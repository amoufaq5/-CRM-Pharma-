import type { PoolClient } from "pg";

import { meetsSeverity, type NotificationKind, type Severity } from "./kinds.js";

/**
 * Raising a notification: the one way anything in this system tells someone.
 *
 * Runs inside the caller's transaction, which is the point. The expiry sweep opens a
 * disposal obligation and raises the notification in the same transaction, so there is no
 * state where an obligation exists and nobody was told — nor one where someone was told
 * about an obligation that rolled back.
 *
 * In-app delivery IS the row. Webhook deliveries are enqueued here and drained later by
 * the scheduler, because an external call must not sit inside a business transaction.
 */

export interface RaiseInput {
  readonly recipientRepProfileId: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly subject: string;
  readonly body: string;
  /**
   * Makes raising idempotent, and is why the nightly sweep can call this unconditionally.
   * Include everything that makes the signal distinct and nothing that does not: an id
   * and an event name, never a timestamp.
   */
  readonly dedupKey: string;
  readonly subjectTable?: string;
  readonly subjectId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface RaiseResult {
  readonly id: string;
  /** False when the dedup key had already been used for this recipient. */
  readonly created: boolean;
  /** Webhook deliveries enqueued. Zero when nothing was created, or no endpoint matched. */
  readonly deliveries: number;
  /**
   * Endpoints that wanted this signal and were skipped because the recipient has no mailbox
   * (0065, the `email_recipient` channel).
   *
   * COUNTED RATHER THAN DEAD-LETTERED, and that was the decision. A `dead` delivery saying
   * "this rep has no notification address" is better evidence and worse behaviour: it would
   * be re-created and re-killed on every raise, forever, filling the one table 0046 exists to
   * keep honest with rows that describe a configuration gap rather than a push. So the gap is
   * a number here, and `notifyAddressCoverage` is the list an administrator acts on.
   *
   * Zero on every other channel and on a signal that was already raised.
   */
  readonly unaddressable: number;
}

interface EndpointRow {
  readonly id: string;
  readonly channel: string;
  readonly min_severity: Severity;
  readonly kinds: readonly string[] | null;
  /**
   * The recipient's mailbox, repeated on every row by the join below. Null when they have
   * none, or when the destination was withdrawn — the two are the same answer here, which is
   * correct: neither is somewhere mail can go.
   */
  readonly to_address: string | null;
}

/** The channel whose destination comes from whoever the notification names (0065). */
const PER_RECIPIENT_CHANNEL = "email_recipient";

export async function raiseNotification(
  tx: PoolClient,
  tenantId: string,
  input: RaiseInput,
): Promise<RaiseResult> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm.notification
       (tenant_id, recipient_rep_profile_id, kind, severity, subject, body,
        subject_table, subject_id, payload, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, recipient_rep_profile_id, dedup_key) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      input.recipientRepProfileId,
      input.kind,
      input.severity,
      input.subject,
      input.body,
      input.subjectTable ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.dedupKey,
    ],
  );

  const created = rows[0];
  if (created === undefined) {
    // Already raised. No second notification, and crucially no second delivery — a
    // nightly sweep must not page someone every night about the same carton.
    const { rows: existing } = await tx.query<{ id: string }>(
      `SELECT id FROM crm.notification
        WHERE tenant_id = $1 AND recipient_rep_profile_id = $2 AND dedup_key = $3`,
      [tenantId, input.recipientRepProfileId, input.dedupKey],
    );
    return { id: existing[0]!.id, created: false, deliveries: 0, unaddressable: 0 };
  }

  // Fan out to whichever endpoints want this signal. Filtering here rather than at send
  // time means an endpoint added tomorrow does not receive a backlog of today's events —
  // which is what someone turning on a Slack hook would otherwise get.
  //
  // The recipient's own mailbox rides along on the same query since 0065, rather than in a
  // second round trip: every delivery of one raise shares one recipient, so the address is
  // the same for all of them, and a tenant with no `email_recipient` endpoint must not pay
  // for a lookup it will not read.
  const { rows: endpoints } = await tx.query<EndpointRow>(
    `SELECT e.id, e.channel, e.min_severity, e.kinds, a.address AS to_address
       FROM crm.notification_endpoint e
       LEFT JOIN crm.rep_notify_address a
              ON a.tenant_id = e.tenant_id AND a.rep_profile_id = $2
      WHERE e.tenant_id = $1 AND e.enabled`,
    [tenantId, input.recipientRepProfileId],
  );

  let deliveries = 0;
  let unaddressable = 0;
  for (const endpoint of endpoints) {
    if (!meetsSeverity(input.severity, endpoint.min_severity)) continue;
    if (endpoint.kinds !== null && !endpoint.kinds.includes(input.kind)) continue;

    // 0065. The filters above come first deliberately: an endpoint that did not want this
    // signal is not a destination that failed, so a rep with no mailbox is NOT reported
    // unaddressable by an endpoint that would have skipped them anyway.
    const perRecipient = endpoint.channel === PER_RECIPIENT_CHANNEL;
    if (perRecipient && endpoint.to_address === null) {
      unaddressable += 1;
      continue;
    }

    await tx.query(
      // The conflict target names `tenant_id` since 0046: a unique index is enforced with
      // row security disabled, so the old `(notification_id, endpoint_id)` key was
      // cross-tenant — latent while the composite foreign key beside it co-guaranteed the
      // pairing, and 0046 drops that key, so the tenant joins the key itself (0043's rule).
      //
      // `to_address` is copied here and not joined at send time, which is 0049's argument
      // applied to a destination that varies per row: a delivery record outlives the
      // notification AND the endpoint, and for this channel the endpoint's url is the marker
      // `mailto:*`, so the row itself has to carry the mailbox or nothing says where the
      // signal went. 0065's CHECK pairs it with the channel in both directions, so a null
      // here on `email_recipient` — or a non-null on any other channel — is refused rather
      // than stored.
      `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, to_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, notification_id, endpoint_id) DO NOTHING`,
      [tenantId, created.id, endpoint.id, perRecipient ? endpoint.to_address : null],
    );
    deliveries += 1;
  }

  return { id: created.id, created: true, deliveries, unaddressable };
}

/**
 * Raises the same signal for everyone who supervises a rep.
 *
 * The recipients come from `crm.supervisors_of`, so "who is accountable for this rep" has
 * the same answer here as it does for a manager's team views. The dedup key is suffixed
 * per recipient by the unique constraint's shape — it is scoped to (tenant, recipient,
 * key) — so one event reaches three managers once each.
 */
export async function raiseForSupervisors(
  tx: PoolClient,
  tenantId: string,
  repProfileId: string,
  input: Omit<RaiseInput, "recipientRepProfileId">,
  opts: { readonly on?: string } = {},
): Promise<readonly RaiseResult[]> {
  const { rows } = await tx.query<{ rep_profile_id: string }>(
    `SELECT rep_profile_id FROM crm.supervisors_of($1, COALESCE($2::date, CURRENT_DATE))`,
    [repProfileId, opts.on ?? null],
  );
  const out: RaiseResult[] = [];
  for (const supervisor of rows) {
    out.push(await raiseNotification(tx, tenantId, { ...input, recipientRepProfileId: supervisor.rep_profile_id }));
  }
  return out;
}
