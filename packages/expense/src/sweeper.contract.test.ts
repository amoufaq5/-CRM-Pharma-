import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_EXPENSE_SWEEP as TENANT, appPool } from "@crm/db/testing";
import { inbox } from "@crm/notify";
import { claimBatch, markDead, markDelivered, raiseDeadLetterAlarm, reviveDeadLetter } from "@crm/relay";

import { upsertAccountMapping } from "./accounts.js";
import { expenseRecordId } from "./posting.js";
import {
  ClientAlreadyInTenantContextError,
  summariseExpensePostSweep,
  sweepApprovedExpenseClaims,
} from "./sweeper.js";
import { approveClaim, createClaim, getClaim, postClaim, submitClaim } from "./store.js";

/**
 * The `expense_post` sweep against a real Postgres.
 *
 * It has to be a real one twice over. The sweeper's whole shape is transactional — one
 * transaction per claim, so a refusal rolls back that claim and nothing else — and a fake
 * connection that records `{sql, params}` cannot tell a rollback from a commit. And the
 * two mechanisms it leans on for idempotence instead of adding a third are both database
 * facts: `postClaim`'s guarded `WHERE state = 'approved'` and the unique index behind
 * `enqueueOutbox`.
 *
 * `TENANT_EXPENSE_SWEEP` is this file's own reserved tenant.
 */
describe("the expense posting sweep", () => {
  let pool: Pool;
  /** Fixtures. Always used through `inTenant`. */
  let client: PoolClient;
  /** Handed to the sweeper, which opens its own transactions and so needs a bare client. */
  let sweepClient: PoolClient;
  /** A second scheduler instance, for the concurrency case. */
  let rivalClient: PoolClient;

  const REP = "ec100000-0000-4000-8000-000000000001";
  const OTHER_REP = "ec200000-0000-4000-8000-000000000002";
  const MGR = "ec300000-0000-4000-8000-000000000003";
  /** Deliberately never reconciled: `erp_employee_id` stays null, so posting is refused. */
  const ORPHAN = "ec400000-0000-4000-8000-000000000004";
  const TERRITORY = "ec500000-0000-4000-8000-000000000005";

  const NOW = new Date("2026-09-20T07:30:00Z");

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const sweep = (
    options: Parameters<typeof sweepApprovedExpenseClaims>[2] = {},
  ): ReturnType<typeof sweepApprovedExpenseClaims> =>
    sweepApprovedExpenseClaims(sweepClient, TENANT, { asOf: NOW, ...options });

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    sweepClient = await pool.connect();
    rivalClient = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, employee, name, erpId] of [
        [REP, "expensesweep-rep", "E-EXPSW-1", "Sweep Rep", "emp-expsw-1"],
        [OTHER_REP, "expensesweep-other", "E-EXPSW-2", "Other Sweep Rep", "emp-expsw-2"],
        [MGR, "expensesweep-mgr", "E-EXPSW-3", "Sweep Manager", "emp-expsw-3"],
        [ORPHAN, "expensesweep-orphan", "E-EXPSW-4", "Unreconciled Rep", null],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile
             (id, tenant_id, subject, employee_number, display_name, erp_employee_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, employee, name, erpId],
        );
      }
      // The orphan needs a supervisor, because the escalation is half of what makes a
      // blocked claim visible to somebody who can act on it.
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'EXPSW','Sweep')
         ON CONFLICT DO NOTHING`,
        [TERRITORY, TENANT],
      );
      for (const [rep, role] of [
        [ORPHAN, "primary"],
        [MGR, "manager"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.territory_assignment
             (tenant_id, territory_id, rep_profile_id, role, valid_from)
           VALUES ($1,$2,$3,$4,'2026-01-01') ON CONFLICT DO NOTHING`,
          [TENANT, TERRITORY, rep, role],
        );
      }
    });
  });

  afterAll(async () => {
    await clear();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    client?.release();
    sweepClient?.release();
    rivalClient?.release();
    await pool?.end();
  });

  const clear = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      // Deliberately has no FK to crm.outbox (0036), so it outlives the queue row and
      // would otherwise accumulate across runs of the dead-write cases below.
      await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
      await tx.query("UPDATE crm.rep_profile SET erp_employee_id = $2 WHERE id = $1", [
        ORPHAN,
        null,
      ]);
    });
  };

  beforeEach(clear);

  /** A mapped, submitted, approved claim: the only state the sweep acts on. */
  const approvedClaim = async (
    rep = REP,
    incurredOn = "2026-09-01",
    amount = "1234.50",
  ): Promise<string> =>
    inTenant(async (tx) => {
      await upsertAccountMapping(tx, TENANT, {
        crmCategory: "congress",
        erpLedgerAccountCode: "6200",
        erpCostCenterCode: "CC-SM",
      });
      const claim = await createClaim(tx, TENANT, {
        repProfileId: rep,
        crmCategory: "congress",
        amount,
        currency: "GBP",
        incurredOn,
        description: "Respiratory congress",
      });
      await submitClaim(tx, TENANT, claim.id, new Date("2026-09-02T09:00:00Z"));
      await approveClaim(tx, TENANT, claim.id, MGR, new Date("2026-09-03T09:00:00Z"));
      return claim.id;
    });

  const outboxRows = (): Promise<readonly { entity: string; operation: string; target_record_id: string; source_id: string }[]> =>
    inTenant(async (tx) => {
      const { rows } = await tx.query<{
        entity: string;
        operation: string;
        target_record_id: string;
        source_id: string;
      }>(
        `SELECT entity, operation, target_record_id, source_id FROM crm.outbox
          WHERE tenant_id = $1 AND source_table = 'crm.expense_claim'
          ORDER BY seq`,
        [TENANT],
      );
      return rows;
    });

  describe("posting without a button", () => {
    it("posts an approved claim", async () => {
      const id = await approvedClaim();
      const result = await sweep();

      expect(result.considered).toBe(1);
      expect(result.posted).toBe(1);
      expect(result.blocked).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.outcomes[0]).toMatchObject({
        claimId: id,
        repProfileId: REP,
        status: "posted",
        erpExpenseId: expenseRecordId(id),
        enqueued: true,
      });
    });

    it("moves the claim to posted and stamps the sweep's own clock", async () => {
      const id = await approvedClaim();
      await sweep();

      const claim = await inTenant((tx) => getClaim(tx, TENANT, id));
      expect(claim?.state).toBe("posted");
      expect(claim?.posted_at?.toISOString()).toBe(NOW.toISOString());
      expect(claim?.erp_expense_id).toBe(expenseRecordId(id));
    });

    it("enqueues exactly one Expense create, addressed by the derived record id", async () => {
      const id = await approvedClaim();
      await sweep();

      expect(await outboxRows()).toEqual([
        {
          entity: "Expense",
          operation: "create",
          target_record_id: expenseRecordId(id),
          source_id: id,
        },
      ]);
    });

    it("takes the oldest spend first, so a closing month goes before yesterday", async () => {
      const recent = await approvedClaim(REP, "2026-09-15");
      const old = await approvedClaim(OTHER_REP, "2026-08-02");
      const result = await sweep();

      expect(result.outcomes.map((o) => o.claimId)).toEqual([old, recent]);
    });

    it("leaves draft, submitted and rejected claims alone", async () => {
      await inTenant(async (tx) => {
        await upsertAccountMapping(tx, TENANT, {
          crmCategory: "congress",
          erpLedgerAccountCode: "6200",
          erpCostCenterCode: null,
        });
        const draft = await createClaim(tx, TENANT, {
          repProfileId: REP,
          crmCategory: "congress",
          amount: "10.00",
          currency: "GBP",
          incurredOn: "2026-09-01",
        });
        const submitted = await createClaim(tx, TENANT, {
          repProfileId: REP,
          crmCategory: "congress",
          amount: "20.00",
          currency: "GBP",
          incurredOn: "2026-09-01",
        });
        await submitClaim(tx, TENANT, submitted.id, new Date("2026-09-02T09:00:00Z"));
        void draft;
      });

      const result = await sweep();
      expect(result.considered).toBe(0);
      expect(await outboxRows()).toEqual([]);
    });
  });

  describe("idempotence", () => {
    it("running twice over the same claim enqueues one row and posts it once", async () => {
      const id = await approvedClaim();

      const first = await sweep();
      const second = await sweep();

      expect(first.posted).toBe(1);
      // The second pass does not even see it: `unpostedApprovedClaims` selects on
      // `state = 'approved'`, which the first pass left behind.
      expect(second.considered).toBe(0);
      expect(second.posted).toBe(0);

      expect(await outboxRows()).toHaveLength(1);
      const claim = await inTenant((tx) => getClaim(tx, TENANT, id));
      expect(claim?.state).toBe("posted");
    });

    /**
     * The stale-transition skip, CONSTRUCTED rather than raced.
     *
     * This was two concurrent sweeps and a `skipped === 1` assertion, which failed about
     * one run in five — correctly: whether the loser ever SEES the claim depends on whether
     * its `unpostedApprovedClaims` commits before or after the winner's UPDATE. Lose that
     * race and the loser lists nothing, reports `considered: 0`, and there is no outcome of
     * any status to count. A test that needs an interleaving must produce it, not hope for
     * it.
     *
     * The interleaving comes from the database, which is the one place in this test that
     * can observe the sweep mid-pass: a one-shot trigger on `crm.outbox` posts claim B at
     * the moment claim A's outbox row is written. So the sweep lists [A, B] while both are
     * `approved`, posts A, and reaches B to find `state = 'posted'` — exactly the
     * transition the loser of a real race finds illegal.
     */
    it("reports a claim posted between the listing and the posting as skipped, not failed", async () => {
      const a = await approvedClaim(REP, "2026-09-01", "1000.00");
      const b = await approvedClaim(OTHER_REP, "2026-09-02", "2000.00");
      await inTenant(async (tx) => {
        await tx.query(
          `CREATE FUNCTION crm.test_post_other_claim() RETURNS trigger
             LANGUAGE plpgsql AS $fn$
           BEGIN
             UPDATE crm.expense_claim
                SET state = 'posted', posted_at = now(), erp_expense_id = 'rec_test_race'
              WHERE id = $claim$ AND state = 'approved';
             RETURN NEW;
           END $fn$`.replace("$claim$", `'${b}'::uuid`),
        );
        await tx.query(
          `CREATE TRIGGER test_race AFTER INSERT ON crm.outbox
             FOR EACH ROW EXECUTE FUNCTION crm.test_post_other_claim()`,
        );
      });

      try {
        const r = await sweep();
        expect(r.considered).toBe(2);
        expect(r.outcomes.filter((o) => o.status === "posted")).toHaveLength(1);
        expect(r.outcomes.filter((o) => o.status === "skipped")).toHaveLength(1);
        expect(r.outcomes.filter((o) => o.status === "failed")).toHaveLength(0);
        // The skip names the claim the trigger moved, not the one the sweep posted.
        expect(r.outcomes.find((o) => o.status === "skipped")?.claimId).toBe(b);
        expect(r.outcomes.find((o) => o.status === "posted")?.claimId).toBe(a);
        // One outbox row per claim at most, and B's came from nowhere — the skip did not
        // enqueue a second write for a claim somebody else had already handed over.
        expect((await outboxRows()).filter((row) => row.source_id === b)).toHaveLength(0);
      } finally {
        await inTenant(async (tx) => {
          await tx.query("DROP TRIGGER IF EXISTS test_race ON crm.outbox");
          await tx.query("DROP FUNCTION IF EXISTS crm.test_post_other_claim()");
        });
      }
    });

    /**
     * And the real race, asserted on what is actually invariant under it.
     *
     * Two scheduler instances in the same window: exactly one posting, exactly one outbox
     * row, no failure, and the claim ends `posted`. The loser's view is deliberately NOT
     * asserted — it legitimately either sees the row and skips it or never lists it at all,
     * and both are correct.
     */
    it("lets two scheduler instances share a window without double-posting", async () => {
      const id = await approvedClaim();
      const [a, b] = await Promise.all([
        sweep(),
        sweepApprovedExpenseClaims(rivalClient, TENANT, { asOf: NOW }),
      ]);

      const outcomes = [...a.outcomes, ...b.outcomes];
      expect(outcomes.filter((o) => o.status === "posted")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "failed")).toHaveLength(0);
      // Every outcome is one or the other: nothing is left in a third state.
      expect(outcomes.every((o) => o.status === "posted" || o.status === "skipped")).toBe(true);

      expect(await outboxRows()).toHaveLength(1);
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.state).toBe("posted");
    });

    it("does not re-post a claim an administrator posted by hand", async () => {
      const id = await approvedClaim();
      await inTenant((tx) => postClaim(tx, TENANT, id, new Date("2026-09-19T12:00:00Z")));

      const result = await sweep();
      expect(result.considered).toBe(0);
      expect(await outboxRows()).toHaveLength(1);
    });
  });

  describe("one claim's refusal is not every claim's", () => {
    it("posts every other rep's claim around an unmappable one", async () => {
      const stuck = await approvedClaim(ORPHAN, "2026-08-01");
      const first = await approvedClaim(REP, "2026-08-15");
      const second = await approvedClaim(OTHER_REP, "2026-09-01");

      const result = await sweep();

      expect(result.considered).toBe(3);
      expect(result.posted).toBe(2);
      expect(result.blocked).toBe(1);
      expect(result.outcomes[0]).toMatchObject({ claimId: stuck, status: "blocked" });
      expect(result.outcomes.slice(1).map((o) => o.claimId)).toEqual([first, second]);
    });

    it("commits the postings it managed, because each claim is its own transaction", async () => {
      // The blocked claim is the OLDEST, so its rollback happens before the two good
      // postings; a sweep in one transaction would have taken them with it.
      await approvedClaim(ORPHAN, "2026-08-01");
      const good = await approvedClaim(REP, "2026-08-15");
      await sweep();

      expect((await inTenant((tx) => getClaim(tx, TENANT, good)))?.state).toBe("posted");
      expect(await outboxRows()).toHaveLength(1);
    });

    it("leaves the blocked claim approved with nothing enqueued", async () => {
      const stuck = await approvedClaim(ORPHAN);
      await sweep();

      const claim = await inTenant((tx) => getClaim(tx, TENANT, stuck));
      expect(claim?.state).toBe("approved");
      expect(claim?.erp_expense_id).toBeNull();
      expect(claim?.posted_at).toBeNull();
      expect(await outboxRows()).toEqual([]);
    });

    it("names the claim and why in the per-claim outcome", async () => {
      const stuck = await approvedClaim(ORPHAN);
      const result = await sweep();

      const outcome = result.outcomes[0];
      expect(outcome).toMatchObject({ claimId: stuck, repProfileId: ORPHAN, status: "blocked" });
      expect(outcome?.status === "blocked" && outcome.reason).toContain("erp_employee_id");
    });
  });

  describe("telling someone about a claim that can never post", () => {
    it("tells the rep, as a warning rather than an alarm they cannot act on", async () => {
      const stuck = await approvedClaim(ORPHAN);
      const result = await sweep();
      expect(result.notified).toBe(2);

      const items = await inTenant((tx) => inbox(tx, ORPHAN));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "expense_post_blocked",
        severity: "warning",
        subject_table: "crm.expense_claim",
        subject_id: stuck,
      });
      expect(items[0]?.body).toContain("nothing is lost");
    });

    it("escalates to the supervisor as urgent, because that is where the fix is", async () => {
      await approvedClaim(ORPHAN);
      await sweep();

      const items = await inTenant((tx) => inbox(tx, MGR));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "expense_post_blocked", severity: "urgent" });
      expect(items[0]?.body).toContain("erp_employee_id");
    });

    it("carries the money and the account code, so the inbox needs no join", async () => {
      await approvedClaim(ORPHAN, "2026-08-11", "87.65");
      await sweep();

      const items = await inTenant((tx) => inbox(tx, ORPHAN));
      expect(items[0]?.payload).toMatchObject({
        amount: "87.65",
        currency: "GBP",
        incurredOn: "2026-08-11",
        crmCategory: "congress",
        erpLedgerAccountCode: "6200",
      });
    });

    it("tells them once, not once per pass", async () => {
      await approvedClaim(ORPHAN);
      const first = await sweep();
      const second = await sweep();
      const third = await sweep();

      expect(first.notified).toBe(2);
      // Deduped by `expense-post:<claim>:unmapped-rep`, which carries no date: the sweep
      // runs every five minutes and must not raise 288 notifications a day.
      expect(second.notified).toBe(0);
      expect(third.notified).toBe(0);
      expect(await inTenant((tx) => inbox(tx, ORPHAN))).toHaveLength(1);
    });

    it("still reports it blocked on every pass, so a green job is not silent about it", async () => {
      await approvedClaim(ORPHAN);
      await sweep();
      const second = await sweep();

      expect(second.considered).toBe(1);
      expect(second.blocked).toBe(1);
      expect(summariseExpensePostSweep(second)).toContain(":blocked");
    });

    it("posts the claim on the next pass once the rep is reconciled, with nobody pressing anything", async () => {
      const stuck = await approvedClaim(ORPHAN);
      expect((await sweep()).blocked).toBe(1);

      await inTenant((tx) =>
        tx.query("UPDATE crm.rep_profile SET erp_employee_id = $2 WHERE id = $1", [
          ORPHAN,
          "emp-expsw-4",
        ]),
      );

      const result = await sweep();
      expect(result.posted).toBe(1);
      expect((await inTenant((tx) => getClaim(tx, TENANT, stuck)))?.state).toBe("posted");
    });
  });

  describe("0031's retention branch for crm.expense_claim", () => {
    it("holds the notification back while the claim is still waiting", async () => {
      const stuck = await approvedClaim(ORPHAN);
      await sweep();

      const open = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ open: boolean; unknown: boolean }>(
          `SELECT crm.notification_subject_open('crm.expense_claim', $1) AS open,
                  crm.notification_subject_unknown('crm.expense_claim') AS unknown`,
          [stuck],
        );
        return rows[0]!;
      });
      // `unknown` false is the point of the branch: without it 0024's prune would count a
      // correctly wired producer as one that needs a branch adding.
      expect(open).toEqual({ open: true, unknown: false });
    });

    it("releases it once the claim has been posted", async () => {
      const stuck = await approvedClaim(ORPHAN);
      await sweep();
      await inTenant((tx) =>
        tx.query("UPDATE crm.rep_profile SET erp_employee_id = $2 WHERE id = $1", [
          ORPHAN,
          "emp-expsw-4",
        ]),
      );
      await sweep();

      const open = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ open: boolean }>(
          `SELECT crm.notification_subject_open('crm.expense_claim', $1) AS open`,
          [stuck],
        );
        return rows[0]!.open;
      });
      expect(open).toBe(false);
    });
  });

  describe("the batch limit", () => {
    it("reports more remaining when the batch fills", async () => {
      await approvedClaim(REP, "2026-08-01");
      await approvedClaim(OTHER_REP, "2026-08-02");

      const result = await sweep({ limit: 1 });
      expect(result.considered).toBe(1);
      expect(result.moreRemaining).toBe(true);
      expect(summariseExpensePostSweep(result)).toContain("more=true");
    });

    it("reports nothing remaining when it did not fill", async () => {
      await approvedClaim();
      const result = await sweep({ limit: 10 });
      expect(result.moreRemaining).toBe(false);
      expect(summariseExpensePostSweep(result)).not.toContain("more=true");
    });
  });

  /**
   * A POSTING INTENT THAT COLLAPSES ONTO A WRITE THE ERP HAS ALREADY REFUSED.
   *
   * `enqueueOutbox` is unique on `(tenant_id, entity, operation, target_record_id)`, and
   * three of the four states it can report for a collapsed duplicate mean the intent is
   * still alive. `dead` does not: the relay has stopped retrying that row, nothing else
   * will, and the enqueue achieved nothing. Until this block existed the sweep read it as
   * the ordinary replay, marked the claim `posted`, and reported `posted=1 replayed=1` —
   * a healthy-looking line over a reimbursement that no longer existed anywhere that would
   * retry it.
   *
   * EVERY DEAD ROW HERE IS GENUINELY DEAD. It is enqueued by the sweep itself, claimed by
   * a worker through `claimBatch`, killed through the relay's own `markDead` — which fires
   * `crm.outbox_dead_letter_record()` and writes the death episode — and announced through
   * `raiseDeadLetterAlarm`, exactly as `OutboxRelay.settle` does it. No fixture sets
   * `state` by hand, because a row whose `state` column says `dead` without the trigger
   * having run is not the row this code meets in production.
   */
  describe("a posting intent that collapses onto a dead ERP write", () => {
    /** Later than the rows' `now()` default, so `claimBatch`'s due check can see them. */
    const RELAY_CLOCK = new Date("2027-01-01T09:00:00Z");
    const DEAD_REASON = "ledger account 6200 does not exist in this tenant";

    /**
     * An approved claim whose `Expense` create is in the outbox and dead.
     *
     * Reconciles ORPHAN first — `clear()` unreconciles it before every test — because this
     * block needs a rep who CAN post and who has a supervisor for the escalation to reach.
     *
     * THE CLAIM IS PUT BACK TO `approved` BY HAND, and that is the honest reachable path
     * rather than a convenience. `postClaim` enqueues and transitions in ONE transaction,
     * so no crash can leave a dead row behind an approved claim; the only producer of this
     * claim's create row is `postClaim` itself; and `posted -> approved` is not a
     * transition the state machine offers. What remains is an operator repair in SQL — the
     * same hand-written path 0038 documents for a revive and `MissingErpExpenseIdError`
     * already names ("moved to 'posted' by something other than postClaim"). Nothing else
     * about the claim is touched.
     */
    const deadWrite = async (): Promise<{ claimId: string; outboxId: string }> => {
      await inTenant((tx) =>
        tx.query("UPDATE crm.rep_profile SET erp_employee_id = $2 WHERE id = $1", [
          ORPHAN,
          "emp-expsw-4",
        ]),
      );
      const claimId = await approvedClaim(ORPHAN);
      expect((await sweep()).posted).toBe(1);

      const outboxId = await inTenant(async (tx) => {
        const [row] = await claimBatch(tx, TENANT, "relay-worker-a", 10, RELAY_CLOCK);
        expect(row?.target_record_id).toBe(expenseRecordId(claimId));
        expect(await markDead(tx, row!.id, RELAY_CLOCK, DEAD_REASON)).toBe(true);
        // The relay raises this in the same transaction as the death, so the rep has
        // already been told about the WRITE before anything below runs.
        expect((await raiseDeadLetterAlarm(tx, TENANT, row!, DEAD_REASON)).repProfileId).toBe(
          ORPHAN,
        );
        return row!.id;
      });

      await inTenant((tx) =>
        tx.query(
          `UPDATE crm.expense_claim
              SET state = 'approved', posted_at = NULL, erp_expense_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, claimId],
        ),
      );
      return { claimId, outboxId };
    };

    const outboxState = (id: string): Promise<string | undefined> =>
      inTenant(async (tx) => {
        const { rows } = await tx.query<{ state: string }>(
          "SELECT state FROM crm.outbox WHERE tenant_id = $1 AND id = $2",
          [TENANT, id],
        );
        return rows[0]?.state;
      });

    it("leaves the claim approved instead of posting it against a write that will never land", async () => {
      const { claimId, outboxId } = await deadWrite();
      await sweep();

      const claim = await inTenant((tx) => getClaim(tx, TENANT, claimId));
      // `approved` is the only state anything retries from: `unpostedApprovedClaims`
      // selects on it, and `crm.notification_subject_open` calls an approved claim the open
      // thing the blocked signal is about (0031).
      expect(claim?.state).toBe("approved");
      expect(claim?.posted_at).toBeNull();
      expect(claim?.erp_expense_id).toBeNull();
      // And nothing was added to the queue: the enqueue collapsed, as it should.
      expect(await outboxRows()).toHaveLength(1);
      expect(await outboxState(outboxId)).toBe("dead");
    });

    it("reports it blocked, naming the dead row — not posted with a replay", async () => {
      const { claimId, outboxId } = await deadWrite();
      const result = await sweep();

      expect(result.posted).toBe(0);
      // The number this used to be counted as.
      expect(result.replayed).toBe(0);
      expect(result.blocked).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.outcomes[0]).toMatchObject({
        claimId,
        repProfileId: ORPHAN,
        status: "blocked",
        cause: "erp_write_dead",
        outboxId,
      });
      const outcome = result.outcomes[0];
      expect(outcome?.status === "blocked" && outcome.reason).toContain(DEAD_REASON);
    });

    it("names the cause in the job summary, because the two blocks are different jobs", async () => {
      const { claimId } = await deadWrite();
      const line = summariseExpensePostSweep(await sweep());

      expect(line).toContain("posted=0 replayed=0 skipped=0 blocked=1");
      expect(line).toContain(`${claimId}:blocked(erp_write_dead)`);
      // Reconciling a rep profile is not the same errand as retrying a dead write.
      expect(line).not.toContain("unmapped_rep");
    });

    it("tells the rep and their supervisor, as a signal distinct from the dead-letter alarm", async () => {
      const { claimId, outboxId } = await deadWrite();
      const result = await sweep();
      expect(result.notified).toBe(2);

      const repItems = await inTenant((tx) => inbox(tx, ORPHAN));
      // Two signals about one dead row and they are not duplicates: `erp_write_failed` is
      // the relay telling the rep a WRITE they believe landed did not, keyed to the outbox
      // row; `expense_post_blocked` is the sweep telling them a CLAIM is waiting behind it.
      expect(repItems.map((i) => i.kind).sort()).toEqual([
        "erp_write_failed",
        "expense_post_blocked",
      ]);
      const blocked = repItems.find((i) => i.kind === "expense_post_blocked");
      expect(blocked).toMatchObject({
        severity: "warning",
        subject_table: "crm.expense_claim",
        subject_id: claimId,
      });
      expect(blocked?.payload).toMatchObject({
        outboxId,
        erpEntity: "Expense",
        erpOperation: "create",
        deadReason: DEAD_REASON,
        reviveCount: 0,
      });

      const mgrItems = await inTenant((tx) => inbox(tx, MGR));
      const escalation = mgrItems.find((i) => i.kind === "expense_post_blocked");
      // Urgent up the chain: fixing the ERP side and pressing retry is their errand.
      expect(escalation?.severity).toBe("urgent");
      expect(escalation?.body).toContain(outboxId);
      expect(escalation?.body).toContain("/retry");
    });

    it("tells them once, not once per pass, and still reports blocked on every pass", async () => {
      await deadWrite();
      const first = await sweep();
      const second = await sweep();
      const third = await sweep();

      expect(first.notified).toBe(2);
      // Keyed `expense-post:<claim>:erp-write-dead:<outbox>:<reviveCount>` — no date in it,
      // so five-minute passes do not become 288 notifications a day.
      expect(second.notified).toBe(0);
      expect(third.notified).toBe(0);
      expect([second.blocked, third.blocked]).toEqual([1, 1]);
      expect(
        (await inTenant((tx) => inbox(tx, ORPHAN))).filter(
          (i) => i.kind === "expense_post_blocked",
        ),
      ).toHaveLength(1);
    });

    it("posts the claim once the dead letter is revived, with nobody touching the claim", async () => {
      const { claimId, outboxId } = await deadWrite();
      expect((await sweep()).blocked).toBe(1);

      // The one way back, and it carries an actor (rule 31).
      expect(await inTenant((tx) => reviveDeadLetter(tx, outboxId, MGR, RELAY_CLOCK))).toBe(true);

      const after = await sweep();
      expect(after.blocked).toBe(0);
      expect(after.posted).toBe(1);
      // The revived row is the write: collapsing onto it is the ordinary replay again.
      expect(after.replayed).toBe(1);
      expect((await inTenant((tx) => getClaim(tx, TENANT, claimId)))?.state).toBe("posted");
      expect(await outboxState(outboxId)).toBe("pending");
    });

    /**
     * THE TRUTH THIS CHANGE HAD TO PRESERVE.
     *
     * The same fixture, the same collapse, the row left alive — and the sweep must behave
     * exactly as it always did: posted, counted as a replay, and nobody told anything. If
     * these two cases ever report the same thing again, the distinction is gone, whichever
     * way round it went.
     */
    for (const [label, settle] of [
      ["in_flight", null],
      ["delivered", "delivered"],
    ] as const) {
      it(`stays silent when the row it collapsed onto is ${label}`, async () => {
        await inTenant((tx) =>
          tx.query("UPDATE crm.rep_profile SET erp_employee_id = $2 WHERE id = $1", [
            ORPHAN,
            "emp-expsw-4",
          ]),
        );
        const claimId = await approvedClaim(ORPHAN);
        expect((await sweep()).posted).toBe(1);
        const outboxId = await inTenant(async (tx) => {
          const [row] = await claimBatch(tx, TENANT, "relay-worker-a", 10, RELAY_CLOCK);
          if (settle !== null) {
            expect(await markDelivered(tx, row!.id, RELAY_CLOCK, { ok: true })).toBe(true);
          }
          return row!.id;
        });
        await inTenant((tx) =>
          tx.query(
            `UPDATE crm.expense_claim
                SET state = 'approved', posted_at = NULL, erp_expense_id = NULL
              WHERE tenant_id = $1 AND id = $2`,
            [TENANT, claimId],
          ),
        );

        const result = await sweep();
        expect(result.posted).toBe(1);
        expect(result.replayed).toBe(1);
        expect(result.blocked).toBe(0);
        expect(result.notified).toBe(0);
        expect(summariseExpensePostSweep(result)).toBe(
          "considered=1 posted=1 replayed=1 skipped=0 blocked=0 failed=0 notified=0",
        );
        expect(await inTenant((tx) => inbox(tx, ORPHAN))).toHaveLength(0);
        expect((await inTenant((tx) => getClaim(tx, TENANT, claimId)))?.state).toBe("posted");
        expect(await outboxState(outboxId)).toBe(settle === null ? "in_flight" : "delivered");
      });
    }
  });

  describe("the transaction the sweeper must own", () => {
    it("refuses a client that is already inside a tenant context", async () => {
      await expect(
        withTenantContext(rivalClient, TENANT, (tx) =>
          sweepApprovedExpenseClaims(tx, TENANT, { asOf: NOW }),
        ),
      ).rejects.toBeInstanceOf(ClientAlreadyInTenantContextError);
    });
  });

  describe("the job summary", () => {
    it("carries every count on a quiet pass", async () => {
      const line = summariseExpensePostSweep(await sweep());
      expect(line).toBe(
        "considered=0 posted=0 replayed=0 skipped=0 blocked=0 failed=0 notified=0",
      );
    });

    it("names what did not post, and only the first few of them", async () => {
      const stuck: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        stuck.push(await approvedClaim(ORPHAN, `2026-07-0${i + 1}`));
      }
      const result = await sweep();
      const line = summariseExpensePostSweep(result);

      expect(result.blocked).toBe(6);
      expect(line).toContain("blocked=6");
      for (const id of stuck.slice(0, 5)) expect(line).toContain(`${id}:blocked`);
      expect(line).not.toContain(stuck[5]!);
    });

    it("counts a replay inside posted rather than beside it", async () => {
      const id = await approvedClaim();
      // The outbox row already there, the claim still approved: the state a crash between
      // `enqueueExpenseCreate` and the UPDATE would leave — except that both are in one
      // transaction, so it takes a deliberate hand to produce it.
      await inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                   source_table, source_id)
           VALUES ($1, 'Expense', 'create', '{}'::jsonb, $2, 'crm.expense_claim', $3)`,
          [TENANT, expenseRecordId(id), id],
        );
      });

      const result = await sweep();
      expect(result.posted).toBe(1);
      expect(result.replayed).toBe(1);
      expect(summariseExpensePostSweep(result)).toContain("posted=1 replayed=1");
      expect(await outboxRows()).toHaveLength(1);
    });
  });

  describe("the scheduled job itself", () => {
    it("accepts expense_post as a job name", async () => {
      await inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.scheduled_job (tenant_id, job, interval_ms) VALUES ($1, $2, $3)`,
          [TENANT, "expense_post", 5 * 60_000],
        );
        const { rows } = await tx.query<{ job: string }>(
          `SELECT job FROM crm.scheduled_job WHERE tenant_id = $1 AND job = 'expense_post'`,
          [TENANT],
        );
        expect(rows).toHaveLength(1);
        await tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id = $1", [TENANT]);
      });
    });

    it("still refuses a job name nothing implements", async () => {
      await expect(
        inTenant((tx) =>
          tx.query(`INSERT INTO crm.scheduled_job (tenant_id, job, interval_ms) VALUES ($1,$2,$3)`, [
            TENANT,
            "expense_posting",
            60_000,
          ]),
        ),
      ).rejects.toThrow(/scheduled_job_job_check/);
    });
  });
});
