#!/usr/bin/env bash
# Checks the migration runner against a real Postgres, on a database that holds
# the ERP stand-in and nothing else.
#
# Why this is a gate and not a unit test: the four properties below are the ones a
# fake connection cannot observe, and three of them have been broken in this repo
# at least once.
#
#   1. Every crm table ends up owned by crm_app. An OWNER BYPASSES RLS, so a table
#      owned by the admin makes its policy decoration. Broken once by migration
#      0010, which created an extension, which made it a DBA file.
#   2. The schema invariants (RLS enabled AND forced, crm_app owning nothing of the
#      ERP's) hold on a database the RUNNER built, not only on one psql built.
#      ENABLE without FORCE does nothing for the owner, and crm_app is the owner.
#   3. A second run is a no-op. The DBA files run on every deploy by design, so
#      they must be idempotent.
#   4. An edited already-applied migration is REFUSED, not silently re-run or
#      silently skipped.
#
# Usage: PGDATABASE=… [PGHOST=… PGUSER=… PGPASSWORD=…] scripts/verify-migration-runner.sh
# The database must already exist and must NOT already have a crm schema.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${PGDATABASE:?PGDATABASE must be set}"
export CRM_APP_PASSWORD="${CRM_APP_PASSWORD:-verify-$$-'quoted'}"  # a quote on purpose
export MIGRATIONS_DIR="$ROOT/db/migrations"

fail() { echo "FAIL: $*" >&2; exit 1; }
q() { psql -v ON_ERROR_STOP=1 -At -c "$1"; }

if [ "$(q "SELECT count(*) FROM information_schema.schemata WHERE schema_name='crm'")" != "0" ]; then
  fail "database $PGDATABASE already has a crm schema; this check needs a fresh one"
fi

"$ROOT/scripts/erp-fixture.sh"

echo "--- dry run on an empty database ---"
node packages/db/dist/bin/migrate.js --dry-run | tee /tmp/crm-dry-1.log
grep -q '"type":"no_ledger"' /tmp/crm-dry-1.log || fail "dry run did not report a missing ledger"

echo "--- first run ---"
node packages/db/dist/bin/migrate.js | tee /tmp/crm-run-1.log
applied=$(grep -c '"type":"applied"' /tmp/crm-run-1.log || true)
[ "$applied" -gt 0 ] || fail "first run applied no migrations"
grep -q '"type":"app_role_password_set"' /tmp/crm-run-1.log \
  || fail "the app role password was not set (a quoted password may have broken it)"

echo "--- 1. ownership ---"
bad=$(q "SELECT coalesce(string_agg(c.relname || ' owned by ' || pg_get_userbyid(c.relowner), ', '), '')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'crm' AND c.relkind = 'r'
           AND pg_get_userbyid(c.relowner) <> 'crm_app'")
[ -z "$bad" ] || fail "crm tables not owned by crm_app: $bad"
echo "ok: every crm table is owned by crm_app"

echo "--- 2. the schema invariants hold on a runner-built database ---"
# The existing contract test, pointed at THIS database rather than the one
# setup-test-db.sh builds with psql. Reusing it rather than restating its
# assertions in bash: the authoritative RLS-exemption list and the "crm_app owns
# nothing in meta" check live there, and a copy here would drift from them.
PGDATABASE="$PGDATABASE" pnpm exec vitest run packages/db/src/schema.contract.test.ts \
  || fail "schema invariants do not hold on a database built by the migration runner"

echo "--- 3. second run is a no-op ---"
node packages/db/dist/bin/migrate.js | tee /tmp/crm-run-2.log
[ "$(grep -c '"type":"applied"' /tmp/crm-run-2.log || true)" = "0" ] \
  || fail "second run applied something; migrations are not idempotent"
node packages/db/dist/bin/migrate.js --dry-run | tee /tmp/crm-dry-2.log
grep -q '"pending":0' /tmp/crm-dry-2.log || fail "dry run still reports pending migrations"
echo "ok: idempotent"

echo "--- 4. an edited applied migration is refused ---"
victim="$(ls "$MIGRATIONS_DIR"/*.sql | grep -v '000[12]_' | tail -1)"
cp "$victim" "$victim.bak"
trap 'mv -f "$victim.bak" "$victim" 2>/dev/null || true' EXIT
printf '\n-- tampered by verify-migration-runner.sh\n' >> "$victim"

set +e
node packages/db/dist/bin/migrate.js --dry-run >/tmp/crm-dry-3.log 2>&1
dry_code=$?
node packages/db/dist/bin/migrate.js >/tmp/crm-run-3.log 2>&1
run_code=$?
set -e
mv -f "$victim.bak" "$victim"; trap - EXIT

[ "$dry_code" = "1" ] || fail "dry run exited $dry_code on an edited migration, expected 1"
grep -q 'CHANGED_AFTER_APPLY' /tmp/crm-dry-3.log || fail "dry run did not name the edited file"
[ "$run_code" != "0" ] || fail "a real run ACCEPTED an edited migration"
echo "ok: refused (dry run exit 1, real run exit $run_code)"

echo
echo "migration runner verified against $PGDATABASE"
