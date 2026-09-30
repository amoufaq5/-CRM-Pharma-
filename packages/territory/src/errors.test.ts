import { describe, expect, it } from "vitest";
import {
  InvalidDateRangeError,
  OverlappingAssignmentError,
  TerritoryCycleError,
  assertDate,
  assertRange,
  translatePgError,
} from "./errors.js";

describe("assertDate", () => {
  it("accepts a real ISO date", () => {
    expect(() => assertDate("valid_from", "2026-09-30")).not.toThrow();
  });

  it.each(["2026-9-1", "30-09-2026", "2026-09-30T00:00:00Z", "", "today"])(
    "refuses %s",
    (bad) => {
      expect(() => assertDate("valid_from", bad)).toThrow(InvalidDateRangeError);
    },
  );

  it("refuses a date that matches the shape but does not exist", () => {
    expect(() => assertDate("valid_from", "2026-02-30")).toThrow(/not a real calendar date/);
  });
});

describe("assertRange", () => {
  it("accepts an open-ended range", () => {
    expect(() => assertRange("2026-01-01", null)).not.toThrow();
  });

  it("refuses an end that precedes the start", () => {
    expect(() => assertRange("2026-06-01", "2026-01-01")).toThrow(InvalidDateRangeError);
  });

  it("refuses an EQUAL end, because the range is half-open and would be empty", () => {
    // Almost always a caller meaning "one day" and silently getting zero.
    expect(() => assertRange("2026-06-01", "2026-06-01")).toThrow(/half-open/);
  });
});

describe("translatePgError", () => {
  it("turns the exclusion-constraint violation into something actionable", () => {
    // "conflicting key value violates exclusion constraint" tells a caller
    // nothing about what they did or what to do instead.
    const err = translatePgError({ code: "23P01" }, "account acct_1", "2026-06-01");
    expect(err).toBeInstanceOf(OverlappingAssignmentError);
    expect(err.message).toContain("account acct_1");
    expect(err.message).toContain("2026-06-01");
    expect(err.message).toMatch(/reassignAccount/);
  });

  it("recognises the hierarchy cycle trigger", () => {
    expect(
      translatePgError({ message: "territory hierarchy cycle: x cannot be a descendant of itself" }, "t", ""),
    ).toBeInstanceOf(TerritoryCycleError);
    expect(
      translatePgError({ message: "territory hierarchy deeper than 64 levels" }, "t", ""),
    ).toBeInstanceOf(TerritoryCycleError);
  });

  it("passes an unrelated error through unchanged", () => {
    const original = new Error("connection reset");
    expect(translatePgError(original, "t", "")).toBe(original);
  });
});
