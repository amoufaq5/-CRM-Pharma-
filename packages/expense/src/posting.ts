import { erpDecimal } from "@crm/acl";
import type { PoolClient } from "pg";
import type { Expense } from "@crm/acl";
import { enqueueOutbox } from "@crm/relay";

import { ErpWriteDeadLetteredError } from "./errors.js";

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
 * FIELD NAMES are the GENERATED ones. `packages/acl/schema/baseline.json` is now a
 * capture of a real `operate-server` serving `pack-erp-core` — all 51 entities, not the
 * two the first hand-written fixture had — so `packages/acl/src/generated/erp.ts` carries
 * an `Expense` interface and the create payload below is typed against it. A field this
 * file misspells, or a `category` outside the seven the ERP admits, is now a compile
 * error rather than a dead letter three weeks later.
 *
 * The entity NAME is still all the outbox carries, and nothing here hand-writes a path: a
 * tenant whose served manifest lacks `Expense` fails closed when `slugFor` cannot answer.
 * `StockMovement` in `packages/sample/src/erp-mirror.ts` follows the same rule.
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
 *     not reachable over the HTTP API.
 *
 *     CORRECTION, from the captured schema: there IS a code → id path for the DEBIT.
 *     `LedgerAccount.account_code` is both filterable and sortable, so
 *     `GET /v1/ledger-accounts?account_code[eq]=6200` resolves it over the ordinary API —
 *     an earlier version of this comment said no path existed at all, and that was wrong.
 *     What is still true is that the CRM has nothing to resolve against OFFLINE:
 *     `packages/sync` projects `Item`, `Employee` and `Account` and no ledger accounts, so
 *     the resolution would be a synchronous ERP read on the posting path.
 *
 *     The COST CENTRE has no path, and that is the sharper problem. `CostCenter`'s only
 *     filterable fields are `parent_id` and `manager_id` — `code` is NOT among them — and
 *     the ERP DROPS a filter it does not recognise rather than refusing it, so
 *     `?code[eq]=CC-SM` returns the first cost centre in the tenant and looks like a hit.
 *     A journal entry attributed to a silently wrong cost centre is exactly the class of
 *     error this file refuses to risk.
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

/**
 * The create payload, typed against the ERP's own `Expense`.
 *
 * `id` and `expense_number` are omitted because both are server-allocated — the latter is
 * an `EXP-{YYYY}-{SEQ:5}` sequence reset yearly, and supplying one would collide with the
 * ERP's. `receipt` is omitted because the CRM's `receipt_url` is a CRM-side URL, not an
 * ERP file handle.
 */
export type ErpExpenseCreatePayload = Omit<Expense, "id" | "expense_number" | "receipt">;

export interface ErpExpenseCreate {
  readonly entity: typeof ERP_EXPENSE_ENTITY;
  readonly operation: "create";
  readonly targetRecordId: string;
  readonly payload: ErpExpenseCreatePayload;
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
 * And the two transitions would need the relay to order them, which is a guarantee this
 * design does not have to ask for. Both of the reasons it originally could not have been
 * asked for are now fixed at their source — `classify` reads the ERP's
 * `invalid_transition` code and answers `retry_ordering` instead of mapping every 409 to
 * `already_delivered`, and `claimBatch` orders by the `seq` 0027 added rather than by a
 * `created_at` that three rows written in one transaction share. So ordering is no longer
 * the objection. The objection that remains is simpler and does not expire: one row cannot
 * be out of order with itself, and a design that needs no ordering guarantee cannot be
 * broken by one regressing.
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
      // A NUMBER, and the comment this replaces cited README rule 4 for the opposite —
      // which is rule 4 applied in the wrong direction. Rule 4 is about money coming FROM
      // the ERP: there the destination is a `NUMERIC` column of arbitrary precision and a
      // double in between can only lose, so the text never gets converted. Here the
      // destination is a field the ERP's own schema calls a `decimal`, and
      // `operate-runtime/src/validation.ts` stores what it was SENT without coercing — so a
      // string lands in a numeric field and stays there, correct only while that validator
      // keeps accepting one.
      //
      // `erpDecimal` is where the precision argument is actually answered: `JSON.stringify`
      // writes the shortest decimal that parses back to the same double, so every value a
      // `numeric(14,2)` column admits crosses exactly, and anything that would not is
      // refused by name rather than rounded.
      amount: erpDecimal("amount", claim.amount),
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
 * Enqueues one of this claim's ERP writes, or refuses because the last one is dead.
 *
 * THE DISTINCTION THIS EXISTS FOR. `enqueueOutbox` reports the state of the row a
 * duplicate collapsed ONTO, and three of the four states mean the intent is alive:
 * `pending` is queued, `in_flight` is being dispatched now, `delivered` is already at the
 * ERP. All three are the ordinary double-tap the idempotency key is for, and all three
 * stay silent — returning `false` exactly as before, because nothing has gone wrong.
 *
 * `dead` is the fourth and it is not a duplicate in any useful sense. The relay has
 * stopped retrying that row, nothing else ever will, and this enqueue changed nothing at
 * all. Reported as a refusal rather than as `false`, because the caller's next act is to
 * mark the claim handed over — see `ErpWriteDeadLetteredError` for why that must not
 * happen. Refusing HERE rather than at each caller is deliberate: both callers must
 * refuse, and a single `boolean` return for both outcomes is how the distinction was lost
 * in the first place.
 *
 * The extra SELECT runs only on the dead path, where one more round trip is free and the
 * reason is what somebody needs in order to act.
 */
async function enqueueClaimWrite(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  row: ErpExpenseCreate | ErpExpenseTransition,
): Promise<boolean> {
  const { enqueued, id, state } = await enqueueOutbox(tx, tenantId, {
    entity: row.entity,
    operation: row.operation,
    payload: { ...row.payload },
    targetRecordId: row.targetRecordId,
    sourceTable: EXPENSE_SOURCE_TABLE,
    sourceId: claimId,
  });
  if (state !== "dead") return enqueued;

  const { rows } = await tx.query<{ dead_reason: string | null; revive_count: number }>(
    `SELECT dead_reason, revive_count FROM crm.outbox WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  throw new ErpWriteDeadLetteredError(
    claimId,
    id,
    row.entity,
    row.operation,
    rows[0]?.dead_reason ?? null,
    rows[0]?.revive_count ?? 0,
  );
}

/**
 * Appends the `Expense` create to the outbox inside the caller's transaction.
 *
 * One transaction with the claim's own state change is the whole reason the outbox
 * exists: a claim that committed as `posted` without its outbox row would be a
 * reimbursement the ERP never hears about, and an outbox row without the state change
 * would post the same claim again on the next sweep.
 *
 * Returns false when the row was already there and still live — a double-tap, or a
 * replayed offline batch. `crm.outbox` is unique on
 * `(tenant_id, entity, operation, target_record_id)` and `enqueueOutbox` reads that
 * conflict as a no-op. THROWS `ErpWriteDeadLetteredError` when the row it collapsed onto
 * is dead, which is the one case where a no-op is not harmless.
 */
export async function enqueueExpenseCreate(
  tx: PoolClient,
  tenantId: string,
  claim: PostableClaim,
  erpEmployeeId: string,
): Promise<boolean> {
  return enqueueClaimWrite(tx, tenantId, claim.id, buildExpenseCreate(claim, erpEmployeeId));
}

/**
 * Appends the `reimburse` transition, in the transaction that marks the claim reimbursed.
 *
 * Refuses on a dead collapse for the same reason the create does, and the consequence is
 * sharper: nothing sweeps reimbursements. A claim marked `reimbursed` against a dead
 * transition would be terminal in the CRM — `reimbursed` has no outgoing transition — with
 * the ERP's `Expense` left in `approved` forever and no job that would ever notice.
 */
export async function enqueueExpenseReimburse(
  tx: PoolClient,
  tenantId: string,
  claimId: string,
  erpExpenseId: string,
): Promise<boolean> {
  return enqueueClaimWrite(tx, tenantId, claimId, buildExpenseReimburse(erpExpenseId));
}
