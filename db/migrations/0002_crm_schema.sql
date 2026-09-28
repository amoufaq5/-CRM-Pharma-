-- 0002_crm_schema.sql
--
-- The CRM's own schema. Runs as crm_app.
--
-- Every tenant-scoped table gets RLS with the ERP's exact policy text, so one
-- mental model covers both systems, PLUS `FORCE ROW LEVEL SECURITY`, which the
-- ERP does not use. FORCE is load-bearing here and nowhere else: crm_app OWNS
-- these tables, and an owner bypasses a policy it is not forced under. Without
-- it the policy would be decoration on our own tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- PostGIS is approved (ADR-0001 Q7) but deliberately NOT required here. It
-- arrives with the migration that first creates a geometry column (territories,
-- check-in, routing). Requiring an extension before anything uses it makes every
-- environment that lacks it fail at migration 0002 instead of at the feature
-- that needs it, which is a worse failure and a harder one to read.

CREATE TABLE IF NOT EXISTS crm._migrations (
  filename    text PRIMARY KEY,
  sha256      char(64) NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- This file is the DBA step (it needs CREATE EXTENSION), so everything it
-- creates is owned by the DBA role unless reassigned. The migration runner runs
-- as crm_app and writes this ledger on every migration, so without this it fails
-- with `permission denied for table _migrations` on the very next file.
-- Found by running the migrations, not by reading them.
ALTER TABLE crm._migrations OWNER TO crm_app;

-- Deliberately NOT tenant-scoped and therefore NOT under RLS: the migration
-- ledger describes the schema, which is shared by every tenant. There is no
-- tenant_id to isolate on, and inventing one would imply per-tenant DDL, which
-- this design does not do.

-- An ERP record id as the CRM stores it. TEXT, not UUID, and not a foreign key:
-- the ERP runs --store pg, so every record lives in one JSONB table and there is
-- no per-entity table to reference (ADR-0001 item 3 / report R17, R18). The CHECK
-- mirrors the ERP's own RECORD_ID_RE so a malformed id cannot be stored at all.
DO $$ BEGIN
  CREATE DOMAIN crm.erp_record_id AS text
    CONSTRAINT erp_record_id_shape CHECK (VALUE ~ '^[A-Za-z0-9_-]{1,200}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Applied to every tenant-scoped CRM table. Kept as a function so the policy text
-- cannot drift table to table.
CREATE OR REPLACE FUNCTION crm.apply_tenant_isolation(tbl regclass)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  policy_name text := replace(tbl::text, 'crm.', '') || '_tenant_isolation';
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', policy_name, tbl);
  -- NULLIF is a DELIBERATE divergence from the ERP's policy text, and the only
  -- one. The ERP writes:
  --     tenant_id = current_setting('app.current_tenant_id', true)::UUID
  -- which behaves two different ways depending on connection history:
  --   * fresh connection, never set -> current_setting returns NULL -> the
  --     predicate is NULL -> no rows. Clean fail-closed.
  --   * pooled connection reused after ANY tenant-scoped transaction -> the GUC
  --     now exists and reverts to its reset value, the EMPTY STRING, so
  --     ''::UUID raises `invalid input syntax for type uuid: ""`.
  -- Both are safe (neither leaks), but the second is an error rather than an
  -- empty result — and in a connection-pooled server it is the NORMAL case after
  -- the first request. Verified live; see rls.contract.test.ts.
  -- NULLIF collapses both to "no rows", so a forgotten withTenantContext fails
  -- the same way every time instead of depending on what the connection did last.
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::UUID)',
    policy_name, tbl);
END
$$;
