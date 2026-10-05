import { describe, expect, it } from "vitest";
import { ErpError } from "@crm/acl";

import { PROBE_TIMEOUT_MS, probeTargetRecord, type ProbeReader } from "./probe.js";

const TARGET = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  entity: "LeaveRequest",
  recordId: "crm-exp-0d1c1e2f-0000-4000-8000-000000000001",
};

/** A reader whose single answer the test dictates. */
const reads = (answer: () => Promise<unknown>): ProbeReader => ({ get: () => answer() });

describe("probeTargetRecord", () => {
  it("reports the record the ERP handed back", async () => {
    const verdict = await probeTargetRecord(
      reads(() => Promise.resolve({ id: TARGET.recordId, state: "draft" })),
      TARGET,
    );
    expect(verdict.kind).toBe("present");
    expect(verdict.kind === "present" && verdict.record["state"]).toBe("draft");
  });

  it("reports absence for the null `ErpClient.get` returns on a 404", async () => {
    // Not an exception: `ErpClient.get` swallows `kind === "not_found"` and answers
    // null, so null IS the ERP saying it does not hold the record.
    expect((await probeTargetRecord(reads(() => Promise.resolve(null)), TARGET)).kind).toBe("absent");
  });

  it("asks for exactly the tenant, entity and record id it was given", async () => {
    const calls: Array<readonly [string, string, string]> = [];
    await probeTargetRecord(
      {
        get: (tenantId, entity, id) => {
          calls.push([tenantId, entity, id]);
          return Promise.resolve(null);
        },
      },
      TARGET,
    );
    expect(calls).toEqual([[TARGET.tenantId, TARGET.entity, TARGET.recordId]]);
  });

  it("reports `unknown` when the read itself fails, and never throws", async () => {
    const verdict = await probeTargetRecord(
      reads(() => Promise.reject(new ErpError("unavailable", 503, "service_unavailable", "down", null))),
      TARGET,
    );
    expect(verdict.kind).toBe("unknown");
    expect(verdict.kind === "unknown" && verdict.reason).toContain("503");
  });

  it("reports `unknown` rather than waiting out the client's own timeout", async () => {
    const started = Date.now();
    const verdict = await probeTargetRecord(
      reads(() => new Promise(() => undefined)),
      TARGET,
      { timeoutMs: 20 },
    );
    expect(verdict.kind).toBe("unknown");
    expect(verdict.kind === "unknown" && verdict.reason).toContain("20ms");
    // The point of the budget: it returns on ITS deadline, not the read's.
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
  });

  it("survives a read that rejects AFTER the budget expired", async () => {
    // The verdict is already `unknown` by then, and the late rejection must neither
    // change it nor surface anywhere. (`Promise.race` observes it, which is why the
    // implementation carries no explicit guard — see the comment there.)
    const verdict = await probeTargetRecord(
      reads(() => new Promise((_, reject) => setTimeout(() => reject(new Error("late reset")), 25))),
      TARGET,
      { timeoutMs: 5 },
    );
    expect(verdict.kind).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it.each([
    ["a bare string", "crm-exp-1"],
    ["a number", 7],
    ["an array", [{ id: "crm-exp-1" }]],
  ])("treats %s as inconclusive, not as a record", async (_label, body) => {
    // A 200 carrying something other than a record is not evidence of one, and
    // calling it `present` would settle a write on a shape the ERP never promised.
    const verdict = await probeTargetRecord(reads(() => Promise.resolve(body)), TARGET);
    expect(verdict.kind).toBe("unknown");
  });

  it("asks once and only once — a probe of a probe answers nothing", async () => {
    let calls = 0;
    await probeTargetRecord(
      reads(() => {
        calls += 1;
        return Promise.reject(new Error("ECONNRESET"));
      }),
      TARGET,
    );
    expect(calls).toBe(1);
  });
});
