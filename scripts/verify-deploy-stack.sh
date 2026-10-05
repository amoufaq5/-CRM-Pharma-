#!/usr/bin/env bash
# Static checks on the deployment stack.
#
# WHY THIS EXISTS. deploy/ has never been built or run: this environment has the Docker
# CLI but no daemon, so `docker build` and `docker compose up` are both impossible here.
# That left the whole stack — compose file, Dockerfile, Caddyfile — verified by reading,
# which is exactly the standard the rest of this repo refuses to accept.
#
# `docker compose config` is CLIENT-SIDE. It needs no daemon, and it does real work:
# it parses the file, resolves the YAML anchors and merges, expands every ${VAR}, and
# fails on an unknown key or a dangling service reference. That turns "it looks right"
# into a gate.
#
# WHAT IT STILL DOES NOT DO: nothing here builds an image or starts a container. The
# Dockerfile's RUN steps, the pnpm install inside it, the runtime's ability to find its
# own dist/, and whether the services actually talk to each other remain UNVERIFIED.
# Do not read a pass here as "the stack works". It means the stack is well-formed and
# the invariants below hold.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/deploy"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

command -v docker >/dev/null || fail "docker CLI not found; this script needs the client only, not a daemon"

# ---------------------------------------------------------------------------
echo "--- 1. the compose file resolves, with .env.example filled in ---"
# .env.example rather than .env: the example is the file in version control, so this
# checks the configuration a new operator actually starts from. A variable added to
# compose and forgotten in the example is the failure this catches.
set -a; . ./.env.example; set +a
docker compose config -q
ok "compose config resolves"

CONFIG="$(docker compose config 2>/dev/null)"

# ---------------------------------------------------------------------------
echo "--- 2. every compose variable without a default is in .env.example ---"
# `docker compose config` substitutes blanks for unset variables and only WARNS, so a
# renamed variable produces a stack that starts and then misbehaves. Compared against
# the committed example rather than the environment, for the same reason as above.
missing=0
while read -r var; do
  grep -qE "^#?\s*${var}=" ./.env.example || { echo "  missing from .env.example: ${var}"; missing=1; }
done < <(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' docker-compose.yml | tr -d '${}' | sort -u)
[ "$missing" -eq 0 ] || fail "compose references variables .env.example does not document"
ok "every \${VAR} without a default is documented"

# ---------------------------------------------------------------------------
echo "--- 3. the application services run as crm_app, never the admin ---"
# The isolation guarantee (ADR-0001 item 2, item 14). A table's owner bypasses RLS and a
# superuser bypasses it even under FORCE, so an application process on the admin identity
# would void every policy in the schema. `withTenantContext` now refuses such a
# connection at runtime; this is the same rule one layer out, where it is cheaper to fix.
for svc in api scheduler; do
  user="$(printf '%s' "$CONFIG" | awk -v s="  $svc:" '
    $0 == s {inside=1} inside && /^      PGUSER:/ {print $2; exit}')"
  [ "$user" = "crm_app" ] || fail "$svc runs as PGUSER=${user:-<unset>}, must be crm_app"
done
ok "api and scheduler both run as crm_app"

# The migrate job is the ONE service that legitimately needs the admin: CREATE ROLE and
# CREATE EXTENSION are things crm_app cannot and must not do. It sets the role itself
# before the application migrations, so the tables still come out owned correctly.
printf '%s' "$CONFIG" | grep -q 'MIGRATIONS_DIR' || fail "migrate service lost MIGRATIONS_DIR"
ok "migrate is the only service on the admin identity"

# ---------------------------------------------------------------------------
echo "--- 4. ordering: nothing serves before the migration has succeeded ---"
for svc in api scheduler; do
  printf '%s' "$CONFIG" | python3 -c "
import sys, yaml
c = yaml.safe_load(sys.stdin)
d = c['services']['$svc'].get('depends_on', {})
cond = d.get('migrate', {}).get('condition')
assert cond == 'service_completed_successfully', '$svc depends on migrate with condition %r' % cond
" || fail "$svc does not wait for migrate to complete successfully"
done
ok "api and scheduler wait for migrate to complete successfully"

# Caddy must wait for the api to be HEALTHY, not merely started. /healthz reports
# readiness — including that the connection's role is one RLS applies to — so under
# `service_started` the proxy would send traffic to a container answering 503 to every
# request. deploy/README.md claims this gate; this is what makes the claim true.
printf '%s' "$CONFIG" | python3 -c "
import sys, yaml
c = yaml.safe_load(sys.stdin)
cond = c['services']['caddy'].get('depends_on', {}).get('api', {}).get('condition')
assert cond == 'service_healthy', 'caddy depends on api with condition %r, want service_healthy' % cond
" || fail "caddy does not gate on the api being healthy"
ok "caddy gates on the api being healthy"

# ---------------------------------------------------------------------------
echo "--- 5. no floating image tags ---"
# A `latest` (or bare) tag makes a redeploy pull something nobody chose, so the thing
# that is running stops being the thing that was tested. The ERP forbids it in its own
# contracts; same rule here.
while read -r img; do
  case "$img" in
    *:latest) fail "floating tag: $img" ;;
    *:*) ;;
    *) fail "untagged image: $img" ;;
  esac
done < <(printf '%s' "$CONFIG" | awk '/^    image:/ {print $2}')
ok "every image is pinned to a tag other than latest"

# ---------------------------------------------------------------------------
echo "--- 6. the runtime image does not run as root ---"
grep -qE '^USER ' "$ROOT/deploy/Dockerfile" || fail "deploy/Dockerfile never drops from root"
last_user="$(grep -E '^USER ' "$ROOT/deploy/Dockerfile" | tail -1 | awk '{print $2}')"
[ "$last_user" != "root" ] || fail "deploy/Dockerfile ends on USER root"
ok "runtime drops to USER $last_user"

# ---------------------------------------------------------------------------
echo "--- 7. the signing key reaches the scheduler and NOT the api ---"
# The api publishes the JWKS from the database and holds no private key, so it cannot
# mint an ERP token even if it is compromised. That property is worth a test because it
# is one careless copy-paste from being lost.
api_block="$(printf '%s' "$CONFIG" | python3 -c "
import sys, yaml, json
c = yaml.safe_load(sys.stdin)
print(json.dumps(c['services']['api'].get('environment', {})))")"
printf '%s' "$api_block" | grep -q 'CRM_SIGNING_KEY' && fail "the api service is given a signing key; only the scheduler may have one"
printf '%s' "$CONFIG" | python3 -c "
import sys, yaml
c = yaml.safe_load(sys.stdin)
env = c['services']['scheduler'].get('environment', {})
assert any(k.startswith('CRM_SIGNING_KEY') for k in env), 'scheduler has no signing-key variable at all'
" || fail "the scheduler cannot be given a signing key"
ok "only the scheduler can hold the signing key"

echo
echo "deploy stack statically verified — NOT built and NOT run (no Docker daemon here)"
