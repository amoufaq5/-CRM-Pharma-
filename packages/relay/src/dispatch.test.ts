import { describe, expect, it } from "vitest";
import { idempotencyKeyFor, parseOperation, UnknownOperationError } from "./dispatch.js";
import type { OutboxRow } from "./store.js";

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "0d1c1e2f-0000-4000-8000-000000000001",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  entity: "Item",
  operation: "create",
  payload: {},
  target_record_id: "crm_abc",
  source_table: "crm.expense_claim",
  source_id: "0d1c1e2f-0000-4000-8000-000000000002",
  attempts: 0,
  ...over,
});

describe("parseOperation", () => {
  it("reads create, update and a named transition", () => {
    expect(parseOperation("create")).toEqual({ kind: "create" });
    expect(parseOperation("update")).toEqual({ kind: "update" });
    expect(parseOperation("transition:mark_paid")).toEqual({ kind: "transition", name: "mark_paid" });
  });

  it.each(["", "delete", "transition:", "transition:bad-name", "transition:1abc", "CREATE"])(
    "refuses %s rather than failing later as an undefined method call",
    (op) => {
      expect(() => parseOperation(op)).toThrow(UnknownOperationError);
    },
  );
});

describe("idempotencyKeyFor", () => {
  it("is stable per row, so a retry reuses it", () => {
    expect(idempotencyKeyFor(row())).toBe(idempotencyKeyFor(row()));
  });

  it("differs between rows, so distinct writes never collide", () => {
    expect(idempotencyKeyFor(row())).not.toBe(
      idempotencyKeyFor(row({ id: "0d1c1e2f-0000-4000-8000-000000000009" })),
    );
  });
});
