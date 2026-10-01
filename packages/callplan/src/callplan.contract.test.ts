import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_CALLPLAN as TENANT, testPool } from "@crm/db/testing";

import {
  ApprovalRefusedError,
  DuplicatePlanError,
  DuplicateTargetError,
  InvalidPlanTransitionError,
  PlanFrozenError,
  TargetOutsideTerritoryError,
} from "./errors.js";
import type { CallPlan, Cycle } from "./store.js";
import {
  activateCycle,
  addTarget,
  approvePlan,
  createCycle,
  createPlan,
  cycleOn,
  getPlan,
  listTargets,
  livePlanFor,
  planAdherence,
  planSummary,
  removeTarget,
  returnPlanToDraft,
  setPlanProducts,
  submitPlan,
  supersedePlan,
  withdrawPlan,
} from "./store.js";

/**
 * Call plans against a real Postgres.
 *
 * Every rule asserted here lives in SQL (0015/0016) rather than in the store, so
 * these tests are the only way to know they hold — and they are the rules that
 * decide what a territory review and an incentive scheme are computed from.
 */
describe("call plans", () => {
  let pool: Pool;
  let client: PoolClient;

  // Three reps and a two-level hierarchy: the manager covers the region, so they
  // manage the rep's territory; the peer covers the same territory as the rep but
  // manages nothing, which is what makes the approval test meaningful.
  const REP = "ca100000-0000-4000-8000-000000000001";
  const MANAGER = "ca200000-0000-4000-8000-000000000002";
  const PEER = "ca300000-0000-4000-8000-000000000003";
  const REGION = "ca400000-0000-4000-8000-000000000004";
  const TERRITORY = "ca500000-0000-4000-8000-000000000005";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");

    await inTenant(async (tx) => {
      for (const [id, subject, number, name] of [
        [REP, "cp-rep", "CP-1", "Plan Rep"],
        [MANAGER, "cp-mgr", "CP-2", "Plan Manager"],
        [PEER, "cp-peer", "CP-3", "Plan Peer"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, number, name],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'CP-REGION','Region')
         ON CONFLICT DO NOTHING`,
        [REGION, TENANT],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name, parent_id) VALUES ($1,$2,'CP-TERR','Territory',$3)
         ON CONFLICT DO NOTHING`,
        [TERRITORY, TENANT, REGION],
      );
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary','2026-01-01'), ($1,$4,$5,'manager','2026-01-01'), ($1,$2,$6,'primary','2026-01-01')
         ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY, REP, REGION, MANAGER, PEER],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
         VALUES ($1,$2,'CP-ACC-1','2026-01-01'), ($1,$2,'CP-ACC-2','2026-01-01')
         ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY],
      );
    });
  });

  /**
   * Asserts a refusal without poisoning the transaction.
   *
   * Postgres aborts the whole transaction on any error, so a test that checks two
   * refusals in a row — or checks one and then carries on — must wrap each in a
   * savepoint. Without this the second assertion sees "current transaction is
   * aborted" and passes or fails for the wrong reason.
   */
  const refuses = async (tx: PoolClient, fn: () => Promise<unknown>): Promise<Error> => {
    await tx.query("SAVEPOINT expect_refusal");
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    await tx.query("ROLLBACK TO SAVEPOINT expect_refusal");
    if (caught === undefined) throw new Error("expected the database to refuse, but it accepted");
    return caught as Error;
  };

  const FROZEN_TABLES = [
    "crm.visit",
    "crm.call_plan",
    "crm.call_plan_target",
    "crm.call_plan_product",
  ] as const;

  /**
   * Clears the fixture's plans.
   *
   * The freeze rules in 0016 refuse to let anything rewrite an approved plan — which
   * includes this cleanup, correctly. So it disables the triggers explicitly for the
   * duration rather than quietly finding a path around them: crm_app owns these
   * tables and may, and doing it in the open keeps the rules honest everywhere else.
   */
  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      // crm.visit is in the list because a completed visit refuses deletion too
      // (0013) — the adherence tests create them, and that rule applies to fixtures.
      for (const table of FROZEN_TABLES) {
        await tx.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      try {
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.call_plan_target WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.call_plan_product WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.call_plan WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.cycle WHERE tenant_id = $1", [TENANT]);
      } finally {
        for (const table of FROZEN_TABLES) {
          await tx.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
        }
      }
    });
  };

  afterAll(async () => {
    await reset();
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  beforeEach(reset);

  const aCycle = (tx: PoolClient): Promise<Cycle> =>
    createCycle(tx, TENANT, { code: "CP-Q4", name: "Q4", startsOn: "2026-10-01", endsOn: "2026-12-31" });

  describe("cycles", () => {
    it("creates and activates one", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        expect((await cycleOn(tx, "2026-11-15"))?.id).toBe(cycle.id);
        expect((await activateCycle(tx, cycle.id)).status).toBe("active");
      });
    });

    it("refuses a cycle that ends before it starts", async () => {
      await expect(
        inTenant((tx) =>
          createCycle(tx, TENANT, { code: "CP-BAD", name: "Bad", startsOn: "2026-12-01", endsOn: "2026-11-01" }),
        ),
      ).rejects.toThrow(/cycle_dates_ordered|ends_on/);
    });

    it("refuses a cycle longer than a year, which is almost always a mistyped year", async () => {
      await expect(
        inTenant((tx) =>
          createCycle(tx, TENANT, { code: "CP-LONG", name: "Long", startsOn: "2026-01-01", endsOn: "2028-01-01" }),
        ),
      ).rejects.toThrow(/cycle_plausible_length/);
    });

    it("refuses a malformed date before it reaches the database", async () => {
      await expect(
        inTenant((tx) =>
          createCycle(tx, TENANT, { code: "CP-X", name: "X", startsOn: "01/10/2026", endsOn: "2026-12-31" }),
        ),
      ).rejects.toThrow(/must be YYYY-MM-DD/);
    });
  });

  describe("targets", () => {
    it("accepts an account the rep covers during the cycle", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        const target = await addTarget(tx, TENANT, {
          planId: plan.id,
          erpAccountId: "CP-ACC-1",
          targetCalls: 2,
          segment: "A",
        });
        expect(target.target_calls).toBe(2);
        expect(await listTargets(tx, plan.id)).toHaveLength(1);
      });
    });

    /**
     * Planning calls on someone else's customers is either a mistake or an attempt
     * to claim their activity. The ERP cannot express the question at all — any
     * sales_rep token there sees every account in the tenant.
     */
    it("refuses an account outside the rep's territory", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await expect(
          addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-NOT-MINE", targetCalls: 1 }),
        ).rejects.toThrow(TargetOutsideTerritoryError);
      });
    });

    /**
     * Coverage is tested across the WHOLE cycle, not sampled at its first day. A rep
     * who picks up an account in week two may legitimately plan to call on it, and
     * the effective-dated assignment tables exist precisely so that is answerable.
     */
    it("accepts an account the rep only gains mid-cycle", async () => {
      await inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
           VALUES ($1,$2,'CP-LATE','2026-11-15')`,
          [TENANT, TERRITORY],
        );
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        const target = await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-LATE", targetCalls: 1 });
        expect(target.erp_account_id).toBe("CP-LATE");
        await tx.query("DELETE FROM crm.account_assignment WHERE erp_account_id = 'CP-LATE'");
      });
    });

    /**
     * NULLS NOT DISTINCT. A plain UNIQUE treats two NULL contacts as different, so
     * the same account could be targeted twice at institution level and both rows
     * would count against adherence separately.
     */
    it("refuses the same account twice at institution level", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: 1 });
        await expect(
          addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: 3 }),
        ).rejects.toThrow(DuplicateTargetError);
      });
    });

    it("allows the same account targeted for two different contacts", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", erpContactId: "C-1", targetCalls: 1 });
        await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", erpContactId: "C-2", targetCalls: 1 });
        expect(await listTargets(tx, plan.id)).toHaveLength(2);
      });
    });

    it("refuses a target of zero or an implausible number of calls", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        for (const n of [0, -1, 101]) {
          const err = await refuses(tx, () =>
            addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: n }),
          );
          expect(err.message).toMatch(/target_calls/);
        }
      });
    });
  });

  describe("the lifecycle", () => {
    it("runs draft → submitted → approved", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: 2 });
        expect((await submitPlan(tx, plan.id, REP)).status).toBe("submitted");
        const approved = await approvePlan(tx, plan.id, MANAGER, { note: "looks right" });
        expect(approved.status).toBe("approved");
        expect(approved.approved_by).toBe(MANAGER);
      });
    });

    it("allows a submitted plan to be sent back for rework", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await submitPlan(tx, plan.id, REP);
        expect((await returnPlanToDraft(tx, plan.id)).status).toBe("draft");
        // Editable again, which is the point of sending it back.
        await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-2", targetCalls: 1 });
      });
    });

    it("refuses a move the lifecycle map does not allow", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        // draft -> approved skips review entirely.
        expect(await refuses(tx, () => approvePlan(tx, plan.id, MANAGER))).toBeInstanceOf(
          InvalidPlanTransitionError,
        );
        await submitPlan(tx, plan.id, REP);
        await approvePlan(tx, plan.id, MANAGER);
        // An approved plan is superseded, never withdrawn: withdrawing it would make a
        // commitment disappear rather than be replaced.
        expect(await refuses(tx, () => withdrawPlan(tx, plan.id))).toBeInstanceOf(InvalidPlanTransitionError);
      });
    });

    it("permits one live plan per rep and cycle", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await expect(createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP })).rejects.toThrow(
          DuplicatePlanError,
        );
      });
    });
  });

  describe("approval", () => {
    /** Four-eyes: the rep cannot approve their own plan. */
    it("refuses self-approval", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await submitPlan(tx, plan.id, REP);
        await expect(approvePlan(tx, plan.id, REP)).rejects.toThrow(ApprovalRefusedError);
      });
    });

    it("refuses approval by whoever submitted it", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        // A manager builds the plan for the rep; a different pair of eyes must sign.
        await submitPlan(tx, plan.id, MANAGER);
        await expect(approvePlan(tx, plan.id, MANAGER)).rejects.toThrow(ApprovalRefusedError);
      });
    });

    /**
     * Four-eyes says "someone else". This says "the RIGHT someone else" — without it
     * any rep in the tenant could approve any other's plan and the signature would be
     * decorative.
     */
    it("refuses a peer who does not manage the rep's territory", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await submitPlan(tx, plan.id, REP);
        const err = await refuses(tx, () => approvePlan(tx, plan.id, PEER));
        expect(err).toBeInstanceOf(ApprovalRefusedError);
        expect(err.message).toMatch(/does not manage any territory/);
      });
    });

    it("accepts a manager assigned above the rep's territory", async () => {
      await inTenant(async (tx) => {
        // MANAGER holds the REGION, the rep holds a child of it. Inherited authority
        // through the hierarchy, which is what the recursive walk is for.
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await submitPlan(tx, plan.id, REP);
        expect((await approvePlan(tx, plan.id, MANAGER)).status).toBe("approved");
      });
    });
  });

  describe("the freeze", () => {
    const approvedPlan = async (tx: PoolClient): Promise<CallPlan> => {
      const cycle = await aCycle(tx);
      const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
      await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: 2 });
      await setPlanProducts(tx, TENANT, plan.id, [{ erpItemId: "ITEM-1" }]);
      await submitPlan(tx, plan.id, REP);
      await approvePlan(tx, plan.id, MANAGER);
      return plan;
    };

    /**
     * If "we planned three calls" can be edited after the calls happened, adherence
     * measures nothing. The denominator lives in the target rows, so they freeze too.
     */
    it("refuses a new, changed or removed target", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        expect(
          await refuses(tx, () => addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-2", targetCalls: 1 })),
        ).toBeInstanceOf(PlanFrozenError);

        const [target] = await listTargets(tx, plan.id);
        expect(await refuses(tx, () => removeTarget(tx, target!.id))).toBeInstanceOf(PlanFrozenError);
        expect(
          (await refuses(tx, () =>
            tx.query("UPDATE crm.call_plan_target SET target_calls = 99 WHERE id = $1", [target!.id]),
          )).message,
        ).toMatch(/are fixed/);
      });
    });

    it("refuses a changed product emphasis", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        await expect(setPlanProducts(tx, TENANT, plan.id, [{ erpItemId: "ITEM-2" }])).rejects.toThrow(PlanFrozenError);
      });
    });

    it("refuses re-pointing an approved plan at a different rep", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        await expect(
          tx.query("UPDATE crm.call_plan SET rep_profile_id = $2 WHERE id = $1", [plan.id, PEER]),
        ).rejects.toThrow(/are fixed/);
      });
    });

    it("refuses deleting an approved plan", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        await expect(tx.query("DELETE FROM crm.call_plan WHERE id = $1", [plan.id])).rejects.toThrow(
          /cannot be deleted/,
        );
      });
    });

    /**
     * The escape hatch that makes the freeze tolerable, and the ordering it needs:
     * the original must leave the live set before the replacement enters it, and
     * `superseded` requires a successor that does not exist yet. The deferred
     * self-FK (0015) is what resolves that.
     */
    it("supersedes with a fresh draft that inherits the targets", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        const { superseded, replacement } = await supersedePlan(tx, TENANT, plan.id);

        expect(superseded.status).toBe("superseded");
        expect(superseded.superseded_by).toBe(replacement.id);
        expect(replacement.status).toBe("draft");
        expect(replacement.revision).toBe(2);
        expect(replacement.rep_profile_id).toBe(REP);

        // The targets came along, and the replacement is editable.
        expect(await listTargets(tx, replacement.id)).toHaveLength(1);
        await addTarget(tx, TENANT, { planId: replacement.id, erpAccountId: "CP-ACC-2", targetCalls: 1 });

        // And "the plan for this rep this cycle" still has exactly one answer.
        expect((await livePlanFor(tx, { cycleId: plan.cycle_id, repProfileId: REP }))?.id).toBe(replacement.id);
        expect((await getPlan(tx, plan.id))?.status).toBe("superseded");
      });
    });

    it("can supersede without copying, for a plan being rebuilt", async () => {
      await inTenant(async (tx) => {
        const plan = await approvedPlan(tx);
        const { replacement } = await supersedePlan(tx, TENANT, plan.id, { copyTargets: false });
        expect(await listTargets(tx, replacement.id)).toHaveLength(0);
      });
    });
  });

  describe("adherence", () => {
    const planWithTargets = async (tx: PoolClient): Promise<CallPlan> => {
      const cycle = await aCycle(tx);
      const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
      await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-1", targetCalls: 2 });
      await addTarget(tx, TENANT, { planId: plan.id, erpAccountId: "CP-ACC-2", targetCalls: 3 });
      return plan;
    };

    const visit = (
      tx: PoolClient,
      account: string,
      occurredAt: string,
      opts: { status?: string; contact?: string | null; recordedAt?: string } = {},
    ): Promise<unknown> =>
      tx.query(
        `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, erp_contact_id, status, occurred_at, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`,
        [TENANT, REP, account, opts.contact ?? null, opts.status ?? "completed", occurredAt, opts.recordedAt ?? null],
      );

    it("counts completed visits inside the cycle", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2026-10-05T09:00:00Z");
        await visit(tx, "CP-ACC-1", "2026-11-05T09:00:00Z");

        const rows = await planAdherence(tx, plan.id);
        const acc1 = rows.find((r) => r.erp_account_id === "CP-ACC-1")!;
        expect(acc1.actual_calls).toBe(2);
        expect(acc1.met).toBe(true);
        expect(rows.find((r) => r.erp_account_id === "CP-ACC-2")!.met).toBe(false);
      });
    });

    it("ignores a visit outside the cycle window", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2027-01-05T09:00:00Z");
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(0);
      });
    });

    it("ignores a visit that is not completed", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2026-10-05T09:00:00Z", { status: "in_progress" });
        await visit(tx, "CP-ACC-1", "2026-10-06T09:00:00Z", { status: "planned" });
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(0);
      });
    });

    /**
     * `occurred_at`, never `recorded_at`. A visit made on the cycle's last day and
     * synced two days later belongs to the cycle it happened in; using the sync time
     * would move activity between cycles according to the strength of a phone signal.
     */
    it("uses when the visit happened, not when it synced", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2026-12-31T18:00:00Z", { recordedAt: "2027-01-03T08:00:00Z" });
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(1);
      });
    });

    it("counts only the named contact for a contact-level target", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        await addTarget(tx, TENANT, {
          planId: plan.id,
          erpAccountId: "CP-ACC-1",
          erpContactId: "DR-A",
          targetCalls: 1,
        });
        await visit(tx, "CP-ACC-1", "2026-10-05T09:00:00Z", { contact: "DR-B" });
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(0);
        await visit(tx, "CP-ACC-1", "2026-10-06T09:00:00Z", { contact: "DR-A" });
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(1);
      });
    });

    it("counts every visit to an institution-level target, contact or not", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2026-10-05T09:00:00Z", { contact: "DR-A" });
        await visit(tx, "CP-ACC-1", "2026-10-06T09:00:00Z");
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(2);
      });
    });

    /**
     * Coverage and attainment are different questions and reporting only the second
     * is how a field force looks compliant while a third of its customers were never
     * seen. The per-target cap is what separates them.
     */
    it("distinguishes coverage from attainment, and caps over-visiting", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx); // 2 + 3 = 5 planned across 2 targets
        for (const day of ["05", "06", "07", "08", "09", "10"]) {
          await visit(tx, "CP-ACC-1", `2026-10-${day}T09:00:00Z`);
        }
        const summary = await planSummary(tx, plan.id);
        expect(summary.targets).toBe(2);
        expect(summary.targets_met).toBe(1);
        expect(summary.targets_touched).toBe(1);
        expect(summary.planned_calls).toBe(5);
        expect(summary.actual_calls).toBe(6);
        expect(summary.coverage_pct).toBe("50.0");
        // Six calls against five planned is NOT 120%: the one target's surplus is
        // capped at its own target, so attainment reads 2/5.
        expect(summary.attainment_pct).toBe("40.0");
      });
    });

    it("reports null percentages for a plan with no targets rather than a made-up zero", async () => {
      await inTenant(async (tx) => {
        const cycle = await aCycle(tx);
        const plan = await createPlan(tx, TENANT, { cycleId: cycle.id, repProfileId: REP });
        const summary = await planSummary(tx, plan.id);
        expect(summary.targets).toBe(0);
        expect(summary.coverage_pct).toBeNull();
        expect(summary.attainment_pct).toBeNull();
      });
    });

    it("keeps measuring a superseded plan, which is what makes the history useful", async () => {
      await inTenant(async (tx) => {
        const plan = await planWithTargets(tx);
        await visit(tx, "CP-ACC-1", "2026-10-05T09:00:00Z");
        // Superseding is for a plan that cannot be edited, so it only applies to an
        // approved one — a draft can simply be changed.
        await submitPlan(tx, plan.id, REP);
        await approvePlan(tx, plan.id, MANAGER);
        await supersedePlan(tx, TENANT, plan.id, { copyTargets: false });
        // The visit is still counted against what was originally agreed. A plan is a
        // record of a commitment, so superseding it must not erase the score.
        expect((await planAdherence(tx, plan.id))[0]!.actual_calls).toBe(1);
      });
    });
  });
});
