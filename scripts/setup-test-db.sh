#!/usr/bin/env bash
# Brings a database to the state the contract tests expect: a stand-in for the
# ERP's meta schema, then the CRM's own migrations in order.
#
# Applies migrations with psql directly rather than through the migration runner,
# so the contract tests get the schema without a build step. The runner itself is
# checked by scripts/verify-migration-runner.sh — a database set up by this script
# has an EMPTY crm._migrations ledger, which is why the two cannot share one path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The ERP must exist first: migration 0001 grants SELECT on one of its tables and
# checks for it explicitly. Shared with the migration-runner check.
"$ROOT/scripts/erp-fixture.sh"

# 0001 and 0002 are DBA steps: cluster roles and CREATE EXTENSION.
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/db/migrations/0001_roles_and_grants.sql"
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/db/migrations/0002_crm_schema.sql"

# Everything after runs as the application role, as it does in production.
# Iterate every migration in order and skip the two DBA files by name rather than
# globbing a numeric range — a glob like 00[3-9]* silently misses 0003 and leaves
# the schema empty, which is how this script shipped broken the first time.
# Files a later migration retires with `-- @supersedes:` are not executed here either, so a
# database this script builds matches one the runner builds. Without this the two diverge:
# 0032 happens to SUCCEED on an empty database (its clamp finds no rows to fail on), so this
# script would run a file the runner records without running.
retired="$(grep -ho '^--[[:space:]]*@supersedes:[[:space:]]*[^[:space:]]*' "$ROOT"/db/migrations/*.sql |
            sed 's/.*@supersedes:[[:space:]]*//' || true)"

applied=0
for f in "$ROOT"/db/migrations/*.sql; do
  base="$(basename "$f")"
  case "$base" in
    0001_*|0002_*) continue ;;
  esac
  if [ -n "$retired" ] && printf '%s\n' "$retired" | grep -qxF "$base"; then
    echo "skipping $base — retired by a later migration"
    continue
  fi
  psql -v ON_ERROR_STOP=1 -q -c "SET ROLE crm_app" -f "$f"
  applied=$((applied + 1))
done

if [ "$applied" -eq 0 ]; then
  echo "no application migrations were applied — check db/migrations/" >&2
  exit 1
fi
echo "applied $applied application migration(s)"

echo "test database ready"
