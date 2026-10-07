import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_ERASURE_LIVE as LIVE,
  TENANT_ERASURE_STOPPED as STOPPED,
  appPool,
  withRegistryTriggersOff,
} from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import { RETENTION_OBLIGATIONS } from "./obligations.js";
import { planTenantErasure } from "./plan.js";

/**
 * The disposition register and the plan, against a real Postgres (migration 0051).
 *
 * The centre of this file is one property, and it is the only one that makes the rest worth
 * anything: EVERY tenant-scoped table has a decision. CrossEngin's ADR-0317 found out the
 * expensive way what happens without it — "It was a subsystem nobody asked, whose silence read
 * as nothing to delete" — so the completeness test is derived from `pg_catalog` and never from
 * a list, and a migration that adds a tenant-scoped table without a disposition fails here on
 * the day it lands.
 */
describe("retention dispositions and the erasure plan (0051)", () => {
  let pool: Pool;
  let client: PoolClient;

  const TOMB = "tomb_0123456789abcdef0123456789abcdef";

  const register = async (tenantId: string, name: string): Promise<void> => {
    await client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, name],
    );
  };

  const stop = (tenantId: string): Promise<unknown> =>
    client.query(
      `UPDATE crm.tenant
          SET status = 'erp_deleted', erp_tombstone_id = $2, erp_tombstone_kind = 'tenant_deletion',
              erp_tombstone_deleted_at = now(), erp_tombstone_proof_sha256 = $3,
              erp_tombstone_observed_at = now()
        WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
      [tenantId, TOMB, "a".repeat(64)],
    );

  /**
   * Mutates the register, runs `fn`, and puts every row back exactly as it was.
   *
   * NOT `BEGIN` / `ROLLBACK`, and the reason is a sharp edge this file found the hard way.
   * `withTenantContext` issues a bare `BEGIN` and a bare `COMMIT`; Postgres makes a `BEGIN`
   * inside an open transaction a no-op with a warning, so the inner `COMMIT` commits the
   * CALLER'S transaction. The first version of this file wrapped these tests in an explicit
   * transaction and the `ROLLBACK` in its `finally` had nothing left to roll back — the
   * mutation was already committed, and it silently redecided all nineteen undecided tables
   * for every test that ran afterwards. `planTenantErasure` counts rows through
   * `withTenantContext`, so no test that calls it can use an outer transaction for isolation.
   *
   * Snapshot and restore instead: explicit, obvious, and it cannot be defeated by what the
   * code under test does with transactions.
   */
  /**
   * Mutates the register, runs `fn`, and puts every row back exactly as it was.
   *
   * NOT `BEGIN` / `ROLLBACK` around `fn`, and the reason is the sharp edge this file found.
   * `withTenantContext` issued a bare `BEGIN` and a bare `COMMIT`; Postgres makes a `BEGIN`
   * inside an open transaction a no-op with a warning, so the inner `COMMIT` committed the
   * CALLER'S transaction. The first version of this file wrapped these tests in an explicit
   * transaction and the `ROLLBACK` in its `finally` had nothing left to roll back — the
   * mutation was already committed, and it silently redecided all nineteen undecided tables
   * for every test that ran afterwards.
   *
   * `withTenantContext` now REFUSES that, with `TransactionAlreadyOpenError`, so the trap is
   * loud rather than silent — but `planTenantErasure` counts rows through it, so a test that
   * called it inside an outer transaction would now fail instead of lying. Snapshot and restore
   * either way: it is what this needs, and it cannot be defeated by what the code under test
   * does with transactions.
   */
  const aroundRegister = async <T>(mutate: string, fn: () => Promise<T>): Promise<T> => {
    await client.query("DROP TABLE IF EXISTS _dd_backup");
    await client.query("CREATE TEMP TABLE _dd_backup AS SELECT * FROM crm.data_disposition");
    try {
      await client.query(mutate);
      return await fn();
    } finally {
      // ONE transaction and a server-side copy, which the first version of this helper was
      // not: it read the rows into JavaScript and re-inserted them one statement at a time,
      // and the first time one of those inserts was refused the loop threw and left the
      // register with the remaining rows simply missing. A restore that can half-apply is
      // worse than no restore, because it corrupts the completeness property every other test
      // in this file depends on — and it did, silently, until a mutation run showed eight
      // tables undeclared instead of one. No `withTenantContext` runs in here, so an explicit
      // transaction is safe: the hazard documented above is about the code under test.
      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM crm.data_disposition");
        await client.query("INSERT INTO crm.data_disposition SELECT * FROM _dd_backup");
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      await client.query("DROP TABLE IF EXISTS _dd_backup");
    }
  };

  const refusal = async (sql: string, params: readonly unknown[] = []): Promise<string> => {
    try {
      await client.query(sql, [...params]);
    } catch (err) {
      return (err as { message?: string }).message ?? String(err);
    }
    throw new Error(`expected a refusal: ${sql}`);
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    for (const t of [STOPPED, LIVE]) {
      await withTenantContext(client, t, (tx) =>
        tx.query("DELETE FROM crm.product_snapshot WHERE tenant_id = $1", [t]),
      );
    }
    await withRegistryTriggersOff(client, () =>
      client.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1)", [[STOPPED, LIVE]]),
    );
    client?.release();
    await pool?.end();
  });

  /**
   * Rows as well as registry entries, and the rows go first.
   *
   * Inside a tenant context per tenant, necessarily: `crm.product_snapshot` is tenant-scoped
   * under FORCE row-level security, so a DELETE without one matches nothing and reports
   * success. The first version of this file cleaned only `crm.tenant` and a later test read the
   * three snapshot rows an earlier one had inserted — a count test passing or failing on which
   * order the suite ran in.
   */
  beforeEach(async () => {
    for (const t of [STOPPED, LIVE]) {
      await withTenantContext(client, t, (tx) =>
        tx.query("DELETE FROM crm.product_snapshot WHERE tenant_id = $1", [t]),
      );
    }
    await withRegistryTriggersOff(client, () =>
      client.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1)", [[STOPPED, LIVE]]),
    );
    await register(LIVE, "Still Trading");
  });

  // -------------------------------------------------------------------------
  // Completeness. The only property that matters.
  // -------------------------------------------------------------------------
  /**
   * Silence is not "none". Derived from the catalog, so a table added next month by someone who
   * has never read this file fails here rather than surviving an erasure nobody noticed.
   */
  it("has a disposition for every tenant-scoped table", async () => {
    const { rows } = await client.query<{ t: string }>("SELECT t FROM crm.undeclared_tenant_tables() AS t");
    expect(
      rows.map((r) => r.t),
      "tenant-scoped tables with no row in crm.data_disposition — silence is not 'none'",
    ).toEqual([]);
  });

  it("names no table that does not exist", async () => {
    const { rows } = await client.query<{ t: string }>("SELECT t FROM crm.disposition_orphans() AS t");
    expect(rows.map((r) => r.t), "register rows whose table has been dropped").toEqual([]);
  });

  /** And the count agrees both ways, so neither side can drift without the other noticing. */
  it("has exactly as many rows as there are tenant-scoped tables", async () => {
    const { rows } = await client.query<{ tables: string; declared: string }>(`
      SELECT (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'crm' AND c.relkind = 'r'
                 AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                              AND a.attname = 'tenant_id' AND NOT a.attisdropped)) AS tables,
             (SELECT count(*)::text FROM crm.data_disposition) AS declared`);
    expect(rows[0]!.declared).toBe(rows[0]!.tables);
  });

  it("uses only obligations the vocabulary declares, and never `none` as a basis", async () => {
    const { rows } = await client.query<{ obligation: string; disposition: string }>(
      "SELECT obligation, disposition FROM crm.data_disposition WHERE obligation IS NOT NULL",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(RETENTION_OBLIGATIONS as readonly string[]).toContain(r.obligation);
      expect(r.obligation).not.toBe("none");
      expect(r.disposition).toBe("retain");
    }
  });

  /** The SQL vocabulary and the TypeScript one are the same list. */
  it("declares the same obligations in SQL as in TypeScript", async () => {
    const { rows } = await client.query<{ codes: string[] }>(
      "SELECT crm.retention_obligations() AS codes",
    );
    expect([...rows[0]!.codes].sort()).toEqual([...RETENTION_OBLIGATIONS].sort());
  });

  /** Every undecided row says what has to be answered. */
  it("gives every undecided table a question", async () => {
    const { rows } = await client.query<{ table_name: string; question: string }>(
      "SELECT table_name, question FROM crm.undecided_dispositions()",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.question.length).toBeGreaterThan(10);
  });

  // -------------------------------------------------------------------------
  // What the register refuses.
  // -------------------------------------------------------------------------
  it("refuses a row naming a table that does not exist", async () => {
    const msg = await refusal(
      "INSERT INTO crm.data_disposition (table_name, disposition, question) VALUES ('vist','undecided','a question long enough to pass')",
    );
    expect(msg).toMatch(/^data-disposition-unknown-table: /);
    expect(msg).toContain("crm.vist");
  });

  /** A table with no tenant_id has no tenant owning its rows, so a disposition is meaningless. */
  it("refuses a row naming a table that is not tenant-scoped", async () => {
    const msg = await refusal(
      "INSERT INTO crm.data_disposition (table_name, disposition, question) VALUES ('service_key','undecided','a question long enough to pass')",
    );
    expect(msg).toMatch(/^data-disposition-not-tenant-scoped: /);
  });

  it("refuses a retain with no lawful basis", async () => {
    const msg = await refusal(
      "UPDATE crm.data_disposition SET disposition = 'retain' WHERE table_name = 'product_snapshot'",
    );
    expect(msg).toContain("data_disposition_retain_has_basis");
  });

  it("refuses `none` as a retain basis, though it is in the vocabulary", async () => {
    const msg = await refusal(
      `UPDATE crm.data_disposition
          SET disposition = 'retain', obligation = 'none',
              obligation_note = 'a note long enough to satisfy the length check',
              retained_reference = 'somewhere', decided_by = 'test', decided_at = now()
        WHERE table_name = 'product_snapshot'`,
    );
    expect(msg).toContain("data_disposition_retain_has_basis");
  });

  it("refuses an erase that carries a lawful basis", async () => {
    const msg = await refusal(
      "UPDATE crm.data_disposition SET obligation = 'tax_records_7y' WHERE table_name = 'product_snapshot'",
    );
    expect(msg).toContain("data_disposition_erase_has_no_basis");
  });

  it("refuses an undecided with no question", async () => {
    const msg = await refusal(
      "UPDATE crm.data_disposition SET question = NULL WHERE table_name = 'visit'",
    );
    expect(msg).toContain("data_disposition_undecided_has_a_question");
  });

  it("refuses an undecided that claims a decider", async () => {
    const msg = await refusal(
      "UPDATE crm.data_disposition SET decided_by = 'somebody' WHERE table_name = 'visit'",
    );
    expect(msg).toContain("data_disposition_undecided_has_a_question");
  });

  it("refuses an obligation outside the vocabulary", async () => {
    const msg = await refusal(
      `UPDATE crm.data_disposition
          SET disposition = 'retain', obligation = 'because_we_feel_like_it',
              obligation_note = 'a note long enough to satisfy the length check',
              retained_reference = 'somewhere', decided_by = 'test', decided_at = now()
        WHERE table_name = 'product_snapshot'`,
    );
    expect(msg).toContain("data_disposition_obligation_check");
  });

  // -------------------------------------------------------------------------
  // The plan.
  // -------------------------------------------------------------------------
  it("is advisory, not actionable, for a tenant the ERP has not deleted", async () => {
    const plan = await planTenantErasure(client, LIVE);
    expect(plan.actionable).toBe(false);
    expect(plan.refusals.map((r) => r.kind)).toContain("not_stopped");
    expect(plan.tenantStatus).toBe("active");
    expect(plan.tombstoneId).toBeNull();
  });

  it("is still not actionable for a stopped tenant while anything is undecided", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    const plan = await planTenantErasure(client, STOPPED);
    expect(plan.actionable).toBe(false);
    expect(plan.refusals.map((r) => r.kind)).toEqual(["undecided"]);
    expect(plan.tombstoneId).toBe(TOMB);
  });

  /**
   * And it becomes actionable once both hold — asserted inside a transaction that rolls back,
   * because deciding nineteen tables for real is Compliance's job and not a test's. This is the
   * one test that proves the refusals are the ONLY thing standing in the way, rather than the
   * plan being permanently unable to say yes.
   */
  it("is actionable for a stopped tenant once every table is decided", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    // `expense_claim` is switched too, and that is forced rather than chosen: its shipped
    // disposition is `retain` and it references `rep_profile`, so deciding only the undecided
    // ones leaves a retained child of an erased parent — which 0052's
    // `retained_child_of_erased` refusal catches. The guard being right, not the fixture being
    // clever; `execute.contract.test.ts` has the same note and a test for the other direction.
    await aroundRegister(
      `UPDATE crm.data_disposition
          SET disposition = 'erase', question = NULL, obligation = NULL, obligation_note = NULL,
              retained_reference = NULL, decided_by = 'test', decided_at = now()
        WHERE disposition = 'undecided' OR table_name = 'expense_claim'`,
      async () => {
        const plan = await planTenantErasure(client, STOPPED);
        expect(plan.refusals).toEqual([]);
        expect(plan.actionable).toBe(true);
        // Derived, not a literal: 0052 added two tables and this read 39 until it did — and
        // 0054 then took those same two OUT of a receipt's scope, because they are the receipt.
        const { rows } = await client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM crm.data_disposition WHERE NOT is_receipt_store",
        );
        expect(plan.erase.length + plan.retain.length).toBe(Number(rows[0]!.n));
        // And the order covers every table it will erase, children first.
        expect([...plan.eraseOrder].sort()).toEqual(plan.erase.map((t) => t.table).sort());
      },
    );
    // And the register is exactly as it was: nineteen still undecided.
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM crm.data_disposition WHERE disposition = 'undecided'",
    );
    expect(rows[0]!.n).toBe("19");
  });

  it("counts real rows, in one snapshot", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    await withTenantContext(client, STOPPED, (tx) =>
      tx.query(
        `INSERT INTO crm.product_snapshot (tenant_id, erp_item_id, sku, name, list_price, currency, synced_at)
         SELECT $1, 'item-' || g, 'SKU' || g, 'Product ' || g, 1.00, 'USD', now() FROM generate_series(1,3) g`,
        [STOPPED],
      ),
    );
    const plan = await planTenantErasure(client, STOPPED);
    expect(plan.erase.find((t) => t.table === "product_snapshot")?.rows).toBe(3);
    // The registry row itself is one of the retained tables, and it is there.
    expect(plan.retain.find((t) => t.table === "tenant")?.rows).toBe(1);
    expect(plan.eraseRows).toBe(3);
  });

  /** Per tenant: the other tenant's rows are not in this tenant's plan. */
  it("counts only the tenant it was asked about", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    await withTenantContext(client, LIVE, (tx) =>
      tx.query(
        `INSERT INTO crm.product_snapshot (tenant_id, erp_item_id, sku, name, list_price, currency, synced_at)
         VALUES ($1,'item-live','SKUL','Live Product',1.00,'USD',now())`,
        [LIVE],
      ),
    );
    const plan = await planTenantErasure(client, STOPPED);
    expect(plan.erase.find((t) => t.table === "product_snapshot")?.rows).toBe(0);
  });

  /**
   * An undecided table is NOT counted. Putting "crm.visit: 4,312 rows" in front of somebody
   * invites the decision this register exists to collect from a lawyer.
   */
  it("does not count an undecided table", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    const plan = await planTenantErasure(client, STOPPED);
    const named = [...plan.erase, ...plan.retain].map((t) => t.table);
    expect(named).not.toContain("visit");
    expect(named).not.toContain("sample_transaction");
    // Derived from the register rather than a literal, which 0052's two new tables broke and
    // 0054 changed again by excluding them from scope.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM crm.data_disposition
        WHERE disposition <> 'undecided' AND NOT is_receipt_store`,
    );
    expect(named).toHaveLength(Number(rows[0]!.n));
  });

  it("carries the obligation and where the data stays, for every retained table", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    const plan = await planTenantErasure(client, STOPPED);
    expect(plan.retain.length).toBeGreaterThan(0);
    for (const t of plan.retain) {
      expect(t.obligation, t.table).toBeDefined();
      expect(t.obligationNote, t.table).toBeDefined();
      expect(t.retainedReference, t.table).toBeDefined();
    }
    expect(plan.retain.find((t) => t.table === "expense_claim")?.obligation).toBe(
      "financial_transactions_7y",
    );
  });

  it("carries no obligation on anything it would erase", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    const plan = await planTenantErasure(client, STOPPED);
    for (const t of plan.erase) {
      expect(t.obligation, t.table).toBeUndefined();
      expect(t.retainedReference, t.table).toBeUndefined();
    }
  });

  /** An undeclared table refuses the plan, proved by hiding a register row inside a rollback. */
  it("refuses the plan when a tenant-scoped table has no disposition", async () => {
    await register(STOPPED, "Gone");
    await stop(STOPPED);
    await aroundRegister("DELETE FROM crm.data_disposition WHERE table_name = 'visit'", async () => {
      const plan = await planTenantErasure(client, STOPPED);
      const undeclared = plan.refusals.find((r) => r.kind === "undeclared");
      expect(undeclared).toBeDefined();
      if (undeclared?.kind !== "undeclared") throw new Error("unreachable");
      expect(undeclared.tables).toEqual(["visit"]);
    });
    // Restored, so the completeness test above still means something.
    const { rows } = await client.query<{ t: string }>("SELECT t FROM crm.undeclared_tenant_tables() AS t");
    expect(rows).toEqual([]);
  });
});
