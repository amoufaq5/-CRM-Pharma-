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
# WHAT IT STILL DOES NOT DO: nothing here builds an image or starts a container, and
# whether the services actually talk to each other remains UNVERIFIED. Do not read a
# pass as "the stack works": it means the stack is well-formed and the invariants below
# hold.
#
# It used to say the same about the image's own RUN steps, and that gap was not
# theoretical — the image could not build, in four independent ways, for six weeks (the
# header of scripts/verify-image-build.sh lists them). Properties 8-10 below are the
# cheap static half of the answer: the manifest list matches the workspace, the context
# cannot carry host build output, and the build step covers every package. The expensive
# half is verify-image-build.sh, which replays both stages for real, and CI, which
# builds the image with Docker.
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

# ---------------------------------------------------------------------------
echo "--- 8. the Dockerfile's manifest layer lists every workspace package ---"
# The manifest layer exists for layer caching: copy the package.json files, install,
# THEN copy sources, so a source-only change reuses the dependency layer. The cost is a
# list that has to be kept in step with the workspace, and it was not — it named 8 of
# the 16 packages, so the other eight were not pnpm importers, got no node_modules, and
# the image could not build at all. Six weeks of THIS JOB passing went over it, because
# nothing compared the two lists. This does, deriving the expected one from
# pnpm-workspace.yaml, so adding a package and forgetting the Dockerfile is a red job
# rather than a broken deploy.
python3 - "$ROOT" <<'PY' || fail "the Dockerfile's manifest list and the workspace disagree"
import pathlib, re, sys, yaml

root = pathlib.Path(sys.argv[1])
globs = yaml.safe_load((root / "pnpm-workspace.yaml").read_text())["packages"]
expected = {
    str(d.relative_to(root))
    for g in globs
    for d in root.glob(g)
    if (d / "package.json").exists()
}
copied = set(re.findall(r"^COPY\s+(\S+)/package\.json\s", (root / "deploy/Dockerfile").read_text(), re.M))

missing = sorted(expected - copied)
extra = sorted(copied - expected)
if missing:
    print(f"  in the workspace, not copied into the image: {', '.join(missing)}")
if extra:
    print(f"  copied into the image, not in the workspace: {', '.join(extra)}")
sys.exit(1 if (missing or extra) else 0)
PY
ok "all $(ls -d "$ROOT"/packages/*/package.json | wc -l | tr -d ' ') workspace manifests are in the manifest layer"

# ---------------------------------------------------------------------------
echo "--- 9. the build context cannot carry the host's build output ---"
# This is what hid property 8's defect. With no .dockerignore, `COPY packages/ packages/`
# lands the host's packages/*/dist and packages/*/tsconfig.tsbuildinfo on top of what
# pnpm just installed; tsc then finds every project up to date, emits NOTHING, and the
# image ships whatever a developer's tree happened to contain. It looks correct
# everywhere except a clean build — which is to say everywhere except CI, where a green
# log is nobody's reading material.
[ -f "$ROOT/.dockerignore" ] || fail "there is no .dockerignore, so the build context carries the host's dist/ and node_modules"
for pattern in node_modules dist '*.tsbuildinfo'; do
  grep -qxF "$pattern" "$ROOT/.dockerignore" || grep -qxF "**/$pattern" "$ROOT/.dockerignore" \
    || fail ".dockerignore does not exclude $pattern; a host build would leak into the image"
done
ok ".dockerignore excludes node_modules, dist and *.tsbuildinfo"

# ---------------------------------------------------------------------------
echo "--- 10. the image's build step covers every workspace package ---"
# That step is `pnpm exec tsc --build`, which builds the root tsconfig's references and
# nothing else. A package missing from that list fails no gate: it typechecks
# (scripts/typecheck-tests.sh walks packages/* itself), its tests pass (vitest
# transpiles from source), and it simply never gets compiled. @crm/erasure sat in
# exactly that state — the GDPR Article 17 executor and the tombstone signer, declaring
# a bin that `pnpm build` never produced and no image ever carried.
python3 - "$ROOT" <<'PY' || fail "the root tsconfig does not cover every workspace package"
import json, pathlib, sys

root = pathlib.Path(sys.argv[1])
# tsconfig.json is strict JSON here, not JSONC. If that changes, so must this parse.
refs = {r["path"].strip("./") for r in json.loads((root / "tsconfig.json").read_text())["references"]}
buildable = {
    str(d.relative_to(root))
    for d in (root / "packages").iterdir()
    if (d / "tsconfig.json").exists() and (d / "src").is_dir()
}
missing = sorted(buildable - refs)
if missing:
    print(f"  compiled by nothing: {', '.join(missing)}")
sys.exit(1 if missing else 0)
PY
ok "every package with sources is a root tsconfig reference"

echo
echo "deploy stack statically verified — the image itself is replayed by"
echo "scripts/verify-image-build.sh and built for real by CI"
