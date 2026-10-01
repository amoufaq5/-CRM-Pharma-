-- 0001_roles_and_grants.sql
-- @requires: dba
--
-- DBA STEP. Run once per cluster as a superuser, NOT by the CRM at runtime.
-- Roles are cluster-wide objects; the CRM's own migrations (0002+) run as
-- crm_app and must never need this file's privileges.
--
-- ADR-0001 decision item 2. The separation below is the isolation guarantee, not
-- a convention: a table's OWNER bypasses row-level security (verified live, see
-- packages/db/src/rls.contract.test.ts), so crm_app owning an ERP object would
-- read every tenant's data regardless of RLS policy.
--
--   erp_owner  owns the ERP's meta schema and its tables (CrossEngin migrations)
--   erp_app    the ERP runtime; non-owner, so RLS confines it
--   crm_app    the CRM runtime; owns crm.*, SELECT-only on the ERP, owns nothing of it

-- PRECONDITION: the ERP must already be migrated into this database.
--
-- ADR-0001 chose a shared database (option b), so the CRM grants itself SELECT
-- on an ERP table — which means the ERP's schema has to exist first. Checked
-- explicitly because the alternative is a deploy failing with
-- `schema "meta" does not exist` thirty lines below, which sends whoever is
-- on call hunting in entirely the wrong place.
--
-- Local development and CI have no real ERP; scripts/setup-test-db.sh builds a
-- faithful stand-in for exactly this reason.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'meta' AND table_name = 'operate_entity_records'
  ) THEN
    RAISE EXCEPTION
      'meta.operate_entity_records was not found. The CrossEngin ERP must be migrated into this database BEFORE the CRM: the CRM reads ERP master data over SQL and grants itself SELECT on that table. Run the ERP''s `crossengin apply` first, or scripts/setup-test-db.sh for a local stand-in.'
      USING ERRCODE = 'undefined_table';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN;
  END IF;
END
$$;

-- crm_app must never be able to escalate past RLS.
ALTER ROLE crm_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

CREATE SCHEMA IF NOT EXISTS crm AUTHORIZATION crm_app;

-- Read-only reach into the ERP. Deliberately narrow: USAGE on the schema and
-- SELECT on the single table the JSONB store keeps records in. No INSERT, no
-- UPDATE, no DELETE, no ownership, and no default privileges on future objects —
-- a new ERP table is invisible to the CRM until someone grants it explicitly and
-- adds it to the allow-list fixture (ADR-0001 Q5).
GRANT USAGE ON SCHEMA meta TO crm_app;
GRANT SELECT ON meta.operate_entity_records TO crm_app;

-- The CRM writes to the ERP over its HTTP API, never over SQL (ADR-0001 item 5),
-- so no write grant is issued here and none should be added.
