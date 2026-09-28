import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { InvalidTenantIdError, SET_TENANT_CONTEXT_SQL, withTenantContext } from "./tenant-context.js";

/** Records every statement so we can assert on shape and on bound parameters. */
function fakeClient(): PoolClient & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    calls,
    query: (sql: string, params?: unknown[]) => {
      calls.push(params === undefined ? { sql } : { sql, params });
      return Promise.resolve({ rows: [] });
    },
  };
  return client as unknown as PoolClient & { calls: typeof calls };
}

describe("withTenantContext", () => {
  it("binds the tenant id as a parameter, never into SQL text", async () => {
    const c = fakeClient();
    await withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "ok");
    const setCall = c.calls.find((x) => x.sql === SET_TENANT_CONTEXT_SQL);
    expect(setCall?.params).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(SET_TENANT_CONTEXT_SQL).not.toContain("1111");
  });

  it("wraps the work in a transaction and commits", async () => {
    const c = fakeClient();
    const out = await withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => 42);
    expect(out).toBe(42);
    expect(c.calls.map((x) => x.sql)).toEqual([
      "BEGIN",
      SET_TENANT_CONTEXT_SQL,
      "COMMIT",
    ]);
  });

  it("rolls back and rethrows when the callback fails", async () => {
    const c = fakeClient();
    await expect(
      withTenantContext(c, "11111111-1111-4111-8111-111111111111", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(c.calls.map((x) => x.sql)).toContain("ROLLBACK");
    expect(c.calls.map((x) => x.sql)).not.toContain("COMMIT");
  });

  it.each([
    ["not a uuid", "tenant-1"],
    ["the ERP regex's hyphen-only hole", "----------------"],
    ["a single hyphen", "-"],
    ["empty", ""],
    ["sql fragment", "1' OR '1'='1"],
    ["uuid with trailing text", "11111111-1111-4111-8111-111111111111x"],
  ])("refuses %s before opening a transaction", async (_label, bad) => {
    const c = fakeClient();
    await expect(withTenantContext(c, bad, async () => "never")).rejects.toThrow(
      InvalidTenantIdError,
    );
    expect(c.calls).toHaveLength(0);
  });
});
