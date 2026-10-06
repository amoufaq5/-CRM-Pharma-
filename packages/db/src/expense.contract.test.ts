import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { testPool, TENANT_DB_EXPENSE as TENANT_A } from "./testing.js";
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

  /**
   * These are tests of 0006's and 0030's RESTING-state CHECKs, and they used to build their
   * rows by inserting the state they wanted to be in. Migration 0044 refuses that — a claim
   * is born `draft` and reaches every other state along an edge its trigger can see — so the
   * fixtures now WALK to the state under test and put the violation on the last hop.
   *
   * That is strictly better evidence than it was. A CHECK asserted against a hand-inserted
   * row proves it holds for a row that arrived from nowhere; the same CHECK asserted against
   * a transition proves it holds on the path a claim actually takes. And it is the division
   * 0044 is built on: the trigger governs the act, these CHECKs govern the row.
   *
   * The columns here are exactly the ones each state needs and no more — `submitted_at` and
   * the snapshot to leave `draft`, the approval pair to reach `approved` — because 0044 seals
   * them write-once and a helper that re-stamped one on every hop would be refused by the
   * seal rather than by the constraint the test names.
   */
  const AT = "2026-09-01T09:00:00.000Z";

  const draftClaim = (rep: string): Promise<string> =>
    withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.expense_claim
           (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
         VALUES ($1,$2,'conference',100.00,'USD','2026-09-01') RETURNING id`,
        [TENANT_A, rep],
      );
      return rows[0]!.id;
    });

  /** `draft -> submitted`, snapshotting whatever codes the case wants to test with. */
  const submit = (id: string, account: string | null, costCentre: string | null): Promise<void> =>
    withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query(
        `UPDATE crm.expense_claim
            SET state = 'submitted', submitted_at = $3,
                erp_ledger_account_code = $4, erp_cost_center_code = $5
          WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, id, AT, account, costCentre],
      );
    });

  /** `submitted -> approved`. `approvedAt` is a parameter because one case omits it. */
  const approve = (id: string, approvedBy: string, approvedAt: string | null): Promise<void> =>
    withTenantContext(client, TENANT_A, async (tx) => {
      await tx.query(
        `UPDATE crm.expense_claim SET state = 'approved', approved_at = $3, approved_by = $4
          WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, id, approvedAt, approvedBy],
      );
    });

  it("refuses a claim approved by the rep who submitted it (four-eyes)", async () => {
    const rep = await repId("exp-rep");
    const id = await draftClaim(rep);
    await submit(id, "6200", null);
    await expect(approve(id, rep, AT)).rejects.toThrow(/expense_claim_four_eyes/);
  });

  it("refuses leaving draft without a snapshotted S&M account code", async () => {
    // The account and cost centre are snapshotted at submission so that
    // re-mapping a category later cannot retroactively re-attribute a posted
    // claim. A submitted claim with no account has nothing to post to.
    const rep = await repId("exp-rep");
    const id = await draftClaim(rep);
    await expect(submit(id, null, null)).rejects.toThrow(/expense_claim_snapshot_before_submit/);
  });

  it("accepts a claim approved by someone else, with the cost centre hooked", async () => {
    const [rep, mgr] = [await repId("exp-rep"), await repId("exp-mgr")];
    const id = await draftClaim(rep);
    await submit(id, "6200", "CC-SM");
    await approve(id, mgr, AT);
    const state = await withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ acct: string; cc: string | null }>(
        `SELECT erp_ledger_account_code AS acct, erp_cost_center_code AS cc
           FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, id],
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
    const id = await draftClaim(rep);
    await submit(id, "6200", null);
    await approve(id, mgr, AT);
    const cc = await withTenantContext(client, TENANT_A, async (tx) => {
      const { rows } = await tx.query<{ cc: string | null }>(
        "SELECT erp_cost_center_code AS cc FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2",
        [TENANT_A, id],
      );
      return rows[0]?.cc ?? null;
    });
    expect(cc).toBeNull();
  });

  it("refuses an approved claim with no approval timestamp", async () => {
    const [rep, mgr] = [await repId("exp-rep"), await repId("exp-mgr")];
    const id = await draftClaim(rep);
    await submit(id, "6200", null);
    // The approver IS named, so 0044's "approving records an approver" rule is satisfied and
    // the refusal is 0006's pairing of the timestamp to the state — which is the one this
    // case is about. Omitting both would be answered by the trigger instead.
    await expect(approve(id, mgr, null)).rejects.toThrow(/expense_claim_approved_fields/);
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
