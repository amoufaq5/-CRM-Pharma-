#!/usr/bin/env bash
# The field client, in a real browser, against the real API and a real Postgres.
#
# WHY THIS EXISTS. ADR-0001's open table has carried one row longer than any other, and
# in capitals: THERE IS NO CLIENT. Everything the CRM built for a device — visit ids
# minted before the network exists (0012), `POST /v1/sync/visits` with per-row outcomes,
# upsert-by-device-id so a replay cannot duplicate, `tenant_deleted` given its own problem
# type so "a client holding a queue of unsent visits" knows to stop — was a guess about a
# consumer that did not exist. Nothing consumed any of it.
#
# So this does, and it does it the only way that proves anything: a real Chromium, taken
# OFFLINE mid-session with a visit half-recorded, and the row counted in Postgres from
# outside the app. The unit tests in packages/client cover the protocol; they cannot tell
# you whether IndexedDB survived the navigation, whether the service worker served the
# shell with the network down, or whether the id the device minted is the primary key the
# database ended up with.
#
# WHAT IT STANDS UP: a throwaway database with the ERP stand-in and all the CRM's
# migrations, a stand-in IdP publishing a JWKS, the CRM's own `api` binary verifying
# tokens against it, and a static server that serves the app and proxies /v1 from ONE
# origin — which is deploy/Caddyfile's arrangement, and the reason this client needs no
# CORS.
#
# WHAT IT DOES NOT PROVE: a real identity provider (the token is minted by the harness's
# IdP stand-in, as §10 of the live-ERP check does), a real ERP behind the outbox, iOS
# Safari, or a device under memory pressure. And it drives one browser engine: Chromium.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

WORK="$(mktemp -d)"
API_PID=""
IDP_PID=""
WEB_PID=""
CLIENT_DB="${CRM_CLIENT_DB:-crm_client_live_$$}"

cleanup() {
  for pid in "$WEB_PID" "$API_PID" "$IDP_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  # The screenshots and logs are the record of a failed run, so they are copied out
  # before the directory goes.
  if [ -n "${CRM_CLIENT_KEEP:-}" ]; then
    echo "artifacts kept in $WORK" >&2
  else
    psql -d postgres -q -c "DROP DATABASE IF EXISTS $CLIENT_DB WITH (FORCE)" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT INT TERM

wait_for_line() {
  local log="$1" pattern="$2" pid="$3" tries="$4" what="$5" i=0
  while [ "$i" -lt "$tries" ]; do
    if [ -f "$log" ] && grep -Eq "$pattern" "$log"; then return 0; fi
    kill -0 "$pid" 2>/dev/null || { tail -20 "$log" >&2 2>/dev/null || true; fail "$what: the process exited first"; }
    sleep 0.5
    i=$((i + 1))
  done
  tail -20 "$log" >&2 2>/dev/null || true
  fail "$what: nothing matching /$pattern/ within $((tries / 2))s"
}

# The harness talks to Postgres as the ADMIN — it creates a database and reads rows from
# outside any tenant context, so an assertion cannot be satisfied by RLS hiding one. The
# API below is given crm_app instead, which is the whole point of the separation.
export PGUSER="${PGUSER:-postgres}"
export PGHOST="${PGHOST:-/var/run/postgresql}"

command -v psql >/dev/null || fail "psql not found"
command -v node >/dev/null || fail "node not found"
node -e 'if (typeof WebSocket !== "function") process.exit(1)' \
  || fail "this Node has no global WebSocket; the browser driver needs Node >= 22"

# ---------------------------------------------------------------------------
echo "--- 1. build what is under test ---"
# The SHIPPED artefacts, not the sources: the bundle a browser downloads and the dist the
# API binary runs from. A check that compiled its own copy would be verifying something
# nobody deploys.
pnpm -s build >/dev/null 2>&1 || fail "pnpm build failed"
(cd "$ROOT/apps/field" && node build.mjs >/dev/null) || fail "the app bundle failed to build"
[ -f "$ROOT/apps/field/dist/app.js" ] || fail "no app bundle was produced"
[ -f "$ROOT/packages/api/dist/bin/api.js" ] || fail "the API binary was not built"
ok "app bundle $(du -k "$ROOT/apps/field/dist/app.js" | cut -f1) KB, and the API binary, both built"

# ---------------------------------------------------------------------------
echo "--- 2. a throwaway database with the ERP stand-in and every migration ---"
psql -d postgres -q -c "DROP DATABASE IF EXISTS $CLIENT_DB WITH (FORCE)" >/dev/null 2>&1 || true
psql -d postgres -q -c "CREATE DATABASE $CLIENT_DB" >/dev/null || fail "could not create $CLIENT_DB"
PGDATABASE="$CLIENT_DB" "$ROOT/scripts/setup-test-db.sh" > "$WORK/setup.log" 2>&1 \
  || { tail -15 "$WORK/setup.log" >&2; fail "the schema could not be built"; }
ok "$CLIENT_DB has the ERP stand-in and $(grep -c 'applied' "$WORK/setup.log" >/dev/null && sed -n 's/^applied \([0-9]*\) application.*/\1/p' "$WORK/setup.log" | head -1) migrations"

export PGDATABASE="$CLIENT_DB"
TENANT="$(psql -At -c "SELECT gen_random_uuid()")"

# ---------------------------------------------------------------------------
echo "--- 3. a stand-in identity provider, publishing a JWKS ---"
IDP_KID="$(node "$ROOT/scripts/live-erp/genkey.mjs" "$WORK" idp)" || fail "could not generate an IdP key"
node "$ROOT/scripts/live-erp/jwks-server.mjs" 0 "$WORK/idp.jwk.json" > "$WORK/idp.log" 2>&1 &
IDP_PID=$!
wait_for_line "$WORK/idp.log" 'jwks listening on [0-9]+' "$IDP_PID" 40 "the IdP's JWKS"
IDP_PORT="$(sed -n 's/^jwks listening on \([0-9]*\).*/\1/p' "$WORK/idp.log" | head -1)"
ok "an IdP stand-in publishes $IDP_KID on 127.0.0.1:$IDP_PORT"

# ---------------------------------------------------------------------------
echo "--- 4. the rows a rep needs to exist at all ---"
# Seeded as crm_app INSIDE a tenant context, for the reason ADR-0001 item 14 records: a
# privileged insert with no context is the blind spot that let a fixture pass where the
# app could not.
psql -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not seed the rep, territory and accounts"
BEGIN;
SET ROLE crm_app;
SELECT set_config('app.current_tenant_id', '$TENANT', true);

INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, erp_employee_id, display_name, status)
VALUES ('$TENANT', 'rep-ada', 'E-1', 'emp-1', 'Ada Lovelace', 'active'),
       -- A SECOND REP, with no territory of her own. A transfer needs a colleague and
       -- nothing else: 0017's only rule for a counterparty is that they are a rep in this
       -- tenant and not the sender. Leaving her out of T-LIVE keeps every assertion above
       -- about Ada's accounts true, and proves the peer list is not territory-scoped.
       ('$TENANT', 'rep-grace', 'E-2', 'emp-2', 'Grace Hopper', 'active'),
       -- Departed, and therefore never offered as a destination, though the write would
       -- still accept her. The picker's one narrowing, visible in the run.
       ('$TENANT', 'rep-gone', 'E-3', NULL, 'Departed Rep', 'departed');

INSERT INTO crm.territory (tenant_id, code, name)
VALUES ('$TENANT', 'T-LIVE', 'Live territory');

INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
SELECT '$TENANT', t.id, r.id, 'primary', CURRENT_DATE - 1
  FROM crm.territory t, crm.rep_profile r
 WHERE t.code = 'T-LIVE' AND r.subject = 'rep-ada';

INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
SELECT '$TENANT', a.id, t.id, CURRENT_DATE - 1
  FROM crm.territory t, (VALUES ('acc-live-1'), ('acc-live-2')) AS a(id)
 WHERE t.code = 'T-LIVE';

INSERT INTO crm.account_snapshot (tenant_id, erp_account_id, name, status, country, erp_updated_at, synced_at)
VALUES ('$TENANT', 'acc-live-1', 'St Mary''s Hospital', 'active', 'GB', now(), now()),
       ('$TENANT', 'acc-live-2', 'Riverside Clinic', 'active', 'GB', now(), now());
COMMIT;
SQL
ok "rep-ada holds T-LIVE, which covers acc-live-1 and acc-live-2 — and acc-not-mine is covered by nobody"
ok "rep-grace exists to hand material to, and rep-gone has departed"

# A lot for the sample half of the run. The STOCK is not inserted: holdings are maintained
# by the ledger's triggers (0018), so the rep is given material the way a rep is given
# material — by confirming receipt through the API, after it is listening. That happens in
# §6 below, once there is a port to talk to.
LOT_ID="$(psql -At -c "SELECT gen_random_uuid()")"
psql -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not seed the sample lot"
BEGIN;
SET ROLE crm_app;
SELECT set_config('app.current_tenant_id', '$TENANT', true);
INSERT INTO crm.sample_lot (id, tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
VALUES ('$LOT_ID', '$TENANT', 'itm-live-1', 'LOT-FIELD-1', CURRENT_DATE + 365, 'drug_sample');
COMMIT;
SQL
ok "lot LOT-FIELD-1 of itm-live-1 exists, expiring in a year"

# ---------------------------------------------------------------------------
echo "--- 5. the CRM's own API binary ---"
export LIVE_IDP_PEM="$WORK/idp.pem"
export LIVE_OIDC_ISSUER="https://idp.test"
export LIVE_OIDC_AUDIENCE="https://crm.test/api"
export LIVE_TENANT_ID="$TENANT"
# The API connects as the APPLICATION role, and its password has to be the one
# setup-test-db.sh actually set — which is PGAPPPASSWORD. Hard-coding `crm_app` worked
# over a unix socket, where peer auth ignores the password, and would have failed in CI
# over TCP where scram does not.
API_PGUSER="${CRM_PGUSER:-${PGAPPUSER:-crm_app}}"
API_PGPASSWORD="${CRM_PGPASSWORD:-${PGAPPPASSWORD:-crm_app}}"
( cd "$ROOT" \
  && PGUSER="$API_PGUSER" PGPASSWORD="$API_PGPASSWORD" PGDATABASE="$CLIENT_DB" \
     PORT=0 \
     OIDC_ISSUER="$LIVE_OIDC_ISSUER" \
     OIDC_AUDIENCE="$LIVE_OIDC_AUDIENCE" \
     OIDC_JWKS_URL="http://127.0.0.1:$IDP_PORT/.well-known/jwks.json" \
     exec node "$ROOT/packages/api/dist/bin/api.js" ) > "$WORK/api.out" 2> "$WORK/api.err" &
API_PID=$!
wait_for_line "$WORK/api.out" '"type":"listening"' "$API_PID" 120 "the API binary"
API_PORT="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$WORK/api.out" | head -1)"
[ -n "$API_PORT" ] || fail "the API logged no port"
ok "the API is listening on $API_PORT, verifying tokens against the IdP's JWKS"

# ---------------------------------------------------------------------------
echo "--- 6. one origin: the app's files, and /v1 proxied to the API ---"
# deploy/Caddyfile's arrangement, which is why neither the app nor the API has any CORS.
node "$ROOT/scripts/client/serve.mjs" "$ROOT/apps/field/dist" "http://127.0.0.1:$API_PORT" 0 > "$WORK/web.log" 2>&1 &
WEB_PID=$!
wait_for_line "$WORK/web.log" 'serving on [0-9]+' "$WEB_PID" 40 "the static server"
WEB_PORT="$(sed -n 's/^serving on \([0-9]*\)$/\1/p' "$WORK/web.log" | head -1)"
APP_URL="http://127.0.0.1:$WEB_PORT/"

# Proven, not assumed: an unauthenticated API call through the SAME origin is still 401.
THROUGH="$(curl -s -o /dev/null -w '%{http_code}' "${APP_URL%/}/v1/accounts")"
[ "$THROUGH" = "401" ] || fail "an unauthenticated /v1/accounts through the app's origin answered $THROUGH, not 401"
ok "the app is served at $APP_URL and /v1 reaches the API, which still refuses an anonymous call"

# ---------------------------------------------------------------------------
echo "--- 6b. the rep is given stock, through the route a rep uses ---"
CRM_FIELD_TOKEN="$(node "$ROOT/scripts/live-erp/human-token.mjs" rep-ada)" || fail "could not mint a human token"
RECEIPT_ID="$(psql -At -c "SELECT gen_random_uuid()")"
RECEIPT_CODE="$(curl -s -o "$WORK/receipt.json" -w '%{http_code}' -X POST "${APP_URL%/}/v1/samples/receipts" \
  -H "authorization: Bearer $CRM_FIELD_TOKEN" -H "x-tenant-id: $TENANT" -H 'content-type: application/json' \
  -d "{\"id\":\"$RECEIPT_ID\",\"lotId\":\"$LOT_ID\",\"quantity\":\"10\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"erpWarehouseId\":\"wh-live-1\"}")"
[ "$RECEIPT_CODE" = "201" ] || { cat "$WORK/receipt.json" >&2; fail "the receipt was refused with $RECEIPT_CODE"; }
ON_HAND="$(psql -At -c "SELECT quantity_on_hand FROM crm.sample_holding WHERE tenant_id = '$TENANT' AND lot_id = '$LOT_ID'")"
[ "$ON_HAND" = "10.000" ] || fail "the rep holds '$ON_HAND' of LOT-FIELD-1, expected 10.000"
ok "a receipt through the API gives rep-ada 10 units, and the holding trigger agrees"

# ---------------------------------------------------------------------------
echo "--- 7. drive the app in a real browser ---"
export CRM_FIELD_TOKEN
# Grace's own token, for the second browser. A transfer is the first thing in this app that
# takes two people, and one device signed in as one rep cannot prove it: the receiving half
# runs in a separate browser with its own profile, which is its own IndexedDB and its own
# localStorage — a second device, not a second tab.
CRM_FIELD_TOKEN_2="$(node "$ROOT/scripts/live-erp/human-token.mjs" rep-grace)" || fail "could not mint a token for rep-grace"
export CRM_FIELD_TOKEN_2
export CRM_FIELD_TENANT="$TENANT"
export CRM_FIELD_LOT_ID="$LOT_ID"
export CRM_PGDATABASE="$CLIENT_DB"
node "$ROOT/scripts/client/drive-app.mjs" "$APP_URL" "$WORK" | tee "$WORK/drive.log" \
  || fail "the browser run reported failures (see the ok:/FAIL: lines above)"
CHECKS="$(sed -n 's/^\([0-9]*\) checks, .*/\1/p' "$WORK/drive.log" | tail -1)"
[ -n "$CHECKS" ] || fail "the browser run printed no check count"

# ---------------------------------------------------------------------------
echo
echo "--- 8. the server's own view of what the client did ---"
VISITS="$(psql -At -c "SELECT count(*) FROM crm.visit WHERE tenant_id = '$TENANT'")"
[ "$VISITS" = "4" ] || fail "crm.visit holds $VISITS rows for this tenant, expected 4"
DISTINCT_IDS="$(psql -At -c "SELECT count(DISTINCT id) FROM crm.visit WHERE tenant_id = '$TENANT'")"
[ "$DISTINCT_IDS" = "4" ] || fail "4 rows but $DISTINCT_IDS distinct ids — a replay duplicated"
V7="$(psql -At -c "SELECT count(*) FROM crm.visit WHERE tenant_id = '$TENANT' AND substring(id::text, 15, 1) = '7'")"
[ "$V7" = "4" ] || fail "only $V7 of 4 visit ids are v7 — something other than the device minted one"
ok "4 visits, 4 distinct device-minted v7 ids, no duplicates"

REP_OWNED="$(psql -At -c "SELECT count(*) FROM crm.visit v JOIN crm.rep_profile r ON r.id = v.rep_profile_id WHERE v.tenant_id = '$TENANT' AND r.subject = 'rep-ada'")"
[ "$REP_OWNED" = "4" ] || fail "$REP_OWNED of 4 visits are attributed to rep-ada"
ok "every visit is attributed to the CALLER, which the API takes from the token and never from the body"

# The two halves of a signature, compared in SQL. The ledger committed to a digest before
# the image existed anywhere but a canvas; the blob trigger recomputed it from the stored
# bytes. If these ever differ the API answers `signature_mismatch`, so equality here is
# the whole commitment working.
MATCHED="$(psql -At -c "
  SELECT count(*) FROM crm.sample_transaction t
    JOIN crm.attachment a
      ON a.subject_table = 'crm.sample_transaction' AND a.subject_id = t.id AND a.purpose = 'disbursement_signature'
   WHERE t.tenant_id = '$TENANT' AND t.kind = 'disbursement' AND a.content_sha256 = t.signature_sha256")"
[ "$MATCHED" = "1" ] || fail "$MATCHED disbursements have a signature whose stored bytes hash to the ledger's commitment, expected 1"
ok "the stored signature hashes to exactly what the ledger committed to before it was uploaded"

# The whole run's arithmetic, in one place, because the number is only meaningful as the
# sum of what the browser did: received 10, disbursed 2, queued a transfer of 2 and
# cancelled it before it was ever sent, transferred 3 to Grace and had it accepted,
# transferred 1 more and recalled it, received 2 more while a count sat unsent on the
# device — and then COUNTED 4, which the commit made true. The count is the only step here
# that sets a balance rather than moving it, and it is why this is 4 and not 7.
REMAINING="$(psql -At -c "
  SELECT h.quantity_on_hand || '|' || h.quantity_in_transit
    FROM crm.sample_holding h JOIN crm.rep_profile r ON r.id = h.rep_profile_id
   WHERE h.tenant_id = '$TENANT' AND h.lot_id = '$LOT_ID' AND r.subject = 'rep-ada'")"
[ "$REMAINING" = "4.000|0.000" ] || fail "rep-ada holds '$REMAINING' (on hand|in transit) at the end of the run, expected 4.000|0.000"
ok "the sender's balance ends at what the COUNT said: 10 received, 2 disbursed, 3 transferred, 2 received again, counted 4"

GRACE="$(psql -At -c "
  SELECT h.quantity_on_hand || '|' || h.quantity_in_transit
    FROM crm.sample_holding h JOIN crm.rep_profile r ON r.id = h.rep_profile_id
   WHERE h.tenant_id = '$TENANT' AND h.lot_id = '$LOT_ID' AND r.subject = 'rep-grace'")"
[ "$GRACE" = "3.000|0.000" ] || fail "rep-grace holds '$GRACE', expected 3.000|0.000"
ok "and the receiver holds exactly what she accepted, on her own balance"

# The total across both reps is the one invariant a custody chain must never break: every
# movement in this run moved material between columns, and none of it created or destroyed
# any. 10 received, 2 disbursed to a doctor, 8 left somewhere.
TOTAL="$(psql -At -c "
  SELECT COALESCE(SUM(quantity_on_hand + quantity_in_transit), 0)
    FROM crm.sample_holding WHERE tenant_id = '$TENANT' AND lot_id = '$LOT_ID'")"
[ "$TOTAL" = "7.000" ] || fail "the two reps hold '$TOTAL' between them, expected 7.000"
ok "and the two balances sum to 7: 8 left after the disbursement, 2 received, 3 written off by the count"

# Every balance in this run is still the sum of its own movements. The count did not edit a
# number; it posted an adjustment, which is the property that makes the ledger the record.
DRIFT="$(psql -At -c "
  SELECT count(*) FROM crm.sample_holding h
   WHERE h.tenant_id = '$TENANT'
     AND h.quantity_on_hand <> (
       SELECT COALESCE(SUM(CASE
         WHEN t.kind IN ('receipt','transfer_in','adjustment_in','transfer_recall') THEN t.quantity
         WHEN t.kind IN ('disbursement','transfer_out','adjustment_out','destruction','expiry_writeoff','return_to_warehouse') THEN -t.quantity
         ELSE 0 END), 0)
         FROM crm.sample_transaction t
        WHERE t.tenant_id = h.tenant_id AND t.lot_id = h.lot_id AND t.rep_profile_id = h.rep_profile_id)")"
[ "$DRIFT" = "0" ] || fail "$DRIFT holding(s) disagree with the sum of their own movements"
ok "and every balance still equals the sum of its movements — the count adjusted, it did not edit"

# A transfer that was never accepted and never recalled would sit in transit forever, which
# is the open end 0025 closed for the sender. Nothing may be left outstanding here.
# The count, from outside the app. Two numbers that must differ and one that must not: the
# ledger's variance is against what was HELD when the line arrived, the device's against
# what the rep was shown — and the balance afterwards is exactly what they counted.
COUNT_STATE="$(psql -At -c "
  SELECT c.status || '|' || cl.counted_quantity || '|' || cl.expected_quantity || '|' ||
         COALESCE(cl.device_expected_quantity::text, 'null')
    FROM crm.sample_count c JOIN crm.sample_count_line cl ON cl.count_id = c.id
   WHERE c.tenant_id = '$TENANT'")"
[ "$COUNT_STATE" = "committed|4.000|7.000|5.000" ] || fail "the count reads '$COUNT_STATE', expected committed|4.000|7.000|5.000"
ok "the count committed with all three figures kept: counted 4, server held 7, device had shown 5"

LINKED="$(psql -At -c "
  SELECT count(*) FROM crm.sample_transaction t JOIN crm.sample_count c ON c.id = t.count_id
   WHERE t.tenant_id = '$TENANT' AND t.kind = 'adjustment_out' AND t.quantity = 3.000")"
[ "$LINKED" = "1" ] || fail "$LINKED adjustments are linked to a count, expected 1"
ok "and its adjustment is linked to the count structurally, not parsed out of a reason string"

OUTSTANDING="$(psql -At -c "
  SELECT count(*) FROM crm.sample_transaction t
   WHERE t.tenant_id = '$TENANT' AND t.kind = 'transfer_out'
     AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction x WHERE x.transfer_of = t.id)")"
[ "$OUTSTANDING" = "0" ] || fail "$OUTSTANDING transfer(s) are still unsettled, expected 0"
ok "every transfer the run made has its one terminal event — an acceptance or a recall"

echo
echo "ok: $CHECKS checks in a real browser, against the real API binary and a real Postgres"
echo "not proven here: a real IdP, a real ERP behind the outbox, Safari, or a device under memory pressure"
