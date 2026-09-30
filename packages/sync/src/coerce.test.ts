import { describe, expect, it } from "vitest";
import {
  CoercionError,
  coerceBoolean,
  coerceCountry,
  coerceDate,
  coerceDecimal,
  coerceRecordId,
  coerceRequiredRecordId,
  coerceRequiredText,
  coerceText,
  coerceTimestamp,
} from "./coerce.js";

describe("coerceDecimal — the one that must never be wrong", () => {
  it("returns a STRING so NUMERIC stores it exactly", () => {
    // float64 cannot represent this. Parsing it into a number and handing that
    // to the driver would round it silently, in a column that then looks
    // authoritative. Money stays text all the way into Postgres.
    expect(coerceDecimal("list_price", "1234567890.12")).toBe("1234567890.12");
    expect(typeof coerceDecimal("list_price", "0.1")).toBe("string");
  });

  it("accepts plain decimals, negatives and integers", () => {
    expect(coerceDecimal("x", "0")).toBe("0");
    expect(coerceDecimal("x", "-42.5")).toBe("-42.5");
    expect(coerceDecimal("x", "999999.9999")).toBe("999999.9999");
  });

  it("treats absent and blank as null, not as zero", () => {
    // A missing price is unknown. Zero is a claim that it is free.
    expect(coerceDecimal("x", null)).toBeNull();
    expect(coerceDecimal("x", undefined)).toBeNull();
    expect(coerceDecimal("x", "")).toBeNull();
    expect(coerceDecimal("x", "   ")).toBeNull();
  });

  it.each([
    ["stray text", "1,000"],
    ["currency symbol", "$10"],
    ["not a number", "abc"],
    ["trailing junk", "10abc"],
    ["two dots", "1.2.3"],
    ["exponent", "1e5"],
    ["hex", "0x10"],
    ["an object", { v: 1 }],
    ["an array", [1]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("REFUSES %s rather than writing something wrong", (_label, input) => {
    expect(() => coerceDecimal("list_price", input)).toThrow(CoercionError);
  });

  it("names the field and the value so a rejection is actionable", () => {
    expect(() => coerceDecimal("list_price", "$10")).toThrow(/list_price.*\$10/);
  });

  it("refuses exponent notation on purpose", () => {
    // Postgres would accept 1e5. Its presence means the value already went
    // through a float somewhere upstream, so exactness is already lost and we
    // want to know.
    expect(() => coerceDecimal("x", "1e5")).toThrow(/exponent/);
  });
});

describe("coerceDate", () => {
  it("accepts a plain ISO date", () => {
    expect(coerceDate("hire_date", "2026-09-01")).toBe("2026-09-01");
  });

  it("refuses a datetime, because truncating one shifts the day across time zones", () => {
    expect(() => coerceDate("hire_date", "2026-09-01T23:00:00Z")).toThrow(/YYYY-MM-DD/);
  });

  it("refuses a date that matches the shape but does not exist", () => {
    expect(() => coerceDate("hire_date", "2026-02-30")).toThrow(/not a real calendar date/);
    expect(() => coerceDate("hire_date", "2026-13-01")).toThrow();
  });

  it("treats absent and blank as null", () => {
    expect(coerceDate("x", null)).toBeNull();
    expect(coerceDate("x", "")).toBeNull();
  });
});

describe("coerceTimestamp", () => {
  it("passes ISO-8601 through VERBATIM", () => {
    // Re-formatting risks shifting the microseconds the incremental high-water
    // mark depends on, which would skip records.
    const t = "2026-09-01T12:34:56.789Z";
    expect(coerceTimestamp("updated_at", t)).toBe(t);
  });

  it("refuses something unparseable", () => {
    expect(() => coerceTimestamp("updated_at", "last tuesday")).toThrow(CoercionError);
  });
});

describe("coerceText", () => {
  it("passes strings through and stringifies numbers and booleans", () => {
    expect(coerceText("x", "a")).toBe("a");
    expect(coerceText("x", 42)).toBe("42");
    expect(coerceText("x", true)).toBe("true");
  });

  it("refuses an object rather than storing [object Object]", () => {
    expect(() => coerceText("x", { a: 1 })).toThrow(CoercionError);
  });

  it("requires a non-blank value where the column is NOT NULL", () => {
    expect(coerceRequiredText("sku", "A-1")).toBe("A-1");
    expect(() => coerceRequiredText("sku", "")).toThrow(/required/);
    expect(() => coerceRequiredText("sku", "   ")).toThrow(/required/);
    expect(() => coerceRequiredText("sku", null)).toThrow(/required/);
  });
});

describe("coerceCountry", () => {
  it("upper-cases for the CHAR(2) column", () => {
    expect(coerceCountry("country", "ae")).toBe("AE");
  });

  it("refuses anything that is not two letters", () => {
    expect(() => coerceCountry("country", "UAE")).toThrow(CoercionError);
    expect(() => coerceCountry("country", "1A")).toThrow(CoercionError);
  });

  it("treats blank as null rather than as a blank country", () => {
    expect(coerceCountry("country", "")).toBeNull();
  });
});

describe("coerceRecordId", () => {
  it("accepts the ERP's id shape", () => {
    expect(coerceRecordId("id", "rec_abc-123_X")).toBe("rec_abc-123_X");
  });

  it("refuses an id the crm.erp_record_id domain would reject", () => {
    // Better to fail here, with the field named, than at the database with a
    // constraint violation halfway through a batch.
    expect(() => coerceRecordId("id", "has space")).toThrow(/erp_record_id/);
    expect(() => coerceRecordId("id", "a".repeat(201))).toThrow(CoercionError);
  });

  it("requires one where the key column demands it", () => {
    expect(() => coerceRequiredRecordId("id", null)).toThrow(/required/);
  });
});

describe("coerceBoolean", () => {
  it("accepts real booleans and their JSON string forms", () => {
    expect(coerceBoolean("x", true)).toBe(true);
    expect(coerceBoolean("x", "false")).toBe(false);
  });

  it("refuses 0/1 and yes/no rather than guessing a convention", () => {
    expect(() => coerceBoolean("x", 1)).toThrow(CoercionError);
    expect(() => coerceBoolean("x", "yes")).toThrow(CoercionError);
  });
});
