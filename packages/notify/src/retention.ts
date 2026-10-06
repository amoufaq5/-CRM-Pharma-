/**
 * How long an inbox keeps things, and the sweep that enforces it.
 *
 * The rules themselves are in migration 0024 — the two horizons, the open-subject
 * exemption, and what counts as open per producer table. This module is the orchestration
 * and the reporting around them.
 */
import type { PoolClient } from "pg";

export interface NotificationPolicy {
  readonly retain_read_days: number;
  readonly retain_unread_days: number;
}

export class InvalidRetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRetentionError";
  }
}

export const DEFAULT_RETAIN_READ_DAYS = 30;
export const DEFAULT_RETAIN_UNREAD_DAYS = 365;

/**
 * The THIRD horizon: how long the record of where a signal was pushed is kept (0046).
 *
 * A third projection of the same policy row rather than a third field on
 * `NotificationPolicy`, for the reason `PruneGuard` is one. The horizons above are what
 * every rep may read, because a rep whose notification disappeared is entitled to know it
 * was a rule. This one is not an answer to that question: `crm.notification_delivery`
 * records pushes to third-party endpoints that a rep cannot see and has no inbox entry for,
 * so it is an administrative setting about evidence, not about an inbox. Keeping it separate
 * also keeps `NotificationPolicy` the pair of numbers the retention API has always returned.
 *
 * The two are coupled in the database, not here: `notification_policy_delivery_not_shorter`
 * (0046) forbids a delivery horizon shorter than the unread one, so raising the unread
 * horizon past this number is refused with a sentence that says which to raise first.
 */
export interface DeliveryRetention {
  readonly retain_delivery_days: number;
}

/** 730 days. The argument for two years, and what it costs, is in 0046's header. */
export const DEFAULT_RETAIN_DELIVERY_DAYS = 730;

/**
 * The ceiling on how much of an inbox one pass may delete, and the way past it.
 *
 * Stored on `crm.notification_policy` beside the horizons but read separately, because
 * the two answer different questions: the horizons say what an inbox keeps — which every
 * rep may read, since a rep whose notification disappeared is entitled to know it was a
 * rule — and the guard says how fast the sweep is allowed to act, which is an operational
 * setting about one irreversible job. Keeping them apart also keeps `NotificationPolicy`
 * the pair of numbers the retention API has always returned.
 */
export interface PruneGuard {
  readonly prune_max_share_percent: number;
  readonly prune_guard_floor_rows: number;
  readonly prune_guard_override_by: string | null;
  readonly prune_guard_override_granted_at: Date | null;
  readonly prune_guard_override_until: Date | null;
}

export const DEFAULT_PRUNE_MAX_SHARE_PERCENT = 25;
export const DEFAULT_PRUNE_GUARD_FLOOR_ROWS = 100;

/** The longest window the CHECK in 0026 will accept, restated so a caller can say why. */
export const MAX_PRUNE_OVERRIDE_HOURS = 168;

/**
 * The ceiling on the FLOOR (0032).
 *
 * The floor short-circuits the share ceiling, so an unbounded one is a permanent,
 * unattributed, non-expiring override — the shape 0026 argues against and then shipped.
 * 1000 is ten times the default and bounds what a misconfigured floor can cost.
 */
export const MAX_PRUNE_GUARD_FLOOR_ROWS = 1000;

/**
 * `notification_policy_prune_override_named`'s character limit on the grantor (0026).
 *
 * Exported so the caller that BUILDS the attribution can fit it. `rep_profile.display_name`
 * and `subject` are unbounded `text`, so a long name or a long OIDC subject overflowed the
 * CHECK and surfaced as "a prune guard override must name who granted it" — the wrong
 * diagnosis for "the name is too long", and unactionable.
 */
export const MAX_PRUNE_OVERRIDE_BY_CHARS = 200;

const DEFAULT_GUARD: PruneGuard = {
  prune_max_share_percent: DEFAULT_PRUNE_MAX_SHARE_PERCENT,
  prune_guard_floor_rows: DEFAULT_PRUNE_GUARD_FLOOR_ROWS,
  prune_guard_override_by: null,
  prune_guard_override_granted_at: null,
  prune_guard_override_until: null,
};

const POLICY_COLUMNS = `retain_read_days, retain_unread_days, retain_delivery_days,
            prune_max_share_percent, prune_guard_floor_rows,
            prune_guard_override_by, prune_guard_override_granted_at,
            prune_guard_override_until`;

/** Every projection of the policy row, as one read. */
type PolicyRow = NotificationPolicy & PruneGuard & DeliveryRetention;

/**
 * The whole policy row, defaulting it into existence.
 *
 * Same shape as `disposalPolicy` in `@crm/sample`: a tenant that has never configured
 * retention gets the documented defaults rather than NULLs the caller has to interpret,
 * and the row exists afterwards so the admin route has something to update.
 *
 * One read for both projections below, so a prune that needs the horizons AND the guard
 * does not ask twice and cannot see two different versions of the same row.
 */
async function policyRow(tx: PoolClient, tenantId: string): Promise<PolicyRow> {
  await tx.query(`INSERT INTO crm.notification_policy (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
    tenantId,
  ]);
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM crm.notification_policy WHERE tenant_id = $1`,
    [tenantId],
  );
  return (
    rows[0] ?? {
      retain_read_days: DEFAULT_RETAIN_READ_DAYS,
      retain_unread_days: DEFAULT_RETAIN_UNREAD_DAYS,
      retain_delivery_days: DEFAULT_RETAIN_DELIVERY_DAYS,
      ...DEFAULT_GUARD,
    }
  );
}

/** The two horizons. */
export async function notificationPolicy(tx: PoolClient, tenantId: string): Promise<NotificationPolicy> {
  const row = await policyRow(tx, tenantId);
  return { retain_read_days: row.retain_read_days, retain_unread_days: row.retain_unread_days };
}

const projectGuard = (row: PruneGuard): PruneGuard => ({
  prune_max_share_percent: row.prune_max_share_percent,
  prune_guard_floor_rows: row.prune_guard_floor_rows,
  prune_guard_override_by: row.prune_guard_override_by,
  prune_guard_override_granted_at: row.prune_guard_override_granted_at,
  prune_guard_override_until: row.prune_guard_override_until,
});

/** The guard, defaulting the row into existence like the horizons do. */
export async function notificationPruneGuard(tx: PoolClient, tenantId: string): Promise<PruneGuard> {
  return projectGuard(await policyRow(tx, tenantId));
}

/** The delivery horizon, defaulting the row into existence like the horizons do. */
export async function notificationDeliveryRetention(
  tx: PoolClient,
  tenantId: string,
): Promise<DeliveryRetention> {
  const row = await policyRow(tx, tenantId);
  return { retain_delivery_days: row.retain_delivery_days };
}

/**
 * The retention CHECKs, as the sentences a 422 can carry.
 *
 * One map for all three horizons, rather than a prefix test per setter: the pairing
 * constraints are what a partial update trips, and a partial update to ANY horizon can trip
 * EITHER of them, so each setter has to be able to say the same two things.
 */
const RETENTION_CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  notification_policy_unread_not_shorter:
    "an unread notification must not be deleted sooner than a read one — " +
    "retainUnreadDays must be at least retainReadDays",
  // The inverse of the sentence above, one table over. Named from the delivery side because
  // that is the horizon being introduced, but a caller RAISING retainUnreadDays meets it
  // too, so the message says which number to move rather than only which rule broke.
  notification_policy_delivery_not_shorter:
    "the record of where a signal was pushed must not be deleted sooner than the " +
    "notification it describes — retainDeliveryDays must be at least retainUnreadDays; " +
    "raise retainDeliveryDays first",
};

/** Translates a retention CHECK into `InvalidRetentionError`, or rethrows. */
function retentionError(err: unknown): Error {
  const e = err as { constraint?: string };
  const known = e?.constraint === undefined ? undefined : RETENTION_CONSTRAINT_MESSAGES[e.constraint];
  if (known !== undefined) return new InvalidRetentionError(known);
  if (e?.constraint?.startsWith("notification_policy_retain") === true) {
    return new InvalidRetentionError("a retention period must be between 1 and 3650 days");
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Change the horizons.
 *
 * The "unread is never shorter" rule is the database's (0024). It is translated here
 * rather than re-checked, because a partial update — setting only `retainReadDays` to
 * something longer than the stored unread horizon — must be judged against the row as it
 * will be, and the CHECK is the only thing that sees that.
 */
export async function setNotificationPolicy(
  tx: PoolClient,
  tenantId: string,
  input: { retainReadDays?: number; retainUnreadDays?: number },
): Promise<NotificationPolicy> {
  await notificationPolicy(tx, tenantId);
  try {
    const { rows } = await tx.query<NotificationPolicy>(
      `UPDATE crm.notification_policy
          SET retain_read_days   = COALESCE($2, retain_read_days),
              retain_unread_days = COALESCE($3, retain_unread_days),
              updated_at         = now()
        WHERE tenant_id = $1
        RETURNING retain_read_days, retain_unread_days`,
      [tenantId, input.retainReadDays ?? null, input.retainUnreadDays ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw retentionError(err);
  }
}

/**
 * Change how long the record of a push is kept.
 *
 * Its own setter rather than a third option on `setNotificationPolicy`, matching the
 * projection: the two inbox horizons are one decision an administrator makes about storage,
 * and this is a decision about how long evidence of a disclosure to a third party is held.
 * The ranges and the pairing are the database's (0046), translated rather than re-checked
 * for the reason the others are — a partial update has to be judged against the row as it
 * will be, and the CHECK is the only thing that sees that.
 */
export async function setNotificationDeliveryRetention(
  tx: PoolClient,
  tenantId: string,
  input: { retainDeliveryDays: number },
): Promise<DeliveryRetention> {
  await policyRow(tx, tenantId);
  try {
    const { rows } = await tx.query<DeliveryRetention>(
      `UPDATE crm.notification_policy
          SET retain_delivery_days = $2,
              updated_at           = now()
        WHERE tenant_id = $1
        RETURNING retain_delivery_days`,
      [tenantId, input.retainDeliveryDays],
    );
    return rows[0]!;
  } catch (err) {
    throw retentionError(err);
  }
}

/**
 * Change the ceiling or the floor.
 *
 * The ranges are the database's (0026), translated here rather than re-checked, for the
 * same reason the horizons' are: a partial update has to be judged against the row as it
 * will be, and the CHECK is the only thing that sees that.
 */
export async function setNotificationPruneGuard(
  tx: PoolClient,
  tenantId: string,
  input: { maxSharePercent?: number; guardFloorRows?: number },
): Promise<PruneGuard> {
  await policyRow(tx, tenantId);
  return guardUpdate(
    tx,
    `UPDATE crm.notification_policy
        SET prune_max_share_percent = COALESCE($2, prune_max_share_percent),
            prune_guard_floor_rows  = COALESCE($3, prune_guard_floor_rows),
            updated_at              = now()
      WHERE tenant_id = $1
      RETURNING ${POLICY_COLUMNS}`,
    [tenantId, input.maxSharePercent ?? null, input.guardFloorRows ?? null],
  );
}

/**
 * Open the break-glass window, so the next few passes may take whatever they take.
 *
 * Deliberately awkward in three ways, because an override that is easy to set is not a
 * guard. It names its grantor. It is anchored to `now()` here, not to anything the caller
 * supplies, so the window cannot be backdated into a longer one than the CHECK allows.
 * And `hours` has no default — a caller that must state how long is a caller that has
 * thought about how long. The worst outcome of granting one and forgetting it is seven
 * days of unguarded prunes, not permanent ones.
 */
export async function grantPruneGuardOverride(
  tx: PoolClient,
  tenantId: string,
  input: { grantedBy: string; hours: number },
): Promise<PruneGuard> {
  await policyRow(tx, tenantId);
  return guardUpdate(
    tx,
    `UPDATE crm.notification_policy
        SET prune_guard_override_by         = $2,
            prune_guard_override_granted_at = now(),
            prune_guard_override_until      = now() + make_interval(hours => $3::int),
            updated_at                      = now()
      WHERE tenant_id = $1
      RETURNING ${POLICY_COLUMNS}`,
    [tenantId, input.grantedBy, input.hours],
  );
}

/** Close it early. The guard refuses again from the next pass. */
export async function revokePruneGuardOverride(tx: PoolClient, tenantId: string): Promise<PruneGuard> {
  await policyRow(tx, tenantId);
  return guardUpdate(
    tx,
    `UPDATE crm.notification_policy
        SET prune_guard_override_by         = NULL,
            prune_guard_override_granted_at = NULL,
            prune_guard_override_until      = NULL,
            updated_at                      = now()
      WHERE tenant_id = $1
      RETURNING ${POLICY_COLUMNS}`,
    [tenantId],
  );
}

/**
 * The guard's CHECKs, as the sentences a 422 can carry.
 *
 * `InvalidRetentionError` rather than a class of its own: the guard is part of retention
 * and a route that already catches one invalid-retention error should not have to learn a
 * second name for the same 422.
 */
const GUARD_CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  notification_policy_prune_max_share:
    "a prune ceiling must be between 1 and 99 percent of the inbox — a ceiling of 100 is not a ceiling",
  notification_policy_prune_guard_floor:
    "a prune guard floor must be between 0 and 1000 rows — above that it is not a floor but a " +
    "permanent bypass of the ceiling; raise the ceiling, or grant a prune guard override",
  notification_policy_prune_override_bounded: `a prune guard override must last between 1 and ${MAX_PRUNE_OVERRIDE_HOURS} hours`,
  notification_policy_prune_override_named: "a prune guard override must name who granted it",
  notification_policy_prune_override_whole: "a prune guard override must name who granted it",
};

async function guardUpdate(tx: PoolClient, sql: string, params: readonly unknown[]): Promise<PruneGuard> {
  try {
    const { rows } = await tx.query<PruneGuard>(sql, [...params]);
    return projectGuard(rows[0]!);
  } catch (err) {
    const e = err as { constraint?: string };
    const known = e?.constraint === undefined ? undefined : GUARD_CONSTRAINT_MESSAGES[e.constraint];
    if (known !== undefined) throw new InvalidRetentionError(known);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export interface PruneCandidate {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly created_at: string;
  readonly was_read: boolean;
  readonly subject_table: string | null;
  readonly subject_open: boolean;
  readonly subject_unknown: boolean;
  readonly delivery_unsettled: boolean;
}

/**
 * 50,000 rows per pass.
 *
 * A tenant turning retention on for the first time after a year of unbounded growth has
 * a backlog, and deleting all of it in one transaction holds locks and a snapshot open
 * for as long as it takes. The job runs again tomorrow, and `moreRemaining` says so — so
 * a large backlog drains over a few nights instead of in one long transaction.
 */
export const MAX_PRUNE_ROWS = 50_000;

/** Past its horizon, whatever the verdict. The predicate both functions below share. */
const PAST_HORIZON = `c.created_at < ($2::timestamptz
       - make_interval(days => CASE WHEN c.was_read THEN $3::int ELSE $4::int END))`;

/**
 * What a prune would take, and what it would hold back.
 *
 * Exists so "turn retention on" can be answered before it is done. Ordered oldest-first,
 * which is the order a reviewer reads it in.
 */
export async function prunableNotifications(
  tx: PoolClient,
  tenantId: string,
  options: { asOf?: Date; limit?: number } = {},
): Promise<readonly PruneCandidate[]> {
  const policy = await notificationPolicy(tx, tenantId);
  const { rows } = await tx.query<PruneCandidate>(
    `SELECT c.id, c.kind, c.severity, c.created_at::text AS created_at, c.was_read,
            c.subject_table, c.subject_open, c.subject_unknown, c.delivery_unsettled
       FROM crm.notification_prune_candidates c
      WHERE c.tenant_id = $1 AND ${PAST_HORIZON}
      ORDER BY c.created_at
      LIMIT $5`,
    [
      tenantId,
      options.asOf ?? new Date(),
      policy.retain_read_days,
      policy.retain_unread_days,
      options.limit ?? 500,
    ],
  );
  return rows;
}

/**
 * Phase two: what the same pass did to `crm.notification_delivery`.
 *
 * WHY A SECOND PHASE OF ONE PASS, and not a second job or a horizon the first DELETE
 * honours. All three were available.
 *
 * Not a second job: the two horizons are one policy and an operator who turns retention on
 * wants one summary and one thing to enable. And the ORDER matters — pruning a notification
 * is what makes its delivered rows outlive it, so the delivery phase has to run after the
 * notification phase or every orphan waits a night for its own horizon to be considered.
 *
 * Not one DELETE with two horizons: they are different tables with different denominators,
 * and the guard is a SHARE. 0026's whole argument is that a share reads the "horizon wrong
 * by an order of magnitude" signature identically at every scale — but a share OF THE INBOX
 * says nothing about a delete from the delivery table. A tenant with 10 notifications and
 * two million delivery rows would see any delivery prune as an impossible share of the
 * inbox, and the inverse tenant would see a catastrophic delivery prune pass a ceiling it
 * never approached.
 *
 * So: one job, one transaction, one ceiling, one floor, one override window — and TWO
 * measurements. `crm.notification_prune_guard_trips` and
 * `crm.notification_prune_ceiling_exceeded` are asked again with the same
 * `prune_max_share_percent` and `prune_guard_floor_rows`, against this table's own numerator
 * and denominator. Nothing here is a new guard and nothing here bypasses the existing one;
 * a refusal in either phase leaves that phase's rows untouched and says so independently,
 * because "the inbox horizon is wrong" and "the delivery horizon is wrong" are two different
 * mistakes and refusing both because of one would be the 0026 failure in reverse.
 */
export interface DeliveryPruneOutcome {
  /** The horizon this phase applied, echoed so a log line carries it. */
  readonly retainDeliveryDays: number;
  readonly deleted: number;
  /**
   * Past its horizon and held back because the push is not settled — `pending`, `in_flight`
   * or `dead`. A dead delivery is held back FOREVER; see the view's header in 0046.
   */
  readonly keptUnsettled: number;
  /**
   * Delivery rows that have outlived the notification they describe, counted at the moment
   * this phase ran — so it includes the ones phase one orphaned a few statements earlier.
   * The feature made countable: this number being non-zero is retention working, not a
   * fault. Some of them are in `deleted`, where they were also past this horizon.
   */
  readonly orphaned: number;
  /** Every delivery row the tenant holds — the denominator the ceiling is a share of. */
  readonly deliveryTotal: number;
  /** What this phase wanted to delete, BEFORE the batch cap. The guard's numerator. */
  readonly prunableTotal: number;
  readonly sharePercent: number;
  readonly moreRemaining: boolean;
  readonly refused: boolean;
  readonly refusalReason: string | null;
  readonly overridden: boolean;
  readonly floorWaived: boolean;
  readonly floorWaivedReason: string | null;
}

export interface PruneResult {
  readonly deletedRead: number;
  readonly deletedUnread: number;
  /** Past its horizon but held back because the thing it is about is unfinished. */
  readonly keptSubjectOpen: number;
  /** Held back because a webhook push is still pending, in flight, or dead. */
  readonly keptDeliveryUnsettled: number;
  /**
   * Past its horizon, pointing at a table `crm.notification_subject_open` has no branch
   * for — so it was pruned on the assumption that nothing is waiting on it. Counted
   * because a non-zero number here means a producer needs a branch adding, and the
   * alternative to counting it is never finding out.
   */
  readonly unknownSubjects: number;
  readonly moreRemaining: boolean;
  readonly policy: NotificationPolicy;
  readonly guard: PruneGuard;
  /**
   * The pass deleted NOTHING because it would have taken more of the inbox than the
   * tenant's ceiling allows (0026). Distinct from a pass with nothing to do: that one
   * reports zero deletions with `prunableTotal` zero and no reason.
   */
  readonly refused: boolean;
  /** The refusal, with its numbers and the way past it. Null unless `refused`. */
  readonly refusalReason: string | null;
  /** Everything the tenant holds — the denominator the ceiling is a share of. */
  readonly inboxTotal: number;
  /**
   * How many rows this pass wanted to delete, BEFORE `maxRows`. The guard's numerator:
   * measured after the batch cap, a two-million-row inbox with a one-day horizon would
   * propose 50,000 rows a night, pass a 25% ceiling every night, and empty itself in
   * forty passes without one refusal.
   */
  readonly prunableTotal: number;
  /** `prunableTotal` as a share of `inboxTotal`, to one decimal place. */
  readonly sharePercent: number;
  /** The guard tripped and a live override let the pass through regardless. */
  readonly overridden: boolean;
  /**
   * The pass was over the ceiling and the row FLOOR let it through — not the override.
   *
   * `overridden` cannot say this, because the floor stops the guard tripping at all, so a
   * floor-waived pass used to log identically to one that was within its ceiling. Null
   * reason when false, for the same reason `refusalReason` is.
   */
  readonly floorWaived: boolean;
  readonly floorWaivedReason: string | null;
  /** Phase two: `crm.notification_delivery`, under its own horizon (0046). */
  readonly delivery: DeliveryPruneOutcome;
}

/**
 * Delete what is past its horizon, keep what is still doing its job.
 *
 * One transaction, like the expiry sweep: either tonight's prune lands or none of it
 * does, which is the right granularity for something that runs again tomorrow.
 *
 * The counts are taken BEFORE the delete. They describe the same horizon the delete
 * uses, and the kept categories are disjoint from the deleted ones, so the order does
 * not change any number — it just makes each one answerable from a single query. They are
 * also what the guard reads, which is the other reason they come first: the share has to
 * be known while the rows still exist.
 */
/**
 * `prunableTotal / inboxTotal` as a percentage, rounded to two places AND rounded UP.
 *
 * Two places because one made the sentence contradict itself: the decision is the exact
 * integer comparison `prunable * 100 > ceiling * total`, so at 2501 of 10000 against a 25%
 * ceiling the guard trips and `round(25.01)` to one place reported "would take 25% ... over
 * its 25% ceiling" — while 2500, which does not trip, reported the same 25%. Up rather than
 * nearest for the same reason, one step further: a share that tripped the guard must never
 * print as a number at or below the ceiling, whatever the decimals do, because the sentence
 * is the only thing the operator reads.
 */
function sharePercentOf(prunableTotal: number, inboxTotal: number): number {
  if (inboxTotal === 0) return 0;
  return Math.ceil((prunableTotal / inboxTotal) * 10_000) / 100;
}

/** One wording, so the preview and the refusal cannot describe the same number differently. */
function refusalSentence(
  prunableTotal: number,
  sharePercent: number,
  inboxTotal: number,
  guard: PruneGuard,
): string {
  return (
    `deleting ${prunableTotal} notification(s) would take ${sharePercent}% of this tenant's ` +
    `inbox of ${inboxTotal}, over its ${guard.prune_max_share_percent}% ceiling; nothing was ` +
    `deleted — check the retention horizons, or grant a prune guard override to proceed`
  );
}

/**
 * The pass is over the ceiling and the FLOOR let it through anyway.
 *
 * Reported because a floor-waived pass used to be indistinguishable from a pass that was
 * within its ceiling: `overridden` is only ever true when the guard itself tripped, and the
 * floor stops it tripping. 0032 caps the floor at 1000 rows so the amount a waiver can cost
 * is bounded; this is how it stops being silent as well.
 */
function floorWaivedSentence(prunableTotal: number, sharePercent: number, guard: PruneGuard): string {
  return (
    `${prunableTotal} notification(s) is ${sharePercent}% of the inbox, over the ` +
    `${guard.prune_max_share_percent}% ceiling, but at or under the ${guard.prune_guard_floor_rows}-row ` +
    `floor below which the share is not consulted — the pass ran`
  );
}

/**
 * The delivery phase's own two sentences.
 *
 * Written out rather than parameterised from the two above, because every noun in them
 * changes: not "notification(s)" but "delivery record(s)", not "inbox" but the delivery
 * table, and the way past a refusal is a different number to check. One wording per phase
 * is also what keeps a preview and a verdict from describing the same number differently —
 * which is the reason the inbox pair exists as functions at all.
 */
function deliveryRefusalSentence(
  prunableTotal: number,
  sharePercent: number,
  deliveryTotal: number,
  guard: PruneGuard,
): string {
  return (
    `deleting ${prunableTotal} delivery record(s) would take ${sharePercent}% of this ` +
    `tenant's ${deliveryTotal} recorded pushes, over its ${guard.prune_max_share_percent}% ` +
    `ceiling; nothing was deleted — check retainDeliveryDays, or grant a prune guard ` +
    `override to proceed`
  );
}

function deliveryFloorWaivedSentence(
  prunableTotal: number,
  sharePercent: number,
  guard: PruneGuard,
): string {
  return (
    `${prunableTotal} delivery record(s) is ${sharePercent}% of the recorded pushes, over ` +
    `the ${guard.prune_max_share_percent}% ceiling, but at or under the ` +
    `${guard.prune_guard_floor_rows}-row floor below which the share is not consulted — ` +
    `the phase ran`
  );
}

/** Past its horizon, whatever the verdict. The delivery phase's half of `PAST_HORIZON`. */
const DELIVERY_PAST_HORIZON = `c.created_at < ($2::timestamptz - make_interval(days => $3::int))`;

interface DeliverySummary {
  readonly delivery_total: string;
  readonly orphaned: string;
  readonly kept_unsettled: string;
  readonly prunable: string;
  readonly guard_trips: boolean;
  readonly ceiling_exceeded: boolean;
}

/**
 * The numbers phase two decides on, in one query.
 *
 * Measured before its delete, for the reason phase one's are: the share has to be known
 * while the rows still exist, and the kept categories are disjoint from the deleted ones so
 * the order changes no number. `delivery_total` counts the whole table for the tenant and
 * the FILTERs narrow it, rather than a WHERE plus a scalar subquery — one scan answers
 * numerator and denominator, and an aggregate over an empty table still returns a row.
 */
async function deliverySummary(
  tx: PoolClient,
  tenantId: string,
  asOf: Date,
  retainDeliveryDays: number,
  guard: PruneGuard,
): Promise<DeliverySummary> {
  const { rows } = await tx.query<DeliverySummary>(
    `SELECT count(*)                                                        AS delivery_total,
            count(*) FILTER (WHERE c.orphaned)                              AS orphaned,
            count(*) FILTER (WHERE ${DELIVERY_PAST_HORIZON} AND c.unsettled) AS kept_unsettled,
            count(*) FILTER (WHERE ${DELIVERY_PAST_HORIZON}
                               AND NOT c.unsettled)                          AS prunable,
            crm.notification_prune_guard_trips(
              count(*) FILTER (WHERE ${DELIVERY_PAST_HORIZON} AND NOT c.unsettled),
              count(*), $4::int, $5::int)                                    AS guard_trips,
            crm.notification_prune_ceiling_exceeded(
              count(*) FILTER (WHERE ${DELIVERY_PAST_HORIZON} AND NOT c.unsettled),
              count(*), $4::int)                                             AS ceiling_exceeded
       FROM crm.notification_delivery_prune_candidates c
      WHERE c.tenant_id = $1`,
    [tenantId, asOf, retainDeliveryDays, guard.prune_max_share_percent, guard.prune_guard_floor_rows],
  );
  return rows[0]!;
}

/**
 * Phase two of one pass. Runs in the caller's transaction, after phase one.
 *
 * Not exported: `pruneNotifications` is the only caller, deliberately. A second entry point
 * into a delete is a second place the guard can be forgotten, and 0026 exists because an
 * unattended prune that takes most of a table is a prune nobody authorised.
 */
async function pruneDeliveries(
  tx: PoolClient,
  tenantId: string,
  guard: PruneGuard,
  retainDeliveryDays: number,
  asOf: Date,
  maxRows: number,
): Promise<DeliveryPruneOutcome> {
  const summary = await deliverySummary(tx, tenantId, asOf, retainDeliveryDays, guard);
  const prunableTotal = Number(summary.prunable);
  const deliveryTotal = Number(summary.delivery_total);
  const sharePercent = sharePercentOf(prunableTotal, deliveryTotal);
  const common = {
    retainDeliveryDays,
    keptUnsettled: Number(summary.kept_unsettled),
    orphaned: Number(summary.orphaned),
    deliveryTotal,
    prunableTotal,
    sharePercent,
  };

  // Judged against the pass's own clock and against the SAME override window phase one used.
  // One break-glass window for the job, not one per table: an operator who has looked at the
  // numbers and said "drain it" has said it about tonight's prune, and making them grant two
  // would mean the second one gets granted by reflex.
  const overrideLive =
    guard.prune_guard_override_until !== null &&
    guard.prune_guard_override_until.getTime() > asOf.getTime();

  if (summary.guard_trips && !overrideLive) {
    return {
      ...common,
      deleted: 0,
      moreRemaining: prunableTotal > 0,
      refused: true,
      refusalReason: deliveryRefusalSentence(prunableTotal, sharePercent, deliveryTotal, guard),
      overridden: false,
      floorWaived: false,
      floorWaivedReason: null,
    };
  }

  // `ORDER BY c.seq`, not `created_at`: oldest WRITE first. 0046 added `seq` because
  // `created_at` is the transaction clock and a dispatch fan-out shares it exactly, so an
  // ordered batch cap over a timestamp would pick arbitrarily among tied rows and a
  // resumed drain could revisit what it had already considered.
  const { rowCount } = await tx.query(
    `DELETE FROM crm.notification_delivery
      WHERE id IN (
        SELECT c.id FROM crm.notification_delivery_prune_candidates c
         WHERE c.tenant_id = $1 AND ${DELIVERY_PAST_HORIZON}
           AND NOT c.unsettled
         ORDER BY c.seq
         LIMIT $4)`,
    [tenantId, asOf, retainDeliveryDays, maxRows],
  );
  const deleted = rowCount ?? 0;
  const floorWaived = summary.ceiling_exceeded && !summary.guard_trips;

  return {
    ...common,
    deleted,
    moreRemaining: prunableTotal > deleted,
    refused: false,
    refusalReason: null,
    overridden: summary.guard_trips,
    floorWaived,
    floorWaivedReason: floorWaived
      ? deliveryFloorWaivedSentence(prunableTotal, sharePercent, guard)
      : null,
  };
}

/** Phase two's numbers, with nothing deleted. */
export interface DeliveryPrunePreview {
  readonly retainDeliveryDays: number;
  readonly wouldRefuse: boolean;
  readonly refusalReason: string | null;
  readonly floorWaived: boolean;
  readonly floorWaivedReason: string | null;
  readonly prunableTotal: number;
  readonly keptUnsettled: number;
  readonly orphaned: number;
  readonly deliveryTotal: number;
  readonly sharePercent: number;
}

export interface PrunePreview {
  readonly guard: PruneGuard;
  /** Whether tonight's pass would be refused for taking too much of the inbox. */
  readonly wouldRefuse: boolean;
  readonly refusalReason: string | null;
  readonly overrideLive: boolean;
  /** Over the ceiling, under the floor — so it will run, and the guard will not say so. */
  readonly floorWaived: boolean;
  readonly floorWaivedReason: string | null;
  readonly prunableTotal: number;
  readonly inboxTotal: number;
  readonly sharePercent: number;
  /**
   * The same questions about phase two.
   *
   * Carried on the same preview rather than behind a second route, because an operator who
   * is about to shorten a horizon needs to see both numbers at once: the inbox prune and the
   * delivery prune are now one job, and a preview that answered for one of them would be a
   * preview of half the night.
   */
  readonly delivery: DeliveryPrunePreview;
}

/**
 * Would tonight's prune be refused, and on what numbers?
 *
 * DELETES NOTHING, which is the whole reason it exists separately. The dry-run route has
 * to answer this, and the obvious shortcut — calling `pruneNotifications` with a row cap of
 * zero — makes a GET invoke the deleter. It happens to delete nothing today; it would stop
 * happening to the moment anyone changed what a zero cap means, and the failure would be
 * silent and irreversible. A reader does not call the writer.
 *
 * Not "read-only", which is what this said and was wrong about: `policyRow` upserts the
 * tenant's default policy row, so a first preview writes one. That write is deliberate and
 * idempotent — every reader of the policy needs a row to read and the defaults are the
 * answer when there is none — but a doc comment that says read-only when a statement is an
 * INSERT is the kind of claim someone later builds on.
 *
 * It asks the same `crm.notification_prune_guard_trips` the pass asks, so the preview and
 * the verdict cannot drift apart.
 */
export async function prunePreview(
  tx: PoolClient,
  tenantId: string,
  options: { asOf?: Date } = {},
): Promise<PrunePreview> {
  const row = await policyRow(tx, tenantId);
  const guard = projectGuard(row);
  const asOf = options.asOf ?? new Date();

  const { rows } = await tx.query<{
    prunable: string;
    inbox_total: string;
    guard_trips: boolean;
    ceiling_exceeded: boolean;
  }>(
    `SELECT count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled) AS prunable,
            (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1)        AS inbox_total,
            crm.notification_prune_guard_trips(
              count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled),
              (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1),
              $5::int, $6::int)                                                     AS guard_trips,
            crm.notification_prune_ceiling_exceeded(
              count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled),
              (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1),
              $5::int)                                                              AS ceiling_exceeded
       FROM crm.notification_prune_candidates c
      WHERE c.tenant_id = $1 AND ${PAST_HORIZON}`,
    [
      tenantId,
      asOf,
      row.retain_read_days,
      row.retain_unread_days,
      guard.prune_max_share_percent,
      guard.prune_guard_floor_rows,
    ],
  );
  const summary = rows[0]!;
  const prunableTotal = Number(summary.prunable);
  const inboxTotal = Number(summary.inbox_total);
  const sharePercent = sharePercentOf(prunableTotal, inboxTotal);
  const overrideLive =
    guard.prune_guard_override_until !== null &&
    guard.prune_guard_override_until.getTime() > asOf.getTime();
  const wouldRefuse = summary.guard_trips && !overrideLive;
  // Over the ceiling but the guard did not trip: the floor is the only other operand.
  const floorWaived = summary.ceiling_exceeded && !summary.guard_trips;

  // Phase two's numbers, from the same clock and the same guard columns. A read, so it is
  // the summary query alone — never `pruneDeliveries`, which deletes.
  const d = await deliverySummary(tx, tenantId, asOf, row.retain_delivery_days, guard);
  const dPrunable = Number(d.prunable);
  const dTotal = Number(d.delivery_total);
  const dShare = sharePercentOf(dPrunable, dTotal);
  const dWouldRefuse = d.guard_trips && !overrideLive;
  const dFloorWaived = d.ceiling_exceeded && !d.guard_trips;

  return {
    guard,
    wouldRefuse,
    refusalReason: wouldRefuse ? refusalSentence(prunableTotal, sharePercent, inboxTotal, guard) : null,
    overrideLive,
    floorWaived,
    floorWaivedReason: floorWaived ? floorWaivedSentence(prunableTotal, sharePercent, guard) : null,
    prunableTotal,
    inboxTotal,
    sharePercent,
    delivery: {
      retainDeliveryDays: row.retain_delivery_days,
      wouldRefuse: dWouldRefuse,
      refusalReason: dWouldRefuse ? deliveryRefusalSentence(dPrunable, dShare, dTotal, guard) : null,
      floorWaived: dFloorWaived,
      floorWaivedReason: dFloorWaived ? deliveryFloorWaivedSentence(dPrunable, dShare, guard) : null,
      prunableTotal: dPrunable,
      keptUnsettled: Number(d.kept_unsettled),
      orphaned: Number(d.orphaned),
      deliveryTotal: dTotal,
      sharePercent: dShare,
    },
  };
}

export async function pruneNotifications(
  tx: PoolClient,
  tenantId: string,
  options: { asOf?: Date; maxRows?: number } = {},
): Promise<PruneResult> {
  const row = await policyRow(tx, tenantId);
  const policy: NotificationPolicy = {
    retain_read_days: row.retain_read_days,
    retain_unread_days: row.retain_unread_days,
  };
  const guard = projectGuard(row);
  const asOf = options.asOf ?? new Date();
  const maxRows = options.maxRows ?? MAX_PRUNE_ROWS;
  const horizon = [tenantId, asOf, policy.retain_read_days, policy.retain_unread_days];

  // The inbox total is a scalar subquery, written twice rather than joined once, because a
  // join would need a GROUP BY and a tenant with nothing past its horizon would then
  // return no row at all — the aggregate has to answer even when it counts nothing.
  const { rows: counts } = await tx.query<{
    kept_subject_open: string;
    kept_delivery_unsettled: string;
    unknown_subjects: string;
    prunable: string;
    inbox_total: string;
    guard_trips: boolean;
    ceiling_exceeded: boolean;
  }>(
    `SELECT count(*) FILTER (WHERE c.subject_open)                                AS kept_subject_open,
            count(*) FILTER (WHERE NOT c.subject_open AND c.delivery_unsettled)   AS kept_delivery_unsettled,
            count(*) FILTER (WHERE c.subject_unknown AND NOT c.subject_open
                               AND NOT c.delivery_unsettled)                      AS unknown_subjects,
            count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled) AS prunable,
            (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1)      AS inbox_total,
            crm.notification_prune_guard_trips(
              count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled),
              (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1),
              $5::int, $6::int)                                                   AS guard_trips,
            crm.notification_prune_ceiling_exceeded(
              count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled),
              (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1),
              $5::int)                                                            AS ceiling_exceeded
       FROM crm.notification_prune_candidates c
      WHERE c.tenant_id = $1 AND ${PAST_HORIZON}`,
    [...horizon, guard.prune_max_share_percent, guard.prune_guard_floor_rows],
  );
  const summary = counts[0]!;
  const prunableTotal = Number(summary.prunable);
  const inboxTotal = Number(summary.inbox_total);
  const sharePercent = sharePercentOf(prunableTotal, inboxTotal);
  const kept = {
    keptSubjectOpen: Number(summary.kept_subject_open),
    keptDeliveryUnsettled: Number(summary.kept_delivery_unsettled),
    unknownSubjects: Number(summary.unknown_subjects),
  };

  // Judged against the pass's own clock, the one the horizons were measured with, so a
  // test and a replay cannot have one leg in a different time. Only the END of the window
  // is checked: the grant writes its start as `now()`, so there is no such thing as an
  // override that has not begun.
  const overrideLive =
    guard.prune_guard_override_until !== null &&
    guard.prune_guard_override_until.getTime() > asOf.getTime();

  const floorWaived = summary.ceiling_exceeded && !summary.guard_trips;

  if (summary.guard_trips && !overrideLive) {
    // Nothing, rather than a trimmed something. A prune cannot be undone, so a pass that
    // has arrived at a number nobody authorised stops AT the number: the horizons, the
    // candidate listing and this sentence are all still readable with the data intact.
    // `moreRemaining` falls out of the usual arithmetic — there is indeed more to do.
    //
    // PHASE TWO STILL RUNS. The two horizons are two different judgements and a refusal is
    // a statement that THIS one looks wrong by an order of magnitude; stopping the delivery
    // phase as well would let one mistyped inbox horizon suspend the other table's
    // retention indefinitely, with nothing in the summary saying that was the reason.
    // Phase two refuses on its own numbers or it does not.
    return {
      deletedRead: 0,
      deletedUnread: 0,
      ...kept,
      moreRemaining: prunableTotal > 0,
      policy,
      guard,
      refused: true,
      refusalReason: refusalSentence(prunableTotal, sharePercent, inboxTotal, guard),
      inboxTotal,
      prunableTotal,
      sharePercent,
      overridden: false,
      // The guard tripped, so the floor did not waive anything.
      floorWaived: false,
      floorWaivedReason: null,
      delivery: await pruneDeliveries(
        tx,
        tenantId,
        guard,
        row.retain_delivery_days,
        asOf,
        maxRows,
      ),
    };
  }

  const { rows: deleted } = await tx.query<{ was_read: boolean }>(
    `DELETE FROM crm.notification
      WHERE id IN (
        SELECT c.id FROM crm.notification_prune_candidates c
         WHERE c.tenant_id = $1 AND ${PAST_HORIZON}
           AND NOT c.subject_open
           AND NOT c.delivery_unsettled
         ORDER BY c.created_at
         LIMIT $5)
      RETURNING read_at IS NOT NULL AS was_read`,
    [...horizon, maxRows],
  );

  // Phase two, AFTER the notification delete and in the same transaction. The order is
  // load-bearing: the rows phase one has just orphaned are the ones this phase exists for,
  // and running it first would make every orphan wait a night to be considered. Its own
  // guard, its own numbers; see `DeliveryPruneOutcome`.
  const delivery = await pruneDeliveries(tx, tenantId, guard, row.retain_delivery_days, asOf, maxRows);

  return {
    delivery,
    deletedRead: deleted.filter((r) => r.was_read).length,
    deletedUnread: deleted.filter((r) => !r.was_read).length,
    ...kept,
    moreRemaining: prunableTotal > deleted.length,
    policy,
    guard,
    refused: false,
    refusalReason: null,
    inboxTotal,
    prunableTotal,
    sharePercent,
    // True only where the guard actually tripped; a live window over a pass that was
    // within its ceiling anyway overrode nothing.
    overridden: summary.guard_trips,
    floorWaived,
    floorWaivedReason: floorWaived ? floorWaivedSentence(prunableTotal, sharePercent, guard) : null,
  };
}
