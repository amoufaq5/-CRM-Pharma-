export const EXPENSE_CLAIM_STATES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "posted",
  "reimbursed",
] as const;
export type ExpenseClaimState = (typeof EXPENSE_CLAIM_STATES)[number];

/**
 * Which state changes are legitimate.
 *
 * The list mirrors 0006's `state` CHECK exactly — the same six values in the same
 * order — because a value this map does not know about would be a state the database
 * accepts and nothing here can move, and the index on `(tenant_id, state, incurred_on)`
 * would quietly accumulate it.
 *
 * Three shapes are deliberate:
 *
 * - **`rejected` is reachable only from `submitted`.** Once the CRM has approved a
 *   claim it has snapshotted an account code and handed the posting to the outbox;
 *   un-approving it would need the ERP side reversed, which is a credit note's job and
 *   not a state change. A claim that should not have been approved is corrected by a
 *   reversing entry in the ledger, not by editing history here. (The ERP's own
 *   `Expense.reject` does accept `approved`, which is the looser of the two rules; the
 *   CRM owns the approval graph per ADR-0001 item 11, so the CRM's holds.)
 * - **`posted` sits between `approved` and `reimbursed`.** `approved` is the human
 *   decision; `posted` is "handed to the ERP". 0006's `idx_expense_claim_unsent`
 *   indexes exactly `state = 'approved' AND erp_journal_entry_id IS NULL`, which only
 *   makes sense if approving and posting are separate acts — a late claim waits for an
 *   open period rather than blocking the approver.
 * - **`rejected` and `reimbursed` are terminal.** A correction is a new claim.
 */
export const EXPENSE_CLAIM_TRANSITIONS: Readonly<
  Record<ExpenseClaimState, readonly ExpenseClaimState[]>
> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected"],
  approved: ["posted"],
  rejected: [],
  posted: ["reimbursed"],
  reimbursed: [],
};

/** The states 0006's `expense_claim_approved_fields` CHECK requires `approved_at` for. */
export const APPROVED_STATES: readonly ExpenseClaimState[] = ["approved", "posted", "reimbursed"];

/**
 * States that must carry a snapshotted S&M account code.
 *
 * 0006 phrases its CHECK as `state = 'draft' OR erp_ledger_account_code IS NOT NULL`,
 * so this is every state but `draft` — including `rejected`, which is why the snapshot
 * happens at submit and is never cleared on the way out.
 */
export const SNAPSHOT_REQUIRED_STATES: readonly ExpenseClaimState[] = EXPENSE_CLAIM_STATES.filter(
  (s) => s !== "draft",
);

export class InvalidExpenseClaimTransitionError extends Error {
  constructor(
    readonly from: ExpenseClaimState,
    readonly to: ExpenseClaimState,
  ) {
    const allowed = EXPENSE_CLAIM_TRANSITIONS[from];
    super(
      allowed.length === 0
        ? `a ${from} expense claim is final and cannot become ${to}; raise a new claim instead`
        : `cannot move an expense claim from ${from} to ${to} (allowed: ${allowed.join(", ")})`,
    );
    this.name = "InvalidExpenseClaimTransitionError";
  }
}

export function isExpenseClaimState(value: string): value is ExpenseClaimState {
  return (EXPENSE_CLAIM_STATES as readonly string[]).includes(value);
}

export function canTransitionExpenseClaim(from: ExpenseClaimState, to: ExpenseClaimState): boolean {
  return EXPENSE_CLAIM_TRANSITIONS[from].includes(to);
}

export function assertExpenseClaimTransition(
  from: ExpenseClaimState,
  to: ExpenseClaimState,
): void {
  if (!canTransitionExpenseClaim(from, to)) {
    throw new InvalidExpenseClaimTransitionError(from, to);
  }
}

export function isFinalExpenseClaimState(state: ExpenseClaimState): boolean {
  return EXPENSE_CLAIM_TRANSITIONS[state].length === 0;
}

/** Whether `expense_claim_approved_fields` requires `approved_at` in this state. */
export function requiresApproval(state: ExpenseClaimState): boolean {
  return APPROVED_STATES.includes(state);
}

/** Whether `expense_claim_snapshot_before_submit` requires an account code in this state. */
export function requiresAccountSnapshot(state: ExpenseClaimState): boolean {
  return state !== "draft";
}
