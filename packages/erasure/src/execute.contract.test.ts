import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_ERASE_BYSTANDER as BYSTANDER,
  TENANT_ERASE_EXEC as DOOMED,
  appPool,
  withRegistryTriggersOff,
} from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import { ErasureRefusedError, executeTenantErasure, readTenantTombstones } from "./execute.js";
import { planTenantErasure } from "./plan.js";
import { verifyTombstone } from "./tombstone.js";

/**
 * The executor, against a real Postgres (migration 0052). It really deletes.
 *
 * Everything here needs the real thing. The delete order is computed from `pg_catalog`; the
 * atomicity is a transaction; the append-only rule, the four-eyes CHECK and the
 * "only for a deleted tenant" trigger are all database refusals; and the figures the hash
 * commits to are `rowCount`s from statements that ran.
 *
 * The register ships with 19 tables `undecided`, so a real plan is never actionable — which is
 * correct and is the point. These tests decide them inside a snapshot that is restored
 * afterwards, which is legitimate: the code path is fully exercised, just not against
 * production's current answers.
 */
describe("the erasure executor and its receipt (0052)", () => {
  let pool: Pool;
  let client: PoolClient;

  const TOMB = "tomb_0123456789abcdef0123456789abcdef";
  const SHA = "a".repeat(64);
  const ALICE = "ops:alice";
  const BOB = "compliance:bob";

  /** Tables this suite writes into, cleaned per test inside a tenant context. */
  const SEEDED = [
    "product_snapshot",
    "rep_profile",
    "visit",
    "visit_product",
    "expense_claim",
    "territory",
    "territory_assignment",
    "account_assignment",
  ];

  const register = (tenantId: string, name: string): Promise<unknown> =>
    client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, name],
    );

  const stop = (tenantId: string): Promise<unknown> =>
    client.query(
      `UPDATE crm.tenant
          SET status = 'erp_deleted', erp_tombstone_id = $2, erp_tombstone_kind = 'tenant_deletion',
              erp_tombstone_deleted_at = now(), erp_tombstone_proof_sha256 = $3,
              erp_tombstone_observed_at = now()
        WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
      [tenantId, TOMB, SHA],
    );

  /**
   * Decides every `undecided` table as `erase`, runs `fn`, and restores the register atomically.
   *
   * `expense_claim` IS ALSO SWITCHED TO ERASE, and that is not the fixture being clever — it is
   * the fixture being forced. Its shipped disposition is `retain`, and it references
   * `rep_profile`, so "decide everything undecided as erase" produces an INCOHERENT register:
   * a retained child of an erased parent, which the plan refuses. Discovered by writing this
   * helper the obvious way and watching the guard fire. The retain path is exercised by its own
   * test below, which retains `rep_profile` instead — the other coherent answer.
   *
   * 0051's restore shape and its reasoning: no outer transaction around `fn`, because
   * `withTenantContext` refuses a client already inside one — which is exactly what the
   * executor relies on for its atomicity.
   */
  const withEverythingDecided = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query("DROP TABLE IF EXISTS _dd_backup");
    await client.query("CREATE TEMP TABLE _dd_backup AS SELECT * FROM crm.data_disposition");
    try {
      await client.query(
        `UPDATE crm.data_disposition
            SET disposition = 'erase', question = NULL, obligation = NULL, obligation_note = NULL,
                retained_reference = NULL, decided_by = 'test', decided_at = now()
          WHERE disposition = 'undecided' OR table_name = 'expense_claim'`,
      );
      return await fn();
    } finally {
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

  /** A rep, a visit with a product line, an expense claim and three snapshot rows. */
  const seed = async (tenantId: string): Promise<void> => {
    await withTenantContext(client, tenantId, async (tx) => {
      const { rows: reps } = await tx.query<{ id: string }>(
        // `$1` cannot be both a uuid and text in one statement — Postgres deduces one type per
        // parameter — so the subject is bound separately.
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1, $2, 'E1', 'A Rep') RETURNING id`,
        [tenantId, `idp|${tenantId}`],
      );
      const rep = reps[0]!.id;
      await tx.query(
        `INSERT INTO crm.product_snapshot (tenant_id, erp_item_id, sku, name, list_price, currency, synced_at)
         SELECT $1, 'item-' || g, 'SKU' || g, 'P' || g, 1.00, 'USD', now() FROM generate_series(1,3) g`,
        [tenantId],
      );
      // A visit needs real territory coverage: `crm.visit_check_territory` refuses one outside
      // the rep's territory, which is 0010's rule and not something a fixture may shortcut.
      // Seeding it properly also puts `crm.territory` — the parent of two more tables — into
      // the erase graph, so the delete order has something to get wrong.
      const { rows: terrs } = await tx.query<{ id: string }>(
        `INSERT INTO crm.territory (tenant_id, code, name) VALUES ($1,'T1','Territory One')
         RETURNING id`,
        [tenantId],
      );
      const territory = terrs[0]!.id;
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary',CURRENT_DATE - 30)`,
        [tenantId, territory, rep],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
         VALUES ($1,'acct-1',$2,CURRENT_DATE - 30)`,
        [tenantId, territory],
      );
      // `crm.visit.id` has NO default, deliberately: a visit's id is minted on the device so an
      // offline create can be replayed idempotently. A fixture has to supply one too.
      const { rows: visits } = await tx.query<{ id: string }>(
        `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, planned_for)
         VALUES (gen_random_uuid(),$1,$2,'acct-1','planned',CURRENT_DATE) RETURNING id`,
        [tenantId, rep],
      );
      await tx.query(
        `INSERT INTO crm.visit_product (tenant_id, visit_id, erp_item_id, position) VALUES ($1,$2,'item-1',1)`,
        [tenantId, visits[0]!.id],
      );
      await tx.query(
        `INSERT INTO crm.expense_claim
           (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on, description)
         VALUES ($1,$2,'travel',12.50,'USD',CURRENT_DATE,'a taxi')`,
        [tenantId, rep],
      );
    });
  };

  const countIn = (tenantId: string, table: string): Promise<number> =>
    withTenantContext(client, tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*)::bigint AS n FROM crm."${table}" WHERE tenant_id = $1`,
        [tenantId],
      );
      return Number(rows[0]!.n);
    });

  const clean = async (): Promise<void> => {
    // THE APPEND-ONLY TRIGGERS ARE DISABLED TO DO THIS, which is stated rather than hidden
    // because it is the guarantee being worked around and the only legitimate reason to is a
    // test's own fixtures. `crm_app` owns these tables (the migration created them), so it can.
    // A test that quietly found another way to delete evidence would be a test that proved the
    // guarantee does not hold; `is append-only` below asserts the refusal with the triggers on.
    await client.query("ALTER TABLE crm.tenant_tombstone_attestation DISABLE TRIGGER tenant_tombstone_attestation_append_only");
    await client.query("ALTER TABLE crm.tenant_tombstone DISABLE TRIGGER tenant_tombstone_append_only");
    try {
      for (const t of [DOOMED, BYSTANDER]) {
        await withTenantContext(client, t, async (tx) => {
          await tx.query("DELETE FROM crm.tenant_tombstone_attestation WHERE tenant_id = $1", [t]);
          await tx.query("DELETE FROM crm.tenant_tombstone WHERE tenant_id = $1", [t]);
        });
      }
    } finally {
      await client.query("ALTER TABLE crm.tenant_tombstone ENABLE TRIGGER tenant_tombstone_append_only");
      await client.query("ALTER TABLE crm.tenant_tombstone_attestation ENABLE TRIGGER tenant_tombstone_attestation_append_only");
    }

    for (const t of [DOOMED, BYSTANDER]) {
      await withTenantContext(client, t, async (tx) => {
        // Children first, by hand: the same order the executor computes, for the same reason.
        await tx.query("DELETE FROM crm.visit_product WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.product_snapshot WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [t]);
      });
    }
    await withRegistryTriggersOff(client, () =>
      client.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1)", [[DOOMED, BYSTANDER]]),
    );
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    await clean().catch(() => undefined);
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await clean();
    await register(BYSTANDER, "Still Trading");
    await seed(BYSTANDER);
  });

  // -------------------------------------------------------------------------
  // It refuses, which is what it does today.
  // -------------------------------------------------------------------------
  it("refuses while any table is undecided, and deletes nothing", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    await expect(
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    ).rejects.toThrow(ErasureRefusedError);
    expect(await countIn(DOOMED, "product_snapshot")).toBe(3);
    expect(await countIn(DOOMED, "rep_profile")).toBe(1);
  });

  it("refuses for a tenant the ERP has not deleted", async () => {
    await register(DOOMED, "Still Here");
    await seed(DOOMED);
    await withEverythingDecided(async () => {
      await expect(
        executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
      ).rejects.toThrow(/not_stopped|has not deleted/);
    });
    expect(await countIn(DOOMED, "product_snapshot")).toBe(3);
  });

  it("refuses four-eyes violations before touching anything", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    await withEverythingDecided(async () => {
      await expect(
        executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: ALICE }),
      ).rejects.toThrow(/four-eyes/);
    });
    expect(await countIn(DOOMED, "product_snapshot")).toBe(3);
  });

  // -------------------------------------------------------------------------
  // And it erases, when it may.
  // -------------------------------------------------------------------------
  it("erases the tenant's rows and writes a verifiable receipt", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);

    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );

    expect(verifyTombstone(result.tombstone)).toEqual([]);
    expect(result.tombstone.id).toMatch(/^crmtomb_[0-9a-f]{32}$/);
    expect(result.tombstone.erpTombstoneId).toBe(TOMB);
    for (const t of SEEDED) expect(await countIn(DOOMED, t), t).toBe(0);
    expect(result.tombstone.rowsErased).toBeGreaterThanOrEqual(7);
  });

  /** The whole point of an attestation per table: the receipt is silent about nothing. */
  it("attests for every table the register governs", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM crm.data_disposition",
    );
    expect(result.tombstone.attestations).toHaveLength(Number(rows[0]!.n));
  });

  /** A table that held nothing says so, rather than claiming an erasure it did not perform. */
  it("distinguishes a table it emptied from one that was already empty", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    const byTable = new Map(result.tombstone.attestations.map((a) => [a.table, a]));
    expect(byTable.get("product_snapshot")).toMatchObject({ outcome: "erased", rowsErased: 3 });
    expect(byTable.get("visit_product")).toMatchObject({ outcome: "erased", rowsErased: 1 });
    expect(byTable.get("territory")).toMatchObject({ outcome: "erased", rowsErased: 1 });
    // And one that really was empty says so rather than claiming an erasure.
    expect(byTable.get("sample_lot")?.outcome).toBe("nothing_to_erase");
  });

  /**
   * Children before parents. `crm.rep_profile` is the parent of eleven tables, and the figures
   * prove the order held: a child removed by a cascade would report zero rows erased.
   */
  it("deletes children before parents, so every figure is the figure that statement removed", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    const order = result.eraseOrder;
    expect(order.indexOf("visit_product")).toBeLessThan(order.indexOf("visit"));
    expect(order.indexOf("visit")).toBeLessThan(order.indexOf("rep_profile"));
    expect(order.indexOf("expense_claim")).toBeLessThan(order.indexOf("rep_profile"));
    // visit_product cascades from visit; it still reports its own 1 row, not 0.
    const vp = result.tombstone.attestations.find((a) => a.table === "visit_product");
    expect(vp).toMatchObject({ outcome: "erased", rowsErased: 1 });
  });

  /** Per tenant. The bystander is untouched, which is RLS plus the explicit predicate. */
  it("leaves every other tenant's rows alone", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    for (const t of SEEDED) expect(await countIn(BYSTANDER, t), t).toBeGreaterThan(0);
  });

  /** The retained half: with the real register, expense_claim is kept under its obligation. */
  it("retains what the register says to keep, with its obligation on the receipt", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    // Decide only the undecided ones that are NOT expense_claim's parents, so the real
    // `retain` on expense_claim survives — which needs rep_profile retained too, or the plan
    // refuses (see the dangling-retain test below). Retain both.
    await client.query("DROP TABLE IF EXISTS _dd_backup2");
    await client.query("CREATE TEMP TABLE _dd_backup2 AS SELECT * FROM crm.data_disposition");
    try {
      await client.query(
        `UPDATE crm.data_disposition
            SET disposition = 'erase', question = NULL, decided_by = 'test', decided_at = now()
          WHERE disposition = 'undecided' AND table_name <> 'rep_profile'`,
      );
      await client.query(
        `UPDATE crm.data_disposition
            SET disposition = 'retain', question = NULL, obligation = 'audit_logs_3y',
                obligation_note = 'kept as the employment record behind the retained claims',
                retained_reference = 'crm.rep_profile', decided_by = 'test', decided_at = now()
          WHERE table_name = 'rep_profile'`,
      );
      const result = await executeTenantErasure(client, DOOMED, {
        executedBy: ALICE,
        approvedBy: BOB,
      });
      expect(verifyTombstone(result.tombstone)).toEqual([]);
      const byTable = new Map(result.tombstone.attestations.map((a) => [a.table, a]));
      expect(byTable.get("expense_claim")).toMatchObject({
        outcome: "retained",
        rowsRetained: 1,
        obligation: "financial_transactions_7y",
      });
      expect(byTable.get("rep_profile")?.outcome).toBe("retained");
      // And they are still there.
      expect(await countIn(DOOMED, "expense_claim")).toBe(1);
      expect(await countIn(DOOMED, "rep_profile")).toBe(1);
      // While the erased ones are gone.
      expect(await countIn(DOOMED, "product_snapshot")).toBe(0);
      expect(await countIn(DOOMED, "visit")).toBe(0);
    } finally {
      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM crm.data_disposition");
        await client.query("INSERT INTO crm.data_disposition SELECT * FROM _dd_backup2");
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      await client.query("DROP TABLE IF EXISTS _dd_backup2");
    }
  });

  /**
   * THE REFUSAL THE FK GRAPH MAKES MANDATORY. `expense_claim` is retained and references
   * `rep_profile`; erasing the parent would be refused by its RESTRICT edge — and for a CASCADE
   * edge would DESTROY the retained child with no attestation while the receipt claimed it was
   * kept. Asserted through the plan, before any delete runs.
   */
  it("refuses to erase a parent whose child is retained", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    await withEverythingDecided(async () => {
      // The helper leaves a COHERENT register, so the incoherence is made here: put
      // `expense_claim` back to `retain` while its parent `rep_profile` stays `erase`. That is
      // the exact shape a half-answered register produces, and the one with a CASCADE sibling
      // (`visit_product -> visit`) that would destroy retained rows silently.
      await client.query(
        `UPDATE crm.data_disposition
            SET disposition = 'retain', obligation = 'financial_transactions_7y',
                obligation_note = 'an accounting record kept for the statutory period',
                retained_reference = 'crm.expense_claim', decided_by = 'test', decided_at = now()
          WHERE table_name = 'expense_claim'`,
      );
      const plan = await planTenantErasure(client, DOOMED);
      const dangling = plan.refusals.find((r) => r.kind === "retained_child_of_erased");
      expect(dangling).toBeDefined();
      if (dangling?.kind !== "retained_child_of_erased") throw new Error("unreachable");
      expect(dangling.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ child: "expense_claim", parent: "rep_profile" }),
        ]),
      );
      await expect(
        executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
      ).rejects.toThrow(ErasureRefusedError);
    });
    // Nothing was deleted.
    expect(await countIn(DOOMED, "product_snapshot")).toBe(3);
  });

  // -------------------------------------------------------------------------
  // The receipt, afterwards.
  // -------------------------------------------------------------------------
  it("reads back and re-verifies from the database", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    const stored = await readTenantTombstones(client, DOOMED);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(result.tombstone.id);
    expect(stored[0]!.contentManifestSha256).toBe(result.tombstone.contentManifestSha256);
    // The round trip through Postgres must preserve everything the hashes cover.
    expect(verifyTombstone(stored[0]!)).toEqual([]);
  });

  it("is append-only: the receipt cannot be rewritten or removed", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    const result = await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );
    const id = result.tombstone.id;
    for (const sql of [
      `UPDATE crm.tenant_tombstone SET rows_erased = 0 WHERE id = '${id}'`,
      `DELETE FROM crm.tenant_tombstone WHERE id = '${id}'`,
      `UPDATE crm.tenant_tombstone_attestation SET rows_erased = 99 WHERE tombstone_id = '${id}'`,
      `DELETE FROM crm.tenant_tombstone_attestation WHERE tombstone_id = '${id}'`,
    ]) {
      const msg = await withTenantContext(client, DOOMED, (tx) =>
        tx.query(sql).then(
          () => "SUCCEEDED",
          (e: { message?: string }) => e.message ?? "",
        ),
      );
      expect(msg, sql).toContain("append-only");
    }
  });

  /** A receipt for a tenant the ERP did not delete is refused by the database too. */
  it("refuses a receipt for a live tenant, in the database", async () => {
    const msg = await withTenantContext(client, BYSTANDER, (tx) =>
      tx
        .query(
          `INSERT INTO crm.tenant_tombstone
             (id, tenant_id, erp_tombstone_id, content_manifest_sha256, proof_sha256,
              executed_by, approved_by, rows_erased, rows_retained)
           VALUES ('crmtomb_00000000000000000000000000000009',$1,$2,$3,$3,'a','b',0,0)`,
          [BYSTANDER, TOMB, SHA],
        )
        .then(
          () => "SUCCEEDED",
          (e: { message?: string }) => e.message ?? "",
        ),
    );
    expect(msg).toMatch(/^tombstone-needs-deleted-tenant: /);
    expect(msg).toContain("not erp_deleted");
  });

  /** And one citing the wrong ERP receipt, which would claim an authority it does not have. */
  it("refuses a receipt citing an ERP tombstone the tenant was not deleted under", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    const msg = await withTenantContext(client, DOOMED, (tx) =>
      tx
        .query(
          `INSERT INTO crm.tenant_tombstone
             (id, tenant_id, erp_tombstone_id, content_manifest_sha256, proof_sha256,
              executed_by, approved_by, rows_erased, rows_retained)
           VALUES ('crmtomb_0000000000000000000000000000000a',$1,'tomb_ffffffffffffffffffffffffffffffff',$2,$2,'a','b',0,0)`,
          [DOOMED, SHA],
        )
        .then(
          () => "SUCCEEDED",
          (e: { message?: string }) => e.message ?? "",
        ),
    );
    expect(msg).toMatch(/^tombstone-wrong-erp-receipt: /);
  });

  /**
   * 0053's third layer: the receipt pins the registry row structurally, not by trigger.
   *
   * The first reference into `crm.tenant` in this schema's history — ADR-0001 carried the
   * observation that nothing pointed at the registry, which is why a row could vanish from
   * under a receipt that depends on it. Asserted with the terminal trigger DISABLED, because
   * with it on the trigger answers first and this key would never be seen to do anything.
   */
  it("pins the registry row with a foreign key, not only with a trigger", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    await seed(DOOMED);
    await withEverythingDecided(() =>
      executeTenantErasure(client, DOOMED, { executedBy: ALICE, approvedBy: BOB }),
    );

    const msg = await withRegistryTriggersOff(client, () =>
      client.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [DOOMED]).then(
        () => "SUCCEEDED",
        (e: { message?: string }) => e.message ?? "",
      ),
    );
    expect(msg).toContain("tenant_tombstone_tenant_id_fkey");

    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM crm.tenant WHERE tenant_id = $1",
      [DOOMED],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("refuses a four-eyes violation in the database as well as in the code", async () => {
    await register(DOOMED, "Gone");
    await stop(DOOMED);
    const msg = await withTenantContext(client, DOOMED, (tx) =>
      tx
        .query(
          `INSERT INTO crm.tenant_tombstone
             (id, tenant_id, erp_tombstone_id, content_manifest_sha256, proof_sha256,
              executed_by, approved_by, rows_erased, rows_retained)
           VALUES ('crmtomb_0000000000000000000000000000000b',$1,$2,$3,$3,'same','same',0,0)`,
          [DOOMED, TOMB, SHA],
        )
        .then(
          () => "SUCCEEDED",
          (e: { message?: string }) => e.message ?? "",
        ),
    );
    expect(msg).toContain("tenant_tombstone_four_eyes");
  });
});
