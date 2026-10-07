-- A receipt cannot attest about the table it is written into.
--
-- THE DEFECT, found by reading 0052 adversarially rather than by a failing test. Measured
-- against a real Postgres before this was written:
--
--   * The first erasure's receipt says `tenant_tombstone: nothing_to_erase` — and the same
--     transaction that signs that statement INSERTS a row into `crm.tenant_tombstone`. The
--     attestation is false by the time it commits, and the content hash commits to it.
--   * It says the same about `crm.tenant_tombstone_attestation`, into which that transaction
--     writes 41 rows.
--   * Run the erasure a second time and those two tables attest `retained`, with counts of 1
--     and 41 — counting the FIRST receipt. So two signed receipts about one tenant disagree
--     about the same table for purely structural reasons, and the second one's figure is
--     wrong the moment it lands, because there are then two receipts and it says one.
--
-- This is the exact failure the subsystem exists to prevent, turned inward. ADR-0317: "A proof
-- over a scope assembled from nothing is a correct proof of a false claim." Here it is a
-- correct proof of a SELF-FALSIFYING claim, which is worse, because nothing about it looks
-- wrong: the hashes verify.
--
-- THE FIX IS NOT A NEW DISPOSITION. `retain` under `deletion_evidence` is the right disposition
-- for these tables and 0052 got that part right. What was wrong is the SCOPE: a receipt may
-- not speak about its own storage. The ERP's six subsystems in ADR-0317 — `tenant_schema`,
-- `shared_tables`, `object_storage`, `backups`, `search_indexes`, `caches` — do not include its
-- own tombstone store either, so excluding ours is faithful to the mirror rather than a
-- deviation from it.
--
-- AND THE EXCLUSION IS DECLARED ON THE RECEIPT, which is 0051's own insight applied one level
-- in: a declared "we are deliberately silent about this" is not the same as silence. A reader
-- comparing 41 register rows against 39 attestations would otherwise find a discrepancy with
-- no explanation, and "the hash covers everything except two things you have to go and work
-- out" is not a property anybody can check.

-- ---------------------------------------------------------------------------
-- 1. Which tables ARE the receipt.
-- ---------------------------------------------------------------------------
-- A property of the table, declared beside its disposition rather than hardcoded in the
-- executor, for the reason every list in this schema lives in SQL: the completeness guard and
-- a reader can both ask, and a test can compare the answer to what the code does.
ALTER TABLE crm.data_disposition
  ADD COLUMN is_receipt_store boolean NOT NULL DEFAULT false;

-- A receipt store cannot be erasable. If it were, an erasure would destroy the proof of
-- itself — which is the one outcome worse than not erasing at all, and it is not a judgement
-- a deployment may amend: every other row in this register is a jurisdictional decision,
-- this one is arithmetic.
ALTER TABLE crm.data_disposition
  ADD CONSTRAINT data_disposition_receipt_store_is_retained
    CHECK (NOT is_receipt_store
           OR (disposition = 'retain' AND obligation = 'deletion_evidence'));

UPDATE crm.data_disposition
   SET is_receipt_store = true, updated_at = now()
 WHERE table_name IN ('tenant_tombstone', 'tenant_tombstone_attestation');

-- `crm.tenant` and `crm.tenant_deletion_check` are NOT receipt stores, deliberately, and the
-- line is "does the erasure transaction write it". It does not write either: 0050's watcher
-- writes them both, long before and from another process. So their attestations are honest —
-- `tenant` attests `retained, 1`, which is the row proving the stop, and that is exactly the
-- kind of thing a receipt SHOULD say. Excluding every table that smells like evidence would
-- make the receipt silent about the most load-bearing row in the deletion.
/**
 * The tables a receipt may not speak about, because it is them.
 */
CREATE OR REPLACE FUNCTION crm.receipt_store_tables()
RETURNS TABLE (table_name text)
LANGUAGE sql STABLE AS $$
  SELECT d.table_name FROM crm.data_disposition d WHERE d.is_receipt_store ORDER BY d.table_name;
$$;

-- ---------------------------------------------------------------------------
-- 2. The receipt states what it is silent about, and commits to it.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.tenant_tombstone
  ADD COLUMN excluded_tables text[] NOT NULL DEFAULT '{}'::text[];

/**
 * Whether a table-name array is sorted, de-duplicated and well-formed.
 *
 * A function because a CHECK constraint cannot contain a subquery and `unnest` needs one —
 * which is Postgres telling you the predicate is more than a comparison. IMMUTABLE because it
 * is: it reads no table, no setting and no clock, so the planner may cache it and a CHECK may
 * call it, the same contract `crm.retention_obligations()` is held to.
 */
CREATE OR REPLACE FUNCTION crm.is_canonical_table_list(names text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT names IS NOT NULL
     AND names = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[]) FROM unnest(names) t)
     AND NOT EXISTS (SELECT 1 FROM unnest(names) t WHERE t !~ '^[a-z][a-z0-9_]{2,62}$');
$$;

-- Sorted, de-duplicated and well-formed, because the content manifest commits to this array
-- and a hash over a list whose order or multiplicity varies is a hash nobody can recompute.
-- The executor produces it sorted; this refuses an unsorted one rather than trusting it.
ALTER TABLE crm.tenant_tombstone
  ADD CONSTRAINT tenant_tombstone_excluded_canonical
    CHECK (crm.is_canonical_table_list(excluded_tables));

/**
 * The manifest format this receipt's hashes were computed under.
 *
 * Added because adding `excluded_tables` to the content manifest CHANGES THE FORMAT, and a
 * receipt whose stored hash no longer recomputes is indistinguishable from a tampered one.
 * Without this column the fix would have quietly invalidated every receipt written before it —
 * there are none in production, nothing has ever run this, but a migration that depends on
 * that is a migration that is wrong the first time it is false.
 *
 * So the version is stored, the verifier selects the format by it, and `v1` receipts stay
 * verifiable forever under the rules they were made with. The domain tag inside the manifest
 * carries the same version, so a v1 digest cannot verify as v2 even if somebody rewrote this
 * column — the tag is inside the hashed bytes and this is not.
 *
 * The PROOF format is unchanged and stays `v1`: its field list is the same, and the manifest
 * hash it commits to differs by itself. Retagging it too would be tidier and would say
 * something untrue, that the proof's own shape moved.
 */
ALTER TABLE crm.tenant_tombstone
  ADD COLUMN manifest_version text NOT NULL DEFAULT 'v1'
    CHECK (manifest_version IN ('v1', 'v2'));

-- Existing rows keep `v1` and an empty exclusion list, which is exactly what they were signed
-- over. New ones are written `v2` by the executor.
--
-- NO BACKFILL AND NO RE-SIGNING, deliberately: re-hashing a stored receipt under a new format
-- would produce a receipt that verifies and was never signed by the people it names. That is
-- the forgery this whole subsystem is built to make impossible, and a migration is not an
-- exception to it.
