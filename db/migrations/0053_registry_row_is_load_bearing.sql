-- A DELETE undid the whole deletion chain. It does not any more.
--
-- THE DEFECT, found by reading 0050 to 0052 back together rather than by a failing test.
-- 0050 made `crm.tenant.status = 'erp_deleted'` terminal with a trigger, and the trigger is
-- `BEFORE UPDATE`. So:
--
--     DELETE FROM crm.tenant WHERE tenant_id = '…';
--
-- succeeded, as `crm_app`, and did three things at once. Measured, all three, before this was
-- written:
--
--   1. THE TENANT IS SERVED AGAIN. `resolvePrincipal` LEFT-joins the registry and treats a
--      missing row as "serve normally" — a fail-OPEN default argued at length in 0050 and
--      pinned by a test, because the registry is the scheduler's work list and is empty in
--      every test database. That argument is sound and it is exactly what makes the DELETE a
--      bypass rather than a nuisance: removing the row does not stop the tenant, it UN-stops it.
--   2. THE RECEIPT IS ORPHANED. 0052's tombstone trigger checks the registry row at INSERT
--      time and nothing after, and nothing references `crm.tenant` — the catalog had zero
--      constraints pointing at it. So the receipt survives with no row behind it, and the
--      chain 0052 claims ("a CRM tombstone implies a stopped tenant implies an ERP tombstone")
--      becomes false retroactively, with the proof still verifying.
--   3. AND `TRUNCATE crm.tenant` DOES IT TO EVERY TENANT AT ONCE, as `crm_app`, because a
--      statement-level truncation does not fire row triggers at all.
--
-- One statement, and the stop that 0050, 0051 and 0052 are built on is gone. The fix is in
-- three layers because the three holes are genuinely different, and any one of them left open
-- re-opens the bypass on its own.

-- ---------------------------------------------------------------------------
-- 1. A stopped tenant's row cannot be deleted either.
-- ---------------------------------------------------------------------------
-- The function is 0050's, PATCHED — extracted from the live catalog and extended, not retyped
-- from the migration that wrote it. That discipline exists because 0041 once reproduced a
-- function from the file that created it and silently reverted 0038's guard, caught only by
-- 0038's own test. Everything below the `TG_OP` branch is byte-identical to what 0050 left.
CREATE OR REPLACE FUNCTION crm.tenant_erp_deleted_is_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- NEW is NULL on a DELETE, so this arm comes first and returns before anything reads it.
  -- `erp_deleted` means the ERP dropped this tenant's schema and signed for it; the registry
  -- row is the CRM's record of that, and 0051 gives it the disposition `retain` under
  -- `deletion_evidence` for exactly this reason. Deleting it does not tidy anything up — it
  -- destroys the evidence AND silently re-opens the API to a tenant whose controller
  -- relationship has ended.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'erp_deleted' THEN
      RAISE EXCEPTION
        'tenant-erp-deleted-terminal: tenant % is erp_deleted and its registry row cannot be deleted — the row IS the record that the ERP deleted this tenant (under tombstone %), and removing it would both destroy that evidence and make the API serve the tenant again, because an unlisted tenant is deliberately served. Reinstating a tenant is a migration, not a delete.',
        OLD.tenant_id, COALESCE(OLD.erp_tombstone_id, 'none')
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'erp_deleted' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'tenant-erp-deleted-terminal: tenant % is erp_deleted and cannot become % — the ERP dropped this tenant''s schema and signed a tombstone for it (%), which no observation here can undo. Reinstating a tenant is a migration, not an update.',
      OLD.tenant_id, NEW.status, OLD.erp_tombstone_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.erp_tombstone_id               IS DISTINCT FROM OLD.erp_tombstone_id
  OR NEW.erp_tombstone_kind             IS DISTINCT FROM OLD.erp_tombstone_kind
  OR NEW.erp_tombstone_deleted_at       IS DISTINCT FROM OLD.erp_tombstone_deleted_at
  OR NEW.erp_tombstone_proof_sha256     IS DISTINCT FROM OLD.erp_tombstone_proof_sha256
  OR NEW.erp_tombstone_chain_entry_hash IS DISTINCT FROM OLD.erp_tombstone_chain_entry_hash
  OR NEW.erp_tombstone_observed_at      IS DISTINCT FROM OLD.erp_tombstone_observed_at THEN
    RAISE EXCEPTION
      'tenant-erp-deleted-terminal: tenant % is erp_deleted, so its tombstone receipt is fixed at % — rewriting the evidence would leave the status attesting to a deletion nobody can check.',
      OLD.tenant_id, OLD.erp_tombstone_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- `CREATE OR REPLACE TRIGGER` rather than drop-then-create, for 0040's reason: the test
-- database is applied through psql without `-1`, so a drop that commits on its own leaves an
-- instant with no guard inside the file whose purpose is that there always is one.
CREATE OR REPLACE TRIGGER tenant_erp_deleted_is_terminal
  BEFORE UPDATE OR DELETE ON crm.tenant
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_erp_deleted_is_terminal();

-- ---------------------------------------------------------------------------
-- 2. And TRUNCATE, which row triggers never see.
-- ---------------------------------------------------------------------------
/**
 * `TRUNCATE crm.tenant` is refused outright.
 *
 * A row-level trigger cannot see a truncation: Postgres removes the rows wholesale and fires
 * only statement-level `TRUNCATE` triggers. So layer 1 above would have left the single
 * most destructive version of the same bypass wide open — one statement that un-stops every
 * deleted tenant in the deployment and orphans every receipt.
 *
 * Refused unconditionally rather than only when a stopped tenant exists. A truncation of the
 * registry is never a thing anybody means to do: it is the scheduler's work list, so it
 * silently stops all background work for every tenant, and that is true whether or not any of
 * them were deleted. A `DELETE` naming rows is the statement for removing a tenant that was
 * never stopped, and layer 1 lets that through.
 */
CREATE OR REPLACE FUNCTION crm.tenant_no_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'tenant-registry-no-truncate: crm.tenant cannot be truncated. It is the registry the scheduler enumerates and the record of which tenants the ERP has deleted, and a TRUNCATE fires no row trigger — so it would un-stop every deleted tenant at once and orphan every erasure receipt. DELETE the rows you mean, which is refused for a stopped tenant.'
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER tenant_no_truncate
  BEFORE TRUNCATE ON crm.tenant
  FOR EACH STATEMENT EXECUTE FUNCTION crm.tenant_no_truncate();

-- ---------------------------------------------------------------------------
-- 3. The receipt pins the row structurally, not by trigger.
-- ---------------------------------------------------------------------------
-- The first reference into `crm.tenant` in this schema's history. ADR-0001 carried the
-- observation that nothing references the registry — which is why nothing can enumerate it,
-- and why a row could vanish from under a receipt that depends on it.
--
-- SINGLE-COLUMN, which is the one place 0035's composite rule does not apply and cannot: the
-- target is the tenant registry itself, keyed on `tenant_id` alone, so there is no second
-- column to carry. "A reference cannot escape its tenant" is vacuous here — the tenant IS the
-- row. `composite-fk.contract.test.ts` enumerates every reference in `crm` and demands
-- composite; this one is declared there as the deliberate exception with that argument.
--
-- ON DELETE RESTRICT, not CASCADE, and the difference is the whole point: CASCADE would make
-- the delete succeed and take the receipts with it, which is the bypass with extra steps.
-- RESTRICT also blocks a TRUNCATE of `crm.tenant` whenever any receipt exists, which makes
-- layer 2 belt to its braces rather than the only thing standing there.
--
-- WHY A TRIGGER AS WELL. The two cover different rows. This key only pins a tenant that has
-- been ERASED; layer 1 pins one that has been STOPPED, which is every deleted tenant from the
-- moment the watcher sees the tombstone until somebody runs the erasure — a window that is
-- open for as long as the nineteen undecided dispositions stay undecided, which is to say
-- indefinitely. The trigger is the one doing the work today.
ALTER TABLE crm.tenant_tombstone
  ADD CONSTRAINT tenant_tombstone_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES crm.tenant (tenant_id) ON DELETE RESTRICT;

-- The observation log is NOT given one, deliberately. `crm.tenant_deletion_check` records how
-- we came to believe a tenant was deleted, and 0051 retains it as `deletion_evidence` — but it
-- also holds `live` and `unknown` rows for tenants that were never deleted and may legitimately
-- be removed from the registry one day. A key here would refuse that, and the row it would
-- protect is already protected: a tenant with a `deleted` observation is `erp_deleted`, which
-- layer 1 refuses to delete.
