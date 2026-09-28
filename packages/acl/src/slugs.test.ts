import { describe, expect, it } from "vitest";
import { entityCamel, operationId, resourceSlug } from "./slugs.js";

describe("resourceSlug", () => {
  it.each([
    ["Item", "items"],
    ["Account", "accounts"],
    ["SalesOrder", "sales-orders"],
    ["InvoiceLine", "invoice-lines"],
    ["LedgerAccount", "ledger-accounts"],
    ["StockMovement", "stock-movements"],
  ])("%s -> /v1/%s", (entity, slug) => {
    expect(resourceSlug(entity)).toBe(slug);
  });

  // These are the ERP's mistakes, reproduced deliberately. If one of these ever
  // fails it means the ERP changed its pluraliser and every hand-written path in
  // this repo is now wrong — which is exactly what we want the build to tell us.
  it.each([
    ["Opportunity", "opportunitys"],
    ["Currency", "currencys"],
    ["BillOfMaterials", "bill-of-materialss"],
  ])("reproduces the naive pluraliser: %s -> /v1/%s", (entity, slug) => {
    expect(resourceSlug(entity)).toBe(slug);
  });
});

describe("operationId", () => {
  it("builds gateway operation ids", () => {
    expect(operationId("SalesOrder", "list")).toBe("salesOrder.list");
    expect(operationId("Invoice", "mark_paid")).toBe("invoice.mark_paid");
    expect(entityCamel("Item")).toBe("item");
  });
});
