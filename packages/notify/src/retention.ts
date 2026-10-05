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

const DEFAULT_GUARD: PruneGuard = {
  prune_max_share_percent: DEFAULT_PRUNE_MAX_SHARE_PERCENT,
  prune_guard_floor_rows: DEFAULT_PRUNE_GUARD_FLOOR_ROWS,
  prune_guard_override_by: null,
  prune_guard_override_granted_at: null,
  prune_guard_override_until: null,
};

const POLICY_COLUMNS = `retain_read_days, retain_unread_days,
            prune_max_share_percent, prune_guard_floor_rows,
            prune_guard_override_by, prune_guard_override_granted_at,
            prune_guard_override_until`;

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
async function policyRow(tx: PoolClient, tenantId: string): Promise<NotificationPolicy & PruneGuard> {
  await tx.query(`INSERT INTO crm.notification_policy (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
    tenantId,
  ]);
  const { rows } = await tx.query<NotificationPolicy & PruneGuard>(
    `SELECT ${POLICY_COLUMNS} FROM crm.notification_policy WHERE tenant_id = $1`,
    [tenantId],
  );
  return (
    rows[0] ?? {
      retain_read_days: DEFAULT_RETAIN_READ_DAYS,
      retain_unread_days: DEFAULT_RETAIN_UNREAD_DAYS,
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
    const e = err as { constraint?: string; message?: string };
    if (e?.constraint === "notification_policy_unread_not_shorter") {
      throw new InvalidRetentionError(
        "an unread notification must not be deleted sooner than a read one — " +
          "retainUnreadDays must be at least retainReadDays",
      );
    }
    if (e?.constraint?.startsWith("notification_policy_retain") === true) {
      throw new InvalidRetentionError("a retention period must be between 1 and 3650 days");
    }
    throw err instanceof Error ? err : new Error(String(err));
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
  notification_policy_prune_guard_floor: "a prune guard floor must be between 0 and 1000000 rows",
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

export interface PrunePreview {
  readonly guard: PruneGuard;
  /** Whether tonight's pass would be refused for taking too much of the inbox. */
  readonly wouldRefuse: boolean;
  readonly refusalReason: string | null;
  readonly overrideLive: boolean;
  readonly prunableTotal: number;
  readonly inboxTotal: number;
  readonly sharePercent: number;
}

/**
 * Would tonight's prune be refused, and on what numbers?
 *
 * READ-ONLY, which is the whole reason it exists separately. The dry-run route has to
 * answer this, and the obvious shortcut — calling `pruneNotifications` with a row cap of
 * zero — makes a GET invoke the deleter. It happens to delete nothing today; it would stop
 * happening to the moment anyone changed what a zero cap means, and the failure would be
 * silent and irreversible. A reader does not call the writer.
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
  }>(
    `SELECT count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled) AS prunable,
            (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1)        AS inbox_total,
            crm.notification_prune_guard_trips(
              count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled),
              (SELECT count(*) FROM crm.notification n WHERE n.tenant_id = $1),
              $5::int, $6::int)                                                     AS guard_trips
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
  const sharePercent = inboxTotal === 0 ? 0 : Math.round((prunableTotal / inboxTotal) * 1000) / 10;
  const overrideLive =
    guard.prune_guard_override_until !== null &&
    guard.prune_guard_override_until.getTime() > asOf.getTime();
  const wouldRefuse = summary.guard_trips && !overrideLive;

  return {
    guard,
    wouldRefuse,
    refusalReason: wouldRefuse ? refusalSentence(prunableTotal, sharePercent, inboxTotal, guard) : null,
    overrideLive,
    prunableTotal,
    inboxTotal,
    sharePercent,
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
              $5::int, $6::int)                                                   AS guard_trips
       FROM crm.notification_prune_candidates c
      WHERE c.tenant_id = $1 AND ${PAST_HORIZON}`,
    [...horizon, guard.prune_max_share_percent, guard.prune_guard_floor_rows],
  );
  const summary = counts[0]!;
  const prunableTotal = Number(summary.prunable);
  const inboxTotal = Number(summary.inbox_total);
  const sharePercent = inboxTotal === 0 ? 0 : Math.round((prunableTotal / inboxTotal) * 1000) / 10;
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

  if (summary.guard_trips && !overrideLive) {
    // Nothing, rather than a trimmed something. A prune cannot be undone, so a pass that
    // has arrived at a number nobody authorised stops AT the number: the horizons, the
    // candidate listing and this sentence are all still readable with the data intact.
    // `moreRemaining` falls out of the usual arithmetic — there is indeed more to do.
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

  return {
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
  };
}
