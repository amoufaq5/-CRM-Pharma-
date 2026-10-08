#!/usr/bin/env bash
# Build the image and RUN the stack: Postgres, the migration one-shot, the API, the
# scheduler, and the TLS edge. The real thing, with a real database.
#
# WHY THIS EXISTS. For six weeks every document in deploy/ said the stack had never been
# built or run because no Docker daemon was available. That was taken on faith and it was
# wrong: `dockerd` starts fine in the development container, nobody had tried, and the
# image could not build. Four independent reasons, each fatal, listed in the header of
# scripts/verify-image-build.sh. The cost of not trying was six weeks of a deployment
# that would have failed at `docker compose up` on first use.
#
# So this is the thing that was missing. verify-deploy-stack.sh reads the files,
# verify-image-build.sh replays the image without Docker, and this one actually runs it:
#
#   - the image builds from a clean context;
#   - migrate REFUSES on a database with no ERP in it, naming the real cause (the
#     precondition in migration 0001, which until now had only ever been tested by SQL);
#   - with the ERP stand-in present it applies all of them and exits 0;
#   - a second run is a no-op;
#   - the api comes up HEALTHY, which includes "connected as a role row-level security
#     applies to" — so this proves the compose file's identities, not just its syntax;
#   - the api serves /healthz, publishes the JWKS, and refuses an unauthenticated request
#     with an RFC 9457 problem;
#   - the scheduler refuses to start with no ERP credential, and starts with one — and
#     the key it signs with is the one the api publishes, which is the whole credential
#     design working across two containers and a database;
#   - the TLS edge answers for the api.
#
# It is destructive only to its own compose project and its own volumes, which it removes
# on the way out, including on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${CRM_SMOKE_PROJECT:-crm-pharma-smoke}"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yml"
ENV_FILE=""
WORK=""

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

cleanup() {
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || fail "docker CLI not found"
docker info >/dev/null 2>&1 || fail "no Docker daemon. On a machine without one, try \`dockerd\` first — that assumption is what let a broken image ship"

WORK="$(mktemp -d)"
ENV_FILE="$WORK/env"

# ---------------------------------------------------------------------------
echo "--- 1. build the image from a clean context ---"
DOCKERFILE="$ROOT/deploy/Dockerfile"
# Two deviations are permitted, both for the environment rather than the stack, both
# injected here rather than committed, and both PRINTED so a reader can see that nothing
# else differs from the committed Dockerfile:
#
#   CRM_SMOKE_CA_FILE   a sandbox that re-terminates TLS needs its CA inside the build,
#                       or pnpm cannot reach the registry;
#   CRM_SMOKE_PIN_BASE  a digest for the base image, for when the registry answers 429 to
#                       an anonymous manifest HEAD. Pinning to the digest of the same tag
#                       changes nothing about what is built.
#
# With neither set the build is deploy/Dockerfile byte for byte, which is what CI runs.
if [ -n "${CRM_SMOKE_CA_FILE:-}" ] || [ -n "${CRM_SMOKE_PIN_BASE:-}" ]; then
  if [ -n "${CRM_SMOKE_CA_FILE:-}" ]; then
    [ -f "$CRM_SMOKE_CA_FILE" ] || fail "CRM_SMOKE_CA_FILE=$CRM_SMOKE_CA_FILE does not exist"
    cp "$CRM_SMOKE_CA_FILE" "$ROOT/.verify-ca.crt"
    trap 'rm -f "$ROOT/.verify-ca.crt"; cleanup' EXIT INT TERM
  fi
  DOCKERFILE="$WORK/Dockerfile.local"
  python3 - "$ROOT/deploy/Dockerfile" "$DOCKERFILE" "${CRM_SMOKE_CA_FILE:-}" "${CRM_SMOKE_PIN_BASE:-}" <<'PY'
import sys
src, dst, ca, pin = sys.argv[1:5]
out, stages, pinned = [], 0, 0
for line in open(src).read().split("\n"):
    if pin and line.startswith("FROM ") and "@sha256:" not in line:
        head, _, tail = line.partition(" AS ")
        line = f"{head}@{pin}" + (f" AS {tail}" if tail else "")
        pinned += 1
    out.append(line)
    if ca and line.startswith("FROM "):
        out += ["COPY .verify-ca.crt /usr/local/share/ca-certificates/ccr-sandbox.crt",
                "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ccr-sandbox.crt"]
        stages += 1
open(dst, "w").write("\n".join(out))
what = []
if stages:
    what.append(f"a CA into {stages} stage(s)")
if pinned:
    what.append(f"a base-image digest on {pinned} FROM line(s)")
print(f"    injected {' and '.join(what)}; nothing else differs from deploy/Dockerfile")
PY
fi
# --target runtime, for the same reason compose names it: the last stage is the edge,
# and an api container built from caddy:2 has no node in it.
docker build --target runtime -f "$DOCKERFILE" -t "$PROJECT:smoke" "$ROOT" > "$WORK/build.log" 2>&1 \
  || { tail -30 "$WORK/build.log" >&2; fail "docker build failed"; }
ok "image built"

# Compose builds `<project>-<service>` from the same Dockerfile. Tagging the one image
# we just built under those names means compose runs it instead of building three times,
# and the compose file itself is exercised exactly as committed.
for svc in migrate api scheduler; do docker tag "$PROJECT:smoke" "$PROJECT-$svc"; done

# ---------------------------------------------------------------------------
echo "--- 2. configuration: the committed example, with a local domain ---"
sed 's|^DOMAIN=.*|DOMAIN=localhost|' "$ROOT/deploy/.env.example" > "$ENV_FILE"
# DOMAIN=localhost makes Caddy use its internal CA instead of reaching out to ACME, so
# the edge can be tested offline. Everything else is the file an operator starts from —
# the point being that the placeholder values are enough to boot, and the two that are
# not (the signing key, the IdP) fail in a way that says so.
ok "env assembled from .env.example"

# ---------------------------------------------------------------------------
echo "--- 3. the database, and a migration that must refuse ---"
dc up -d db >/dev/null 2>&1 || fail "could not start the database"
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-db-1" 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-db-1")" = healthy ] || fail "the database never became healthy"
ok "database healthy"

# ADR-0001 put the CRM in the ERP's database, so the ERP has to be there first. Migration
# 0001 checks and fails with the real cause rather than letting a deploy die on
# `schema "meta" does not exist` thirty lines later. This is that path, in a container.
if dc run --rm migrate > "$WORK/refuse.log" 2>&1; then
  fail "migrate succeeded against a database with no ERP in it; the 0001 precondition is not holding"
fi
grep -q "operate_entity_records was not found" "$WORK/refuse.log" \
  || { tail -5 "$WORK/refuse.log" >&2; fail "migrate refused, but not for the documented reason"; }
ok "migrate refuses without the ERP, naming the cause"

# ---------------------------------------------------------------------------
echo "--- 4. the ERP stand-in, then the real migration ---"
# The repository's own fixture, run unmodified inside the database container.
dc exec -T -u postgres -e PGUSER=postgres -e PGDATABASE=crossengin db bash -s < "$ROOT/scripts/erp-fixture.sh" >/dev/null \
  || fail "could not apply the ERP stand-in"
dc run --rm migrate > "$WORK/migrate.log" 2>&1 || { tail -10 "$WORK/migrate.log" >&2; fail "migrate failed with the ERP present"; }
grep -q '"type":"done"' "$WORK/migrate.log" || fail "migrate produced no done record"
applied="$(python3 -c "
import json,sys
for line in open('$WORK/migrate.log'):
    line = line.strip()
    if line.startswith('{'):
        rec = json.loads(line)
        if rec.get('type') == 'done':
            print(rec['dbaApplied'] + rec['applied'])
")"
[ "$applied" -gt 50 ] || fail "migrate reported only $applied applied migrations"
ok "$applied migrations applied"

dc run --rm migrate > "$WORK/again.log" 2>&1 || fail "the second migrate run failed"
python3 - "$WORK/again.log" <<'PY' || fail "the second run was not a no-op"
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("{") and json.loads(line).get("type") == "done":
        rec = json.loads(line)
        sys.exit(0 if rec["applied"] == 0 and rec["dbaApplied"] >= 0 else 1)
sys.exit(1)
PY
ok "a second run applies nothing"

# ---------------------------------------------------------------------------
echo "--- 5. the api, as crm_app ---"
dc up -d api >/dev/null 2>&1 || fail "could not start the api"
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-api-1" 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-api-1")" = healthy ] \
  || { dc logs api | tail -10 >&2; fail "the api never became healthy"; }
# Healthy is a stronger statement than it looks: /healthz asks the database whether this
# connection's role is one row-level security applies to, so a PGUSER pointing at the
# table owner answers 503. The compose file's two identities are load-bearing and this
# is where that is proven rather than asserted.
ok "api healthy (and therefore connected as a role RLS applies to)"

dc exec -T api node --input-type=module -e '
const at = async (path, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:8080${path}`, { headers });
  return { status: r.status, body: await r.text() };
};
const expect = (what, got, want) => {
  if (got !== want) { console.error(`${what} answered ${got}, expected ${want}`); process.exit(1); }
};

expect("/healthz", (await at("/healthz")).status, 200);

// 503, and deliberately not an empty key set. No key has been published yet at this
// point in the run, and the rule is in routes.ts: the ERP keeps its last good key set on
// any non-200, while a 200 replaces it with whatever arrived — so an empty document
// would silently disarm every verifier that fetched it. This script asserted 200 on its
// first run; the script was what was wrong.
expect("jwks with nothing published", (await at("/.well-known/jwks.json")).status, 503);

const anon = await at("/v1/accounts");
expect("/v1/accounts unauthenticated", anon.status, 401);
const problem = JSON.parse(anon.body);
if (!problem.type?.startsWith("https://") || problem.status !== 401) {
  console.error("the 401 was not an RFC 9457 problem document"); process.exit(1);
}
expect("/v1/accounts with a malformed token", (await at("/v1/accounts", { authorization: "Bearer not-a-token" })).status, 401);

console.log("PROBE-OK");
' > "$WORK/probe.log" 2>&1 || { tail -5 "$WORK/probe.log" >&2; fail "the api probe failed"; }
ok "healthz 200, jwks 503 with nothing published, 401 problem documents on a real route"

# ---------------------------------------------------------------------------
echo "--- 6. the scheduler: refuses without a credential, runs with one ---"
dc up -d scheduler >/dev/null 2>&1 || true
sleep 6
dc logs scheduler 2>&1 | grep -q "no ERP credential is configured" \
  || fail "the scheduler started without an ERP credential, or failed for another reason"
ok "refuses to start with no credential, saying which variables to set"

dc run --rm --entrypoint node scheduler packages/credential/dist/bin/service-key.js \
  generate --note "deploy smoke" > "$WORK/key.log" 2>&1 \
  || { tail -5 "$WORK/key.log" >&2; fail "could not generate a service key"; }
kid="$(python3 -c "
import json,sys
for line in open('$WORK/key.log'):
    line = line.strip()
    if line.startswith('{') and json.loads(line).get('type') == 'published':
        print(json.loads(line)['kid'])
")"
[ -n "$kid" ] || fail "the key generator published nothing"
python3 - "$WORK/key.log" "$ENV_FILE" <<'PY'
import pathlib, sys
log = pathlib.Path(sys.argv[1]).read_text()
pem = log[log.index("-----BEGIN PRIVATE KEY-----"): log.index("-----END PRIVATE KEY-----") + len("-----END PRIVATE KEY-----")]
env = pathlib.Path(sys.argv[2])
env.write_text(env.read_text().replace("CRM_SIGNING_KEY_PEM=\n", f'CRM_SIGNING_KEY_PEM="{pem.replace(chr(10), chr(92) + "n")}"\n'))
PY
dc up -d --force-recreate scheduler >/dev/null 2>&1 || fail "could not restart the scheduler with a key"
started=""
for _ in $(seq 1 15); do
  # Both lines, not just "started". The credential line is what carries the kid, and it
  # is emitted BEFORE the schedulers are wired — so waiting on "started" alone was
  # waiting on the wrong evidence, and would read a missing credential line as a wrong
  # key rather than as a slow boot.
  if dc logs scheduler 2>&1 | grep -q '"type":"started"' \
    && dc logs scheduler 2>&1 | grep -q '"type":"credential"'; then started=yes; break; fi
  sleep 2
done
[ -n "$started" ] || { dc logs scheduler 2>&1 | tail -20 >&2; fail "the scheduler never started with a credential"; }
if ! dc logs scheduler 2>&1 | grep -q "\"kid\":\"$kid\""; then
  # The evidence, not just the verdict. Without this the failure says the key is wrong
  # and gives no way to tell a wrong key from a missing credential line, a static
  # fallback (which logs "kid":null), or a PEM the env file mangled.
  echo "expected kid: $kid" >&2
  echo "credential line(s) the scheduler logged:" >&2
  dc logs scheduler 2>&1 | grep '"type":"credential"' >&2 || echo "  (none)" >&2
  echo "published line(s) the generator logged:" >&2
  grep '"type":"published"' "$WORK/key.log" >&2 || echo "  (none)" >&2
  echo "scheduler tail:" >&2
  dc logs scheduler 2>&1 | tail -20 >&2
  fail "the scheduler is not signing with the key that was just published"
fi
ok "scheduler running, signing with $kid"

# The two halves of the credential, across two containers: the scheduler holds the
# private key and the api publishes the public one out of the database. Nothing but the
# database connects them, which is the property that lets the api be compromised without
# anyone being able to mint an ERP token.
dc exec -T api node --input-type=module -e "
const r = await fetch('http://127.0.0.1:8080/.well-known/jwks.json');
const { keys } = await r.json();
if (!keys.some((k) => k.kid === '$kid')) { console.error('the api does not publish ' + '$kid'); process.exit(1); }
console.log('JWKS-OK');
" >/dev/null 2>&1 || fail "the api does not publish the key the scheduler signs with"
ok "the api publishes exactly the key the scheduler holds"

# ---------------------------------------------------------------------------
echo "--- 7. the TLS edge ---"
if [ "${CRM_SMOKE_SKIP_CADDY:-}" = "1" ]; then
  echo "SKIPPED by CRM_SMOKE_SKIP_CADDY=1 — say why wherever you set it; an unexplained skip is a lie"
else
  dc up -d caddy >/dev/null 2>&1 || fail "could not start caddy (a rate-limited image pull looks like this)"
  for _ in $(seq 1 20); do
    [ "$(docker inspect -f '{{.State.Running}}' "$PROJECT-caddy-1" 2>/dev/null)" = true ] && break
    sleep 2
  done
  # Through the edge, over TLS, with Caddy's internal CA — so this checks the proxy and
  # the certificate path, not just that the container is up.
  dc exec -T caddy sh -c 'wget -q -O - --no-check-certificate https://localhost/healthz' > "$WORK/edge.log" 2>&1 \
    || { dc logs caddy | tail -10 >&2; fail "the edge did not serve /healthz over TLS"; }
  grep -q '"status":"ok"' "$WORK/edge.log" || fail "the edge answered, but not with the api's health"
  ok "caddy serves the api over TLS"

  # The SAME origin serves the app. That is the arrangement that keeps both sides free of
  # CORS, so it is worth an assertion rather than an assumption — and an edge that
  # proxies the API correctly while answering 404 for the app is green everywhere and
  # useless to a rep.
  dc exec -T caddy sh -c 'wget -q -O - --no-check-certificate https://localhost/' > "$WORK/edge-app.log" 2>&1 \
    || fail "the edge did not serve the app at /"
  grep -q 'id="app"' "$WORK/edge-app.log" || fail "the edge served something at /, but not the field client's shell"
  dc exec -T caddy sh -c 'wget -q -O - --no-check-certificate https://localhost/app.js' > "$WORK/edge-bundle.log" 2>&1 \
    || fail "the edge did not serve the app bundle"
  grep -q 'dev-token' "$WORK/edge-bundle.log" \
    && fail "the bundle the edge serves still carries the paste-a-token login path"
  ok "and serves the field client from the same origin, with the dev login compiled out"
fi

echo
echo "the stack was built and RUN: migrate, api and scheduler against a real Postgres"
echo "this says nothing about ACME, a real IdP, or the ERP itself — all three are someone else's host"
