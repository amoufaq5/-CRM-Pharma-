#!/usr/bin/env bash
# Is every tenant with data in this database actually REGISTERED?
#
# WHY THIS IS A SCRIPT AND NOT A ROUTE OR A JOB. Nothing in `crm.*` references `crm.tenant`, so a
# rep profile, an outbox row or a notification can name a tenant the registry has never heard of —
# and every per-tenant job walks the registry, so that tenant's writes are never relayed, its
# expiries never swept, its deletions never noticed, while the API serves it perfectly happily
# (serving an unlisted tenant is deliberate: see ADR-0001 on `crm.tenant`).
#
# Detecting it means asking "which tenants appear in the data", which is a question the application
# role CANNOT ask. These tables are owned by `crm_app`, RLS is ENABLED and FORCED, so the owner is
# confined like anybody else and a cross-tenant count with no context answers zero. Enumeration is
# a privileged act, `SECURITY DEFINER` is refused in `crm` by contract and would be owned by
# `crm_app` anyway, so the only honest place for this is here: run with the MIGRATION ADMIN's
# credentials, outside the product, exactly as ADR-0001's row said it would have to be.
#
# `crm.tenants_with_data()` refuses a confined caller by name rather than answering zero, so this
# script cannot accidentally report a clean database because it was pointed at the wrong role —
# which is 0066's `unverifiable` rule and 0067's `self_test_failed`, in a third place.
#
# WHAT IT DOES NOT DO: fix anything. Provisioning a tenant means deciding a display name and a
# status, and 0050 makes `erp_deleted` terminal — so a reconciliation that inserted a registry row
# would be inventing the one fact the row exists to carry. It reports and exits 1.
#
# Usage: PGHOST=… PGUSER=<admin> PGDATABASE=… scripts/verify-tenant-registry.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

# NO APOSTROPHE IN THIS MESSAGE. The word in ${var:?word} is expanded, so a single quote there
# starts a quoted string and bash fails to parse the whole file — which it did, with
# "unexpected EOF while looking for matching `''" pointing at the last line of the script.
: "${PGDATABASE:?PGDATABASE must be set: this reads the database of one deployment}"
q() { psql -v ON_ERROR_STOP=1 -At -c "$1"; }

# THE GUARD ON THE GUARD, before anything is counted: if the role cannot see across tenants the
# function below refuses, and a refusal here must read as a refusal rather than as a clean run.
if [ "$(q "SELECT crm.caller_sees_every_tenant()")" != "t" ]; then
  fail "$(q 'SELECT current_user') cannot see across tenants (row-level security confines it), so every count here would be zero. Run this as the migration admin."
fi
ok "connected as $(q 'SELECT current_user'), which row-level security does not confine"

WITH_DATA="$(q "SELECT count(*) FROM crm.tenants_with_data()")"
REGISTERED="$(q "SELECT count(*) FROM crm.tenant")"
ok "$WITH_DATA tenant(s) have rows in crm; the registry lists $REGISTERED"

# THE CONTROL, which is what stops a clean verdict meaning "the query found nothing": plant a row
# for a tenant the registry does not list, confirm the check SEES it, and roll it back. Without
# this, a reconciliation whose derivation had silently broken would print "every tenant is
# registered" on every deployment forever — the vacuous green 0066's live gate was corrected for.
# `crm.notification_policy` is the probe's table because it is in the register and needs nothing
# but a tenant id — every other candidate would have the control inventing a rep, a lot or a
# receipt. ROLLBACK, always: this script is read-only to the deployment it is checking.
PROBE="$(psql -v ON_ERROR_STOP=1 -At <<'SQL'
BEGIN;
INSERT INTO crm.notification_policy (tenant_id) VALUES ('00000000-0000-4000-8000-0000000073de');
SELECT 'probe=' || count(*) FROM crm.unregistered_tenants()
 WHERE tenant_id = '00000000-0000-4000-8000-0000000073de';
ROLLBACK;
SQL
)"
case "$PROBE" in
  *probe=1*) ok "and the check detects a planted unregistered tenant, so a clean verdict means something" ;;
  *)   fail "the check did NOT see a tenant with data and no registry row: $PROBE" ;;
esac

UNREGISTERED="$(psql -v ON_ERROR_STOP=1 -At -F'|' -c \
  "SELECT tenant_id || ' (rows in ' || tables_with_rows || ' table(s))' FROM crm.unregistered_tenants()")"
IDLE="$(psql -v ON_ERROR_STOP=1 -At -F'|' -c \
  "SELECT tenant_id || ' (' || status || ')' FROM crm.registered_tenants_without_data()")"

if [ -n "$IDLE" ]; then
  echo "    note: registry rows with no data anywhere — provisioned and unused, or erased:" >&2
  printf '%s\n' "$IDLE" | sed 's/^/      /' >&2
fi

if [ -n "$UNREGISTERED" ]; then
  echo "    tenants with data and NO registry row:" >&2
  printf '%s\n' "$UNREGISTERED" | sed 's/^/      /' >&2
  echo "    each one is served by the API and watched by NOTHING: no relay, no expiry sweep, no" >&2
  echo "    deletion watch. Provision a crm.tenant row for each (display name and status are" >&2
  echo "    decisions, which is why this script will not write one), or erase the data." >&2
  fail "$(printf '%s\n' "$UNREGISTERED" | wc -l | tr -d ' ') tenant(s) have data and no registry row"
fi

ok "every tenant with data in $PGDATABASE is registered"
