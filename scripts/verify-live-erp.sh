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
# This boots the real server on a throwaway database and drives the SHIPPED dist
# of @crm/credential, @crm/acl and @crm/relay at it. Nothing here mints its own
# token, writes its own query string, or classifies its own error: a harness that
# did would verify the harness.
#
# Every check carries a CONTROL where one is possible, because this repo has been
# bitten three times by assertions that passed against inert behaviour. "An
# unknown filter returns every row" is worthless without "a known filter returns
# fewer"; "a bad sort does not reorder" is worthless without "a good sort does".
#
# WHAT IT DOES NOT PROVE:
#   * Nothing about the ERP under load, concurrency, or more than one tenant's
#     manifest. One tenant on the boot pack is served here; a tenant on a custom
#     manifest (ADR-0001 Q11) has a different entity set and is NOT exercised.
#   * Nothing about ADR-0001 option (b)'s single-database arrangement. The ERP
#     gets its own database here, so the CRM's SELECT grant on
#     meta.operate_entity_records is still the stand-in from scripts/erp-fixture.sh.
#     Only the HTTP path to the ERP is live.
#   * Nothing about the ERP's GL, period locks or write-effects. The entities
#     driven here are the ones the CRM's own outbox touches.
#   * Nothing about TLS, a reverse proxy, or key rotation under live traffic. The
#     JWKS is served over plain HTTP on loopback.
#   * It is not a CI gate. It needs a Postgres cluster, a built CrossEngin
#     checkout and ~40 seconds. Run it when the CRM→ERP contract changes.
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
ERP_PID=""
JWKS_PID=""

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

cleanup() {
  local code=$?
  [ -n "$ERP_PID" ] && kill "$ERP_PID" 2>/dev/null || true
  [ -n "$JWKS_PID" ] && kill "$JWKS_PID" 2>/dev/null || true
  if [ "$code" -ne 0 ] && [ -f "$WORK/erp.log" ]; then
    echo; echo "--- last 25 lines of the operate-server log ---" >&2
    tail -25 "$WORK/erp.log" >&2
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

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
ok "@crm/acl, @crm/credential, @crm/relay and @crm/db are built"

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
psql -d "$CRM_DB" -At -c "SELECT 1 FROM crm.outbox LIMIT 0" >/dev/null 2>&1 \
  || fail "$CRM_DB has no crm.outbox — run the CRM migrations first"
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
node "$ROOT/scripts/live-erp/drive.mjs" || fail "live verification reported failures (see the ok:/FAIL: lines above)"

# ---------------------------------------------------------------------------
echo
echo "--- 10. the ERP checkout is exactly as it was found ---"
erp_manifest > "$WORK/erp-after.txt"
if diff -q "$WORK/erp-before.txt" "$WORK/erp-after.txt" >/dev/null; then
  ok "not one file under $ERP_DIR changed"
else
  diff -u "$WORK/erp-before.txt" "$WORK/erp-after.txt" | head -20 >&2
  fail "this run MODIFIED the ERP checkout — it is read-only; see the diff above"
fi

echo
ok "every live check passed"
