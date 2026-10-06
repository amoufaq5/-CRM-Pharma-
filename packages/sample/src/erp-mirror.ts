import type { PoolClient } from "pg";
import { enqueueOutbox,
  type OutboxState,
} from "@crm/relay";

import type { SampleLot, SampleTransaction } from "./store.js";

/**
 * Mirroring sample movements into the ERP's inventory.
 *
 * ADR-0001 Q4: the CRM owns custody, and only the AGGREGATE movement is mirrored —
 * when material physically crosses the boundary of ERP-controlled stock. Two
 * movements do that and seven do not:
 *
 *   receipt             → stock LEAVES the warehouse  → ERP StockMovement `issue`
 *   return_to_warehouse → stock RE-ENTERS it          → ERP StockMovement `receipt`
 *
 * Everything else — disbursement, transfer between reps, destruction, expiry
 * write-off, adjustment — happens entirely inside the rep's custody, after the
 * material already left ERP stock. Mirroring those would double-count.
 *
 * NOTE THE INVERSION, because it is exactly the kind of thing that gets written
 * backwards once and then disagrees forever: the CRM's `receipt` is the ERP's
 * `issue`. They are the same event seen from opposite sides of the warehouse door.
 */

/** The CRM kinds that cross the ERP stock boundary, and what the ERP calls them. */
const ERP_MOVEMENT_TYPE: Readonly<Record<string, "issue" | "receipt">> = {
  receipt: "issue",
  return_to_warehouse: "receipt",
};

export interface ErpStockMirror {
  readonly entity: "StockMovement";
  readonly operation: "create";
  readonly targetRecordId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The deterministic ERP record id for a mirrored movement.
 *
 * Derived from the CRM transaction's own id, so a redelivery addresses the same ERP
 * record and collapses into a unique violation on `(tenant_id, entity, record_id)` —
 * the durable guarantee, not the gateway's in-memory idempotency store (report R6).
 */
export function mirrorRecordId(transactionId: string): string {
  return `crm-sm-${transactionId}`;
}

/**
 * Builds the mirror for a movement, or null when the movement does not cross the
 * boundary.
 *
 * Pure, so the mapping can be asserted without a database — and the mapping is the
 * part worth asserting.
 */
export function erpMirrorFor(transaction: SampleTransaction, lot: SampleLot): ErpStockMirror | null {
  const movementType = ERP_MOVEMENT_TYPE[transaction.kind];
  if (movementType === undefined) return null;
  if (transaction.erp_warehouse_id === null) return null;

  return {
    entity: "StockMovement",
    operation: "create",
    targetRecordId: mirrorRecordId(transaction.id),
    payload: {
      item_id: lot.erp_item_id,
      warehouse_id: transaction.erp_warehouse_id,
      movement_type: movementType,
      quantity: transaction.quantity,
      occurred_at: transaction.occurred_at.toISOString(),
      reference: transaction.id,
      // The lot and expiry have nowhere structured to go: StockMovement has
      // item_id, warehouse_id, movement_type, quantity, reference, reason and
      // occurred_at, and that is all (report R3). Putting them in `reason` leaves a
      // human-readable trace in the ERP's audit without pretending the ERP can
      // answer a lot-level question — the CRM remains the system of record for that,
      // which is the whole point of ADR-0001 Q4.
      reason: truncate(
        `CRM sample ${transaction.kind}: lot ${lot.lot_number}` +
          (lot.expiry_date !== null ? ` exp ${lot.expiry_date}` : "") +
          ` (${lot.material_kind})`,
        200,
      ),
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The four states `crm.outbox.state` admits.
 *
 * An alias for `@crm/relay`'s own `OutboxState` rather than a second hand-written copy of
 * the four values, which is a list that can fall behind the CHECK constraint without
 * anything failing. It used to be spelled `Awaited<ReturnType<typeof enqueueOutbox>>["state"]`
 * because the relay's barrel did not export the type; it does now.
 */
export type ErpMirrorOutboxState = OutboxState;

/**
 * What enqueuing a mirror did, in enough detail to answer the rep honestly.
 *
 * `enqueued` is the old boolean and means exactly what it used to: THIS call wrote the
 * row. Everything else is what `enqueueOutbox`'s state made askable.
 */
export interface ErpMirrorResult {
  /**
   * False when there was nothing to mirror: seven of the nine movement kinds never cross
   * the ERP stock boundary, and a receipt or return carrying no `erp_warehouse_id` has no
   * warehouse to name. `erpMirrorFor` is the one that decides.
   */
  readonly applicable: boolean;
  /** True only when this call wrote the outbox row. */
  readonly enqueued: boolean;
  /** Null when there was nothing to mirror. */
  readonly outboxId: string | null;
  /** The state of the row this movement's mirror is, or collapsed onto. */
  readonly state: ErpMirrorOutboxState | null;
  /**
   * The ERP will never hear about this movement without a person.
   *
   * The one outcome a caller must not read as a harmless duplicate. See
   * `enqueueErpMirror`.
   */
  readonly deadLettered: boolean;
  /** Why the ERP refused it, when it did. */
  readonly deadReason: string | null;
}

const NOT_APPLICABLE: ErpMirrorResult = {
  applicable: false,
  enqueued: false,
  outboxId: null,
  state: null,
  deadLettered: false,
  deadReason: null,
};

/**
 * Enqueues the mirror in the same transaction that recorded the movement.
 *
 * One transaction is the whole reason the outbox exists: a movement that committed
 * without its mirror would leave the ERP's warehouse balance permanently overstated,
 * and a mirror that committed without its movement would understate it.
 *
 * WHY THIS NO LONGER RETURNS A BARE BOOLEAN. A movement id is device-minted, and
 * `insertMovement` collapses a redelivered offline movement onto the row already there —
 * so a replayed receipt reaches here a second time and `enqueueOutbox` collapses onto the
 * outbox row already there too. That is the designed path and `enqueued: false` is the
 * honest answer for it, while the queued write is still alive. It is NOT the honest answer
 * when that row is `dead`: the relay stopped retrying it, the warehouse balance at the ERP
 * is overstated and will stay overstated, and the rep has now recorded the same hand-over
 * twice and been told `201 Created` twice. `deadLettered` is that case, and it is the only
 * new thing a caller has to do anything about.
 *
 * NOTHING IS NOTIFIED FROM HERE, deliberately. `raiseDeadLetterAlarm` already told the rep
 * (urgently — they believe that write landed) and their supervisors the moment the row
 * died, keyed on `revive_count` so a second death is news and a second mention of the same
 * death is not. Raising another signal for the same dead row on every replay is precisely
 * the noise that key exists to prevent. The way back is unchanged:
 * `GET /v1/erp-writes/failed` then `POST /v1/erp-writes/{id}/retry`.
 */
export async function enqueueErpMirror(
  tx: PoolClient,
  tenantId: string,
  transaction: SampleTransaction,
  lot: SampleLot,
): Promise<ErpMirrorResult> {
  const mirror = erpMirrorFor(transaction, lot);
  if (mirror === null) return NOT_APPLICABLE;

  const { enqueued, id, state } = await enqueueOutbox(tx, tenantId, {
    entity: mirror.entity,
    operation: mirror.operation,
    payload: { ...mirror.payload },
    targetRecordId: mirror.targetRecordId,
    sourceTable: "crm.sample_transaction",
    sourceId: transaction.id,
  });

  if (state !== "dead") {
    return {
      applicable: true,
      enqueued,
      outboxId: id,
      state,
      deadLettered: false,
      deadReason: null,
    };
  }

  // Only on the dead path, where one more round trip is free and the reason is the thing
  // somebody acts on.
  const { rows } = await tx.query<{ dead_reason: string | null }>(
    `SELECT dead_reason FROM crm.outbox WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return {
    applicable: true,
    enqueued,
    outboxId: id,
    state,
    deadLettered: true,
    deadReason: rows[0]?.dead_reason ?? null,
  };
}
