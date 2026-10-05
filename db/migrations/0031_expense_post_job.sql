-- 0031_expense_post_job.sql
--
-- An approved expense claim waited for somebody to press a button.
--
-- WHAT WAS BROKEN. `postClaim` hands an approved claim to the ERP, and until now the only
-- caller was `POST /v1/expenses/{id}/post` — a human. Approving and posting are separate
-- acts on purpose (0006's `idx_expense_claim_unsent` indexes exactly "approved, not yet
-- handed over", which only means something if they are), but nothing ever performed the
-- second one on its own. A rep's reimbursement therefore started when an administrator
-- remembered it, and ADR-0001 recorded the gap with no date against it.
--
-- THE RULE. Posting is still a separate act; it is now a SCHEDULED one. `expense_post`
-- sweeps `unpostedApprovedClaims` every five minutes and posts each claim in its own
-- transaction. A claim that cannot post does not hold up the ones that can, which is the
-- same rule the snapshot refresher follows and matters more here: one rep with no
-- `erp_employee_id` would otherwise block every other rep's money indefinitely.
--
-- CONSEQUENCE WORTH KNOWING. `expense_post` makes the CRM post claims without a human in
-- the loop, so the four-eyes CHECK on `crm.expense_claim` is now the ONLY thing standing
-- between an approval and a ledger entry. It was already the only thing that mattered —
-- the ERP's Expense workflow is a flat role check (report R7) — but a second pair of eyes
-- used to exist by accident, in the person who pressed the button. It does not any more.
--
-- Two further changes follow from the sweeper telling someone when a claim can never post.

-- ---------------------------------------------------------------------------
-- 1. The job.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full', 'expiry_sweep',
                 'notify_dispatch', 'notify_prune', 'expense_post'));

-- ---------------------------------------------------------------------------
-- 2. The signal for a claim that can never post.
-- ---------------------------------------------------------------------------
-- `RepNotMappedToEmployeeError` will not fix itself on a timer: the rep has no
-- `erp_employee_id`, so there is no `Employee` to hang an `Expense` on, and every sweep
-- from now until somebody reconciles `crm.rep_profile` will refuse the same claim. Skipping
-- it quietly every five minutes is how a rep never gets paid and nobody finds out.
--
-- `erp_write_failed` was the near-enough kind and is refused, as 0029 refused the last one.
-- That kind means a row reached `crm.outbox` and the ERP turned it down permanently — it
-- deep-links to the outbox row, it tells the rep something they believe already happened
-- did not, and it says the write will not be retried. Here no row was ever enqueued, the
-- rep's app correctly shows the claim as approved rather than sent, and the posting WILL be
-- retried on every pass once the mapping exists. All three halves would be lies.
ALTER TABLE crm.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE crm.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN (
    'disposal_obligation_raised',
    'disposal_obligation_overdue',
    'call_plan_submitted',
    'call_plan_approved',
    'call_plan_returned',
    'sample_transfer_awaiting_acceptance',
    'sample_transfer_recalled',
    'erp_write_failed',
    'expense_post_blocked'
  ));

-- ---------------------------------------------------------------------------
-- 3. `crm.expense_claim` becomes a subject the retention prune understands.
-- ---------------------------------------------------------------------------
-- 0024 counts a notification whose `subject_table` has no branch here as
-- `unknown_subjects` and prunes it "on the assumption that nothing is waiting on it",
-- counting it precisely so that a producer missing a branch is discovered rather than
-- inferred. A blocked claim IS something waiting, so without this branch the new kind
-- would make that counter non-zero for a producer that is wired correctly — and the
-- counter would stop meaning what 0024 built it to mean.
--
-- Both functions are restated in full, which is what CREATE OR REPLACE requires: the
-- other four branches are 0024's, unchanged.
CREATE OR REPLACE FUNCTION crm.notification_subject_open(
  p_subject_table text,
  p_subject_id    uuid
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE p_subject_table
    -- A regulated disposal nobody has completed. The notification is how the rep knows.
    WHEN 'crm.disposal_obligation' THEN EXISTS (
      SELECT 1 FROM crm.disposal_obligation o
       WHERE o.id = p_subject_id AND o.status IN ('open', 'overdue'))
    -- A write the rep believes landed and never did. 0022 raises this; until the row is
    -- revived or abandoned, it is the only thing saying so.
    WHEN 'crm.outbox' THEN EXISTS (
      SELECT 1 FROM crm.outbox b
       WHERE b.id = p_subject_id AND b.state = 'dead')
    -- Material in transit: a transfer_out with no acceptance recorded against it. The
    -- same predicate `outstandingTransfers` uses, so the two cannot disagree.
    WHEN 'crm.sample_transaction' THEN EXISTS (
      SELECT 1 FROM crm.sample_transaction t
       WHERE t.id = p_subject_id AND t.kind = 'transfer_out'
         AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction a WHERE a.transfer_of = t.id))
    -- A plan still waiting on an approver. `draft` is not open in this sense: nobody is
    -- waiting on a draft, and its author can see it in their own list.
    WHEN 'crm.call_plan' THEN EXISTS (
      SELECT 1 FROM crm.call_plan p
       WHERE p.id = p_subject_id AND p.status = 'submitted')
    -- A claim the sweeper could not hand over. `approved` is the one open state: a rep is
    -- owed money and the ERP has not been told. Every other state is settled — `posted`
    -- and `reimbursed` succeeded, `rejected` and `draft` are not owed.
    WHEN 'crm.expense_claim' THEN EXISTS (
      SELECT 1 FROM crm.expense_claim c
       WHERE c.id = p_subject_id AND c.state = 'approved')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION crm.notification_subject_unknown(p_subject_table text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject_table IS NOT NULL
     AND p_subject_table NOT IN ('crm.disposal_obligation', 'crm.outbox',
                                 'crm.sample_transaction', 'crm.call_plan',
                                 'crm.expense_claim');
$$;
