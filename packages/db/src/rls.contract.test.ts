import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { testPool, TENANT_A, TENANT_B } from "./testing.js";
import {
  PrivilegedConnectionError,
  TransactionAlreadyOpenError,
  withTenantContext,
} from "./tenant-context.js";

/**
 * Contract tests against a REAL Postgres.
 *
 * These exist because the ERP's own suite does not have them. CrossEngin tests
 * its Postgres modules offline against a fake connection that records
 * `{sql, params}`, and its CLAUDE.md says plainly that this catches SQL *shape*
 * only — "several real defects in this repo were found only by booting a
 * throwaway cluster". Our isolation model rests on runtime behaviour that a fake
 * cannot express, so we assert it here, on every CI run.
 *
 * Each `it` encodes a claim ADR-0001 depends on. If one fails, the ADR is wrong,
 * not the test.
 */
describe("row-level security contract", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();

    // A faithful miniature of the ERP's deployed shape: one shared table,
    // tenant_id, RLS with the ERP's exact policy text.
    //
    // The fixture is owned by a NON-SUPERUSER role on purpose. A superuser
    // bypasses RLS unconditionally — even under FORCE — so a suite that connects
    // as `postgres` and owns its own fixture would show "no isolation" for every
    // case and prove nothing. That is itself a finding, pinned below.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_owner') THEN
          CREATE ROLE rls_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_reader') THEN
          CREATE ROLE rls_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`
      DROP TABLE IF EXISTS rls_fixture;
      CREATE TABLE rls_fixture (
        id        serial PRIMARY KEY,
        tenant_id uuid NOT NULL,
        note      text NOT NULL
      );
      ALTER TABLE rls_fixture ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS rls_fixture_tenant_isolation ON rls_fixture;
      CREATE POLICY rls_fixture_tenant_isolation ON rls_fixture
        USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
      INSERT INTO rls_fixture (tenant_id, note) VALUES
        ('${TENANT_A}', 'a1'), ('${TENANT_A}', 'a2'), ('${TENANT_B}', 'b1');
      ALTER TABLE rls_fixture OWNER TO rls_owner;
      GRANT SELECT ON rls_fixture TO rls_reader;
    `);
  });

  afterAll(async () => {
    await client?.query("RESET ROLE");
    await client?.query("DROP TABLE IF EXISTS rls_fixture");
    client?.release();
    await pool?.end();
  });

  async function countAs(role: string | null, tenantId: string | null): Promise<number> {
    await client.query("BEGIN");
    try {
      if (tenantId !== null) {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      }
      if (role !== null) await client.query(`SET LOCAL ROLE ${role}`);
      const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM rls_fixture");
      return Number(rows[0]?.n ?? -1);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("confines a non-owner role to its own tenant", async () => {
    expect(await countAs("rls_reader", TENANT_A)).toBe(2);
    expect(await countAs("rls_reader", TENANT_B)).toBe(1);
  });

  it("returns NO rows on a PRISTINE connection when tenant context is missing", async () => {
    // current_setting(..., true) yields NULL on a connection that has never had
    // the GUC set, so `tenant_id = NULL` is NULL and the policy admits nothing.
    //
    // A DEDICATED connection is required, not the shared one: once any test in
    // this file has opened a tenant-scoped transaction, the GUC exists on that
    // connection and reverts to '' rather than NULL, which sends the ERP-shaped
    // policy down the raising path instead. That is not a test artefact — it is
    // the production behaviour of a pooled connection, asserted two tests below.
    const fresh = await pool.connect();
    try {
      await fresh.query("SET ROLE rls_reader");
      const { rows } = await fresh.query<{ n: string }>(
        "SELECT count(*) AS n FROM rls_fixture",
      );
      expect(Number(rows[0]?.n)).toBe(0);
    } finally {
      await fresh.query("RESET ROLE");
      fresh.release();
    }
  });

  it("refuses a malformed tenant id before any statement runs", async () => {
    // The guard is in withTenantContext, but the consequence is a database one:
    // a value that slipped through to `::UUID` would raise rather than widen
    // scope, so this is belt and braces on a fail-closed path.
    await expect(withTenantContext(client, "'; DROP TABLE rls_fixture; --", async () => 1))
      .rejects.toThrow(/invalid tenantId/);
    const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM rls_fixture");
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it("LEAKS ACROSS TENANTS for the table owner — the reason crm_app owns no ERP object", async () => {
    // ADR-0001 item 2 and report R16. The owner is not subject to its own policy
    // unless the table is FORCEd. This is why role/ownership separation IS the
    // isolation guarantee for ERP tables, not a stylistic preference.
    expect(await countAs("rls_owner", TENANT_A)).toBe(3);
  });

  it("FORCE ROW LEVEL SECURITY closes the owner bypass — which is why crm.* uses it", async () => {
    // The ERP does not FORCE its tables. We must, because crm_app OWNS crm.*:
    // without FORCE our own application role would read every tenant's CRM rows.
    await client.query("ALTER TABLE rls_fixture FORCE ROW LEVEL SECURITY");
    try {
      expect(await countAs("rls_owner", TENANT_A)).toBe(2);
    } finally {
      await client.query("ALTER TABLE rls_fixture NO FORCE ROW LEVEL SECURITY");
    }
  });

  it("a SUPERUSER bypasses RLS even under FORCE — so the app must never connect as one", async () => {
    // Not a redundant case. FORCE fixes the *owner* bypass but does nothing about
    // a superuser, whose exemption is unconditional. If the CRM ever connects as
    // `postgres` — an easy mistake in a dev compose file that then ships — every
    // policy in this file silently stops applying. `crm_app` is created
    // NOSUPERUSER NOBYPASSRLS for exactly this reason, asserted in
    // schema.contract.test.ts.
    await client.query("ALTER TABLE rls_fixture FORCE ROW LEVEL SECURITY");
    try {
      expect(await countAs(null, TENANT_A)).toBe(3);
    } finally {
      await client.query("ALTER TABLE rls_fixture NO FORCE ROW LEVEL SECURITY");
    }
  });

  /**
   * The consequence of the two cases above, enforced rather than documented.
   *
   * Those tests prove that a superuser sees every tenant's rows. This one proves the
   * application refuses to pretend otherwise: `withTenantContext` asks the server which
   * role the statements will run under and will not proceed on one that is exempt from
   * the policy. Until this existed, `PGUSER=postgres` in a compose file or a CI job
   * turned every policy in the schema off and the only symptom was wider results.
   *
   * Run on the suite's own connection with no SET ROLE, which IS a superuser here — so
   * this is the real refusal, not a simulation of it.
   */
  it("withTenantContext REFUSES a connection that bypasses RLS", async () => {
    await expect(withTenantContext(client, TENANT_A, async () => "never"))
      .rejects.toThrow(PrivilegedConnectionError);
    // And it says which role, because the fix is to change it.
    await expect(withTenantContext(client, TENANT_A, async () => "never"))
      .rejects.toThrow(/postgres/);
  });

  it("admits the same connection once it has SET ROLE to an unprivileged role", async () => {
    // The guard reads `current_user`, which follows SET ROLE — so the fixture pattern
    // used throughout this repo (connect as admin, SET ROLE crm_app) still works, and
    // works for the right reason rather than by being exempt.
    await client.query("SET ROLE rls_reader");
    try {
      await expect(withTenantContext(client, TENANT_A, async () => "ok")).resolves.toBe("ok");
    } finally {
      await client.query("RESET ROLE");
    }
  });

  it("withTenantContext scopes reads and leaves no context behind after commit", async () => {
    await client.query("SET ROLE rls_reader");
    const seen = await withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM rls_fixture");
      return Number(rows[0]?.n);
    });
    await client.query("RESET ROLE");
    expect(seen).toBe(2);

    // is_local => true, so the VALUE dies with the transaction — but the GUC
    // itself now exists on this connection and reverts to its reset value, the
    // EMPTY STRING, not NULL. That distinction is the subject of the next test
    // and the reason crm.* policies wrap the setting in NULLIF.
    const { rows } = await client.query<{ v: string | null }>(
      "SELECT current_setting('app.current_tenant_id', true) AS v",
    );
    expect(rows[0]?.v).toBe("");
  });

  it("the ERP's policy text RAISES on a reused pooled connection; ours returns no rows", async () => {
    // The finding: `tenant_id = current_setting('app.current_tenant_id', true)::UUID`
    // behaves two different ways depending on what the connection did before.
    //   fresh connection      -> current_setting yields NULL -> predicate NULL -> 0 rows
    //   reused after a tenant tx -> yields '' -> ''::UUID -> ERROR
    // Both are fail-closed, neither leaks — but in a connection-pooled server the
    // second is the NORMAL case after the first request, so a forgotten
    // withTenantContext surfaces as `invalid input syntax for type uuid: ""`
    // rather than an empty result. CrossEngin uses the un-guarded form on every
    // tenant-scoped table.
    await client.query(`
      DROP TABLE IF EXISTS erp_policy_probe;
      CREATE TABLE erp_policy_probe (tenant_id uuid NOT NULL);
      INSERT INTO erp_policy_probe VALUES ('${TENANT_A}');
      ALTER TABLE erp_policy_probe ENABLE ROW LEVEL SECURITY;
      CREATE POLICY erp_shape ON erp_policy_probe
        USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);
      ALTER TABLE erp_policy_probe OWNER TO rls_owner;
      GRANT SELECT ON erp_policy_probe TO rls_reader;
    `);
    try {
      // Make the GUC exist on this connection, then let it revert to ''.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
      await client.query("COMMIT");

      await client.query("SET ROLE rls_reader");
      await expect(client.query("SELECT count(*) FROM erp_policy_probe")).rejects.toThrow(
        /invalid input syntax for type uuid/,
      );
      await client.query("RESET ROLE");

      // The crm.* form, with NULLIF, collapses both cases to "no rows".
      await client.query(`
        DROP POLICY erp_shape ON erp_policy_probe;
        CREATE POLICY crm_shape ON erp_policy_probe
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID);
      `);
      await client.query("SET ROLE rls_reader");
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM erp_policy_probe",
      );
      expect(Number(rows[0]?.n)).toBe(0);
    } finally {
      await client.query("RESET ROLE");
      await client.query("DROP TABLE IF EXISTS erp_policy_probe");
    }
  });

  /**
   * The fourth fail-closed check, against a REAL connection — which is the only place it can
   * be proved, because the thing being guarded against is what Postgres does with a nested
   * `BEGIN` and a fake has no Postgres.
   *
   * The bug it closes was found by a test that passed. Migration 0051's contract suite wrapped
   * its mutations in an explicit transaction and rolled back in a `finally`; the `COMMIT`
   * inside `withTenantContext` ended that transaction instead, so the rollback undid nothing
   * and nineteen retention dispositions were silently redecided for every later test.
   */
  describe("a connection already inside a transaction", () => {
    it("is refused, and the caller's transaction is left open and intact", async () => {
      await client.query("SET ROLE rls_reader");
      try {
        await client.query("BEGIN");
        await client.query("CREATE TEMP TABLE tx_guard_probe (x int)");
        await client.query("INSERT INTO tx_guard_probe VALUES (1)");

        await expect(
          withTenantContext(client, TENANT_A, async () => "never"),
        ).rejects.toThrow(TransactionAlreadyOpenError);

        // STILL IN THE TRANSACTION. Before the guard this read 'I': the refused call had
        // already committed everything above.
        expect((client as unknown as { getTransactionStatus(): string }).getTransactionStatus()).toBe(
          "T",
        );

        // And the rollback still means something, which is the whole point.
        await client.query("ROLLBACK");
        await expect(client.query("SELECT * FROM tx_guard_probe")).rejects.toThrow(
          /relation "tx_guard_probe" does not exist/,
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE");
      }
    });

    /**
     * And it refuses BEFORE issuing anything, proved by the one observable that cannot be
     * faked: a connection whose transaction has already FAILED rejects every statement, so if
     * the guard ran a query first the error would come from Postgres rather than from us.
     */
    it("refuses a failed transaction without touching it, naming the rollback", async () => {
      await client.query("SET ROLE rls_reader");
      try {
        await client.query("BEGIN");
        await client.query("SELECT 1/0").catch(() => undefined);
        expect((client as unknown as { getTransactionStatus(): string }).getTransactionStatus()).toBe(
          "E",
        );

        const err = await withTenantContext(client, TENANT_A, async () => 1).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TransactionAlreadyOpenError);
        expect((err as Error).message).toContain("ROLLBACK first");
        // Not a Postgres error about the aborted transaction: our sentence, not theirs.
        expect((err as Error).message).not.toContain("current transaction is aborted");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE");
      }
    });

    /** A plain pool client is idle, so the ordinary path is untouched. */
    it("leaves an idle connection alone", async () => {
      await client.query("SET ROLE rls_reader");
      try {
        expect((client as unknown as { getTransactionStatus(): string }).getTransactionStatus()).toBe(
          "I",
        );
        await expect(withTenantContext(client, TENANT_A, async () => "ok")).resolves.toBe("ok");
      } finally {
        await client.query("RESET ROLE");
      }
    });
  });
});

describe("ERP JSONB store: text-comparison defect (report R19)", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query(`
      DROP TABLE IF EXISTS jsonb_fixture;
      CREATE TABLE jsonb_fixture (document jsonb NOT NULL);
      INSERT INTO jsonb_fixture (document) VALUES
        ('{"sku":"A","total":"999"}'), ('{"sku":"B","total":"1000"}'), ('{"sku":"C","total":"20"}');
    `);
  });

  afterAll(async () => {
    await client?.query("DROP TABLE IF EXISTS jsonb_fixture");
    client?.release();
    await pool?.end();
  });

  /**
   * The ERP's JSONB adapter (operate-runtime-pg/src/entity-ops.ts:43-47) emits
   * `document ->> field` with `castSuffix: () => ""`. The column store emits a
   * real column with `::NUMERIC(p,s)`. These tests pin the consequence so that
   * "read numbers from the snapshot tables, never from the ERP" stays a rule
   * with evidence behind it rather than a remembered warning.
   */
  it("?total[gte]=1000 returns records BELOW the threshold", async () => {
    // Worse than it first looks: "20" >= "1000" is also true in text collation,
    // because "2" > "1". A filter meant to find high-value records returns the
    // lowest one in the table.
    const { rows } = await client.query<{ total: string }>(
      `SELECT document->>'total' AS total FROM jsonb_fixture
        WHERE document->>'total' >= '1000' ORDER BY document->>'total'`,
    );
    expect(rows.map((r) => r.total)).toEqual(["1000", "20", "999"]);
  });

  it("the same predicate is correct once cast, as the column store would", async () => {
    const { rows } = await client.query<{ total: string }>(
      `SELECT document->>'total' AS total FROM jsonb_fixture
        WHERE (document->>'total')::numeric >= 1000`,
    );
    expect(rows.map((r) => r.total)).toEqual(["1000"]);
  });

  it("sorting is lexicographic: 100, 20, 9 rather than 9, 20, 100", async () => {
    const { rows } = await client.query<{ total: string }>(
      `SELECT document->>'total' AS total FROM jsonb_fixture ORDER BY document->>'total'`,
    );
    expect(rows.map((r) => r.total)).toEqual(["1000", "20", "999"]);
  });
});
