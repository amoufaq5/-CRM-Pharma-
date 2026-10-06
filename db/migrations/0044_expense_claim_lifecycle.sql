-- 0044_expense_claim_lifecycle.sql
--
-- The expense claim lifecycle was not in the database at all.
--
-- WHAT WAS BROKEN. `crm.expense_claim` carries a six-value `state` CHECK and four CHECK
-- constraints about what each state must look like AT REST, and nothing whatsoever about
-- how a claim may MOVE. The whole state machine lived in `packages/expense/src/states.ts`
-- — `EXPENSE_CLAIM_TRANSITIONS`, `canTransitionExpenseClaim`,
-- `assertExpenseClaimTransition` — and every store function asks it before issuing a
-- guarded UPDATE. That is a correct implementation and it is the only one, so a writer
-- that is not `packages/expense` was free to do all of this:
--
--     UPDATE crm.expense_claim SET state = 'draft', approved_at = NULL,
--            approved_by = NULL, posted_at = NULL, erp_expense_id = NULL
--      WHERE state = 'reimbursed';            -- a paid claim back to a draft
--
--     UPDATE crm.expense_claim SET state = 'approved', approved_at = now()
--      WHERE state = 'submitted';             -- approved by nobody
--
--     UPDATE crm.expense_claim SET state = 'posted', posted_at = now()
--      WHERE state = 'draft';                 -- never submitted, never approved
--
--     INSERT INTO crm.expense_claim (…, state, approved_at, approved_by)
--     VALUES (…, 'approved', now(), <a colleague>);   -- born approved
--
--     UPDATE crm.expense_claim SET approved_by = NULL WHERE state = 'approved';
--                                            -- the approver erased, state untouched
--
-- Every one of those was accepted by a real cluster before this file. The four CHECKs
-- cannot catch them because each is a statement about a RESTING state and none of them is
-- false of the rows above: `expense_claim_approved_fields` pairs `approved_at` with the
-- three approved-ish states and says nothing about `approved_by`;
-- `expense_claim_rejected_fields` pairs `rejected_at` with `rejected` and 0030
-- DELIBERATELY left `rejected_by` nullable; `expense_claim_snapshot_before_submit` only
-- asks for an account code outside `draft`; and the two four-eyes CHECKs compare an actor
-- to the claimant when an actor is present, which a null actor satisfies vacuously.
--
-- WHY IT MATTERS MORE THAN A MISSING GUARD USUALLY DOES. 0040 put the receipt-timing rule
-- in the database precisely because a route is not where an offline path can be made to
-- honour it — and that trigger decides by reading `crm.expense_claim.state`. Its two tiers
-- ("a first receipt while draft or submitted, a replacement in draft only") are therefore
-- only as strong as the column it trusts, and nothing defended that column: a writer who
-- could set `state = 'draft'` on an approved claim could swap the receipt an approval was
-- given against, which is the exact outcome 0040 exists to prevent, reached one table
-- earlier. 0040's own fixtures hand-wrote all six states to build their cases, which is a
-- fair summary of how open the column was.
--
-- THE RULE, IN ONE SENTENCE. A claim is born `draft`; it changes state only along an edge
-- of `crm.expense_claim_transitions()`; the act of entering a state must supply the
-- columns that state's record of a decision consists of and that no CHECK already pairs;
-- and a decision once recorded is not rewritten.
--
-- ===========================================================================
-- ONE MAP, IN ONE PLACE, AND READABLE FROM OUTSIDE THE TRIGGER
-- ===========================================================================
--
-- The precedent in this repo is `crm.call_plan_check_transition` (0016), which holds the
-- plan lifecycle as a single `CASE OLD.status … THEN ARRAY[…]` inside the trigger function
-- rather than as a pile of `IF` branches, and its doc comment calls it "the plan
-- lifecycle, as a map rather than a pile of conditions". That shape is kept here and it is
-- the right one: one `CASE`, one place, no path through the function that can admit an
-- edge the map does not list.
--
-- It is LIFTED OUT of the trigger body, which is the one departure, and the reason is a
-- test. A `CASE` inside a `plpgsql` function body cannot be queried, so the only thing
-- that could ever claim the SQL map and `EXPENSE_CLAIM_TRANSITIONS` agree is a comment
-- saying so — and this repo has been bitten three times by a fixture kinder than reality
-- (README, "the snapshot refresh"). `crm.expense_claim_transitions()` returns the five
-- edges as rows, so `expense-claim-lifecycle.contract.test.ts` reads them out of the live
-- database and compares the edge SET to the TypeScript map. The same is done for the
-- per-state field requirements and for the sealed columns: each rule is a function
-- returning its own data, so a reader can ask the database what it enforces instead of
-- inferring it from a refusal.
--
-- CAN THE TWO DRIFT? YES, and saying otherwise would be the comment this arrangement
-- exists to avoid. There is no generator between them and nothing at runtime consults
-- both. Neither can be derived from the other, either: a migration is applied before any
-- TypeScript exists on the box and has to be readable on its own, and
-- `canTransitionExpenseClaim` is a pure function called with no connection — deliberately,
-- so `assertExpenseClaimTransition` can refuse with a typed error naming the allowed
-- targets instead of letting a 23514 reach the caller. So this is one rule stated twice,
-- exactly as 0033 states `AttachmentTooLargeError` twice and 0040 states the receipt tiers
-- twice, and the drift is held shut by a test rather than by vigilance: change either side
-- alone and `the SQL map and EXPENSE_CLAIM_TRANSITIONS agree` fails.
--
-- A SEVENTH STATE FAILS CLOSED. `crm.expense_claim_transition_requires()` returns NULL for
-- a state it does not know, and the trigger refuses rather than waving the row through. So
-- widening `expense_claim_state_check` without saying what the new state requires makes
-- that state unreachable, which is noisy and recoverable; the other direction would make it
-- the one state with no rule, which is silent and is the hole this file closes. Note that
-- this is the OPPOSITE direction from `crm.notification_subject_open`, which treats a table
-- it has no branch for as not-open on purpose (0031, README "Inbox retention") — there the
-- failure being prevented is unbounded growth and "keep forever when unsure" would restore
-- it silently. Here the failure being prevented is an ungoverned lifecycle, so unsure means
-- no.
--
-- ===========================================================================
-- WHAT EACH TRANSITION MUST SUPPLY, AND WHAT IS ALREADY SOMEBODY ELSE'S JOB
-- ===========================================================================
--
-- A second opinion about the same fact is how two constraints come to disagree, so the
-- trigger asks for exactly the columns that no existing CHECK pairs with the state, and
-- for nothing else. Read against `\d crm.expense_claim`:
--
--   target        trigger requires                                         already at rest
--   ------------  -------------------------------------------------------  ----------------------------------------
--   submitted     submitted_at                                             erp_ledger_account_code (snapshot CHECK)
--   approved      submitted_at, approved_by                                approved_at (approved_fields), account
--   rejected      submitted_at, rejected_by                                rejected_at (rejected_fields), account
--   posted        submitted_at, approved_by, posted_at, erp_expense_id     approved_at, account
--   reimbursed    submitted_at, approved_by, posted_at, erp_expense_id     approved_at, account
--
-- `approved_at`, `rejected_at` and `erp_ledger_account_code` are therefore NOT re-checked
-- here. `expense_claim_approved_fields` is an equality over the three approved-ish states,
-- so it already demands `approved_at` for `posted` and `reimbursed` too, and
-- `expense_claim_snapshot_before_submit` already demands the account code for every state
-- but `draft`. Restating either would give this table two authorities on one column, and
-- the second is the one that is wrong after the first is edited.
--
-- `submitted_at` is the one moment NO constraint pairs with anything, which is why it is
-- required on all five non-draft targets: every state past `draft` is downstream of a
-- submission, and this is the only column that records it.
--
-- `approved_by` AND `rejected_by` ARE WHERE THIS EARNS ITS KEEP. Nothing made either
-- mandatory. For the rejecter that was a conscious choice and 0030 explains it: rows
-- rejected before 0030 have an actor nobody wrote down, so "a constraint demanding one
-- would either fail the migration or invite a fabricated value", and it closes with "every
-- rejection written from now on carries both". That promise lived in `rejectClaim` and in
-- its route. It is now in the database, and in the only place that can keep it without
-- re-opening the problem 0030 avoided: the requirement bites on the ACT of rejecting, not
-- on a `rejected` row, so a legacy row with a null rejecter stays exactly as honest as
-- 0030 left it and is not refused by anything here. The resting CHECK governs the row; the
-- trigger governs the decision. That is the division, and it is the reason this migration
-- needs no pre-flight (below).
--
-- `posted` REQUIRES `erp_expense_id`, which has a visible consequence in TypeScript.
-- `MissingErpExpenseIdError` guards `reimburseClaim` against a `posted` claim carrying no
-- ERP record id; that row can no longer be produced by a transition, so the guard is
-- demoted to defence in depth against a repair made through the escape hatch below. It
-- stays for the same reason `summariseAttemptHistory().impossibleRevivals` stayed after
-- 0038: it cannot happen on the ordinary path any more and it is still reachable by hand,
-- which is precisely the row an operator should be told about rather than shown as fact.
--
-- `reimbursed` REQUIRES NOTHING OF ITS OWN, and that is a gap in the schema rather than in
-- this file. There is no `reimbursed_at` and no `reimbursed_by` — `reimburseClaim` writes
-- `state` and `updated_at` and nothing else — so the one column it could be paired with
-- does not exist. Requiring the `posted` set is all the schema can see.
--
-- ===========================================================================
-- FOUR EYES: WHERE THE COLUMNS EXIST, AND WHERE PRETENDING WOULD BE WORSE
-- ===========================================================================
--
-- `approve` and `reject` each record an actor and each already has its own four-eyes
-- CHECK (`expense_claim_four_eyes`, `expense_claim_reject_four_eyes`), so this trigger
-- does not restate the comparison — see the duplication argument above. What it DOES do is
-- make those CHECKs non-vacuous: `approved_by IS NULL OR approved_by <> rep_profile_id` is
-- satisfied by a null, so until now a claim could reach `approved` with four-eyes
-- technically upheld and nobody named. Requiring the actor on the transition is what turns
-- that CHECK from a conditional into a rule.
--
-- `post` AND `reimburse` RECORD NO ACTOR AT ALL, and nothing here pretends otherwise.
-- There is no `posted_by` and no `reimbursed_by`, so no constraint and no trigger can
-- compare anything, and `requireExpenseApprover` in the route is the only place that rule
-- can live — which README "Expenses" already states, along with the honest reading that
-- `post`'s route check has been a formality since 0031 gave the `expense_post` sweep an
-- actorless path to it.
--
-- WHAT THIS FILE DOES ADD TO THAT PICTURE, WITHOUT A NEW COLUMN. `posted` and `reimbursed`
-- now require `approved_by`, and the map admits exactly one route into each of them, so a
-- claim in either state provably passed through `approved` with a named approver who was
-- not the claimant. Four eyes on the hand-over is still unenforceable; four eyes on the
-- DECISION the hand-over acts upon is now structural rather than merely usual. That is the
-- strongest statement the existing columns support.
--
-- RECOMMENDED AND NOT DONE: `posted_by` (nullable, because the `expense_post` sweep has no
-- actor and must not fabricate one) and `reimbursed_at` / `reimbursed_by`. With them,
-- `reimburse` could carry the same CHECK pair the other two decisions have and the route's
-- guard would stop being the only copy. It is a schema change with a backfill question
-- attached — what actor do existing `posted` rows get, and the answer is none — and this
-- migration was asked for the lifecycle, not for new columns.
--
-- ===========================================================================
-- NOTHING IS BACK-FILLED, AND WHY THIS SCHEMA DIFFERS FROM THE ERP'S INCIDENTS
-- ===========================================================================
--
-- The ERP's `incident-response-runtime` back-fills the timestamps a target status
-- TRANSITIVELY implies, because its map admits skips — `mitigating -> resolved` jumps over
-- the hop where `mitigatedAt` is normally stamped, so refusing the move or leaving the
-- field null are the only other options and both are wrong.
--
-- THIS MAP ADMITS NO SKIPS. Every state has exactly one predecessor (`draft` -> `submitted`
-- -> `approved` -> `posted` -> `reimbursed`, with `rejected` hanging off `submitted`), so
-- nothing is transitively implied that was not also directly required one hop earlier.
-- There is no case where a legal move would leave an implied column empty, and therefore
-- nothing for a back-fill to do.
--
-- AND IF THERE WERE, IT WOULD STILL BE REFUSED RATHER THAN INVENTED. `now()` inside a
-- trigger is the TRANSACTION clock — the fact 0020, 0030 and 0036 all had to reason about —
-- so a back-filled `posted_at` would stamp every claim in one `expense_post` batch with an
-- identical instant, and would differ from the `posted_at` the caller believes it wrote.
-- `posted_at` is the moment a decision was taken, not a derived quantity; a trigger that
-- supplies one is writing a fact nobody witnessed. 0038 reached the same conclusion from
-- the other side when it refused to repair existing impossible `revived_at` values:
-- "overwriting it with `now()` would replace a visibly wrong timestamp with an invisibly
-- wrong one".
--
-- SO WHAT HAPPENS TO A HAND-WRITTEN ROW THAT SKIPS A STEP? It is refused, and the question
-- of what to back-fill never arises. `draft -> posted` is not an edge; `submitted ->
-- reimbursed` is not an edge; a row that reaches `posted` did so from `approved` and
-- carries the approver who sent it there. The chain being total is what makes the
-- four-eyes statement in the previous section true.
--
-- ===========================================================================
-- A DECISION ONCE RECORDED IS NOT REWRITTEN
-- ===========================================================================
--
-- Pairing fields to the TRANSITION and not to the resting state leaves one way out, and it
-- is a single statement:
--
--     UPDATE crm.expense_claim SET approved_by = NULL WHERE state = 'approved';
--
-- No state changed, so a transition rule never looks; no CHECK mentions `approved_by` on
-- its own; and the claim is now approved by nobody — which is the defect this file opened
-- with, reached without a transition. Re-pointing the column at a different rep is the same
-- statement with a different value and is worse, because it is attribution rather than
-- absence.
--
-- THE RULE. The columns that record WHO decided and WHEN, plus the two ERP record ids, are
-- WRITE-ONCE: null may become a value (that is what a transition does), and a value may
-- never become a different value or null again. Phrased as a property of a CHANGE, not of a
-- row — which is what keeps it out of the pre-flight argument below and what lets it stand
-- beside 0030's deliberately nullable `rejected_by` without contradicting it.
--
-- `erp_ledger_account_code` AND `erp_cost_center_code` ARE NOT IN THAT SET, though 0006's
-- intent ("re-mapping a category next quarter must not silently re-attribute a claim")
-- reads like they should be. Two reasons. The CHECK permits a `draft` claim to already
-- carry an account code, and `submitClaim` then OVERWRITES it with the live mapping in one
-- statement — sealing the column would refuse the submission of any such claim, which is a
-- legal row today. And `erp_cost_center_code` is legitimately null for a mapping with no
-- cost centre, so write-once would leave it settable forever afterwards, which is the rule
-- failing to mean anything rather than the rule being kept. Freezing a claim's SUBSTANCE
-- after it leaves draft — category, amount, currency, `incurred_on`, the snapshot — is a
-- real and separate gap, in the shape 0016 closed for an approved call plan. It is named in
-- the ADR as owed and is not attempted here.
--
-- ===========================================================================
-- BORN `draft`, AND WHY INSERT NEEDS AN ARM OF ITS OWN
-- ===========================================================================
--
-- A claim that arrives already `approved` skips the entire map in one statement, and every
-- resting CHECK is happy to see it: supply `approved_at`, supply an `approved_by` who is
-- not the claimant, supply an account code, and the row is indistinguishable at rest from
-- one that was filed, submitted and approved by two people. A `BEFORE UPDATE` trigger never
-- sees it. The transition rule and the field rules would both be decoration against a
-- writer who simply spells the end state in the INSERT.
--
-- So INSERT admits `draft` and nothing else. `state` already DEFAULTS to `'draft'`, which
-- is what makes this cost nothing: `createClaim` is the only thing in this workspace that
-- inserts a claim outside a test, and it names no state at all. Two tests still name one in
-- an INSERT and both are correct to: `composite-fk.contract.test.ts`'s two `_by` probes
-- (which stand this trigger down anyway, for the reason its own header gives), and this
-- migration's own suite, which asserts that each of the five non-draft spellings is refused.
--
-- WHY THE INSERT ARM CHECKS NOTHING ELSE. A `draft` row's lifecycle columns are already
-- pinned where it matters — `expense_claim_approved_fields` and
-- `expense_claim_rejected_fields` are equalities, so `draft` forces both timestamps null —
-- and a `draft` row carrying a stray `posted_at` skips nothing, because the map still makes
-- it walk every hop. One rule per arm; the arm's rule is "a claim begins at the beginning".
--
-- THE FUTURE PATH WORTH NAMING. `packages/sync/` exists because reps work offline and a
-- receipt flush is the obvious next one after disbursements; a flush of a claim filed AND
-- submitted on a plane would want to insert `submitted`. It must not. Two statements in one
-- transaction — `createClaim` then `submitClaim` — produce the same row, take the account
-- snapshot from the live mapping rather than from whatever the device remembered, and go
-- through the one path that knows the category has to be mapped at all. The INSERT arm is
-- what makes that the only option rather than the polite one.
--
-- ===========================================================================
-- THE ESCAPE HATCH IS `DISABLE TRIGGER`, AND IT IS DELIBERATELY EXPENSIVE
-- ===========================================================================
--
-- An operator repair in SQL is a real thing in this system, and a trigger that refuses
-- every repair is a trigger somebody turns off at the worst possible moment. So the hatch
-- is named here rather than discovered later:
--
--     BEGIN;
--     ALTER TABLE crm.expense_claim DISABLE TRIGGER expense_claim_check_lifecycle;
--     -- the repair, which every CHECK and every policy still judges
--     ALTER TABLE crm.expense_claim ENABLE TRIGGER expense_claim_check_lifecycle;
--     COMMIT;
--
-- IT IS THE HATCH THIS REPO ALREADY USES. `packages/db/src/composite-fk.contract.test.ts`
-- opens every one of its 46 probes with `ALTER TABLE … DISABLE TRIGGER USER`, and argues it
-- in its own header: a foreign key is checked after the BEFORE triggers have had their say,
-- so a guard on top has to be stood down for the constraint underneath to be the thing
-- answering. Its teardown does the same for the append-only tables, because "a fixture has
-- to be removable even when the table it is in is not". Inventing a second mechanism for
-- the same need would be the drift this file is otherwise written to prevent — and note
-- that those probes mean `crm.expense_claim`'s two `_by` foreign keys are already probed
-- with this trigger stood down, so they needed no change for it.
--
-- WHY NOT A SESSION GUC, which is the obvious alternative: `SET LOCAL
-- app.expense_claim_repair = 'on'` and an early `RETURN NEW`. Refused, and the reason is
-- what it costs rather than what it does. A GUC is cheap, per-transaction and invisible in
-- a catalog, which makes it exactly the thing a future writer sets once "just for this sync
-- flush" — and then the lifecycle is back in TypeScript and this file is a comment. Every
-- header in this schema that moved a rule out of a route (0018, 0023, 0033, 0040) did so
-- because the route was skippable; a hatch that is as cheap as the path it bypasses
-- reintroduces the skip under a new name. `DISABLE TRIGGER` cannot be done per row, takes
-- `ACCESS EXCLUSIVE` on `crm.expense_claim` so it cannot be done quietly while the API
-- serves, is DDL and so appears under `log_statement = 'ddl'`, and has to be undone
-- explicitly. An operator who does it is making a decision; an application that does it
-- blocks itself. That asymmetry IS the control.
--
-- WHAT THE HATCH IS NOT FOR, which is most of what one might expect. There is no backwards
-- transition anywhere in production, and every documented operator repair in this system is
-- a repair to a DIFFERENT table: a write the ERP refused permanently is revived through
-- `POST /v1/erp-writes/:id/retry`, which resets `crm.outbox` and never touches the claim
-- (README rule 31); a claim stuck `approved` because its rep has no `erp_employee_id` is
-- freed by reconciling `crm.rep_profile`, and `expense_post` picks it up on the next pass;
-- and a claim that should not have been approved is corrected by a reversing entry in the
-- ledger, which `states.ts` says in as many words. The hatch therefore exists for two
-- things, and both are honest about being outside the lifecycle: a bulk import of claims
-- that already have a history, and a test that must manufacture a row the lifecycle cannot
-- produce in order to assert a rule about a row AT REST.
--
-- IT IS OPEN TO `crm_app`, and that is worth stating plainly rather than implying a
-- stronger boundary than exists. `crm_app` owns these tables — which is what makes it
-- subject to the policies, README rule 1 — so it can disable this trigger, as it can every
-- other trigger in the schema. The guarantee here is visibility and expense, not
-- impossibility; impossibility would need the table owned by a role the application is not,
-- which is a deployment change and not a migration.
--
-- ===========================================================================
-- THERE IS NO PRE-FLIGHT, AND THAT IS A DECISION
-- ===========================================================================
--
-- 0037 opens with a per-tenant pre-flight and 0039 exists only because 0032's backfill ran
-- blind, so an absent one has to be argued. 0040's argument applies here almost unchanged:
-- a rule that governs an ACT has nothing to scan.
--
-- TAKE EACH HALF OF THIS FILE IN TURN:
--
--   * The transition map governs a change of `state`. No row at rest violates it, because
--     "this row is in `posted`" is not a claim about how it got there.
--   * The field requirements are evaluated ONLY when `NEW.state <> OLD.state`. That scoping
--     is what makes them act-rules rather than resting-state rules, and it is load-bearing
--     for exactly one shape of existing row: 0030's backfill knowingly left pre-existing
--     `rejected` rows with `rejected_at` set and `rejected_by` null. Had the requirement
--     been phrased as "a `rejected` row has a rejecter" it would have refused those rows,
--     and either failed the migration or invited a fabricated actor — which is the trade
--     0030 examined and declined. Phrased as "rejecting records a rejecter", it refuses
--     nothing that already exists.
--   * The write-once rule governs a value CHANGING. A row whose columns are already null is
--     untouched; a row whose columns are set is only refused if something tries to move
--     them.
--   * The INSERT arm governs an insertion.
--
-- So there is no state a correct database can be in that this file would refuse, and
-- nothing a clamp could clamp. Which is also why both halves are a trigger rather than a
-- CHECK, beyond the fact that a CHECK cannot see `OLD`: a validated CHECK's scan is NOT an
-- ordinary query and WOULD see every existing row (0039's asymmetry, the sighted half), so
-- phrasing any of this as a CHECK would refuse a database that is exactly correct.
--
-- ===========================================================================
-- TRIGGER NAME, ORDER, AND THE ERROR IT RAISES
-- ===========================================================================
--
-- `crm.expense_claim` carries NO user trigger today, so firing order is not yet a finding
-- the way 0033 and 0040 found it on `crm.attachment`. It will be the moment a second one
-- arrives, and the name is chosen so the answer is already right: Postgres fires same-event
-- triggers in ALPHABETICAL order, and `expense_claim_check_lifecycle` sorts before anything
-- named for a narrower concern (`expense_claim_freeze_substance`, say). That is the correct
-- precedence — "may this move at all" before "and may this particular column move" — and is
-- the same reasoning 0040 used to put itself AFTER `attachment_validate`: the better-aimed
-- refusal goes first, and here the map is the better-aimed one, because a column rule
-- reporting on a transition the map forbids is a true sentence about the wrong question.
--
-- ONE FUNCTION WITH A `TG_OP` BRANCH, NOT TWO TRIGGERS. 0016 splits `call_plan`'s rules
-- across four triggers because they are four different questions (the map, the approver's
-- territory, the children, deletion). These two arms are ONE question — how a claim comes to
-- be in a state — asked of the two events that can answer it, which is 0040's own shape and
-- its own argument for not giving `attachment_validate` a `TG_OP` branch it had no business
-- holding.
--
-- THE MESSAGES AVOID THE WORD "amount", ON PURPOSE. Every refusal here is a 23514 with no
-- constraint name, and `translateExpenseClaimError` ends with `if (e?.code === "23514" &&
-- message.includes("amount"))` under a comment reading "the only unnamed one on this table
-- is `amount > 0`". That comment is no longer true, and a lifecycle refusal that happened
-- to use the word would be reported to a rep as `InvalidAmountError`. No translation branch
-- is added for the new refusals instead of widening that one, because none is reachable
-- from `packages/expense`: every store function calls `assertExpenseClaimTransition` and
-- then issues a guarded `WHERE state = …` UPDATE, so a TypeScript caller meets a typed
-- error naming the allowed targets and never this trigger. A branch for it would be dead
-- code pretending to be a safety net.
--
-- ===========================================================================
-- RE-APPLICATION
-- ===========================================================================
--
-- `CREATE OR REPLACE` on all four functions and on the trigger, so this file converges on
-- the same state from a database that has it and one that does not. `CREATE OR REPLACE
-- TRIGGER` (Postgres 14+; 16 in CI, in `deploy/docker-compose.yml` and in production)
-- rather than `DROP TRIGGER IF EXISTS` then `CREATE`, for 0040's reason and in its words:
-- the runner wraps a whole file in one transaction, but `scripts/setup-test-db.sh` applies
-- files through `psql` WITHOUT `-1`, where each statement commits on its own — so the
-- atomicity has to be in the statement rather than assumed from the caller. A
-- drop-then-create would leave a committed instant in which `crm.expense_claim` has no
-- lifecycle guard, inside the file whose whole purpose is that it always has one.

-- ---------------------------------------------------------------------------
-- 1. The map.
-- ---------------------------------------------------------------------------

/**
 * The claim lifecycle, as rows rather than as branches.
 *
 *   draft     -> submitted
 *   submitted -> approved | rejected
 *   approved  -> posted
 *   posted    -> reimbursed
 *   rejected, reimbursed -> terminal
 *
 * Mirrors `EXPENSE_CLAIM_TRANSITIONS` in `packages/expense/src/states.ts`, which explains
 * the three shapes that are choices rather than consequences: `rejected` is reachable only
 * from `submitted` because un-approving needs the ERP side reversed and that is a credit
 * note's job; `posted` sits between `approved` and `reimbursed` because the human decision
 * and the hand-over are separate acts (0006's `idx_expense_claim_unsent` indexes exactly
 * the gap between them); and both exits are terminal because a correction is a new claim.
 *
 * Returned as rows and not kept inside the trigger so that the agreement between this and
 * the TypeScript map is a test rather than a comment. See the header.
 */
CREATE OR REPLACE FUNCTION crm.expense_claim_transitions()
RETURNS TABLE (from_state text, to_state text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT * FROM (VALUES
    ('draft'::text,     'submitted'::text),
    ('submitted',       'approved'),
    ('submitted',       'rejected'),
    ('approved',        'posted'),
    ('posted',          'reimbursed')
  ) AS t (from_state, to_state);
$$;

/**
 * The columns the ACT of entering a state must supply, and that no CHECK already pairs.
 *
 * Deliberately not a restatement of `expense_claim_approved_fields`,
 * `expense_claim_rejected_fields` or `expense_claim_snapshot_before_submit`: those three
 * govern the row at rest and are the authority on `approved_at`, `rejected_at` and
 * `erp_ledger_account_code` respectively. The table in the header lists both columns side
 * by side.
 *
 * `submitted_at` on every non-draft target, because every state past `draft` is downstream
 * of a submission and this is the only column recording it. `approved_by` and `rejected_by`
 * because the two four-eyes CHECKs are vacuous against a null actor. `posted_at` and
 * `erp_expense_id` on `posted` and `reimbursed` because nothing else asks for either, and
 * `reimbursed` inherits the `posted` set because the map admits exactly one way in.
 *
 * NULL for an unrecognised state, which the trigger treats as a refusal. A state added to
 * `expense_claim_state_check` and not here is unreachable rather than ungoverned — see the
 * header on why this fails in the opposite direction from `crm.notification_subject_open`.
 */
CREATE OR REPLACE FUNCTION crm.expense_claim_transition_requires(p_state text)
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_state
    WHEN 'draft'      THEN ARRAY[]::text[]
    WHEN 'submitted'  THEN ARRAY['submitted_at']
    WHEN 'approved'   THEN ARRAY['submitted_at', 'approved_by']
    WHEN 'rejected'   THEN ARRAY['submitted_at', 'rejected_by']
    WHEN 'posted'     THEN ARRAY['submitted_at', 'approved_by', 'posted_at', 'erp_expense_id']
    WHEN 'reimbursed' THEN ARRAY['submitted_at', 'approved_by', 'posted_at', 'erp_expense_id']
    ELSE NULL
  END;
$$;

/**
 * Write-once: who decided, when, and which ERP record it became.
 *
 * A transition fills these; nothing moves them afterwards. Without this the field
 * requirements above are defeated by one statement that changes no state —
 * `UPDATE … SET approved_by = NULL WHERE state = 'approved'` — which leaves a claim
 * approved by nobody, the defect this file opened with.
 *
 * The two ERP record ids are here for a different reason than the five CRM columns: an ERP
 * record id is the thing the outbox's uniqueness guarantee is built on (README rule 2), so
 * a claim that renamed the record it became would make a replay land twice.
 *
 * `erp_ledger_account_code` and `erp_cost_center_code` are deliberately absent — the header
 * explains why sealing them would refuse a legal submission.
 */
CREATE OR REPLACE FUNCTION crm.expense_claim_sealed_columns()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['submitted_at', 'approved_at', 'approved_by', 'rejected_at', 'rejected_by',
               'posted_at', 'erp_expense_id', 'erp_journal_entry_id'];
$$;

-- ---------------------------------------------------------------------------
-- 2. The guard.
-- ---------------------------------------------------------------------------

/**
 * How a claim may come to be in a state. One question, asked of both events that answer it.
 *
 * INSERT: `draft` only. A claim that arrives already `approved` skips the map entirely and
 * is indistinguishable at rest from one two people agreed on.
 *
 * UPDATE: the move must be an edge of `crm.expense_claim_transitions()`, the target state's
 * required columns must be present, and no already-recorded decision may be rewritten. The
 * field requirements are scoped to an actual change of `state` on purpose: that is what
 * keeps them statements about an act, so no existing row violates them and this migration
 * needs no pre-flight. See the header.
 *
 * Columns are read out of `to_jsonb(NEW)` by name rather than through eight `IF` branches,
 * so the requirement lists stay data that a test can read and compare.
 */
CREATE OR REPLACE FUNCTION crm.expense_claim_check_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required  text[];
  col       text;
  after_row jsonb;
  prior_row jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' THEN
      RAISE EXCEPTION
        'expense-claim-lifecycle: a claim cannot be created in state % — it begins as draft and reaches every other state by a transition this trigger can see, so a claim born past the start is one nobody decided on',
        NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  after_row := to_jsonb(NEW);

  IF NEW.state <> OLD.state THEN
    IF NOT EXISTS (
      SELECT 1 FROM crm.expense_claim_transitions() t
       WHERE t.from_state = OLD.state AND t.to_state = NEW.state
    ) THEN
      RAISE EXCEPTION
        'expense-claim-lifecycle: expense claim % cannot move from % to % — the lifecycle admits (%), and a correction to a claim that has left draft is a new claim or a reversing entry, never an edit',
        OLD.id, OLD.state, NEW.state,
        COALESCE(
          (SELECT string_agg(t.to_state, ', ' ORDER BY t.to_state)
             FROM crm.expense_claim_transitions() t WHERE t.from_state = OLD.state),
          'nothing — it is final')
        USING ERRCODE = 'check_violation';
    END IF;

    required := crm.expense_claim_transition_requires(NEW.state);
    -- Unrecognised state. `expense_claim_state_check` would refuse it too, but a CHECK is
    -- evaluated after this trigger, and a state added to that CHECK and not to the
    -- requirement map would otherwise be the one state with no field rule at all.
    IF required IS NULL THEN
      RAISE EXCEPTION
        'expense-claim-lifecycle: state % has no entry in crm.expense_claim_transition_requires, so nothing vouches for what a claim in it must carry',
        NEW.state
        USING ERRCODE = 'check_violation';
    END IF;

    FOREACH col IN ARRAY required LOOP
      IF after_row ->> col IS NULL THEN
        RAISE EXCEPTION
          'expense-claim-lifecycle: expense claim % cannot become % with no % — that column is the record of the decision, and the resting CHECKs on this table cannot ask for it because they are satisfied by a null',
          OLD.id, NEW.state, col
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  prior_row := to_jsonb(OLD);

  FOREACH col IN ARRAY crm.expense_claim_sealed_columns() LOOP
    IF prior_row ->> col IS NOT NULL
       AND (after_row ->> col) IS DISTINCT FROM (prior_row ->> col) THEN
      RAISE EXCEPTION
        'expense-claim-lifecycle: expense claim % already records % as %, and it is write-once — erasing or re-pointing it would change who decided this claim without changing its state, which no CHECK on this table would notice',
        OLD.id, col, prior_row ->> col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

-- Named to sort first among same-event triggers on this table: "may this move at all"
-- belongs ahead of any later rule about one column, or a column refusal would answer a
-- question about a transition the map forbids. Replaced in one statement, so no committed
-- instant leaves the table unguarded. Both are argued in the header.
CREATE OR REPLACE TRIGGER expense_claim_check_lifecycle
  BEFORE INSERT OR UPDATE ON crm.expense_claim
  FOR EACH ROW EXECUTE FUNCTION crm.expense_claim_check_lifecycle();
