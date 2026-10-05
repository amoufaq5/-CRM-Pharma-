import { describe, expect, it } from "vitest";
import * as callplan from "@crm/callplan";
import * as expense from "@crm/expense";
import * as notify from "@crm/notify";
import * as role from "@crm/role";
import * as sample from "@crm/sample";

import { PrivilegedConnectionError } from "@crm/db";

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
  /**
   * Errors that SHOULD fall through to a 500, with the reason each one does.
   *
   * The rule above exists to catch an error class added to a domain package and never
   * mapped. It is not a claim that every error belongs in a response: these three happen
   * inside the SCHEDULER while it talks to an SMTP relay, where the sender converts them
   * into a `SendOutcome` and the dispatcher logs them. None can reach a request, and
   * giving one a client-facing status would invent a meaning it does not have.
   *
   * Explicit and listed, like RLS_EXEMPT in schema.contract.test.ts, so adding one is a
   * visible act with a reason attached rather than a silent hole.
   */
  const DELIBERATELY_INTERNAL: Readonly<Record<string, string>> = {
    InvalidSmtpRelayError: "boot-time relay configuration; the scheduler must fail to start, not answer a request",
    SmtpProtocolError: "the relay spoke something that is not SMTP; becomes a dead SendOutcome",
    SmtpTimeoutError: "a relay stopped answering; becomes a retry SendOutcome",
    ClientAlreadyInTenantContextError:
      "a caller handed the expense sweep a client already inside withTenantContext — a " +
      "programming error in the scheduler, not something a request can provoke or a client act on",
  };

  for (const [moduleName, mod, atLeast] of [
    ["@crm/sample", sample as unknown as Record<string, unknown>, 6],
    ["@crm/callplan", callplan as unknown as Record<string, unknown>, 6],
    ["@crm/role", role as unknown as Record<string, unknown>, 6],
    ["@crm/notify", notify as unknown as Record<string, unknown>, 1],
    // Added after every one of this package's twelve refusals reached a client as a 500 —
    // including `UnmappedCategoryError`, which is the designed refusal the whole Finance
    // dependency rests on. A new domain package is exactly what this test is for, and it
    // only works if the package is in this list.
    ["@crm/expense", expense as unknown as Record<string, unknown>, 10],
  ] as const) {
    it(`maps every error exported by ${moduleName}`, () => {
      const classes = errorClasses(mod);
      expect(classes.length).toBeGreaterThanOrEqual(atLeast);
      for (const [name, instance] of classes) {
        const problem = toProblem(instance);
        if (name in DELIBERATELY_INTERNAL) {
          expect(problem.kind, `${name} is listed as internal; if that changed, map it`).toBe("internal");
          continue;
        }
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

  it("gives an unmapped expense category its own type, because Finance must act on it", () => {
    const problem = toProblem(new expense.UnmappedCategoryError("congress"));
    expect(problem.body().type).toBe(`${PROBLEM_BASE}/unmapped-category`);
    expect(problem.status).toBe(409);
    // The sentence has to survive: it names the category and the table Finance fills in.
    expect(problem.detail).toContain("congress");
  });

  it("gives the lockout refusal its own type, because a client must act on it", () => {
    expect(toProblem(new role.LastAdministratorError("refusing to revoke the last administrator")).body().type).toBe(
      `${PROBLEM_BASE}/last-administrator`,
    );
    expect(toProblem(new role.SelfGrantError("cannot grant themselves")).status).toBe(403);
    expect(toProblem(new role.RoleAlreadyHeldError("compliance", "2026-01-01")).status).toBe(409);
  });

  /**
   * The one domain error that SHOULD fall through to a generic 500.
   *
   * A connection whose role bypasses RLS is an operator misconfiguration, not something
   * a client did or can fix, and the error names a database role. Mapping it to a
   * friendlier problem would publish that name to anyone who can make a request. The
   * full message goes to the structured log, where the operator is.
   */
  it("keeps a privileged-connection refusal internal, and does not name the role", () => {
    const problem = toProblem(new PrivilegedConnectionError("postgres"));
    expect(problem.kind).toBe("internal");
    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem.body("cid"))).not.toContain("postgres");
    expect(JSON.stringify(problem.body("cid"))).not.toContain("row-level security");
  });

  it("passes an ApiError through untouched", () => {
    const original = new ApiError("not_found", "no such thing");
    expect(toProblem(original)).toBe(original);
  });
});
