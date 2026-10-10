-- An approval that nobody acts on gets louder once, not every fifteen minutes.
--
-- WHAT IS BROKEN, and 0063's own closing note argued against the obvious fix:
--
--     NO ESCALATION. One notice per person per proposal, forever. A weekly reminder would
--     need a dedup key carrying a period, which is nagging by construction, and the honest
--     alternative is an age in the queue read on a screen rather than pushed.
--
-- Both halves of that are right and neither is an answer. A proposal somebody made in March
-- is still pending in December, its notice was read and forgotten in March, and nothing in
-- this system says the waiting has become a problem. That is not solved by sending the same
-- sentence again on a cadence — a reminder whose dedup key carries a week number is a reminder
-- that arrives forever, and the thing it trains a reader to do is ignore the kind.
--
-- ESCALATION IS A STATE CHANGE, NOT A CADENCE, and this schema already has the shape. 0020's
-- disposal obligation has a `due_by` stamped at discovery and a SECOND notification kind for
-- crossing it: `disposal_obligation_overdue`, at `urgent`, to the rep AND up the hierarchy,
-- exactly once. Nobody is nagged and nobody is left quietly waiting. The same arrangement
-- fits here one-for-one:
--
--   * `decide_by`, stamped when the proposal is made, so the deadline is DATA;
--   * `config_change_approval_overdue`, a second kind at `urgent`, raised once;
--   * to the people who can decide it AND to the administrators, who are the layer that can
--     do something a decider cannot — appoint another officer, or ask why.
--
-- The dedup key still carries no period. `…:awaiting` once, `…:overdue` once: two states, two
-- notices, per person, ever.
--
-- STAMPED AND THEN FROZEN, which is 0020's argument and not a new one. That migration copies
-- the grace period onto each obligation at discovery so "a changed policy never rewrites a
-- deadline that has already been communicated". Here the default lives on the column, so a
-- later deployment shortening it moves no deadline anybody was already given — and
-- `config_proposal_decided_once` is extended to cover `decide_by`, because a deadline that can
-- be moved after it was set is not a deadline.
--
-- The cost of freezing it is worth stating: there is no extension. An administrator who is
-- legitimately waiting on Finance cannot buy another week, and the exit is to reject the
-- proposal with a reason and propose it again — which resets the clock and leaves both the
-- refusal and the new request in the record. That is the same answer this lineage gives
-- everywhere else ("a mistake is corrected by changing the policy back, with a reason") and it
-- is better than a mutable deadline whose history is a column that used to say something else.
--
-- SEVEN DAYS, and the number is an argument rather than a default. What is waiting is one
-- colleague's decision on a change another colleague asked for, so the unit is working days
-- rather than hours: a day is too short (an officer on leave on Tuesday would make every
-- request overdue by Wednesday), and a month is long enough that the person who asked has
-- stopped expecting an answer. A week crosses one weekend and one working week, which is the
-- interval after which "I will look at it" has stopped being true.
--
-- NOT PER RULE, deliberately, and this is the one place the shape is deliberately coarser than
-- the rule it serves. `crm.four_eyes_rule` could carry a `decide_within` and arming the
-- unattended write-off could have a shorter fuse than a ledger re-pointing — but a proposal
-- may span columns, so two rules would need a `min()`, a test for the mixed case, and a
-- decision about what a proposal matching no rule's deadline means. Nothing today wants two
-- numbers. When something does, it is a column on that table rather than a redesign of this
-- one, and the deadline being DATA on the proposal is what makes that cheap.
--
-- NOTHING EXPIRES, which 0062 recorded as open and this does not change. "A TTL needs a
-- decision about what expiry MEANS — rejected by the system is not a refusal anybody made" is
-- still the objection, and it is still unanswered. What this migration does is take most of
-- the value of an expiry without inventing a refusal: the deadline exists, crossing it is
-- loud, and the proposal stays decidable by the two people whose job it is.

-- ---------------------------------------------------------------------------
-- 1. The deadline, as data.
-- ---------------------------------------------------------------------------
-- `clock_timestamp()` rather than `now()`, for 0059's reason restated: `now()` is the
-- transaction clock, so two proposals made in one transaction would share a deadline to the
-- microsecond. It matters less for a date seven days out than it does for an ordering, and
-- the two columns should not disagree about which clock a proposal was made on.
--
-- NOT NULL with a default, so every proposal has one and no caller supplies it: a deadline the
-- asker chose would be a deadline the asker could set to a century.
ALTER TABLE crm.config_proposal
  ADD COLUMN decide_by timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days');

-- The overdue read: pending proposals past their deadline, newest first. Partial, because the
-- sweep only ever asks about undecided rows and a decided proposal has no deadline left to
-- cross.
CREATE INDEX idx_config_proposal_due
  ON crm.config_proposal (tenant_id, decide_by) WHERE decision IS NULL;

COMMENT ON COLUMN crm.config_proposal.decide_by IS
  'When this stops being merely pending and starts being overdue (0064). Stamped from the column default when the proposal is made and frozen afterwards, for 0020''s reason: a deployment that shortens the window must not move a deadline somebody was already given. Nothing expires at it — crossing it raises config_change_approval_overdue once, to the deciders and to the administrators.';

/**
 * The deadline is the DATABASE's, in both directions.
 *
 * The column default covers every code path — `proposeConfigChange` does not mention
 * `decide_by` and the route calls the store — so this trigger exists for the path this whole
 * lineage exists for: somebody with the application password at a psql prompt. An INSERT
 * naming `decide_by` a century out is not a four-eyes bypass, but it silently disables the
 * escalation, which is the same idea wearing a quieter coat.
 *
 * OVERWRITES RATHER THAN REFUSES, which is 0059's choice for the `from` columns of a policy
 * change and is made here for the same reason: "the caller does not get to say what the policy
 * used to be". A refusal would make every raw-SQL insert that merely omitted the column into a
 * noisy failure for no gain, and the honest statement is that this value is not the writer's
 * to supply. A fixture that genuinely needs a past deadline — the live gate simulating a week
 * passing — turns this trigger off explicitly and says so, which is what a fixture undoing a
 * guarantee should look like.
 *
 * The window lives here, as a literal, and in the column default, as a literal. Two copies of
 * seven days, which is one more than this repository likes: a contract test inserts a bare
 * proposal and asserts the two agree, so a change to one without the other is immediately red
 * rather than a deadline that depends on which path wrote the row.
 */
CREATE OR REPLACE FUNCTION crm.config_proposal_stamp_deadline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.decide_by := clock_timestamp() + interval '7 days';
  RETURN NEW;
END
$$;

CREATE TRIGGER config_proposal_stamp_deadline
  BEFORE INSERT ON crm.config_proposal
  FOR EACH ROW EXECUTE FUNCTION crm.config_proposal_stamp_deadline();

/**
 * 0062's freeze, now covering the deadline.
 *
 * Replaced whole rather than patched, because `CREATE OR REPLACE FUNCTION` is how this schema
 * changes a trigger body and a reader needs the version the database is running to be the
 * version they can read. The only change is `decide_by` joining the frozen tuple.
 */
CREATE OR REPLACE FUNCTION crm.config_proposal_decided_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.tenant_id, OLD.table_name, OLD.row_key, OLD.changes, OLD.four_eyes_columns,
      OLD.role, OLD.proposed_by, OLD.proposed_at, OLD.proposed_reason, OLD.decide_by)
     IS DISTINCT FROM
     (NEW.tenant_id, NEW.table_name, NEW.row_key, NEW.changes, NEW.four_eyes_columns,
      NEW.role, NEW.proposed_by, NEW.proposed_at, NEW.proposed_reason, NEW.decide_by) THEN
    RAISE EXCEPTION
      'config-proposal-frozen: what proposal % asked for, and when it is due, cannot be changed after it was made. Withdraw it and propose the new change.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decision IS NOT NULL
     AND (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.decided_reason)
         IS DISTINCT FROM (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.decided_reason) THEN
    RAISE EXCEPTION
      'config-proposal-decided: proposal % was already % by somebody; a decision cannot be retaken.',
      OLD.id, OLD.decision
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION
      'config-proposal-spent: proposal % has already been applied, and an approval is good for one change.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The second kind.
-- ---------------------------------------------------------------------------
-- 0049's closed list, extended, and TAKEN FROM THE LIVE FUNCTION rather than from the
-- migration that created it — which is the mistake 0062 made with
-- `crm.notification_subject_open` and `subject-coverage.contract.test.ts` caught on the first
-- run. There is no way to extend a function several migrations have touched except to write it
-- whole, so the whole of it is here, read out of the catalog.
--
-- A SECOND KIND RATHER THAN A SECOND SEVERITY ON THE FIRST, and 0063 argued the other way for
-- its two audiences ("one fact with two audiences rather than two facts"). The difference is
-- real: `awaiting` and `overdue` are two FACTS about one proposal, and an operator routing
-- kinds to a webhook wants to send the second somewhere louder than the first. That is exactly
-- the distinction 0020 drew between `disposal_obligation_raised` and
-- `disposal_obligation_overdue`, which are also one subject and two kinds.
CREATE OR REPLACE FUNCTION crm.notification_kinds()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['disposal_obligation_raised',
               'disposal_obligation_overdue',
               'call_plan_submitted',
               'call_plan_approved',
               'call_plan_returned',
               'sample_transfer_awaiting_acceptance',
               'sample_transfer_recalled',
               'erp_write_failed',
               'expense_post_blocked',
               'config_change_awaiting_approval',
               'config_change_approval_overdue'];
$$;

-- `crm.notification_subject_open` needs no change, and that is worth saying rather than
-- leaving to inference: its `crm.config_proposal` branch is "undecided", and an OVERDUE
-- proposal is still undecided — so a notice about one outlives its retention horizon for
-- exactly as long as the thing it is about is unresolved, which is what that function is for.
