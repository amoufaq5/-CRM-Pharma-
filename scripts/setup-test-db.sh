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
# MUST MATCH `supersededFiles` IN packages/db/src/migrate.ts, and three ways it did not.
# The Node side is /^--\s*@supersedes:\s*(\S+)\s*$/gm over the APPLICATION files only, and
# it refuses a name that resolves to nothing or does not sort before the declaring file.
# This grep had no end-of-line anchor, so a prose line that merely QUOTES the syntax —
# which these headers do to each other constantly — silently retired a live migration here
# and not in production; it scanned the two DBA files the Node side excludes; and it
# validated nothing, so a declaration the deploy REFUSES could still leave `pnpm test`
# green against a database the deploy will not build. `grep -x` anchors both ends.
retired="$(for f in "$ROOT"/db/migrations/*.sql; do
             case "$(basename "$f")" in 0001_*|0002_*) continue ;; esac
             grep -hxoE -- '--[[:space:]]*@supersedes:[[:space:]]*[^[:space:]]+' "$f" || true
           done | sed 's/.*@supersedes:[[:space:]]*//')"
for name in $retired; do
  [ -f "$ROOT/db/migrations/$name" ] \
    || { echo "@supersedes names $name, which is not a migration" >&2; exit 1; }
done

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

# ---------------------------------------------------------------------------
# PROVE the application connection works, as the suite will open it.
#
# `CREATE ROLE crm_app LOGIN` in 0001 sets no password, which is invisible over a
# unix socket (peer or trust auth ignores it) and fatal over TCP against the
# official postgres image, whose pg_hba is `host all all all scram-sha-256`. CI
# connects over TCP. So for however long `appPool()` has existed, CI has answered
# `password authentication failed for user "crm_app" — User "crm_app" has no
# password assigned` to every suite that needs the application identity: 32 of 82
# test files failed and 1,073 tests never ran, while the same tree is 82/82 green
# over a socket. Found by reading a CI log, not by a failing local run.
#
# Two halves to the fix and this is the second, because the first is a password
# somebody can forget: the suite's own connection is OPENED HERE, with exactly
# what `appPool()` would use, and a failure stops the setup with the reason. A test
# database the suite cannot authenticate to is worse than no database — it does not
# fail, it SKIPS, and a skipped contract test is indistinguishable from a passing
# one in a summary line.
if [ -n "${PGAPPPASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 -q -c "ALTER ROLE ${PGAPPUSER:-crm_app} PASSWORD '${PGAPPPASSWORD}'"
  echo "set a password on ${PGAPPUSER:-crm_app} from PGAPPPASSWORD"
fi

app_user="${PGAPPUSER:-crm_app}"
probe="$(mktemp)"; probe_err="$(mktemp)"
trap 'rm -f "$probe" "$probe_err"' EXIT
if ! PGUSER="$app_user" PGPASSWORD="${PGAPPPASSWORD:-}" \
     psql -w -v ON_ERROR_STOP=1 -qtAc "SELECT current_user" > "$probe" 2>"$probe_err"; then
  echo "the application identity cannot connect to this database, so the contract suites would SKIP:" >&2
  sed 's/^/  /' "$probe_err" >&2
  case "${PGHOST:-/var/run/postgresql}" in
    /*) echo "  over a unix socket this is usually pg_hba or a missing LOGIN, not the password." >&2 ;;
    *)  echo "  over TCP the official postgres image requires scram-sha-256: export PGAPPPASSWORD" >&2
        echo "  before running this script (and give the same value to the test run)." >&2 ;;
  esac
  exit 1
fi
[ "$(cat "$probe")" = "$app_user" ] \
  || { echo "connected as $(cat "$probe"), expected $app_user" >&2; exit 1; }
echo "$app_user can connect — the identity the contract suites use"

echo "test database ready"
