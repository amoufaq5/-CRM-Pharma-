import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { testPool, TENANT_A } from "./testing.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * Expense-claim invariants (ADR-0001 item 11 / Q6).
 *
 * The CRM enforces these because the ERP does not. Its `Expense` workflow is a
 * flat role check that never reads `Employee.manager_id`, has no amount bands,
 * no multi-step chain and no separation of duties — the same principal can
 * submit and approve (report R7). And its `Expense` has no GL write-effect at
 * all, so a claim can reach `reimbursed` without touching the ledger.
 */
describe("expense claim constraints", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1,'exp-rep','E-EXP','Rep'), ($1,'exp-mgr','E-MGR','Manager')
         ON CONFLICT DO NOTHING`,
        [TENANT_A],
      );
    });
  });

  afterAll(async () => {
    await withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT_A]);
      await tx.query("DELETE FROM crm.rep_profile WHERE subject IN ('exp-rep','exp-mgr')");
    });
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  });

  async function repId(subject: string): Promise<string> {
    return withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM crm.rep_profile WHERE subject = $1",
        [subject],
      );
      return rows[0]!.id;
    });
  }

  const INSERT = `
    INSERT INTO crm.expense_claim
      (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on,
       erp_ledger_account_code, erp_cost_center_code, state, approved_at, approved_by)
    VALUES ($1,$2,'conference',100.00,'USD','2026-09-01',$3,$4,$5,$6,$7)`;

  it("refuses a claim approved by the rep who submitted it (four-eyes)", async () => {
    const rep = await repId("exp-rep");
    await expect(
      withTenantContext(client, TENANT_A, async (tx) => {
        await tx.query(INSERT, [TENANT_A, rep, "6200", null, "approved", new Date(), rep]);
      }),
    ).rejects.toThrow(/expense_claim_four_eyes/);
  });

  it("refuses leaving draft without a snapshotted S&M account code", async () => {
    // The account and cost centre are snapshotted at submission so that
    // re-mapping a category later cannot retroactively re-attribute a posted
    // claim. A submitted claim with no account has nothing to post to.
    const rep = await repId("exp-rep");
    await expect(
      withTenantContext(client, TENANT_A, async (tx) => {
        await tx.query(INSERT, [TENANT_A, rep, null, null, "submitted", null, null]);
      }),
    ).rejects.toThrow(/expense_claim_snapshot_before_submit/);
  });

  it("accepts a claim approved by someone else, with the cost centre hooked", async () => {
    const [rep, mgr] = [await repId("exp-rep"), await repId("exp-mgr")];
    const state = await withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query(INSERT, [TENANT_A, rep, "6200", "CC-SM", "approved", new Date(), mgr]);
      const { rows } = await tx.query<{ acct: string; cc: string | null }>(
        `SELECT erp_ledger_account_code AS acct, erp_cost_center_code AS cc
           FROM crm.expense_claim WHERE tenant_id = $1 AND rep_profile_id = $2`,
        [TENANT_A, rep],
      );
      return rows[0];
    });
    // A separate S&M account, with the cost centre as an optional dimension —
    // exactly the JournalLine shape the relay will post.
    expect(state).toEqual({ acct: "6200", cc: "CC-SM" });
  });

  it("accepts a claim with NO cost centre — the dimension is optional", async () => {
    // JournalLine.cost_center_id is nullable in the ERP, so "post to the S&M
    // account with no dimension" is a valid posting and the right default until
    // Finance names the cost-centre codes.
    const [rep, mgr] = [await repId("exp-rep"), await repId("exp-mgr")];
    await withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT_A]);
      await tx.query(INSERT, [TENANT_A, rep, "6200", null, "approved", new Date(), mgr]);
    });
    const cc = await withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ cc: string | null }>(
        "SELECT erp_cost_center_code AS cc FROM crm.expense_claim WHERE tenant_id = $1",
        [TENANT_A],
      );
      return rows[0]?.cc ?? null;
    });
    expect(cc).toBeNull();
  });

  it("refuses an approved claim with no approval timestamp", async () => {
    const [rep, mgr] = [await repId("exp-rep"), await repId("exp-mgr")];
    await expect(
      withTenantContext(client, TENANT_A, async (tx) => {
        await tx.query(INSERT, [TENANT_A, rep, "6200", null, "approved", null, mgr]);
      }),
    ).rejects.toThrow(/expense_claim_approved_fields/);
  });

  it("refuses a non-positive amount", async () => {
    const rep = await repId("exp-rep");
    await expect(
      withTenantContext(client, TENANT_A, async (tx) => {
        await tx.query(
          `INSERT INTO crm.expense_claim
             (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
           VALUES ($1,$2,'conference',0,'USD','2026-09-01')`,
          [TENANT_A, rep],
        );
      }),
    ).rejects.toThrow(/amount/);
  });
});
