#!/usr/bin/env bash
# A stand-in for the CrossEngin ERP's meta schema.
#
# Faithful to the DEPLOYED shape — one shared JSONB table under RLS (--store pg),
# not per-entity typed tables. If CrossEngin ever moves to --store pg-columns this
# file changes and so does ADR-0001.
#
# Separate from setup-test-db.sh because two things need it: the contract-test
# database, and the migration-runner check, which must start from a database that
# has the ERP in it and nothing else. Duplicating the SQL is how the two drift.
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

echo "ERP stand-in ready"
