-- 0040_receipt_claim_state.sql
--
-- The one attachment rule that was still only in a route.
--
-- WHAT WAS BROKEN. `POST /v1/expenses/:id/receipt` holds a rule nothing in the database
-- holds, and its own doc comment says so in as many words: "It belongs in a trigger rather
-- than here, because a route is not where an offline sync path can be made to honour it."
-- The rule it holds is about WHICH IMAGE IS THE RECEIPT at the moment somebody approves a
-- reimbursement against it:
--
--   * a FIRST receipt may be attached while the claim is `draft` or `submitted`. A claim
--     legitimately gains its evidence while an approver is already looking at it.
--   * a REPLACEMENT is admitted in `draft` only. In `submitted` an approver may be reading
--     receipt A at the moment it becomes B, and would then approve B having reviewed A.
--     That race is the entire reason the two tiers differ.
--   * `approved`, `posted`, `reimbursed` and `rejected` refuse both: on the first three the
--     decision has been taken and the evidence behind it is history, and on the last there
--     is nothing left to evidence.
--
-- 0033 built this table so that a swap is not expressible — the row is append-only, the
-- bytes are immutable, a replacement is a NEW row naming the one it supersedes, and the
-- superseded image keeps its bytes. All of that holds. What it does NOT hold is the TIMING:
-- `crm.attachment_validate` never reads `crm.expense_claim.state`, so the chain stays
-- honest and legible while the answer to "which receipt did the approver see" changes under
-- them. The old photograph survives, which is exactly what makes this easy to miss — the
-- forensics are intact and the approval is still wrong.
--
-- A ROUTE IS THE WRONG PLACE FOR IT, for the reason this repo gives every time (0023's role
-- rules, 0018's ledger rules, 0033's own five): the interactive route is one writer of this
-- table and it is not the only one. `packages/sync/` exists because reps work offline, the
-- disbursement flush already has a per-row sync path, and a receipt flush is the obvious
-- next one — it would reach `putAttachment` with no route check in front of it. A psql
-- prompt reaches it with none either. So the rule moves into the database, and the route's
-- check STAYS: it runs before half a megabyte crosses the wire and it is the sentence a rep
-- actually reads, which is 0033's own argument for keeping `AttachmentTooLargeError` in
-- TypeScript as well as a CHECK in SQL. One rule, two statements of it, and the one that
-- cannot be routed around is underneath.
--
-- ===========================================================================
-- WHY THIS EXTENDS NOTHING AND ADDS ONE TRIGGER, AND WHY ITS NAME MATTERS
-- ===========================================================================
--
-- The obvious move is a new arm in `crm.attachment_validate`, beside the signature
-- commitment check it already branches on by purpose. It is the wrong one, for one reason
-- that is decisive and one that is a matter of what that function is.
--
-- THE RULE HAS TO BITE ON UPDATE, AND `attachment_validate` IS `BEFORE INSERT`. Superseding
-- is two statements in that order — the predecessor is marked first, because
-- `uq_attachment_current` admits one `current` row per (subject, purpose) and inserting the
-- successor first would collide with the row it replaces. The INSERT carries
-- `supersedes_attachment_id`, so an INSERT-only rule does catch the ordinary replacement.
-- It does not catch the first half ON ITS OWN, and the first half on its own commits:
--
--     UPDATE crm.attachment
--        SET status = 'superseded',
--            superseded_by_attachment_id = <any other attachment of this tenant>,
--            superseded_reason = 'x'
--      WHERE id = <the receipt on an approved claim>;
--
-- `attachment_append_only` admits it (it is `current -> superseded` with a successor and a
-- reason), `attachment_superseded_pair` and `attachment_superseded_reason` are satisfied,
-- and the DEFERRABLE back-link finds a real row at COMMIT. The claim is then APPROVED WITH
-- NO CURRENT RECEIPT AT ALL, which is a worse outcome than the swap this file is about and
-- was reachable with one statement. Widening `attachment_validate`'s trigger to
-- `INSERT OR UPDATE` to reach it would re-run its commitment lookup, its supervision check
-- and its supersession-chain checks on every supersession of every purpose — arms written
-- for a row that does not exist yet, answering a question nobody asked.
--
-- AND `attachment_validate` IS "the rules a NEW attachment must satisfy". Its five questions
-- are about the row being created. This one is about whether the SUBJECT will accept the act
-- at all, on either statement, which is a different question — the same reason 0033 kept
-- `attachment_append_only` separate rather than giving `attachment_validate` a `TG_OP`
-- branch.
--
-- SO: ONE FUNCTION, ONE TRIGGER, `BEFORE INSERT OR UPDATE`, AND THE NAME IS LOAD-BEARING.
-- Postgres fires same-event triggers in ALPHABETICAL ORDER by trigger name, and 0033's
-- header records that the order of `attachment_validate`'s own arms was a finding rather
-- than a preference: the purpose/subject-pairing arm speaks FIRST, because without it a
-- `disbursement_signature` pointed at an expense claim was refused with "records no
-- signature_sha256" — a true sentence about the wrong question. A trigger named, say,
-- `attachment_claim_state` sorts BEFORE `attachment_validate` and would undo that: a receipt
-- mispaired onto `crm.sample_transaction` would meet this function first, find no claim with
-- that id, and be told the claim is missing rather than that the pairing is wrong.
--
-- `attachment_validate_receipt_claim_state` sorts after `attachment_validate` and after
-- `attachment_append_only`, so on both events the better-aimed refusal still comes first:
--
--   INSERT:  attachment_validate                        -> pairing, subject, owner, commitment
--            attachment_validate_receipt_claim_state    -> may the claim accept this now?
--   UPDATE:  attachment_append_only                     -> is this even a permitted change?
--            attachment_validate_receipt_claim_state    -> may the claim accept it now?
--
-- On UPDATE that ordering is what lets this function assume what it assumes: by the time it
-- runs, the only change that can be in flight is `current -> superseded` with every other
-- column identical, because `attachment_append_only` has already refused anything else. So
-- an UPDATE reaching here IS the stand-down half of a replacement, and needs no inspection
-- of what changed.
--
-- `packages/storage/src/attachment.contract.test.ts` pins the ordering from the other side,
-- by name, under "the claim state a receipt may be attached, replaced or stood down at" —
-- so renaming this trigger breaks a test rather than quietly reordering two refusals. (An
-- earlier draft of this header named a `receipt-claim-state.contract.test.ts` that was never
-- written: the cases went into the existing suite, which already owns `TENANT_STORAGE` and
-- the claim fixture they need.)
--
-- ===========================================================================
-- SCOPED TO THE RECEIPT PURPOSE, AND WHAT THE OTHER PURPOSE WOULD MEAN
-- ===========================================================================
--
-- `disbursement_signature` is untouched and the guard returns immediately for it. Its
-- subject is `crm.sample_transaction`, which has no state column and could not have one:
-- 0018 makes the custody ledger append-only, so a hand-over has no lifecycle to be at the
-- wrong point of, and 0033 already refuses superseding a signature outright. There is no
-- timing question to ask about an image whose identity is a commitment that cannot be
-- corrected.
--
-- The purpose is the gate rather than `subject_table`, because the purpose is what decides
-- every other rule in this subsystem (0033: "What this attachment IS, which decides every
-- rule that follows"), and the two are pinned to each other by `attachment_purpose_subject`
-- and by the arm at the top of `crm.attachment_validate`. A third purpose added later gets
-- no rule here by default, which is the right direction: a purpose whose subject has a
-- lifecycle has to say what that lifecycle admits, and silence must not read as "any time".
--
-- ===========================================================================
-- THE CLAIM IS RESOLVED UNDER RLS AND NOT BY AN EXPLICIT TENANT PREDICATE, WHICH IS
-- BACKWARDS FOR THIS REPO AND RIGHT HERE
-- ===========================================================================
--
-- The house pattern is `AND tenant_id = $n` beside the id, with the policy as the backstop,
-- and this function deliberately does NOT follow it: it matches the claim on `c.id` alone
-- and lets the policy on `crm.expense_claim` scope it, which is exactly what
-- `crm.attachment_subject_rep` does one trigger earlier.
--
-- IT WAS WRITTEN THE HOUSE WAY FIRST AND A TEST CAUGHT IT. `AND c.tenant_id = NEW.tenant_id`
-- turns a cross-tenant SMUGGLE into a missing claim. The write
--
--     INSERT INTO crm.attachment (…, tenant_id, subject_id, …)
--     VALUES (…, <another tenant>, <a claim of MINE>, …)
--
-- run inside my own tenant context is refused by the RLS `WITH CHECK` on `crm.attachment`,
-- and that refusal — "new row violates row-level security policy" — is the correct
-- diagnosis and the one `attachment.contract.test.ts` pins. With the extra predicate this
-- function speaks first, because a BEFORE trigger runs ahead of the policy check, and says
-- the claim does not exist: a true sentence about the wrong question, for the second time in
-- this subsystem's history — 0033's header records the first. Resolving the claim exactly as
-- the trigger before it does keeps the two in step and leaves the smuggle to the mechanism
-- that actually diagnoses it.
--
-- THE PREDICATE WAS NOT BUYING ANYTHING EITHER. A row whose `tenant_id` is not the session's
-- is refused by the policy whatever this function concludes, and a row whose `tenant_id` IS
-- the session's resolves the same claim under either spelling. The only case the predicate
-- changes is the one it gets wrong.
--
-- NOT FINDING THE CLAIM REFUSES, and the direction is 0033's: an attachment whose subject is
-- gone has nobody accountable for it, so it is not readable and must not be writable either.
-- On INSERT the case is unreachable, and resolving the claim the same way as
-- `crm.attachment_subject_rep` is what makes it unreachable rather than merely unlikely: if
-- `attachment_validate` admitted the row then it resolved an owner from this very claim under
-- this very policy, so the claim is visible here too — including on a connection with no
-- tenant context at all, where 0033's "an attachment cannot be created for a subject that
-- does not exist" is the sentence that comes back. On UPDATE it is reachable, because
-- `crm.attachment.subject_id` is deliberately NOT a foreign key (0033: a column cannot
-- reference two tables) and nothing stops an expense claim being deleted out from under its
-- receipts. A receipt whose claim has been deleted cannot be stood down, which is the
-- fail-closed answer and leaves the chain intact for whoever has to explain the deletion.
--
-- ===========================================================================
-- THERE IS NOTHING TO BACKFILL, AND THAT IS WHY THERE IS NO PRE-FLIGHT
-- ===========================================================================
--
-- 0037 opens with a per-tenant pre-flight and 0039 exists because 0032's backfill ran blind,
-- so the absence of one here is a decision and not an omission. This rule is about an ACT —
-- attaching, replacing, standing down — and not about a resting state. A receipt sitting
-- `current` on a `posted` claim is the NORMAL and correct end state: it was attached in
-- draft, the claim was submitted, approved and posted around it, and nothing moved the
-- image. No existing row can violate a rule about acts, so there is nothing a scan could
-- find and nothing a clamp could clamp.
--
-- Which is also why this is a trigger and not a CHECK, beyond the fact that it reads another
-- table. A CHECK would have to be satisfied by every row already there, and the rows already
-- there are fine; its validation scan is not an ordinary query and WOULD see them (0039's
-- asymmetry, the sighted half), so it would refuse a database that is exactly correct. A
-- trigger looks only at what is being written, which is the only thing this rule has an
-- opinion about.
--
-- ===========================================================================
-- RE-APPLICATION
-- ===========================================================================
--
-- `CREATE OR REPLACE` on both objects, so this file converges on the same state from a
-- database that has it and one that does not. `CREATE OR REPLACE TRIGGER` (Postgres 14+;
-- this repo is on 16 in CI, in `deploy/docker-compose.yml` and in production) rather than
-- `DROP TRIGGER IF EXISTS` then `CREATE`, for 0037's reason and in its words: the runner
-- wraps a whole file in one transaction, but `scripts/setup-test-db.sh` applies files through
-- `psql` WITHOUT `-1`, where each statement commits on its own — so the atomicity has to be
-- in the statement rather than assumed from the caller. A drop-then-create would leave a
-- committed instant in which `crm.attachment` has no claim-state guard, inside the file whose
-- whole purpose is that it always has one.

-- ---------------------------------------------------------------------------
-- May this expense claim accept a receipt being attached, replaced or stood down?
-- ---------------------------------------------------------------------------

/**
 * The two tiers, in the database, where the route cannot be the only thing holding them.
 *
 * A first receipt: `draft` or `submitted`, because evidence legitimately arrives while an
 * approver is looking. A replacement — either half of one — `draft` only, because an
 * approver may be reading receipt A at the moment it becomes B.
 *
 * On UPDATE the act is always the stand-down half of a replacement: `attachment_append_only`
 * sorts first and has already refused every other change. See the header on why this trigger
 * is named to sort after both of 0033's.
 */
CREATE OR REPLACE FUNCTION crm.attachment_validate_receipt_claim_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_state text;
BEGIN
  -- A signature has no timing question to answer: its subject is an append-only ledger row
  -- with no state, and 0033 refuses superseding one outright. See the header.
  IF NEW.purpose <> 'expense_receipt' THEN
    RETURN NEW;
  END IF;

  -- Matched on the id alone, under the caller's own row security, exactly as
  -- `crm.attachment_subject_rep` resolves the same claim in the trigger before this one. An
  -- explicit `AND c.tenant_id = NEW.tenant_id` here made a cross-tenant smuggle report a
  -- missing claim instead of the row-level-security violation that actually refuses it — see
  -- the header.
  SELECT c.state INTO claim_state
    FROM crm.expense_claim c
   WHERE c.id = NEW.subject_id;

  -- Unreachable on INSERT — `attachment_validate` resolved an owner from this claim under
  -- this policy, so it is visible here, and a claim that is not visible was refused there
  -- with a better sentence. Reachable on UPDATE, because `subject_id` is not a foreign key
  -- and a claim can be deleted under its receipts. Fail closed either way: an attachment
  -- nobody is accountable for is not one to be moved around.
  IF claim_state IS NULL THEN
    RAISE EXCEPTION
      'receipt-claim-state: expense claim % is not visible in tenant %, so there is no claim state that could admit this receipt',
      NEW.subject_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF claim_state <> 'draft' THEN
      RAISE EXCEPTION
        'receipt-claim-state: expense claim % is %, so the receipt standing on it cannot be stood down — standing it down is the first half of a replacement, and it would leave a claim that has left draft with no current receipt at all',
        NEW.subject_id, claim_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.supersedes_attachment_id IS NOT NULL THEN
    IF claim_state <> 'draft' THEN
      RAISE EXCEPTION
        'receipt-claim-state: expense claim % is %, so its receipt is fixed and may no longer be replaced — an approver may be reading this image at the moment it changes, and a decision taken against evidence it never saw is corrected by a new claim, not by a new photograph',
        NEW.subject_id, claim_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF claim_state NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION
      'receipt-claim-state: expense claim % is %, and a receipt may be attached only while a claim is draft or submitted — after that the decision has been taken, or there is nothing left to evidence',
      NEW.subject_id, claim_state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- Named to sort AFTER `attachment_validate` and `attachment_append_only`, which is what
-- keeps each event's better-aimed refusal first; replaced in one statement, so no committed
-- instant leaves the table unguarded. Both are argued in the header.
CREATE OR REPLACE TRIGGER attachment_validate_receipt_claim_state
  BEFORE INSERT OR UPDATE ON crm.attachment
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_validate_receipt_claim_state();
