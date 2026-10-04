import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { appPool, TENANT_CREDENTIAL_A as TENANT_A, TENANT_CREDENTIAL_B as TENANT_B } from "@crm/db/testing";
import { InvalidTenantIdError, withTenantContext } from "@crm/db";

import { PostgresServiceRoleSource, ServiceRoleUnavailableError } from "./role-source.js";

/**
 * `crm.erp_service_principal` against a real Postgres.
 *
 * The CHECK constraints here are the interesting part: they encode what the ERP
 * would silently do with a bad value, and a fake connection cannot enforce a CHECK.
 *
 * `appPool()`, because this pool is handed to `PostgresServiceRoleSource`, which opens
 * its own connections and inherits the pool's role. It used to be the admin pool, so
 * every query in this suite ran as a superuser and row-level security did not apply —
 * which made the assertion below that each tenant "never" sees the other's role a claim
 * about a `WHERE` clause, not about isolation. The fixture writes through
 * `withTenantContext` for the same reason: a seed that inserts with no tenant context is
 * a seed only a privileged connection can perform.
 */
describe("the per-tenant ERP service role", () => {
  let pool: Pool;
  let fixture: PoolClient;

  const seed = (
    tenantId: string,
    role: string,
    opts: { subject?: string | null; enabled?: boolean } = {},
  ): Promise<unknown> =>
    withTenantContext(fixture, tenantId, (tx) =>
      tx.query(
        `INSERT INTO crm.erp_service_principal (tenant_id, erp_role, subject, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET erp_role = $2, subject = $3, enabled = $4`,
        [tenantId, role, opts.subject ?? null, opts.enabled ?? true],
      ),
    );

  const clear = async (): Promise<void> => {
    for (const t of [TENANT_A, TENANT_B]) {
      await withTenantContext(fixture, t, (tx) =>
        tx.query("DELETE FROM crm.erp_service_principal WHERE tenant_id = $1", [t]),
      );
    }
  };

  beforeAll(async () => {
    pool = appPool();
    fixture = await pool.connect();
  });

  afterAll(async () => {
    await clear();
    fixture?.release();
    await pool?.end();
  });

  beforeEach(clear);

  it("reads the role configured for a tenant", async () => {
    await seed(TENANT_A, "controller");
    const source = new PostgresServiceRoleSource({ pool });
    expect(await source.roleFor(TENANT_A)).toEqual({ role: "controller", subject: null });
  });

  it("returns each tenant its own role and never the other's", async () => {
    await seed(TENANT_A, "controller");
    await seed(TENANT_B, "erp_accountant");
    const source = new PostgresServiceRoleSource({ pool });
    expect((await source.roleFor(TENANT_A)).role).toBe("controller");
    expect((await source.roleFor(TENANT_B)).role).toBe("erp_accountant");
  });

  it("carries a subject override when one is set", async () => {
    await seed(TENANT_A, "controller", { subject: "crm-eu-west" });
    const source = new PostgresServiceRoleSource({ pool });
    expect((await source.roleFor(TENANT_A)).subject).toBe("crm-eu-west");
  });

  /**
   * No default role, and this is the test that keeps it that way. A tenant nobody
   * configured must not get a token — and specifically must not inherit `controller`,
   * which can post to the general ledger.
   */
  it("refuses a tenant with no row", async () => {
    const source = new PostgresServiceRoleSource({ pool });
    await expect(source.roleFor(TENANT_A)).rejects.toThrow(ServiceRoleUnavailableError);
    await expect(source.roleFor(TENANT_A)).rejects.toThrow(/no crm.erp_service_principal row/);
  });

  it("refuses a disabled tenant, which is how a credential is revoked", async () => {
    await seed(TENANT_A, "controller", { enabled: false });
    const source = new PostgresServiceRoleSource({ pool });
    await expect(source.roleFor(TENANT_A)).rejects.toThrow(/the row is disabled/);
  });

  it("rejects a malformed tenant id before it touches the database", async () => {
    const source = new PostgresServiceRoleSource({ pool });
    await expect(source.roleFor("not-a-uuid")).rejects.toThrow(InvalidTenantIdError);
  });

  describe("the role CHECK constraint", () => {
    /**
     * The constraint that matters most. The ERP splits `scope` on spaces and takes
     * only the FIRST entry as the principal's role, so 'sales_rep controller' grants
     * sales_rep and silently discards the rest — a row that reads like deliberate
     * least privilege and does something else. The database refuses it.
     */
    it("refuses a role containing a space", async () => {
      await expect(seed(TENANT_A, "sales_rep controller")).rejects.toThrow(/erp_role/);
    });

    it("refuses an empty role and one with uppercase or punctuation", async () => {
      await expect(seed(TENANT_A, "")).rejects.toThrow(/erp_role/);
      await expect(seed(TENANT_A, "Controller")).rejects.toThrow(/erp_role/);
      await expect(seed(TENANT_A, "controller;drop")).rejects.toThrow(/erp_role/);
    });

    it("accepts the role names the core pack actually declares", async () => {
      for (const role of ["controller", "erp_accountant", "sales_rep", "ap_clerk"]) {
        await seed(TENANT_A, role);
        expect((await new PostgresServiceRoleSource({ pool }).roleFor(TENANT_A)).role).toBe(role);
      }
    });
  });

  describe("caching", () => {
    it("reuses a resolved role within the TTL", async () => {
      await seed(TENANT_A, "controller");
      let now = 1_000_000;
      const source = new PostgresServiceRoleSource({ pool, cacheTtlMs: 60_000, now: () => now });
      expect((await source.roleFor(TENANT_A)).role).toBe("controller");

      await seed(TENANT_A, "sales_rep");
      expect((await source.roleFor(TENANT_A)).role).toBe("controller"); // still cached

      now += 60_001;
      expect((await source.roleFor(TENANT_A)).role).toBe("sales_rep");
    });

    /**
     * Only successes are cached. A stale "no" would keep a tenant broken for a TTL
     * after someone fixed the configuration, and the usual way this is discovered is
     * an operator adding the row, seeing nothing change, and adding it again.
     */
    it("does not cache a refusal", async () => {
      const source = new PostgresServiceRoleSource({ pool, cacheTtlMs: 600_000 });
      await expect(source.roleFor(TENANT_A)).rejects.toThrow(ServiceRoleUnavailableError);
      await seed(TENANT_A, "controller");
      expect((await source.roleFor(TENANT_A)).role).toBe("controller");
    });

    it("can be invalidated per tenant and wholesale", async () => {
      await seed(TENANT_A, "controller");
      await seed(TENANT_B, "controller");
      const source = new PostgresServiceRoleSource({ pool, cacheTtlMs: 600_000 });
      await source.roleFor(TENANT_A);
      await source.roleFor(TENANT_B);

      await seed(TENANT_A, "sales_rep");
      await seed(TENANT_B, "sales_rep");
      source.invalidate(TENANT_A);
      expect((await source.roleFor(TENANT_A)).role).toBe("sales_rep");
      expect((await source.roleFor(TENANT_B)).role).toBe("controller");

      source.invalidate();
      expect((await source.roleFor(TENANT_B)).role).toBe("sales_rep");
    });
  });
});
