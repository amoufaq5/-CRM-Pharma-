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

  /**
   * The hole the privilege guard in `withTenantContext` cannot see through.
   *
   * That guard asks which ROLE the statements will run under, which is the right question
   * for a connection and the wrong one for a `SECURITY DEFINER` function: such a function
   * runs as its OWNER, so one owned by a privileged role would read every tenant's rows
   * no matter who called it, and the guard would have said yes. A view without
   * `security_invoker` is the same hole wearing a different hat — RLS is then evaluated
   * against the view's owner.
   *
   * Nothing in `crm` is either today, and both functions in the role model (0023) are
   * deliberately `SECURITY INVOKER` so tenant scoping reaches them. This test is the
   * cheap insurance that keeps it that way: adding one has to be a conscious act that
   * fails this test and makes someone argue for it.
   */
  it("no crm function is SECURITY DEFINER, and no crm view evades its caller's RLS", async () => {
    const { rows: definers } = await client.query<{ name: string }>(`
      SELECT p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'crm' AND p.prosecdef
       ORDER BY p.proname`);
    expect(
      definers.map((r) => r.name),
      "a SECURITY DEFINER function runs as its owner, so RLS is evaluated for the owner, not the caller",
    ).toEqual([]);

    // A view owned by a NON-privileged role is safe either way, because that owner is
    // subject to the policies too — which is why `crm.notification_prune_candidates`
    // scopes correctly (verified live). The check is therefore on the owner, not on
    // security_invoker: the thing that breaks isolation is a privileged owner.
    const { rows: views } = await client.query<{ name: string; owner: string }>(`
      SELECT c.relname AS name, c.relowner::regrole::text AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'crm' AND c.relkind IN ('v', 'm')
         AND (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE oid = c.relowner)
       ORDER BY c.relname`);
    expect(
      views.map((r) => `${r.name} owned by ${r.owner}`),
      "a view owned by a role that bypasses RLS serves every tenant's rows to any caller",
    ).toEqual([]);
  });

  it("an RLS-exempt table holds no tenant data", async () => {
    // The exemption is only defensible while the table stays a registry. If
    // someone adds a column that belongs to a tenant, this fails and the
    // exemption has to be re-argued rather than quietly inherited.
    //
    // IT HAS BEEN RE-ARGUED ONCE, by migration 0050, and the argument is recorded here
    // rather than in the commit that widened the list. 0050 adds the receipt for an ERP
    // tenant deletion — the tombstone id, kind, timestamp, proof hash, chain hash and when
    // we observed it — beside the `status` that the receipt is the only way to reach.
    //
    // Why these belong on the registry: they are facts about whether the TENANT exists at
    // the ERP, which is the same category as `status` and `display_name` and not the same
    // category as a rep, an account, a visit or an amount. No tenant's users can read them:
    // `crm.tenant` is read in exactly three places, all server-side — the scheduler's
    // `activeTenants`, `tenantRegistryStatus`, and a join in `resolvePrincipal` keyed on the
    // caller's OWN tenant_id that surfaces nothing but a 403-or-not decision. No route
    // returns a row from this table.
    //
    // And why the exemption is not materially wider for it: what the exemption costs is
    // cross-tenant visibility, and `display_name` already exposes every tenant's NAME to a
    // connection in any tenant's context. A tombstone id and a sha256 add nothing a
    // deployment operator could not already see, and the status they pair with has to live
    // here regardless, because `WHERE status = 'active'` is the single enumeration point that
    // makes the mark stop every job at once.
    //
    // What would NOT survive this argument: a contact email, a billing amount, a plan name, a
    // seat count — anything belonging to a person or to money. The second assertion below is
    // the cheap guard for exactly that, in the idiom the `service_key` test below uses.
    const ALLOWED_REGISTRY_COLUMNS = new Set([
      "tenant_id",
      "display_name",
      "status",
      "created_at",
      "updated_at",
      "erp_tombstone_id",
      "erp_tombstone_kind",
      "erp_tombstone_deleted_at",
      "erp_tombstone_proof_sha256",
      "erp_tombstone_chain_entry_hash",
      "erp_tombstone_observed_at",
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

      // The allow-list is a list, so it can be extended by anybody willing to type a name.
      // This cannot: a column on an RLS-exempt table whose name belongs to a person, a
      // contact detail or money is the thing the exemption must never cover, and no argument
      // in a comment makes it safe. Adding one has to fail a test that says why.
      for (const name of rows.map((r) => r.attname)) {
        expect(
          name,
          `crm.${table}.${name} is on an RLS-EXEMPT table and reads like personal or financial data, ` +
            `which every tenant's connection could then see`,
        ).not.toMatch(/email|phone|address|contact|person|amount|price|fee|cost|seat|plan|card|iban|salary/i);
      }
    }
  });

  /**
   * A table with no `tenant_id` column escapes the RLS check above entirely — there
   * is nothing for a policy to compare. That is correct for a deployment-level
   * table and catastrophic for one holding tenant data, so the set is enumerated
   * rather than inferred: a new table that forgot its tenant_id fails here instead
   * of serving every tenant's rows to everyone.
   */
  it("only the known deployment-level tables lack a tenant_id", async () => {
    const PLATFORM_WIDE: Readonly<Record<string, string>> = {
      _migrations: "the migration ledger; describes the deployment",
      service_key: "published Ed25519 PUBLIC keys for the ERP service credential; one set signs for every tenant",
    };
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'crm' AND c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       ORDER BY c.relname`);
    expect(rows.map((r) => r.relname)).toEqual(Object.keys(PLATFORM_WIDE).sort());
  });

  it("the key registry holds no private key material", async () => {
    // The API publishes this table and must never be able to sign. A column that
    // could hold a private key would make the separation a convention.
    const { rows } = await client.query<{ attname: string }>(`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'crm' AND c.relname = 'service_key' AND a.attnum > 0 AND NOT a.attisdropped`);
    const names = rows.map((r) => r.attname);
    expect(names).toContain("public_jwk_x");
    for (const name of names) {
      expect(name, `crm.service_key.${name} looks like it could hold a secret`).not.toMatch(
        /private|secret|seed|_d$/i,
      );
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
