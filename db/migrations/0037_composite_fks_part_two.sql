-- 0037_composite_fks_part_two.sql
--
-- The last eight references in crm.* become tenant-scoped, and the debt 0035 wrote down
-- is paid off rather than carried.
--
-- WHAT WAS BROKEN. Nothing new. This is the same defect 0035 closed, still open on four
-- tables: **a referential integrity check runs with row security disabled**. Postgres
-- documents it and it is what makes a foreign key usable at all — a parent you cannot see
-- would otherwise read as a parent that does not exist — so RLS was never standing between
-- a row and another tenant's parent. 0035 demonstrated the consequence live rather than
-- arguing it: as `crm_app`, under FORCE ROW LEVEL SECURITY, inside `withTenantContext`, a
-- tenant-B `rep_role` naming a tenant-A profile as `granted_by` inserted and **committed**,
-- and `SELECT count(*)` with no tenant context then returned 0, because RLS hides the
-- damage it did not prevent.
--
-- 0035 converted 38 references and left eight, for a reason that was good at the time and
-- is spent now: the eight live on tables created by `0033_attachments.sql` and
-- `0034_endpoint_probe.sql`, both of which run BEFORE 0035 and both of which were still
-- being written while it was. A migration that names another in-flight file's constraints
-- breaks the entire ordered chain the moment that file changes under it, where a stale
-- entry in `packages/db/src/composite-fk.contract.test.ts` breaks one test with a message
-- saying what to do. So they were written down in `AWAITING_CONVERSION` with the conversion
-- each one owed, which made the hole finite and visible and made a ninth fail a test. 0033
-- and 0034 are now applied and hash-gated; this file is the one that can reach them.
--
-- THE RULE, unchanged from 0035. A reference inside `crm.*` carries the tenant it was
-- written in:
--
--     FOREIGN KEY (tenant_id, <ref>) REFERENCES crm.<target> (tenant_id, id)
--
-- The database answers "same tenant?" at the same moment it answers "does it exist?", and
-- the two can no longer disagree. After this file there is no single-column reference into
-- a tenant-scoped table anywhere in `crm`, and `AWAITING_CONVERSION` is empty.
--
-- THE EIGHT, AS THE CATALOG HAS THEM — NOT AS THE LIST SAID. The list in the test file was
-- written from a read of `pg_constraint` taken while 0033 and 0034 were still moving, and
-- it is right about which eight and about seven of their `ON DELETE` clauses. It records
-- nothing about deferrability, and one of them is deferrable:
--
--   crm.attachment
--     attachment_uploaded_by_fkey                   -> rep_profile           RESTRICT
--     attachment_supersedes_attachment_id_fkey      -> attachment            RESTRICT
--     attachment_superseded_by_attachment_id_fkey   -> attachment            RESTRICT
--                                                      DEFERRABLE INITIALLY DEFERRED
--   crm.attachment_blob
--     attachment_blob_attachment_id_fkey            -> attachment            RESTRICT
--   crm.attachment_access
--     attachment_access_attachment_id_fkey          -> attachment            RESTRICT
--     attachment_access_read_by_fkey                -> rep_profile           RESTRICT
--   crm.notification_endpoint_probe
--     notification_endpoint_probe_endpoint_id_fkey  -> notification_endpoint CASCADE
--     notification_endpoint_probe_requested_by_fkey -> rep_profile           RESTRICT
--
-- All eight are `ON UPDATE NO ACTION`, `MATCH SIMPLE`, and validated. Every attribute
-- above was read from `pg_constraint` (`confdeltype`, `confupdtype`, `condeferrable`,
-- `condeferred`, `confmatchtype`) against the live database, and the same six columns were
-- captured for all 46 foreign keys in `crm` before this file ran and after, and diffed: the
-- only difference is the column list. That is the method 0035 used and it is the only one
-- that answers the question — "the clause looks the same" is a claim about a text file, not
-- about the constraint the next write will meet.
--
-- WHY `ON DELETE` IS THE PART TO BE CAREFUL WITH. It is the business rule, and a
-- drop-and-recreate is precisely where one gets silently rewritten. Seven of the eight are
-- `RESTRICT` and each one is deliberate:
--
--   * `crm.attachment` cannot be deleted at all — `attachment_append_only` refuses every
--     DELETE, because an attachment IS the regulated record and not a copy of one. 0033
--     says so where it declares `attachment_blob`'s reference: RESTRICT rather than the
--     ordinary CASCADE, because a cascade would describe a path that does not exist and
--     would quietly BECOME the path if the append-only trigger were ever relaxed. The same
--     argument covers `attachment_access` and both self-references.
--   * `uploaded_by` and `read_by` name a rep. A receipt is the audit trail of a
--     reimbursement and an access record is the audit trail of who looked at evidence;
--     either one losing its attribution to a profile deletion would lose the trail. Same
--     reasoning as `crm.expense_claim` -> `crm.rep_profile` in 0035.
--   * `requested_by` is the same: 0034 made it NOT NULL on the grounds that a probe sends
--     real traffic to somebody else's server, so it is attributable or it does not happen.
--
-- The eighth is `CASCADE` and that is equally deliberate: a `notification_endpoint_probe`
-- is the test history of one endpoint and has no meaning once the endpoint is gone, so
-- 0034 wrote CASCADE and 0021 wrote the same for `notification_delivery`. Getting this one
-- backwards in either direction is the failure this file has to avoid — a RESTRICT here
-- would make an endpoint undeletable once probed, and a CASCADE on any of the other seven
-- would silently destroy evidence.
--
-- DEFERRABILITY IS PRESERVED TOO, AND ON ONE CONSTRAINT IT IS LOAD-BEARING.
-- `attachment_superseded_by_attachment_id_fkey` is DEFERRABLE INITIALLY DEFERRED and has to
-- be. Superseding an attachment marks the OLD row first — `uq_attachment_current` admits
-- only one `current` row per (subject, purpose), so inserting the successor first would
-- collide — which means the back link is written before the row it names exists. Deferring
-- the check to COMMIT is what makes "superseded by a row that was never written" fail
-- instead of commit. Recreating it non-deferrable would break the one write path the
-- column exists for, and it would break it at the first supersede rather than at migration
-- time. The forward link `supersedes_attachment_id` is NOT deferrable and must not become
-- so: the row it names already exists by then.
--
-- MATCH SIMPLE, NOT MATCH FULL, AND IT IS WRITTEN NOWHERE. Under the default MATCH SIMPLE a
-- composite reference with ANY null column is not checked at all. `tenant_id` is NOT NULL
-- on every tenant-scoped table in this schema, so the only column in each pair that can be
-- null is the reference itself — and a null reference meaning "no parent" is exactly the
-- existing semantics. On these eight that matters for the two self-references:
-- `supersedes_attachment_id` and `superseded_by_attachment_id` are null on every attachment
-- that neither replaces nor has been replaced, which is nearly all of them. MATCH FULL
-- would demand all-null-or-none-null and would therefore refuse every ordinary attachment
-- the moment this migration applied. (The other six columns are NOT NULL today, which is
-- itself a reason to spell this out: a future migration that relaxes one of them to
-- nullable inherits the correct behaviour only because MATCH SIMPLE is the default, and
-- nothing in the DDL says so. It is the default; it is correct; it would be easy to "fix".)
--
-- THE UNIQUE CONSTRAINT IS NOT A UNIQUENESS CLAIM. `crm.attachment` is referenced by four
-- of the eight — twice by itself, once by `attachment_blob`, once by `attachment_access` —
-- and it is the one referenced table 0035 did not already give a referenceable target. So
-- it gets `UNIQUE (tenant_id, id)`, which is redundant AS A CLAIM: `id` is already the
-- primary key, so `(tenant_id, id)` cannot be anything but unique. It exists for one
-- reason — Postgres will only let a foreign key name columns covered by a unique index —
-- and the column ORDER is the useful one, because `(tenant_id, id)` can serve a
-- tenant-scoped scan where `(id, tenant_id)` would be a strict prefix of the primary key
-- and therefore pure overhead. Making `(tenant_id, id)` the primary key instead was
-- rejected for 0035's reasons and they all still hold here: `crm.attachment_blob`'s key is
-- `attachment_id` alone and `@crm/storage` reads attachments by id.
--
-- The other three targets (`crm.rep_profile`, `crm.notification_endpoint`,
-- `crm.attachment` as seen from its children) need nothing new; 0035 created eleven such
-- constraints and two of them are reused here. This file adds the twelfth and last.
--
-- NO INDEX IS ADDED ON THE REFERENCING SIDE, same as 0035. The composite check looks the
-- child up by `(tenant_id, <ref>)`; `idx_attachment_uploader` and
-- `idx_attachment_access_by` are already `(tenant_id, …)`-prefixed and keep serving it, and
-- the ones that are not — `idx_attachment_supersedes (supersedes_attachment_id)`,
-- `idx_notification_endpoint_probe_history (endpoint_id, seq DESC)` — had no tenant prefix
-- before either, so nothing gets slower. Adding indexes in a migration about tenant
-- scoping would be a different change wearing this one's clothes.
--
-- ONE CONSEQUENCE WORTH STATING, because it is a behaviour change and not only a
-- tightening: a parent delete now considers only children IN THE SAME TENANT. A `RESTRICT`
-- that used to be tripped by a child row in another tenant no longer is, and the one
-- `CASCADE` no longer reaches one. That is the right direction — after this file no such
-- child can be written — and it is the only way the two halves could be consistent.
--
-- DROP AND ADD IN ONE STATEMENT, PER TABLE. Each `ALTER TABLE` below does both, so there is
-- no instant at which the table has no foreign key. The migration runner wraps a whole file
-- in one transaction, but `scripts/setup-test-db.sh` applies files through `psql` without
-- `-1`, where each statement commits on its own — so the atomicity has to be in the
-- statement rather than assumed from the caller.
--
-- ============================================================================
-- THE PRE-FLIGHT, AND WHY IT IS NOT OPTIONAL ON FOUR TABLES THAT ARE PROBABLY EMPTY
-- ============================================================================
--
-- 0035 measured something that is easy to disbelieve and is the most important sentence in
-- either file: **a validated constraint can be added without having looked.** Postgres
-- validates a new foreign key with a single `LEFT JOIN` over the two tables, and that is an
-- ORDINARY QUERY. `crm_app` owns these tables under FORCE ROW LEVEL SECURITY and holds no
-- `app.current_tenant_id` during a migration, so the join ran against zero visible rows,
-- found nothing wrong, and marked all 38 constraints `convalidated = true` with a known
-- cross-tenant row still sitting in the table. The same `ALTER TABLE` as the superuser
-- refused instantly and named the key. Per-row referential checks bypass RLS, which is why
-- every subsequent INSERT is correctly refused; the bulk validation does not, which is why
-- the existing rows are not. A constraint marked valid without having looked is worse than
-- one that was never validated at all.
--
-- "These four tables are new and are probably empty" is not an argument, for two reasons.
-- A migration does not get to assume what is in a production database it has never seen —
-- 0033 and 0034 may have been applied months before this file reaches a given deployment,
-- and `crm.attachment` is exactly the kind of table that fills up. And the finding is
-- worse than empty-or-not: the database will report that it checked when it did not, so
-- skipping the look leaves no trace that nobody looked.
--
-- So section 0 is 0035's pre-flight, reused rather than reinvented, and it has to get past
-- the same RLS to do its job. The ways that do not work are recorded in 0035's header; in
-- short, a plain scan as `crm_app` sees nothing and would report a leaking database clean,
-- `SET row_security = off` is an ERROR under FORCE rather than a bypass, a SECURITY DEFINER
-- function does not help because FORCE applies to the owner (and `schema.contract.test.ts`
-- forbids one), and `NO FORCE ROW LEVEL SECURITY` for the duration of the scan would work
-- and is refused on principle, because it opens the exact hole these two files exist to
-- close, inside the files whose worst failure mode is leaving it open.
--
-- What works is to ask the question from inside each tenant, where RLS becomes the asset:
-- under `app.current_tenant_id = T` a child row of T is visible and a parent in another
-- tenant is NOT, so a cross-tenant reference surfaces as a child row whose parent cannot be
-- found. The same `LEFT JOIN` Postgres would have run, run once per tenant. `crm.tenant` is
-- the CRM's own registry and is RLS-exempt, so it can be enumerated.
--
-- The scope is DERIVED FROM `pg_constraint`, not from the list in this header. The header
-- is what this migration intends; the catalog is what the database has, and deriving the
-- scan from the catalog is the only way the two can be seen to disagree. After 0035 the
-- derivation — every single-column reference into a table that carries `tenant_id` — returns
-- exactly these eight, which is the same set the drift guard enforces from the other side.
-- If a ninth had appeared since, it would be scanned too, which is the right behaviour: the
-- pre-flight should check what is exposed, not what this file plans to fix. The 38
-- references 0035 already converted are not re-scanned because they cannot have acquired a
-- violation — a composite key refuses one per row, at write time, bypassing RLS.
--
-- The gap 0035 named is unchanged and is not papered over here: a row whose `tenant_id` is
-- not in `crm.tenant` is never scanned, because nothing can enumerate it. No table
-- references the registry, so such a row is possible — and it is a defect in its own right,
-- since the registry is the list of tenants this deployment serves. Writes are closed
-- structurally from this migration onward either way.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: is there already a cross-tenant reference in the data?
--
--    Runs BEFORE anything is altered, so a leaking database is reported rather than
--    half-migrated. See the header for why it iterates tenants and why it reads the
--    reference list out of the catalog rather than taking it from this file.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  t         uuid;
  fk        record;
  offenders bigint;
  findings  text[] := '{}';
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
-- 1. The referenceable target. One table; `crm.rep_profile` and
--    `crm.notification_endpoint` got theirs in 0035. See the header for why this index
--    exists and why it is not a uniqueness claim.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.attachment ADD CONSTRAINT attachment_tenant_id_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. The references. Names are preserved, as in 0035, so error messages still read true and
--    so the drift guard's per-constraint probes can assert on them. `translateProbeError`
--    already keys off `23503` for the endpoint case and that stays correct;
--    `translateAttachmentError` keys off `uq_attachment_current` and `attachment_pkey`,
--    neither of which this file touches.
-- ---------------------------------------------------------------------------

-- crm.attachment → crm.rep_profile, itself ×2.
--
-- `uploaded_by` is NOT NULL and names the rep themself or whoever supervises them (0033).
-- `attachment_validate` already refuses an uploader who neither owns nor supervises the
-- subject's rep, and it asks `crm.rep_can_supervise` — which reads
-- `crm.territory_assignment` and `crm.rep_profile` under the CALLER's row security, so an
-- uploader in another tenant resolves to no supervision and is refused today. That refusal
-- is a side effect of a trigger asking a business question: it is one new branch away from
-- being lost, it does not hold for a writer that reaches this table by any other path, and
-- a reader cannot tell it apart from a column that was never protected. The constraint says
-- it structurally.
--
-- The self-references keep their asymmetric deferrability, which is the whole mechanism of
-- superseding — see the header. The referenced UNIQUE added in section 1 is non-deferrable,
-- which is what a DEFERRABLE foreign key requires of its target.
ALTER TABLE crm.attachment
  DROP CONSTRAINT attachment_uploaded_by_fkey,
  ADD  CONSTRAINT attachment_uploaded_by_fkey
       FOREIGN KEY (tenant_id, uploaded_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT attachment_supersedes_attachment_id_fkey,
  ADD  CONSTRAINT attachment_supersedes_attachment_id_fkey
       FOREIGN KEY (tenant_id, supersedes_attachment_id) REFERENCES crm.attachment (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT attachment_superseded_by_attachment_id_fkey,
  ADD  CONSTRAINT attachment_superseded_by_attachment_id_fkey
       FOREIGN KEY (tenant_id, superseded_by_attachment_id) REFERENCES crm.attachment (tenant_id, id)
       ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- crm.attachment_blob → crm.attachment. RESTRICT, and 0033 argues for it where it declares
-- the column: CASCADE is the ordinary choice and the wrong one, because crm.attachment
-- cannot be deleted at all, so a cascade would describe a path that does not exist and
-- would quietly become the path if the append-only trigger were relaxed.
--
-- `attachment_blob_verify` already compares `att.tenant_id` to `NEW.tenant_id` and raises.
-- It stays — it is also the function that checks the size, the digest and the magic bytes,
-- and it gives the better sentence — but it is no longer the only thing standing there.
ALTER TABLE crm.attachment_blob
  DROP CONSTRAINT attachment_blob_attachment_id_fkey,
  ADD  CONSTRAINT attachment_blob_attachment_id_fkey
       FOREIGN KEY (tenant_id, attachment_id) REFERENCES crm.attachment (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.attachment_access → crm.attachment, crm.rep_profile. Both RESTRICT: this table is
-- the record of who looked at a piece of regulated evidence, and it is append-only (0033).
-- It carries NO insert-time guard at all, so these two are the clearest case in this file —
-- nothing but RLS was between an access record and another tenant's attachment, and
-- referential checks bypass RLS.
ALTER TABLE crm.attachment_access
  DROP CONSTRAINT attachment_access_attachment_id_fkey,
  ADD  CONSTRAINT attachment_access_attachment_id_fkey
       FOREIGN KEY (tenant_id, attachment_id) REFERENCES crm.attachment (tenant_id, id)
       ON DELETE RESTRICT,
  DROP CONSTRAINT attachment_access_read_by_fkey,
  ADD  CONSTRAINT attachment_access_read_by_fkey
       FOREIGN KEY (tenant_id, read_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;

-- crm.notification_endpoint_probe → crm.notification_endpoint (CASCADE), crm.rep_profile
-- (RESTRICT). The CASCADE is 0034's and is kept exactly: an endpoint's test history has no
-- meaning once the endpoint is gone, the same argument 0021 made for
-- `notification_delivery`. A RESTRICT here would make a probed endpoint undeletable, which
-- is a different product decision wearing a migration's clothes.
--
-- `notification_endpoint_probe_guard` already refuses a cross-tenant `endpoint_id` by
-- reading the parent under the caller's own RLS, and its comment explains why it has to:
-- "A foreign-key check would have accepted it." After this migration that sentence is no
-- longer true, and the arm stays anyway. Three reasons, in order of weight. It is the one
-- that produces `probe-foreign-endpoint:`, which `translateProbeError` turns into a 404
-- naming the endpoint, where a bare 23503 would have to be guessed at — and that guess is
-- wrong for `requested_by`, which raises the same code. It runs BEFORE the constraint, so
-- the better sentence is the one a caller actually gets. And defence in depth is cheap
-- here: the lookup is a primary-key read the guard performs anyway on the path to the
-- cooldown check, which reads `crm.notification_endpoint_probe` by endpoint regardless. The
-- guard is not redundant in any case — it also stamps `requested_at` from the server clock,
-- enforces one outstanding probe per endpoint and applies the per-tenant cooldown, so
-- removing it was never on the table; the only question was whether its tenant arm should
-- go, and a guard is not worth deleting for being correct twice.
ALTER TABLE crm.notification_endpoint_probe
  DROP CONSTRAINT notification_endpoint_probe_endpoint_id_fkey,
  ADD  CONSTRAINT notification_endpoint_probe_endpoint_id_fkey
       FOREIGN KEY (tenant_id, endpoint_id) REFERENCES crm.notification_endpoint (tenant_id, id)
       ON DELETE CASCADE,
  DROP CONSTRAINT notification_endpoint_probe_requested_by_fkey,
  ADD  CONSTRAINT notification_endpoint_probe_requested_by_fkey
       FOREIGN KEY (tenant_id, requested_by) REFERENCES crm.rep_profile (tenant_id, id)
       ON DELETE RESTRICT;
