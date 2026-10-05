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
 * The tenant's policy, defaulting the row into existence.
 *
 * Same shape as `disposalPolicy` in `@crm/sample`: a tenant that has never configured
 * retention gets the documented defaults rather than NULLs the caller has to interpret,
 * and the row exists afterwards so the admin route has something to update.
 */
export async function notificationPolicy(tx: PoolClient, tenantId: string): Promise<NotificationPolicy> {
  await tx.query(`INSERT INTO crm.notification_policy (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
    tenantId,
  ]);
  const { rows } = await tx.query<NotificationPolicy>(
    `SELECT retain_read_days, retain_unread_days FROM crm.notification_policy WHERE tenant_id = $1`,
    [tenantId],
  );
  return (
    rows[0] ?? {
      retain_read_days: DEFAULT_RETAIN_READ_DAYS,
      retain_unread_days: DEFAULT_RETAIN_UNREAD_DAYS,
    }
  );
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
}

/**
 * Delete what is past its horizon, keep what is still doing its job.
 *
 * One transaction, like the expiry sweep: either tonight's prune lands or none of it
 * does, which is the right granularity for something that runs again tomorrow.
 *
 * The counts are taken BEFORE the delete. They describe the same horizon the delete
 * uses, and the kept categories are disjoint from the deleted ones, so the order does
 * not change any number — it just makes each one answerable from a single query.
 */
export async function pruneNotifications(
  tx: PoolClient,
  tenantId: string,
  options: { asOf?: Date; maxRows?: number } = {},
): Promise<PruneResult> {
  const policy = await notificationPolicy(tx, tenantId);
  const asOf = options.asOf ?? new Date();
  const maxRows = options.maxRows ?? MAX_PRUNE_ROWS;
  const horizon = [tenantId, asOf, policy.retain_read_days, policy.retain_unread_days];

  const { rows: counts } = await tx.query<{
    kept_subject_open: string;
    kept_delivery_unsettled: string;
    unknown_subjects: string;
    prunable: string;
  }>(
    `SELECT count(*) FILTER (WHERE c.subject_open)                                AS kept_subject_open,
            count(*) FILTER (WHERE NOT c.subject_open AND c.delivery_unsettled)   AS kept_delivery_unsettled,
            count(*) FILTER (WHERE c.subject_unknown AND NOT c.subject_open
                               AND NOT c.delivery_unsettled)                      AS unknown_subjects,
            count(*) FILTER (WHERE NOT c.subject_open AND NOT c.delivery_unsettled) AS prunable
       FROM crm.notification_prune_candidates c
      WHERE c.tenant_id = $1 AND ${PAST_HORIZON}`,
    horizon,
  );
  const summary = counts[0]!;

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
    keptSubjectOpen: Number(summary.kept_subject_open),
    keptDeliveryUnsettled: Number(summary.kept_delivery_unsettled),
    unknownSubjects: Number(summary.unknown_subjects),
    moreRemaining: Number(summary.prunable) > deleted.length,
    policy,
  };
}
