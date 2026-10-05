import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_EXPENSE_STORE as TENANT, appPool } from "@crm/db/testing";

import { upsertAccountMapping } from "./accounts.js";
import {
  FourEyesViolationError,
  RejectionFourEyesViolationError,
  InvalidAmountError,
  InvalidCategoryError,
  InvalidCurrencyError,
  InvalidDateError,
  ExpenseClaimNotFoundError,
  MissingErpExpenseIdError,
  RepNotMappedToEmployeeError,
  UnmappedCategoryError,
} from "./errors.js";
import { enqueueExpenseCreate, expenseRecordId } from "./posting.js";
import { InvalidExpenseClaimTransitionError } from "./states.js";
import {
  approveClaim,
  claimPostingStatus,
  createClaim,
  getClaim,
  listClaimsForRep,
  postClaim,
  reimburseClaim,
  rejectClaim,
  requireClaim,
  submitClaim,
  unpostedApprovedClaims,
  type ExpenseClaim,
} from "./store.js";

/**
 * The claim lifecycle against a real Postgres.
 *
 * Four of the rules under test live in 0006 as CHECK constraints rather than in
 * TypeScript — four-eyes, the account snapshot, the approval-timestamp pairing and the
 * positive amount — so a fake connection would assert the shape of SQL that nothing had
 * refused. The rest need a real server for an unglamorous reason: `NUMERIC`, `char(3)`
 * and `date` all coerce in ways no fake reproduces, and two of this package's guards
 * exist only because the live cluster was asked what it would accept.
 *
 * `TENANT_EXPENSE_STORE` is this file's own reserved tenant (`packages/db/src/testing.ts`
 * hands them out one per test file). Everything created here is removed again, and the rep
 * subjects stay prefixed so a future file sharing the tenant by mistake fails loudly on a
 * unique subject rather than quietly on a count.
 */
describe("expense claims", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "e6100000-0000-4000-8000-000000000001";
  const MGR = "e6200000-0000-4000-8000-000000000002";
  /** Deliberately never reconciled: `erp_employee_id` stays null. */
  const ORPHAN = "e6300000-0000-4000-8000-000000000003";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, employee, name, erpId] of [
        [REP, "expensestore-rep", "E-EXPST-1", "Store Rep", "emp-expst-1"],
        [MGR, "expensestore-mgr", "E-EXPST-2", "Store Manager", "emp-expst-2"],
        [ORPHAN, "expensestore-orphan", "E-EXPST-3", "Unreconciled Rep", null],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile
             (id, tenant_id, subject, employee_number, display_name, erp_employee_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, employee, name, erpId],
        );
      }
    });
  });

  afterAll(async () => {
    await clear();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [
        TENANT,
        [REP, MGR, ORPHAN],
      ]);
    });
    client?.release();
    await pool?.end();
  });

  const clear = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1 AND source_table = $2", [
        TENANT,
        "crm.expense_claim",
      ]);
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeEach(clear);

  const map = (tx: PoolClient, costCentre: string | null = "CC-SM"): Promise<unknown> =>
    upsertAccountMapping(tx, TENANT, {
      crmCategory: "congress",
      erpLedgerAccountCode: "6200",
      erpCostCenterCode: costCentre,
    });

  const draft = (tx: PoolClient, rep = REP, category = "congress"): Promise<ExpenseClaim> =>
    createClaim(tx, TENANT, {
      repProfileId: rep,
      crmCategory: category,
      amount: "1234.50",
      currency: "GBP",
      incurredOn: "2026-09-01",
      description: "Respiratory congress, Manchester",
    });

  /** A mapped, submitted, approved claim — the state everything downstream starts from. */
  const approved = async (rep = REP): Promise<string> =>
    inTenant(async (tx) => {
      await map(tx);
      const claim = await draft(tx, rep);
      await submitClaim(tx, TENANT, claim.id, new Date("2026-09-02T09:00:00Z"));
      await approveClaim(tx, TENANT, claim.id, MGR, new Date("2026-09-03T09:00:00Z"));
      return claim.id;
    });

  describe("creating a claim", () => {
    it("starts in draft with no snapshot and no ERP ids", async () => {
      await inTenant(async (tx) => {
        const claim = await draft(tx);
        expect(claim).toMatchObject({
          state: "draft",
          erp_ledger_account_code: null,
          erp_cost_center_code: null,
          erp_expense_id: null,
          erp_journal_entry_id: null,
          submitted_at: null,
          approved_at: null,
          approved_by: null,
          rejected_at: null,
          rejected_by: null,
          posted_at: null,
        });
      });
    });

    it("needs no mapping to exist — a rep can record spend before Finance maps it", async () => {
      await inTenant(async (tx) => {
        const claim = await draft(tx, REP, "a-category-nobody-mapped");
        expect(claim.state).toBe("draft");
      });
    });

    it("keeps the amount a string, to the scale the column holds", async () => {
      await inTenant(async (tx) => {
        const claim = await createClaim(tx, TENANT, {
          repProfileId: REP,
          crmCategory: "congress",
          amount: "7",
          currency: "GBP",
          incurredOn: "2026-09-01",
        });
        expect(claim.amount).toBe("7.00");
        expect(typeof claim.amount).toBe("string");
      });
    });

    it("returns incurred_on as the ISO day, not a timezone-shifted Date", async () => {
      await inTenant(async (tx) => {
        expect((await draft(tx)).incurred_on).toBe("2026-09-01");
      });
    });

    it("refuses NaN, which 0006's CHECK (amount > 0) does NOT catch", async () => {
      await inTenant(async (tx) => {
        await expect(
          createClaim(tx, TENANT, {
            repProfileId: REP,
            crmCategory: "congress",
            amount: "NaN",
            currency: "GBP",
            incurredOn: "2026-09-01",
          }),
        ).rejects.toBeInstanceOf(InvalidAmountError);
      });
    });

    it("confirms against the live cluster that NaN really would pass the CHECK", async () => {
      // The reason the TypeScript guard above is not redundant. NaN sorts above every
      // non-NaN numeric in Postgres, so `amount > 0` is true for it and 0006 would store
      // a claim that poisons every sum over the table.
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ admitted: boolean }>(
          "SELECT 'NaN'::numeric(14,2) > 0 AS admitted",
        );
        expect(rows[0]!.admitted).toBe(true);
      });
    });

    it("refuses zero and a negative amount", async () => {
      for (const amount of ["0", "0.00", "-5.00"]) {
        await inTenant(async (tx) => {
          await expect(
            createClaim(tx, TENANT, {
              repProfileId: REP,
              crmCategory: "congress",
              amount,
              currency: "GBP",
              incurredOn: "2026-09-01",
            }),
          ).rejects.toBeInstanceOf(InvalidAmountError);
        });
      }
    });

    it("refuses more precision than the column keeps", async () => {
      await inTenant(async (tx) => {
        await expect(
          createClaim(tx, TENANT, {
            repProfileId: REP,
            crmCategory: "congress",
            amount: "10.005",
            currency: "GBP",
            incurredOn: "2026-09-01",
          }),
        ).rejects.toBeInstanceOf(InvalidAmountError);
      });
    });

    it("refuses a currency char(3) would silently pad", async () => {
      for (const currency of ["us", "usd", "U$D", "USDX"]) {
        await inTenant(async (tx) => {
          await expect(
            createClaim(tx, TENANT, {
              repProfileId: REP,
              crmCategory: "congress",
              amount: "10.00",
              currency,
              incurredOn: "2026-09-01",
            }),
          ).rejects.toBeInstanceOf(InvalidCurrencyError);
        });
      }
    });

    it("confirms against the live cluster that char(3) really does pad", async () => {
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ padded: boolean }>("SELECT 'us'::char(3) = 'us ' AS padded");
        expect(rows[0]!.padded).toBe(true);
      });
    });

    it("refuses a date that is not YYYY-MM-DD", async () => {
      await inTenant(async (tx) => {
        await expect(
          createClaim(tx, TENANT, {
            repProfileId: REP,
            crmCategory: "congress",
            amount: "10.00",
            currency: "GBP",
            incurredOn: "01/09/2026",
          }),
        ).rejects.toBeInstanceOf(InvalidDateError);
      });
    });

    it("refuses a blank category", async () => {
      await inTenant(async (tx) => {
        await expect(
          createClaim(tx, TENANT, {
            repProfileId: REP,
            crmCategory: " ",
            amount: "10.00",
            currency: "GBP",
            incurredOn: "2026-09-01",
          }),
        ).rejects.toBeInstanceOf(InvalidCategoryError);
      });
    });
  });

  describe("reading claims", () => {
    it("returns null for a claim that is not there, and throws when one is required", async () => {
      await inTenant(async (tx) => {
        const absent = "e6900000-0000-4000-8000-00000000000f";
        expect(await getClaim(tx, TENANT, absent)).toBeNull();
        await expect(requireClaim(tx, TENANT, absent)).rejects.toBeInstanceOf(
          ExpenseClaimNotFoundError,
        );
      });
    });

    it("lists one rep's claims and not another's", async () => {
      await inTenant(async (tx) => {
        await draft(tx, REP);
        await draft(tx, MGR);
        const mine = await listClaimsForRep(tx, TENANT, REP);
        expect(mine.length).toBe(1);
        expect(mine[0]!.rep_profile_id).toBe(REP);
      });
    });

    it("filters by state", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const a = await draft(tx);
        await draft(tx);
        await submitClaim(tx, TENANT, a.id, new Date());
        expect((await listClaimsForRep(tx, TENANT, REP, { states: ["draft"] })).length).toBe(1);
        expect((await listClaimsForRep(tx, TENANT, REP, { states: ["submitted"] })).length).toBe(1);
        expect(
          (await listClaimsForRep(tx, TENANT, REP, { states: ["posted", "reimbursed"] })).length,
        ).toBe(0);
      });
    });
  });

  describe("submitting — the Finance blocker", () => {
    it("REFUSES when the category has no mapping, naming the category", async () => {
      await inTenant(async (tx) => {
        const claim = await draft(tx);
        const err = await submitClaim(tx, TENANT, claim.id, new Date()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnmappedCategoryError);
        expect((err as Error).message).toContain('"congress"');
        expect((err as Error).message).toContain("crm.expense_account_map");
      });
    });

    it("leaves the claim in draft when it refuses", async () => {
      const id = await inTenant(async (tx) => (await draft(tx)).id);
      await inTenant((tx) => submitClaim(tx, TENANT, id, new Date())).catch(() => undefined);
      await inTenant(async (tx) => {
        expect((await requireClaim(tx, TENANT, id)).state).toBe("draft");
      });
    });

    it("refuses when the only mapping is inactive", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
          isActive: false,
        });
        const claim = await draft(tx);
        await expect(submitClaim(tx, TENANT, claim.id, new Date())).rejects.toBeInstanceOf(
          UnmappedCategoryError,
        );
      });
    });

    it("snapshots the account and cost centre once Finance has mapped the category", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        const submitted = await submitClaim(tx, TENANT, claim.id, new Date("2026-09-02T09:00:00Z"));
        expect(submitted).toMatchObject({
          state: "submitted",
          erp_ledger_account_code: "6200",
          erp_cost_center_code: "CC-SM",
        });
        expect(submitted.submitted_at?.toISOString()).toBe("2026-09-02T09:00:00.000Z");
      });
    });

    it("snapshots a null cost centre as null, not as absent", async () => {
      await inTenant(async (tx) => {
        await map(tx, null);
        const claim = await draft(tx);
        const submitted = await submitClaim(tx, TENANT, claim.id, new Date());
        expect(submitted.erp_ledger_account_code).toBe("6200");
        expect(submitted.erp_cost_center_code).toBeNull();
      });
    });

    it("does NOT re-attribute a submitted claim when Finance re-points the category", async () => {
      // The whole reason 0006 snapshots instead of looking up at posting time.
      const id = await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        await submitClaim(tx, TENANT, claim.id, new Date());
        return claim.id;
      });
      await inTenant((tx) =>
        upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "9999",
          erpCostCenterCode: "CC-OTHER",
        }),
      );
      await inTenant(async (tx) => {
        const claim = await requireClaim(tx, TENANT, id);
        expect(claim.erp_ledger_account_code).toBe("6200");
        expect(claim.erp_cost_center_code).toBe("CC-SM");
      });
    });

    it("refuses a second submit", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        await submitClaim(tx, TENANT, claim.id, new Date());
        await expect(submitClaim(tx, TENANT, claim.id, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });
  });

  describe("approving — four eyes", () => {
    it("is refused when the approver is the rep, by the database", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        await submitClaim(tx, TENANT, claim.id, new Date());
        const err = await approveClaim(tx, TENANT, claim.id, REP, new Date()).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(FourEyesViolationError);
        expect((err as Error).message).toContain("expense_claim_four_eyes");
      });
    });

    it("records who approved it and when", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        await submitClaim(tx, TENANT, claim.id, new Date());
        const out = await approveClaim(tx, TENANT, claim.id, MGR, new Date("2026-09-03T09:00:00Z"));
        expect(out.state).toBe("approved");
        expect(out.approved_by).toBe(MGR);
        expect(out.approved_at?.toISOString()).toBe("2026-09-03T09:00:00.000Z");
      });
    });

    it("cannot approve a draft claim", async () => {
      await inTenant(async (tx) => {
        const claim = await draft(tx);
        await expect(approveClaim(tx, TENANT, claim.id, MGR, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });
  });

  describe("rejecting", () => {
    /** A mapped, submitted claim — the only state a rejection is reachable from. */
    const submitted = async (tx: PoolClient, rep = REP): Promise<ExpenseClaim> => {
      await map(tx);
      const claim = await draft(tx, rep);
      return submitClaim(tx, TENANT, claim.id, new Date("2026-09-02T09:00:00Z"));
    };

    it("rejects a submitted claim without an approval timestamp", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        const out = await rejectClaim(tx, TENANT, claim.id, MGR, new Date());
        expect(out.state).toBe("rejected");
        expect(out.approved_at).toBeNull();
      });
    });

    /**
     * The gap 0030 closed. Before it, a rejection recorded a state and no actor — and in
     * a lifecycle where four-eyes is enforced here or nowhere, "a manager rejected this"
     * with no manager named is not a record of a decision.
     */
    it("records who rejected it, and when, in columns of their own", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        const out = await rejectClaim(
          tx, TENANT, claim.id, MGR, new Date("2026-09-04T11:30:00Z"),
        );
        expect(out.rejected_by).toBe(MGR);
        expect(out.rejected_at?.toISOString()).toBe("2026-09-04T11:30:00.000Z");
        // And NOT in the approval columns, which is the whole point of adding two.
        expect(out.approved_by).toBeNull();
        expect(out.approved_at).toBeNull();
      });
    });

    /** Four eyes applies to the refusal exactly as it does to the approval. */
    it("refuses a rejection by the claimant", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        await expect(
          rejectClaim(tx, TENANT, claim.id, REP, new Date()),
        ).rejects.toBeInstanceOf(RejectionFourEyesViolationError);
      });
    });

    /**
     * Distinct classes, because a rejection reported as a failed approval sends the
     * reader looking for an approval nobody attempted.
     */
    it("tells a rejecter four-eyes violation apart from an approver one", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        await expect(
          approveClaim(tx, TENANT, claim.id, REP, new Date()),
        ).rejects.toBeInstanceOf(FourEyesViolationError);
      });
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        let err: unknown;
        try {
          await rejectClaim(tx, TENANT, claim.id, REP, new Date());
        } catch (caught) {
          err = caught;
        }
        expect(err).toBeInstanceOf(RejectionFourEyesViolationError);
        expect(err).not.toBeInstanceOf(FourEyesViolationError);
        expect((err as Error).message).toMatch(/cannot be rejected by the rep who submitted it/);
      });
    });

    /**
     * `expense_claim_rejected_fields` and `expense_claim_approved_fields` are over
     * disjoint state sets, so at most one timestamp is ever required — asserted against
     * the live constraints rather than reasoned about, since a contradiction between the
     * two would show up as a row nothing can write.
     */
    it("leaves the approval pairing intact, and cannot contradict it", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        const rejected = await rejectClaim(tx, TENANT, claim.id, MGR, new Date());
        expect(rejected.rejected_at).not.toBeNull();
        expect(rejected.approved_at).toBeNull();

        // A rejected claim carrying an approval timestamp is refused by 0006's half.
        await expect(
          tx.query("UPDATE crm.expense_claim SET approved_at = now() WHERE id = $1", [claim.id]),
        ).rejects.toThrow(/expense_claim_approved_fields/);
      });
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        // …and a submitted one carrying a rejection timestamp by 0030's.
        await expect(
          tx.query("UPDATE crm.expense_claim SET rejected_at = now() WHERE id = $1", [claim.id]),
        ).rejects.toThrow(/expense_claim_rejected_fields/);
      });
    });

    it("keeps the snapshot, which the snapshot CHECK requires outside draft", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        expect(
          (await rejectClaim(tx, TENANT, claim.id, MGR, new Date())).erp_ledger_account_code,
        ).toBe("6200");
      });
    });

    it("cannot reject an approved claim — the posting is already handed over", async () => {
      const id = await approved();
      await inTenant(async (tx) => {
        await expect(rejectClaim(tx, TENANT, id, MGR, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });

    it("is terminal", async () => {
      await inTenant(async (tx) => {
        const claim = await submitted(tx);
        await rejectClaim(tx, TENANT, claim.id, MGR, new Date());
        await expect(approveClaim(tx, TENANT, claim.id, MGR, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });
  });

  describe("posting to the ERP", () => {
    it("appends exactly one outbox row, in the same transaction as the state change", async () => {
      const id = await approved();
      const result = await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      expect(result.enqueued).toBe(true);
      expect(result.claim.state).toBe("posted");

      await inTenant(async (tx) => {
        const { rows } = await tx.query<{
          entity: string;
          operation: string;
          target_record_id: string;
          source_table: string;
          source_id: string;
          payload: Record<string, unknown>;
        }>(
          `SELECT entity, operation, target_record_id, source_table, source_id, payload
             FROM crm.outbox WHERE tenant_id = $1 AND source_id = $2`,
          [TENANT, id],
        );
        expect(rows.length).toBe(1);
        expect(rows[0]).toMatchObject({
          entity: "Expense",
          operation: "create",
          target_record_id: expenseRecordId(id),
          source_table: "crm.expense_claim",
          source_id: id,
        });
        expect(rows[0]!.payload).toMatchObject({
          employee_id: "emp-expst-1",
          category: "other",
          amount: "1234.50",
          currency: "GBP",
          incurred_on: "2026-09-01",
          state: "approved",
        });
      });
    });

    it("carries the snapshotted account and cost centre in the description", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ payload: { description: string } }>(
          "SELECT payload FROM crm.outbox WHERE tenant_id = $1 AND source_id = $2",
          [TENANT, id],
        );
        expect(rows[0]!.payload.description).toContain("S&M account 6200");
        expect(rows[0]!.payload.description).toContain("cost centre CC-SM");
        expect(rows[0]!.payload.description).toContain("category congress");
      });
    });

    it("writes the ERP id it minted, and leaves the journal entry id null", async () => {
      const id = await approved();
      const { claim } = await inTenant((tx) => postClaim(tx, TENANT, id, new Date("2026-09-04T09:00:00Z")));
      expect(claim.erp_expense_id).toBe(expenseRecordId(id));
      // Null because no JournalEntry is posted: there is no LedgerAccount record id to
      // debit and no credit account named anywhere. See the header of posting.ts.
      expect(claim.erp_journal_entry_id).toBeNull();
      expect(claim.posted_at?.toISOString()).toBe("2026-09-04T09:00:00.000Z");
    });

    it("REFUSES when the rep has no erp_employee_id", async () => {
      const id = await approved(ORPHAN);
      await inTenant(async (tx) => {
        const err = await postClaim(tx, TENANT, id, new Date()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RepNotMappedToEmployeeError);
      });
      await inTenant(async (tx) => {
        expect((await requireClaim(tx, TENANT, id)).state).toBe("approved");
        expect(await claimPostingStatus(tx, TENANT, id)).toEqual([]);
      });
    });

    it("cannot post an unapproved claim", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        await submitClaim(tx, TENANT, claim.id, new Date());
        await expect(postClaim(tx, TENANT, claim.id, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });

    it("cannot post twice", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        await expect(postClaim(tx, TENANT, id, new Date())).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });

    it("collapses a re-enqueue of the same write instead of making a second ERP record", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        const claim = await requireClaim(tx, TENANT, id);
        expect(await enqueueExpenseCreate(tx, TENANT, claim, "emp-expst-1")).toBe(false);
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM crm.outbox WHERE tenant_id = $1 AND source_id = $2",
          [TENANT, id],
        );
        expect(rows[0]!.n).toBe("1");
      });
    });

    it("attributes the outbox row to the rep, so a dead letter reaches them (0022)", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ rep: string | null }>(
          `SELECT crm.outbox_recipient(source_table, source_id) AS rep
             FROM crm.outbox WHERE tenant_id = $1 AND source_id = $2`,
          [TENANT, id],
        );
        expect(rows[0]!.rep).toBe(REP);
      });
    });
  });

  describe("reimbursing", () => {
    it("enqueues the reimburse transition against the id the create minted", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      const out = await inTenant((tx) => reimburseClaim(tx, TENANT, id));
      expect(out.enqueued).toBe(true);
      expect(out.claim.state).toBe("reimbursed");

      await inTenant(async (tx) => {
        const statuses = await claimPostingStatus(tx, TENANT, id);
        expect(statuses.map((s) => s.operation)).toEqual(["create", "transition:reimburse"]);
        expect(statuses.every((s) => s.entity === "Expense")).toBe(true);
      });
    });

    it("is a SEPARATE outbox row from the create, not a sibling enqueued with it", async () => {
      // An invalid transition answers 409, which the relay's classifier reads as
      // already_delivered — so a transition delivered before its create would be
      // recorded as a success that never happened. One row per CRM state change is what
      // keeps that impossible.
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        expect((await claimPostingStatus(tx, TENANT, id)).length).toBe(1);
      });
      await inTenant((tx) => reimburseClaim(tx, TENANT, id));
      await inTenant(async (tx) => {
        expect((await claimPostingStatus(tx, TENANT, id)).length).toBe(2);
      });
    });

    it("cannot reimburse a claim that was never posted", async () => {
      const id = await approved();
      await inTenant(async (tx) => {
        await expect(reimburseClaim(tx, TENANT, id)).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });

    it("refuses a posted claim carrying no ERP id rather than re-minting one", async () => {
      const id = await approved();
      await inTenant(async (tx) => {
        await tx.query(
          `UPDATE crm.expense_claim SET state = 'posted', posted_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        );
      });
      await inTenant(async (tx) => {
        await expect(reimburseClaim(tx, TENANT, id)).rejects.toBeInstanceOf(
          MissingErpExpenseIdError,
        );
      });
    });

    it("is terminal", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant((tx) => reimburseClaim(tx, TENANT, id));
      await inTenant(async (tx) => {
        await expect(reimburseClaim(tx, TENANT, id)).rejects.toBeInstanceOf(
          InvalidExpenseClaimTransitionError,
        );
      });
    });
  });

  describe("what is waiting to be posted", () => {
    it("lists approved claims with no journal entry, oldest spend first", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        for (const day of ["2026-09-10", "2026-09-01"]) {
          const claim = await createClaim(tx, TENANT, {
            repProfileId: REP,
            crmCategory: "congress",
            amount: "10.00",
            currency: "GBP",
            incurredOn: day,
          });
          await submitClaim(tx, TENANT, claim.id, new Date());
          await approveClaim(tx, TENANT, claim.id, MGR, new Date());
        }
        const waiting = await unpostedApprovedClaims(tx, TENANT);
        expect(waiting.map((c) => c.incurred_on)).toEqual(["2026-09-01", "2026-09-10"]);
      });
    });

    it("drops a claim once it is posted", async () => {
      const id = await approved();
      await inTenant(async (tx) => {
        expect((await unpostedApprovedClaims(tx, TENANT)).length).toBe(1);
      });
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        expect(await unpostedApprovedClaims(tx, TENANT)).toEqual([]);
      });
    });

    it("ignores draft and submitted claims", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        await draft(tx);
        const submitted = await draft(tx);
        await submitClaim(tx, TENANT, submitted.id, new Date());
        expect(await unpostedApprovedClaims(tx, TENANT)).toEqual([]);
      });
    });
  });

  describe("telling the UI the truth about the ERP", () => {
    it("reports nothing for a claim that has not been posted", async () => {
      await inTenant(async (tx) => {
        await map(tx);
        const claim = await draft(tx);
        expect(await claimPostingStatus(tx, TENANT, claim.id)).toEqual([]);
      });
    });

    it("reports a pending write as pending, with no delivery time", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        const [status] = await claimPostingStatus(tx, TENANT, id);
        expect(status).toMatchObject({ state: "pending", attempts: 0, delivered_at: null });
      });
    });

    it("surfaces a dead letter's reason, the one case the two sides will never agree", async () => {
      const id = await approved();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date()));
      await inTenant(async (tx) => {
        await tx.query(
          `UPDATE crm.outbox SET state = 'dead', dead_at = now(),
                                 dead_reason = 'forbidden: the service credential lacks the required role'
            WHERE tenant_id = $1 AND source_id = $2`,
          [TENANT, id],
        );
      });
      await inTenant(async (tx) => {
        const [status] = await claimPostingStatus(tx, TENANT, id);
        expect(status?.state).toBe("dead");
        expect(status?.dead_reason).toContain("service credential");
        // The claim still reads `posted`: the CRM decided, the ERP refused, and the gap
        // is the thing to show rather than hide.
        expect((await requireClaim(tx, TENANT, id)).state).toBe("posted");
      });
    });
  });
});
