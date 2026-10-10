import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { withTenantContext } from "@crm/db";
import { TENANT_EXPENSE_LIFECYCLE as TENANT, appPool, wipeConfigChanges, withFixtureAttribution } from "@crm/db/testing";

import {
  EXPENSE_CLAIM_STATES,
  EXPENSE_CLAIM_TRANSITIONS,
  canTransitionExpenseClaim,
  type ExpenseClaimState,
} from "./states.js";
import { approveClaim, createClaim, getClaim, postClaim, reimburseClaim, submitClaim } from "./store.js";
import { upsertAccountMapping } from "./accounts.js";

/**
 * Migration 0044 — the claim lifecycle, in the database.
 *
 * WHY THIS IS A CONTRACT TEST AND NOT A UNIT TEST. The thing under test is a trigger, and
 * the whole reason it exists is that a writer which is not `packages/expense` can reach
 * `crm.expense_claim` — a `psql` prompt, a future offline-sync flush, a data import. A fake
 * `PgConnection` that records `{sql, params}` would assert the shape of the statements this
 * file sends and nothing at all about whether the database refused them.
 *
 * THE MAP IS WALKED PROGRAMMATICALLY. Every ordered pair of the six states is attempted,
 * and the expected outcome comes from `canTransitionExpenseClaim`, so a hand-written list
 * cannot quietly omit the pair that matters. 30 pairs, 5 of them legal — which means the
 * 25 refusals include the ones no route can reach at all (`reimbursed -> draft`,
 * `draft -> posted`, `rejected -> approved`), and those are precisely the ones a route check
 * could never have covered.
 *
 * EVERY REFUSAL IS ASSERTED TO BE THE TRIGGER'S. The message prefix `expense-claim-lifecycle`
 * is checked, not merely that the statement failed. Several illegal pairs would ALSO violate
 * a resting CHECK once they landed (`approved -> rejected` leaves `approved_at` set beside
 * `state = 'rejected'`, which `expense_claim_approved_fields` refuses), and a test that
 * accepted any error as proof would pass just as happily with this trigger dropped. That is
 * the mistake `composite-fk.contract.test.ts` documents for its own probes.
 */

const REP = "e6441111-0000-4000-8000-000000000001";
const MGR = "e6442222-0000-4000-8000-000000000002";

const TRIGGER = "expense_claim_check_lifecycle";

/**
 * The columns a claim AT REST in each state carries, which is what a fixture has to write
 * to park a claim there.
 *
 * Nested along the real chain on purpose: a transition is then expressible as "set `state`,
 * plus whatever the target needs that the source did not have", which keeps the probe
 * additive. That matters because 0044 seals these columns write-once — a probe that re-set
 * `submitted_at` to a fresh `now()` on every hop would be refused by the seal rather than
 * by the map, and every illegal pair would then "pass" for the wrong reason.
 *
 * The values are CONSTANTS, not `now()`, for the same reason.
 */
const AT = "2026-09-01T09:00:00.000Z";
const ERP_ID = "rec_lifecycle_probe";

const RESTING: Readonly<Record<ExpenseClaimState, Readonly<Record<string, string>>>> = (() => {
  const draft: Record<string, string> = {};
  const submitted = { ...draft, submitted_at: AT, erp_ledger_account_code: "6000" };
  const approved = { ...submitted, approved_at: AT, approved_by: MGR };
  const rejected = { ...submitted, rejected_at: AT, rejected_by: MGR };
  const posted = { ...approved, posted_at: AT, erp_expense_id: ERP_ID };
  return { draft, submitted, approved, rejected, posted, reimbursed: { ...posted } };
})();

/** `SET` fragments for the columns `to` needs and `from` did not have. */
function additions(from: ExpenseClaimState, to: ExpenseClaimState): readonly string[] {
  const have = RESTING[from];
  return Object.entries(RESTING[to])
    .filter(([col]) => have[col] === undefined)
    .map(([col, value]) => `${col} = ${literal(value)}`);
}

/** Every lifecycle column this state rests with, for an INSERT. */
function restingColumns(state: ExpenseClaimState): { cols: string; vals: string } {
  const entries = Object.entries(RESTING[state]);
  return {
    cols: entries.map(([c]) => `, ${c}`).join(""),
    vals: entries.map(([, v]) => `, ${literal(v)}`).join(""),
  };
}

/**
 * Inlined rather than bound, because these fragments are assembled per state and a
 * positional parameter list that changes shape per case is where an off-by-one hides. Every
 * value here is a constant in this file; nothing reaches it from outside.
 */
function literal(value: string): string {
  return `'${value}'`;
}

interface PgError {
  readonly code?: string;
  readonly message?: string;
}

describe("0044 — the expense claim lifecycle is in the database", () => {
  let pool: Pool;
  let client: PoolClient;

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, employee, name] of [
        [REP, "lifecycle-rep", "E-LC-1", "Lifecycle Rep"],
        [MGR, "lifecycle-mgr", "E-LC-2", "Lifecycle Manager"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile
             (id, tenant_id, subject, employee_number, display_name, erp_employee_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, employee, name, `emp-${employee}`],
        );
      }
    });
  });

  afterAll(async () => {
    await clear();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [TENANT]);
      // 0061's configuration log before its authors, ON DELETE RESTRICT.
      await wipeConfigChanges(tx, TENANT);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    client?.release();
    await pool?.end();
  });

  const clear = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeEach(clear);

  /** A draft claim, through the one path that writes one. */
  const draftClaim = (): Promise<string> =>
    inTenant(async (tx) => {
      const claim = await createClaim(tx, TENANT, {
        repProfileId: REP,
        crmCategory: "congress",
        amount: "120.50",
        currency: "EUR",
        incurredOn: "2026-09-01",
      });
      return claim.id;
    });

  /**
   * Parks a claim in `state` THROUGH THE ESCAPE HATCH, which is the only honest way to
   * build a fixture for the rule under test: walking the legal chain to get there would
   * make every probe depend on the trigger it is probing, and `draft` is the only state
   * reachable without it anyway.
   *
   * `ALTER TABLE … DISABLE TRIGGER <name>` and not `… DISABLE TRIGGER USER`: 0044's header
   * names this specific trigger as the hatch, and disabling all of them would also be a
   * passing test the day somebody adds a second guard to this table.
   */
  const park = async (claimId: string, state: ExpenseClaimState): Promise<void> => {
    if (state === "draft") return;
    const sets = Object.entries(RESTING[state]).map(([c, v]) => `${c} = ${literal(v)}`);
    await inTenant(async (tx) => {
      await tx.query(`ALTER TABLE crm.expense_claim DISABLE TRIGGER ${TRIGGER}`);
      await tx.query(
        `UPDATE crm.expense_claim SET state = $3, ${sets.join(", ")}
          WHERE tenant_id = $1 AND id = $2`,
        [TENANT, claimId, state],
      );
      await tx.query(`ALTER TABLE crm.expense_claim ENABLE TRIGGER ${TRIGGER}`);
    });
    // The fixture asserts itself. A CHECK this helper failed to satisfy would leave the
    // claim where it was, and every probe below would be answered by the wrong source state.
    const landed = await inTenant((tx) => getClaim(tx, TENANT, claimId));
    expect(landed?.state, `could not park a claim in ${state}`).toBe(state);
  };

  /**
   * Runs one statement and reports what the server said, or `null` if it was accepted.
   *
   * The catch is OUTSIDE `withTenantContext`, so a refusal rolls the transaction back the
   * way the wrapper intends. Catching inside the callback instead would leave an aborted
   * transaction to be COMMITted — which Postgres quietly turns into a rollback, and which is
   * exactly the sort of thing that hides the next bug.
   */
  const refusal = async (sql: string, params: readonly unknown[]): Promise<PgError | null> => {
    try {
      await inTenant((tx) => tx.query(sql, [...params]));
      return null;
    } catch (err) {
      const e = err as PgError;
      return { code: e.code ?? "", message: e.message ?? "" };
    }
  };

  /** Attempts `from -> to` with every column the target needs, and reports what was said. */
  const attempt = async (
    claimId: string,
    from: ExpenseClaimState,
    to: ExpenseClaimState,
  ): Promise<PgError | null> => {
    const sets = ["state = $3", ...additions(from, to)];
    return refusal(
      `UPDATE crm.expense_claim SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
      [TENANT, claimId, to],
    );
  };

  // -------------------------------------------------------------------------
  // The map, and whether the two copies of it agree.
  // -------------------------------------------------------------------------

  describe("the map", () => {
    const sqlEdges = (): Promise<readonly string[]> =>
      inTenant(async (tx) => {
        const { rows } = await tx.query<{ from_state: string; to_state: string }>(
          "SELECT from_state, to_state FROM crm.expense_claim_transitions()",
        );
        return rows.map((r) => `${r.from_state}->${r.to_state}`).sort();
      });

    const tsEdges = (): readonly string[] =>
      Object.entries(EXPENSE_CLAIM_TRANSITIONS)
        .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
        .sort();

    /**
     * The drift guard, and the reason `crm.expense_claim_transitions()` returns rows instead
     * of living inside the trigger body as 0016's `CASE` does.
     *
     * Neither copy can be generated from the other — a migration runs before any TypeScript
     * exists on the box, and `canTransitionExpenseClaim` is called with no connection so that
     * `assertExpenseClaimTransition` can raise a typed error naming the allowed targets. So
     * the rule is stated twice and this is what holds the two together: change either side
     * alone and this fails.
     */
    it("agrees with EXPENSE_CLAIM_TRANSITIONS, edge for edge", async () => {
      expect(await sqlEdges()).toEqual(tsEdges());
    });

    it("declares the five edges the lifecycle actually has, and no more", async () => {
      expect(await sqlEdges()).toEqual([
        "approved->posted",
        "draft->submitted",
        "posted->reimbursed",
        "submitted->approved",
        "submitted->rejected",
      ]);
    });

    /**
     * The state universe, read out of the CHECK rather than restated.
     *
     * `EXPENSE_CLAIM_STATES`'s own doc comment says it "mirrors 0006's `state` CHECK exactly
     * — the same six values in the same order", and until now nothing checked that. A seventh
     * value admitted by the database and unknown to the map would be a state nothing can
     * move and `idx_expense_claim_state` would quietly accumulate it.
     */
    it("admits exactly the six states the TypeScript enum knows", async () => {
      const def = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'expense_claim_state_check'`,
        );
        return rows[0]!.def;
      });
      const inCheck = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
      expect(inCheck).toEqual([...EXPENSE_CLAIM_STATES].sort());
    });

    /**
     * The division of labour between this trigger and 0006's/0030's CHECKs, as a test.
     *
     * 0044 asks for the columns no CHECK already pairs with the state, and deliberately not
     * for the three that one does: a second opinion about the same fact is how two
     * constraints come to disagree. If a later edit adds `approved_at` to the requirement
     * map, this table then has two authorities on that column and the second is the one that
     * is wrong after the first is changed.
     */
    it("never asks for a column an existing CHECK already pairs with the state", async () => {
      const covered = ["approved_at", "rejected_at", "erp_ledger_account_code"];
      for (const state of EXPENSE_CLAIM_STATES) {
        const required = await inTenant(async (tx) => {
          const { rows } = await tx.query<{ cols: string[] }>(
            "SELECT crm.expense_claim_transition_requires($1) AS cols",
            [state],
          );
          return rows[0]!.cols;
        });
        expect(required, state).not.toBeNull();
        for (const col of covered) expect(required, `${state} must leave ${col} to its CHECK`).not.toContain(col);
      }
    });

    /**
     * Fail closed on a state the requirement map does not know.
     *
     * The CHECK is widened inside a transaction that always rolls back, because that is the
     * only way to reach the arm at all — and the arm is the one that decides whether a
     * seventh state added by a later migration is unreachable (noisy, recoverable) or
     * ungoverned (silent, and the hole 0044 closes). This is the OPPOSITE direction from
     * `crm.notification_subject_open`, which treats an unknown subject table as not-open on
     * purpose; the header argues why.
     */
    it("refuses a state with no entry in the requirement map", async () => {
      const id = await draftClaim();
      const message = await inTenant(async (tx) => {
        await tx.query("ALTER TABLE crm.expense_claim DROP CONSTRAINT expense_claim_state_check");
        await tx.query(
          `ALTER TABLE crm.expense_claim ADD CONSTRAINT expense_claim_state_check
             CHECK (state IN ('draft','submitted','approved','rejected','posted','reimbursed','escheated'))`,
        );
        await tx.query(
          `CREATE OR REPLACE FUNCTION crm.expense_claim_transitions()
             RETURNS TABLE (from_state text, to_state text) LANGUAGE sql IMMUTABLE AS
             $f$ SELECT 'draft'::text, 'escheated'::text $f$`,
        );
        const err = await tx
          .query("UPDATE crm.expense_claim SET state = 'escheated' WHERE tenant_id = $1 AND id = $2", [
            TENANT,
            id,
          ])
          .then(() => null)
          .catch((e: unknown) => (e as PgError).message ?? "");
        // Roll the whole thing away — the DDL above and the replaced function with it.
        throw new Error(`PROBE:${String(err)}`);
      }).catch((e: unknown) => String((e as Error).message).replace(/^PROBE:/, ""));

      expect(message).toContain("expense-claim-lifecycle");
      expect(message).toContain("crm.expense_claim_transition_requires");

      // And the rollback really did restore both objects.
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'expense_claim_state_check'`,
        );
        expect(rows[0]!.def).not.toContain("escheated");
      });
      expect(await sqlEdges()).toEqual(tsEdges());
    });
  });

  // -------------------------------------------------------------------------
  // The whole map, walked.
  // -------------------------------------------------------------------------

  describe("every ordered pair of states", () => {
    for (const from of EXPENSE_CLAIM_STATES) {
      for (const to of EXPENSE_CLAIM_STATES) {
        if (from === to) continue;
        const legal = canTransitionExpenseClaim(from, to);
        it(`${legal ? "admits" : "refuses"} ${from} -> ${to}`, async () => {
          const id = await draftClaim();
          await park(id, from);
          const outcome = await attempt(id, from, to);

          if (legal) {
            expect(outcome, `${from} -> ${to} should have been admitted`).toBeNull();
            expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.state).toBe(to);
            return;
          }

          // 23514 is a CHECK violation, which is what `RAISE … USING ERRCODE =
          // 'check_violation'` reports. Asserting the PREFIX as well is what makes this a
          // test of the trigger: several of these pairs would also violate a resting CHECK
          // once they landed, and a test that took any error as proof would pass with this
          // trigger dropped.
          expect(outcome?.code, `${from} -> ${to}`).toBe("23514");
          expect(outcome?.message, `${from} -> ${to}`).toContain("expense-claim-lifecycle");
          expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.state).toBe(from);
        });
      }
    }

    /** The count, so a pair silently disappearing from the loop fails too. */
    it("covers 30 pairs, of which 5 are legal", () => {
      const pairs = EXPENSE_CLAIM_STATES.flatMap((f) =>
        EXPENSE_CLAIM_STATES.filter((t) => t !== f).map((t) => canTransitionExpenseClaim(f, t)),
      );
      expect(pairs).toHaveLength(30);
      expect(pairs.filter(Boolean)).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // A claim is born draft.
  // -------------------------------------------------------------------------

  describe("a claim cannot be born past the start", () => {
    for (const state of EXPENSE_CLAIM_STATES) {
      const born = state === "draft";
      it(`${born ? "accepts" : "refuses"} a claim inserted as ${state}`, async () => {
        const { cols, vals } = restingColumns(state);
        const id = randomUUID();
        const outcome = await refusal(
          `INSERT INTO crm.expense_claim
             (id, tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on, state${cols})
           VALUES ($1,$2,$3,'congress',120.50,'EUR','2026-09-01',$4${vals})`,
          [id, TENANT, REP, state],
        );

        if (born) {
          expect(outcome).toBeNull();
          return;
        }
        // Every resting CHECK is SATISFIED by these rows — that is the point. An `approved`
        // row with a timestamp, a snapshot and an approver who is not the claimant is
        // indistinguishable at rest from one two people agreed on, so nothing but this arm
        // refuses it.
        expect(outcome?.code, state).toBe("23514");
        expect(outcome?.message, state).toContain("expense-claim-lifecycle");
        expect(outcome?.message, state).toContain(`created in state ${state}`);
      });
    }
  });

  // -------------------------------------------------------------------------
  // The named refusals: an actor nobody wrote down.
  // -------------------------------------------------------------------------

  describe("the act of deciding has to name a decider", () => {
    /**
     * `expense_claim_four_eyes` is `approved_by IS NULL OR approved_by <> rep_profile_id`,
     * so a null satisfies it and a claim could reach `approved` with four eyes technically
     * upheld and nobody named. Requiring the actor on the transition is what turns that
     * CHECK from a conditional into a rule.
     */
    it("refuses approved with a null approved_by, which the four-eyes CHECK admits", async () => {
      const id = await draftClaim();
      await park(id, "submitted");
      const outcome = await refusal(
        `UPDATE crm.expense_claim SET state = 'approved', approved_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id, AT],
      );
      expect(outcome?.message).toContain("cannot become approved with no approved_by");

      // The control: the same statement naming an approver is admitted, so the refusal
      // above is about the null and not about the transition.
      await inTenant((tx) =>
        tx.query(
          `UPDATE crm.expense_claim SET state = 'approved', approved_at = $3, approved_by = $4
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id, AT, MGR],
        ),
      );
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.approved_by).toBe(MGR);
    });

    /**
     * 0030 left `rejected_by` nullable DELIBERATELY, for the rows that already existed, and
     * closed with "every rejection written from now on carries both". That promise lived in
     * `rejectClaim`. It is now in the database, and only on the ACT — see the next test for
     * the half that keeps 0030's decision intact.
     */
    it("refuses rejected with a null rejected_by, which 0030's CHECK deliberately admits", async () => {
      const id = await draftClaim();
      await park(id, "submitted");
      const outcome = await refusal(
        `UPDATE crm.expense_claim SET state = 'rejected', rejected_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id, AT],
      );
      expect(outcome?.message).toContain("cannot become rejected with no rejected_by");
    });

    /**
     * The half that makes a pre-flight unnecessary.
     *
     * A row 0030's backfill left `rejected` with a null actor is NOT refused by anything in
     * 0044: the requirement is a statement about rejecting, not about a rejected row. So no
     * existing row needed clamping and no scan would have found anything — which is the
     * whole argument for this migration having no pre-flight.
     */
    it("leaves a legacy rejected row with no rejecter alone, as 0030 intended", async () => {
      const id = await draftClaim();
      await inTenant(async (tx) => {
        await tx.query(`ALTER TABLE crm.expense_claim DISABLE TRIGGER ${TRIGGER}`);
        await tx.query(
          `UPDATE crm.expense_claim
              SET state = 'rejected', submitted_at = $3, rejected_at = $3,
                  erp_ledger_account_code = '6000'
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id, AT],
        );
        await tx.query(`ALTER TABLE crm.expense_claim ENABLE TRIGGER ${TRIGGER}`);
      });
      // With the guard live again, an ordinary touch of that row is accepted.
      //
      // `updated_at` and not `description`, which this used to write: 0047 freezes a claim's
      // SUBSTANCE once it leaves draft, and `description` is in that set — it is part of what
      // an approver read, and the repo's answer to annotating a decided record is an
      // append-only note beside it (0030's disposal reason), not rewriting the field the
      // decision was given against. The premise here was never about `description` anyway:
      // it is that a non-state UPDATE does not trip the required-field check, and
      // `updated_at` says that without borrowing a column whose editability was incidental.
      await inTenant((tx) =>
        tx.query("UPDATE crm.expense_claim SET updated_at = $3 WHERE tenant_id = $1 AND id = $2", [
          TENANT,
          id,
          AT,
        ]),
      );
      const claim = await inTenant((tx) => getClaim(tx, TENANT, id));
      expect(claim?.state).toBe("rejected");
      expect(claim?.rejected_by).toBeNull();
      // …and the actor can still be supplied later, because write-once only forbids MOVING
      // a value that is already there.
      await inTenant((tx) =>
        tx.query("UPDATE crm.expense_claim SET rejected_by = $3 WHERE tenant_id = $1 AND id = $2", [
          TENANT,
          id,
          MGR,
        ]),
      );
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.rejected_by).toBe(MGR);
    });

    it("refuses posted with no erp_expense_id and with no posted_at", async () => {
      for (const omit of ["erp_expense_id", "posted_at"] as const) {
        const id = await draftClaim();
        await park(id, "approved");
        const sets = Object.entries(RESTING.posted)
          .filter(([c]) => c !== omit && RESTING.approved[c] === undefined)
          .map(([c, v]) => `${c} = ${literal(v)}`);
        const outcome = await refusal(
          `UPDATE crm.expense_claim SET state = 'posted'${sets.length > 0 ? ", " + sets.join(", ") : ""}
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        );
        expect(outcome?.message, omit).toContain(`cannot become posted with no ${omit}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // A decision once recorded is not rewritten.
  // -------------------------------------------------------------------------

  describe("the lifecycle columns are write-once", () => {
    const SEALED = [
      "submitted_at",
      "approved_at",
      "approved_by",
      "rejected_at",
      "rejected_by",
      "posted_at",
      "erp_expense_id",
      "erp_journal_entry_id",
    ];

    it("is the list the database itself publishes", async () => {
      const cols = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ cols: string[] }>(
          "SELECT crm.expense_claim_sealed_columns() AS cols",
        );
        return rows[0]!.cols;
      });
      expect([...cols].sort()).toEqual([...SEALED].sort());
    });

    /**
     * The hole that pairing fields to the TRANSITION leaves, and the reason this rule is
     * here at all: not one of these statements changes `state`, so a transition rule never
     * looks at them, and no CHECK on this table mentions any of these columns on its own.
     */
    for (const [state, col, replacement] of [
      ["posted", "approved_by", REP],
      ["posted", "approved_at", "2020-01-01T00:00:00.000Z"],
      ["posted", "submitted_at", "2020-01-01T00:00:00.000Z"],
      ["posted", "posted_at", "2020-01-01T00:00:00.000Z"],
      ["posted", "erp_expense_id", "rec_somewhere_else"],
      ["rejected", "rejected_by", REP],
      ["rejected", "rejected_at", "2020-01-01T00:00:00.000Z"],
    ] as const) {
      it(`refuses re-pointing ${col} on a ${state} claim`, async () => {
        const id = await draftClaim();
        await park(id, state);
        for (const value of [null, replacement]) {
          const outcome = await refusal(
            `UPDATE crm.expense_claim SET ${col} = $3 WHERE tenant_id = $1 AND id = $2`,
            [TENANT, id, value],
          );
          expect(outcome?.message, `${col} := ${String(value)}`).toContain("write-once");
          expect(outcome?.message, `${col} := ${String(value)}`).toContain(col);
        }
      });
    }

    /**
     * `approved_by = <the claimant>` on an already-approved claim is the one re-pointing
     * `expense_claim_four_eyes` WOULD have caught, and it is the only one of the seven. Both
     * refusals are correct; which one speaks matters, because a BEFORE trigger runs ahead of
     * a CHECK and the write-once sentence is the one that explains what the writer did wrong.
     */
    it("speaks before the four-eyes CHECK when the replacement is the claimant", async () => {
      const id = await draftClaim();
      await park(id, "approved");
      const outcome = await refusal(
        "UPDATE crm.expense_claim SET approved_by = $3 WHERE tenant_id = $1 AND id = $2",
        [TENANT, id, REP],
      );
      expect(outcome?.message).toContain("write-once");
      expect(outcome?.message).not.toContain("expense_claim_four_eyes");
    });

    it("admits re-writing the same value, because nothing moved", async () => {
      const id = await draftClaim();
      await park(id, "posted");
      await inTenant((tx) =>
        tx.query(
          `UPDATE crm.expense_claim SET approved_at = $3, posted_at = $3, erp_expense_id = $4
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id, AT, ERP_ID],
        ),
      );
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.erp_expense_id).toBe(ERP_ID);
    });
  });

  // -------------------------------------------------------------------------
  // What the trigger must NOT break.
  // -------------------------------------------------------------------------

  describe("the paths that must still work", () => {
    /**
     * The store's own chain, end to end, with the guard live. `packages/expense` is the one
     * writer that already knew the map, so if 0044 and `states.ts` had disagreed by one edge
     * or one column this is where it would show.
     */
    it("admits the whole chain through createClaim/submit/approve/post/reimburse", async () => {
      await inTenant((tx) =>
        withFixtureAttribution(tx, TENANT, (t) =>
          upsertAccountMapping(t, TENANT, { crmCategory: "congress", erpLedgerAccountCode: "6000" }),
        ),
      );
      const id = await draftClaim();
      const seen: string[] = ["draft"];
      await inTenant(async (tx) => {
        seen.push((await submitClaim(tx, TENANT, id, new Date())).state);
        seen.push((await approveClaim(tx, TENANT, id, MGR, new Date())).state);
      });
      await inTenant(async (tx) => {
        seen.push((await postClaim(tx, TENANT, id, new Date())).claim.state);
      });
      await inTenant(async (tx) => {
        seen.push((await reimburseClaim(tx, TENANT, id)).claim.state);
      });
      expect(seen).toEqual(["draft", "submitted", "approved", "posted", "reimbursed"]);
    });

    /**
     * A hand-written walk, with NOTHING disabled — the import path, and the proof that 0044
     * refuses a jump rather than refusing SQL. `submitClaim` would be the better route for a
     * real import because it snapshots the account from the live mapping; this is what a
     * bulk load that already holds its own history does, hop by hop.
     */
    it("admits a hand-written walk that takes every hop in order", async () => {
      const id = await draftClaim();
      const chain: ExpenseClaimState[] = ["submitted", "approved", "posted", "reimbursed"];
      let from: ExpenseClaimState = "draft";
      for (const to of chain) {
        expect(await attempt(id, from, to), `${from} -> ${to}`).toBeNull();
        from = to;
      }
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.state).toBe("reimbursed");
    });

    /**
     * A claim is deletable. 0044 has no DELETE arm on purpose — `crm.expense_claim` is not
     * an append-only table (0033's attachment tables are, and say so), and every contract
     * suite in this workspace tears its claims down with a plain DELETE.
     */
    it("leaves DELETE alone, which every teardown in this workspace depends on", async () => {
      const id = await draftClaim();
      await park(id, "reimbursed");
      await inTenant((tx) =>
        tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2", [TENANT, id]),
      );
      expect(await inTenant((tx) => getClaim(tx, TENANT, id))).toBeNull();
    });

    /**
     * What 0044 gives 0040.
     *
     * 0040's receipt trigger decides by reading `crm.expense_claim.state`, and its header
     * says a replacement is admitted in `draft` only because "an approver may be reading
     * receipt A at the moment it becomes B". That rule was only as strong as the column it
     * trusted: before 0044, moving an approved claim back to `draft` was one statement, and
     * the swap 0040 forbids was reachable one table earlier.
     */
    it("closes the route into 0040's draft-only tier", async () => {
      const id = await draftClaim();
      await park(id, "approved");
      const outcome = await attempt(id, "approved", "draft");
      expect(outcome?.message).toContain("cannot move from approved to draft");
      expect((await inTenant((tx) => getClaim(tx, TENANT, id)))?.state).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // The escape hatch.
  // -------------------------------------------------------------------------

  describe("the escape hatch", () => {
    /**
     * Named in 0044's header, used by every fixture above, and tested here rather than
     * assumed — because a hatch nobody has exercised is a hatch that does not work on the
     * night it is needed. It is the same mechanism `composite-fk.contract.test.ts` opens all
     * 46 of its probes with, and it is available because `crm_app` OWNS these tables, which
     * 0044's header states plainly rather than implying a stronger boundary.
     */
    it("lets the owner stand the guard down and put it back, in one transaction", async () => {
      const id = await draftClaim();
      await park(id, "reimbursed");

      await inTenant(async (tx) => {
        await tx.query(`ALTER TABLE crm.expense_claim DISABLE TRIGGER ${TRIGGER}`);
        // The repair `MissingErpExpenseIdError` is written for: a posted claim with no ERP
        // record id, which 0044 makes unreachable by transition and which is now reachable
        // only through here.
        await tx.query(
          `UPDATE crm.expense_claim SET state = 'posted', erp_expense_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        );
        await tx.query(`ALTER TABLE crm.expense_claim ENABLE TRIGGER ${TRIGGER}`);
      });

      const claim = await inTenant((tx) => getClaim(tx, TENANT, id));
      expect(claim?.state).toBe("posted");
      expect(claim?.erp_expense_id).toBeNull();

      // And the guard is live again immediately afterwards: the same backwards move is
      // refused on the next statement.
      expect((await attempt(id, "posted", "approved"))?.message).toContain("expense-claim-lifecycle");
    });

    /**
     * The hatch suspends the MAP, not the invariants. Every CHECK and the tenant policy
     * still judge a repair — which is what makes "disable the trigger" a narrower act than
     * it sounds, and worth saying because an operator reaching for it under pressure will
     * assume otherwise.
     */
    it("does not suspend the CHECK constraints or the policy", async () => {
      const id = await draftClaim();
      await park(id, "approved");
      const message = await inTenant((tx) =>
        tx
          .query(`ALTER TABLE crm.expense_claim DISABLE TRIGGER ${TRIGGER}`)
          .then(() =>
            tx.query(
              `UPDATE crm.expense_claim SET state = 'rejected', rejected_at = $3, rejected_by = $4
                WHERE tenant_id = $1 AND id = $2`,
              [TENANT, id, AT, MGR],
            ),
          )
          .then(() => null)
          .catch((e: unknown) => (e as PgError).message ?? ""),
      );
      // `approved_at` is still set, and `expense_claim_approved_fields` is an equality over
      // the three approved-ish states — so the row is refused by the CHECK with the trigger
      // standing down.
      expect(message).toContain("expense_claim_approved_fields");
    });
  });

  // -------------------------------------------------------------------------
  // 0047 — what a claim SAYS is frozen once it has left draft.
  //
  // 0044 closed the lifecycle and left this open, deliberately: a claim approved for 120.50
  // could be edited to 1,205.00 and posted, with the approval still on the row attesting to
  // a number nobody ever saw. The same hole let an approved claim be re-pointed at a
  // different rep — 0016's call-plan defect, in the expense table.
  // -------------------------------------------------------------------------

  describe("0047 — the substance is frozen once a claim leaves draft", () => {
    const FREEZE_TRIGGER = "expense_claim_freeze_substance";

    /** A plausible NEW value per frozen column, so each probe actually changes something. */
    const CHANGED: Readonly<Record<string, string>> = {
      rep_profile_id: MGR,
      crm_category: "detailing",
      amount: "1205.00",
      currency: "USD",
      incurred_on: "2026-09-02",
      description: "edited after the fact",
      receipt_url: "https://example.test/other.png",
      erp_ledger_account_code: "9999",
      erp_cost_center_code: "CC-OTHER",
    };

    const frozenColumns = (): Promise<readonly string[]> =>
      inTenant(async (tx) => {
        const { rows } = await tx.query<{ cols: string[] }>(
          "SELECT crm.expense_claim_frozen_columns() AS cols",
        );
        return rows[0]!.cols;
      });

    /**
     * THE LIST IS ASKED OF THE DATABASE AND CHECKED AGAINST THE TABLE.
     *
     * A typo'd column name in that array would not fail anything: `to_jsonb(OLD) ->> 'amont'`
     * is null on both sides, so the comparison is silently always equal and the column is
     * simply never frozen. The guard would still pass every test that probes a DIFFERENT
     * column, which is the shape of a rule that protects nothing.
     */
    it("names only real columns of crm.expense_claim, and covers the ones that matter", async () => {
      const frozen = await frozenColumns();
      const actual = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'crm' AND table_name = 'expense_claim'`,
        );
        return new Set(rows.map((r) => r.column_name));
      });
      for (const col of frozen) expect(actual.has(col), `${col} is not a column`).toBe(true);
      // The money and the ownership, explicitly: this is the list's reason for existing and
      // a future edit that drops one of them should fail here.
      for (const col of ["amount", "currency", "incurred_on", "crm_category", "rep_profile_id"]) {
        expect(frozen, `${col} must be frozen`).toContain(col);
      }
      // Every probe below must actually change its column, or the test is vacuous.
      for (const col of frozen) expect(Object.keys(CHANGED), `${col} has no probe value`).toContain(col);
    });

    /**
     * DISJOINT FROM 0044's SEALED SET, asked of the database rather than asserted in prose.
     *
     * The sealed columns are the decision RECORD and 0044 holds them write-once. Two
     * constraints with an opinion about one column is how they come to disagree, and the only
     * thing that could claim these two SQL arrays do not overlap is a comment — which is why
     * both are published as functions.
     */
    it("does not overlap the lifecycle's write-once columns", async () => {
      const overlap = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ col: string }>(
          `SELECT unnest(crm.expense_claim_frozen_columns()) AS col
           INTERSECT
           SELECT unnest(crm.expense_claim_sealed_columns())`,
        );
        return rows.map((r) => r.col);
      });
      expect(overlap).toEqual([]);
    });

    it("admits every edit while the claim is still a draft", async () => {
      const id = await draftClaim();
      for (const [col, value] of Object.entries(CHANGED)) {
        expect(
          await refusal(
            `UPDATE crm.expense_claim SET ${col} = ${literal(value)} WHERE tenant_id = $1 AND id = $2`,
            [TENANT, id],
          ),
          `a draft refused a change to ${col}`,
        ).toBeNull();
      }
    });

    it("refuses every frozen column in every state past draft", async () => {
      const frozen = await frozenColumns();
      const past = EXPENSE_CLAIM_STATES.filter((s) => s !== "draft");
      for (const state of past) {
        for (const col of frozen) {
          const id = await draftClaim();
          await park(id, state);
          const err = await refusal(
            `UPDATE crm.expense_claim SET ${col} = ${literal(CHANGED[col]!)}
              WHERE tenant_id = $1 AND id = $2`,
            [TENANT, id],
          );
          expect(err, `${state}: ${col} was editable`).not.toBeNull();
          // The TRIGGER's refusal, not some CHECK that happened to fire — the mistake this
          // file's own header warns about.
          expect(err?.message, `${state}: ${col}`).toContain("expense-claim-substance");
          expect(err?.message).toContain(col);
          expect(err?.code).toBe("23514");
        }
      }
    });

    /**
     * The one legitimate writer of the account codes, and why the rule is keyed on OLD.state.
     *
     * `submitClaim` stamps `erp_ledger_account_code` in the SAME statement as
     * `draft -> submitted`, so `OLD.state` is still `draft` when the trigger looks. A
     * write-once rule would have refused exactly this — and `erp_cost_center_code` is
     * legitimately null, so write-once would have left it settable forever, which is the
     * opposite of the guarantee.
     */
    it("lets submitClaim stamp the account snapshot on the way out of draft", async () => {
      await inTenant((tx) =>
        withFixtureAttribution(tx, TENANT, (t) =>
          upsertAccountMapping(t, TENANT, {
            crmCategory: "congress",
            erpLedgerAccountCode: "6100",
            erpCostCenterCode: "CC-SM",
          }),
        ),
      );
      const id = await draftClaim();
      const submitted = await inTenant((tx) => submitClaim(tx, TENANT, id, new Date("2026-09-10T08:00:00Z")));
      expect(submitted.state).toBe("submitted");
      expect(submitted.erp_ledger_account_code).toBe("6100");
      expect(submitted.erp_cost_center_code).toBe("CC-SM");
      // And now it is fixed.
      const err = await refusal(
        "UPDATE crm.expense_claim SET erp_ledger_account_code = '9999' WHERE tenant_id = $1 AND id = $2",
        [TENANT, id],
      );
      expect(err?.message).toContain("expense-claim-substance");
    });

    it("still lets the lifecycle move a claim, and still lets updated_at move", async () => {
      const id = await draftClaim();
      await park(id, "approved");
      expect(
        await refusal(
          `UPDATE crm.expense_claim
              SET state = 'posted', posted_at = ${literal("2026-09-20T08:00:00Z")},
                  erp_expense_id = ${literal(`crm-exp-${id}`)}, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        ),
      ).toBeNull();
    });

    /**
     * TRIGGER ORDER IS LOAD-BEARING. Postgres fires same-event triggers alphabetically, and
     * `check_lifecycle` sorts before `freeze_substance` — so an UPDATE that is BOTH an
     * illegal transition and a substance edit is reported as the illegal transition, which is
     * the better-aimed sentence. Renaming either trigger breaks this rather than quietly
     * reordering two refusals.
     */
    it("reports an illegal transition as a transition, even when the substance also changed", async () => {
      const id = await draftClaim();
      await park(id, "reimbursed");
      const err = await refusal(
        `UPDATE crm.expense_claim SET state = 'draft', amount = '1.00' WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      expect(err?.message).toContain("expense-claim-lifecycle");
      expect(err?.message).not.toContain("expense-claim-substance");
    });

    it("fires both triggers, in the order their names imply", async () => {
      const names = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'crm' AND c.relname = 'expense_claim' AND NOT t.tgisinternal
            ORDER BY t.tgname`,
        );
        return rows.map((r) => r.tgname);
      });
      expect(names).toEqual([TRIGGER, FREEZE_TRIGGER]);
    });
  });
});
