import type { PoolClient } from "pg";

import type { NotificationKind, Severity } from "./kinds.js";

export interface InboxItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly subject: string;
  readonly body: string;
  readonly subject_table: string | null;
  readonly subject_id: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: Date;
  readonly read_at: Date | null;
}

export async function inbox(
  tx: PoolClient,
  repProfileId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<readonly InboxItem[]> {
  const { rows } = await tx.query<InboxItem>(
    `SELECT * FROM crm.notification_inbox($1, $2, $3)`,
    [repProfileId, opts.unreadOnly ?? false, opts.limit ?? 50],
  );
  return rows;
}

/**
 * The unread count — an actual count of an actual column.
 *
 * Worth naming because the ERP cannot do this: it has no per-user read state, so its
 * "unread" is an approximation based on recency (its ADR-0273 and ADR-0278). A badge that
 * means "things since you last looked" goes wrong the moment someone reads on two devices.
 */
export async function unreadCount(tx: PoolClient, repProfileId: string): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM crm.notification
      WHERE recipient_rep_profile_id = $1 AND read_at IS NULL`,
    [repProfileId],
  );
  return Number(rows[0]!.n);
}

/**
 * Marks one notification read, for this recipient only.
 *
 * Returns false when the id is not theirs, which the route turns into a 404 rather than a
 * 403 — whether a notification exists is itself information about someone else's work.
 * The `read_at IS NULL` guard keeps the first read's timestamp: when they saw it is the
 * fact worth keeping, not when they last tapped it.
 */
export async function markRead(tx: PoolClient, repProfileId: string, notificationId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE crm.notification
        SET read_at = now()
      WHERE id = $1 AND recipient_rep_profile_id = $2 AND read_at IS NULL`,
    [notificationId, repProfileId],
  );
  if ((rowCount ?? 0) > 0) return true;
  // Already read is success — a client retrying must not get an error.
  const { rowCount: exists } = await tx.query(
    `SELECT 1 FROM crm.notification WHERE id = $1 AND recipient_rep_profile_id = $2`,
    [notificationId, repProfileId],
  );
  return (exists ?? 0) > 0;
}

/** Marks everything read. Returns how many were. */
export async function markAllRead(tx: PoolClient, repProfileId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE crm.notification SET read_at = now()
      WHERE recipient_rep_profile_id = $1 AND read_at IS NULL`,
    [repProfileId],
  );
  return rowCount ?? 0;
}
