import { describe, expect, it } from "vitest";

import {
  Account,
  Me,
  Problem,
  ReturnBody,
  SYNC_BATCH_MAX,
  SyncResponse,
  VisitBody,
  Warehouse,
  WarehouseList,
  problemKind,
} from "./api.js";

/**
 * The client's copy of the wire contract, held to the server's own rules.
 *
 * These are not schema tests for their own sake: every case below is one the server would
 * refuse, and a client that accepts it has only moved the failure to the far side of a
 * queue — where it surfaces as a batch of `validation_failed` rows a rep cannot act on,
 * hours after the visit. Refusing at the keyboard is the whole point of carrying the
 * schema here. `scripts/verify-client-live.sh` is what proves the copy still matches.
 */
describe("VisitBody", () => {
  const good = { id: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e", erpAccountId: "ACC-1" };

  it("accepts the minimum the server needs: a device-minted id and an account", () => {
    expect(VisitBody.safeParse(good).success).toBe(true);
  });

  it("requires the id, because the server has no default for it", () => {
    expect(VisitBody.safeParse({ erpAccountId: "ACC-1" }).success).toBe(false);
  });

  it("rejects an ERP id the database's domain constraint would refuse", () => {
    // `crm.erp_record_id` is CHECK (VALUE ~ '^[A-Za-z0-9_-]{1,200}$'). A space, a slash
    // or an empty string fails in Postgres; failing here instead costs nothing.
    for (const bad of ["", "ACC 1", "ACC/1", "a".repeat(201), "Ωmega"]) {
      expect(VisitBody.safeParse({ ...good, erpAccountId: bad }).success, bad).toBe(false);
    }
    expect(VisitBody.safeParse({ ...good, erpAccountId: "a".repeat(200) }).success).toBe(true);
  });

  it("rejects a status or type outside the server's enums", () => {
    expect(VisitBody.safeParse({ ...good, status: "done" }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, visitType: "coffee" }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, status: "completed", visitType: "detailing" }).success).toBe(true);
  });

  it("holds the server's bounds on duration, coordinates and notes", () => {
    expect(VisitBody.safeParse({ ...good, durationMinutes: 1441 }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, durationMinutes: -1 }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, durationMinutes: 30.5 }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, checkin: { latitude: 91, longitude: 0 } }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, checkin: { latitude: 0, longitude: 181 } }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, notes: "x".repeat(10_001) }).success).toBe(false);
  });

  it("requires an offset on occurredAt, so a device in another timezone cannot shift a visit", () => {
    expect(VisitBody.safeParse({ ...good, occurredAt: "2026-10-08T09:00:00" }).success).toBe(false);
    expect(VisitBody.safeParse({ ...good, occurredAt: "2026-10-08T09:00:00Z" }).success).toBe(true);
    expect(VisitBody.safeParse({ ...good, occurredAt: "2026-10-08T09:00:00+03:00" }).success).toBe(true);
  });

  it("caps products at the server's 50", () => {
    const products = (n: number): { erpItemId: string }[] => Array.from({ length: n }, (_, i) => ({ erpItemId: `SKU-${i}` }));
    expect(VisitBody.safeParse({ ...good, products: products(50) }).success).toBe(true);
    expect(VisitBody.safeParse({ ...good, products: products(51) }).success).toBe(false);
  });

  it("knows the batch cap the server enforces", () => {
    expect(SYNC_BATCH_MAX).toBe(200);
  });
});

describe("responses", () => {
  it("accepts an account with every label null, because the join is a LEFT JOIN", () => {
    // An account assigned before the snapshot caught up arrives unlabelled. A client that
    // required a name would make it vanish — the opposite of what the server intends.
    expect(
      Account.safeParse({ erp_account_id: "ACC-1", name: null, status: null, country: null, synced_from: null })
        .success,
    ).toBe(true);
  });

  it("accepts a rep with no ERP employee id, which is the unmapped case", () => {
    expect(
      Me.safeParse({ repProfileId: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e", displayName: "R", erpEmployeeId: null, territories: [], accountCount: 0 }).success,
    ).toBe(true);
  });

  it("parses a mixed sync response", () => {
    const parsed = SyncResponse.safeParse({
      accepted: 1,
      rejected: 1,
      results: [
        { id: "a", ok: true },
        { id: "b", ok: false, type: "outside_territory", error: "nope" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a reply missing the per-row results, which is the shape a portal returns", () => {
    expect(SyncResponse.safeParse({ accepted: 0, rejected: 0 }).success).toBe(false);
    expect(SyncResponse.safeParse("<html>captive portal</html>").success).toBe(false);
  });

  it("accepts a depot with only the fields a picker needs", () => {
    // `name` and `code` are NOT NULL at the ERP and in the snapshot; the rest is optional
    // because a depot with no city is a depot, and refusing it would empty a rep's list of
    // destinations over a blank column.
    expect(
      Warehouse.safeParse({ erp_warehouse_id: "wh-1", code: "DEPOT-1", name: "Central" }).success,
    ).toBe(true);
    expect(
      Warehouse.safeParse({ erp_warehouse_id: "wh-1", code: "DEPOT-1", name: "Central", city: null, status: null })
        .success,
    ).toBe(true);
  });

  it("refuses a depot whose id could not be an ERP record id", () => {
    // The movement is posted against this id. A value the server's own domain would refuse
    // must not reach a queue that drains hours later.
    expect(Warehouse.safeParse({ erp_warehouse_id: "wh 1!", code: "D", name: "N" }).success).toBe(false);
    expect(WarehouseList.safeParse({ data: [] }).success).toBe(true);
    expect(WarehouseList.safeParse({ data: [{ code: "D", name: "N" }] }).success).toBe(false);
  });

  it("still requires a return to name a depot, so a blank pick cannot be queued", () => {
    const base = {
      id: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e",
      lotId: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1f",
      quantity: "3.000",
      occurredAt: "2026-10-15T09:00:00.000Z",
    };
    expect(ReturnBody.safeParse({ ...base, erpWarehouseId: "wh-1" }).success).toBe(true);
    expect(ReturnBody.safeParse({ ...base, erpWarehouseId: "" }).success).toBe(false);
    expect(ReturnBody.safeParse(base).success).toBe(false);
  });

  it("parses an RFC 9457 problem with and without a detail", () => {
    expect(Problem.safeParse({ type: "x", title: "t", status: 400 }).success).toBe(true);
    expect(Problem.safeParse({ type: "x", title: "t", status: 400, detail: "d" }).success).toBe(true);
    expect(Problem.safeParse({ error: "nope" }).success).toBe(false);
  });
});

describe("problemKind", () => {
  it("reads the kind out of the API's type URL", () => {
    expect(problemKind("https://crm.pharma/errors/tenant-deleted")).toBe("tenant_deleted");
    expect(problemKind("https://crm.pharma/errors/validation-failed")).toBe("validation_failed");
  });

  it("passes through the bare kind a sync row carries", () => {
    // The two sources differ: a problem document sends the URL, a sync row sends
    // `problem.kind` directly. Both have to reach the classifier as the same string.
    expect(problemKind("tenant_deleted")).toBe("tenant_deleted");
  });

  it("returns the tail of a type it does not recognise rather than nothing", () => {
    expect(problemKind("https://example.com/errors/weird-thing")).toBe("https://example.com/errors/weird_thing");
    expect(problemKind("brand-new-kind")).toBe("brand_new_kind");
  });
});
