import { describe, expect, it } from "vitest";
import * as callplan from "@crm/callplan";
import * as notify from "@crm/notify";
import * as role from "@crm/role";
import * as sample from "@crm/sample";

import { ApiError, PROBLEM_BASE, toProblem } from "./problems.js";

/**
 * Domain errors are mapped to problems BY NAME (see `toProblem`), which is robust
 * across package boundaries and fragile in one specific way: a new error class added
 * to a domain package falls through to a 500 and nothing says so.
 *
 * So the mapping is asserted structurally. Every error exported by the sample and
 * call-plan packages must map to something other than `internal` — a reviewer adding
 * the tenth custody rule finds out here rather than from a support ticket reading
 * "an unexpected error occurred".
 */
describe("toProblem covers every domain error", () => {
  /**
   * The exported error CLASSES, found by constructing each candidate and keeping the
   * ones that come back as an Error whose `name` it set to its own class name — which
   * is exactly the property `toProblem` dispatches on. A `translateXError` helper also
   * ends in "Error" and is excluded by the same check rather than by a name pattern.
   */
  const errorClasses = (mod: Record<string, unknown>): ReadonlyArray<[string, Error]> => {
    const out: Array<[string, Error]> = [];
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function" || !name.endsWith("Error")) continue;
      let instance: unknown;
      try {
        instance = new (value as new (...a: unknown[]) => unknown)("x", "y");
      } catch {
        continue;
      }
      if (instance instanceof Error && instance.name === name) out.push([name, instance]);
    }
    return out;
  };

  // The minimum is per module and deliberately close to the real count: a module whose
  // errors all vanish from the barrel would otherwise pass this test by exporting none.
  for (const [moduleName, mod, atLeast] of [
    ["@crm/sample", sample as unknown as Record<string, unknown>, 6],
    ["@crm/callplan", callplan as unknown as Record<string, unknown>, 6],
    ["@crm/role", role as unknown as Record<string, unknown>, 6],
    ["@crm/notify", notify as unknown as Record<string, unknown>, 1],
  ] as const) {
    it(`maps every error exported by ${moduleName}`, () => {
      const classes = errorClasses(mod);
      expect(classes.length).toBeGreaterThanOrEqual(atLeast);
      for (const [name, instance] of classes) {
        const problem = toProblem(instance);
        expect(problem.kind, `${moduleName}.${name} falls through to a 500`).not.toBe("internal");
        expect(problem.status).toBeLessThan(500);
      }
    });
  }

  it("keeps an unrecognised throw generic, and says nothing about the internals", () => {
    const problem = toProblem(new Error("relation crm.sample_holding does not exist"));
    expect(problem.kind).toBe("internal");
    expect(problem.status).toBe(500);
    // An internal message can carry a table name, a column or SQL. The client is the
    // wrong place for that; the log is the right one.
    expect(problem.detail).toBe("an unexpected error occurred");
    expect(problem.detail).not.toContain("sample_holding");
  });

  it("gives the custody refusals a client can branch on their own types", () => {
    expect(toProblem(new sample.LotExpiredError("expired on 2026-01-01")).body().type).toBe(
      `${PROBLEM_BASE}/lot-expired`,
    );
    expect(toProblem(new sample.InsufficientHoldingError("holds 2.000")).body().type).toBe(
      `${PROBLEM_BASE}/insufficient-stock`,
    );
    expect(toProblem(new callplan.PlanFrozenError("are fixed")).body().type).toBe(`${PROBLEM_BASE}/plan-final`);
  });

  it("gives the lockout refusal its own type, because a client must act on it", () => {
    expect(toProblem(new role.LastAdministratorError("refusing to revoke the last administrator")).body().type).toBe(
      `${PROBLEM_BASE}/last-administrator`,
    );
    expect(toProblem(new role.SelfGrantError("cannot grant themselves")).status).toBe(403);
    expect(toProblem(new role.RoleAlreadyHeldError("compliance", "2026-01-01")).status).toBe(409);
  });

  it("passes an ApiError through untouched", () => {
    const original = new ApiError("not_found", "no such thing");
    expect(toProblem(original)).toBe(original);
  });
});
