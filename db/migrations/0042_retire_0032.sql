-- @supersedes: 0032_prune_floor_cap.sql
--
-- Retires a migration that cannot be applied to the database it exists to repair.
--
-- `0032_prune_floor_cap.sql` is defective in a way the hash ledger cannot survive. Its
-- first statement clamps `crm.notification_policy.prune_guard_floor_rows` to 1,000; it is
-- DML on an RLS-FORCEd table, run as `crm_app` with no tenant context, so it affects ZERO
-- rows. The validated CHECK two statements later is NOT blind — a CHECK's validation scan
-- sees every row, which is the asymmetry this schema learned the hard way and records in
-- ADR-0001 — so it finds the million-row floor the clamp did not lower, and refuses.
--
-- 0039 is the repair and, until now, could never run. `applyMigrations` applies files in
-- order, records each only on success, and throws on the first failure, so a database
-- halted on 0032 retries 0032 on every deploy and 0033–0041 are unreachable forever. The
-- repair being correct is no help if nothing can reach it: that is the same defect class as
-- 0032 itself, one level up, and it was found by an adversarial review of 0039 rather than
-- by anything failing.
--
-- WHY THE DECLARATION IS HERE AND NOT IN 0039. 0039 is applied and therefore hash-frozen:
-- adding a line to it would make every database that already ran it refuse the next deploy
-- with `MigrationChangedError`, which is precisely the rule this repository enforces ("write
-- a new migration instead of editing an applied one"). The runner computes the retired set
-- over every loaded file before it starts applying, so a declaration in a later file reaches
-- back far enough.
--
-- WHAT 0032 CONTAINED BESIDES THE DEFECT, and why this file is not empty. Retiring 0032
-- drops two function definitions with it, and `packages/notify/src/retention.ts` calls both
-- by name. They are reproduced below VERBATIM from 0032 — not rewritten — because the point
-- of retiring that file is to lose its clamp, not its functions. `CREATE OR REPLACE` makes
-- both statements correct in all three states a database can be in: 0032 never reached,
-- 0032 half-applied through psql in autocommit, or 0032 applied cleanly before the data
-- grew past the clamp.
--
-- The floor itself is 0039's business and stays there. 0039 lifts FORCE around its clamp
-- (0027's pattern), restores it, then does `DROP CONSTRAINT IF EXISTS` and one `ADD`, so all
-- three states converge on a floor capped at 1,000 — and 0039 now actually runs.

/**
 * Is this pass over the tenant's share ceiling?
 *
 * Integer arithmetic, for the reason 0026 gives: `p_prunable * 100 > p_max_share *
 * p_inbox_total` is exact, needs no guard against an empty inbox, and cannot trip at a
 * boundary the reported percentage rounds the other way.
 */
CREATE OR REPLACE FUNCTION crm.notification_prune_ceiling_exceeded(
  p_prunable    bigint,
  p_inbox_total bigint,
  p_max_share   integer
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_prunable * 100 > p_max_share::bigint * p_inbox_total;
$$;

/**
 * Does this prune take too much of the inbox to run unattended?
 *
 * Unchanged in behaviour and now defined in one place each: the ceiling above, the floor
 * here. Replacing the body rather than adding a second function, so there is no way for
 * the two to answer differently.
 */
CREATE OR REPLACE FUNCTION crm.notification_prune_guard_trips(
  p_prunable    bigint,
  p_inbox_total bigint,
  p_max_share   integer,
  p_floor_rows  integer
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_prunable > p_floor_rows
     AND crm.notification_prune_ceiling_exceeded(p_prunable, p_inbox_total, p_max_share);
$$;
