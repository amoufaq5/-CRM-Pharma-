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
#   5. The cross-tenant pre-flight in 0035/0037 actually FIRES on a leaking database.
#      It walks `crm.tenant` to ask the question from inside each tenant, and
#      `crm.tenant` is EMPTY in a database either of this repo's setup paths builds
#      — so on every run until now that DO block looped zero times, applied cleanly,
#      and proved nothing. ADR-0001 carries that as an open item. This builds a
#      database that really does leak and asserts the migration refuses it.
#
# Usage: PGDATABASE=… [PGHOST=… PGUSER=… PGPASSWORD=…] scripts/verify-migration-runner.sh
# The database must already exist and must NOT already have a crm schema. Property 5
# needs a SECOND throwaway database, so the role must be able to CREATEDB; it is named
# after PGDATABASE and dropped at the end.
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

echo "--- 5. the cross-tenant pre-flight fires on a leaking database ---"
# 0035 and 0037 open with a DO block that asks, from inside each registered tenant,
# whether any reference already points across a tenant boundary — because a composite
# foreign key's bulk VALIDATE is an ordinary query and therefore sees ZERO rows as
# `crm_app` with no tenant context, so it would mark itself valid over a violating table.
# The block is the only thing standing between that and a silently-wrong constraint, and
# nothing has ever exercised it: it enumerates `crm.tenant`, which neither setup path
# populates.
#
# So: apply everything up to 0034, register two tenants, write the leak that this schema
# actually shipped once — a tenant B `rep_role` naming a tenant A `rep_profile`, through
# `granted_by`, which was a single-column reference until 0035 converted it — and then let
# the runner reach 0035.
PRE_DB="${PGDATABASE}_preflight"
PRE_DIR="$(mktemp -d)"
cleanup_pre() {
  rm -rf "$PRE_DIR"
  PGDATABASE=postgres dropdb --if-exists "$PRE_DB" >/dev/null 2>&1 || true
}
trap cleanup_pre EXIT

for f in "$MIGRATIONS_DIR"/*.sql; do
  n="$(basename "$f" | cut -c1-4)"
  [ "$n" -le 0034 ] && cp "$f" "$PRE_DIR/"
done
[ -f "$PRE_DIR/0035_composite_fks.sql" ] && fail "the subset must stop before 0035"

PGDATABASE=postgres dropdb --if-exists "$PRE_DB" >/dev/null 2>&1 || true
PGDATABASE=postgres createdb "$PRE_DB" \
  || fail "could not create $PRE_DB — property 5 needs a role that can CREATEDB"
PGDATABASE="$PRE_DB" "$ROOT/scripts/erp-fixture.sh" >/dev/null
MIGRATIONS_DIR="$PRE_DIR" PGDATABASE="$PRE_DB" node packages/db/dist/bin/migrate.js >/tmp/crm-pre-1.log 2>&1 \
  || { cat /tmp/crm-pre-1.log >&2; fail "could not apply migrations 0003-0034 to $PRE_DB"; }

# Seeded as crm_app under each tenant's own context, which is the only way the rows can be
# written at all — and is also why the leak is invisible to an uncontexted query, which is
# the whole point of the pre-flight.
A="a0000000-0000-4000-8000-00000000aaaa"
B="b0000000-0000-4000-8000-00000000bbbb"
PGDATABASE="$PRE_DB" psql -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "could not seed the leak"
SET ROLE crm_app;
INSERT INTO crm.tenant (tenant_id, display_name) VALUES ('$A','Tenant A'), ('$B','Tenant B');
BEGIN;
  SELECT set_config('app.current_tenant_id', '$A', true);
  INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
  VALUES ('a0000000-0000-4000-8000-00000000a001','$A','pf-a','pf-a','Rep A');
COMMIT;
BEGIN;
  SELECT set_config('app.current_tenant_id', '$B', true);
  INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
  VALUES ('b0000000-0000-4000-8000-00000000b001','$B','pf-b','pf-b','Rep B'),
         ('b0000000-0000-4000-8000-00000000b002','$B','pf-b2','pf-b2','Rep B2');
  -- THE LEAK: granted_by is tenant A's profile, in a tenant B row. A single-column
  -- reference at this point in the chain, so Postgres accepts it.
  INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by)
  VALUES ('$B','b0000000-0000-4000-8000-00000000b001','administrator',
          'a0000000-0000-4000-8000-00000000a001');
COMMIT;
SQL

# Both directions, because they are the pre-flight's whole premise. From inside tenant B
# the row is there; with no tenant context it is not — which is exactly why a bulk VALIDATE
# cannot see it and why the DO block has to iterate tenants to find it.
present="$(PGDATABASE="$PRE_DB" psql -At -c "SET ROLE crm_app;
  SELECT set_config('app.current_tenant_id','$B',false);
  SELECT count(*) FROM crm.rep_role r WHERE r.granted_by = 'a0000000-0000-4000-8000-00000000a001'" | tail -1)"
[ "$present" = "1" ] || fail "the leak row was not seeded (tenant B sees $present)"
leaked="$(PGDATABASE="$PRE_DB" psql -At -c "SET ROLE crm_app;
  SELECT count(*) FROM crm.rep_role r WHERE r.granted_by = 'a0000000-0000-4000-8000-00000000a001'" | tail -1)"
[ "$leaked" = "0" ] || fail "the leak row should be invisible with no tenant context, saw $leaked"
echo "ok: the leak exists inside tenant B and is invisible without a tenant context"

set +e
MIGRATIONS_DIR="$PRE_DIR" PGDATABASE="$PRE_DB" node packages/db/dist/bin/migrate.js >/dev/null 2>&1
MIGRATIONS_DIR="$MIGRATIONS_DIR" PGDATABASE="$PRE_DB" node packages/db/dist/bin/migrate.js >/tmp/crm-pre-2.log 2>&1
pre_code=$?
set -e
[ "$pre_code" != "0" ] || { cat /tmp/crm-pre-2.log >&2; fail "0035 ACCEPTED a database with a cross-tenant reference"; }
grep -q "rep_role" /tmp/crm-pre-2.log || { cat /tmp/crm-pre-2.log >&2; fail "the refusal does not name the offending table"; }
grep -qi "granted_by" /tmp/crm-pre-2.log || { cat /tmp/crm-pre-2.log >&2; fail "the refusal does not name the offending column"; }
grep -q "$B" /tmp/crm-pre-2.log || { cat /tmp/crm-pre-2.log >&2; fail "the refusal does not name the offending tenant"; }
echo "ok: refused, naming the table, the column and the tenant (exit $pre_code)"

# And the negative control: the same database WITHOUT the leak migrates all the way. A
# pre-flight that refused everything would satisfy every assertion above.
# `crm.rep_role` is append-only — a grant is revoked, never deleted (0023) — so removing
# the row needs the guard lifted, exactly as `api.contract.test.ts`'s fixture does. Worth
# noting rather than hiding: the append-only rule is why a leaked grant could not simply be
# cleaned up in place, and why 0035 refuses rather than repairing.
PGDATABASE="$PRE_DB" psql -v ON_ERROR_STOP=1 -q -o /dev/null -c "SET ROLE crm_app;
  BEGIN;
    SELECT set_config('app.current_tenant_id', '$B', true);
    ALTER TABLE crm.rep_role DISABLE TRIGGER USER;
    DELETE FROM crm.rep_role WHERE granted_by = 'a0000000-0000-4000-8000-00000000a001';
    ALTER TABLE crm.rep_role ENABLE TRIGGER USER;
  COMMIT;" || fail "could not remove the leak row"
MIGRATIONS_DIR="$MIGRATIONS_DIR" PGDATABASE="$PRE_DB" node packages/db/dist/bin/migrate.js >/tmp/crm-pre-3.log 2>&1 \
  || { cat /tmp/crm-pre-3.log >&2; fail "the same database refused even after the leak was removed"; }
echo "ok: and the same database migrates once the leak is gone"

echo
echo "migration runner verified against $PGDATABASE"
