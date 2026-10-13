-- Which tenants exist, derived from the data rather than from a list.
--
-- ADR-0001's row, measured and recorded on 2026-10-07 rather than argued: 0053 stops a stopped
-- tenant's registry row being removed, "which closes the bypass — it does NOT make a tenant with
-- data and no registry row impossible, and such a tenant is still watched by nothing and served by
-- the API". Nothing in `crm.*` references `crm.tenant`, so a rep profile, an outbox row or a
-- notification can name a tenant the registry has never heard of; and every per-tenant job walks
-- the registry, so that tenant's writes are never relayed, its expiries never swept, its deletions
-- never noticed.
--
-- THE PRINCIPLE IS 0051's AND IT IS NOT NEGOTIABLE: a completeness claim derived from a LIST is a
-- claim about the list. `crm.data_disposition` earns its guard by deriving from `pg_catalog`, and
-- `crm.erp_reference_register` (0066) earns its by the same move. The tenant set has to come from
-- the rows.
--
-- AND THE OBSTACLE IS REAL, which is why the row recorded a measurement instead of a fix. These
-- tables are owned by `crm_app`, RLS is ENABLED and FORCED, so the owner is confined like anybody
-- else: `SELECT count(DISTINCT tenant_id) FROM crm.rep_profile` with no tenant context answers
-- 0 where an admin answers 2. Enumeration across tenants is a PRIVILEGED act. A `SECURITY DEFINER`
-- enumerator is doubly blocked — `schema.contract.test.ts` forbids one in `crm` by design, and a
-- function a migration creates is owned by `crm_app`, so FORCE would apply to it anyway.
--
-- SO THE FUNCTION REFUSES RATHER THAN ANSWERING ZERO. That is the whole of this migration's
-- contribution, and it is 0066's `unverifiable` verdict and 0067's `self_test_failed` in a third
-- place: a confined caller gets a named refusal telling it what credentials the question needs,
-- because "I could not look" must never read like "there is nothing there". The privileged run
-- lives in `scripts/verify-tenant-registry.sh`, outside the product, which is where the row said
-- it would have to live.
--
-- WHAT THIS DOES NOT DO: add a foreign key from every tenant-scoped table to `crm.tenant`. That is
-- the other route the row named, it would make an unregistered tenant IMPOSSIBLE rather than
-- merely detectable, and it is a change to forty-odd tables plus every fixture in the suite — each
-- of which currently invents a tenant id and writes rows under it without provisioning anything.
-- It is the right end state and it is not a line in a migration about detection.

-- ---------------------------------------------------------------------------
-- 1. Can this caller see across tenants at all?
-- ---------------------------------------------------------------------------
/**
 * True only for a role RLS does not confine.
 *
 * `rolsuper OR rolbypassrls`, which is exactly what `schema.contract.test.ts` asks of a table's
 * owner when it decides whether FORCE is load-bearing. `crm_app` is `NOSUPERUSER NOBYPASSRLS` by
 * 0001 and a test pins it, so this is false for the application and true for the migration
 * admin — the identity `scripts/` runs as.
 */
CREATE OR REPLACE FUNCTION crm.caller_sees_every_tenant()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false);
$$;

-- ---------------------------------------------------------------------------
-- 2. The tenant set, from the rows.
-- ---------------------------------------------------------------------------
/**
 * Every tenant that has data anywhere in `crm`, with the count of tables it appears in.
 *
 * ONE STATEMENT, for `planTenantErasure`'s reason: the tables are unioned into a single query so
 * the answer is one snapshot rather than forty moments. The table list comes from
 * `crm.data_disposition`, whose trigger refuses a name that is not a real tenant-scoped table in
 * `crm` — so the names interpolated below are safe by construction, as they are in `countRows`,
 * and they are quoted anyway because defence that costs nothing is free.
 *
 * IT REFUSES A CONFINED CALLER BY NAME. Under `crm_app` every one of those tables is FORCE
 * RLS-protected and a query with no tenant context returns nothing, so this function would answer
 * "no tenants have data" — about a database with thousands of rows. 0066 named that class of
 * answer `unverifiable` and 0067 `self_test_failed`; here the refusal is the verdict, because a
 * reconciliation that cannot look must not report clean.
 *
 * RECEIPT STORES ARE INCLUDED (0054 excludes them from an erasure's SCOPE, which is a different
 * question): a tombstone naming a tenant is evidence the tenant existed, and a tenant whose only
 * remaining rows are receipts is exactly the case a registry row must not be missing for.
 *
 * ONE TABLE IS EXCLUDED, AND IT IS `crm.tenant` ITSELF. The register governs it like any other
 * tenant-scoped table, so a first version of this function counted a registry row as data — which
 * makes the whole check CIRCULAR: every registered tenant then "has data" by virtue of being
 * registered, and `crm.registered_tenants_without_data()` could never return a row, ever, on any
 * database. Found by the test written for that function, not by reading this one. What the
 * reconciliation is about is BUSINESS data with no registry row, so the list being checked against
 * cannot be part of the derivation.
 */
CREATE OR REPLACE FUNCTION crm.tenants_with_data()
RETURNS TABLE (tenant_id uuid, tables_with_rows integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  parts text[];
  stmt  text;
BEGIN
  IF NOT crm.caller_sees_every_tenant() THEN
    RAISE EXCEPTION
      'tenant-enumeration-confined: % is subject to row-level security, so this question can only be answered as zero tenants — which is not an answer. Run it as the migration admin (a role with BYPASSRLS or SUPERUSER); scripts/verify-tenant-registry.sh is the supported caller.',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT array_agg(format('SELECT DISTINCT tenant_id, %L::text AS t FROM crm.%I', d.table_name, d.table_name)
                   ORDER BY d.table_name)
    INTO parts
    FROM crm.data_disposition d
   WHERE d.table_name <> 'tenant';

  IF parts IS NULL THEN
    -- The register is empty, which is not "no tenants": it is a database whose 0051 seed never
    -- ran, and answering zero would be the same lie as answering it under RLS.
    RAISE EXCEPTION
      'tenant-enumeration-no-register: crm.data_disposition is empty, so there is no list of tenant-scoped tables to derive the tenant set from'
      USING ERRCODE = 'no_data_found';
  END IF;

  stmt := 'SELECT u.tenant_id, count(DISTINCT u.t)::integer FROM (' ||
          array_to_string(parts, ' UNION ALL ') ||
          ') AS u GROUP BY u.tenant_id ORDER BY u.tenant_id';

  RETURN QUERY EXECUTE stmt;
END
$$;

/**
 * Tenants with data and no registry row — the defect, as a query.
 *
 * Nothing in the product can fix one of these: provisioning a tenant means deciding its
 * `display_name` and its status, and 0050 makes `erp_deleted` terminal, so a reconciliation that
 * INSERTED a registry row would be inventing the one fact the row exists to carry. It reports.
 */
CREATE OR REPLACE FUNCTION crm.unregistered_tenants()
RETURNS TABLE (tenant_id uuid, tables_with_rows integer)
LANGUAGE sql STABLE AS $$
  SELECT d.tenant_id, d.tables_with_rows
    FROM crm.tenants_with_data() d
   WHERE NOT EXISTS (SELECT 1 FROM crm.tenant t WHERE t.tenant_id = d.tenant_id)
   ORDER BY d.tenant_id;
$$;

/**
 * And the other direction, which is NOT a defect and is printed anyway.
 *
 * A registry row with no rows anywhere is a provisioned tenant nobody has used yet, or one whose
 * erasure completed — both legitimate, and both worth seeing beside the count, because a
 * deployment where that number is large is one where provisioning is running ahead of onboarding.
 */
CREATE OR REPLACE FUNCTION crm.registered_tenants_without_data()
RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id, t.status
    FROM crm.tenant t
   WHERE NOT EXISTS (SELECT 1 FROM crm.tenants_with_data() d WHERE d.tenant_id = t.tenant_id)
   ORDER BY t.tenant_id;
$$;

COMMENT ON FUNCTION crm.tenants_with_data() IS
  'Every tenant with rows anywhere in crm, derived from crm.data_disposition rather than from a list (0051''s principle). Refuses a caller RLS confines, because the answer would be a confident zero.';
COMMENT ON FUNCTION crm.unregistered_tenants() IS
  'Tenants with data and no crm.tenant row: watched by no job, served by the API. Reported, never fixed — provisioning decides a display name and a status, and inventing either is what this function exists to prevent.';
