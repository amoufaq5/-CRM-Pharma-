import { withTenantContext } from "@crm/db";
import { raiseForSupervisors, raiseNotification, type NotificationKind } from "@crm/notify";
import type { PoolClient } from "pg";

import { ExpenseClaimNotFoundError, RepNotMappedToEmployeeError } from "./errors.js";
import { InvalidExpenseClaimTransitionError } from "./states.js";
import { postClaim, unpostedApprovedClaims, type ExpenseClaim } from "./store.js";

/**
 * The sweep that hands approved claims to the ERP without waiting for a button.
 *
 * ADR-0001 recorded the gap: approving and posting are separate acts on purpose — 0006's
 * `idx_expense_claim_unsent` indexes "approved, not yet handed over", which only means
 * something if they are — but nothing ever performed the second one except a human
 * calling `POST /v1/expenses/{id}/post`. So a rep's reimbursement started when an
 * administrator remembered it.
 *
 * TAKES A CLIENT, NOT A TRANSACTION, which is the one place this file departs from the
 * house signature. Every other store function in this package takes a `PoolClient`
 * already inside `withTenantContext`; this one opens a transaction PER CLAIM, because a
 * sweep that wrapped twenty postings in one transaction would roll back nineteen good
 * ones to refuse the twentieth. Handing it a client that is already in tenant context is
 * refused rather than tolerated: a nested `BEGIN` is a warning, not an error, and the
 * inner `COMMIT` would then commit the CALLER's transaction half-finished.
 *
 * IDEMPOTENCE IS NOT IMPLEMENTED HERE. Two mechanisms already carry it and a third would
 * only be a way for them to disagree: `postClaim` refuses a claim that is not `approved`,
 * and the outbox row's target id is derived from the claim's uuid, so `enqueueOutbox`
 * collapses a redelivery into a no-op. A second pass over a posted claim therefore does
 * not even see it — `unpostedApprovedClaims` selects on `state = 'approved'`.
 *
 * ONE CLAIM'S REFUSAL IS NOT EVERY CLAIM'S. The rule the snapshot refresher follows, and
 * it matters more here: `RepNotMappedToEmployeeError` will not fix itself on a timer, so a
 * single rep with no `erp_employee_id` would otherwise block every other rep's money for
 * as long as the mapping stayed broken. Per-claim outcomes are reported and the job
 * summary carries the counts.
 */

/** Above any plausible per-pass approval volume; see `moreRemaining` for the backlog case. */
export const DEFAULT_SWEEP_LIMIT = 200;

/**
 * The signal for a claim that can never post. 0031 widens `crm.notification.kind` to
 * accept it, and `NOTIFICATION_KINDS` carries it, so this is a plain typed constant with
 * no assertion: the two lists agree and `subject-coverage.contract.test.ts` compares them
 * against `pg_constraint` on every run.
 */
export const EXPENSE_POST_BLOCKED_KIND: NotificationKind = "expense_post_blocked";

export type ExpensePostStatus = "posted" | "skipped" | "blocked" | "failed";

interface OutcomeBase {
  readonly claimId: string;
  readonly repProfileId: string;
}

export type ExpensePostOutcome =
  | (OutcomeBase & {
      readonly status: "posted";
      /** Null only if something set `state = 'posted'` without minting one — see 0006. */
      readonly erpExpenseId: string | null;
      /** False when the outbox already held this write — a replay, not a second ERP record. */
      readonly enqueued: boolean;
    })
  /** The row moved between the listing and the posting: a concurrent approver or the button. */
  | (OutcomeBase & { readonly status: "skipped"; readonly reason: string })
  /** Refused for something no later pass will fix on its own. Somebody has been told. */
  | (OutcomeBase & { readonly status: "blocked"; readonly reason: string; readonly notified: number })
  /** Refused for something that may not recur. Retried on the next pass. */
  | (OutcomeBase & { readonly status: "failed"; readonly reason: string });

export interface ExpensePostSweepResult {
  readonly considered: number;
  readonly posted: number;
  /** Postings whose outbox row was already there. Counted inside `posted`, not beside it. */
  readonly replayed: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly failed: number;
  /** In-app notifications raised, counting one per recipient. */
  readonly notified: number;
  /** The batch filled its limit, so there is more approved spend behind it. */
  readonly moreRemaining: boolean;
  readonly outcomes: readonly ExpensePostOutcome[];
}

export interface ExpensePostSweepOptions {
  /** The sweep's "now", stamped as `posted_at`. Injected so a test can stand on any date. */
  readonly asOf?: Date;
  /**
   * How many claims one pass may take. `unpostedApprovedClaims` caps it at 500, so a
   * larger value would make `moreRemaining` read false on a batch that was in fact full.
   */
  readonly limit?: number;
}

/**
 * The client is already inside somebody's tenant context, so it cannot own a transaction.
 *
 * Refused loudly because the alternative is silent: Postgres answers a nested `BEGIN`
 * with a warning and the first `COMMIT` would end the caller's transaction, committing
 * whatever it had done so far and leaving the rest of its work unwrapped.
 */
export class ClientAlreadyInTenantContextError extends Error {
  constructor(readonly tenantId: string) {
    super(
      `sweepApprovedExpenseClaims opens one transaction per claim and must be given a plain ` +
        `pool client, but this one already has app.current_tenant_id set (${tenantId}) — it is ` +
        `inside a withTenantContext transaction. Connect a client from the pool and pass that.`,
    );
    this.name = "ClientAlreadyInTenantContextError";
  }
}

export async function sweepApprovedExpenseClaims(
  client: PoolClient,
  tenantId: string,
  options: ExpensePostSweepOptions = {},
): Promise<ExpensePostSweepResult> {
  const { rows: guard } = await client.query<{ tenant: string | null }>(
    "SELECT current_setting('app.current_tenant_id', true) AS tenant",
  );
  const inherited = guard[0]?.tenant ?? null;
  if (inherited !== null && inherited !== "") {
    throw new ClientAlreadyInTenantContextError(inherited);
  }

  const now = options.asOf ?? new Date();
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

  // Listed in its own transaction, committed before the first posting. The list is a
  // snapshot and is allowed to go stale — a claim posted by the button in between comes
  // back as `skipped`, which is the honest outcome rather than a failure.
  const claims = await withTenantContext(client, tenantId, (tx) =>
    unpostedApprovedClaims(tx, tenantId, limit),
  );

  const outcomes: ExpensePostOutcome[] = [];
  for (const claim of claims) {
    outcomes.push(await postOne(client, tenantId, claim, now));
  }

  const count = (status: ExpensePostStatus): number =>
    outcomes.filter((o) => o.status === status).length;

  return {
    considered: claims.length,
    posted: count("posted"),
    replayed: outcomes.filter((o) => o.status === "posted" && !o.enqueued).length,
    skipped: count("skipped"),
    blocked: count("blocked"),
    failed: count("failed"),
    notified: outcomes.reduce((n, o) => n + (o.status === "blocked" ? o.notified : 0), 0),
    moreRemaining: claims.length >= limit,
    outcomes,
  };
}

async function postOne(
  client: PoolClient,
  tenantId: string,
  claim: ExpenseClaim,
  now: Date,
): Promise<ExpensePostOutcome> {
  const base = { claimId: claim.id, repProfileId: claim.rep_profile_id } as const;
  try {
    const result = await withTenantContext(client, tenantId, (tx) =>
      postClaim(tx, tenantId, claim.id, now),
    );
    return {
      ...base,
      status: "posted",
      erpExpenseId: result.claim.erp_expense_id,
      enqueued: result.enqueued,
    };
  } catch (err) {
    if (err instanceof RepNotMappedToEmployeeError) {
      return await blockedOutcome(client, tenantId, claim, err, base);
    }
    // The row moved under the listing. Not a failure: the claim is posted, or was
    // rejected, and either way this pass had nothing left to do with it.
    if (
      err instanceof InvalidExpenseClaimTransitionError ||
      err instanceof ExpenseClaimNotFoundError
    ) {
      return { ...base, status: "skipped", reason: trim(err.message) };
    }
    return { ...base, status: "failed", reason: trim(String(err)) };
  }
}

/**
 * A claim that will be refused identically on every pass from now until a person acts.
 *
 * Telling someone is the whole point. Skipping it silently every five minutes is how a rep
 * never gets paid and nobody finds out — and the claim IS retried, so there is nothing
 * else in the system that would ever report this.
 *
 * Raised in a transaction OF ITS OWN: `postClaim`'s was rolled back by the refusal, so a
 * notification written inside it would have gone with it.
 */
async function blockedOutcome(
  client: PoolClient,
  tenantId: string,
  claim: ExpenseClaim,
  err: RepNotMappedToEmployeeError,
  base: { readonly claimId: string; readonly repProfileId: string },
): Promise<ExpensePostOutcome> {
  const reason = trim(err.message);
  try {
    const notified = await withTenantContext(client, tenantId, (tx) =>
      raiseBlockedClaim(tx, tenantId, claim),
    );
    return { ...base, status: "blocked", reason, notified };
  } catch (tellErr) {
    // A blocked claim nobody was told about must not read as handled. Reported as a plain
    // failure so the next pass refuses it again and tries the telling again.
    return {
      ...base,
      status: "failed",
      reason: `${reason} — and nobody could be told: ${trim(String(tellErr))}`,
    };
  }
}

async function raiseBlockedClaim(
  tx: PoolClient,
  tenantId: string,
  claim: ExpenseClaim,
): Promise<number> {
  const money = `${claim.currency} ${claim.amount}`;
  const detail = {
    kind: EXPENSE_POST_BLOCKED_KIND,
    // Scoped to the claim and the reason, with no date and no attempt count in it: the
    // sweep runs every five minutes and must tell them once, not 288 times a day.
    dedupKey: `expense-post:${claim.id}:unmapped-rep`,
    subjectTable: "crm.expense_claim",
    subjectId: claim.id,
    payload: {
      amount: claim.amount,
      currency: claim.currency,
      incurredOn: claim.incurred_on,
      crmCategory: claim.crm_category,
      erpLedgerAccountCode: claim.erp_ledger_account_code,
      repProfileId: claim.rep_profile_id,
    },
  } as const;

  const told = await raiseNotification(tx, tenantId, {
    ...detail,
    recipientRepProfileId: claim.rep_profile_id,
    // WARNING for the rep, where a dead letter is urgent for them. The severity follows
    // who can act, not who is affected: a rep cannot reconcile their own profile against
    // an ERP Employee record, and an urgent notification whose only possible response is
    // to wait for somebody else is how urgent stops meaning anything.
    severity: "warning",
    subject: `Approved expense not yet sent to the ERP: ${money}`,
    body:
      `Your ${money} claim from ${claim.incurred_on} is approved and nothing is lost, but it ` +
      `cannot be sent to the ERP yet: your profile is not linked to an ERP employee record. ` +
      `Your manager has been told. It will be sent automatically once the link is made.`,
  });

  const escalations = await raiseForSupervisors(tx, tenantId, claim.rep_profile_id, {
    ...detail,
    // URGENT up the chain, inverting the dead-letter pattern for the same reason the rep's
    // is only a warning: this is where the fix is, and it is blocking a payment.
    severity: "urgent",
    subject: `Reimbursement blocked: a rep has no ERP employee link (${money})`,
    body:
      `An approved ${money} expense claim from ${claim.incurred_on} cannot be posted because ` +
      `the rep's crm.rep_profile row has no erp_employee_id. Reconcile it against the ERP's ` +
      `Employee records (0003: employee_number is the join key); the next sweep will post the ` +
      `claim without anyone pressing anything.`,
  });

  // Only what was actually raised. Every pass after the first deduplicates against the
  // same key, and a count that included those would report the sweep telling people
  // something twelve times an hour when it told them once.
  return (told.created ? 1 : 0) + escalations.filter((e) => e.created).length;
}

/**
 * One line for the scheduler's log, naming the claims that did not post.
 *
 * The counts alone would make a pass with a permanently blocked claim indistinguishable
 * from a quiet one at a glance, and the claim id is what somebody needs to act.
 */
export function summariseExpensePostSweep(result: ExpensePostSweepResult): string {
  const named = result.outcomes
    .filter((o) => o.status === "blocked" || o.status === "failed")
    .slice(0, 5)
    .map((o) => `${o.claimId}:${o.status}`);
  return (
    `considered=${result.considered} posted=${result.posted} replayed=${result.replayed} ` +
    `skipped=${result.skipped} blocked=${result.blocked} failed=${result.failed} ` +
    `notified=${result.notified}` +
    (result.moreRemaining ? " more=true" : "") +
    (named.length > 0 ? ` | ${named.join(" ")}` : "")
  );
}

function trim(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}
