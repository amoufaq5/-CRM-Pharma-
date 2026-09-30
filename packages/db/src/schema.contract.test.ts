import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { testPool, TENANT_DB_SCHEMA_A as TENANT_A, TENANT_DB_SCHEMA_B as TENANT_B } from "./testing.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * Invariants of the deployed CRM schema, asserted against a real database.
 *
 * ADR-0001 item 2 promises "CI asserts crm_app owns no ERP object". This is that
 * assertion. Everything here is a property the design depends on and that a
 * careless migration could silently remove.
 */
describe("CRM schema invariants", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  /**
   * Tables carrying a `tenant_id` that are deliberately NOT tenant-scoped.
   *
   * Adding to this list must be a conscious act, visible in a diff, and each
   * entry needs a reason that survives review — which is why the list is
   * explicit rather than a structural rule like "exempt when tenant_id is the
   * primary key". A rule that clever would silently exempt a real data table
   * someone happened to key that way.
   */
  const RLS_EXEMPT: Readonly<Record<string, string>> = {
    // The registry of which tenants exist. RLS here would be circular: reading
    // which tenants exist would require having already chosen one. Holds ids,
    // a display name and scheduling config — nothing a tenant would call theirs,
    // which the next test enforces.
    tenant: "the tenant registry itself; RLS would be circular",
  };

  it("every tenant-scoped crm table has RLS ENABLED and FORCED", async () => {
    const { rows } = await client.query<{
      relname: string;
      rls: boolean;
      forced: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'crm' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       ORDER BY c.relname`);

    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      if (t.relname in RLS_EXEMPT) continue;
      expect(t.rls, `${t.relname} must ENABLE ROW LEVEL SECURITY`).toBe(true);
      // FORCE is the one that matters here: crm_app OWNS these tables, and an
      // owner is exempt from a policy it is not forced under.
      expect(t.forced, `${t.relname} must FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it("an RLS-exempt table holds no tenant data", async () => {
    // The exemption is only defensible while the table stays a registry. If
    // someone adds a column that belongs to a tenant, this fails and the
    // exemption has to be re-argued rather than quietly inherited.
    const ALLOWED_REGISTRY_COLUMNS = new Set([
      "tenant_id",
      "display_name",
      "status",
      "created_at",
      "updated_at",
    ]);
    for (const table of Object.keys(RLS_EXEMPT)) {
      const { rows } = await client.query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crm' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
        [table],
      );
      const unexpected = rows.map((r) => r.attname).filter((c) => !ALLOWED_REGISTRY_COLUMNS.has(c));
      expect(unexpected, `crm.${table} is RLS-exempt (${RLS_EXEMPT[table]}) and must stay a registry`).toEqual([]);
    }
  });

  it("crm_app owns NO object in the ERP's meta schema", async () => {
    // The single most dangerous thing that could regress. An owner bypasses RLS,
    // so crm_app owning an ERP table is a silent cross-tenant read of ERP data.
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'meta' AND pg_get_userbyid(c.relowner) = 'crm_app'`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("crm_app holds SELECT and nothing else on the ERP", async () => {
    const { rows } = await client.query<{ privilege_type: string }>(`
      SELECT DISTINCT privilege_type FROM information_schema.table_privileges
       WHERE grantee = 'crm_app' AND table_schema = 'meta' ORDER BY 1`);
    expect(rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
  });

  it("crm_app cannot escalate past RLS", async () => {
    const { rows } = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
          FROM pg_roles WHERE rolname = 'crm_app'`);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it("the migration runner can write its own ledger as crm_app", async () => {
    // Regression test for a real defect: 0002 is the DBA step, so crm._migrations
    // was created owned by the DBA role and every migration after it failed with
    // `permission denied for table _migrations`.
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE crm_app");
      await client.query(
        "INSERT INTO crm._migrations (filename, sha256) VALUES ($1, $2)",
        ["9999_probe.sql", "a".repeat(64)],
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("the erp_record_id domain refuses a malformed ERP id", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE crm_app");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
      await expect(
        client.query(
          `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, erp_employee_id, display_name)
           VALUES ($1, 's', 'E1', $2, 'R')`,
          [TENANT_A, "not a valid id!"],
        ),
      ).rejects.toThrow(/erp_record_id_shape|violates check constraint/);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

describe("CRM tables are tenant-isolated in practice", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    for (const [tenant, subject] of [
      [TENANT_A, "sub-a"],
      [TENANT_B, "sub-b"],
    ] as const) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [tenant, subject, `EMP-${subject}`, subject],
        );
      });
    }
  });

  afterAll(async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  it("a tenant sees only its own reps, even as the table owner", async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      const n = await withTenantContext(client, tenant, async (tx) => {
        const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM crm.rep_profile");
        return Number(rows[0]?.n);
      });
      expect(n).toBe(1);
    }
  });

  it("a write cannot smuggle a row into another tenant", async () => {
    // The policy has no WITH CHECK clause, so USING governs writes too: inserting
    // a row whose tenant_id differs from the context is refused rather than
    // silently accepted and then invisible.
    await expect(
      withTenantContext(client, TENANT_A, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
           VALUES ($1, 'smuggled', 'EMP-X', 'X')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});
