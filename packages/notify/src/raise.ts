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
}

interface EndpointRow {
  readonly id: string;
  readonly min_severity: Severity;
  readonly kinds: readonly string[] | null;
}

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
    return { id: existing[0]!.id, created: false, deliveries: 0 };
  }

  // Fan out to whichever endpoints want this signal. Filtering here rather than at send
  // time means an endpoint added tomorrow does not receive a backlog of today's events —
  // which is what someone turning on a Slack hook would otherwise get.
  const { rows: endpoints } = await tx.query<EndpointRow>(
    `SELECT id, min_severity, kinds FROM crm.notification_endpoint
      WHERE tenant_id = $1 AND enabled`,
    [tenantId],
  );

  let deliveries = 0;
  for (const endpoint of endpoints) {
    if (!meetsSeverity(input.severity, endpoint.min_severity)) continue;
    if (endpoint.kinds !== null && !endpoint.kinds.includes(input.kind)) continue;
    await tx.query(
      `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (notification_id, endpoint_id) DO NOTHING`,
      [tenantId, created.id, endpoint.id],
    );
    deliveries += 1;
  }

  return { id: created.id, created: true, deliveries };
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
