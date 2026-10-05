-- 0039_prune_floor_repair.sql
--
-- MIGRATION 0032 COULD NOT BE APPLIED TO THE DATABASE IT EXISTED TO REPAIR.
--
-- 0032 capped `prune_guard_floor_rows` at 1000, because that column is the left operand of
-- the prune guard's AND and therefore short-circuits the share ceiling entirely — an
-- uncapped floor is a permanent, unattributed, non-expiring bypass. It opened with what it
-- called a clamp:
--
--     UPDATE crm.notification_policy SET prune_guard_floor_rows = 1000, updated_at = now()
--      WHERE prune_guard_floor_rows > 1000;
--
-- That is plain DML on an RLS-FORCEd table, run as `crm_app` with no
-- `app.current_tenant_id` set, so the policy matches nothing and it is `UPDATE 0`. **The
-- validated CHECK that follows then sees the rows and refuses**, because a CHECK's
-- validation scan is NOT an ordinary query. 0027 had already documented this trap for its
-- own backfill, and lifted FORCE for the duration; 0032 was written five migrations later
-- and did not.
--
-- NOTE THE ASYMMETRY, because it is worth carrying both ways round. 0035 found that a new
-- FOREIGN KEY's bulk validation IS an ordinary query, so it validated against zero visible
-- rows and marked itself `convalidated = true` over a table holding a violation. A CHECK
-- does the opposite: it sees everything. So the same migration shape is blind in one case
-- and sighted in the other, and 0032 managed to be caught by the sighted one while its own
-- repair was blinded by the other.
--
-- WHAT THAT COST, in two shapes depending on how the file was applied:
--
--   - Through the migration runner, which wraps each file in one transaction: 0032 aborts,
--     the deploy halts, and 0033 onward never run. The error is "violated by some row" in a
--     file whose text says existing rows are clamped rather than the migration failing.
--
--   - Through `psql` without `-1`, which is how `scripts/setup-test-db.sh` applies every
--     migration: the DROP CONSTRAINT commits and the ADD fails, leaving **no floor
--     constraint at all**. The old 1,000,000 ceiling is gone and the new 1000 one was never
--     added, and `setNotificationPruneGuard` deliberately does not re-check the range in
--     TypeScript — so the bypass 0032 was written to close reopens with no bound whatsoever.
--
-- No test could catch it. Every test database is built from empty, so none ever holds an
-- out-of-range row, and the suite exercises the one path on which 0032 is correct.
--
-- 0032'S TEXT CANNOT BE CORRECTED. It is recorded in `crm._migrations` with its hash on
-- every database that has applied it, and the runner refuses an edited applied file by
-- design. So this migration does the repair instead, and is written to be correct on all
-- three states a database can be in:
--
--   1. 0032 never reached (the deploy halted) — the constraint is whatever 0031 left, the
--      row still holds its out-of-range value. Clamped and re-constrained here.
--   2. 0032 half-applied via psql — no constraint at all, row still out of range. Same.
--   3. 0032 applied cleanly (every database built from empty) — row in range, constraint
--      already correct. This file is then a no-op that re-asserts what is already true.
--
-- WHY `DROP CONSTRAINT IF EXISTS` AND NOT A CONDITIONAL ADD. The constraint may be absent
-- (state 2), present with the old 1000000 bound (state 1), or present with the new one
-- (state 3), and only the last is acceptable. Dropping unconditionally and adding exactly
-- one definition makes all three converge without the file having to ask which it is in —
-- and because this runs inside the runner's transaction, there is no committed instant in
-- which the table is unconstrained.

-- ---------------------------------------------------------------------------
-- 1. Let the clamp see the table.
-- ---------------------------------------------------------------------------
-- A repair has to see every row by definition, so FORCE is lifted and restored below —
-- 0027's pattern, for 0027's reason, which 0032 should have followed. Under the runner the
-- lifted state is never committed, because the whole file is one transaction. Through
-- `psql` in autocommit it briefly is, which is acceptable for the same reason 0027 gives:
-- that path builds a database from nothing with no application connected to it.
ALTER TABLE crm.notification_policy NO FORCE ROW LEVEL SECURITY;

UPDATE crm.notification_policy
   SET prune_guard_floor_rows = 1000, updated_at = now()
 WHERE prune_guard_floor_rows > 1000;

ALTER TABLE crm.notification_policy FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. One definition of the bound, whatever the database arrived with.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_policy
  DROP CONSTRAINT IF EXISTS notification_policy_prune_guard_floor;
ALTER TABLE crm.notification_policy
  ADD CONSTRAINT notification_policy_prune_guard_floor
    CHECK (prune_guard_floor_rows BETWEEN 0 AND 1000);
