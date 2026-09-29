-- 0006_expense_claims.sql
--
-- ADR-0001 item 11 (Q6, resolved 2026-09-29): rep spend posts to a SEPARATE
-- Sales & Marketing expense account, which can optionally be hooked to a cost
-- centre. Not a cost-centre tag on the ERP's existing expense account, and not
-- per-campaign.
--
-- This is the ordinary JournalLine shape: `ledger_account_id` is required and
-- carries the S&M account; `cost_center_id` is optional and carries the
-- dimension. The ERP's FinanceSettings already has a single `expenseAccountCode`
-- for AP bills — overloading it would merge rep spend into supplier invoices in
-- the P&L, which is the thing a separate account exists to prevent.
--
-- Codes, not ids, are stored throughout: that is the ERP's own convention
-- (FinanceSettings holds `account_code` strings and resolves them to
-- LedgerAccount record ids at posting time via resolveAccountId), and a code
-- survives the record-id churn that a JSONB-store reload can cause.

CREATE TABLE crm.expense_account_map (
  tenant_id              uuid NOT NULL,

  -- The CRM's own category vocabulary, deliberately richer than the ERP's
  -- seven-value Expense.category enum (travel|meals|lodging|supplies|software|
  -- training|other), which cannot express the things a field force actually
  -- spends on.
  crm_category           text NOT NULL,

  -- The separate S&M account this category posts to: a LedgerAccount.account_code
  -- of account_type 'expense'. Several categories may share one account.
  erp_ledger_account_code text NOT NULL,

  -- Optional hook to a CostCenter.code. NULL means "post to the account with no
  -- cost-centre dimension", which is valid — JournalLine.cost_center_id is
  -- nullable — and is the right default until Finance names the codes.
  erp_cost_center_code   text,

  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, crm_category)
);

SELECT crm.apply_tenant_isolation('crm.expense_account_map');

CREATE TABLE crm.expense_claim (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,

  -- A real foreign key, because both sides are ours. The CRM-to-ERP references
  -- elsewhere cannot have one (ADR-0001 item 3); this one can, so it does.
  rep_profile_id     uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  crm_category       text NOT NULL,
  amount             numeric(14,2) NOT NULL CHECK (amount > 0),
  currency           char(3) NOT NULL,
  incurred_on        date NOT NULL,
  description        text,

  -- CRM-side object storage (report R9: the ERP's `files` package is contracts
  -- with no runtime, and Expense.receipt is an untyped JSONB column).
  receipt_url        text,

  -- The account and cost centre are SNAPSHOTTED from expense_account_map when
  -- the claim is submitted, not looked up at posting time. Re-mapping a category
  -- next quarter must not silently re-attribute a claim that has already been
  -- posted — history is what it was, and an accountant reading a journal entry
  -- needs it to still mean what it meant.
  erp_ledger_account_code text,
  erp_cost_center_code    text,

  state              text NOT NULL DEFAULT 'draft'
                       CHECK (state IN ('draft','submitted','approved','rejected','posted','reimbursed')),

  -- Set by the relay once the ERP accepts the write. Null until then; that gap
  -- is the eventual consistency the UI must show honestly.
  erp_expense_id       crm.erp_record_id,
  erp_journal_entry_id crm.erp_record_id,

  submitted_at       timestamptz,
  approved_at        timestamptz,
  approved_by        uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  posted_at          timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- The approval graph is the CRM's (ADR-0001 item 11 / report R7: the ERP's
  -- Expense workflow is a flat role check that never reads Employee.manager_id).
  -- Four-eyes is enforced here because nothing downstream will.
  CONSTRAINT expense_claim_four_eyes CHECK (approved_by IS NULL OR approved_by <> rep_profile_id),
  CONSTRAINT expense_claim_approved_fields
    CHECK ((state IN ('approved','posted','reimbursed')) = (approved_at IS NOT NULL)),
  CONSTRAINT expense_claim_snapshot_before_submit
    CHECK (state = 'draft' OR erp_ledger_account_code IS NOT NULL)
);

CREATE INDEX idx_expense_claim_rep    ON crm.expense_claim (tenant_id, rep_profile_id, state);
CREATE INDEX idx_expense_claim_state  ON crm.expense_claim (tenant_id, state, incurred_on);
CREATE INDEX idx_expense_claim_unsent ON crm.expense_claim (tenant_id)
  WHERE state = 'approved' AND erp_journal_entry_id IS NULL;

SELECT crm.apply_tenant_isolation('crm.expense_claim');
