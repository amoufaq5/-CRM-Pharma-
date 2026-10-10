#!/usr/bin/env bash
# Run the CRM's ERP-facing code against a RUNNING CrossEngin operate-server.
#
# WHY THIS EXISTS. Everything about the CRM→ERP path was verified against the
# ERP's SOURCE and a captured schema: the Ed25519 service credential, the JWKS
# handshake, slug resolution, the silently-dropped filter the whole ACL is built
# around, both error shapes, and the outbox's three classifications. ADR-0001's
# open table said so in as many words — "no live handshake has happened — no ERP
# instance was available". Transcribing a verifier is not the same as satisfying
# one, and reading a handler is not the same as seeing the body it emits.
#
# This boots the real server on a throwaway database and does two things with it.
# Sections 1-9 drive the SHIPPED dist of @crm/credential, @crm/acl and @crm/relay
# at it as a LIBRARY. Sections 10-14 start the CRM's own `api` and `scheduler`
# BINARIES as processes and let them do the work — the gap ADR-0001's open table
# named in as many words: "the CRM's own api and scheduler binaries were not driven
# at the live ERP. The relay was driven directly."
#
# Nothing here mints its own ERP token, writes its own query string, classifies its
# own error, or drains the outbox by hand: a harness that did would verify the
# harness. The one token this file's helpers assemble themselves is the HUMAN login
# token, and only because there the CRM is the verifier and not the issuer — an
# external IdP is what it stands in for.
#
# Every check carries a CONTROL where one is possible, because this repo has been
# bitten four times by assertions that passed against inert behaviour — and once,
# in section 6, by one that FAILED while the code was correct, because a case's
# instrumented client was seeing a previous case's retry. "An
# unknown filter returns every row" is worthless without "a known filter returns
# fewer"; "a bad sort does not reorder" is worthless without "a good sort does".
#
# WHAT IT DOES NOT PROVE:
#   * Nothing about the ERP under load, concurrency, or more than one tenant's
#     manifest. One tenant on the boot pack is served here; a tenant on a custom
#     manifest (ADR-0001 Q11) has a different entity set and is NOT exercised.
#     The scheduler's per-tenant loop runs with exactly ONE tenant and ONE
#     instance, so neither tenant isolation inside a tick nor the claim/skip-locked
#     story for two instances is tested.
#   * Nothing about the jobs other than relay_drain, the snapshots and
#     notify_approvals. expiry_sweep, notify_prune, notify_dispatch and
#     expense_post all run in the first tick against the live database and are
#     observed to succeed; nothing is asserted about what they did, because the
#     rows they act on are not seeded. `notify_approvals` IS seeded — §10 leaves a
#     four-eyes proposal pending with a second officer who was never told, and its
#     deadline two days past — so §11 asserts the notice it raised, the escalation
#     beside it and the severity of each, rather than only the tick.
#   * Nothing about an RS256 human token. The stand-in IdP signs EdDSA, and RS256
#     is the format every real OIDC provider defaults to (jwt.ts supports it, and
#     only packages/api/src/jwt.test.ts exercises it).
#   * Nothing about ADR-0001 option (b)'s single-database arrangement. The ERP
#     gets its own database here, so the CRM's SELECT grant on
#     meta.operate_entity_records is still the stand-in from scripts/erp-fixture.sh.
#     Only the HTTP path to the ERP is live.
#   * Nothing about the ERP's GL, period locks or write-effects. The entities
#     driven here are the ones the CRM's own outbox touches.
#   * Nothing about TLS, a reverse proxy, or key rotation under live traffic. The
#     JWKS is served over plain HTTP on loopback.
#   * It is not a CI gate. It needs a Postgres cluster, a built CrossEngin
#     checkout and about a minute. Run it when the CRM->ERP contract changes.
#
# Usage:
#   ./scripts/verify-live-erp.sh                 # boot an ERP, run, tear down
#   CROSSENGIN_DIR=/path/to/CrossEngin ./scripts/verify-live-erp.sh
#
# /home/user/CrossEngin is treated as READ-ONLY throughout: it is read, built
# once if its dist is missing, run, and pointed at a throwaway database. Nothing
# in it is written.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ERP_DIR="${CROSSENGIN_DIR:-/home/user/CrossEngin}"

ERP_PORT="${ERP_PORT:-8788}"
JWKS_PORT="${JWKS_PORT:-8799}"
ERP_DB="${ERP_PGDATABASE:-erp_live1}"
CRM_DB="${CRM_PGDATABASE:-crm_live1}"
TENANT="${LIVE_TENANT_ID:-11111111-1111-4111-8111-111111111111}"
ISSUER="${LIVE_JWT_ISSUER:-https://crm.test}"
AUDIENCE="${LIVE_JWT_AUDIENCE:-https://erp.test}"
ERP_ROLE="${LIVE_ERP_ROLE:-erp_admin}"

export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGUSER="${PGUSER:-postgres}"

WORK="$(mktemp -d)"
# Each phase of the binaries' driver appends "<checks> <failures>" here.
: > "$WORK/counts"
ERP_PID=""
JWKS_PID=""
# The CRM's own long-running processes (§10–§13). Every one of them is a listener,
# and a leaked listener does not fail the next run on the check that would name it
# — it fails four steps later on something that reads like a different bug. So each
# gets a variable the moment it is started and the trap kills all of them, pass or
# fail, the same way the ERP and the JWKS endpoint already do.
IDP_PID=""
API_PID=""
SCHED_PID=""
DEV_SCHED_PID=""

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

cleanup() {
  local code=$?
  [ -n "$ERP_PID" ] && kill "$ERP_PID" 2>/dev/null || true
  [ -n "$JWKS_PID" ] && kill "$JWKS_PID" 2>/dev/null || true
  [ -n "$IDP_PID" ] && kill "$IDP_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$SCHED_PID" ] && kill "$SCHED_PID" 2>/dev/null || true
  [ -n "$DEV_SCHED_PID" ] && kill "$DEV_SCHED_PID" 2>/dev/null || true
  if [ "$code" -ne 0 ] && [ -f "$WORK/erp.log" ]; then
    echo; echo "--- last 25 lines of the operate-server log ---" >&2
    tail -25 "$WORK/erp.log" >&2
  fi
  # The CRM's binaries write their own diagnosis and then die; without this the
  # failure reads as "the gate timed out waiting for a tick".
  for log in api.err api.out sched.err sched.out sched2.err sched2.out; do
    if [ "$code" -ne 0 ] && [ -s "$WORK/$log" ]; then
      echo; echo "--- last 15 lines of $log ---" >&2
      tail -15 "$WORK/$log" >&2
    fi
  done
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

# Waits for a pattern to appear in a log a background process is writing, and
# gives up rather than hanging. A process that dies is reported as having died,
# which is the difference between a readable failure and a stuck gate.
#   wait_for_line <logfile> <grep -E pattern> <pid> <tries, half a second each> <what>
wait_for_line() {
  local log="$1" pattern="$2" pid="$3" tries="$4" what="$5"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if [ -f "$log" ] && grep -Eq "$pattern" "$log"; then return 0; fi
    kill -0 "$pid" 2>/dev/null || { tail -20 "$log" >&2 2>/dev/null || true; fail "$what: the process exited first"; }
    sleep 0.5
    i=$((i + 1))
  done
  tail -20 "$log" >&2 2>/dev/null || true
  fail "$what: nothing matching /$pattern/ within $((tries / 2))s"
}

# SIGTERM, then wait for the graceful stop the binary promises. Both processes
# drain an in-flight tick or request before exiting, so a check that reads their
# log must not read it while a tick is still writing to it.
stop_gracefully() {
  local pid="$1" what="$2" status=0
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" || status=$?
  echo "$status" > "$WORK/last-exit"
  [ "$status" -eq 0 ] || echo "    ($what exited $status)"
}

command -v node >/dev/null || fail "node not found"
command -v psql >/dev/null || fail "psql not found"
[ -d "$ERP_DIR" ] || fail "no CrossEngin checkout at $ERP_DIR (set CROSSENGIN_DIR)"

# Both ports must be free before anything starts. A leftover JWKS server from an
# earlier run keeps its own socket, this run's server fails to bind, and every
# token is then signed by a key the document on the wire does not carry — which
# surfaces four steps later as "the JWKS does not publish the key we just
# generated" and reads like a key-generation bug. Caught here instead, by name.
for port in "$ERP_PORT" "$JWKS_PORT" "$((JWKS_PORT + 1))"; do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" \
    && fail "something is already listening on 127.0.0.1:$port — stop it, or set ERP_PORT/JWKS_PORT"
done
ok "ports $ERP_PORT, $JWKS_PORT and $((JWKS_PORT + 1)) are free"

# ---------------------------------------------------------------------------
echo "--- 1. the CRM's own dist is current ---"
# The driver imports dist, not src. A stale dist would verify last week's ACL
# against this week's ERP and report a pass for code nobody is running.
(cd "$ROOT" && npx tsc --build) || fail "the CRM workspace does not build"
for p in acl credential relay db; do
  [ -f "$ROOT/packages/$p/dist/index.js" ] || fail "packages/$p/dist/index.js is missing after a build"
done
# The two BINARIES, by the path their package.json `bin` entries name and their
# compose services invoke — §10–§13 run these as processes, not as libraries.
API_BIN="$ROOT/packages/api/dist/bin/api.js"
SCHED_BIN="$ROOT/packages/scheduler/dist/bin/scheduler.js"
[ -f "$API_BIN" ] || fail "no built API binary at $API_BIN"
[ -f "$SCHED_BIN" ] || fail "no built scheduler binary at $SCHED_BIN"
ok "@crm/acl, @crm/credential, @crm/relay and @crm/db are built, and so are both binaries"

# ---------------------------------------------------------------------------
echo "--- 2. the ERP checkout is built, and a manifest of it is taken ---"
ERP_BIN="$ERP_DIR/apps/operate-server/dist/bin/operate-server.js"
MIGRATE_BIN="$ERP_DIR/packages/kernel-pg/dist/bin/crossengin-pg.js"
[ -f "$ERP_BIN" ] || fail "no built operate-server at $ERP_BIN — build the ERP checkout first"
[ -f "$MIGRATE_BIN" ] || fail "no built crossengin-pg at $MIGRATE_BIN"
# The ERP is somebody else's repository and this script only reads, runs and
# points it at a throwaway database. A name/mtime/size manifest taken now and
# compared at the end turns that from a promise into a check — cheap, and the one
# way a stray write would be noticed rather than assumed away.
erp_manifest() {
  find "$ERP_DIR/apps" "$ERP_DIR/packages" "$ERP_DIR/deploy" \
    -type f \( -name '*.ts' -o -name '*.json' -o -name '*.sql' -o -name '*.md' \) \
    -printf '%p %T@ %s\n' 2>/dev/null | sort
}
erp_manifest > "$WORK/erp-before.txt"
ok "operate-server and crossengin-pg are built ($(wc -l < "$WORK/erp-before.txt") ERP files fingerprinted)"

# ---------------------------------------------------------------------------
echo "--- 3. a throwaway ERP database, migrated by the ERP's own applier ---"
psql -lqtA -F'|' | cut -d'|' -f1 | grep -qx "$ERP_DB" || createdb "$ERP_DB" || fail "createdb $ERP_DB failed"
# pg_uuidv7 is a C extension this cluster does not carry. The applier accepts a
# callable uuid_generate_v7() instead, which is the managed-Postgres path the ERP
# documents — so this is the supported fallback, not a workaround of our own.
if ! psql -d "$ERP_DB" -At -c "SELECT 1 FROM pg_proc WHERE proname='uuid_generate_v7'" | grep -q 1; then
  psql -d "$ERP_DB" -v ON_ERROR_STOP=1 -q -f "$ERP_DIR/deploy/supabase/00-uuidv7.sql" \
    || fail "could not define uuid_generate_v7() in $ERP_DB"
fi
PGDATABASE="$ERP_DB" node "$MIGRATE_BIN" apply > "$WORK/migrate.log" 2>&1 \
  || { cat "$WORK/migrate.log" >&2; fail "the ERP migration applier failed against $ERP_DB"; }
grep -q "failed:  *0" "$WORK/migrate.log" || { cat "$WORK/migrate.log" >&2; fail "the ERP migration left failures"; }
META_TABLES="$(psql -d "$ERP_DB" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='meta'")"
ok "$ERP_DB migrated by crossengin-pg ($META_TABLES tables in schema meta)"

psql -d "$ERP_DB" -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO meta.tenants (id, slug, name, schema_name)
   VALUES ('$TENANT','live-verify','Live Verify','tenant_live_verify')
   ON CONFLICT (id) DO NOTHING" || fail "could not register the tenant in meta.tenants"
ok "tenant $TENANT is active in meta.tenants"

# ---------------------------------------------------------------------------
echo "--- 4. the CRM's side: a service principal for this tenant ---"
# The driver resolves the tenant's ERP role through PostgresServiceRoleSource, as
# the scheduler does, so the row has to exist and RLS has to admit it. Seeded via
# withTenantContext as crm_app would see it — a privileged INSERT with no tenant
# context is exactly the blind spot ADR-0001 item 14 records.
# THE CRM DATABASE IS REBUILT HERE, every run.
#
# It used to be required to exist already ("run the CRM migrations first"), which made the
# gate's schema whatever happened to be lying around — and that is not a hypothetical sharp
# edge: this check failed with `column "seq" does not exist` because `crm_live1` predated
# migration 0041, so section 6i read a function the database held an older signature for. A
# gate whose schema is stale proves something about a database nobody has.
#
# Built by `scripts/setup-test-db.sh` and NOT by the migration runner, deliberately. That
# script applies the files through psql and leaves `crm._migrations` empty by design (its own
# header says so), which is exactly why a database it built cannot then be handed to the
# runner — the runner would find an empty ledger over a full schema and refuse on 0003. The
# runner has its own gate in `scripts/verify-migration-runner.sh`; this one needs a current
# schema, and the cheapest way to be sure it is current is to not keep the old one.
dropdb --if-exists "$CRM_DB" || fail "could not drop $CRM_DB"
createdb "$CRM_DB" || fail "createdb $CRM_DB failed"
PGDATABASE="$CRM_DB" "$ROOT/scripts/setup-test-db.sh" > "$WORK/crm-migrate.log" 2>&1 \
  || { tail -30 "$WORK/crm-migrate.log" >&2; fail "the CRM migrations failed against $CRM_DB"; }
ok "$CRM_DB rebuilt from empty ($(grep -c '^applied' "$WORK/crm-migrate.log" >/dev/null 2>&1; \
     sed -n 's/^applied \([0-9]*\) application.*/\1/p' "$WORK/crm-migrate.log") migrations)"

psql -d "$CRM_DB" -At -c "SELECT 1 FROM crm.outbox LIMIT 0" >/dev/null 2>&1 \
  || fail "$CRM_DB has no crm.outbox after migrating"
PGPASSWORD="${CRM_PGPASSWORD:-crm_app}" psql -h "$PGHOST" -U "${CRM_PGUSER:-crm_app}" -d "$CRM_DB" \
  -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not seed crm.erp_service_principal"
BEGIN;
SELECT set_config('app.current_tenant_id', '$TENANT', true);
INSERT INTO crm.tenant (tenant_id, display_name)
VALUES ('$TENANT', 'Live Verify') ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO crm.erp_service_principal (tenant_id, erp_role, subject, enabled)
VALUES ('$TENANT', '$ERP_ROLE', 'crm-service:$TENANT', true)
ON CONFLICT (tenant_id) DO UPDATE SET erp_role = EXCLUDED.erp_role, enabled = true;
COMMIT;
SQL
ok "crm.erp_service_principal grants '$ERP_ROLE' for this tenant"

# ---------------------------------------------------------------------------
echo "--- 5. a fresh service keypair, and the CRM's JWKS on a socket ---"
KID="$(node "$ROOT/scripts/live-erp/genkey.mjs" "$WORK" key)"
ROGUE_KID="$(node "$ROOT/scripts/live-erp/genkey.mjs" "$WORK" rogue)"
[ -n "$KID" ] && [ "$KID" != "$ROGUE_KID" ] || fail "key generation produced no kid, or two identical ones"
ok "signing key $KID generated (and an unpublished rogue key for the negative control)"

node "$ROOT/scripts/live-erp/jwks-server.mjs" "$JWKS_PORT" "$WORK/key.jwk.json" > "$WORK/jwks.log" 2>&1 &
JWKS_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$JWKS_PORT/.well-known/jwks.json" -o "$WORK/jwks.json" 2>/dev/null && break
  sleep 0.25
done
[ -s "$WORK/jwks.json" ] || fail "the CRM's JWKS endpoint never came up on $JWKS_PORT"
grep -q "\"kid\":\"$KID\"" "$WORK/jwks.json" || fail "the JWKS does not publish the key we just generated"
grep -q '"crv":"Ed25519"' "$WORK/jwks.json" || fail "the JWKS does not advertise Ed25519 — the ERP parses nothing else"
ok "the JWKS publishes $KID as an OKP/Ed25519 key"

# The 503-not-empty-200 rule (README rule 10) is a property of the ENDPOINT, so it
# is checked where the endpoint runs rather than in a unit test over a return value.
node "$ROOT/scripts/live-erp/jwks-server.mjs" "$((JWKS_PORT + 1))" --empty > "$WORK/jwks-empty.log" 2>&1 &
EMPTY_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$((JWKS_PORT + 1))/__count" && break
  sleep 0.25
done
EMPTY_CODE="$(curl -s -o "$WORK/empty.json" -w '%{http_code}' "http://127.0.0.1:$((JWKS_PORT + 1))/.well-known/jwks.json")"
kill "$EMPTY_PID" 2>/dev/null || true
[ "$EMPTY_CODE" = "503" ] || fail "an unpublished key set served HTTP $EMPTY_CODE; it must be 503, because the ERP REPLACES its cached keys with whatever a 200 carries"
grep -q '"keys"' "$WORK/empty.json" && fail "the 503 body still carries a key set"
ok "with nothing to publish the endpoint answers 503, never an empty 200"

# ---------------------------------------------------------------------------
echo "--- 6. boot operate-server with the CRM as its only identity provider ---"
# --store pg: the deployed store (ADR-0001 R17), where every filter is a text
#   comparison on `document ->> 'field'`. The whole of rule 4 depends on it.
# --per-tenant-manifests: on in the target deployment (Q11/R18).
# NO --api-key: the CRM's JWKS is the ONLY way into this server, so a passing
#   handshake cannot be an opaque dev token sneaking in.
ERP_ARGV=(
  "$ERP_BIN"
  --pack erp-core
  --store pg
  --per-tenant-manifests
  --port "$ERP_PORT"
  --jwks-url "http://127.0.0.1:$JWKS_PORT/.well-known/jwks.json"
  --jwks-refresh-ms 30000
  --jwt-issuer "$ISSUER"
  --jwt-audience "$AUDIENCE"
)
echo "    node ${ERP_ARGV[*]/#$ERP_BIN/operate-server}"
( cd "$ERP_DIR" && PGHOST="$PGHOST" PGUSER="$PGUSER" PGDATABASE="$ERP_DB" exec node "${ERP_ARGV[@]}" ) > "$WORK/erp.log" 2>&1 &
ERP_PID=$!

for _ in $(seq 1 120); do
  if curl -s -o /dev/null "http://127.0.0.1:$ERP_PORT/v1/meta/schema"; then break; fi
  kill -0 "$ERP_PID" 2>/dev/null || fail "operate-server exited during boot"
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$ERP_PORT/v1/meta/schema" || fail "operate-server never answered on $ERP_PORT"
ok "operate-server is listening on $ERP_PORT ($(head -1 "$WORK/erp.log"))"

# An unauthenticated probe must be refused. Otherwise every "the token was
# accepted" check below is consistent with a server that authenticates nobody.
ANON="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ERP_PORT/v1/items")"
[ "$ANON" = "401" ] || fail "an unauthenticated GET /v1/items returned $ANON, not 401 — this server is not gating anything"
ok "an unauthenticated request is refused 401, so acceptance below means something"

# ---------------------------------------------------------------------------
echo "--- 7. fixtures, through the ERP's own API ---"
export ERP_BASE_URL="http://127.0.0.1:$ERP_PORT"
export JWKS_BASE_URL="http://127.0.0.1:$JWKS_PORT"
export LIVE_TENANT_ID="$TENANT"
export LIVE_JWT_ISSUER="$ISSUER"
export LIVE_JWT_AUDIENCE="$AUDIENCE"
export LIVE_KEY_PEM="$WORK/key.pem"
export LIVE_ROGUE_PEM="$WORK/rogue.pem"
export CRM_PGDATABASE="$CRM_DB"
node "$ROOT/scripts/live-erp/seed.mjs" || fail "seeding the ERP fixtures failed"
ok "fixtures present"

# The CRM learns the ERP's depots, through the shipped refresher, before any rep can record
# receiving stock from one: since 0058 a receipt naming a warehouse the snapshot does not
# have is refused — and with an EMPTY snapshot it is refused as an integration failure (503)
# rather than a bad id, because nothing could be validated. That ordering is production's
# too; §11 proves the scheduler is what maintains it.
WH_SYNC="$(CRM_PGUSER="${CRM_PGUSER:-crm_app}" CRM_PGPASSWORD="${CRM_PGPASSWORD:-crm_app}" \
  node "$ROOT/scripts/live-erp/sync-warehouses.mjs")" \
  || fail "the CRM could not sync its warehouse list from the live ERP"
ok "$WH_SYNC"

# ---------------------------------------------------------------------------
echo "--- 8. the schema the CRM's committed baseline claims to be a capture of ---"
# packages/acl/schema/baseline.json is the file CI diffs against, and three of the
# CRM's load-bearing facts are measured from it. If it is not what a live server
# serves, those facts are a second opinion about reality — which is exactly how
# six PollingChangeSource tests passed for the life of the project against a
# hand-written fixture.
curl -fsS -H "authorization: Bearer $(node "$ROOT/scripts/live-erp/token.mjs")" \
  -H "x-tenant-id: $TENANT" "$ERP_BASE_URL/v1/meta/schema" > "$WORK/live-schema.json" \
  || fail "could not read /v1/meta/schema for the baseline comparison"
if command -v jq >/dev/null; then
  jq -S 'del(.generatedAt)' "$WORK/live-schema.json" > "$WORK/live.norm.json"
  jq -S 'del(.generatedAt)' "$ROOT/packages/acl/schema/baseline.json" > "$WORK/base.norm.json"
  if diff -q "$WORK/live.norm.json" "$WORK/base.norm.json" >/dev/null; then
    ok "packages/acl/schema/baseline.json is byte-identical to what this server serves"
  else
    diff -u "$WORK/base.norm.json" "$WORK/live.norm.json" | head -40 >&2
    fail "the committed baseline DRIFTS from the live server — see the diff above"
  fi
else
  echo "    (jq not found: skipping the baseline byte comparison)"
fi

# ---------------------------------------------------------------------------
echo "--- 9. drive @crm/credential, @crm/acl and @crm/relay at the live server ---"
# Through `tee` so the run's own count can be added to the binaries' below. One
# total is the number the README quotes, and deriving it beats maintaining it.
node "$ROOT/scripts/live-erp/drive.mjs" | tee "$WORK/drive.log" \
  || fail "live verification reported failures (see the ok:/FAIL: lines above)"
LIB_CHECKS="$(sed -n 's/^\([0-9]*\) checks, .*/\1/p' "$WORK/drive.log" | tail -1)"
[ -n "$LIB_CHECKS" ] || fail "drive.mjs printed no check count"

# ===========================================================================
# THE CRM'S OWN BINARIES.
#
# Everything above drives the CRM's dist as a LIBRARY. ADR-0001's open table named
# the gap that leaves, in these words:
#
#   The CRM's own `api` and `scheduler` binaries were not driven at the live ERP.
#   The relay was driven directly. The scheduler's per-tenant loop, its credential
#   boot and its refusal to start on `ERP_TOKEN` under `NODE_ENV=production` are
#   all still verified only against the fixture.
#
# What follows starts both processes for real — the API with an IdP in front of it,
# the scheduler with the signing key where production puts it — and lets them do
# the work. Nothing below calls `drainTenant`, mints a service token for the
# scheduler, or resolves a role on its behalf.
#
# THE SHELL OWNS THE PROCESSES AND `drive-binaries.mjs` OWNS THE ASSERTIONS. Every
# listener started here gets a PID variable at the moment it is started, and the
# trap above kills all of them whether the run passes or fails.
# ===========================================================================
echo
echo "--- 10. the CRM's API binary, authenticated against a JWKS, at the live ERP ---"

# The scheduler's boot check reads `crm.service_key`, not the socket: a signing key
# that is not in that table is one no verifier has, so `buildServiceCredential`
# refuses to start rather than mint tokens every ERP call rejects. The key the JWKS
# endpoint has been serving since §5 is published here, through the shipped
# registry — `crm-service-key generate` cannot be used because it generates its own
# keypair, and the ERP has already fetched this one.
export CRM_PGDATABASE="$CRM_DB"
PUBLISHED_KID="$(node "$ROOT/scripts/live-erp/publish-key.mjs" "$WORK/key.jwk.json")" \
  || fail "could not publish the service key into crm.service_key"
[ "$PUBLISHED_KID" = "$KID" ] || fail "the registry published $PUBLISHED_KID, not the $KID the JWKS serves"
ok "crm.service_key publishes $KID and it is the active signing key"

# A SECOND key set, for the human tier. ADR-0001 item 10's two tiers "never mix":
# any OIDC provider signs people into the CRM, and a short-lived Ed25519 service
# token signs the CRM into the ERP. Served on an EPHEMERAL port, so this stands up
# an IdP without reserving a fourth socket — §10c then proves the service key does
# not open the API, which is the live form of "never mix".
IDP_KID="$(node "$ROOT/scripts/live-erp/genkey.mjs" "$WORK" idp)"
[ -n "$IDP_KID" ] && [ "$IDP_KID" != "$KID" ] || fail "the IdP key is missing, or is the service key"
node "$ROOT/scripts/live-erp/jwks-server.mjs" 0 "$WORK/idp.jwk.json" > "$WORK/idp-jwks.log" 2>&1 &
IDP_PID=$!
wait_for_line "$WORK/idp-jwks.log" 'jwks listening on [0-9]+' "$IDP_PID" 40 "the stand-in IdP's JWKS"
IDP_PORT="$(sed -n 's/^jwks listening on \([0-9]*\).*/\1/p' "$WORK/idp-jwks.log" | head -1)"
[ -n "$IDP_PORT" ] || fail "could not read the IdP JWKS port"
ok "a stand-in IdP publishes $IDP_KID on 127.0.0.1:$IDP_PORT — a different key set from the ERP's"

# The rows the API's own authorisation depends on. Seeded as crm_app inside a tenant
# context, for the reason §4 gives: a privileged INSERT with no tenant context is
# the blind spot ADR-0001 item 14 records.
LOT_ID="$(psql -d "$CRM_DB" -At -c 'SELECT gen_random_uuid()')"
printf '{"lotId":"%s"}\n' "$LOT_ID" > "$WORK/binaries.json"
PGPASSWORD="${CRM_PGPASSWORD:-crm_app}" psql -h "$PGHOST" -U "${CRM_PGUSER:-crm_app}" -d "$CRM_DB" \
  -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not seed the rep profile and sample lot"
BEGIN;
SELECT set_config('app.current_tenant_id', '$TENANT', true);
INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, erp_employee_id, display_name, status)
VALUES ('$TENANT', 'rep-ada', 'E-1', 'emp-1', 'Ada Lovelace', 'active')
ON CONFLICT (tenant_id, subject) DO UPDATE
  SET erp_employee_id = EXCLUDED.erp_employee_id, status = 'active';
INSERT INTO crm.sample_lot (id, tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
VALUES ('$LOT_ID', '$TENANT', 'itm-1', 'LOT-LIVE-1', CURRENT_DATE + 365, 'drug_sample')
ON CONFLICT (tenant_id, erp_item_id, lot_number) DO NOTHING;

-- A SECOND REP, and the administrator grant. 0023's four-eyes rule means nobody grants
-- themselves a role, so the second rep grants Ada — the same shape a real tenant has, where
-- the first administrator is inserted by whoever runs the migrations.
--
-- The grant is what makes §10's endpoint checks reachable at all: since 0060 adding a
-- notification endpoint is an administrator action that names its author and its reason, and
-- the whole point of the check is that the author comes from the token.
INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name, status)
VALUES ('$TENANT', 'rep-grace', 'E-2', 'Grace Hopper', 'active')
ON CONFLICT (tenant_id, subject) DO UPDATE SET status = 'active';
INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
SELECT '$TENANT', a.id, 'administrator', g.id, CURRENT_DATE - 1,
       'the live gate needs somebody who may configure where signals are pushed'
  FROM crm.rep_profile a, crm.rep_profile g
 WHERE a.subject = 'rep-ada' AND g.subject = 'rep-grace'
   AND NOT EXISTS (SELECT 1 FROM crm.rep_role x
                    WHERE x.rep_profile_id = a.id AND x.role = 'administrator' AND x.valid_to IS NULL);

-- AND A PENDING FOUR-EYES PROPOSAL, with both reps holding the grant it answers to (0062),
-- so the scheduler notify_approvals tick has something real to do. §11 asserts what it
-- DID rather than only that it ran, which is the limitation this file's header records for
-- every other job: a tick that reports zeroes proves the dispatcher case exists and nothing
-- about the query behind it.
--
-- Inserted directly rather than through the route, because the API binary is not up yet and
-- the claim being measured is the SCHEDULER's. `four_eyes_columns` and `role` are written out
-- for the same reason: the store stamps them from crm.four_eyes_rule, and a fixture going
-- through the store would be testing that here instead of where it belongs.
--
-- NO BACKTICKS ANYWHERE IN THIS HEREDOC. It is unquoted, because the fixture needs $TENANT
-- expanded — which also makes a backtick command substitution, and the first version of this
-- comment ran "notify_approvals" as a shell command.
INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
SELECT '$TENANT', a.id, 'compliance', g.id, CURRENT_DATE - 1,
       'the live gate needs two officers so a four-eyed change can be approved at all'
  FROM crm.rep_profile a, crm.rep_profile g
 WHERE a.subject = 'rep-ada' AND g.subject = 'rep-grace'
   AND NOT EXISTS (SELECT 1 FROM crm.rep_role x
                    WHERE x.rep_profile_id = a.id AND x.role = 'compliance' AND x.valid_to IS NULL);
INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
SELECT '$TENANT', g.id, 'compliance', a.id, CURRENT_DATE - 1,
       'and the second of the two, granted by the first'
  FROM crm.rep_profile a, crm.rep_profile g
 WHERE a.subject = 'rep-ada' AND g.subject = 'rep-grace'
   AND NOT EXISTS (SELECT 1 FROM crm.rep_role x
                    WHERE x.rep_profile_id = g.id AND x.role = 'compliance' AND x.valid_to IS NULL);
INSERT INTO crm.config_proposal
  (tenant_id, table_name, row_key, changes, four_eyes_columns, role, proposed_by, proposed_reason)
SELECT '$TENANT', 'disposal_policy', jsonb_build_object('tenant_id', '$TENANT'::uuid),
       '{"auto_writeoff_promo": true}'::jsonb, ARRAY['auto_writeoff_promo'], 'compliance', a.id,
       'the live gate asking to arm the unattended promotional write-off'
  FROM crm.rep_profile a
 WHERE a.subject = 'rep-ada'
   AND NOT EXISTS (SELECT 1 FROM crm.config_proposal p
                    WHERE p.tenant_id = '$TENANT' AND p.decision IS NULL);
COMMIT;
SQL
ok "crm.rep_profile maps rep-ada → Employee emp-1, and lot LOT-LIVE-1 of itm-1 exists"
ok "rep-ada holds the administrator grant — granted by Grace, because 0023 lets nobody grant themselves one"
ok "and a pending four-eyes proposal is waiting, with two compliance officers to decide it"

# AND IT IS ALREADY LATE. 0064 stamps the deadline on INSERT and freezes it on UPDATE — a
# deadline the writer chooses is not a deadline — so simulating a week passing means turning
# both guarantees off explicitly, which is what a fixture undoing one should look like. The
# contract suite does it the honest way round, by injecting a clock into the sweep; the claim
# HERE is about the deployed binary, which reads the wall clock and cannot be told otherwise.
psql -d "$CRM_DB" -v ON_ERROR_STOP=1 -q -c "
  ALTER TABLE crm.config_proposal DISABLE TRIGGER USER;
  UPDATE crm.config_proposal SET decide_by = clock_timestamp() - interval '2 days'
   WHERE tenant_id = '$TENANT' AND decision IS NULL;
  ALTER TABLE crm.config_proposal ENABLE TRIGGER USER" \
  || fail "could not back-date the proposal's deadline"
ok "and its deadline is two days past, so the sweep has an escalation to raise as well"

# PORT=0: the binary logs the port it actually bound, so no fourth fixed socket is
# reserved and a stale listener cannot be mistaken for this one.
export LIVE_KID="$KID"
export LIVE_IDP_PEM="$WORK/idp.pem"
export LIVE_OIDC_ISSUER="https://idp.test"
export LIVE_OIDC_AUDIENCE="https://crm.test/api"
export LIVE_ERP_ROLE="$ERP_ROLE"
export CRM_PGUSER="${CRM_PGUSER:-crm_app}"
export CRM_PGPASSWORD="${CRM_PGPASSWORD:-crm_app}"
( cd "$ROOT" \
  && PGHOST="$PGHOST" PGUSER="$CRM_PGUSER" PGPASSWORD="$CRM_PGPASSWORD" PGDATABASE="$CRM_DB" \
     PORT=0 \
     OIDC_ISSUER="$LIVE_OIDC_ISSUER" \
     OIDC_AUDIENCE="$LIVE_OIDC_AUDIENCE" \
     OIDC_JWKS_URL="http://127.0.0.1:$IDP_PORT/.well-known/jwks.json" \
     exec node "$API_BIN" ) > "$WORK/api.out" 2> "$WORK/api.err" &
API_PID=$!
wait_for_line "$WORK/api.out" '"type":"listening"' "$API_PID" 120 "the CRM's API binary"
API_PORT="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$WORK/api.out" | head -1)"
[ -n "$API_PORT" ] || fail "the API logged a listening line with no port in it"
export CRM_API_BASE_URL="http://127.0.0.1:$API_PORT"
ok "the API binary is listening on $API_PORT, verifying human tokens against the IdP's JWKS"

node "$ROOT/scripts/live-erp/drive-binaries.mjs" api-write "$WORK" \
  || fail "the API binary's checks reported failures (see the ok:/FAIL: lines above)"

# ---------------------------------------------------------------------------
echo
echo "--- 11. the scheduler binary, booted as production does, drains that row ---"
# The invocation is deploy/docker-compose.yml's `scheduler` service, variable for
# variable: NODE_ENV=production, the signing key read from the path
# CRM_SIGNING_KEY_FILE names, the issuer and audience that must match the ERP's
# --jwt-issuer/--jwt-audience, and NO ERP_TOKEN. Nothing here hands it a token, a
# role or a tenant list: it resolves all three itself.
#
# TICK_INTERVAL_MS is the knob the binary already reads, used rather than sleeping
# blindly: at 1s the loop comes round fast enough that a bounded wait on the
# process's OWN relay_drain line is the signal, instead of a guess about timing.
SCHED_ENV=(
  PGHOST="$PGHOST" PGUSER="$CRM_PGUSER" PGPASSWORD="$CRM_PGPASSWORD" PGDATABASE="$CRM_DB"
  NODE_ENV=production
  ERP_BASE_URL="$ERP_BASE_URL"
  CRM_SIGNING_KEY_FILE="$WORK/key.pem"
  CRM_TOKEN_ISSUER="$ISSUER"
  ERP_TOKEN_AUDIENCE="$AUDIENCE"
  TICK_INTERVAL_MS=1000
)
echo "    NODE_ENV=production CRM_SIGNING_KEY_FILE=… node packages/scheduler/dist/bin/scheduler.js"
( cd "$ROOT" && exec env "${SCHED_ENV[@]}" node "$SCHED_BIN" ) > "$WORK/sched.out" 2> "$WORK/sched.err" &
SCHED_PID=$!
# `ensureJobs` creates every job row due immediately on a tenant's first tick, so
# the first drain needs no nudging. 120s rather than 30: the same tick also runs
# three snapshot refreshes against the live ERP.
wait_for_line "$WORK/sched.out" '"type":"job_ok".*"job":"relay_drain"' "$SCHED_PID" 240 \
  "the scheduler's own relay_drain tick"
ok "the scheduler booted and reported a relay_drain tick of its own"

# 0063's sweep, in the deployed binary. The one job besides the relay and the snapshots whose
# WORK this file asserts rather than merely observing: the fixture above left a proposal
# pending with a second officer who was never told about it, which is the state the sweep
# exists for, and the line has to say it told somebody.
wait_for_line "$WORK/sched.out" '"type":"job_ok".*"job":"notify_approvals"' "$SCHED_PID" 120 \
  "the scheduler's notify_approvals tick"
# The job_ok line, not the job_start one that precedes it — `job_start` ends right after the
# job name, so matching the first occurrence found a line with no `detail` at all and reported
# a sweep that had notified nobody. Measured, not reasoned about: the run said so.
APPROVAL_LINE="$(grep '"type":"job_ok".*"job":"notify_approvals"' "$WORK/sched.out" | head -1)"
case "$APPROVAL_LINE" in
  *'notified=2'*) ok "notify_approvals told the officer who could decide it — $APPROVAL_LINE" ;;
  *) fail "notify_approvals ran and notified nobody: $APPROVAL_LINE" ;;
esac
# TWO notices for one proposal, because it is two facts: it is waiting for her, and it is
# already late. 0064's escalation is a second KIND rather than a louder first one, so an
# operator can route it somewhere the first does not go.
case "$APPROVAL_LINE" in
  *'ESCALATED=1'*'overdue=1'*) ok "and escalated it, once, because its deadline had passed" ;;
  *) fail "notify_approvals did not escalate an overdue proposal: $APPROVAL_LINE" ;;
esac
# And the notifications are rows, in the right inbox, raised by the scheduler rather than by
# anything this harness did — which is the half a log line cannot prove.
TOLD="$(psql -d "$CRM_DB" -At -c "
  SELECT string_agg(DISTINCT n.kind, ',' ORDER BY n.kind)
    FROM crm.notification n JOIN crm.rep_profile r ON r.id = n.recipient_rep_profile_id
   WHERE n.tenant_id = '$TENANT' AND r.subject = 'rep-grace'
     AND n.kind LIKE 'config_change_%'")"
[ "$TOLD" = "config_change_approval_overdue,config_change_awaiting_approval" ] \
  || fail "expected both approval kinds in rep-grace's inbox, found: $TOLD"
ok "and both notices are rows in Grace's inbox — the request, and that it is overdue"
URGENT="$(psql -d "$CRM_DB" -At -c "
  SELECT severity FROM crm.notification
   WHERE tenant_id = '$TENANT' AND kind = 'config_change_approval_overdue'")"
[ "$URGENT" = "urgent" ] || fail "an overdue approval should be urgent, found: $URGENT"
ok "and the escalation is urgent, where the first notice was a warning"

stop_gracefully "$SCHED_PID" "the scheduler"
SCHED_PID=""
[ "$(cat "$WORK/last-exit")" = "0" ] || fail "the scheduler did not stop cleanly on SIGTERM"
grep -q '"type":"shutdown"' "$WORK/sched.out" || fail "the scheduler exited without logging its shutdown"
ok "and stopped cleanly on SIGTERM, draining the tick in flight first"

node "$ROOT/scripts/live-erp/drive-binaries.mjs" drain "$WORK" \
  || fail "the scheduler binary's checks reported failures (see the ok:/FAIL: lines above)"

# ---------------------------------------------------------------------------
echo
echo "--- 12. the ERP role is the tenant's row, not the process's environment ---"
# The control for §11b. The environment of the second run is byte-identical to the
# first; the only change is one column of one row. `next_run_at` is pulled back to
# now because the first run advanced it by the job's 30s cadence — the tick still
# happens on the scheduler's own loop through `claimDueJobs`, this only stops the
# gate spending half a minute waiting for a window.
PGPASSWORD="$CRM_PGPASSWORD" psql -h "$PGHOST" -U "$CRM_PGUSER" -d "$CRM_DB" \
  -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not downgrade the tenant's ERP role"
BEGIN;
SELECT set_config('app.current_tenant_id', '$TENANT', true);
UPDATE crm.erp_service_principal SET erp_role = 'erp_viewer' WHERE tenant_id = '$TENANT';
UPDATE crm.scheduled_job SET next_run_at = now() WHERE tenant_id = '$TENANT' AND job = 'relay_drain';
COMMIT;
SQL
node "$ROOT/scripts/live-erp/drive-binaries.mjs" role-setup "$WORK" || fail "could not queue the erp_viewer row"
ok "crm.erp_service_principal now grants 'erp_viewer', which cannot create a StockMovement"

( cd "$ROOT" && exec env "${SCHED_ENV[@]}" node "$SCHED_BIN" ) > "$WORK/sched2.out" 2> "$WORK/sched2.err" &
SCHED_PID=$!
wait_for_line "$WORK/sched2.out" '"type":"job_ok".*"job":"relay_drain"' "$SCHED_PID" 120 \
  "the scheduler's relay_drain tick under erp_viewer"
stop_gracefully "$SCHED_PID" "the scheduler"
SCHED_PID=""

node "$ROOT/scripts/live-erp/drive-binaries.mjs" role "$WORK" \
  || fail "the role control reported failures (see the ok:/FAIL: lines above)"

PGPASSWORD="$CRM_PGPASSWORD" psql -h "$PGHOST" -U "$CRM_PGUSER" -d "$CRM_DB" -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL
BEGIN;
SELECT set_config('app.current_tenant_id', '$TENANT', true);
UPDATE crm.erp_service_principal SET erp_role = '$ERP_ROLE' WHERE tenant_id = '$TENANT';
COMMIT;
SQL
ok "the tenant's role is restored to '$ERP_ROLE'"

# ---------------------------------------------------------------------------
echo
echo "--- 13. the scheduler refuses a static ERP_TOKEN under NODE_ENV=production ---"
# A NEGATIVE CONTROL, and the kind that matters: a static bearer token shared
# across every tenant, carrying whatever role the ERP bound it to, is the weakest
# credential in the system. The refusal is a process-start decision, so it is
# asserted on the exit status and the sentence, not on a return value.
#
# NOTE WHAT IS ABSENT: no CRM_SIGNING_KEY_FILE. A signing key takes precedence over
# ERP_TOKEN by design, so leaving one set would make this pass for the wrong reason.
set +e
( cd "$ROOT" && env \
    PGHOST="$PGHOST" PGUSER="$CRM_PGUSER" PGPASSWORD="$CRM_PGPASSWORD" PGDATABASE="$CRM_DB" \
    NODE_ENV=production ERP_TOKEN=a-static-development-token ERP_BASE_URL="$ERP_BASE_URL" \
    TICK_INTERVAL_MS=1000 \
    timeout 60 node "$SCHED_BIN" ) > "$WORK/prod.out" 2> "$WORK/prod.err"
PROD_CODE=$?
set -e
[ "$PROD_CODE" -ne 0 ] || fail "the scheduler STARTED on a static ERP_TOKEN under NODE_ENV=production"
[ "$PROD_CODE" -ne 124 ] || fail "the scheduler neither started nor refused — it hung"
grep -q "ERP_TOKEN is a development-only static credential" "$WORK/prod.err" \
  || { cat "$WORK/prod.err" >&2; fail "it exited $PROD_CODE without saying why — an operator gets no cause"; }
grep -q "CRM_SIGNING_KEY_PEM" "$WORK/prod.err" \
  || fail "the refusal does not name the variable that fixes it"
ok "it exits $PROD_CODE and names both the cause and the remedy"

# THE COMPLEMENT, and it is the half that makes the check mean anything: without it
# this section passes just as well against a binary that cannot start at all.
( cd "$ROOT" && exec env \
    PGHOST="$PGHOST" PGUSER="$CRM_PGUSER" PGPASSWORD="$CRM_PGPASSWORD" PGDATABASE="$CRM_DB" \
    ERP_TOKEN=a-static-development-token ERP_BASE_URL="$ERP_BASE_URL" TICK_INTERVAL_MS=60000 \
    node "$SCHED_BIN" ) > "$WORK/dev.out" 2> "$WORK/dev.err" &
DEV_SCHED_PID=$!
wait_for_line "$WORK/dev.out" '"type":"started"' "$DEV_SCHED_PID" 120 "the same binary without NODE_ENV=production"
grep -q '"type":"credential","kind":"static"' "$WORK/dev.out" \
  || { tail -10 "$WORK/dev.out" >&2; fail "it started, but not on the static credential"; }
grep -q "static ERP_TOKEN credential" "$WORK/dev.err" \
  || fail "it took the static credential silently — development only is a thing to say out loud"
stop_gracefully "$DEV_SCHED_PID" "the development scheduler"
DEV_SCHED_PID=""
ok "the same binary and the same ERP_TOKEN start outside production, with the warning on stderr"

# ---------------------------------------------------------------------------
echo
echo "--- 14. both processes are gone ---"
# A leaked listener is the failure that disguises itself: the next run fails on
# "something is already listening", four steps from the cause. The trap covers the
# failing path; this covers the passing one, which the trap never exercises.
STARTED_PIDS="$API_PID $IDP_PID"
for pid in $STARTED_PIDS; do
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
done
API_PID=""
IDP_PID=""
# Only this run's own pids are examined. Another agent's scheduler on this host is
# not this gate's business, and a `pgrep` wide enough to see it would fail the run
# for somebody else's process.
LEFT=""
for pid in $STARTED_PIDS; do
  kill -0 "$pid" 2>/dev/null && LEFT="$LEFT $pid"
done
[ -z "$LEFT" ] || fail "a process this gate started is still running:$LEFT"
ok "every process this gate started — ERP, 2 key sets, API, 3 schedulers — is accounted for"

# ---------------------------------------------------------------------------
echo
echo "--- 15. the retention vocabulary still matches the ERP's own source ---"
# Migration 0051 takes five obligation codes verbatim from the ERP's RETENTION_OBLIGATIONS so
# that a deletion recorded on both sides of the boundary reads as one record rather than two
# dialects. The whole value of that is lost the first time one side renames a code, and a
# vocabulary copied by hand is a vocabulary that drifts — so this reads the ERP's SOURCE rather
# than trusting the comment that says where the codes came from.
#
# A grep and not an import: the CRM deliberately depends on no @crossengin/* package (it reads
# over HTTP), so there is nothing to typecheck against. The ERP file is read-only here, as
# every other use of this checkout is.
ERP_OBLIGATIONS_FILE="$ERP_DIR/packages/tenant-lifecycle/src/gdpr-deletion.ts"
if [ ! -f "$ERP_OBLIGATIONS_FILE" ]; then
  fail "the ERP has no $ERP_OBLIGATIONS_FILE — 0051's shared obligation codes cannot be checked"
fi
erp_codes="$(awk '/^export const RETENTION_OBLIGATIONS = \[/{inside=1;next} inside&&/^\] as const;/{exit} inside' \
             "$ERP_OBLIGATIONS_FILE" | sed -n 's/.*"\([a-z0-9_]*\)".*/\1/p' | sort | tr '\n' ' ')"
[ -n "$erp_codes" ] || fail "could not read RETENTION_OBLIGATIONS out of $ERP_OBLIGATIONS_FILE"

# The CRM's half, from the CRM's own constant, through the same extraction.
crm_codes="$(awk '/^export const ERP_RETENTION_OBLIGATIONS = \[/{inside=1;next} inside&&/^\] as const;/{exit} inside' \
             "$ROOT/packages/erasure/src/obligations.ts" | sed -n 's/.*"\([a-z0-9_]*\)".*/\1/p' | sort | tr '\n' ' ')"
[ -n "$crm_codes" ] || fail "could not read ERP_RETENTION_OBLIGATIONS out of packages/erasure/src/obligations.ts"

if [ "$erp_codes" != "$crm_codes" ]; then
  fail "the shared retention vocabulary has drifted. ERP: [$erp_codes] CRM: [$crm_codes]"
fi
ok "0051's shared obligation codes are spelled exactly as the ERP spells them — $crm_codes"

# And the database agrees with the TypeScript, which the contract suite also asserts — repeated
# here because this gate runs against a database built by the real migration runner.
db_codes="$(PGPASSWORD="${CRM_PGPASSWORD:-crm_app}" psql -h "$PGHOST" -U "${CRM_PGUSER:-crm_app}" -d "$CRM_DB" \
            -tAc "SELECT string_agg(o, ' ' ORDER BY o) FROM unnest(crm.retention_obligations()) o" 2>/dev/null || true)"
[ -n "$db_codes" ] || fail "crm.retention_obligations() answered nothing"
for code in $crm_codes; do
  case " $db_codes " in
    *" $code "*) ;;
    *) fail "crm.retention_obligations() is missing the shared code $code" ;;
  esac
done
ok "and crm.retention_obligations() carries every one of them — $db_codes"

# ---------------------------------------------------------------------------
echo
echo "--- 16. the ERP checkout is exactly as it was found ---"
erp_manifest > "$WORK/erp-after.txt"
if diff -q "$WORK/erp-before.txt" "$WORK/erp-after.txt" >/dev/null; then
  ok "not one file under $ERP_DIR changed"
else
  diff -u "$WORK/erp-before.txt" "$WORK/erp-after.txt" | head -20 >&2
  fail "this run MODIFIED the ERP checkout — it is read-only; see the diff above"
fi

# ---------------------------------------------------------------------------
echo
BIN_CHECKS=0
BIN_FAILS=0
while read -r c f; do
  BIN_CHECKS=$((BIN_CHECKS + c))
  BIN_FAILS=$((BIN_FAILS + f))
done < "$WORK/counts"
[ "$BIN_FAILS" -eq 0 ] || fail "$BIN_FAILS binary check(s) failed"
ok "$LIB_CHECKS checks over the dist as a library + $BIN_CHECKS over the two binaries = $((LIB_CHECKS + BIN_CHECKS)), 0 failures"
ok "every live check passed"
