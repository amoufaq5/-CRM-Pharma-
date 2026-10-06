import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  InvalidTenantIdError,
  PrivilegedConnectionError,
  ROLE_PRIVILEGE_SQL,
  SET_TENANT_CONTEXT_SQL,
  TransactionAlreadyOpenError,
  withTenantContext,
} from "./tenant-context.js";

/**
 * Records every statement so we can assert on shape and on bound parameters.
 *
 * It must ANSWER two statements now: the context statement reports the session's role,
 * and a second asks the catalog whether that role is exempt from RLS. The wrapper
 * refuses a connection it cannot get both answers for, so a fake that stays silent is
 * itself a test case ("silent" / "no-verdict").
 *
 * Role names in these tests are deliberately UNIQUE where the cache matters: the
 * verdict is cached per role name for the life of the process, so two tests sharing a
 * name would share an answer and the second would assert nothing.
 */
function fakeClient(
  session: { role?: string; bypassesRls?: boolean; txStatus?: "I" | "T" | "E" | null } | "silent" | "no-verdict" = {},
): PoolClient & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    calls,
    /**
     * ANSWERED, deliberately, even though the wrapper proceeds when it is absent.
     *
     * node-postgres's `Client` has this method and these values (`I` idle, `T` in a
     * transaction, `E` failed); the wrapper's absent-means-proceed branch exists so a fake
     * without it still works, and a fake that USES it is what gives the nesting guard unit
     * coverage instead of leaving it to the live suite alone. `txStatus: null` models a client
     * that has the method and no answer yet, which a fresh connection does.
     */
    getTransactionStatus: () =>
      typeof session === "string" ? "I" : session.txStatus === undefined ? "I" : session.txStatus,
    query: (sql: string, params?: unknown[]) => {
      calls.push(params === undefined ? { sql } : { sql, params });
      if (session === "silent") return Promise.resolve({ rows: [] });
      if (sql === SET_TENANT_CONTEXT_SQL) {
        return Promise.resolve({
          rows: [{ effective_role: session === "no-verdict" ? "ghost_role" : session.role ?? "crm_app" }],
        });
      }
      if (sql === ROLE_PRIVILEGE_SQL) {
        // "no-verdict" models a role the catalog has no row for.
        if (session === "no-verdict") return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ bypasses_rls: session.bypassesRls ?? false }] });
      }
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

  describe("the privilege guard", () => {
    it("refuses a superuser or BYPASSRLS connection, naming the role", async () => {
      const c = fakeClient({ role: "super_a", bypassesRls: true });
      await expect(
        withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never"),
      ).rejects.toThrow(PrivilegedConnectionError);
      // Rolled back, and the callback never ran.
      expect(c.calls.map((x) => x.sql)).toContain("ROLLBACK");
      expect(c.calls.map((x) => x.sql)).not.toContain("COMMIT");
    });

    it("names the role in the message, because the fix is to change it", async () => {
      const c = fakeClient({ role: "super_b", bypassesRls: true });
      await expect(
        withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never"),
      ).rejects.toThrow(/super_b/);
    });

    /**
     * Fail closed on an answer that did not arrive. A guard that treats "no verdict" as
     * a pass is a guard that stops working the moment the statement changes shape.
     */
    it("refuses when the server names no role at all", async () => {
      const c = fakeClient("silent");
      await expect(
        withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never"),
      ).rejects.toThrow(PrivilegedConnectionError);
    });

    /** A role the catalog has no row for is refused, not assumed harmless. */
    it("refuses a role whose attributes it cannot read", async () => {
      const c = fakeClient("no-verdict");
      await expect(
        withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never"),
      ).rejects.toThrow(PrivilegedConnectionError);
    });

    it("admits an unprivileged role", async () => {
      const c = fakeClient({ role: "app_ok", bypassesRls: false });
      await expect(
        withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "ok"),
      ).resolves.toBe("ok");
    });

    /**
     * The catalog lookup is the expensive half (~82 µs against a live cluster), so it
     * happens once per role name and never again. Without this, every transaction in
     * the system would pay for it.
     */
    it("asks the catalog once per role, then never again", async () => {
      const c = fakeClient({ role: "cached_once", bypassesRls: false });
      const T = "11111111-1111-4111-8111-111111111111";
      await withTenantContext(c, T, async () => "a");
      await withTenantContext(c, T, async () => "b");
      await withTenantContext(c, T, async () => "c");
      expect(c.calls.filter((x) => x.sql === ROLE_PRIVILEGE_SQL)).toHaveLength(1);
      // ... while the context itself is set on every one of them.
      expect(c.calls.filter((x) => x.sql === SET_TENANT_CONTEXT_SQL)).toHaveLength(3);
    });

    /**
     * Keyed on the role NAME, not the client: the fixtures in this repo connect as the
     * admin and `SET ROLE crm_app`, so the role a connection runs under changes during
     * its life and a per-client cache would answer for whichever came first.
     */
    it("follows the role rather than the connection", async () => {
      const T = "11111111-1111-4111-8111-111111111111";
      const elevated = fakeClient({ role: "switches_to_super", bypassesRls: true });
      const lowered = fakeClient({ role: "switches_to_app", bypassesRls: false });
      await expect(withTenantContext(elevated, T, async () => "never")).rejects.toThrow(
        PrivilegedConnectionError,
      );
      await expect(withTenantContext(lowered, T, async () => "ok")).resolves.toBe("ok");
    });
  });

  it.each([
    ["not a uuid", "tenant-1"],
    ["the ERP regex's hyphen-only hole", "----------------"],
    ["a single hyphen", "-"],
    ["empty", ""],
    ["sql fragment", "1' OR '1'='1"],
    ["uuid with trailing text", "11111111-1111-4111-8111-111111111111x"],
  ])("refuses %s before opening a transaction", async (_label, bad) => {
    // Checked before the privilege guard, deliberately: a malformed tenant id is
    // reported as one whatever connection it arrives on, and costs no round trip.
    const c = fakeClient({ role: "malformed_probe", bypassesRls: true });
    await expect(withTenantContext(c, bad, async () => "never")).rejects.toThrow(
      InvalidTenantIdError,
    );
    expect(c.calls).toHaveLength(0);
  });

  /**
   * The bug this guard exists for. Without it the `COMMIT` below ends the caller's
   * transaction, their later `ROLLBACK` undoes nothing, and everything they thought was
   * provisional is committed — which is exactly how migration 0051's contract suite silently
   * redecided nineteen retention dispositions while staying green.
   */
  it("refuses a connection already inside a transaction", async () => {
    const c = fakeClient({ txStatus: "T" });
    await expect(
      withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never"),
    ).rejects.toThrow(TransactionAlreadyOpenError);
  });

  /** And issues NOTHING first: a refusal that had already sent BEGIN would be the same bug. */
  it("sends no statement at all when it refuses a nested call", async () => {
    const c = fakeClient({ txStatus: "T" });
    await withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "never").catch(
      () => undefined,
    );
    expect(c.calls).toEqual([]);
  });

  it("names the remedy rather than the symptom", async () => {
    const c = fakeClient({ txStatus: "T" });
    const err = await withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => 1).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("would end YOUR transaction");
    expect((err as Error).message).toContain("move the surrounding work into the callback");
  });

  /**
   * A failed transaction gets its own sentence. Every statement on such a connection is
   * rejected until it is rolled back, so the catalog read for the RLS verdict would be
   * answered by the failure — and the user would be told their role might bypass RLS.
   */
  it("refuses a connection whose transaction has already failed, and says so", async () => {
    const c = fakeClient({ txStatus: "E" });
    const err = await withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => 1).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransactionAlreadyOpenError);
    expect((err as Error).message).toContain("already failed");
    expect((err as Error).message).toContain("ROLLBACK first");
    expect(c.calls).toEqual([]);
  });

  it("proceeds on an idle connection", async () => {
    const c = fakeClient({ txStatus: "I", role: "tx_idle_role" });
    await expect(
      withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "ok"),
    ).resolves.toBe("ok");
    expect(c.calls[0]?.sql).toBe("BEGIN");
  });

  /**
   * A client that has no such method is a fake, not a node-postgres `Client`, so it has no
   * backend and no transaction to clobber. Proceeding is a fail-OPEN branch and is argued in
   * the source; this pins it so a later "tighten this" has to argue back.
   */
  it("proceeds when the client cannot be asked at all", async () => {
    const c = fakeClient({ role: "tx_unaskable_role" });
    delete (c as unknown as { getTransactionStatus?: unknown }).getTransactionStatus;
    await expect(
      withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "ok"),
    ).resolves.toBe("ok");
  });

  /** And when it has the method but no answer yet, which a fresh connection does. */
  it("proceeds when the status is not yet known", async () => {
    const c = fakeClient({ txStatus: null, role: "tx_unknown_role" });
    await expect(
      withTenantContext(c, "11111111-1111-4111-8111-111111111111", async () => "ok"),
    ).resolves.toBe("ok");
  });

  /**
   * Order: the pure check first, so a malformed tenant id is reported as one even on a
   * connection that is also mid-transaction. Two things wrong, and the one the caller can fix
   * without understanding transactions is named.
   */
  it("reports a malformed tenant id ahead of an open transaction", async () => {
    const c = fakeClient({ txStatus: "T" });
    await expect(withTenantContext(c, "not-a-uuid", async () => 1)).rejects.toThrow(
      InvalidTenantIdError,
    );
  });
});
