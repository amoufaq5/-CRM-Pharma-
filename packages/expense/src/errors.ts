/**
 * The database refuses these, and the raw message is unhelpful to a caller.
 *
 * Each class corresponds to one rule in 0006. Translating rather than re-checking in
 * TypeScript is the house pattern (`packages/callplan/src/errors.ts`,
 * `packages/role/src/errors.ts`) and the reason holds here too: four-eyes is a CHECK
 * constraint, so it also holds for a psql prompt and for whatever writes this table
 * next, and a second implementation in TypeScript would eventually disagree with the
 * one that actually decides.
 */

export class ExpenseClaimNotFoundError extends Error {
  constructor(id: string) {
    super(`no expense claim ${id}`);
    this.name = "ExpenseClaimNotFoundError";
  }
}

/**
 * Finance has not mapped this CRM category to a Sales & Marketing ledger account.
 *
 * The refusal that makes ADR-0001 item 11's open question safe to leave open:
 * `crm.expense_account_map` is empty until Finance names the codes, and a claim that
 * cannot say which account it belongs to must not become a journal entry. Posting to a
 * guessed account is worse than not posting — an accountant can chase a missing claim,
 * but a claim sitting in the wrong account looks correct.
 */
export class UnmappedCategoryError extends Error {
  constructor(readonly crmCategory: string) {
    super(
      `expense category ${JSON.stringify(crmCategory)} has no active Sales & Marketing ` +
        `ledger-account mapping, so this claim cannot be submitted. Finance must add a row to ` +
        `crm.expense_account_map for ${JSON.stringify(crmCategory)} naming the ` +
        `LedgerAccount.account_code (account_type 'expense') it posts to, and optionally a ` +
        `CostCenter.code. Until then the claim stays in draft: posting it to a guessed account ` +
        `would mis-state the P&L (ADR-0001 item 11).`,
    );
    this.name = "UnmappedCategoryError";
  }
}

/** The approver is the rep whose claim it is. 0006's `expense_claim_four_eyes`. */
export class FourEyesViolationError extends Error {
  constructor(message: string) {
    super(
      `an expense claim cannot be approved by the rep who submitted it (four-eyes). ` +
        `The CRM enforces this because nothing downstream will — the ERP's Expense workflow is ` +
        `a flat role check with no separation of duties (report R7): ${message}`,
    );
    this.name = "FourEyesViolationError";
  }
}

/**
 * The rejecter is the rep whose claim it is. 0030's `expense_claim_reject_four_eyes`.
 *
 * Its own class rather than a reused `FourEyesViolationError`, for the same reason 0030
 * added two columns instead of overloading `approved_by`: a rejection reported as "cannot
 * be approved by the rep who submitted it" sends the reader looking for an approval that
 * was never attempted.
 */
export class RejectionFourEyesViolationError extends Error {
  constructor(message: string) {
    super(
      `an expense claim cannot be rejected by the rep who submitted it (four-eyes). ` +
        `Separation of duties applies to the refusal exactly as it does to the approval — a ` +
        `claimant who can reject their own claim decides both outcomes: ${message}`,
    );
    this.name = "RejectionFourEyesViolationError";
  }
}

/**
 * The claim has no snapshotted account code but is leaving `draft`.
 *
 * Reachable only by a writer that bypassed `submitClaim`; the store's own path snapshots
 * first. Kept as a distinct type so that writer gets told which rule it broke rather
 * than a constraint name.
 */
export class MissingAccountSnapshotError extends Error {
  constructor(message: string) {
    super(
      `an expense claim cannot leave draft without a snapshotted ledger account code — ` +
        `submit it through submitClaim, which takes the snapshot: ${message}`,
    );
    this.name = "MissingAccountSnapshotError";
  }
}

/** An approved/posted/reimbursed claim with no approval timestamp, or a rejected one with one. */
export class ApprovalFieldsError extends Error {
  constructor(message: string) {
    super(`approval state and approval timestamp disagree: ${message}`);
    this.name = "ApprovalFieldsError";
  }
}

/**
 * A rejected claim with no rejection timestamp, or an unrejected one carrying one.
 *
 * The counterpart to `ApprovalFieldsError`, over 0030's `expense_claim_rejected_fields`.
 * The two constraints cannot both be violated by one row: `state` is a single value and
 * the state sets are disjoint, so at most one of the timestamps is ever required.
 */
export class RejectionFieldsError extends Error {
  constructor(message: string) {
    super(`rejection state and rejection timestamp disagree: ${message}`);
    this.name = "RejectionFieldsError";
  }
}

/**
 * The amount is not a plain positive decimal.
 *
 * Checked in TypeScript, unusually for this repo, because `CHECK (amount > 0)` does NOT
 * catch it: `'NaN'::numeric > 0` is TRUE in Postgres — verified against the live cluster —
 * since NaN sorts above every non-NaN numeric. A claim for NaN would be accepted by 0006
 * and would then poison every sum over the table.
 */
export class InvalidAmountError extends Error {
  constructor(readonly value: string) {
    super(
      `amount must be a positive decimal with at most 2 places, got ${JSON.stringify(value)} ` +
        `(note: 'NaN' passes 0006's CHECK (amount > 0), which is why this is refused here)`,
    );
    this.name = "InvalidAmountError";
  }
}

/**
 * The currency is not three uppercase letters.
 *
 * Also a TypeScript check, for the same reason: `currency` is `char(3)`, and
 * `'us'::char(3)` is silently padded rather than rejected — verified live. A two-letter
 * currency would reach the ERP as `'us '` and read as a code that does not exist.
 */
export class InvalidCurrencyError extends Error {
  constructor(readonly value: string) {
    super(
      `currency must be a 3-letter uppercase ISO-4217 code, got ${JSON.stringify(value)} ` +
        `(char(3) pads a shorter value rather than refusing it)`,
    );
    this.name = "InvalidCurrencyError";
  }
}

export class InvalidDateError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`${field} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
    this.name = "InvalidDateError";
  }
}

/**
 * The rep has no `erp_employee_id`, so there is nothing to hang the ERP `Expense` on.
 *
 * `Expense.employee_id` is a required reference to `Employee`. A null here means the
 * mapping in 0003 was never reconciled, or was reconciled and the Employee could not be
 * found — an orphan. Either way the posting is refused rather than sent with a null
 * reference, which the ERP would reject as `validation_failed` and the relay would
 * dead-letter against the rep.
 */
export class RepNotMappedToEmployeeError extends Error {
  constructor(readonly repProfileId: string) {
    super(
      `rep ${repProfileId} has no erp_employee_id, so an ERP Expense cannot be created for ` +
        `their claim. Reconcile crm.rep_profile against the ERP's Employee records first ` +
        `(0003: employee_number is the join key).`,
    );
    this.name = "RepNotMappedToEmployeeError";
  }
}

/**
 * The claim was posted but carries no ERP record id to address.
 *
 * Only reachable if something set `state = 'posted'` without going through `postClaim`.
 * Refused rather than re-minted: re-minting would be guessing which ERP record this
 * claim became, and the deterministic id is the only thing making redelivery safe.
 */
export class MissingErpExpenseIdError extends Error {
  constructor(readonly claimId: string) {
    super(
      `expense claim ${claimId} is posted but has no erp_expense_id, so there is no ERP record ` +
        `to transition. It was moved to 'posted' by something other than postClaim.`,
    );
    this.name = "MissingErpExpenseIdError";
  }
}

/**
 * An account or cost-centre code that could not be an ERP one.
 *
 * `LedgerAccount.account_code` and `CostCenter.code` are both `text` with
 * `maxLength: 32` in `pack-erp-core`, so a longer value is a 422 at posting time —
 * weeks after Finance typed it, against a claim a rep is waiting on. Refused when the
 * mapping is written instead, which is when someone is there to fix it.
 */
export class InvalidAccountCodeError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `${field} must be 1-32 characters with no surrounding whitespace, got ` +
        `${JSON.stringify(value)} (pack-erp-core declares both LedgerAccount.account_code and ` +
        `CostCenter.code as text maxLength 32)`,
    );
    this.name = "InvalidAccountCodeError";
  }
}

/** A CRM category that is blank or only whitespace — it would key a row nothing can find. */
export class InvalidCategoryError extends Error {
  constructor(readonly value: string) {
    super(`crm_category must be 1-120 non-blank characters, got ${JSON.stringify(value)}`);
    this.name = "InvalidCategoryError";
  }
}

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

/** Recognises 0006's and 0030's refusals. Anything unrecognised passes through unchanged. */
export function translateExpenseClaimError(err: unknown): Error {
  const e = err as PgErrorShape;
  const message = e?.message ?? "";
  const constraint = e?.constraint ?? "";

  // The two reject constraints are matched BEFORE their approve counterparts. Neither
  // name is a substring of the other today, but they differ by one infix and the
  // approve branches match on substrings — so a future rename is one letter away from
  // reporting a rejection as a failed approval.
  if (
    constraint === "expense_claim_reject_four_eyes" ||
    message.includes("expense_claim_reject_four_eyes")
  ) {
    return new RejectionFourEyesViolationError(message);
  }
  if (
    constraint === "expense_claim_rejected_fields" ||
    message.includes("expense_claim_rejected_fields")
  ) {
    return new RejectionFieldsError(message);
  }
  if (constraint === "expense_claim_four_eyes" || message.includes("expense_claim_four_eyes")) {
    return new FourEyesViolationError(message);
  }
  if (
    constraint === "expense_claim_snapshot_before_submit" ||
    message.includes("expense_claim_snapshot_before_submit")
  ) {
    return new MissingAccountSnapshotError(message);
  }
  if (
    constraint === "expense_claim_approved_fields" ||
    message.includes("expense_claim_approved_fields")
  ) {
    return new ApprovalFieldsError(message);
  }
  // 23514 is a CHECK violation; the only unnamed one on this table is `amount > 0`.
  if (e?.code === "23514" && message.includes("amount")) {
    return new InvalidAmountError("<= 0");
  }

  return err instanceof Error ? err : new Error(String(err));
}
