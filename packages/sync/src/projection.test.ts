import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PROJECTION,
  PRODUCT_PROJECTION,
  projectionFor,
  PROJECTIONS,
  REP_PROJECTION,
  WAREHOUSE_PROJECTION,
} from "./projection.js";
import { CoercionError } from "./coerce.js";

describe("product projection", () => {
  it("keeps money as an exact string", () => {
    const row = PRODUCT_PROJECTION.project({
      id: "rec_1",
      sku: "A-1",
      name: "Widget",
      list_price: "1234567890.12",
      standard_cost: "0.0001",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    expect(row["list_price"]).toBe("1234567890.12");
    expect(row["standard_cost"]).toBe("0.0001");
  });

  it("rejects the record rather than nulling a bad price", () => {
    // Nulling would make the product look free, in a typed column that then
    // reads as authoritative.
    expect(() =>
      PRODUCT_PROJECTION.project({ id: "rec_1", sku: "A", name: "W", list_price: "$10" }),
    ).toThrow(CoercionError);
  });

  it("requires the fields the snapshot's NOT NULL columns demand", () => {
    expect(() => PRODUCT_PROJECTION.project({ id: "rec_1", name: "W" })).toThrow(/sku/);
    expect(() => PRODUCT_PROJECTION.project({ sku: "A", name: "W" })).toThrow(/id/);
  });

  it("emits exactly the declared columns, so the INSERT cannot drift from the table", () => {
    const row = PRODUCT_PROJECTION.project({ id: "r", sku: "A", name: "W" });
    expect(Object.keys(row).sort()).toEqual([...PRODUCT_PROJECTION.columns].sort());
  });
});

describe("rep projection", () => {
  it("copies only what the CRM needs", () => {
    const row = REP_PROJECTION.project({
      id: "rec_e1",
      employee_number: "E-1",
      given_name: "A",
      family_name: "B",
      work_email: "a@b.test",
      national_id: "SHOULD-NOT-APPEAR",
      date_of_birth: "1990-01-01",
      annual_salary: "100000.00",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    // The ERP classifies national_id and date_of_birth as pii and annual_salary
    // as commercial_sensitive. The CRM has no use for any of them, and a field
    // never copied cannot leak.
    expect(row).not.toHaveProperty("national_id");
    expect(row).not.toHaveProperty("date_of_birth");
    expect(row).not.toHaveProperty("annual_salary");
    expect(Object.values(row)).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("validates reference ids against the domain's shape", () => {
    expect(() =>
      REP_PROJECTION.project({ id: "rec_e1", employee_number: "E-1", manager_id: "bad id!" }),
    ).toThrow(/erp_record_id/);
  });

  it("refuses a hire_date that is really a datetime", () => {
    expect(() =>
      REP_PROJECTION.project({ id: "r", employee_number: "E", hire_date: "2026-01-01T00:00:00Z" }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("account projection", () => {
  it("normalises the country code for CHAR(2)", () => {
    const row = ACCOUNT_PROJECTION.project({ id: "rec_a", name: "Acme", country: "ae" });
    expect(row["country"]).toBe("AE");
  });
});

describe("warehouse projection", () => {
  it("carries the code and the name, because a rep picks a depot by its code", () => {
    const row = WAREHOUSE_PROJECTION.project({
      id: "wh_1",
      code: "DEPOT-N",
      name: "Northern Distribution",
      warehouse_type: "distribution",
      address_line1: "1 Dock Road",
      city: "Dubai",
      country: "ae",
      status: "active",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    expect(row["erp_warehouse_id"]).toBe("wh_1");
    expect(row["code"]).toBe("DEPOT-N");
    expect(row["name"]).toBe("Northern Distribution");
    expect(row["country"]).toBe("AE");
    expect(row["status"]).toBe("active");
  });

  it("rejects a record with no code rather than listing a nameless destination", () => {
    // The picker shows the code. A blank one is an option a rep cannot tell apart from
    // any other blank one, on a screen that dispatches physical stock.
    expect(() => WAREHOUSE_PROJECTION.project({ id: "wh_1", name: "N" })).toThrow(/code/);
    expect(() => WAREHOUSE_PROJECTION.project({ id: "wh_1", code: "D" })).toThrow(/name/);
  });

  it("keeps the ERP's status verbatim, including one it has not published before", () => {
    // Not an enum here on purpose: the writer's rule is "is it active", so an unexpected
    // status must read as "not active" rather than crash the mirror.
    const row = WAREHOUSE_PROJECTION.project({ id: "wh_2", code: "D", name: "N", status: "mothballed" });
    expect(row["status"]).toBe("mothballed");
  });

  it("copies no more of the address than tells two depots apart", () => {
    const row = WAREHOUSE_PROJECTION.project({
      id: "wh_3",
      code: "D",
      name: "N",
      address_line2: "SHOULD-NOT-APPEAR",
      postal_code: "SHOULD-NOT-APPEAR",
    });
    expect(Object.values(row)).not.toContain("SHOULD-NOT-APPEAR");
    expect(Object.keys(row).sort()).toEqual([...WAREHOUSE_PROJECTION.columns].sort());
  });
});

describe("the projection registry", () => {
  it("covers each snapshot exactly once, with a distinct table and entity", () => {
    expect(PROJECTIONS).toHaveLength(4);
    expect(new Set(PROJECTIONS.map((p) => p.table)).size).toBe(4);
    expect(new Set(PROJECTIONS.map((p) => p.entity)).size).toBe(4);
    expect(new Set(PROJECTIONS.map((p) => p.name)).size).toBe(4);
  });

  it("declares its id column among its columns", () => {
    for (const p of PROJECTIONS) expect(p.columns).toContain(p.idColumn);
  });

  it("is what `refreshAll` iterates, so a declared snapshot cannot go unrefreshed", () => {
    // The scheduler's only all-snapshots job used to enumerate the names a second time,
    // which meant a fourth snapshot could be declared, migrated and tested and still never
    // be refreshed. Asserting the source of that list here keeps the two from parting.
    expect(PROJECTIONS.map((p) => p.name)).toEqual(["product", "rep", "account", "warehouse"]);
  });

  it("looks up by name and refuses an unknown one", () => {
    expect(projectionFor("rep")).toBe(REP_PROJECTION);
    // @ts-expect-error — the guard exists for callers without types.
    expect(() => projectionFor("nope")).toThrow(/unknown snapshot/);
  });
});
