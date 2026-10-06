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
 * The four `notification_*`/`recipient_*` fields are COPIES taken when the push was
 * enqueued, so they are still here when the notification is not. `endpoint_channel` and
 * `endpoint_url` are JOINED and therefore nullable: the endpoint reference survives 0046
 * untouched, so there is nothing to copy — but its own `ON DELETE CASCADE` means a deleted
 * endpoint would take this row with it, which is recorded as the remaining half of the
 * problem rather than worked around here.
 */
export interface DeliveryRecord {
  readonly id: string;
  /** The write order. `bigint`, read as text — `crm.outbox.seq`'s convention. */
  readonly seq: string;
  readonly notification_id: string;
  readonly endpoint_id: string;
  readonly endpoint_channel: string | null;
  readonly endpoint_url: string | null;
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
