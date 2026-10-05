import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_EXPENSE_MAP as TENANT, appPool } from "@crm/db/testing";

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

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1, $2, 'expensemap-rep', 'E-EXPMAP-1', 'Map Rep')
         ON CONFLICT DO NOTHING`,
        [REP, TENANT],
      );
    });
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND rep_profile_id = $2", [
        TENANT,
        REP,
      ]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2", [TENANT, REP]);
    });
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND rep_profile_id = $2", [
        TENANT,
        REP,
      ]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
    });
  });

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
        const after = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6300",
        });
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
        const second = await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6300",
        });
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
});
