import type { PoolClient } from "pg";
import { assertTransition, type VisitStatus } from "./status.js";
import { translateVisitError, VisitNotFoundError } from "./errors.js";

export interface Visit {
  readonly id: string;
  readonly rep_profile_id: string;
  readonly erp_account_id: string;
  readonly erp_contact_id: string | null;
  readonly visit_type: string;
  readonly status: VisitStatus;
  readonly planned_for: string | null;
  readonly occurred_at: string | null;
  readonly duration_minutes: number | null;
  readonly outcome: string | null;
  readonly notes: string | null;
  readonly recorded_at: string;
}

export interface VisitProduct {
  readonly id: string;
  readonly erp_item_id: string;
  readonly position: number;
  readonly key_message: string | null;
  readonly reaction: string | null;
}

const COLUMNS = `id, rep_profile_id, erp_account_id, erp_contact_id, visit_type, status,
  planned_for::text, occurred_at::text, duration_minutes, outcome, notes, recorded_at::text`;

export interface RecordVisitInput {
  /** Minted on the DEVICE, before the visit ever reaches the server. */
  readonly id: string;
  readonly repProfileId: string;
  readonly erpAccountId: string;
  readonly erpContactId?: string | null;
  readonly visitType?: string;
  readonly status?: VisitStatus;
  readonly plannedFor?: string | null;
  readonly occurredAt?: string | null;
  readonly durationMinutes?: number | null;
  readonly checkin?: { latitude: number; longitude: number; accuracyM?: number } | null;
  readonly outcome?: string | null;
  readonly notes?: string | null;
}

/**
 * Records a visit, idempotently.
 *
 * The id comes from the device, so a sync that retried after a dropped
 * connection re-sends the SAME id and collapses into the same row instead of
 * creating a second visit. This is the same guarantee the outbox relies on, and
 * for a rep in a hospital basement it is the difference between an accurate call
 * report and a duplicated one.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: a device that recorded the
 * visit offline, then added notes before it synced, must have the later version
 * win. The immutability trigger still refuses the update if the stored visit is
 * already final, so a replay cannot rewrite a finished record.
 *
 * `recorded_at` is NOT updated on conflict. It is when the server first heard
 * about this visit, and that fact does not change because the device spoke
 * again.
 */
export async function recordVisit(
  tx: PoolClient,
  tenantId: string,
  input: RecordVisitInput,
): Promise<Visit> {
  try {
    const { rows } = await tx.query<Visit>(
      `INSERT INTO crm.visit
         (id, tenant_id, rep_profile_id, erp_account_id, erp_contact_id, visit_type, status,
          planned_for, occurred_at, duration_minutes,
          checkin_latitude, checkin_longitude, checkin_accuracy_m, outcome, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'detailing'),COALESCE($7,'planned'),
               $8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         erp_contact_id    = EXCLUDED.erp_contact_id,
         visit_type        = EXCLUDED.visit_type,
         status            = EXCLUDED.status,
         planned_for       = EXCLUDED.planned_for,
         occurred_at       = EXCLUDED.occurred_at,
         duration_minutes  = EXCLUDED.duration_minutes,
         checkin_latitude  = EXCLUDED.checkin_latitude,
         checkin_longitude = EXCLUDED.checkin_longitude,
         checkin_accuracy_m = EXCLUDED.checkin_accuracy_m,
         outcome           = EXCLUDED.outcome,
         notes             = EXCLUDED.notes,
         updated_at        = now()
       RETURNING ${COLUMNS}`,
      [
        input.id,
        tenantId,
        input.repProfileId,
        input.erpAccountId,
        input.erpContactId ?? null,
        input.visitType ?? null,
        input.status ?? null,
        input.plannedFor ?? null,
        input.occurredAt ?? null,
        input.durationMinutes ?? null,
        input.checkin?.latitude ?? null,
        input.checkin?.longitude ?? null,
        input.checkin?.accuracyM ?? null,
        input.outcome ?? null,
        input.notes ?? null,
      ],
    );
    return rows[0]!;
  } catch (err) {
    throw translateVisitError(err);
  }
}

export async function getVisit(tx: PoolClient, id: string): Promise<Visit | null> {
  const { rows } = await tx.query<Visit>(`SELECT ${COLUMNS} FROM crm.visit WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Moves a visit to a new status, checking the transition first.
 *
 * The check is here as well as in the database because the messages differ in
 * kind: this one can say what WOULD have been allowed, which a trigger raising
 * on an immutable row cannot. The database remains the authority — it refuses a
 * final row regardless of what any caller believes.
 */
export async function transitionVisit(
  tx: PoolClient,
  id: string,
  to: VisitStatus,
  patch: { occurredAt?: string; durationMinutes?: number; outcome?: string | null; notes?: string } = {},
): Promise<Visit> {
  const current = await getVisit(tx, id);
  if (current === null) throw new VisitNotFoundError(id);
  assertTransition(current.status, to);

  try {
    const { rows } = await tx.query<Visit>(
      `UPDATE crm.visit SET
         status           = $2,
         occurred_at      = COALESCE($3::timestamptz, occurred_at,
                                     CASE WHEN $2 IN ('in_progress','completed') THEN now() END),
         duration_minutes = COALESCE($4, duration_minutes),
         outcome          = COALESCE($5, outcome),
         notes            = COALESCE($6, notes),
         updated_at       = now()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, to, patch.occurredAt ?? null, patch.durationMinutes ?? null, patch.outcome ?? null, patch.notes ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw translateVisitError(err);
  }
}

/**
 * Appends to a finished visit's notes.
 *
 * The one edit a final visit allows. A rep remembering something on the drive
 * home is a normal and useful thing; silently rewriting what was reported is
 * not, which is why this appends with a timestamp rather than replacing.
 */
export async function appendNote(
  tx: PoolClient,
  id: string,
  note: string,
  at: Date = new Date(),
): Promise<Visit> {
  const stamped = `[${at.toISOString()}] ${note}`;
  try {
    const { rows } = await tx.query<Visit>(
      `UPDATE crm.visit
          SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || E'\\n' || $2 END,
              updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, stamped],
    );
    if (rows[0] === undefined) throw new VisitNotFoundError(id);
    return rows[0];
  } catch (err) {
    throw translateVisitError(err);
  }
}

/** Replaces a visit's detailing lines. Refused once the visit is final. */
export async function setVisitProducts(
  tx: PoolClient,
  tenantId: string,
  visitId: string,
  products: ReadonlyArray<{ erpItemId: string; keyMessage?: string; reaction?: string }>,
): Promise<readonly VisitProduct[]> {
  try {
    await tx.query("DELETE FROM crm.visit_product WHERE visit_id = $1", [visitId]);
    if (products.length === 0) return [];

    const params: unknown[] = [];
    const tuples = products.map((p, i) => {
      // `position` is 1-based and assigned from array order: the sequence a rep
      // detailed in is the sequence they sent.
      const values = [tenantId, visitId, p.erpItemId, i + 1, p.keyMessage ?? null, p.reaction ?? null];
      return `(${values.map((v) => `$${params.push(v)}`).join(", ")})`;
    });
    const { rows } = await tx.query<VisitProduct>(
      `INSERT INTO crm.visit_product (tenant_id, visit_id, erp_item_id, position, key_message, reaction)
       VALUES ${tuples.join(", ")}
       RETURNING id, erp_item_id, position, key_message, reaction`,
      params,
    );
    return rows;
  } catch (err) {
    throw translateVisitError(err);
  }
}

export async function getVisitProducts(tx: PoolClient, visitId: string): Promise<readonly VisitProduct[]> {
  const { rows } = await tx.query<VisitProduct>(
    "SELECT id, erp_item_id, position, key_message, reaction FROM crm.visit_product WHERE visit_id = $1 ORDER BY position",
    [visitId],
  );
  return rows;
}

export interface VisitQuery {
  readonly repProfileId?: string;
  readonly erpAccountId?: string;
  readonly status?: readonly VisitStatus[];
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

/**
 * Lists visits.
 *
 * RLS confines this to the tenant, but NOT to the rep — a manager legitimately
 * reads their team's visits. Narrowing to one rep's own is the caller's
 * decision, made with `crm.visible_account_ids`, because "which visits may I
 * see" and "which visits exist" are different questions and conflating them
 * here would make a manager's dashboard impossible to write.
 */
export async function listVisits(tx: PoolClient, query: VisitQuery = {}): Promise<readonly Visit[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.repProfileId !== undefined) where.push(`rep_profile_id = $${params.push(query.repProfileId)}`);
  if (query.erpAccountId !== undefined) where.push(`erp_account_id = $${params.push(query.erpAccountId)}`);
  if (query.status !== undefined && query.status.length > 0) {
    where.push(`status = ANY($${params.push([...query.status])}::text[])`);
  }
  if (query.from !== undefined) where.push(`occurred_at >= $${params.push(query.from)}::timestamptz`);
  if (query.to !== undefined) where.push(`occurred_at < $${params.push(query.to)}::timestamptz`);

  const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
  const { rows } = await tx.query<Visit>(
    `SELECT ${COLUMNS} FROM crm.visit
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(occurred_at, planned_for::timestamptz) DESC NULLS LAST, id
      LIMIT ${limit}`,
    params,
  );
  return rows;
}
