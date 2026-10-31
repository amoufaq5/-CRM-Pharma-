-- Every tenant-scoped row now references the tenant registry.
--
-- ADR-0001 has carried this row since 0035: "A row whose `tenant_id` is absent from
-- `crm.tenant` is invisible to 0035's pre-flight, because nothing can enumerate it: no table
-- references the registry. Such a row is a defect in its own right... Giving every
-- tenant-scoped table an FK to `crm.tenant` would close it and is a much larger change."
--
-- This is that change, and it is 45 foreign keys. 0053 added the first one
-- (`crm.tenant_tombstone.tenant_id`) because a vanishing registry row was already doing damage
-- there; the other 45 tenant-scoped tables had nothing.
--
-- WHAT THE GAP ACTUALLY COST, stated before the fix so the fix can be judged. A row for a
-- tenant the registry has never heard of is:
--
--   * UNSCANNED by 0035/0037's cross-tenant pre-flight, which loops over `crm.tenant`;
--   * UNSERVED by every per-tenant job, because the scheduler walks the registry -- its writes
--     are never relayed, its expiries never swept, its deletions never noticed (0073 measured
--     exactly this and could only report it);
--   * AND UNERASABLE, which is the one that matters most now: `planTenantErasure` reads
--     `crm.tenant` for the status and the ERP tombstone, so a tenant with no row can never be
--     `erp_deleted` and its data can never be lawfully destroyed.
--
-- 0073 made the tenant set derivable from the data and had to refuse rather than answer, because
-- enumeration across tenants is a privileged act. This makes the question unnecessary: the set
-- OF TENANTS WITH DATA and the set of REGISTERED TENANTS are now the same set by construction,
-- and the only way to write a row for an unregistered tenant is to register it first.
--
-- SINGLE-COLUMN, AND THAT IS THE ONE SAFE SINGLE-COLUMN SHAPE. 0035's whole subject is that a
-- reference naming a ROW by id alone can name another tenant's row, because a referential check
-- runs with row security disabled. Here the referenced value IS the tenant: there is no second
-- column to carry and nothing to escape. `composite-fk.contract.test.ts` filters its drift guard
-- on `parent_cols = 'id'` for exactly this reason, and asserts this shape separately.
--
-- ON DELETE RESTRICT, which is 0053's argument amplified. CASCADE would make
-- `DELETE FROM crm.tenant` destroy every tenant-scoped row in the schema with no attestation,
-- no receipt and no four-eyes -- the uncontrolled deletion that 0051, 0052 and 0054 exist to
-- make impossible, reachable by one statement. RESTRICT means a registry row cannot be removed
-- while anything references it, so removing a tenant means erasing it first, through the path
-- that signs a receipt.
--
-- ===========================================================================
-- THE VALIDATION TRAP, which this migration would otherwise walk into
-- ===========================================================================
--
-- `ADD CONSTRAINT ... FOREIGN KEY` validates existing rows, and 0027 established what that
-- costs here: a foreign key's bulk validation scan IS confined by row security, and this
-- migration runs as `crm_app`, which OWNS these tables and is FORCEd under their policies. With
-- no tenant context the scan therefore sees NOTHING and the constraint is accepted on a vacuous
-- pass -- so on a deployment that really holds orphan rows, every one of these 45 constraints
-- would be created, trusted, and wrong.
--
-- That is not hypothetical here, it is the exact defect being closed: the rows this constraint
-- must find are, by definition, rows nobody can enumerate.
--
-- So FORCE is lifted per table for the check and restored immediately, which is 0027's pattern
-- and the only sanctioned use of it. Lifting FORCE does not lift RLS: `crm_app` is the OWNER, so
-- while FORCE is off it sees every row -- which is the whole point, and is why the window is one
-- table wide and inside the migration's own transaction.
--
-- ===========================================================================
-- AND THE ORPHANS ARE BACKFILLED, not refused, which is the decision in this migration
-- ===========================================================================
--
-- The first draft refused: counted the rows whose `tenant_id` is not in `crm.tenant`, named the
-- table and an example, and told a human to decide. It found twelve on the first database it ran
-- against, which is the strongest possible argument that the row ADR-0001 carried was real -- and
-- also the argument against refusing. `packages/api/src/principal.ts` has carried the reason in
-- its own words since 0050: refusing unregistered tenants "would be a different and much larger
-- change -- a real one, and arguably right -- but making it a side effect of adding a deletion
-- signal would lock out every such deployment on upgrade". A migration that cannot be applied
-- leaves the hole open on exactly the deployments that have it.
--
-- So the registry is BACKFILLED FROM THE DATA, which is 0073's measurement turned into a repair:
-- the rows prove the tenant exists, and 0073 could only say so because enumeration across
-- tenants is privileged. Here FORCE is already lifted, so the enumeration is possible.
--
-- THE ONE INFERENCE, named rather than buried: `status`. Existence is derived -- the rows are
-- there -- but the status is not in the data, and `active` is the only value that is not a
-- regression. Every consumer of this registry filters `status = 'active'` (the scheduler's
-- `activeTenants`, the channel-coverage check, the deletion watcher), so backfilling `paused` or
-- `disabled` would register the tenant and leave its work undone, which is the state being
-- fixed. `erp_deleted` is refused by a CHECK without a tombstone in hand, correctly. And a
-- tenant whose data is being served by the API IS active by every operational definition this
-- CRM has.
--
-- The provenance goes in `display_name`, because an operator seeing a new row in the scheduler's
-- list must be able to tell where it came from, and a NOTICE per tenant says it at migration
-- time as well -- the scheduler will start relaying these tenants' outboxes and sweeping their
-- expiries, which is the fix and is also a change in behaviour somebody should hear about.

DO $$
DECLARE
  t           record;
  orphans     bigint;
  example     text;
  added       int := 0;
  backfilled  int := 0;
  forced      boolean;
BEGIN
  FOR t IN
    SELECT c.relname, c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crm'
       AND c.relkind = 'r'
       -- The registry does not reference itself. It carries `tenant_id` as its PRIMARY KEY,
       -- which is why every catalog query in this schema that looks for "tables with a
       -- tenant_id" has to exclude it by name -- a fact that has already caused one wrong
       -- probe in this repository, where `crm.tenant` was mistaken for a tenant-scoped table
       -- because it has the column.
       AND c.relname <> 'tenant'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                      AND a.attnum > 0 AND NOT a.attisdropped)
       -- Idempotent by the catalog rather than by a list: 0053's table already has one, and a
       -- re-run of this migration on a database that has it must be a no-op per table.
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint con
          WHERE con.conrelid = c.oid AND con.contype = 'f'
            AND con.confrelid = 'crm.tenant'::regclass)
     ORDER BY c.relname
  LOOP
    SELECT c.relforcerowsecurity INTO forced FROM pg_class c WHERE c.oid = t.oid;
    IF forced THEN
      EXECUTE format('ALTER TABLE crm.%I NO FORCE ROW LEVEL SECURITY', t.relname);
    END IF;

    BEGIN
      EXECUTE format(
        'SELECT count(*), min(x.tenant_id::text) FROM crm.%I x
          WHERE NOT EXISTS (SELECT 1 FROM crm.tenant g WHERE g.tenant_id = x.tenant_id)',
        t.relname)
        INTO orphans, example;

      IF orphans > 0 THEN
        -- Backfilled rather than refused: see the header. ON CONFLICT because two tables can
        -- hold rows for the same unregistered tenant, and the second must be a no-op rather
        -- than a failure that reads like a different problem.
        EXECUTE format(
          'INSERT INTO crm.tenant (tenant_id, display_name, status, created_at, updated_at)
             SELECT DISTINCT x.tenant_id,
                    ''unregistered tenant, backfilled by migration 0075'', ''active'', now(), now()
               FROM crm.%I x
              WHERE NOT EXISTS (SELECT 1 FROM crm.tenant g WHERE g.tenant_id = x.tenant_id)
             ON CONFLICT (tenant_id) DO NOTHING',
          t.relname);
        RAISE NOTICE
          'backfilled the registry from crm.%: % row(s) named a tenant it had never heard of (for example %)',
          t.relname, orphans, example;
        backfilled := backfilled + 1;
      END IF;

      EXECUTE format(
        'ALTER TABLE crm.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id)
           REFERENCES crm.tenant (tenant_id) ON DELETE RESTRICT',
        t.relname, t.relname || '_tenant_id_fkey');
      added := added + 1;
    EXCEPTION WHEN OTHERS THEN
      -- FORCE goes back on before the error leaves this block. The whole DO block is in the
      -- migration's transaction, so a rollback would restore it anyway -- but the migration
      -- runner reports the error and a reader of that error should not have to work out whether
      -- a table was left unforced in the meantime.
      IF forced THEN
        EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', t.relname);
      END IF;
      RAISE;
    END;

    IF forced THEN
      EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', t.relname);
    END IF;
  END LOOP;

  RAISE NOTICE 'tenant registry references: % added, % table(s) needed a backfill first', added, backfilled;
END
$$;

-- ===========================================================================
-- AND THE REGISTRY SAYS IT TOO, for the one case a key cannot cover
-- ===========================================================================
--
-- The keys above close WRITES. They say nothing about a READ for a tenant nobody registered,
-- which today answers an empty set -- and an empty set is fail-closed in the sense that no data
-- leaks, but it is also the sentence 0066, 0067 and 0073 all refuse to let stand: "there is
-- nothing there" where the truth is "nobody ever heard of this tenant". A caller reading zero
-- visits for a tenant that does not exist should be told which of the two it is.
--
-- `withTenantContext` is where that belongs, because its own header already claims to be "the
-- ONLY sanctioned way to reach a crm.* table" and it already fails closed four times over. This
-- function is what it asks, so the question is answered in SQL and the same answer is available
-- to anything else that wants it.
--
-- STABLE, not IMMUTABLE, and SECURITY INVOKER by default: the registry is platform-wide with no
-- policy on it, so a confined caller can read it -- which is the one thing about `crm.tenant`
-- that makes this possible at all.
CREATE OR REPLACE FUNCTION crm.tenant_is_registered(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM crm.tenant WHERE tenant_id = p_tenant)
$$;
