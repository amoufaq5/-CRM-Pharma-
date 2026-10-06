-- Freezes WHAT a claim says, once it has left draft.
--
-- 0044 closed the lifecycle: a claim is born `draft`, moves only along a declared edge, and
-- a decision once recorded is not rewritten. It deliberately did not close this, and named
-- it as owed — because it is a different rule, about columns rather than transitions.
--
-- THE HOLE. `crm_category`, `amount`, `currency`, `incurred_on` and the snapshotted account
-- codes could all be rewritten on an `approved` or `posted` claim with no state change and
-- no constraint objecting. So a claim approved for 120.50 could be edited to 1,205.00 and
-- posted, and the approval would still be on the row, with its approver and its timestamp,
-- attesting to a number nobody ever saw. `rep_profile_id` was writable too, so an approved
-- claim could be re-pointed at a different rep — which is the same defect 0016 closed for an
-- approved call plan, in its own words: "a plan that can be re-pointed at a different rep
-- after approval is not an approved plan."
--
-- THE RULE. Once `OLD.state <> 'draft'`, none of the columns in
-- `crm.expense_claim_frozen_columns()` may change. Keyed on the state the row was ALREADY
-- in, which is what makes the one legitimate writer legal: `submitClaim` stamps the account
-- codes in the SAME statement as `draft -> submitted`, so `OLD.state` is still `draft` when
-- the trigger looks. A write-once rule would have refused exactly that — and `cost_center`
-- is legitimately null, so write-once would also have left it settable forever, which is the
-- opposite of the guarantee. Frozen-after-draft is the shape that fits the data.
--
-- WHY A SECOND FUNCTION AND NOT AN ARM IN 0044's. Two reasons, and the first is mechanical:
-- `CREATE OR REPLACE FUNCTION` replaces a whole body, so amending 0044's would mean
-- reproducing it here verbatim — the discipline that 0041 broke, reverting 0038's guard,
-- caught only by 0038's own test. The second is that these are different questions. 0044
-- answers "may this row move?"; this answers "may this row still say that?". They fire on
-- the same event and are read by different people.
--
-- The trigger NAME is load-bearing, as 0040's is. Postgres fires same-event triggers
-- alphabetically, and `expense_claim_check_lifecycle` sorts before
-- `expense_claim_freeze_substance`, so an illegal transition is still reported as an illegal
-- transition rather than as a frozen column — the better-aimed sentence wins, which is the
-- rule 0034 set for its own refusals. A test pins the order.
--
-- WHAT IS DELIBERATELY NOT FROZEN.
--
--   * The eight columns in `crm.expense_claim_sealed_columns()` — the decision record. 0044
--     already holds those, write-once, and a second opinion about one fact is how two
--     constraints come to disagree. A test asserts the two lists are DISJOINT.
--   * `updated_at`, obviously, and `state` itself, which is 0044's.
--   * `tenant_id` and `id`. Re-pointing `tenant_id` is refused by the row-security policy's
--     `WITH CHECK` before this trigger's opinion would matter, and `id` is the primary key a
--     composite reference already pins. Naming them here would be a guard that reads as
--     load-bearing and is not.
--
-- `description` IS frozen, and that is a judgement worth stating: it is free text, nothing
-- writes it after insert, and it is part of what an approver read. If annotating an approved
-- claim is ever wanted, the answer is an append-only note beside the row — the shape 0030
-- used for a disposal reason — and not rewriting the field the approval was given against.
--
-- NO PRE-FLIGHT, and the reasoning is 0040's. This governs an ACT, not a resting state: every
-- existing row is legal whatever it says, because the rule is about changing a value and no
-- row is mid-change. There is nothing to scan — and a validated CHECK's scan IS sighted under
-- FORCE row-level security (0039's asymmetry), so phrasing it as a CHECK would refuse a
-- database that is exactly correct.

/**
 * The columns that say WHAT a claim is, published so a reader and a test can ask.
 *
 * In the database rather than only in TypeScript for the reason 0044's two maps are: a
 * `CASE` inside a plpgsql body cannot be queried, so the only thing that could claim the
 * frozen set and the sealed set are disjoint would be a comment.
 */
CREATE OR REPLACE FUNCTION crm.expense_claim_frozen_columns()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['rep_profile_id', 'crm_category', 'amount', 'currency', 'incurred_on',
               'description', 'receipt_url', 'erp_ledger_account_code',
               'erp_cost_center_code'];
$$;

CREATE OR REPLACE FUNCTION crm.expense_claim_freeze_substance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col        text;
  after_row  jsonb;
  prior_row  jsonb;
BEGIN
  -- A draft is a draft: everything about it is still being decided, including by the rep who
  -- filed it. The freeze begins at the first transition out.
  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  after_row := to_jsonb(NEW);
  prior_row := to_jsonb(OLD);

  FOREACH col IN ARRAY crm.expense_claim_frozen_columns() LOOP
    IF (after_row ->> col) IS DISTINCT FROM (prior_row ->> col) THEN
      RAISE EXCEPTION
        'expense-claim-substance: expense claim % is %, so % is fixed at % and cannot become % — a decision was recorded against the claim as it reads now, and editing what it says would leave that decision attesting to something nobody saw. Reverse it with a new claim.',
        OLD.id, OLD.state, col,
        COALESCE(prior_row ->> col, 'null'), COALESCE(after_row ->> col, 'null')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

-- `CREATE OR REPLACE TRIGGER` rather than drop-then-create, for 0040's reason:
-- `scripts/setup-test-db.sh` applies through psql without `-1`, so a drop that commits on its
-- own leaves an instant with no guard, inside the file whose whole purpose is that there
-- always is one.
CREATE OR REPLACE TRIGGER expense_claim_freeze_substance
  BEFORE UPDATE ON crm.expense_claim
  FOR EACH ROW EXECUTE FUNCTION crm.expense_claim_freeze_substance();
