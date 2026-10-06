import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import type { ChannelSender, SendOutcome, WebhookPayload } from "./sender.js";

/**
 * Draining pending deliveries.
 *
 * The same claim/retry/dead-letter discipline as the ERP outbox relay, and for the same
 * reasons: `next_attempt_at` advances AT CLAIM TIME so a crash mid-send cannot hot-loop,
 * `FOR UPDATE SKIP LOCKED` lets several scheduler instances share the work without a
 * lock, and the external call happens between two short transactions rather than inside
 * one long one.
 *
 * What it does NOT share is the outbox's idempotency guarantee. The ERP is unique on
 * (tenant, entity, record_id), so a redelivery there collapses; a webhook receiver makes
 * no such promise. Delivery is therefore at-least-once with the delivery id in a header,
 * and collapsing a duplicate is the receiver's job — stated plainly because a reader who
 * assumes otherwise will be wrong at the worst moment.
 */

/** Attempts before a delivery is dead-lettered. ~17 minutes of trying, with the curve below. */
export const MAX_ATTEMPTS = 8;

/**
 * Backoff for a retryable failure: 10s, 20s, 40s … capped at 5 minutes, with full jitter.
 *
 * Snappier than the ERP relay's curve on purpose. A notification is only useful while it
 * is still news, and an endpoint that is briefly down usually comes back in seconds — so
 * the first few retries are close together, where the relay's can afford to be patient.
 */
export function nextDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 300_000);
  // Full jitter, not a ±10% band: when an endpoint recovers, every queued delivery for it
  // becomes due at once, and a narrow band would reproduce the thundering herd that took
  // it down.
  return Math.max(1_000, Math.round(base * random()));
}

export interface ClaimedDelivery {
  readonly id: string;
  readonly notification_id: string;
  /** The write order (0046). `bigint`, so it is read as text — `crm.outbox.seq`'s convention. */
  readonly seq: string;
  readonly attempts: number;
  readonly endpoint_id: string;
  readonly channel: string;
  readonly url: string;
  readonly secret_env: string;
  readonly payload: WebhookPayload;
}

/**
 * Settles deliveries whose notification no longer exists.
 *
 * NEW WITH 0046, AND ONLY BECAUSE OF IT. While `crm.notification_delivery` cascaded from
 * `crm.notification` this state could not arise; with the reference dropped it can, and it
 * had to be handled rather than discovered: `claimDue` builds its payload by joining the
 * notification, so an orphan would be CLAIMED by the statement's first CTE — `attempts`
 * incremented, `next_attempt_at` advanced — and then dropped by the inner join, so it would
 * be consumed on every tick without ever being delivered, dead-lettered or counted. Silent
 * and unbounded.
 *
 * DEAD, not deleted and not left pending. The payload cannot be rebuilt from anything this
 * row carries (0046 deliberately copies no `subject`, `body` or `payload` — see its header),
 * so this is a permanent refusal and `dead` is the state for one. Deleting it would throw
 * away the record of a push that was enqueued, which is the opposite of what 0046 is for;
 * leaving it pending would leave it invisible.
 *
 * It takes a prune's hold with it: a `dead` delivery is never pruned at any horizon, so an
 * orphan settled this way is retained indefinitely. That is acceptable because the only way
 * to reach it is a hand-written DELETE of a notification with a live delivery — the prune
 * itself cannot, since an unsettled delivery holds its notification back (0024).
 */
export async function settleOrphanedDeliveries(
  tx: PoolClient,
  tenantId: string,
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE crm.notification_delivery d
        SET state = 'dead',
            last_error = left('the notification this push describes no longer exists, so its '
                              || 'payload cannot be rebuilt — recorded as undeliverable', 2000)
      WHERE d.tenant_id = $1
        AND d.state IN ('pending', 'in_flight')
        AND NOT EXISTS (SELECT 1 FROM crm.notification n
                         WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id)`,
    [tenantId],
  );
  return rowCount ?? 0;
}

/**
 * Claims due deliveries and moves their next attempt forward in the same statement.
 *
 * One query builds the payload too, so the sender needs nothing else: a second round trip
 * per delivery would be the dominant cost of a quiet night.
 *
 * EVERY ORDERING TERM IS `seq` SINCE 0046, and the reason is the one 0027, 0033 and 0041
 * all record. `next_attempt_at` defaults to `now()`, the TRANSACTION timestamp, so a signal
 * fanned out to three endpoints — or a whole expiry sweep's worth of deliveries, written in
 * one transaction by design — becomes due at the identical instant; and the final
 * `ORDER BY n.created_at` was the same clock a second time. Both sorts therefore fell
 * through to the plan, so a batch's claim order and the order the sender worked through it
 * were arbitrary among tied rows. `seq` is the insert order, which is what "oldest push
 * first" was always supposed to mean.
 *
 * The `due` CTE also requires the notification to still exist, so an orphan is never
 * claimed-and-lost by the inner join below. `settleOrphanedDeliveries` is what gives those
 * rows an outcome; this predicate is what stops them being consumed silently in the
 * meantime, and the two are deliberately separate — a claim must not be the thing that
 * dead-letters.
 */
export async function claimDue(
  tx: PoolClient,
  tenantId: string,
  now: Date,
  limit = 20,
  random: () => number = Math.random,
): Promise<readonly ClaimedDelivery[]> {
  const { rows } = await tx.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT d.id
         FROM crm.notification_delivery d
        WHERE d.tenant_id = $1
          AND d.state IN ('pending', 'in_flight')
          AND d.next_attempt_at <= $2
          AND EXISTS (SELECT 1 FROM crm.notification n
                       WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id)
        ORDER BY d.next_attempt_at, d.seq
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE crm.notification_delivery d
          SET state = 'in_flight',
              attempts = d.attempts + 1,
              next_attempt_at = $2::timestamptz + ($4 || ' milliseconds')::interval
        WHERE d.id IN (SELECT id FROM due)
        RETURNING d.id, d.tenant_id, d.notification_id, d.endpoint_id, d.attempts, d.seq
     )
     SELECT c.id, c.notification_id, c.seq::text AS seq, c.attempts, c.endpoint_id,
            e.channel, e.url, e.secret_env,
            jsonb_build_object(
              'deliveryId', c.id,
              'notificationId', n.id,
              'tenantId', n.tenant_id,
              'kind', n.kind,
              'severity', n.severity,
              'subject', n.subject,
              'body', n.body,
              'recipient', jsonb_build_object('repProfileId', rp.id, 'displayName', rp.display_name),
              'subjectRef', jsonb_build_object('table', n.subject_table, 'id', n.subject_id),
              'payload', n.payload,
              'createdAt', to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ) AS payload
       FROM claimed c
       -- Every join carries its tenant term since 0046. None of them is a behaviour
       -- change: all three tables are RLS-FORCEd and this runs inside a tenant context,
       -- so the policy already confined them. They are written out for 0043's reason --
       -- the composite foreign key that made the notification pairing structural is
       -- gone, so a reader of this query must be able to see the tenant match here
       -- rather than infer it from a policy two files away.
       JOIN crm.notification n ON n.tenant_id = c.tenant_id AND n.id = c.notification_id
       JOIN crm.rep_profile rp ON rp.tenant_id = n.tenant_id AND rp.id = n.recipient_rep_profile_id
       JOIN crm.notification_endpoint e ON e.tenant_id = c.tenant_id AND e.id = c.endpoint_id
      ORDER BY c.seq`,
    [tenantId, now, limit, nextDelayMs(1, random)],
  );
  return rows;
}

export async function markDelivered(
  tx: PoolClient,
  id: string,
  status: number | undefined,
  now: Date,
): Promise<void> {
  await tx.query(
    `UPDATE crm.notification_delivery
        SET state = 'delivered', delivered_at = $2, last_status = $3, last_error = NULL
      WHERE id = $1`,
    [id, now, status ?? null],
  );
}

export async function markRetry(
  tx: PoolClient,
  id: string,
  attempts: number,
  outcome: SendOutcome,
  now: Date,
  random: () => number = Math.random,
): Promise<"retry" | "dead"> {
  // The attempt ceiling is applied HERE rather than at claim time, so the reason a
  // delivery died is the last real failure rather than "it was too old to try".
  if (attempts >= MAX_ATTEMPTS) {
    await markDead(tx, id, { ...outcome, error: `${outcome.error ?? "failed"} (gave up after ${attempts} attempts)` });
    return "dead";
  }
  await tx.query(
    `UPDATE crm.notification_delivery
        SET state = 'pending',
            next_attempt_at = $2::timestamptz + ($3 || ' milliseconds')::interval,
            last_status = $4,
            last_error = left($5, 2000)
      WHERE id = $1`,
    [id, now, nextDelayMs(attempts, random), outcome.status ?? null, outcome.error ?? null],
  );
  return "retry";
}

export async function markDead(tx: PoolClient, id: string, outcome: SendOutcome): Promise<void> {
  await tx.query(
    `UPDATE crm.notification_delivery
        SET state = 'dead', last_status = $2, last_error = left($3, 2000)
      WHERE id = $1`,
    [id, outcome.status ?? null, outcome.error ?? null],
  );
}

export interface DispatchResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  readonly pending: number;
  /**
   * Unsettled deliveries whose notification was gone, recorded as undeliverable (0046).
   *
   * Counted separately from `dead` because the cause is different in kind: a `dead` row
   * means a destination refused us, and this one means somebody removed the message out
   * from under a queued push. A non-zero value here is not an endpoint problem.
   */
  readonly orphaned: number;
}

export interface NotificationDispatcherOptions {
  readonly pool: Pool;
  readonly senders: readonly ChannelSender[];
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export class NotificationDispatcher {
  private readonly senders: Map<string, ChannelSender>;

  constructor(private readonly opts: NotificationDispatcherOptions) {
    this.senders = new Map(opts.senders.map((s) => [s.channel, s]));
  }

  /**
   * One pass for one tenant.
   *
   * Claim and settle are separate transactions with the HTTP call between them, never one
   * transaction held open across the network — a slow endpoint would otherwise hold a row
   * lock for its whole timeout and block the next pass.
   */
  async drainTenant(tenantId: string): Promise<DispatchResult> {
    const now = this.opts.now ?? ((): Date => new Date());
    const random = this.opts.random ?? Math.random;
    const client = await this.opts.pool.connect();

    let delivered = 0;
    let retried = 0;
    let dead = 0;
    try {
      // Before the claim, in its own transaction: an orphan is not claimable (the `due` CTE
      // refuses it) so it would otherwise sit unsettled and uncounted forever. Settling
      // first also means the `pending` figure at the end of this pass is a count of pushes
      // that can actually still happen.
      const orphaned = await withTenantContext(client, tenantId, (tx) =>
        settleOrphanedDeliveries(tx, tenantId),
      );

      const claimed = await withTenantContext(client, tenantId, (tx) =>
        claimDue(tx, tenantId, now(), this.opts.batchSize ?? 20, random),
      );

      for (const delivery of claimed) {
        const sender = this.senders.get(delivery.channel);
        const outcome: SendOutcome =
          sender === undefined
            ? // RETRY, not dead. A missing sender is a statement about THIS PROCESS, not
              // about the destination: the endpoint row is legal (0029 admits `email`) and
              // the notification is deliverable the moment a process that registers the
              // channel takes a tick. Dead-lettering it destroyed every notification routed
              // to a correctly configured endpoint whose sender the running binary happened
              // not to have. `markRetry` still gives up at MAX_ATTEMPTS, so a channel nobody
              // ever registers dead-letters on its own rather than retrying forever.
              {
                kind: "retry",
                error:
                  `no sender registered for channel ${delivery.channel} in this process — ` +
                  `it registers ${[...this.senders.keys()].join(", ") || "none"}`,
              }
            : await sender.send(delivery.payload, {
                id: delivery.endpoint_id,
                url: delivery.url,
                secretEnv: delivery.secret_env,
              });

        await withTenantContext(client, tenantId, async (tx) => {
          if (outcome.kind === "delivered") {
            await markDelivered(tx, delivery.id, outcome.status, now());
            delivered += 1;
          } else if (outcome.kind === "dead") {
            await markDead(tx, delivery.id, outcome);
            dead += 1;
          } else if ((await markRetry(tx, delivery.id, delivery.attempts, outcome, now(), random)) === "dead") {
            dead += 1;
          } else {
            retried += 1;
          }
        });
      }

      const pending = await withTenantContext(client, tenantId, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM crm.notification_delivery
            WHERE tenant_id = $1 AND state IN ('pending', 'in_flight')`,
          [tenantId],
        );
        return Number(rows[0]!.n);
      });

      return { claimed: claimed.length, delivered, retried, dead, pending, orphaned };
    } finally {
      client.release();
    }
  }
}
