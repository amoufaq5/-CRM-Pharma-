-- 0035_composite_fks.sql
--
-- Every reference inside crm.* becomes tenant-scoped, so a cross-tenant reference is a
-- constraint violation rather than a convention somebody has to remember.
--
-- WHAT WAS BROKEN. ADR-0001 carried this as an open item against itself: "a role grant's
-- `granted_by` / `revoked_by` are plain FKs to `crm.rep_profile (id)`, as every
-- rep-profile reference in this schema is. Nothing but RLS and the explicit tenant match
-- stops one naming a profile in another tenant." That turned out to understate it twice
-- over.
--
-- First, it is not hypothetical. `crm.revoke_rep_role` scoped its UPDATE on the grant id
-- alone, and a rep of one tenant ended a grant in another. It shipped; it was found in
-- live verification; it was fixed by adding `AND tenant_id = p_tenant_id` to one
-- function. Which is the problem: a fix in one function is a fix the next function
-- forgets, and the whole suite was green while the bug was live because the suite
-- connected as a superuser.
--
-- Second, RLS was never standing between the row and the other tenant in the first
-- place. **Referential integrity checks bypass row-level security** — Postgres documents
-- this and it is what makes an FK usable at all, since a parent you cannot see would
-- otherwise read as a parent that does not exist. So when a tenant-B statement names a
-- tenant-A profile, the FK happily finds it. The row commits. And then RLS *hides* the
-- damage: `SELECT count(*) FROM crm.rep_role` with no tenant context returns 0, and
-- inside tenant B the row looks ordinary. Verified against a live cluster as `crm_app`
-- before this file was written: a tenant-B grant naming a tenant-A grantor inserted,
-- committed, and was invisible to every reader who was not looking for it.
--
-- THE RULE. A reference inside `crm.*` carries the tenant it was written in:
--
--     FOREIGN KEY (tenant_id, <ref>_id) REFERENCES crm.<target> (tenant_id, id)
--
-- All 38 of them, with no exceptions left behind. The database now answers "same tenant?"
-- at the same moment it answers "does it exist?", and the two can no longer disagree.
-- This is the convention the ERP's own column-mapped store already emits for served
-- entity tables (ADR-0001, "What the ERP is genuinely good at"), so the two schemas now
-- read the same way.
--
-- WHY ALL 38 AND NOT THE THREE THE ADR NAMED. The ADR's reason for leaving it was that
-- "changing the convention for one table would be worse than leaving it stated here" —
-- correct, and the conclusion is to change the convention everywhere rather than to keep
-- the hole. A survey of `pg_constraint` (not a grep) found 38 foreign keys in `crm.*`,
-- every one of them single-column into a tenant-scoped table's `id`, and every one of them
-- on a table that already carries `tenant_id` because RLS needs it. So the composite FK
-- is nearly free here: no column is added to any table and no data is backfilled. Three
-- of the 38 happen to be refused today by a BEFORE trigger that reads the parent under
-- RLS, sees nothing, and raises — `sample_transaction.transfer_of`, `visit.rep_profile_id`
-- and `call_plan_target.call_plan_id`. They are converted too: that refusal is a side
-- effect of a trigger asking a business question, it is one new `kind` or one new branch
-- away from being lost, and a reader cannot tell it apart from the 35 that were never
-- protected at all.
--
-- `sample_holding` is the case that settles the argument. Its guard refuses every direct
-- write, so its two references look unreachable — but `sample_transaction_apply` copies
-- `lot_id` and `rep_profile_id` straight across from the ledger row, so a cross-tenant
-- lot on an `adjustment_in` lands in a derived balance table. A reference is exposed if
-- ANY path reaches it, and "which paths reach this column" is not a question a schema
-- should need asked.
--
-- WHAT IS DELIBERATELY NOT TOUCHED: ERP REFERENCES. The CRM is 3-degraded (ADR-0001 Q1).
-- There are no foreign keys into ERP tables and there cannot be: the deployed ERP runs
-- `--store pg` with every record in one JSONB table, so an `erp_account_id` is a
-- `crm.erp_record_id` domain over TEXT with a shape CHECK and nothing to reference. The
-- catalog confirms it — zero foreign keys cross a schema boundary in either direction.
-- Those columns are not references and are left exactly as they are.
--
-- THE UNIQUE CONSTRAINTS ARE NOT UNIQUENESS CLAIMS. `UNIQUE (tenant_id, id)` on a table
-- whose `id` is already the primary key is redundant as a claim — `id` alone is unique, so
-- `(tenant_id, id)` cannot be anything else. It exists for one reason: Postgres will only
-- let a foreign key reference columns covered by a unique index, so a referenceable target
-- has to be created before it can be referenced. Eleven of them, one per table that is
-- referenced at all. That is the price of this migration and it is worth naming:
--
--   * The column ORDER is the useful one. `(tenant_id, id)` can serve a tenant-scoped
--     index-only scan or an `ORDER BY id` within a tenant; `(id, tenant_id)` would be a
--     strict prefix of the primary key and therefore pure overhead. Both work as FK
--     targets, so the order is free to be the one that is occasionally useful.
--   * Making `(tenant_id, id)` the PRIMARY KEY instead was considered and rejected. It
--     would cost the single-column `id` lookup every read path uses, break the
--     `ON CONFLICT (id)` clauses the offline-sync paths depend on (rule 7 — the device
--     mints the id so a retried sync collapses into the same row), and change
--     `crm.sample_holding`'s key shape for no benefit. The redundant index is cheaper than
--     any of that.
--   * No index is added on the REFERENCING side. The composite check looks up the child by
--     `(tenant_id, <ref>_id)`, and the columns that have an index today keep serving it;
--     the ones that do not (`rep_role.granted_by`, `expense_claim.approved_by`,
--     `outbox.revived_by`, `call_plan.approved_by`, `sample_count.counted_by`) had none
--     before either, so nothing gets slower. Adding five indexes to a migration about
--     tenant scoping would be a different change wearing this one's clothes.
--
-- ON DELETE IS PRESERVED EXACTLY, CONSTRAINT BY CONSTRAINT. This matters more than
-- anything else in the file: `ON DELETE` is the business rule, and a drop-and-recreate is
-- exactly where one gets silently rewritten. Six are `CASCADE`, deliberately, because the
-- child is part of the parent and has no meaning without it — `call_plan_product` and
-- `call_plan_target` on `call_plan`, `notification_delivery` on both `notification` and
-- `notification_endpoint` (0021), `sample_count_line` on `sample_count`, `visit_product`
-- on `visit`. The other 32 are `RESTRICT`, also deliberately, because the record IS the
-- audit trail and losing it to a parent's deletion would lose the trail —
-- `crm.expense_claim` → `crm.rep_profile` and the sample ledger → `crm.rep_profile` are
-- the two the ADR calls out by name, and `rep_role` is the same argument (a grant is
-- history; it can be ended, not deleted). Every `ADD CONSTRAINT` below restates the
-- clause its `DROP` removed and no constraint changes behaviour.
--
-- ON UPDATE is likewise left implicit — all 38 were `NO ACTION` and still are. Nothing
-- in this schema updates a primary key.
--
-- One consequence of the composite key worth stating, because it is a behaviour change and
-- not only a tightening: a parent delete now considers only children IN THE SAME TENANT. A
-- `RESTRICT` that used to be tripped by a child row in another tenant no longer is, and a
-- `CASCADE` no longer reaches one. That is the right direction — after this migration no
-- such child can exist — and it is the only way the two halves could be consistent.
--
-- MATCH SIMPLE, NOT MATCH FULL, AND THAT IS LOAD-BEARING. Under the default MATCH SIMPLE
-- a composite reference with ANY null column is not checked at all. `tenant_id` is NOT
-- NULL on all 34 tenant-scoped tables, so the only column that can be null is the
-- reference itself — and a null reference meaning "no parent" is precisely the existing
-- semantics of every nullable FK here (`revoked_by`, `approved_by`, `superseded_by`,
-- `transfer_of`, `visit_id`, …). MATCH FULL would demand all-null-or-none-null and would
-- therefore refuse every one of those rows, turning an optional reference into a mandatory
-- one. The default is correct; it is written out nowhere and would be easy to "fix".
--
-- DROP AND ADD IN ONE STATEMENT, PER TABLE. Each `ALTER TABLE` below does both, so there
-- is no instant at which the table has no foreign key. The migration runner wraps a whole
-- file in one transaction, but `scripts/setup-test-db.sh` applies files through `psql`
-- without `-1`, where each statement commits on its own — so the atomicity has to be in
-- the statement rather than assumed from the caller.
--
-- EXISTING BAD DATA: THE VALIDATION POSTGRES RUNS HERE IS BLIND, SO THIS FILE DOES THE
-- CHECK ITSELF. This was going to be a paragraph saying that adding a validated composite
-- FK refuses if a pre-existing row names a parent in another tenant — the same argument
-- 0029 made for `sample_tx_transfer_of_only_settles` ("NOT VALID would have been the
-- cautious choice, but these rows are few and young and a constraint that is never
-- validated is a constraint that does not hold"). It is not true here, and the reason is
-- worth the space because it is the second RLS trap in this one file.
--
-- Measured, not reasoned about: with a known cross-tenant `rep_role` row sitting in the
-- table, running this file as `crm_app` added all 38 constraints, marked every one
-- `convalidated = true`, and left the bad row in place. The same `ALTER TABLE` as the
-- superuser refused it immediately, naming the key. The difference is that Postgres
-- validates a new foreign key with one `LEFT JOIN` query over the two tables, and THAT
-- query is an ordinary query — so `crm_app`, which owns these tables under FORCE ROW LEVEL
-- SECURITY and has no `app.current_tenant_id` during a migration, validated the constraint
-- against zero visible rows and found nothing wrong. Per-row referential checks bypass RLS,
-- which is why every subsequent INSERT is correctly refused; the bulk validation does not.
-- A constraint that is marked valid without having looked is worse than one that is not
-- marked valid at all.
--
-- So section 0 below is a pre-flight that looks properly, and it has to get past the same
-- RLS to do it. The ways that do not work, so nobody tries them again:
--
--   * A plain scan as `crm_app` sees nothing, for the reason above, and would report zero
--     violations on a leaking database.
--   * `SET row_security = off` is an ERROR under FORCE, not a bypass — verified: "query
--     would be affected by row-level security policy for table …".
--   * `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` for the duration of the scan would work
--     and is rejected on principle: it opens, deliberately, the exact hole this file
--     closes, inside the one file whose worst failure mode is leaving it open.
--   * A `SECURITY DEFINER` function does not help — it would be owned by `crm_app`, and
--     FORCE applies to the owner. `schema.contract.test.ts` forbids one anyway.
--
-- What does work is to ask the question from inside each tenant, where RLS is an asset
-- rather than an obstacle: under `app.current_tenant_id = T` a child row of T is visible
-- and a parent in another tenant is NOT, so a cross-tenant reference shows up as a child
-- row whose parent cannot be found — the same `LEFT JOIN` Postgres would have run, run once
-- per tenant. `crm.tenant` is the CRM's own registry and is RLS-exempt, so it can be
-- enumerated. The pre-flight walks it, probes all 38 references in each tenant, and raises
-- with the table, the column, the tenant and the row count for every violation it finds.
-- The cost is 38 queries per registered tenant, once, each an anti-join a tenant-prefixed
-- index can serve; a migration is the right place to pay that.
--
-- The one gap it leaves, stated rather than hidden: a row whose `tenant_id` is not in
-- `crm.tenant` is not scanned, because nothing can enumerate it. No table references the
-- registry, so such a row is possible — and it is a defect in its own right, since the
-- registry is the list of tenants this deployment serves. Writes are closed structurally
-- from this migration onwards either way.
--
-- WHAT STAYS OPEN. A composite foreign key still cannot be declared on a column pair the
-- referencing table does not carry, so this closes the class only for tables that already
-- have `tenant_id` — which is all 34 of them today, and the drift guard in
-- `packages/db/src/composite-fk.contract.test.ts` is what makes the thirty-fifth fail a
-- test instead of quietly reopening it. That guard also carries the references this file
-- does not reach: migrations 0033 and 0034 were being written while this one was, and add
-- eight more single-column references on four new tables (`crm.attachment`,
-- `crm.attachment_blob`, `crm.attachment_access`, `crm.notification_endpoint_probe`). Both
-- run BEFORE 0035, so this file COULD convert them, and deliberately does not: naming
-- another in-flight migration's constraints breaks the whole ordered chain if that file
-- changes under it, where a stale entry in the test breaks one test with a message saying
-- what to do. They are listed there by name with the conversion each one is owed, so they
-- are a finite, visible debt rather than a reopened class, and a NINTH cannot appear
-- without failing that test.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: is there already a cross-tenant reference in the data?
--
--    Runs BEFORE anything is altered, so a leaking database is reported rather than
--    half-migrated. Derived from `pg_constraint` rather than from a hand-written list of
--    38 triples: the list in section 2 is what this migration INTENDS, and this block
--    checks what the database actually has, which is the only way the two can be seen to
--    disagree. See the header for why it iterates tenants.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  t        uuid;
  fk       record;
  offenders bigint;
  findings text[] := '{}';
BEGIN
  FOR t IN SELECT tenant_id FROM crm.tenant ORDER BY tenant_id LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);

    FOR fk IN
      SELECT con.conname,
             child.relname AS child,
             (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS col,
             parent.relname AS parent
        FROM pg_constraint con
        JOIN pg_class child  ON child.oid  = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace n  ON n.oid      = child.relnamespace
       WHERE con.contype = 'f'
         AND n.nspname = 'crm'
         AND array_length(con.conkey, 1) = 1
         -- only a reference BY single-column id INTO a tenant-scoped table is in scope;
         -- an ERP id is a CHECKed TEXT column and is not a reference at all.
         AND (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1]) = 'id'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id'
                        AND NOT a.attisdropped)
       ORDER BY child.relname, con.conname
    LOOP
      EXECUTE format(
        'SELECT count(*) FROM crm.%I c WHERE c.%I IS NOT NULL AND NOT EXISTS ('
          'SELECT 1 FROM crm.%I p WHERE p.tenant_id = c.tenant_id AND p.id = c.%I)',
        fk.child, fk.col, fk.parent, fk.col)
        INTO offenders;

      IF offenders > 0 THEN
        findings := findings || format(
          '  %s: %s row(s) of crm.%s in tenant %s whose %s names a crm.%s in another tenant',
          fk.conname, offenders, fk.child, t, fk.col, fk.parent);
      END IF;
    END LOOP;
  END LOOP;

  -- Leave the transaction as it was found. The ALTERs below do not read any row, but a
  -- migration that silently left a tenant context set would be a trap for whatever ran next.
  PERFORM set_config('app.current_tenant_id', '', true);

  IF cardinality(findings) > 0 THEN
    RAISE EXCEPTION E'cross-tenant references already exist in this database:\n%',
      array_to_string(findings, E'\n')
      USING HINT = 'each of these rows is a tenant isolation leak that predates this '
                   'migration. As the admin role, for each one: SELECT c.id, c.tenant_id, '
                   'p.tenant_id FROM crm.<child> c JOIN crm.<parent> p ON p.id = c.<col> '
                   'WHERE p.tenant_id <> c.tenant_id; then decide per row whether it is '
                   'repointed or deleted. Do not weaken the constraint to admit it.';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The referenceable targets. Eleven tables; see the header for why these indexes
--    exist and why they are not uniqueness claims.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.rep_profile          ADD CONSTRAINT rep_profile_tenant_id_id_key          UNIQUE (tenant_id, id);
ALTER TABLE crm.territory            ADD CONSTRAINT territory_tenant_id_id_key            UNIQUE (tenant_id, id);
ALTER TABLE crm.cycle                ADD CONSTRAINT cycle_tenant_id_id_key                UNIQUE (tenant_id, id);
ALTER TABLE crm.call_plan            ADD CONSTRAINT call_plan_tenant_id_id_key            UNIQUE (tenant_id, id);
ALTER TABLE crm.visit                ADD CONSTRAINT visit_tenant_id_id_key                UNIQUE (tenant_id, id);
ALTER TABLE crm.sample_lot           ADD CONSTRAINT sample_lot_tenant_id_id_key           UNIQUE (tenant_id, id);
ALTER TABLE crm.sample_transaction   ADD CONSTRAINT sample_transaction_tenant_id_id_key   UNIQUE (tenant_id, id);
ALTER TABLE crm.sample_count         ADD CONSTRAINT sample_count_tenant_id_id_key         UNIQUE (tenant_id, id);
ALTER TABLE crm.disposal_obligation  ADD CONSTRAINT disposal_obligation_tenant_id_id_key  UNIQUE (tenant_id, id);
ALTER TABLE crm.notification         ADD CONSTRAINT notification_tenant_id_id_key         UNIQUE (tenant_id, id);
ALTER TABLE crm.notification_endpoint ADD CONSTRAINT notification_endpoint_tenant_id_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. The references. Names are preserved so error messages, and the one unit test that
--    asserts on a constraint name (`expense_claim_rep_profile_id_fkey`), still read true.
-- ---------------------------------------------------------------------------

-- crm.account_assignment → crm.territory
ALTER TABLE crm.account_assignment
  DROP CONSTRAINT account_assignment_territory_id_fkey,
  ADD  CONSTRAINT account_assignment_territory_id_fkey
       FOREIGN KEY (tenant_id, territory_id) REFERENCES crm.territory (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.territory → itself. A self-reference needs nothing special: the parent row and the
-- child row are separate rows, and `territory_not_self_parent` plus the cycle trigger were
-- never about tenancy. An inserted parent_id that names another tenant's territory is
-- invisible to the cycle walk under RLS, so the walk finds no cycle and allows it — which
-- is the whole exposure, in the one place a reader would assume there was none.
ALTER TABLE crm.territory
  DROP CONSTRAINT territory_parent_id_fkey,
  ADD  CONSTRAINT territory_parent_id_fkey
       FOREIGN KEY (tenant_id, parent_id) REFERENCES crm.territory (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.territory_assignment → crm.territory, crm.rep_profile
ALTER TABLE crm.territory_assignment
  DROP CONSTRAINT territory_assignment_territory_id_fkey,
  ADD  CONSTRAINT territory_assignment_territory_id_fkey
       FOREIGN KEY (tenant_id, territory_id) REFERENCES crm.territory (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT territory_assignment_rep_profile_id_fkey,
  ADD  CONSTRAINT territory_assignment_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.cycle is referenced only by crm.call_plan, below.

-- crm.call_plan → crm.cycle, crm.rep_profile ×3, itself.
-- `superseded_by` is DEFERRABLE INITIALLY DEFERRED and stays that way: superseding a plan
-- writes both rows in one transaction and the successor does not exist yet when the
-- predecessor is pointed at it. The referenced UNIQUE constraint is non-deferrable, which
-- is what a deferrable FK requires.
ALTER TABLE crm.call_plan
  DROP CONSTRAINT call_plan_cycle_id_fkey,
  ADD  CONSTRAINT call_plan_cycle_id_fkey
       FOREIGN KEY (tenant_id, cycle_id) REFERENCES crm.cycle (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT call_plan_rep_profile_id_fkey,
  ADD  CONSTRAINT call_plan_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT call_plan_submitted_by_fkey,
  ADD  CONSTRAINT call_plan_submitted_by_fkey
       FOREIGN KEY (tenant_id, submitted_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT call_plan_approved_by_fkey,
  ADD  CONSTRAINT call_plan_approved_by_fkey
       FOREIGN KEY (tenant_id, approved_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT call_plan_superseded_by_fkey,
  ADD  CONSTRAINT call_plan_superseded_by_fkey
       FOREIGN KEY (tenant_id, superseded_by) REFERENCES crm.call_plan (tenant_id, id)
       ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- crm.call_plan_product → crm.call_plan. CASCADE: a plan's product list is part of the
-- plan (0015).
ALTER TABLE crm.call_plan_product
  DROP CONSTRAINT call_plan_product_call_plan_id_fkey,
  ADD  CONSTRAINT call_plan_product_call_plan_id_fkey
       FOREIGN KEY (tenant_id, call_plan_id) REFERENCES crm.call_plan (tenant_id, id)
       ON DELETE CASCADE;

-- crm.call_plan_target → crm.call_plan. CASCADE, same reason.
ALTER TABLE crm.call_plan_target
  DROP CONSTRAINT call_plan_target_call_plan_id_fkey,
  ADD  CONSTRAINT call_plan_target_call_plan_id_fkey
       FOREIGN KEY (tenant_id, call_plan_id) REFERENCES crm.call_plan (tenant_id, id)
       ON DELETE CASCADE;

-- crm.visit → crm.rep_profile
ALTER TABLE crm.visit
  DROP CONSTRAINT visit_rep_profile_id_fkey,
  ADD  CONSTRAINT visit_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.visit_product → crm.visit. CASCADE: detailing lines are part of the visit (0012).
ALTER TABLE crm.visit_product
  DROP CONSTRAINT visit_product_visit_id_fkey,
  ADD  CONSTRAINT visit_product_visit_id_fkey
       FOREIGN KEY (tenant_id, visit_id) REFERENCES crm.visit (tenant_id, id)
       ON DELETE CASCADE;

-- crm.sample_transaction → crm.sample_lot, crm.rep_profile ×2, crm.visit, itself.
-- Every one RESTRICT: this is the custody ledger and it is append-only (rule 14). A
-- deletion that took a movement with it would silently restate a balance.
ALTER TABLE crm.sample_transaction
  DROP CONSTRAINT sample_transaction_lot_id_fkey,
  ADD  CONSTRAINT sample_transaction_lot_id_fkey
       FOREIGN KEY (tenant_id, lot_id) REFERENCES crm.sample_lot (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_transaction_rep_profile_id_fkey,
  ADD  CONSTRAINT sample_transaction_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_transaction_counterparty_rep_profile_id_fkey,
  ADD  CONSTRAINT sample_transaction_counterparty_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, counterparty_rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_transaction_visit_id_fkey,
  ADD  CONSTRAINT sample_transaction_visit_id_fkey
       FOREIGN KEY (tenant_id, visit_id) REFERENCES crm.visit (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_transaction_transfer_of_fkey,
  ADD  CONSTRAINT sample_transaction_transfer_of_fkey
       FOREIGN KEY (tenant_id, transfer_of) REFERENCES crm.sample_transaction (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.sample_holding → crm.rep_profile, crm.sample_lot. The derived balance table: its
-- guard refuses every direct write, so these two are written only by
-- `sample_transaction_apply`, which copies the ledger row's ids across unchanged. That is
-- the path, not the absence of one.
ALTER TABLE crm.sample_holding
  DROP CONSTRAINT sample_holding_rep_profile_id_fkey,
  ADD  CONSTRAINT sample_holding_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_holding_lot_id_fkey,
  ADD  CONSTRAINT sample_holding_lot_id_fkey
       FOREIGN KEY (tenant_id, lot_id) REFERENCES crm.sample_lot (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.sample_count → crm.rep_profile ×2
ALTER TABLE crm.sample_count
  DROP CONSTRAINT sample_count_rep_profile_id_fkey,
  ADD  CONSTRAINT sample_count_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT sample_count_counted_by_fkey,
  ADD  CONSTRAINT sample_count_counted_by_fkey
       FOREIGN KEY (tenant_id, counted_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.sample_count_line → crm.sample_count (CASCADE: lines are part of the count, 0017),
-- crm.sample_lot (RESTRICT).
ALTER TABLE crm.sample_count_line
  DROP CONSTRAINT sample_count_line_count_id_fkey,
  ADD  CONSTRAINT sample_count_line_count_id_fkey
       FOREIGN KEY (tenant_id, count_id) REFERENCES crm.sample_count (tenant_id, id)
       ON DELETE CASCADE,
  DROP CONSTRAINT sample_count_line_lot_id_fkey,
  ADD  CONSTRAINT sample_count_line_lot_id_fkey
       FOREIGN KEY (tenant_id, lot_id) REFERENCES crm.sample_lot (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.disposal_obligation → crm.rep_profile, crm.sample_lot, crm.sample_transaction,
-- itself. All RESTRICT: an obligation and the movement that resolved it are the record of
-- a regulated disposal (rule 24).
ALTER TABLE crm.disposal_obligation
  DROP CONSTRAINT disposal_obligation_rep_profile_id_fkey,
  ADD  CONSTRAINT disposal_obligation_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT disposal_obligation_lot_id_fkey,
  ADD  CONSTRAINT disposal_obligation_lot_id_fkey
       FOREIGN KEY (tenant_id, lot_id) REFERENCES crm.sample_lot (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT disposal_obligation_resolving_transaction_id_fkey,
  ADD  CONSTRAINT disposal_obligation_resolving_transaction_id_fkey
       FOREIGN KEY (tenant_id, resolving_transaction_id) REFERENCES crm.sample_transaction (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT disposal_obligation_continues_obligation_id_fkey,
  ADD  CONSTRAINT disposal_obligation_continues_obligation_id_fkey
       FOREIGN KEY (tenant_id, continues_obligation_id) REFERENCES crm.disposal_obligation (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.expense_claim → crm.rep_profile ×3. RESTRICT, called out by the ADR: the claim is
-- the audit trail of a reimbursement and outlives the profile that filed it.
ALTER TABLE crm.expense_claim
  DROP CONSTRAINT expense_claim_rep_profile_id_fkey,
  ADD  CONSTRAINT expense_claim_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT expense_claim_approved_by_fkey,
  ADD  CONSTRAINT expense_claim_approved_by_fkey
       FOREIGN KEY (tenant_id, approved_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT expense_claim_rejected_by_fkey,
  ADD  CONSTRAINT expense_claim_rejected_by_fkey
       FOREIGN KEY (tenant_id, rejected_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.notification → crm.rep_profile
ALTER TABLE crm.notification
  DROP CONSTRAINT notification_recipient_rep_profile_id_fkey,
  ADD  CONSTRAINT notification_recipient_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, recipient_rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.notification_delivery → crm.notification, crm.notification_endpoint. Both CASCADE,
-- both deliberate (0021): a delivery attempt is an attribute of the notification and of
-- the endpoint it was aimed at, and has no meaning once either is gone.
ALTER TABLE crm.notification_delivery
  DROP CONSTRAINT notification_delivery_notification_id_fkey,
  ADD  CONSTRAINT notification_delivery_notification_id_fkey
       FOREIGN KEY (tenant_id, notification_id) REFERENCES crm.notification (tenant_id, id)
       ON DELETE CASCADE,
  DROP CONSTRAINT notification_delivery_endpoint_id_fkey,
  ADD  CONSTRAINT notification_delivery_endpoint_id_fkey
       FOREIGN KEY (tenant_id, endpoint_id) REFERENCES crm.notification_endpoint (tenant_id, id)
       ON DELETE CASCADE;

-- crm.outbox → crm.rep_profile. `revived_by` names whoever re-queued a dead letter
-- (0022); RESTRICT keeps the attribution.
ALTER TABLE crm.outbox
  DROP CONSTRAINT outbox_revived_by_fkey,
  ADD  CONSTRAINT outbox_revived_by_fkey
       FOREIGN KEY (tenant_id, revived_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.rep_role → crm.rep_profile ×3. The three the ADR named, and the two
-- (`granted_by`, `revoked_by`) that the shipped `revoke_rep_role` bug reached.
ALTER TABLE crm.rep_role
  DROP CONSTRAINT rep_role_rep_profile_id_fkey,
  ADD  CONSTRAINT rep_role_rep_profile_id_fkey
       FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT rep_role_granted_by_fkey,
  ADD  CONSTRAINT rep_role_granted_by_fkey
       FOREIGN KEY (tenant_id, granted_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT rep_role_revoked_by_fkey,
  ADD  CONSTRAINT rep_role_revoked_by_fkey
       FOREIGN KEY (tenant_id, revoked_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;
