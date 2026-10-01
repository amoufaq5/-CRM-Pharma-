import type { PoolClient } from "pg";

import { raiseNotification } from "@crm/notify";

import { SampleCountError, SampleLotNotFoundError, translateSampleError } from "./errors.js";

/**
 * Sample and promotional-material custody.
 *
 * Every function here records a movement; none of them writes a balance. The
 * balance is a projection the database maintains in the same transaction (0018),
 * which is the single difference between this and the ERP's `StockLevel` —
 * where both exist and nothing connects them.
 *
 * Quantities are **strings**, not numbers, for the same reason money is (ADR-0001):
 * they come out of `NUMERIC` and a float cannot hold every value a NUMERIC(16,3)
 * can. A caller that wants arithmetic can parse; a caller that wants to display or
 * round-trip must not be handed a lossy value to start with.
 */

export type MaterialKind = "drug_sample" | "promo_material";
export type LotStatus = "active" | "quarantined" | "withdrawn";

export type TransactionKind =
  | "receipt"
  | "transfer_in"
  | "adjustment_in"
  | "disbursement"
  | "transfer_out"
  | "return_to_warehouse"
  | "destruction"
  | "expiry_writeoff"
  | "adjustment_out";

export interface SampleLot {
  readonly id: string;
  readonly erp_item_id: string;
  readonly lot_number: string;
  readonly expiry_date: string | null;
  readonly material_kind: MaterialKind;
  readonly controlled: boolean;
  readonly status: LotStatus;
  readonly status_reason: string | null;
}

export interface SampleHolding {
  readonly rep_profile_id: string;
  readonly lot_id: string;
  readonly erp_item_id: string;
  readonly lot_number: string;
  readonly expiry_date: string | null;
  readonly material_kind: MaterialKind;
  readonly quantity_on_hand: string;
  readonly quantity_in_transit: string;
  readonly last_movement_at: Date | null;
  readonly last_counted_at: Date | null;
}

export interface SampleTransaction {
  readonly id: string;
  readonly lot_id: string;
  readonly rep_profile_id: string;
  readonly kind: TransactionKind;
  readonly quantity: string;
  readonly erp_account_id: string | null;
  readonly erp_contact_id: string | null;
  readonly visit_id: string | null;
  readonly recipient_name: string | null;
  readonly signature_sha256: string | null;
  readonly erp_warehouse_id: string | null;
  readonly counterparty_rep_profile_id: string | null;
  readonly transfer_of: string | null;
  readonly reason: string | null;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
}

export interface ExpiringHolding {
  readonly rep_profile_id: string;
  readonly lot_id: string;
  readonly erp_item_id: string;
  readonly lot_number: string;
  readonly expiry_date: string;
  readonly days_remaining: number;
  readonly quantity_on_hand: string;
}

const LOT_COLUMNS =
  "id, erp_item_id::text AS erp_item_id, lot_number, expiry_date::text AS expiry_date, " +
  "material_kind, controlled, status, status_reason";

const TX_COLUMNS =
  "id, lot_id, rep_profile_id, kind, quantity::text AS quantity, " +
  "erp_account_id::text AS erp_account_id, erp_contact_id::text AS erp_contact_id, visit_id, " +
  "recipient_name, signature_sha256, erp_warehouse_id::text AS erp_warehouse_id, " +
  "counterparty_rep_profile_id, transfer_of, reason, occurred_at, recorded_at";

// ---- lots -----------------------------------------------------------------

export async function registerLot(
  tx: PoolClient,
  tenantId: string,
  input: {
    erpItemId: string;
    lotNumber: string;
    materialKind: MaterialKind;
    expiryDate?: string | null;
    controlled?: boolean;
  },
): Promise<SampleLot> {
  try {
    const { rows } = await tx.query<SampleLot>(
      `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind, controlled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${LOT_COLUMNS}`,
      [
        tenantId,
        input.erpItemId,
        input.lotNumber,
        input.expiryDate ?? null,
        input.materialKind,
        input.controlled ?? false,
      ],
    );
    return rows[0]!;
  } catch (err) {
    throw translateSampleError(err);
  }
}

export async function getLot(tx: PoolClient, lotId: string): Promise<SampleLot | null> {
  const { rows } = await tx.query<SampleLot>(`SELECT ${LOT_COLUMNS} FROM crm.sample_lot WHERE id = $1`, [lotId]);
  return rows[0] ?? null;
}

export async function listLots(
  tx: PoolClient,
  opts: { erpItemId?: string; status?: LotStatus } = {},
): Promise<readonly SampleLot[]> {
  const { rows } = await tx.query<SampleLot>(
    `SELECT ${LOT_COLUMNS} FROM crm.sample_lot
      WHERE ($1::text IS NULL OR erp_item_id::text = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY expiry_date NULLS LAST, lot_number`,
    [opts.erpItemId ?? null, opts.status ?? null],
  );
  return rows;
}

/**
 * Quarantines or withdraws a lot — the recall path.
 *
 * One row, and every rep holding it is stopped from disbursing at once. The stock
 * stays on their balance deliberately: material under recall still has to be
 * accounted for, and a quantity that vanished when the flag flipped is a quantity
 * nobody has to return.
 */
export async function setLotStatus(
  tx: PoolClient,
  lotId: string,
  status: LotStatus,
  reason: string | null,
): Promise<SampleLot> {
  try {
    const { rows } = await tx.query<SampleLot>(
      `UPDATE crm.sample_lot SET status = $2, status_reason = $3, updated_at = now()
        WHERE id = $1 RETURNING ${LOT_COLUMNS}`,
      [lotId, status, reason],
    );
    if (rows[0] === undefined) throw new SampleLotNotFoundError(lotId);
    return rows[0];
  } catch (err) {
    throw translateSampleError(err);
  }
}

// ---- movements ------------------------------------------------------------

interface MovementBase {
  /** Device-minted, like a visit id. Pass the id the device generated. */
  readonly id: string;
  readonly lotId: string;
  readonly repProfileId: string;
  readonly quantity: string | number;
  readonly occurredAt: Date;
}

async function insertMovement(
  tx: PoolClient,
  tenantId: string,
  row: {
    id: string;
    lotId: string;
    repProfileId: string;
    kind: TransactionKind;
    quantity: string | number;
    occurredAt: Date;
    erpAccountId?: string | null;
    erpContactId?: string | null;
    visitId?: string | null;
    recipientName?: string | null;
    signatureSha256?: string | null;
    erpWarehouseId?: string | null;
    counterpartyRepProfileId?: string | null;
    transferOf?: string | null;
    reason?: string | null;
  },
): Promise<SampleTransaction> {
  try {
    const { rows } = await tx.query<SampleTransaction>(
      `INSERT INTO crm.sample_transaction
         (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_account_id, erp_contact_id,
          visit_id, recipient_name, signature_sha256, erp_warehouse_id,
          counterparty_rep_profile_id, transfer_of, reason, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       -- A redelivered offline movement collapses into the row already there
       -- rather than handing the samples out twice in the record. The device-minted
       -- id is what makes that possible; same guarantee the outbox relies on.
       ON CONFLICT (id) DO NOTHING
       RETURNING ${TX_COLUMNS}`,
      [
        row.id,
        tenantId,
        row.lotId,
        row.repProfileId,
        row.kind,
        String(row.quantity),
        row.erpAccountId ?? null,
        row.erpContactId ?? null,
        row.visitId ?? null,
        row.recipientName ?? null,
        row.signatureSha256 ?? null,
        row.erpWarehouseId ?? null,
        row.counterpartyRepProfileId ?? null,
        row.transferOf ?? null,
        row.reason ?? null,
        row.occurredAt,
      ],
    );
    if (rows[0] !== undefined) return rows[0];
    // The insert was a no-op, so the row already exists: return it. A replayed
    // sync must look like success, not like a conflict.
    const existing = await getTransaction(tx, row.id);
    if (existing === null) throw new Error(`movement ${row.id} neither inserted nor found`);
    return existing;
  } catch (err) {
    throw translateSampleError(err);
  }
}

/**
 * Material enters a rep's custody from ERP-controlled stock.
 *
 * This is the one movement that corresponds to something the ERP needs to know
 * about: stock has physically left the warehouse. The caller enqueues the mirrored
 * `StockMovement` (see `@crm/sample`'s `erpMirrorFor`) in the same transaction.
 */
export function receiveSamples(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & { erpWarehouseId: string },
): Promise<SampleTransaction> {
  return insertMovement(tx, tenantId, { ...input, kind: "receipt", erpWarehouseId: input.erpWarehouseId });
}

/** Material is handed to a prescriber. Needs a recipient and a signature hash. */
export function disburseSamples(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & {
    erpAccountId: string;
    recipientName: string;
    signatureSha256: string;
    erpContactId?: string | null;
    visitId?: string | null;
  },
): Promise<SampleTransaction> {
  return insertMovement(tx, tenantId, { ...input, kind: "disbursement" });
}

/**
 * Sends material to another rep. It leaves the bag and enters in-transit.
 *
 * Notifies the RECEIVING rep in the same transaction, because they have no other reason to
 * expect it: an unaccepted transfer was previously visible only to whoever thought to look
 * at `GET /v1/samples/transfers`, and material nobody accepts sits in transit indefinitely.
 */
export async function transferOut(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & { toRepProfileId: string },
): Promise<SampleTransaction> {
  const movement = await insertMovement(tx, tenantId, {
    ...input,
    kind: "transfer_out",
    counterpartyRepProfileId: input.toRepProfileId,
  });

  const { rows } = await tx.query<{ lot_number: string; display_name: string }>(
    `SELECT l.lot_number, rp.display_name
       FROM crm.sample_lot l, crm.rep_profile rp
      WHERE l.id = $1 AND rp.id = $2`,
    [input.lotId, input.repProfileId],
  );
  const lotNumber = rows[0]?.lot_number ?? input.lotId;
  const sender = rows[0]?.display_name ?? "another rep";

  await raiseNotification(tx, tenantId, {
    recipientRepProfileId: input.toRepProfileId,
    kind: "sample_transfer_awaiting_acceptance",
    severity: "warning",
    subject: `${sender} sent you ${String(input.quantity)} of lot ${lotNumber}`,
    body:
      `${sender} transferred ${String(input.quantity)} unit(s) of lot ${lotNumber} to you. ` +
      `It stays on their balance as in-transit until you accept it.`,
    // Keyed on the transfer, so a replayed offline sync of the same transfer does not
    // notify twice.
    dedupKey: `transfer:${movement.id}:awaiting`,
    subjectTable: "crm.sample_transaction",
    subjectId: movement.id,
    payload: { lotNumber, quantity: String(input.quantity), fromRepProfileId: input.repProfileId },
  });

  return movement;
}

/**
 * Accepts a transfer. The receiving rep gains it and the sender's in-transit clears,
 * in one transaction, so the total across both never changes.
 *
 * Quantity and lot are read from the transfer rather than taken from the caller: an
 * acceptance that disagrees with what was sent is not an acceptance, and the
 * database refuses it anyway — this removes the chance to get it wrong.
 */
export async function acceptTransfer(
  tx: PoolClient,
  tenantId: string,
  input: { id: string; transferOf: string; repProfileId: string; occurredAt: Date },
): Promise<SampleTransaction> {
  const source = await getTransaction(tx, input.transferOf);
  if (source === null) {
    throw translateSampleError(new Error(`transfer_of ${input.transferOf} does not exist`));
  }
  return insertMovement(tx, tenantId, {
    id: input.id,
    lotId: source.lot_id,
    repProfileId: input.repProfileId,
    kind: "transfer_in",
    quantity: source.quantity,
    occurredAt: input.occurredAt,
    counterpartyRepProfileId: source.rep_profile_id,
    transferOf: input.transferOf,
  });
}

/** Material goes back into ERP stock. Mirrored to the ERP as a `receipt`. */
export function returnToWarehouse(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & { erpWarehouseId: string; reason?: string | null },
): Promise<SampleTransaction> {
  return insertMovement(tx, tenantId, { ...input, kind: "return_to_warehouse" });
}

/** Witnessed destruction, or a write-off of expired stock. Both need a reason. */
export function writeOff(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & { kind: "destruction" | "expiry_writeoff"; reason: string },
): Promise<SampleTransaction> {
  return insertMovement(tx, tenantId, input);
}

/** A correction. The ledger is append-only, so this is how a mistake is fixed. */
export function adjust(
  tx: PoolClient,
  tenantId: string,
  input: MovementBase & { direction: "in" | "out"; reason: string },
): Promise<SampleTransaction> {
  return insertMovement(tx, tenantId, {
    ...input,
    kind: input.direction === "in" ? "adjustment_in" : "adjustment_out",
  });
}

// ---- reads ----------------------------------------------------------------

export async function getTransaction(tx: PoolClient, id: string): Promise<SampleTransaction | null> {
  const { rows } = await tx.query<SampleTransaction>(
    `SELECT ${TX_COLUMNS} FROM crm.sample_transaction WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function holdingsFor(
  tx: PoolClient,
  repProfileId: string,
  opts: { includeEmpty?: boolean } = {},
): Promise<readonly SampleHolding[]> {
  const { rows } = await tx.query<SampleHolding>(
    `SELECT h.rep_profile_id, h.lot_id, l.erp_item_id::text AS erp_item_id, l.lot_number,
            l.expiry_date::text AS expiry_date, l.material_kind,
            h.quantity_on_hand::text AS quantity_on_hand,
            h.quantity_in_transit::text AS quantity_in_transit,
            h.last_movement_at, h.last_counted_at
       FROM crm.sample_holding h
       JOIN crm.sample_lot l ON l.id = h.lot_id
      WHERE h.rep_profile_id = $1
        AND ($2::boolean OR h.quantity_on_hand > 0 OR h.quantity_in_transit > 0)
      ORDER BY l.expiry_date NULLS LAST, l.lot_number`,
    [repProfileId, opts.includeEmpty ?? false],
  );
  return rows;
}

export async function ledgerFor(
  tx: PoolClient,
  opts: { repProfileId?: string; lotId?: string; erpAccountId?: string; limit?: number } = {},
): Promise<readonly SampleTransaction[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await tx.query<SampleTransaction>(
    `SELECT ${TX_COLUMNS} FROM crm.sample_transaction
      WHERE ($1::uuid IS NULL OR rep_profile_id = $1 OR counterparty_rep_profile_id = $1)
        AND ($2::uuid IS NULL OR lot_id = $2)
        AND ($3::text IS NULL OR erp_account_id::text = $3)
      ORDER BY occurred_at DESC, recorded_at DESC
      LIMIT ${limit}`,
    [opts.repProfileId ?? null, opts.lotId ?? null, opts.erpAccountId ?? null],
  );
  return rows;
}

/** Transfers this rep sent that nobody has accepted. The "where is my material" query. */
export async function outstandingTransfers(
  tx: PoolClient,
  repProfileId: string,
): Promise<readonly SampleTransaction[]> {
  const { rows } = await tx.query<SampleTransaction>(
    `SELECT ${TX_COLUMNS} FROM crm.sample_transaction t
      WHERE t.kind = 'transfer_out'
        AND (t.rep_profile_id = $1 OR t.counterparty_rep_profile_id = $1)
        AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction a WHERE a.transfer_of = t.id)
      ORDER BY t.occurred_at`,
    [repProfileId],
  );
  return rows;
}

export async function expiringHoldings(
  tx: PoolClient,
  opts: { repProfileId?: string | null; withinDays?: number; asOf?: string } = {},
): Promise<readonly ExpiringHolding[]> {
  const { rows } = await tx.query<ExpiringHolding>(
    `SELECT rep_profile_id, lot_id, erp_item_id, lot_number, expiry_date::text AS expiry_date,
            days_remaining, quantity_on_hand::text AS quantity_on_hand
       FROM crm.expiring_sample_holdings($1, $2, COALESCE($3::date, CURRENT_DATE))`,
    [opts.repProfileId ?? null, opts.withinDays ?? 60, opts.asOf ?? null],
  );
  return rows;
}

// ---- counts ---------------------------------------------------------------

export interface SampleCount {
  readonly id: string;
  readonly rep_profile_id: string;
  readonly counted_by: string;
  readonly status: "open" | "committed" | "cancelled";
  readonly counted_at: Date;
  readonly committed_at: Date | null;
  readonly note: string | null;
}

export async function openCount(
  tx: PoolClient,
  tenantId: string,
  input: { repProfileId: string; countedBy: string; countedAt: Date; note?: string | null },
): Promise<SampleCount> {
  try {
    const { rows } = await tx.query<SampleCount>(
      `INSERT INTO crm.sample_count (tenant_id, rep_profile_id, counted_by, counted_at, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rep_profile_id, counted_by, status, counted_at, committed_at, note`,
      [tenantId, input.repProfileId, input.countedBy, input.countedAt, input.note ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw translateSampleError(err);
  }
}

/**
 * Records a counted quantity, snapshotting the balance as it stands now.
 *
 * `expected_quantity` is captured here rather than at commit time so the variance a
 * reviewer approves is the variance the counter saw. Recomputing it later would
 * silently absorb anything that moved in between — which is exactly the movement
 * worth looking at.
 */
export async function recordCountLine(
  tx: PoolClient,
  tenantId: string,
  input: { countId: string; lotId: string; countedQuantity: string | number },
): Promise<{ readonly lot_id: string; readonly counted_quantity: string; readonly expected_quantity: string }> {
  try {
    const { rows } = await tx.query<{ lot_id: string; counted_quantity: string; expected_quantity: string }>(
      `INSERT INTO crm.sample_count_line (tenant_id, count_id, lot_id, counted_quantity, expected_quantity)
       SELECT $1, $2, $3, $4,
              COALESCE((SELECT h.quantity_on_hand FROM crm.sample_holding h
                         JOIN crm.sample_count c ON c.id = $2
                        WHERE h.rep_profile_id = c.rep_profile_id AND h.lot_id = $3), 0)
       ON CONFLICT (count_id, lot_id) DO UPDATE SET counted_quantity = EXCLUDED.counted_quantity
       RETURNING lot_id, counted_quantity::text AS counted_quantity, expected_quantity::text AS expected_quantity`,
      [tenantId, input.countId, input.lotId, String(input.countedQuantity)],
    );
    return rows[0]!;
  } catch (err) {
    throw translateSampleError(err);
  }
}

/**
 * Commits a count: one adjustment per discrepancy, written through the ledger.
 *
 * Returns how many adjustments it wrote. The balance afterwards still equals the sum
 * of its movements, which is the property that makes the count auditable rather than
 * a quiet correction.
 */
export async function commitCount(tx: PoolClient, countId: string): Promise<number> {
  try {
    const { rows } = await tx.query<{ written: number }>(`SELECT crm.commit_sample_count($1) AS written`, [countId]);
    return rows[0]!.written;
  } catch (err) {
    throw translateSampleError(err);
  }
}

export async function cancelCount(tx: PoolClient, countId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE crm.sample_count SET status = 'cancelled' WHERE id = $1 AND status = 'open'`,
    [countId],
  );
  if ((rowCount ?? 0) === 0) throw new SampleCountError(`sample count ${countId} is not open`);
}

export async function getCount(tx: PoolClient, countId: string): Promise<SampleCount | null> {
  const { rows } = await tx.query<SampleCount>(
    `SELECT id, rep_profile_id, counted_by, status, counted_at, committed_at, note
       FROM crm.sample_count WHERE id = $1`,
    [countId],
  );
  return rows[0] ?? null;
}

export interface TeamExpiringHolding extends ExpiringHolding {
  readonly display_name: string;
}

export interface TeamExposure {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly lots_held: number;
  readonly units_on_hand: string;
  readonly units_in_transit: string;
  readonly earliest_expiry: string | null;
  readonly expired_lots: number;
  /** Null means never counted — a stronger finding than an old date. */
  readonly last_counted_at: Date | null;
}

/** Expiring stock across a manager's team. Scoped in SQL by `crm.managed_rep_ids`. */
export async function teamExpiringHoldings(
  tx: PoolClient,
  managerRepProfileId: string,
  opts: { withinDays?: number; asOf?: string } = {},
): Promise<readonly TeamExpiringHolding[]> {
  const { rows } = await tx.query<TeamExpiringHolding>(
    `SELECT rep_profile_id, display_name, lot_id, erp_item_id, lot_number,
            expiry_date::text AS expiry_date, days_remaining,
            quantity_on_hand::text AS quantity_on_hand
       FROM crm.team_expiring_holdings($1, $2, COALESCE($3::date, CURRENT_DATE))`,
    [managerRepProfileId, opts.withinDays ?? 60, opts.asOf ?? null],
  );
  return rows;
}

/**
 * Custody exposure per rep: what they hold, what is expired, and when their bag was
 * last counted.
 *
 * Ordered by `last_counted_at` with nulls first, so whoever has never been counted is
 * at the top rather than sorted as though they were counted long ago.
 */
export async function teamExposure(
  tx: PoolClient,
  managerRepProfileId: string,
  opts: { asOf?: string } = {},
): Promise<readonly TeamExposure[]> {
  const { rows } = await tx.query<TeamExposure>(
    `SELECT rep_profile_id, display_name, lots_held,
            units_on_hand::text AS units_on_hand,
            units_in_transit::text AS units_in_transit,
            earliest_expiry::text AS earliest_expiry,
            expired_lots, last_counted_at
       FROM crm.team_sample_exposure($1, COALESCE($2::date, CURRENT_DATE))`,
    [managerRepProfileId, opts.asOf ?? null],
  );
  return rows;
}

export interface SampleCountLine {
  readonly lot_id: string;
  readonly lot_number: string;
  readonly counted_quantity: string;
  readonly expected_quantity: string;
  readonly variance: string;
}

/** A count's lines with the variance a reviewer approves, computed once in SQL. */
export async function countLines(tx: PoolClient, countId: string): Promise<readonly SampleCountLine[]> {
  const { rows } = await tx.query<SampleCountLine>(
    `SELECT cl.lot_id, l.lot_number,
            cl.counted_quantity::text AS counted_quantity,
            cl.expected_quantity::text AS expected_quantity,
            (cl.counted_quantity - cl.expected_quantity)::text AS variance
       FROM crm.sample_count_line cl
       JOIN crm.sample_lot l ON l.id = cl.lot_id
      WHERE cl.count_id = $1
      ORDER BY l.lot_number`,
    [countId],
  );
  return rows;
}

export async function listCounts(
  tx: PoolClient,
  opts: { repProfileId?: string; status?: "open" | "committed" | "cancelled" } = {},
): Promise<readonly SampleCount[]> {
  const { rows } = await tx.query<SampleCount>(
    `SELECT id, rep_profile_id, counted_by, status, counted_at, committed_at, note
       FROM crm.sample_count
      WHERE ($1::uuid IS NULL OR rep_profile_id = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY counted_at DESC`,
    [opts.repProfileId ?? null, opts.status ?? null],
  );
  return rows;
}

export interface DisposalObligation {
  readonly id: string;
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly lot_id: string;
  readonly erp_item_id: string;
  readonly lot_number: string;
  readonly material_kind: MaterialKind;
  readonly expired_on: string;
  readonly discovered_on: string;
  readonly due_by: string;
  /** Positive once past the deadline, negative while there is still time. */
  readonly days_overdue: number;
  readonly status: "open" | "overdue";
  readonly quantity_on_hand: string;
}

/** One rep's outstanding disposals, soonest deadline first. */
export async function openObligations(
  tx: PoolClient,
  repProfileId: string,
  opts: { asOf?: string } = {},
): Promise<readonly DisposalObligation[]> {
  const { rows } = await tx.query<DisposalObligation>(
    `SELECT id, rep_profile_id, display_name, lot_id, erp_item_id, lot_number, material_kind,
            expired_on::text AS expired_on, discovered_on::text AS discovered_on,
            due_by::text AS due_by, days_overdue, status,
            quantity_on_hand::text AS quantity_on_hand
       FROM crm.open_disposal_obligations($1, COALESCE($2::date, CURRENT_DATE))`,
    [repProfileId, opts.asOf ?? null],
  );
  return rows;
}

/**
 * Outstanding disposals across a manager's team.
 *
 * Scoped by `crm.managed_rep_ids` inside the query, like every other team read — not by
 * filtering a rep id afterwards.
 */
export async function teamObligations(
  tx: PoolClient,
  managerRepProfileId: string,
  opts: { asOf?: string } = {},
): Promise<readonly DisposalObligation[]> {
  const { rows } = await tx.query<DisposalObligation>(
    `SELECT o.id, o.rep_profile_id, o.display_name, o.lot_id, o.erp_item_id, o.lot_number,
            o.material_kind, o.expired_on::text AS expired_on,
            o.discovered_on::text AS discovered_on, o.due_by::text AS due_by,
            o.days_overdue, o.status, o.quantity_on_hand::text AS quantity_on_hand
       FROM crm.open_disposal_obligations(NULL, COALESCE($2::date, CURRENT_DATE)) o
      WHERE o.rep_profile_id IN (
              SELECT rep_profile_id FROM crm.managed_rep_ids($1, COALESCE($2::date, CURRENT_DATE))
            )
      ORDER BY o.due_by, o.display_name`,
    [managerRepProfileId, opts.asOf ?? null],
  );
  return rows;
}
