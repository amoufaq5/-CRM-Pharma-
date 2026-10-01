import { describe, expect, it } from "vitest";

import { erpMirrorFor, mirrorRecordId } from "./erp-mirror.js";
import type { SampleLot, SampleTransaction, TransactionKind } from "./store.js";

/**
 * The mapping from CRM custody to ERP inventory.
 *
 * Pure, so it is asserted here without a database — and the mapping is the part worth
 * asserting, because getting the direction backwards would overstate or understate the
 * ERP's warehouse balance forever and nothing downstream would notice.
 */

const LOT: SampleLot = {
  id: "11111111-1111-4111-8111-111111111111",
  erp_item_id: "ITEM-7",
  lot_number: "LOT-X",
  expiry_date: "2027-03-31",
  material_kind: "drug_sample",
  controlled: false,
  status: "active",
  status_reason: null,
};

function tx(kind: TransactionKind, overrides: Partial<SampleTransaction> = {}): SampleTransaction {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    lot_id: LOT.id,
    rep_profile_id: "33333333-3333-4333-8333-333333333333",
    kind,
    quantity: "25.000",
    erp_account_id: null,
    erp_contact_id: null,
    visit_id: null,
    recipient_name: null,
    signature_sha256: null,
    erp_warehouse_id: "WH-1",
    counterparty_rep_profile_id: null,
    transfer_of: null,
    reason: null,
    occurred_at: new Date("2026-10-05T09:00:00.000Z"),
    recorded_at: new Date("2026-10-05T11:00:00.000Z"),
    ...overrides,
  };
}

describe("erpMirrorFor", () => {
  /**
   * The inversion, pinned. The CRM's `receipt` — material arriving in a rep's bag — is
   * the ERP's `issue`, because it has just left the warehouse. They are the same event
   * seen from opposite sides of one door, and writing it backwards once would be
   * permanent.
   */
  it("maps a CRM receipt to an ERP issue", () => {
    const mirror = erpMirrorFor(tx("receipt"), LOT)!;
    expect(mirror.payload["movement_type"]).toBe("issue");
    expect(mirror.entity).toBe("StockMovement");
    expect(mirror.operation).toBe("create");
  });

  it("maps a return to the warehouse to an ERP receipt", () => {
    expect(erpMirrorFor(tx("return_to_warehouse"), LOT)!.payload["movement_type"]).toBe("receipt");
  });

  /**
   * Seven of the nine kinds happen entirely inside the rep's custody, after the
   * material already left ERP stock. Mirroring any of them would double-count the
   * warehouse.
   */
  it("mirrors nothing for a movement that stays inside custody", () => {
    for (const kind of [
      "disbursement",
      "transfer_out",
      "transfer_in",
      "destruction",
      "expiry_writeoff",
      "adjustment_in",
      "adjustment_out",
    ] as const) {
      expect(erpMirrorFor(tx(kind), LOT), `${kind} must not mirror`).toBeNull();
    }
  });

  it("carries the item, warehouse, quantity and time the ERP needs", () => {
    const mirror = erpMirrorFor(tx("receipt"), LOT)!;
    expect(mirror.payload["item_id"]).toBe("ITEM-7");
    expect(mirror.payload["warehouse_id"]).toBe("WH-1");
    expect(mirror.payload["quantity"]).toBe("25.000");
    expect(mirror.payload["occurred_at"]).toBe("2026-10-05T09:00:00.000Z");
    expect(mirror.payload["reference"]).toBe(tx("receipt").id);
  });

  /**
   * The quantity stays a string all the way through. `StockMovement.quantity` is a
   * decimal(16,3) at the far end too, and a float64 round trip is how a quantity
   * arrives as 24.999999999999996.
   */
  it("keeps the quantity as a string", () => {
    expect(typeof erpMirrorFor(tx("receipt", { quantity: "0.001" }), LOT)!.payload["quantity"]).toBe("string");
  });

  /**
   * The lot and expiry have nowhere structured to go — StockMovement has item_id,
   * warehouse_id, movement_type, quantity, reference, reason and occurred_at, and that
   * is all. Putting them in `reason` leaves a readable trace without pretending the
   * ERP can answer a lot-level question.
   */
  it("writes the lot and expiry into reason, the only field that can hold them", () => {
    const reason = erpMirrorFor(tx("receipt"), LOT)!.payload["reason"] as string;
    expect(reason).toContain("LOT-X");
    expect(reason).toContain("2027-03-31");
    expect(reason).toContain("drug_sample");
  });

  it("truncates reason to the 200 characters the ERP field accepts", () => {
    const longLot: SampleLot = { ...LOT, lot_number: "L".repeat(300) };
    const reason = erpMirrorFor(tx("receipt"), longLot)!.payload["reason"] as string;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("omits the expiry from reason for material that has none", () => {
    const promo: SampleLot = { ...LOT, material_kind: "promo_material", expiry_date: null };
    expect(erpMirrorFor(tx("receipt"), promo)!.payload["reason"]).not.toContain("exp");
  });

  /** A movement with no warehouse has nothing to post against; refusing beats guessing. */
  it("mirrors nothing when the warehouse is missing", () => {
    expect(erpMirrorFor(tx("receipt", { erp_warehouse_id: null }), LOT)).toBeNull();
  });
});

describe("mirrorRecordId", () => {
  /**
   * Deterministic from the CRM transaction's id, so a redelivery addresses the SAME ERP
   * record and collapses into a unique violation on (tenant_id, entity, record_id) —
   * the durable guarantee, not the gateway's in-memory idempotency store.
   */
  it("is derived from the transaction id and stable", () => {
    expect(mirrorRecordId("abc")).toBe("crm-sm-abc");
    expect(mirrorRecordId("abc")).toBe(mirrorRecordId("abc"));
    expect(mirrorRecordId("abd")).not.toBe(mirrorRecordId("abc"));
  });

  it("matches the id pattern the ERP accepts", () => {
    // resolveRecordId accepts ^[A-Za-z0-9_-]{1,200}$; a uuid plus the prefix fits.
    const id = mirrorRecordId("2b1f1c22-5e2a-4a5f-9f4a-0c1d2e3f4a5b");
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
  });
});
