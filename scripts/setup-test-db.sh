#!/usr/bin/env bash
# Brings a database to the state the contract tests expect: a stand-in for the
# ERP's meta schema, then the CRM's own migrations in order.
#
# The ERP fixture is a faithful miniature of the DEPLOYED shape — one shared
# JSONB table under RLS (--store pg), not per-entity typed tables. If CrossEngin
# ever moves to --store pg-columns this file changes and so does ADR-0001.
set -euo pipefail

psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_owner') THEN
    CREATE ROLE erp_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS meta AUTHORIZATION erp_owner;
SET ROLE erp_owner;
CREATE TABLE IF NOT EXISTS meta.operate_entity_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  entity     text NOT NULL,
  record_id  text NOT NULL,
  document   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, record_id)
);
ALTER TABLE meta.operate_entity_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operate_entity_records_tenant_isolation ON meta.operate_entity_records;
CREATE POLICY operate_entity_records_tenant_isolation ON meta.operate_entity_records
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
RESET ROLE;
SQL

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 0001 and 0002 are DBA steps: cluster roles and CREATE EXTENSION.
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/db/migrations/0001_roles_and_grants.sql"
psql -v ON_ERROR_STOP=1 -q -f "$ROOT/db/migrations/0002_crm_schema.sql"

# Everything after runs as the application role, as it does in production.
# Iterate every migration in order and skip the two DBA files by name rather than
# globbing a numeric range — a glob like 00[3-9]* silently misses 0003 and leaves
# the schema empty, which is how this script shipped broken the first time.
applied=0
for f in "$ROOT"/db/migrations/*.sql; do
  case "$(basename "$f")" in
    0001_*|0002_*) continue ;;
  esac
  psql -v ON_ERROR_STOP=1 -q -c "SET ROLE crm_app" -f "$f"
  applied=$((applied + 1))
done

if [ "$applied" -eq 0 ]; then
  echo "no application migrations were applied — check db/migrations/" >&2
  exit 1
fi
echo "applied $applied application migration(s)"

echo "test database ready"
