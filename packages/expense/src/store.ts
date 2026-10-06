import type { PoolClient } from "pg";

import { EXPENSE_CATEGORY_MAX as CATEGORY_MAX, requireAccountMapping } from "./accounts.js";
import {
  ExpenseClaimNotFoundError,
  InvalidAmountError,
  InvalidCategoryError,
  InvalidCurrencyError,
  InvalidDateError,
  MissingErpExpenseIdError,
  RepNotMappedToEmployeeError,
  translateExpenseClaimError,
} from "./errors.js";
import {
  assertExpenseClaimTransition,
  isExpenseClaimState,
  type ExpenseClaimState,
} from "./states.js";
import {
  EXPENSE_SOURCE_TABLE,
  enqueueExpenseCreate,
  enqueueExpenseReimburse,
  expenseRecordId,
} from "./posting.js";

/**
 * Rep expense claims (0006).
 *
 * Every function takes a `PoolClient` already inside `withTenantContext`, like the rest
 * of the CRM's stores: RLS confines the queries, and a caller who forgets the wrapper
 * sees no rows rather than everyone's. The ERP write in `postClaim` and
 * `reimburseClaim` appends to `crm.outbox` in that same transaction and never calls the
 * ERP itself.
 */

export interface ExpenseClaim {
  readonly id: string;
  readonly rep_profile_id: string;
  readonly crm_category: string;
  /** A string, not a number — `NUMERIC(14,2)` outlives float64 (README rule 4). */
  readonly amount: string;
  readonly currency: string;
  readonly incurred_on: string;
  readonly description: string | null;
  readonly receipt_url: string | null;
  readonly erp_ledger_account_code: string | null;
  readonly erp_cost_center_code: string | null;
  readonly state: ExpenseClaimState;
  readonly erp_expense_id: string | null;
  readonly erp_journal_entry_id: string | null;
  readonly submitted_at: Date | null;
  readonly approved_at: Date | null;
  readonly approved_by: string | null;
  readonly rejected_at: Date | null;
  readonly rejected_by: string | null;
  readonly posted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateClaimInput {
  readonly repProfileId: string;
  readonly crmCategory: string;
  /** Decimal string. Not a number: see `InvalidAmountError` for why 'NaN' matters here. */
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
  readonly description?: string | null;
  readonly receiptUrl?: string | null;
}

/**
 * `amount` and `incurred_on` are cast to text on the way out on purpose. Money stays a
 * string from the database to the ERP (README rule 4) — float64 cannot represent every
 * `NUMERIC(14,2)` the column admits — and a `date` read as a JS `Date` acquires a
 * timezone it never had, which moves a claim incurred on the 1st into the previous month
 * for anyone west of UTC.
 */
const CLAIM_FIELDS = [
  "id",
  "rep_profile_id",
  "crm_category",
  "amount::text AS amount",
  "currency",
  "incurred_on::text AS incurred_on",
  "description",
  "receipt_url",
  "erp_ledger_account_code",
  "erp_cost_center_code",
  "state",
  "erp_expense_id::text AS erp_expense_id",
  "erp_journal_entry_id::text AS erp_journal_entry_id",
  "submitted_at",
  "approved_at",
  "approved_by",
  "rejected_at",
  "rejected_by",
  "posted_at",
  "created_at",
  "updated_at",
] as const;

const CLAIM_COLUMNS = CLAIM_FIELDS.join(", ");

/** The same list qualified, for the one statement whose FROM clause makes bare names ambiguous. */
const CLAIM_COLUMNS_C = CLAIM_FIELDS.map((f) => `c.${f}`).join(", ");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
/** Up to 12 integer digits and 2 decimals — the headroom `NUMERIC(14,2)` actually has. */
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;


/**
 * Three shape checks that the database cannot make, verified against the live cluster:
 *
 *  - `'NaN'::numeric > 0` is TRUE, so `CHECK (amount > 0)` admits NaN, and one NaN row
 *    turns every `sum(amount)` over the table into NaN.
 *  - `'us'::char(3)` is silently padded to `'us '` rather than refused, so a two-letter
 *    currency reaches the ERP looking like a code.
 *  - `0`, `0.00` and `00.0` are all `> 0`-false or lossy; the regex pins the format the
 *    ERP's `decimal(14,2)` validator will accept so a rejection happens here, in front
 *    of the person typing it, rather than as a dead letter three weeks later.
 */
function checkedInput(input: CreateClaimInput): CreateClaimInput {
  if (input.crmCategory.trim().length === 0 || input.crmCategory.length > CATEGORY_MAX) {
    throw new InvalidCategoryError(input.crmCategory);
  }
  // `/[1-9]/` and not `Number(input.amount) <= 0`. The float test was harmless given the
  // regex — the smallest positive value it admits is 0.01 — but it is the exact construct
  // README rule 4 forbids, in the one module whose own error class exists to explain why,
  // and it would quietly become wrong the moment the regex widened. Having passed
  // AMOUNT_RE the string is digits and at most one dot, so "contains a non-zero digit" is
  // "greater than zero", decided on the characters themselves.
  if (!AMOUNT_RE.test(input.amount) || !/[1-9]/.test(input.amount)) {
    throw new InvalidAmountError(input.amount);
  }
  if (!CURRENCY_RE.test(input.currency)) throw new InvalidCurrencyError(input.currency);
  if (!DATE_RE.test(input.incurredOn)) throw new InvalidDateError("incurredOn", input.incurredOn);
  return input;
}

export async function createClaim(
  tx: PoolClient,
  tenantId: string,
  input: CreateClaimInput,
): Promise<ExpenseClaim> {
  const checked = checkedInput(input);
  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `INSERT INTO crm.expense_claim
         (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on,
          description, receipt_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${CLAIM_COLUMNS}`,
      [
        tenantId,
        checked.repProfileId,
        checked.crmCategory,
        checked.amount,
        checked.currency,
        checked.incurredOn,
        checked.description ?? null,
        checked.receiptUrl ?? null,
      ],
    );
    return rows[0]!;
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

export async function getClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
): Promise<ExpenseClaim | null> {
  const { rows } = await tx.query<ExpenseClaim>(
    `SELECT ${CLAIM_COLUMNS} FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2`,
    [tenantId, claimId],
  );
  return rows[0] ?? null;
}

export async function requireClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
): Promise<ExpenseClaim> {
  const claim = await getClaim(tx, tenantId, claimId);
  if (claim === null) throw new ExpenseClaimNotFoundError(claimId);
  return claim;
}

export interface ListClaimsOptions {
  readonly states?: readonly ExpenseClaimState[];
  readonly limit?: number;
}

/** One rep's claims, newest spend first. Served by `idx_expense_claim_rep`. */
export async function listClaimsForRep(
  tx: PoolClient,
  tenantId: string,
  repProfileId: string,
  options: ListClaimsOptions = {},
): Promise<readonly ExpenseClaim[]> {
  const states = options.states ?? null;
  const { rows } = await tx.query<ExpenseClaim>(
    `SELECT ${CLAIM_COLUMNS} FROM crm.expense_claim
      WHERE tenant_id = $1 AND rep_profile_id = $2
        AND ($3::text[] IS NULL OR state = ANY($3::text[]))
      ORDER BY incurred_on DESC, created_at DESC
      LIMIT $4`,
    [tenantId, repProfileId, states, Math.max(1, Math.min(options.limit ?? 100, 500))],
  );
  return rows;
}

/**
 * Submits a draft claim, SNAPSHOTTING the account and cost-centre codes.
 *
 * The snapshot is the point and it is taken in one statement, joined against the live
 * mapping, so the codes written are the ones in force at this instant and no second
 * statement can observe a different mapping. 0006 chose the snapshot over a lookup at
 * posting time because re-mapping a category next quarter must not retroactively
 * re-attribute a claim already posted — history has to still mean what it meant.
 *
 * No active mapping means the claim does NOT move. The mapping is read first so the
 * refusal names the category and says what Finance has to do, rather than reporting an
 * empty UPDATE; a claim that cannot say which S&M account it belongs to has nothing to
 * post to, and 0006's `expense_claim_snapshot_before_submit` would refuse it anyway with
 * a constraint name instead of a sentence.
 */
export async function submitClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  now: Date,
): Promise<ExpenseClaim> {
  const claim = await requireClaim(tx, tenantId, claimId);
  assertExpenseClaimTransition(claim.state, "submitted");
  await requireAccountMapping(tx, tenantId, claim.crm_category);

  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `UPDATE crm.expense_claim c
          SET state = 'submitted',
              submitted_at = $3,
              erp_ledger_account_code = m.erp_ledger_account_code,
              erp_cost_center_code    = m.erp_cost_center_code,
              updated_at = now()
         FROM crm.expense_account_map m
        WHERE c.tenant_id = $1 AND c.id = $2 AND c.state = 'draft'
          AND m.tenant_id = c.tenant_id AND m.crm_category = c.crm_category AND m.is_active
        RETURNING ${CLAIM_COLUMNS_C}`,
      [tenantId, claimId, now],
    );
    if (rows[0] === undefined) throw await staleTransition(tx, tenantId, claimId, "submitted");
    return rows[0];
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

/**
 * Approves a submitted claim.
 *
 * Four-eyes is NOT re-checked here. `expense_claim_four_eyes` is a CHECK constraint, so
 * it holds for the offline-sync path and for a psql prompt too, and a second
 * implementation in TypeScript would eventually disagree with the one that decides. The
 * refusal is translated into `FourEyesViolationError` instead.
 */
export async function approveClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  approvedBy: string,
  now: Date,
): Promise<ExpenseClaim> {
  const claim = await requireClaim(tx, tenantId, claimId);
  assertExpenseClaimTransition(claim.state, "approved");
  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `UPDATE crm.expense_claim
          SET state = 'approved', approved_at = $4, approved_by = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND state = 'submitted'
        RETURNING ${CLAIM_COLUMNS}`,
      [tenantId, claimId, approvedBy, now],
    );
    if (rows[0] === undefined) throw await staleTransition(tx, tenantId, claimId, "approved");
    return rows[0];
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

/**
 * Rejects a submitted claim, recording WHO rejected it and when (0030).
 *
 * `approved_at` stays null, which `expense_claim_approved_fields` requires for every
 * state outside approved/posted/reimbursed; `rejected_at` is set, which
 * `expense_claim_rejected_fields` requires for this one. The actor goes in its own
 * column: writing it to `approved_by` was considered and refused, because a rejecter
 * stored in a column named `approved_by` reads as an approval to every query that does
 * not know better, including the four-eyes CHECK's own wording.
 *
 * Four eyes is not re-checked here, exactly as in `approveClaim` and for the same
 * reason — `expense_claim_reject_four_eyes` is a CHECK, so it holds for a psql prompt
 * too, and the refusal is translated rather than duplicated.
 */
export async function rejectClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  rejectedBy: string,
  now: Date,
): Promise<ExpenseClaim> {
  const claim = await requireClaim(tx, tenantId, claimId);
  assertExpenseClaimTransition(claim.state, "rejected");
  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `UPDATE crm.expense_claim
          SET state = 'rejected', rejected_at = $4, rejected_by = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND state = 'submitted'
        RETURNING ${CLAIM_COLUMNS}`,
      [tenantId, claimId, rejectedBy, now],
    );
    if (rows[0] === undefined) throw await staleTransition(tx, tenantId, claimId, "rejected");
    return rows[0];
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

export interface PostResult {
  readonly claim: ExpenseClaim;
  /**
   * False when the outbox already held this write — a replay, not a second ERP record.
   *
   * Only ever reported for a row that is still LIVE (`pending`, `in_flight` or
   * `delivered`). A replay that collapses onto a `dead` row does not come back as `false`:
   * it refuses with `ErpWriteDeadLetteredError`, because there is no live write behind it
   * for the replay to have collapsed into.
   */
  readonly enqueued: boolean;
}

/**
 * Hands an approved claim to the ERP.
 *
 * `erp_expense_id` is written HERE, not by the relay, because the CRM mints it: the
 * target record id is derived from the claim's own uuid and is what the ERP will carry
 * (0004). Waiting for a delivery callback would mean inventing one — the relay settles
 * rows against `crm.outbox` and has no per-producer hook — and would leave the claim
 * unable to say which ERP record it became. Whether that record EXISTS yet is a separate
 * question, and `claimPostingStatus` is how to ask it rather than inferring it from a
 * null id.
 *
 * `erp_journal_entry_id` stays null, and will until the GL posting has an account id to
 * debit and a credit account to name — see the header of `posting.ts`.
 *
 * REFUSES rather than posting when the outbox already holds this claim's `Expense` create
 * as a DEAD row. The claim then stays `approved`, which is the only state from which
 * anything retries it: the `expense_post` sweep looks at `approved` claims, and
 * `crm.notification_subject_open` treats an `approved` claim as the open thing a blocked
 * notification is about (0031). Marking it `posted` instead would settle it in the CRM
 * against a write the ERP will never hold, and `unpostedApprovedClaims` would never show
 * it again. See `ErpWriteDeadLetteredError`.
 */
export async function postClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  now: Date,
): Promise<PostResult> {
  const claim = await requireClaim(tx, tenantId, claimId);
  assertExpenseClaimTransition(claim.state, "posted");

  const { rows: reps } = await tx.query<{ erp_employee_id: string | null }>(
    `SELECT erp_employee_id FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2`,
    [tenantId, claim.rep_profile_id],
  );
  const erpEmployeeId = reps[0]?.erp_employee_id ?? null;
  if (erpEmployeeId === null) throw new RepNotMappedToEmployeeError(claim.rep_profile_id);

  const enqueued = await enqueueExpenseCreate(tx, tenantId, claim, erpEmployeeId);

  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `UPDATE crm.expense_claim
          SET state = 'posted', posted_at = $4, erp_expense_id = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND state = 'approved'
        RETURNING ${CLAIM_COLUMNS}`,
      [tenantId, claimId, expenseRecordId(claimId), now],
    );
    if (rows[0] === undefined) throw await staleTransition(tx, tenantId, claimId, "posted");
    return { claim: rows[0], enqueued };
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

/**
 * Marks a posted claim reimbursed and drives the ERP's `reimburse` transition.
 *
 * Enqueued as its own row at its own moment, never alongside the create — one outbox row
 * per CRM state change, so a transition can never be in flight ahead of the record it acts
 * on. That used to be load-bearing twice over: an invalid transition answers 409, and
 * `classify` read every 409 as `already_delivered`, so a transition delivered early was
 * recorded as a success that never happened. The relay no longer does that (it reads the
 * ERP's `invalid_transition` code and answers `retry_ordering`), and the rows now order by
 * `seq` rather than a shared `created_at` — so both of the original hazards are closed at
 * their source. The rule stays because it is still the right shape: one row cannot be out
 * of order with itself, and that holds without depending on either fix.
 *
 * Refuses on a dead `transition:reimburse` row, as `postClaim` does on a dead create, and
 * the claim stays `posted`. Nothing sweeps reimbursements, so this refusal is the only
 * thing between a dead transition and a claim that is terminal in the CRM while the ERP's
 * `Expense` sits in `approved` forever.
 */
export async function reimburseClaim(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
): Promise<PostResult> {
  const claim = await requireClaim(tx, tenantId, claimId);
  assertExpenseClaimTransition(claim.state, "reimbursed");
  if (claim.erp_expense_id === null) throw new MissingErpExpenseIdError(claimId);

  const enqueued = await enqueueExpenseReimburse(tx, tenantId, claimId, claim.erp_expense_id);

  try {
    const { rows } = await tx.query<ExpenseClaim>(
      `UPDATE crm.expense_claim
          SET state = 'reimbursed', updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND state = 'posted'
        RETURNING ${CLAIM_COLUMNS}`,
      [tenantId, claimId],
    );
    if (rows[0] === undefined) throw await staleTransition(tx, tenantId, claimId, "reimbursed");
    return { claim: rows[0], enqueued };
  } catch (err) {
    throw translateExpenseClaimError(err);
  }
}

/**
 * Approved claims that have not been handed to the ERP.
 *
 * The query 0006's `idx_expense_claim_unsent` was built for, matched to it exactly —
 * `state = 'approved' AND erp_journal_entry_id IS NULL` — so it reads the partial index
 * rather than the table. Oldest spend first: a claim against a month that is about to
 * close should go before one incurred yesterday.
 */
export async function unpostedApprovedClaims(
  tx: PoolClient,
  tenantId: string,
  limit = 100,
): Promise<readonly ExpenseClaim[]> {
  const { rows } = await tx.query<ExpenseClaim>(
    `SELECT ${CLAIM_COLUMNS} FROM crm.expense_claim
      WHERE tenant_id = $1 AND state = 'approved' AND erp_journal_entry_id IS NULL
      ORDER BY incurred_on, created_at
      LIMIT $2`,
    [tenantId, Math.max(1, Math.min(limit, 500))],
  );
  return rows;
}

export interface ErpWriteStatus {
  readonly entity: string;
  readonly operation: string;
  readonly state: string;
  readonly attempts: number;
  readonly dead_reason: string | null;
  readonly delivered_at: Date | null;
}

/**
 * Where this claim's ERP writes have actually got to.
 *
 * 0006 says the gap between a claim being posted and the ERP holding it "is the eventual
 * consistency the UI must show honestly". This is how: the claim's own `state` says what
 * the CRM decided, these rows say what the ERP has, and a `dead` row with a reason is the
 * one case where the two will never agree without someone acting.
 */
export async function claimPostingStatus(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
): Promise<readonly ErpWriteStatus[]> {
  // ORDER BY seq, not created_at. 0027 added the sequence precisely because now() is the
  // transaction timestamp: two outbox rows written in one transaction share created_at to
  // the microsecond and nothing orders them. A claim's create and reimburse happen in
  // different transactions today, so this query was right by accident; seq makes it right
  // by construction, and it is what the relay claims in.
  const { rows } = await tx.query<ErpWriteStatus>(
    `SELECT entity, operation, state, attempts, dead_reason, delivered_at
       FROM crm.outbox
      WHERE tenant_id = $1 AND source_table = $2 AND source_id = $3
      ORDER BY seq`,
    [tenantId, EXPENSE_SOURCE_TABLE, claimId],
  );
  return rows;
}

/**
 * Why a guarded UPDATE matched nothing.
 *
 * The state was read, found legal, and then the row moved — a concurrent approver, or two
 * taps of the same button. Re-read and report the transition that is actually illegal
 * now, so the caller sees "cannot move from approved to approved" rather than a silent
 * no-op that looks like success.
 */
async function staleTransition(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  to: ExpenseClaimState,
): Promise<Error> {
  const claim = await getClaim(tx, tenantId, claimId);
  if (claim === null) return new ExpenseClaimNotFoundError(claimId);
  const from = isExpenseClaimState(claim.state) ? claim.state : "draft";
  try {
    assertExpenseClaimTransition(from, to);
  } catch (err) {
    return err as Error;
  }
  return new Error(
    `expense claim ${claimId} did not move from ${from} to ${to}; the row changed under this transaction`,
  );
}
