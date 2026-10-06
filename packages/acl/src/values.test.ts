import { describe, expect, it } from "vitest";

import { ErpDecimalError, erpDecimal } from "./values.js";

/**
 * The property that makes this safe, and the one that makes it necessary.
 *
 * NECESSARY: node-postgres returns `NUMERIC` as text, the ERP's `decimal` validator accepts
 * a string and stores it uncoerced, so the ERP has been holding `"12.000"` in a field its own
 * schema calls a number. Correct only while that validator stays lenient.
 *
 * SAFE: `JSON.stringify` writes the shortest decimal that parses back to the same double, so
 * for any value within 15 significant digits the JSON the ERP receives names the same number
 * the database holds. That is asserted here over the real column shape rather than assumed.
 */
describe("erpDecimal", () => {
  it("carries every value a numeric(14,2) column can hold, exactly", () => {
    // The round trip that matters is TEXT -> number -> JSON, because JSON is what crosses.
    const cases = [
      "0.00",
      "0.01",
      "12.000",
      "40.00",
      "120.50",
      "120.57",
      "1205.00",
      "-5.50",
      "999999999999.99",
    ];
    for (const text of cases) {
      const n = erpDecimal("amount", text);
      expect(Number(JSON.stringify(n)), text).toBe(Number(text));
    }
  });

  it("drops the trailing zeros numeric emits to its scale, and nothing else", () => {
    expect(erpDecimal("quantity", "12.000")).toBe(12);
    expect(erpDecimal("amount", "40.00")).toBe(40);
    // 120.57 is not representable in binary; the point is that the SHORTEST round-trip
    // decimal is still "120.57", so what the ERP receives is what was recorded.
    expect(JSON.stringify(erpDecimal("amount", "120.57"))).toBe("120.57");
  });

  it("accepts a number unchanged, so a caller that already has one is not penalised", () => {
    expect(erpDecimal("quantity", 12)).toBe(12);
    expect(erpDecimal("amount", 120.5)).toBe(120.5);
  });

  it("refuses what it cannot carry, rather than sending something nearly right", () => {
    // Sixteen significant digits: a double's shortest round trip would name a different
    // decimal than the database holds, silently, in somebody's ledger.
    expect(() => erpDecimal("amount", "1234567890123456")).toThrow(ErpDecimalError);
    expect(() => erpDecimal("amount", "0.1234567890123456")).toThrow(/significant digits/);
    // And the refusal names the column, because the caller is enqueueing a write and the
    // operator who reads the dead letter needs to know which field.
    expect(() => erpDecimal("quantity", "nonsense")).toThrow(/quantity/);
    for (const bad of ["", "   ", "NaN", "Infinity", "1,000.00"]) {
      expect(() => erpDecimal("amount", bad), bad).toThrow(ErpDecimalError);
    }
  });

  it("holds the fifteen-digit boundary from both sides", () => {
    // Exactly fifteen significant digits is the last value a double names unambiguously, so
    // it is admitted; sixteen is not. Counted rather than eyeballed, because the first
    // version of this test called a fifteen-digit value sixteen and asserted a refusal that
    // correctly did not happen.
    expect("1234567890123.45".replace(/[.]/g, "")).toHaveLength(15);
    expect(erpDecimal("amount", "1234567890123.45")).toBe(1234567890123.45);

    expect("12345678901234.56".replace(/[.]/g, "")).toHaveLength(16);
    expect(() => erpDecimal("amount", "12345678901234.56")).toThrow(ErpDecimalError);
  });
});
