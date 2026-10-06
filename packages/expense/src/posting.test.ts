import { describe, expect, it } from "vitest";

import {
  ERP_EXPENSE_CATEGORIES,
  ERP_EXPENSE_ENTITY,
  EXPENSE_SOURCE_TABLE,
  buildExpenseCreate,
  buildExpenseReimburse,
  erpExpenseCategory,
  expenseDescription,
  expenseRecordId,
  type PostableClaim,
} from "./posting.js";

/**
 * The ERP payloads, asserted without a database because the MAPPING is the part worth
 * asserting — the same reason `packages/sample/src/erp-mirror.ts` keeps its mapping pure.
 *
 * Field names come from `pack-erp-core/src/entities-finance.ts`, not from
 * `packages/acl/src/generated/erp.ts`, which has no `Expense` because the captured
 * baseline covers only `Item` and `Opportunity`. These tests are therefore the only thing
 * standing between a typo and a 422 three weeks later, so they name every key.
 */
const CLAIM: PostableClaim = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  crm_category: "congress",
  amount: "1234.50",
  currency: "GBP",
  incurred_on: "2026-09-01",
  description: "Respiratory congress, Manchester",
  erp_ledger_account_code: "6200",
  erp_cost_center_code: "CC-SM",
};

describe("erpExpenseCategory", () => {
  it("lists the ERP's seven values and no more", () => {
    expect(ERP_EXPENSE_CATEGORIES).toEqual([
      "travel",
      "meals",
      "lodging",
      "supplies",
      "software",
      "training",
      "other",
    ]);
  });

  it("passes an exact match through", () => {
    for (const category of ERP_EXPENSE_CATEGORIES) {
      expect(erpExpenseCategory(category)).toBe(category);
    }
  });

  it("reduces a richer CRM category to other rather than guessing", () => {
    for (const category of ["congress", "hospitality", "speaker_fee", "sample_courier"]) {
      expect(erpExpenseCategory(category)).toBe("other");
    }
  });

  it("does not match on case — the ERP's enum is lowercase", () => {
    expect(erpExpenseCategory("Travel")).toBe("other");
  });

  it("does not match on a padded value", () => {
    expect(erpExpenseCategory("travel ")).toBe("other");
  });

  it("maps the empty string to other rather than throwing", () => {
    expect(erpExpenseCategory("")).toBe("other");
  });
});

describe("expenseRecordId", () => {
  it("derives the id from the claim, so a redelivery addresses the same record", () => {
    expect(expenseRecordId(CLAIM.id)).toBe(`crm-exp-${CLAIM.id}`);
  });

  it("is a pure function of the claim id", () => {
    expect(expenseRecordId(CLAIM.id)).toBe(expenseRecordId(CLAIM.id));
  });

  it("stays inside the ERP's ^[A-Za-z0-9_-]{1,200}$ for a uuid", () => {
    const id = expenseRecordId(CLAIM.id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(id.length).toBeLessThan(200);
  });

  it("gives two claims two ids", () => {
    expect(expenseRecordId("a")).not.toBe(expenseRecordId("b"));
  });
});

describe("expenseDescription", () => {
  it("carries the CRM category, which the ERP's enum cannot hold", () => {
    expect(expenseDescription(CLAIM)).toContain("category congress");
  });

  it("carries the snapshotted S&M account, which Expense has no field for", () => {
    expect(expenseDescription(CLAIM)).toContain("S&M account 6200");
  });

  it("carries the cost centre when one is snapshotted", () => {
    expect(expenseDescription(CLAIM)).toContain("cost centre CC-SM");
  });

  it("omits the cost centre entirely when there is none", () => {
    const text = expenseDescription({ ...CLAIM, erp_cost_center_code: null });
    expect(text).not.toContain("cost centre");
    expect(text).toContain("S&M account 6200");
  });

  it("carries the claim id so an ERP row traces back without the outbox", () => {
    expect(expenseDescription(CLAIM)).toContain(CLAIM.id);
  });

  it("appends the rep's own words last", () => {
    expect(expenseDescription(CLAIM).endsWith("Respiratory congress, Manchester")).toBe(true);
  });

  it("omits an empty description rather than leaving a trailing separator", () => {
    expect(expenseDescription({ ...CLAIM, description: "" }).endsWith("·")).toBe(false);
    expect(expenseDescription({ ...CLAIM, description: null })).toContain("cost centre CC-SM");
  });

  it("says unmapped rather than null when there is no snapshot", () => {
    expect(expenseDescription({ ...CLAIM, erp_ledger_account_code: null })).toContain(
      "S&M account unmapped",
    );
  });

  it("truncates a long description with an ellipsis instead of being refused by the ERP", () => {
    const text = expenseDescription({ ...CLAIM, description: "x".repeat(2000) });
    expect(text.length).toBe(500);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("buildExpenseCreate", () => {
  const row = buildExpenseCreate(CLAIM, "emp-77");

  it("names the entity and never a path", () => {
    expect(row.entity).toBe("Expense");
    expect(ERP_EXPENSE_ENTITY).toBe("Expense");
    expect(JSON.stringify(row)).not.toContain("/v1/");
  });

  it("creates rather than transitions", () => {
    expect(row.operation).toBe("create");
  });

  it("addresses the deterministic record id", () => {
    expect(row.targetRecordId).toBe(expenseRecordId(CLAIM.id));
  });

  it("sends exactly the Expense fields pack-erp-core declares, and no others", () => {
    expect(Object.keys(row.payload).sort()).toEqual([
      "amount",
      "category",
      "currency",
      "description",
      "employee_id",
      "incurred_on",
      "state",
    ]);
  });

  it("points employee_id at the rep's reconciled ERP Employee", () => {
    expect(row.payload["employee_id"]).toBe("emp-77");
  });

  /**
   * A NUMBER, and the test this replaces asserted a string "because float64 cannot hold
   * every NUMERIC(14,2)". That reasoning is README rule 4 applied in the wrong direction.
   *
   * Rule 4 is about money coming FROM the ERP, where the destination is a `NUMERIC` column
   * of arbitrary precision and a double in between can only lose. Going the other way the
   * destination is a field the ERP's own schema calls a `decimal`, and its validator stores
   * what it was sent WITHOUT coercing — so a string sat in a numeric field, correct only
   * while that validator kept accepting one. Tighten it to `typeof value === "number"` and
   * every posted claim 422s and dead-letters.
   *
   * The precision worry is answered rather than dismissed: see the round-trip tests on
   * `erpDecimal`, and the one below.
   */
  it("sends the amount as a NUMBER, because that is what the ERP field is", () => {
    expect(row.payload["amount"]).toBe(1234.5);
    expect(typeof row.payload["amount"]).toBe("number");
  });

  it("does not round a long amount, and the JSON that crosses says so", () => {
    const big = buildExpenseCreate({ ...CLAIM, amount: "999999999999.99" }, "emp-77");
    expect(big.payload["amount"]).toBe(999999999999.99);
    // The assertion that actually matters: JSON is what reaches the ERP, and
    // `JSON.stringify` writes the shortest decimal that parses back to the same double — so
    // the digits the database holds are the digits that cross.
    expect(JSON.stringify(big.payload["amount"])).toBe("999999999999.99");
  });

  it("refuses an amount it cannot carry, rather than sending one that is nearly right", () => {
    // Beyond a numeric(14,2), so unreachable from this column today — the guard is for the
    // day somebody widens it without reading `erpDecimal`.
    expect(() => buildExpenseCreate({ ...CLAIM, amount: "12345678901234.56" }, "emp-77")).toThrow(
      /significant digits/,
    );
  });

  it("sends the date as the ISO day it was incurred, with no time", () => {
    expect(row.payload["incurred_on"]).toBe("2026-09-01");
  });

  it("creates the record ALREADY approved — the CRM owns the approval graph", () => {
    expect(row.payload["state"]).toBe("approved");
  });

  it("does not send expense_number: it is a server-allocated sequence", () => {
    expect(row.payload).not.toHaveProperty("expense_number");
  });

  it("does not send an id: the relay adds the target id on dispatch", () => {
    expect(row.payload).not.toHaveProperty("id");
  });

  it("does not send a receipt: Expense.receipt is an untyped JSONB file field (report R9)", () => {
    expect(row.payload).not.toHaveProperty("receipt");
  });

  it("does not invent a cost_center_id — Expense has no such field (report R8)", () => {
    expect(row.payload).not.toHaveProperty("cost_center_id");
    expect(row.payload).not.toHaveProperty("ledger_account_id");
  });

  it("is a pure function of its inputs", () => {
    expect(buildExpenseCreate(CLAIM, "emp-77")).toEqual(row);
  });
});

describe("buildExpenseReimburse", () => {
  const row = buildExpenseReimburse("crm-exp-1");

  it("fires the ERP's reimburse transition, which only accepts approved", () => {
    expect(row.operation).toBe("transition:reimburse");
  });

  it("addresses the record the create minted, not a new one", () => {
    expect(row.targetRecordId).toBe("crm-exp-1");
  });

  it("sends an empty payload — the transition carries no fields", () => {
    expect(row.payload).toEqual({});
  });

  it("parses as a transition under the relay's own operation grammar", () => {
    expect(row.operation).toMatch(/^transition:[A-Za-z_][A-Za-z0-9_]*$/);
  });
});

describe("the outbox correlation", () => {
  it("names the producing table exactly as crm.outbox_recipient branches on it", () => {
    // 0022's attribution function switches on this literal; a mismatch means a dead
    // letter nobody is told about.
    expect(EXPENSE_SOURCE_TABLE).toBe("crm.expense_claim");
  });
});
