import type { PoolClient } from "pg";

export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly entity: string;
  readonly operation: string;
  readonly payload: Record<string, unknown>;
  readonly target_record_id: string;
  readonly source_table: string;
  readonly source_id: string;
  readonly attempts: number;
}

const ROW_COLUMNS =
  "id, tenant_id, entity, operation, payload, target_record_id, source_table, source_id, attempts";

/**
 * Claims up to `limit` due rows for this worker, oldest due first and in
 * enqueue order within a tie.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes multiple relay workers safe: each
 * claims a disjoint set without blocking on the others. Without SKIP LOCKED,
 * two workers serialise on the same head-of-queue row and throughput collapses
 * to one worker's.
 *
 * `attempts` increments AT CLAIM TIME, not on failure. A worker that dies
 * mid-dispatch has still consumed an attempt, so a row that reliably kills its
 * worker — the poison message — walks its way to dead-lettering instead of being
 * retried forever by successive victims.
 *
 * The tie-breaker is `seq` (0027), not `created_at`: `created_at` defaults to
 * `now()`, which is the TRANSACTION timestamp, so two rows enqueued together —
 * a create and the transition that acts on it, the normal shape here — carry the
 * same value to the microsecond and the order between them was whatever the plan
 * produced. `seq` is allocated per INSERT, so it orders them. It does NOT order
 * concurrent enqueues: sequence values are handed out before commit and in no
 * particular relation to it, so a lower `seq` can become visible after a higher
 * one and be claimed by a later drain. `classify`'s `retry_ordering` remains the
 * backstop for that; see 0027's header.
 *
 * Returned as a SORTED SELECT over a data-modifying CTE rather than straight
 * from `RETURNING`, because `RETURNING` row order is unspecified — it follows the
 * update's physical scan, not the subquery's ORDER BY. The relay dispatches this
 * array in order, so sorting it is the half of the fix that is actually visible.
 *
 * NOTE: runs inside `withTenantContext`, so RLS confines it to one tenant. The
 * relay loops over tenants rather than draining the table globally; a
 * cross-tenant drain would need to bypass RLS, which is exactly what this
 * design refuses to do.
 */
export async function claimBatch(
  tx: PoolClient,
  tenantId: string,
  workerId: string,
  limit: number,
  now: Date,
): Promise<readonly OutboxRow[]> {
  const { rows } = await tx.query<OutboxRow>(
    `WITH due AS (
       SELECT id FROM crm.outbox
        WHERE tenant_id = $1
          AND state = 'pending'
          AND next_attempt_at <= $4
        ORDER BY next_attempt_at, seq
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     ), claimed AS (
       UPDATE crm.outbox SET
         state      = 'in_flight',
         attempts   = attempts + 1,
         claimed_at = $4,
         claimed_by = $3
       WHERE id IN (SELECT id FROM due)
       RETURNING ${ROW_COLUMNS}, next_attempt_at, seq
     )
     SELECT ${ROW_COLUMNS} FROM claimed ORDER BY next_attempt_at, seq`,
    [tenantId, limit, workerId, now],
  );
  return rows;
}

/**
 * Returns rows whose lease expired to `pending` so another worker can take them.
 *
 * A worker that is killed between claiming and settling leaves its rows in
 * `in_flight` forever: no other worker looks at them (they are not `pending`)
 * and nothing else times them out. The row is not lost — it is permanently
 * invisible, which is worse, because the claim looked like it worked.
 */
export async function reclaimStale(
  tx: PoolClient,
  tenantId: string,
  leaseMs: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const { rowCount } = await tx.query(
    `UPDATE crm.outbox
        SET state = 'pending', claimed_at = NULL, claimed_by = NULL,
            last_error = COALESCE(last_error, 'lease expired; reclaimed')
      WHERE tenant_id = $1 AND state = 'in_flight' AND claimed_at < $2`,
    [tenantId, cutoff],
  );
  return rowCount ?? 0;
}

export async function markDelivered(
  tx: PoolClient,
  id: string,
  now: Date,
  response: unknown,
): Promise<void> {
  await tx.query(
    `UPDATE crm.outbox
        SET state = 'delivered', delivered_at = $2, last_error = NULL,
            claimed_at = NULL, claimed_by = NULL,
            erp_response = $3::jsonb
      WHERE id = $1`,
    [id, now, JSON.stringify(response ?? null)],
  );
}

export async function markRetry(
  tx: PoolClient,
  id: string,
  nextAttemptAt: Date,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE crm.outbox
        SET state = 'pending', next_attempt_at = $2, last_error = $3,
            claimed_at = NULL, claimed_by = NULL
      WHERE id = $1`,
    [id, nextAttemptAt, reason.slice(0, 2000)],
  );
}

export async function markDead(
  tx: PoolClient,
  id: string,
  now: Date,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE crm.outbox
        SET state = 'dead', dead_at = $2, dead_reason = $3, last_error = $3,
            claimed_at = NULL, claimed_by = NULL
      WHERE id = $1`,
    [id, now, reason.slice(0, 2000)],
  );
}

export interface OutboxLag {
  readonly pending: number;
  readonly inFlight: number;
  readonly dead: number;
  /** Age in seconds of the oldest undelivered row. The number to alert on. */
  readonly oldestPendingAgeSeconds: number | null;
}

/**
 * The relay's health in one row.
 *
 * `oldestPendingAgeSeconds` is the signal worth paging on: queue DEPTH is
 * ambiguous (a big snapshot sync looks identical to a stuck queue), whereas a
 * row that has sat for an hour is unambiguously wrong. `dead` should alert at
 * any value above zero — a dead row is a rep's write that silently never
 * reached the ERP.
 */
export async function outboxLag(tx: PoolClient, tenantId: string, now: Date): Promise<OutboxLag> {
  const { rows } = await tx.query<{
    pending: string;
    in_flight: string;
    dead: string;
    oldest: Date | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE state = 'pending')   AS pending,
       count(*) FILTER (WHERE state = 'in_flight') AS in_flight,
       count(*) FILTER (WHERE state = 'dead')      AS dead,
       min(created_at) FILTER (WHERE state IN ('pending','in_flight')) AS oldest
     FROM crm.outbox WHERE tenant_id = $1`,
    [tenantId],
  );
  const r = rows[0];
  const oldest = r?.oldest ?? null;
  return {
    pending: Number(r?.pending ?? 0),
    inFlight: Number(r?.in_flight ?? 0),
    dead: Number(r?.dead ?? 0),
    oldestPendingAgeSeconds:
      oldest === null ? null : Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)),
  };
}

export interface EnqueueInput {
  readonly entity: string;
  /** `create`, `update`, or `transition:<name>` — see `parseOperation`. */
  readonly operation: string;
  readonly payload: Record<string, unknown>;
  /**
   * The id the ERP record will carry. Minted by the CALLER, deterministically from
   * whatever CRM row is producing this, because that is what makes a redelivery
   * collapse into a unique violation the classifier reads as success rather than
   * creating a second ERP record.
   */
  readonly targetRecordId: string;
  readonly sourceTable: string;
  readonly sourceId: string;
}

/**
 * Appends to the outbox inside the caller's transaction.
 *
 * The only place anything is written to `crm.outbox`, deliberately: the
 * idempotency rule lives in the table's unique constraint and the deterministic
 * target id, and a second producer with its own INSERT would be a second chance to
 * get either wrong.
 *
 * Returns false when the row was already there. A double-tap in the mobile app, or
 * a replayed offline batch, must be a no-op rather than two ERP writes under two
 * different target ids — which no downstream constraint would catch, because they
 * would be two legitimately distinct records.
 *
 * `seq` comes from the column default, which is evaluated BEFORE the conflict is
 * detected — so a collapsed duplicate burns a sequence value and leaves a gap.
 * Routine rather than exceptional here, since a replayed offline batch is a
 * normal day: nothing may read `seq` as a count or infer a missing row from one.
 */
export async function enqueueOutbox(
  tx: PoolClient,
  tenantId: string,
  input: EnqueueInput,
): Promise<{ readonly enqueued: boolean; readonly id: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm.outbox
       (tenant_id, entity, operation, payload, target_record_id, source_table, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, entity, operation, target_record_id) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      input.entity,
      input.operation,
      JSON.stringify(input.payload),
      input.targetRecordId,
      input.sourceTable,
      input.sourceId,
    ],
  );
  if (rows[0] !== undefined) return { enqueued: true, id: rows[0].id };

  const { rows: existing } = await tx.query<{ id: string }>(
    `SELECT id FROM crm.outbox
      WHERE tenant_id = $1 AND entity = $2 AND operation = $3 AND target_record_id = $4`,
    [tenantId, input.entity, input.operation, input.targetRecordId],
  );
  return { enqueued: false, id: existing[0]!.id };
}
