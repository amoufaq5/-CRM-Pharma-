import type { PoolClient } from "pg";
import { enqueueOutbox } from "@crm/relay";

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
 * Enqueues the mirror in the same transaction that recorded the movement.
 *
 * One transaction is the whole reason the outbox exists: a movement that committed
 * without its mirror would leave the ERP's warehouse balance permanently overstated,
 * and a mirror that committed without its movement would understate it. Returns
 * false when there was nothing to mirror or the row was already enqueued.
 */
export async function enqueueErpMirror(
  tx: PoolClient,
  tenantId: string,
  transaction: SampleTransaction,
  lot: SampleLot,
): Promise<boolean> {
  const mirror = erpMirrorFor(transaction, lot);
  if (mirror === null) return false;
  const { enqueued } = await enqueueOutbox(tx, tenantId, {
    entity: mirror.entity,
    operation: mirror.operation,
    payload: { ...mirror.payload },
    targetRecordId: mirror.targetRecordId,
    sourceTable: "crm.sample_transaction",
    sourceId: transaction.id,
  });
  return enqueued;
}
