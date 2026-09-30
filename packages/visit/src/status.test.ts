import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  VISIT_STATUSES,
  VISIT_TRANSITIONS,
  assertTransition,
  canTransition,
  isFinal,
} from "./status.js";

describe("the visit lifecycle", () => {
  it("covers every declared status", () => {
    for (const s of VISIT_STATUSES) expect(VISIT_TRANSITIONS[s]).toBeDefined();
  });

  it("only ever transitions to a real status", () => {
    for (const from of VISIT_STATUSES) {
      for (const to of VISIT_TRANSITIONS[from]) expect(VISIT_STATUSES).toContain(to);
    }
  });

  it("walks planned -> in_progress -> completed", () => {
    expect(canTransition("planned", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("reaches `missed` only from `planned`", () => {
    // A rep who turned up and was refused entry records `completed` with outcome
    // `no_access`. That is a different fact from never having gone, and coverage
    // reporting depends on telling them apart.
    expect(canTransition("planned", "missed")).toBe(true);
    expect(canTransition("in_progress", "missed")).toBe(false);
  });

  it("treats completed, cancelled and missed as final", () => {
    expect(isFinal("completed")).toBe(true);
    expect(isFinal("cancelled")).toBe(true);
    expect(isFinal("missed")).toBe(true);
    expect(isFinal("planned")).toBe(false);
  });

  it("refuses to reopen a completed visit, and says why", () => {
    expect(() => assertTransition("completed", "in_progress")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("completed", "in_progress")).toThrow(/record a correcting visit/);
  });

  it("names what WOULD have been allowed on a non-final refusal", () => {
    // The message a trigger cannot produce, which is why the check also lives here.
    expect(() => assertTransition("planned", "completed")).toThrow(
      /allowed: in_progress, cancelled, missed/,
    );
  });

  it("cannot skip straight from planned to completed", () => {
    // A completed visit without an in_progress step means nobody checked in, so
    // there is no check-in location and no duration to trust.
    expect(canTransition("planned", "completed")).toBe(false);
  });
});
