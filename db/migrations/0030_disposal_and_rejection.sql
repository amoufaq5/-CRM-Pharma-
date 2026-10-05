-- 0030_disposal_and_rejection.sql
--
-- Two regulatory facts the schema could not hold: a disposal deadline that survived
-- the material leaving custody and coming back, and the identity of whoever rejected
-- an expense claim.
--
-- ===========================================================================
-- PART 1 — A RECALL COULD RESET A REGULATED DISPOSAL DEADLINE
-- ===========================================================================
--
-- WHAT WAS BROKEN. 0020's sweep keys a disposal deadline to DISCOVERY: `due_by =
-- discovered_on + grace_days`, one live obligation per (rep, lot). When a rep's
-- expired holding reaches zero the sweep resolves the obligation and attributes it
-- from the ledger — and `transfer_out` is one of the attributions it accepts
-- (`transferred`). So: send the expired carton to a colleague, the obligation
-- resolves; get it back, and the next sweep finds an expired holding with no live
-- obligation and raises a NEW one, discovered today, due today + 30. The deadline in
-- an SOP about destroying expired drug samples was resettable at will. Two reps could
-- already do it by bouncing a transfer; 0025's recall made it UNILATERAL, because the
-- sender can take a transfer back without the receiver ever touching it.
--
-- WHY NOT KEY THE DEADLINE TO THE LOT'S EXPIRY. It removes the class of bug outright
-- and it is the wrong trade. `due_by = expired_on + grace_days` is a deadline computed
-- from a date in the past, so a lot discovered late is born already overdue — and
-- 0020 asserts the opposite in a constraint it chose deliberately
-- (`disposal_due_after_discovery CHECK (due_by >= discovered_on)`), which would have
-- to be dropped. Worse, it would re-price every obligation already communicated to a
-- rep, which is the exact thing 0020 copies `grace_days` onto each row to prevent. A
-- commitment a person was never told about on a day before they were told it is not a
-- commitment.
--
-- WHY NOT RE-OPEN THE RESOLVED ROW. It keeps the dates, but it has to decide what
-- becomes of `resolved_on`, `resolution` and `resolving_transaction_id` —
-- `disposal_resolved_pair` ties them to `status = 'resolved'`. Nulling them erases an
-- attributed ledger fact (this material left this rep's custody on this date by this
-- transaction), which is true and stays true; keeping them beside `status = 'open'`
-- means dropping that CHECK and leaving a row that reads "open, resolved on 15 Apr as
-- transferred" — a contradiction no query can interpret. Neither is acceptable in a
-- subsystem whose whole premise (0020's header, README rule 14) is that a record is
-- never un-written.
--
-- THE RULE. A returning holding gets a CONTINUATION, not a new obligation: a new row
-- that INHERITS `discovered_on` and `due_by` from the (rep, lot)'s earlier
-- obligations, and names the row it continues in `continues_obligation_id`. The
-- resolved row stays exactly as it was. So the deadline is carried, not recomputed,
-- and the chain reads as what happened — discovered 10 Apr, due 10 May, resolved 15
-- Apr as `transferred` by transaction X; continued, still due 10 May, open.
--
-- Inherited verbatim rather than `LEAST(carried, today + grace)`: taking the earlier
-- of the two would let a SHORTENED policy pull in a deadline already given, which is
-- the same injustice from the other direction. One rule, stated once — a continuation
-- keeps the deadline it had.
--
-- Carried from `min()` over every prior obligation on that (rep, lot) rather than from
-- the latest, so a chain cannot drift one hop at a time, and so the answer is the
-- earliest date this rep was ever told about this lot even if a row was written by
-- hand. (`min(due_by)` cannot fall below `min(discovered_on)`: the row holding the
-- minimum due date already satisfies `due_by >= discovered_on`, and every other row's
-- discovery is no later than its own.)
--
-- Carried regardless of how the earlier obligation was resolved, not only from
-- `transferred`. For an EXPIRED lot there is no way for genuinely new material to
-- enter a rep's custody at all — 0020's trigger refuses a `receipt` of an expired lot
-- — so every increase in an expired holding is material that was already in the
-- system: a `transfer_in`, a `transfer_recall`, or an `adjustment_in` correcting a
-- miscount. All three are the same thing for this purpose, and treating them alike is
-- the fail-closed reading.
--
-- CONSEQUENCE WORTH KNOWING. A continuation whose carried deadline is already past is
-- inserted `open` and marked `overdue` by step 4 of the same sweep, which escalates it
-- to the rep and their supervisor — so taking back material you had let run late tells
-- your manager, immediately, rather than buying another grace period.
--
-- WHAT THIS DOES NOT CLOSE. The deadline is carried per (rep, lot), so a GENUINE
-- hand-over to a rep who has never held the lot still starts that rep's own grace
-- period. That is deliberate: the receiving rep was never given a deadline, and
-- holding them to one they never saw is the injustice described above. It does leave
-- the material's effective deadline movable by a cooperating pair, which is the
-- bilateral half of the ADR's finding; closing it means deciding that an obligation
-- attaches to material rather than to a person, which is a change to what the table
-- means and not a fix to this bug.

ALTER TABLE crm.disposal_obligation
  ADD COLUMN continues_obligation_id uuid
    REFERENCES crm.disposal_obligation (id) ON DELETE RESTRICT;

-- A row continuing itself would be a cycle of length one, and `discovered_on` carried
-- from itself says nothing. Cheap to forbid, and the only shape of the column that is
-- meaningless rather than merely unusual.
ALTER TABLE crm.disposal_obligation
  ADD CONSTRAINT disposal_continuation_not_self
    CHECK (continues_obligation_id IS NULL OR continues_obligation_id <> id);

-- The carry-forward lookup and the audit chain below both ask for one (rep, lot)'s
-- whole history. `idx_disposal_obligation_rep` is on (tenant, rep, status) and cannot
-- serve it. The FK above also wants an index of its own, or every RESTRICT check
-- becomes a scan.
CREATE INDEX idx_disposal_obligation_lot
  ON crm.disposal_obligation (tenant_id, rep_profile_id, lot_id);
CREATE INDEX idx_disposal_obligation_continues
  ON crm.disposal_obligation (continues_obligation_id)
  WHERE continues_obligation_id IS NOT NULL;

/**
 * The deadline a returning holding inherits, and the row it continues.
 *
 * In SQL rather than in the sweep because it is the definition of "the deadline this
 * rep already has for this lot", and the sweep's INSERT is not the only thing that will
 * ever need to ask. Returns one row always — the aggregates are null when this (rep,
 * lot) has no history, which is the caller's signal to compute a fresh deadline.
 *
 * Only resolved rows are considered. A live one cannot be continued: it has not ended,
 * and `uq_disposal_obligation_live` admits exactly one, so the sweep's ON CONFLICT is
 * what handles that case.
 *
 * The row to continue is the chain's TAIL — the one resolved obligation nothing else
 * continues — and NOT the most recently created, because `created_at` defaults to
 * `now()`, which is the TRANSACTION's clock: two obligations written by one catch-up run
 * carry the same timestamp and "latest" stops having an answer. A linked list has exactly
 * one tail, so the scalar subquery below is total; if it ever matched two rows Postgres
 * would refuse the statement, which for a corrupted chain is the right outcome and the
 * reason it is phrased as a scalar rather than a LIMIT 1.
 */
CREATE OR REPLACE FUNCTION crm.disposal_carry_forward(
  p_rep_profile_id uuid,
  p_lot_id         uuid
)
RETURNS TABLE (continues_obligation_id uuid, discovered_on date, due_by date)
LANGUAGE sql STABLE AS $$
  SELECT (SELECT tail.id
            FROM crm.disposal_obligation tail
           WHERE tail.rep_profile_id = p_rep_profile_id
             AND tail.lot_id = p_lot_id
             AND tail.status = 'resolved'
             AND NOT EXISTS (
                   SELECT 1 FROM crm.disposal_obligation successor
                    WHERE successor.continues_obligation_id = tail.id)),
         min(o.discovered_on),
         min(o.due_by)
    FROM crm.disposal_obligation o
   WHERE o.rep_profile_id = p_rep_profile_id
     AND o.lot_id = p_lot_id
     AND o.status = 'resolved';
$$;

/**
 * One (rep, lot)'s disposal history, oldest first — the read an audit asks for.
 *
 * The point of carrying a deadline forward instead of re-opening a row is that the
 * history stays legible, and this is where that is cashed in: each obligation with its
 * own resolution, the KIND of movement that discharged it, and the row it continues.
 * An auditor reading it sees that the stock was transferred away on the 15th and came
 * back, rather than one obligation whose provenance is unexplained.
 *
 * Ordered by walking `continues_obligation_id` forward from the root, not by `created_at`
 * — which is the transaction clock, so a catch-up run that resolved and continued in one
 * transaction stamps both rows identically and no timestamp ordering can tell them apart.
 * The chain itself is the only thing that knows which came first, and `sequence_number` is
 * the walk's depth. The 10000 bound exists so a hand-edited cycle fails as a short
 * answer rather than as a query that never returns; a row reachable from no root (also
 * only possible by hand) gets sequence 0 and sorts last, visibly rather than silently.
 *
 * `crm.open_disposal_obligations` is left alone: it answers "what must this rep clear",
 * which is a different question and has callers that select its columns by name.
 */
CREATE OR REPLACE FUNCTION crm.disposal_obligation_chain(
  p_rep_profile_id uuid,
  p_lot_id         uuid
)
RETURNS TABLE (
  id                         uuid,
  sequence_number            integer,
  continues_obligation_id    uuid,
  quantity_at_discovery      numeric,
  expired_on                 date,
  discovered_on              date,
  due_by                     date,
  status                     text,
  resolved_on                date,
  resolution                 text,
  resolving_transaction_id   uuid,
  resolving_transaction_kind text,
  created_at                 timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk AS (
    SELECT r.id, 1 AS depth
      FROM crm.disposal_obligation r
     WHERE r.rep_profile_id = p_rep_profile_id
       AND r.lot_id = p_lot_id
       AND r.continues_obligation_id IS NULL
    UNION ALL
    SELECT n.id, w.depth + 1
      FROM crm.disposal_obligation n
      JOIN walk w ON n.continues_obligation_id = w.id
     WHERE n.rep_profile_id = p_rep_profile_id
       AND n.lot_id = p_lot_id
       AND w.depth < 10000
  )
  SELECT o.id,
         COALESCE(w.depth, 0)::integer,
         o.continues_obligation_id,
         o.quantity_at_discovery,
         o.expired_on, o.discovered_on, o.due_by,
         o.status, o.resolved_on, o.resolution,
         o.resolving_transaction_id,
         -- The ledger's own word for what discharged it. `resolution` is 0020's
         -- vocabulary ('transferred'); this is the movement kind ('transfer_out'), which
         -- is what the custody log shows and therefore what an auditor is matching
         -- against.
         t.kind::text,
         o.created_at
    FROM crm.disposal_obligation o
    LEFT JOIN walk w ON w.id = o.id
    LEFT JOIN crm.sample_transaction t ON t.id = o.resolving_transaction_id
   WHERE o.rep_profile_id = p_rep_profile_id
     AND o.lot_id = p_lot_id
   ORDER BY (w.depth IS NULL), w.depth, o.created_at, o.id;
$$;

-- ===========================================================================
-- PART 2 — WHO REJECTED AN EXPENSE CLAIM WAS NOT RECORDED
-- ===========================================================================
--
-- WHAT WAS BROKEN. 0006 gave `crm.expense_claim` an `approved_by`/`approved_at` pair
-- and nothing for the other outcome, so a rejection recorded a state and no actor. In
-- a claim lifecycle where four-eyes is enforced here or nowhere (ADR-0001 item 11:
-- the ERP's own Expense workflow is a flat role check that never reads
-- `Employee.manager_id`), "a manager rejected this" with no manager named is not a
-- record of a decision.
--
-- Overloading `approved_by` was considered and refused: a rejecter stored in a column
-- called `approved_by` reads as an approval to every query that does not know better,
-- `expense_claim_four_eyes`'s own wording included. Two columns, then.
--
-- THE RULE. `rejected_at` is paired to the `rejected` state exactly as `approved_at` is
-- paired to approved/posted/reimbursed, and the rejecter is held to four eyes exactly
-- as the approver is. The two pairings cannot contradict each other: `state` is one
-- value, the state sets are disjoint, so at most one of the two timestamps is ever
-- non-null — a rejected claim has `approved_at IS NULL` because
-- `expense_claim_approved_fields` already says so, and now `rejected_at IS NOT NULL`
-- because this one does.
--
-- `rejected_by` is deliberately NOT tied to the state. It is nullable in the
-- `rejected` state for one reason only: the rows that already exist. A claim rejected
-- before this migration has an actor nobody wrote down, and a constraint demanding one
-- would either fail the migration or invite a fabricated value. The timestamp is
-- recoverable and the identity is not, so the backfill below reconstructs one and
-- leaves the other honestly null. Every rejection written from now on carries both:
-- `rejectClaim` takes the actor, and its route already holds the principal and already
-- requires supervision.

ALTER TABLE crm.expense_claim
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejected_by uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT;

-- `rejected` is terminal and reachable only from `submitted` (0006's state CHECK,
-- mirrored by EXPENSE_CLAIM_TRANSITIONS), so nothing moves a rejected claim afterwards
-- and `updated_at` IS the moment it was rejected. A reconstruction, not a record —
-- which is why `rejected_by` is left null rather than guessed at from the territory
-- hierarchy as it stands today.
UPDATE crm.expense_claim
   SET rejected_at = COALESCE(updated_at, created_at)
 WHERE state = 'rejected' AND rejected_at IS NULL;

ALTER TABLE crm.expense_claim
  ADD CONSTRAINT expense_claim_rejected_fields
    CHECK ((state = 'rejected') = (rejected_at IS NOT NULL));

-- The same separation of duties as `expense_claim_four_eyes`, phrased the same way, so
-- the two read as one rule about actors rather than two about columns. A claimant who
-- can reject their own claim has four eyes on the outcome they want and two on the one
-- they do not.
ALTER TABLE crm.expense_claim
  ADD CONSTRAINT expense_claim_reject_four_eyes
    CHECK (rejected_by IS NULL OR rejected_by <> rep_profile_id);

-- Who has been rejecting what, over a period. `idx_expense_claim_state` is on
-- (tenant, state, incurred_on) and answers "which claims are rejected"; this answers
-- "which did this manager reject", which is the question a review of a supervisor's
-- decisions asks.
CREATE INDEX idx_expense_claim_rejected_by
  ON crm.expense_claim (tenant_id, rejected_by, rejected_at)
  WHERE rejected_by IS NOT NULL;
