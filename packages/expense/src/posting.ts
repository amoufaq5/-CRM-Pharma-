import type { PoolClient } from "pg";
import { enqueueOutbox } from "@crm/relay";

/**
 * What a settled expense claim becomes at the ERP.
 *
 * Everything here goes through the OUTBOX — README rule 2 — so the ERP's RBAC,
 * write-guards, period locks, sequences, audit and GL effects all still run, and a
 * redelivery collapses into a unique violation on `(tenant_id, entity, record_id)` that
 * `packages/relay/src/outcome.ts` reads as success. Nothing in this file writes an ERP
 * table and nothing in it hand-writes a path: the entity NAME is all the outbox carries,
 * and `ErpClient` resolves the slug from the tenant's own `/v1/meta/schema` at dispatch
 * (README rule 3).
 *
 * FIELD NAMES come from `pack-erp-core/src/entities-finance.ts` (`EXPENSE_ENTITY`) in the
 * ERP repo, cross-read against `docs/ERP_INTEGRATION_REPORT.md` "Expense claims". They
 * are NOT in `packages/acl/schema/baseline.json`, which captured only `Item` and
 * `Opportunity`, so `packages/acl/src/generated/erp.ts` has no `Expense` interface to
 * type this against — see the report accompanying this package. The same is true of
 * `StockMovement` in `packages/sample/src/erp-mirror.ts`, which is the precedent this
 * follows: an entity the baseline does not cover is named, never pathed, and a tenant
 * whose served manifest lacks it fails closed when `slugFor` cannot answer.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO JOURNAL ENTRY HERE.
 *
 * ADR-0001 item 11 says the relay posts a balanced `JournalEntry` — debit the S&M
 * account, credit employee payable. It is not built, and not because it was skipped:
 * two of the three values it needs cannot be obtained without guessing, and a wrong
 * journal entry is worse than no journal entry.
 *
 *  1. `JournalLine.ledger_account_id` is `{kind: "reference", target: "LedgerAccount"}` —
 *     a RECORD ID. The CRM holds an account CODE, deliberately (0006; codes survive the
 *     record-id churn a JSONB-store reload causes). Item 11 says the code is "resolved at
 *     posting time via resolveAccountId", but `resolveAccountId` is a private function
 *     inside the ERP's own `write-effects.ts`, used by its invoice/bill postings; it is
 *     not reachable over the HTTP API. The CRM has no `crm.ledger_account_snapshot` to
 *     resolve against either — `packages/sync` projects `Item`, `Employee` and `Account`
 *     and nothing else. So there is no code → id path at all today.
 *
 *  2. There is no credit account anywhere to name. `FinanceSettings` has
 *     `apAccountCode` (the supplier AP control) and `cashAccountCode`, and no
 *     employee-reimbursements-payable code; `crm.expense_account_map` has ONE code
 *     column, which is the debit. Crediting `apAccountCode` would put an employee
 *     liability into the supplier AP control with no `Bill` behind it, so the AP
 *     subledger and the GL would disagree permanently. Crediting `cashAccountCode` would
 *     assert cash moved at posting, which it has not — `reimbursed` is a later state.
 *
 * The ERP's `journalPostingGuard` would reject a half-built entry as
 * `unbalanced_journal_entry`, which `classify` treats as fatal, so a guess would not even
 * fail quietly: it would dead-letter and raise `erp_write_failed` at the rep for a
 * finance misconfiguration they cannot fix. Blocking is the better refusal.
 *
 * What IS posted is the `Expense` record — "the `Expense` record is the claim", item 11 —
 * carrying the snapshotted S&M account and cost-centre codes in its `description`, so the
 * manual journal entry report R8 says an accountant must make is readable off the record
 * itself rather than reconstructed from the CRM.
 * ────────────────────────────────────────────────────────────────────────────────
 */

/** `EXPENSE_ENTITY.category` in pack-erp-core. Seven values, and that is all there is. */
export const ERP_EXPENSE_CATEGORIES = [
  "travel",
  "meals",
  "lodging",
  "supplies",
  "software",
  "training",
  "other",
] as const;
export type ErpExpenseCategory = (typeof ERP_EXPENSE_CATEGORIES)[number];

export const ERP_EXPENSE_ENTITY = "Expense";
export const EXPENSE_SOURCE_TABLE = "crm.expense_claim";

/**
 * The CRM category reduced to one the ERP's enum can hold.
 *
 * An EXACT match on the ERP's own seven values passes through; anything else becomes
 * `other`. That is not a lossy mapping invented here — 0006 states the CRM vocabulary is
 * "deliberately richer than the ERP's seven-value Expense.category enum, which cannot
 * express the things a field force actually spends on". Inventing a table of
 * correspondences (is a congress `travel` or `training`?) would put a judgement nobody
 * made into the ERP's reporting; `other` plus the real category in `description` keeps
 * the judgement where it belongs and still leaves a human-readable trace, exactly as
 * `erp-mirror.ts` does with a lot number it has nowhere structured to put.
 */
export function erpExpenseCategory(crmCategory: string): ErpExpenseCategory {
  return (ERP_EXPENSE_CATEGORIES as readonly string[]).includes(crmCategory)
    ? (crmCategory as ErpExpenseCategory)
    : "other";
}

/**
 * The deterministic ERP record id for a claim's `Expense`.
 *
 * Derived from the claim's own uuid, so a redelivery addresses the same ERP record and
 * collapses into a unique violation on `(tenant_id, entity, record_id)` — the durable
 * guarantee, not the gateway's in-memory `Idempotency-Key` store (report R6). A uuid
 * leaves this well inside the ERP's `^[A-Za-z0-9_-]{1,200}$`.
 */
export function expenseRecordId(claimId: string): string {
  return `crm-exp-${claimId}`;
}

/** The claim fields a posting needs. A subset of `ExpenseClaim`, so either can be passed. */
export interface PostableClaim {
  readonly id: string;
  readonly crm_category: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurred_on: string;
  readonly description: string | null;
  readonly erp_ledger_account_code: string | null;
  readonly erp_cost_center_code: string | null;
}

export interface ErpExpenseCreate {
  readonly entity: typeof ERP_EXPENSE_ENTITY;
  readonly operation: "create";
  readonly targetRecordId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ErpExpenseTransition {
  readonly entity: typeof ERP_EXPENSE_ENTITY;
  readonly operation: "transition:reimburse";
  readonly targetRecordId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const DESCRIPTION_MAX = 500;

/**
 * What the ERP record says about itself.
 *
 * The GL attribution travels here because it has nowhere else to go: `Expense` has no
 * `cost_center_id` and no account field (report R8), so without this the codes Finance
 * mapped would exist only in the CRM and the accountant making the manual entry would
 * have to come and ask. The claim id is included so an ERP row can be traced back
 * without the CRM's outbox.
 */
export function expenseDescription(claim: PostableClaim): string {
  const parts = [
    `CRM expense claim ${claim.id}`,
    `category ${claim.crm_category}`,
    `S&M account ${claim.erp_ledger_account_code ?? "unmapped"}`,
    claim.erp_cost_center_code !== null ? `cost centre ${claim.erp_cost_center_code}` : null,
    claim.description !== null && claim.description.length > 0 ? claim.description : null,
  ].filter((p): p is string => p !== null);
  const text = parts.join(" · ");
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * The `Expense` create for an approved claim.
 *
 * `state: "approved"` is sent rather than created in `draft` and then transitioned, for
 * two reasons that both point the same way.
 *
 * The approval record of truth is the CRM's. ADR-0001 item 11 put the approval graph here
 * because the ERP's is a flat role check with no hierarchy, no amount bands and no
 * separation of duties (report R7) — so firing `Expense.submit` then `Expense.approve`
 * from the service principal would add two audit rows saying the CRM approved its own
 * claim, which is theatre, not provenance. `approved_by` and `approved_at` on
 * `crm.expense_claim`, under a four-eyes CHECK, are the provenance.
 *
 * And the two transitions could not be relied on anyway. An invalid transition answers
 * **409** (`operate-runtime/src/handlers.ts`: `invalid_transition`), which
 * `classify` maps through `kind === "conflict"` to `already_delivered` — i.e. SUCCESS.
 * So an `approve` row delivered before its `submit` row would be marked delivered and
 * never retried, leaving the ERP record stuck in `submitted` with nothing to say so.
 * Three rows enqueued in one transaction share a `created_at` (Postgres `now()` is
 * transaction-start), so `claimBatch`'s `ORDER BY next_attempt_at, created_at` does not
 * order them. One row cannot be out of order with itself.
 *
 * `expense_number` is NOT sent: it is a server-allocated sequence
 * (`EXP-{YYYY}-{SEQ:5}`, reset yearly) and supplying one would collide with the ERP's own.
 */
export function buildExpenseCreate(
  claim: PostableClaim,
  erpEmployeeId: string,
): ErpExpenseCreate {
  return {
    entity: ERP_EXPENSE_ENTITY,
    operation: "create",
    targetRecordId: expenseRecordId(claim.id),
    payload: {
      employee_id: erpEmployeeId,
      category: erpExpenseCategory(claim.crm_category),
      // A string, never a number: float64 cannot represent every NUMERIC(14,2) the
      // column admits, and a rounded amount in an expense claim reads as authoritative
      // (README rule 4).
      amount: claim.amount,
      currency: claim.currency,
      incurred_on: claim.incurred_on,
      state: "approved",
      description: expenseDescription(claim),
    },
  };
}

/**
 * The `reimburse` transition for an already-created `Expense`.
 *
 * `approved → reimbursed` in the ERP's `Expense` lifecycle, which is why the create above
 * lands in `approved`: it is the only `from` state `reimburse` accepts.
 */
export function buildExpenseReimburse(erpExpenseId: string): ErpExpenseTransition {
  return {
    entity: ERP_EXPENSE_ENTITY,
    operation: "transition:reimburse",
    targetRecordId: erpExpenseId,
    payload: {},
  };
}

/**
 * Appends the `Expense` create to the outbox inside the caller's transaction.
 *
 * One transaction with the claim's own state change is the whole reason the outbox
 * exists: a claim that committed as `posted` without its outbox row would be a
 * reimbursement the ERP never hears about, and an outbox row without the state change
 * would post the same claim again on the next sweep.
 *
 * Returns false when the row was already there — a double-tap, or a replayed offline
 * batch. `crm.outbox` is unique on `(tenant_id, entity, operation, target_record_id)` and
 * `enqueueOutbox` reads that conflict as a no-op.
 */
export async function enqueueExpenseCreate(
  tx: PoolClient,
  tenantId: string,
  claim: PostableClaim,
  erpEmployeeId: string,
): Promise<boolean> {
  const row = buildExpenseCreate(claim, erpEmployeeId);
  const { enqueued } = await enqueueOutbox(tx, tenantId, {
    entity: row.entity,
    operation: row.operation,
    payload: { ...row.payload },
    targetRecordId: row.targetRecordId,
    sourceTable: EXPENSE_SOURCE_TABLE,
    sourceId: claim.id,
  });
  return enqueued;
}

/** Appends the `reimburse` transition, in the transaction that marks the claim reimbursed. */
export async function enqueueExpenseReimburse(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  erpExpenseId: string,
): Promise<boolean> {
  const row = buildExpenseReimburse(erpExpenseId);
  const { enqueued } = await enqueueOutbox(tx, tenantId, {
    entity: row.entity,
    operation: row.operation,
    payload: { ...row.payload },
    targetRecordId: row.targetRecordId,
    sourceTable: EXPENSE_SOURCE_TABLE,
    sourceId: claimId,
  });
  return enqueued;
}
