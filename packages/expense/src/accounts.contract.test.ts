import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { CONFIG_LOG_LIMIT, configChanges, withAttribution, withTenantContext } from "@crm/db";
import {
  TENANT_EXPENSE_MAP as TENANT,
  appPool,
  wipeProposals,
  withFourEyes,
} from "@crm/db/testing";

import {
  activeAccountMapping,
  deactivateAccountMapping,
  listAccountMappings,
  requireAccountMapping,
  unmappedCategoriesWithClaims,
  upsertAccountMapping,
} from "./accounts.js";
import { InvalidAccountCodeError, InvalidCategoryError, UnmappedCategoryError } from "./errors.js";
import { createClaim } from "./store.js";

/**
 * `crm.expense_account_map` against a real Postgres.
 *
 * The table is Finance's, it is empty, and the one behaviour that has to be right is
 * what happens when it STAYS empty: `requireAccountMapping` must refuse by name rather
 * than fall back to anything. A fake connection could not show that an inactive row is
 * invisible to the submit path while still being readable for an audit, which is the
 * distinction `is_active` exists to draw.
 *
 * `TENANT_EXPENSE_MAP` is this file's own reserved tenant, per the one-block-per-test-file
 * rule in `packages/db/src/testing.ts`. It shared `TENANT_DB_EXPENSE` with two other
 * suites while this package was being written, which worked only because
 * `fileParallelism: false` happens to be set; every row is still removed below, because a
 * reserved tenant is not a reason to leave a database dirty.
 */
describe("expense account map", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "e5100000-0000-4000-8000-000000000001";

  /** The sentence every signed write in this file carries, asserted on below. */
  const REASON = "Finance re-pointing a category in the test suite";

  /**
   * Tenant context AND attribution, because `crm.expense_account_map` is one of the two
   * tables migration 0061 put under it.
   *
   * This suite signs with its OWN rep rather than the shared fixture author, because here the
   * log is not incidental — the last block reads it back and asserts who wrote what. A fixture
   * author would make those assertions say "a fixture did it", which is true and useless.
   */
  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, (tx) =>
      withAttribution(tx, { repProfileId: REP, reason: REASON }, fn),
    );

  /** Tenant context with NOBODY named — for the one test that asserts the refusal. */
  const unsigned = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await unsigned(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1, $2, 'expensemap-rep', 'E-EXPMAP-1', 'Map Rep')
         ON CONFLICT DO NOTHING`,
        [REP, TENANT],
      );
    });
  });

  afterAll(async () => {
    await unsigned(async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND rep_profile_id = $2", [
        TENANT,
        REP,
      ]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
      // The logs and the proposals before their actors: 0061 and 0062 both name reps ON
      // DELETE RESTRICT, and the logs reference the proposal, so the order is fixed.
      await wipeProposals(tx, TENANT);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2", [TENANT, REP]);
    });
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await unsigned(async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND rep_profile_id = $2", [
        TENANT,
        REP,
      ]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
      // So the attribution block below reads only its own test's history.
      await wipeProposals(tx, TENANT);
    });
  });

  /**
   * Re-pointing a category, the way a tenant actually has to (0062).
   *
   * CHANGING WHERE A CATEGORY POSTS TAKES TWO PEOPLE: every claim posted afterwards lands in
   * the new account, and pointing it back does not move them. So three tests below that used
   * to be one `upsertAccountMapping` call now go the whole way round — two reps hold the
   * administrator grant, one proposes, the other approves — and what each of them is actually
   * about (one row not two, `updated_at` moving, the log naming one column) is unchanged.
   *
   * The approval names the cost centre as well as the account code, because the upsert
   * REPLACES it: an approval covering only the four-eyed column would apply as a silent
   * clearing of a dimension nobody agreed to drop. That is the route's shape too.
   */
  const repoint = (
    tx: PoolClient,
    category: string,
    code: string,
    centre: string | null = null,
  ): Promise<unknown> =>
    withFourEyes(
      tx,
      TENANT,
      {
        tableName: "expense_account_map",
        rowKey: { tenant_id: TENANT, crm_category: category },
        changes: { erp_ledger_account_code: code, erp_cost_center_code: centre },
        role: "administrator",
      },
      (c) =>
        upsertAccountMapping(c, TENANT, {
          crmCategory: category,
          erpLedgerAccountCode: code,
          erpCostCenterCode: centre,
        }),
    );

  describe("the empty table", () => {
    it("has no mapping for any category", async () => {
      await inTenant(async (tx) => {
        expect(await activeAccountMapping(tx, TENANT, "congress")).toBeNull();
      });
    });

    it("refuses by name, naming the category and Finance", async () => {
      await inTenant(async (tx) => {
        const err = await requireAccountMapping(tx, TENANT, "congress").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnmappedCategoryError);
        expect((err as Error).message).toContain('"congress"');
        expect((err as Error).message).toContain("Finance");
      });
    });

    it("lists nothing rather than throwing", async () => {
      await inTenant(async (tx) => {
        expect(await listAccountMappings(tx, TENANT)).toEqual([]);
      });
    });

    it("reports nothing to deactivate", async () => {
      await inTenant(async (tx) => {
        expect(await deactivateAccountMapping(tx, TENANT, "congress")).toBe(false);
      });
    });
  });

  describe("writing a mapping", () => {
    it("stores the account code and defaults to active", async () => {
      await inTenant(async (tx) => {
        const mapping = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(mapping.erp_ledger_account_code).toBe("6200");
        expect(mapping.is_active).toBe(true);
      });
    });

    it("accepts a null cost centre — JournalLine.cost_center_id is nullable", async () => {
      await inTenant(async (tx) => {
        const mapping = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(mapping.erp_cost_center_code).toBeNull();
      });
    });

    it("stores a cost centre when Finance names one", async () => {
      await inTenant(async (tx) => {
        const mapping = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
          erpCostCenterCode: "CC-SM",
        });
        expect(mapping.erp_cost_center_code).toBe("CC-SM");
      });
    });

    it("lets several categories share one account", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "hospitality",
          erpLedgerAccountCode: "6200",
        });
        const all = await listAccountMappings(tx, TENANT);
        expect(all.map((m) => m.crm_category)).toEqual(["congress", "hospitality"]);
        expect(new Set(all.map((m) => m.erp_ledger_account_code))).toEqual(new Set(["6200"]));
      });
    });

    it("re-points a category rather than creating a second row", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
          erpCostCenterCode: "CC-SM",
        });
        await repoint(tx, "congress", "6300");
        const after = (await listAccountMappings(tx, TENANT))[0]!;
        expect(after.erp_ledger_account_code).toBe("6300");
        // The cost centre is REPLACED, not merged: an upsert that kept a stale dimension
        // would attribute new spend to a cost centre nobody re-stated.
        expect(after.erp_cost_center_code).toBeNull();
        expect((await listAccountMappings(tx, TENANT)).length).toBe(1);
      });
    });

    it("moves updated_at on a re-point so the change is datable", async () => {
      await inTenant(async (tx) => {
        const first = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await tx.query("SELECT pg_sleep(0.01)");
        await repoint(tx, "congress", "6300");
        const second = (await listAccountMappings(tx, TENANT))[0]!;
        expect(second.updated_at.getTime()).toBeGreaterThanOrEqual(first.updated_at.getTime());
      });
    });
  });

  describe("rejecting codes the ERP would reject later", () => {
    it("refuses an account code over 32 characters", async () => {
      await inTenant(async (tx) => {
        const err = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6".repeat(33),
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidAccountCodeError);
      });
    });

    it("refuses an empty account code", async () => {
      await inTenant(async (tx) => {
        await expect(
          upsertAccountMapping(tx, TENANT, { crmCategory: "congress", erpLedgerAccountCode: "" }),
        ).rejects.toBeInstanceOf(InvalidAccountCodeError);
      });
    });

    it("refuses a padded account code, which would not match any LedgerAccount", async () => {
      await inTenant(async (tx) => {
        await expect(
          upsertAccountMapping(tx, TENANT, {
            crmCategory: "congress",
            erpLedgerAccountCode: " 6200",
          }),
        ).rejects.toBeInstanceOf(InvalidAccountCodeError);
      });
    });

    it("refuses an over-long cost centre code too", async () => {
      await inTenant(async (tx) => {
        await expect(
          upsertAccountMapping(tx, TENANT, {
            crmCategory: "congress",
            erpLedgerAccountCode: "6200",
            erpCostCenterCode: "C".repeat(33),
          }),
        ).rejects.toBeInstanceOf(InvalidAccountCodeError);
      });
    });

    it("refuses a blank category", async () => {
      await inTenant(async (tx) => {
        await expect(
          upsertAccountMapping(tx, TENANT, { crmCategory: "   ", erpLedgerAccountCode: "6200" }),
        ).rejects.toBeInstanceOf(InvalidCategoryError);
      });
    });

    it("writes nothing when the input is refused", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "",
        }).catch(() => undefined);
        expect(await listAccountMappings(tx, TENANT)).toEqual([]);
      });
    });
  });

  describe("deactivation", () => {
    it("hides the mapping from the submit path", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(await deactivateAccountMapping(tx, TENANT, "congress")).toBe(true);
        expect(await activeAccountMapping(tx, TENANT, "congress")).toBeNull();
        await expect(requireAccountMapping(tx, TENANT, "congress")).rejects.toBeInstanceOf(
          UnmappedCategoryError,
        );
      });
    });

    it("keeps the row, so what the category used to post to is still answerable", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
        const all = await listAccountMappings(tx, TENANT);
        expect(all.length).toBe(1);
        expect(all[0]!.erp_ledger_account_code).toBe("6200");
        expect(all[0]!.is_active).toBe(false);
      });
    });

    it("is not repeatable — a second call reports nothing to do", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(await deactivateAccountMapping(tx, TENANT, "congress")).toBe(true);
        expect(await deactivateAccountMapping(tx, TENANT, "congress")).toBe(false);
      });
    });

    it("hides an inactive row from activeOnly but not from the full list", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "hospitality",
          erpLedgerAccountCode: "6210",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
        expect((await listAccountMappings(tx, TENANT, { activeOnly: true })).length).toBe(1);
        expect((await listAccountMappings(tx, TENANT)).length).toBe(2);
      });
    });

    it("can be reactivated by an upsert", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
        const back = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(back.is_active).toBe(true);
      });
    });
  });

  describe("the Finance to-do list", () => {
    const draft = (tx: PoolClient, category: string): Promise<unknown> =>
      createClaim(tx, TENANT, {
        repProfileId: REP,
        crmCategory: category,
        amount: "10.00",
        currency: "GBP",
        incurredOn: "2026-09-01",
      });

    it("is empty when nothing has been claimed", async () => {
      await inTenant(async (tx) => {
        expect(await unmappedCategoriesWithClaims(tx, TENANT)).toEqual([]);
      });
    });

    it("counts draft claims per unmapped category", async () => {
      await inTenant(async (tx) => {
        await draft(tx, "congress");
        await draft(tx, "congress");
        await draft(tx, "hospitality");
        expect(await unmappedCategoriesWithClaims(tx, TENANT)).toEqual([
          { crm_category: "congress", draft_claims: 2 },
          { crm_category: "hospitality", draft_claims: 1 },
        ]);
      });
    });

    it("drops a category the moment Finance maps it", async () => {
      await inTenant(async (tx) => {
        await draft(tx, "congress");
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        expect(await unmappedCategoriesWithClaims(tx, TENANT)).toEqual([]);
      });
    });

    it("brings a category back if the mapping is deactivated", async () => {
      await inTenant(async (tx) => {
        await draft(tx, "congress");
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
        expect(await unmappedCategoriesWithClaims(tx, TENANT)).toEqual([
          { crm_category: "congress", draft_claims: 1 },
        ]);
      });
    });
  });
  /**
   * Migration 0061: a change to this table is refused unless somebody signs it, and recorded
   * when they do.
   *
   * The table is Finance's and the question it has to answer is not "what does congress post
   * to" — `listAccountMappings` answers that — it is "who re-pointed it, when, and why". Every
   * other test in this file writes through `inTenant`, which signs; this block is where the
   * signature is the subject rather than the precondition.
   *
   * Asserted against a real Postgres because all of it is a trigger: the refusal is a `RAISE`
   * from `crm.record_config_change`, the exemption is a lookup in `pg_attrdef`, and
   * `changed_columns` is computed by comparing two `jsonb` images of the row.
   */
  describe("attribution", () => {
    it("refuses a write nobody has signed", async () => {
      await unsigned(async (tx) => {
        await expect(
          upsertAccountMapping(tx, TENANT, {
            crmCategory: "congress",
            erpLedgerAccountCode: "6200",
          }),
        ).rejects.toThrow(/config-change-unattributed/);
      });
      // And refused means refused: nothing landed.
      expect(await unsigned((tx) => listAccountMappings(tx, TENANT))).toEqual([]);
    });

    it("records a new mapping as a creation, naming the author and the reason", async () => {
      await inTenant((tx) =>
        upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        }),
      );
      const log = await unsigned((tx) => configChanges(tx, TENANT));
      expect(log.length).toBe(1);
      expect(log[0]!.table_name).toBe("expense_account_map");
      expect(log[0]!.action).toBe("created");
      expect(log[0]!.changed_by).toBe(REP);
      expect(log[0]!.changed_by_name).toBe("Map Rep");
      expect(log[0]!.reason).toBe(REASON);
      // `before` is null on a creation — there was nothing to be before.
      expect(log[0]!.before).toBeNull();
      // The account code is what MOVED off its declared default; `is_active` defaults to true
      // and was not chosen, so it is not listed.
      expect(log[0]!.changed_columns).toContain("erp_ledger_account_code");
      expect(log[0]!.changed_columns).not.toContain("is_active");
    });

    it("records a re-point as an amendment, naming only the column that moved", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await repoint(tx, "congress", "6300");
      });
      const log = await unsigned((tx) => configChanges(tx, TENANT));
      // Newest first, so the amendment is at the head. `clock_timestamp()` rather than `now()`
      // is what makes that true inside one transaction.
      expect(log.map((c) => c.action)).toEqual(["amended", "created"]);
      expect(log[0]!.changed_columns).toEqual(["erp_ledger_account_code"]);
      expect(log[0]!.before).toMatchObject({ erp_ledger_account_code: "6200" });
      expect(log[0]!.after).toMatchObject({ erp_ledger_account_code: "6300" });
      expect(log[0]!.row_key).toMatchObject({ tenant_id: TENANT, crm_category: "congress" });
    });

    it("records a deactivation as the is_active change it is", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
      });
      const log = await unsigned((tx) => configChanges(tx, TENANT));
      expect(log[0]!.action).toBe("amended");
      expect(log[0]!.changed_columns).toEqual(["is_active"]);
      expect(log[0]!.before).toMatchObject({ is_active: true });
      expect(log[0]!.after).toMatchObject({ is_active: false });
    });

    it("does not record a deactivation that deactivates nothing", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        });
        await deactivateAccountMapping(tx, TENANT, "congress");
        // The second call matches a row that is already inactive. `updated_at` is ignored and
        // nothing else moves, so there is nothing to record — and 0061 does not refuse it,
        // because a route with ensure semantics is entitled to be called twice.
        expect(await deactivateAccountMapping(tx, TENANT, "congress")).toBe(false);
      });
      const log = await unsigned((tx) => configChanges(tx, TENANT));
      expect(log.map((c) => c.changed_columns)).toEqual([["is_active"], ["erp_ledger_account_code"]]);
    });

    it("refuses to let the log be edited or deleted", async () => {
      await inTenant((tx) =>
        upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        }),
      );
      await unsigned(async (tx) => {
        await expect(
          tx.query("UPDATE crm.config_change SET reason = $2 WHERE tenant_id = $1", [
            TENANT,
            "a reason somebody preferred",
          ]),
        ).rejects.toThrow(/append-only|config_change/i);
      });
      await unsigned(async (tx) => {
        await expect(
          tx.query("DELETE FROM crm.config_change WHERE tenant_id = $1", [TENANT]),
        ).rejects.toThrow(/append-only|config_change/i);
      });
    });

    it("filters by table and caps what it returns", async () => {
      await inTenant((tx) =>
        upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
        }),
      );
      expect(
        (await unsigned((tx) => configChanges(tx, TENANT, { table: "expense_account_map" }))).length,
      ).toBe(1);
      expect(
        await unsigned((tx) => configChanges(tx, TENANT, { table: "notification_policy" })),
      ).toEqual([]);
      // A limit over the ceiling is clamped to it rather than honoured.
      expect(
        (await unsigned((tx) => configChanges(tx, TENANT, { limit: CONFIG_LOG_LIMIT + 500 })))
          .length,
      ).toBe(1);
    });
  });
});
