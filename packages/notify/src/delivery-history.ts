/**
 * Where a signal was pushed, and whether it landed — readable after the signal is gone.
 *
 * The rules are migration 0046's: `crm.notification_delivery` no longer references
 * `crm.notification`, it copies the four facts that make a push legible on its own, and it
 * has a retention horizon of its own in `crm.notification_policy`. This module is the read
 * side of that, and nothing more — the ordering and the joins live in SQL
 * (`crm.notification_delivery_history`, `crm.notification_delivery_recent`) for the reason
 * `crm.outbox_dead_letter_history` does: the ordering key is a property of the table, and a
 * caller that reconstructed it would eventually reconstruct it differently.
 */
import type { PoolClient } from "pg";

import type { NotificationKind, Severity } from "./kinds.js";

/**
 * One recorded push.
 *
 * Every `notification_*`, `recipient_*` and `endpoint_*` field is a COPY taken when the push
 * was enqueued, so all of them are still here when the parent is not — the notification's
 * four since 0046, the endpoint's two since 0048, which dropped that cascade too. They are
 * NOT NULL in the table and therefore not nullable here: a row that reached this table went
 * through the trigger that makes the copies, and a path that bypassed it would have written
 * nothing at all rather than a row with no context.
 */
export interface DeliveryRecord {
  readonly id: string;
  /** The write order. `bigint`, read as text — `crm.outbox.seq`'s convention. */
  readonly seq: string;
  readonly notification_id: string;
  readonly endpoint_id: string;
  readonly endpoint_channel: string;
  readonly endpoint_url: string;
  readonly notification_kind: NotificationKind;
  readonly notification_severity: Severity;
  readonly notification_created_at: Date;
  readonly recipient_rep_profile_id: string;
  /** Resolved by LEFT JOIN, so a removed profile reads as a recorded uuid and a null name. */
  readonly recipient_display_name: string | null;
  readonly state: "pending" | "in_flight" | "delivered" | "dead";
  readonly attempts: number;
  readonly last_status: number | null;
  readonly last_error: string | null;
  readonly delivered_at: Date | null;
  readonly created_at: Date;
  /**
   * Whether the inbox copy of this signal still exists.
   *
   * False is the whole point of 0046: this row is then the only record that the signal was
   * ever pushed anywhere. A caller rendering a delivery log should say so rather than
   * showing a dead link to a notification that has been pruned.
   */
  readonly notification_present: boolean;
  /**
   * Whether the endpoint this was addressed to still exists (0048).
   *
   * Separate from `notification_present` because the two answer different questions and a
   * reader acts on them differently: the inbox copy being gone is retention working, where
   * the destination being gone means nobody can resend this and the url beside it is the
   * only record of where it went.
   */
  readonly endpoint_present: boolean;
}

/**
 * Every push for one signal, oldest first.
 *
 * Takes the notification id and NOT a notification, deliberately: the id is the correlation
 * value that went out on the wire (`claimDue` puts it in the webhook body as
 * `notificationId`), so it is what a receiver quotes back when they ask why they were
 * paged — and it still resolves here after the notification itself has been pruned. That is
 * the one thing an `ON DELETE SET NULL` would have destroyed.
 */
export async function deliveryHistory(
  tx: PoolClient,
  notificationId: string,
): Promise<readonly DeliveryRecord[]> {
  const { rows } = await tx.query<DeliveryRecord>(
    `SELECT * FROM crm.notification_delivery_history($1)`,
    [notificationId],
  );
  return rows;
}

/**
 * What this tenant has pushed lately, newest first.
 *
 * Ordered by `seq DESC` in SQL, not by a timestamp — 0041's lesson, which applies here for
 * the same reason it applied to the dead-letter listing: a dispatch fan-out writes several
 * rows in one transaction and `created_at` is the transaction clock, so a time-ordered
 * listing reports whichever row the plan produced first as the latest push.
 */
export async function recentDeliveries(
  tx: PoolClient,
  opts: { limit?: number } = {},
): Promise<readonly DeliveryRecord[]> {
  const { rows } = await tx.query<DeliveryRecord>(
    `SELECT * FROM crm.notification_delivery_recent($1)`,
    [opts.limit ?? 50],
  );
  return rows;
}
