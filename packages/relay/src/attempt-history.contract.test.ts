import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_DISPOSAL_SEQ as TENANT, appPool } from "@crm/db/testing";

import {
  attemptHistory,
  recentDeaths,
  summariseAttemptHistory,
  type DeadLetterAttempt,
} from "./attempt-history.js";
import { reviveDeadLetter } from "./dead-letters.js";
import { claimBatch, enqueueOutbox, markDead, markDelivered, markRetry } from "./store.js";

/**
 * A dead letter that remembers why it died EACH time (0036 part 2).
 *
 * WHAT WAS BROKEN. 0022 gave the outbox a way back — fix the ERP-side cause, revive the
 * row, re-send the same payload — and `dead_reason` holds only the latest cause, so the
 * next death overwrites the last. "Died because the ledger account was missing, somebody
 * created it, died again because the period was locked" was indistinguishable from "died
 * twice because the ledger account is still missing". `revive_count` says a row has died
 * more than once; nothing said why each time.
 *
 * The writer is a trigger on `crm.outbox`, not this package, so the assertions below drive
 * the REAL writers — `markDead`, `markDelivered`, `markRetry`, `claimBatch`,
 * `reviveDeadLetter` — and read the history back. A test that inserted history rows by
 * hand would prove the table exists and nothing about whether anything fills it.
 *
 * `appPool()` connects as `crm_app`, so RLS is live and the isolation assertions mean
 * something. A superuser connection bypasses the policy even under FORCE.
 *
 * TENANT. Shares `TENANT_DISPOSAL_SEQ` with `packages/sample`'s disposal ordering suite:
 * the two touch disjoint tables (`crm.outbox` + `crm.outbox_dead_letter` here,
 * `crm.disposal_obligation` there) and test files run sequentially. A reserved block of
 * its own means editing `packages/db/src/testing.ts`, which this change does not own.
 */
describe("a dead letter's per-attempt history", () => {
  let pool: Pool;
  let client: PoolClient;

  const REVIVER = "e2dd0000-0000-4000-8000-000000000001";
  const OTHER_TENANT = "e2cc0000-0000-4000-8000-000000000099";

  const at = (iso: string): Date => new Date(iso);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1,$2,'ah-reviver','AH-1','ah-reviver') ON CONFLICT DO NOTHING`,
        [REVIVER, TENANT],
      );
    });
  });

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
    });
  };

  afterAll(async () => {
    await reset();
    client?.release();
    await pool?.end();
  });

  afterEach(reset);

  /** A queued ERP write, through the only writer of `crm.outbox`. */
  const queued = async (
    tx: PoolClient,
    opts: { entity?: string; operation?: string } = {},
  ): Promise<{ readonly id: string; readonly sourceId: string; readonly targetId: string }> => {
    const sourceId = randomUUID();
    const targetId = `AH-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const { id } = await enqueueOutbox(tx, TENANT, {
      entity: opts.entity ?? "Expense",
      operation: opts.operation ?? "create",
      payload: { amount: 12 },
      targetRecordId: targetId,
      sourceTable: "crm.expense_claim",
      sourceId,
    });
    return { id, sourceId, targetId };
  };

  // ---- the trigger discriminates ------------------------------------------

  describe("what gets recorded", () => {
    it("writes exactly one row when a write is given up on", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "ledger account LA-1 not found");

        const history = await attemptHistory(tx, row.id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          outbox_id: row.id,
          attempt: 1,
          revive_count_at_death: 0,
          reason: "ledger account LA-1 not found",
          is_repeat_of_previous: false,
          revived_at: null,
          revived_by: null,
          revived_by_name: null,
        });
        expect(history[0]!.died_at).toEqual(at("2026-10-01T10:00:00Z"));
      });
    });

    it("copies the identity of the write, so the row reads without a join", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx, { entity: "JournalEntry", operation: "transition:post" });
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "period locked");
        const [entry] = await attemptHistory(tx, row.id);
        expect(entry).toMatchObject({
          entity: "JournalEntry",
          operation: "transition:post",
          target_record_id: row.targetId,
          source_table: "crm.expense_claim",
          source_id: row.sourceId,
        });
      });
    });

    it("records the dispatch attempts that episode consumed, which is not the death count", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        // A claim time comfortably past `next_attempt_at`, which defaults to the real
        // `now()` on a freshly enqueued row — a fixed past date would claim nothing and
        // the assertion below would read 1 and look like a different bug.
        const claimAt = at("2027-01-01T09:00:00Z");
        // Three real claims: `attempts` increments at claim time (see `claimBatch`).
        for (let i = 0; i < 3; i += 1) {
          expect(await claimBatch(tx, TENANT, "worker-1", 10, claimAt)).toHaveLength(1);
          await markRetry(tx, row.id, claimAt, "503");
        }
        expect(await claimBatch(tx, TENANT, "worker-1", 10, claimAt)).toHaveLength(1);
        await markDead(tx, row.id, at("2027-01-01T10:00:00Z"), "403");

        const [entry] = await attemptHistory(tx, row.id);
        expect(entry!.dispatch_attempts).toBe(4);
        expect(entry!.attempt).toBe(1);
      });
    });

    it("records nothing for a claim, a retry or a delivery", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        expect(
          await claimBatch(tx, TENANT, "worker-1", 10, at("2027-01-01T09:00:00Z")),
        ).toHaveLength(1);
        expect(await attemptHistory(tx, row.id)).toHaveLength(0);

        await markRetry(tx, row.id, at("2027-01-01T09:05:00Z"), "502 from the ERP");
        expect(await attemptHistory(tx, row.id)).toHaveLength(0);

        await markDelivered(tx, row.id, at("2027-01-01T09:10:00Z"), { ok: true });
        expect(await attemptHistory(tx, row.id)).toHaveLength(0);
      });
    });

    it("records nothing for a second markDead on a row that is already dead", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "first");
        // Settling twice is not a second death: the episode has not been restarted, so a
        // second row would claim a death that never happened.
        await markDead(tx, row.id, at("2026-10-01T10:00:01Z"), "first, again");
        const history = await attemptHistory(tx, row.id);
        expect(history).toHaveLength(1);
        expect(history[0]!.reason).toBe("first");
      });
    });
  });

  // ---- the gap, closed ----------------------------------------------------

  describe("across a revive", () => {
    const diedTwice = async (
      tx: PoolClient,
      reasons: readonly [string, string],
    ): Promise<{ readonly id: string; readonly history: readonly DeadLetterAttempt[] }> => {
      const row = await queued(tx);
      await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), reasons[0]);
      await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
      await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
      await markDead(tx, row.id, at("2026-10-02T08:05:00Z"), reasons[1]);
      return { id: row.id, history: await attemptHistory(tx, row.id) };
    };

    it("keeps BOTH reasons, which is the whole point", async () => {
      await inTenant(async (tx) => {
        const { history } = await diedTwice(tx, [
          "ledger account LA-1 not found",
          "accounting period 2026-09 is locked",
        ]);
        expect(history.map((h) => h.reason)).toEqual([
          "ledger account LA-1 not found",
          "accounting period 2026-09 is locked",
        ]);
      });
    });

    it("numbers the episodes, and agrees with revive_count at each one", async () => {
      await inTenant(async (tx) => {
        const { history } = await diedTwice(tx, ["a", "b"]);
        expect(history.map((h) => h.attempt)).toEqual([1, 2]);
        expect(history.map((h) => h.revive_count_at_death)).toEqual([0, 1]);
      });
    });

    it("stamps the first episode with who revived it and when", async () => {
      await inTenant(async (tx) => {
        const { history } = await diedTwice(tx, ["a", "b"]);
        expect(history[0]!.revived_at).toEqual(at("2026-10-02T08:00:00Z"));
        expect(history[0]!.revived_by).toBe(REVIVER);
        expect(history[0]!.revived_by_name).toBe("ah-reviver");
        // The second episode is still open: nobody has revived it.
        expect(history[1]!.revived_at).toBeNull();
        expect(history[1]!.revived_by).toBeNull();
      });
    });

    it("flags a repeat when the cause was never fixed", async () => {
      await inTenant(async (tx) => {
        const { history } = await diedTwice(tx, [
          "ledger account LA-1 not found",
          "ledger account LA-1 not found",
        ]);
        expect(history.map((h) => h.is_repeat_of_previous)).toEqual([false, true]);
        expect(summariseAttemptHistory(history)).toMatchObject({
          deaths: 2,
          revives: 1,
          distinctReasons: 1,
          repeatedReasons: ["ledger account LA-1 not found"],
          alwaysTheSameReason: true,
          neverTheSameReason: false,
        });
      });
    });

    it("does not flag a repeat when the cause moved on", async () => {
      await inTenant(async (tx) => {
        const { history } = await diedTwice(tx, ["account missing", "period locked"]);
        expect(history.map((h) => h.is_repeat_of_previous)).toEqual([false, false]);
        expect(summariseAttemptHistory(history)).toMatchObject({
          deaths: 2,
          distinctReasons: 2,
          repeatedReasons: [],
          alwaysTheSameReason: false,
          neverTheSameReason: true,
        });
      });
    });

    it("keeps three episodes in order, each with its own cause", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        for (const [i, reason] of ["account missing", "period locked", "403 forbidden"].entries()) {
          if (i > 0) {
            await reviveDeadLetter(tx, row.id, REVIVER, at(`2026-10-0${i + 1}T08:00:00Z`));
            await claimBatch(tx, TENANT, "worker-1", 10, at(`2026-10-0${i + 1}T08:01:00Z`));
          }
          await markDead(tx, row.id, at(`2026-10-0${i + 1}T09:00:00Z`), reason);
        }
        const history = await attemptHistory(tx, row.id);
        expect(history.map((h) => [h.attempt, h.reason])).toEqual([
          [1, "account missing"],
          [2, "period locked"],
          [3, "403 forbidden"],
        ]);
        // Each earlier episode is closed, the last is not.
        expect(history.map((h) => h.revived_at !== null)).toEqual([true, true, false]);
      });
    });
  });

  // ---- the hand-written path ----------------------------------------------

  describe("a row put back in the queue without the revive function", () => {
    it("records that the episode ended but attributes it to nobody", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
        await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
        await markDead(tx, row.id, at("2026-10-02T09:00:00Z"), "period locked");

        // The hand-written revive: state moved, `revive_count` did not. `revived_by` on
        // the outbox row still names the PREVIOUS reviver, and copying it would credit
        // this revive to somebody who had nothing to do with it.
        await tx.query(
          "UPDATE crm.outbox SET state = 'pending', attempts = 0 WHERE id = $1",
          [row.id],
        );

        const history = await attemptHistory(tx, row.id);
        expect(history[1]!.revived_at).not.toBeNull();
        expect(history[1]!.revived_by).toBeNull();
        expect(history[1]!.revived_by_name).toBeNull();
        // ...and the earlier, properly attributed revive is untouched.
        expect(history[0]!.revived_by).toBe(REVIVER);
      });
    });

    it("leaves attempt and revive_count disagreeing, which the summary reports", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await tx.query("UPDATE crm.outbox SET state = 'pending' WHERE id = $1", [row.id]);
        await markDead(tx, row.id, at("2026-10-02T10:00:00Z"), "account still missing");

        const history = await attemptHistory(tx, row.id);
        expect(history.map((h) => [h.attempt, h.revive_count_at_death])).toEqual([
          [1, 0],
          [2, 0],
        ]);
        expect(summariseAttemptHistory(history).unaccountedRevivals).toBe(1);
      });
    });
  });

  // ---- retention: the history outlives the row it describes ----------------

  describe("independence from crm.outbox", () => {
    it("survives the deletion of the outbox row, still self-describing", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx, { entity: "Expense", operation: "create" });
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await tx.query("DELETE FROM crm.outbox WHERE id = $1", [row.id]);

        const history = await attemptHistory(tx, row.id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          entity: "Expense",
          operation: "create",
          target_record_id: row.targetId,
          source_table: "crm.expense_claim",
          source_id: row.sourceId,
          reason: "account missing",
        });
      });
    });

    it("is still listed when crm.dead_outbox_letters no longer shows anything", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
        await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
        // The revive worked: the row is delivered and is no longer a dead letter at all.
        await markDelivered(tx, row.id, at("2026-10-02T08:02:00Z"), { ok: true });

        const { rows: live } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.dead_outbox_letters(NULL, 100)",
        );
        expect(Number(live[0]!.n)).toBe(0);

        const recent = await recentDeaths(tx, { limit: 50 });
        expect(recent.map((r) => r.outbox_id)).toContain(row.id);
        expect(recent.find((r) => r.outbox_id === row.id)!.revived_at).not.toBeNull();
      });
    });

    it("compares against the real previous episode even outside the page", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "same cause");
        await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
        await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
        await markDead(tx, row.id, at("2026-10-02T09:00:00Z"), "same cause");

        // A page of one: the previous episode is not in the result set, and the flag must
        // still be true. Window functions run before LIMIT, which is why.
        const page = await recentDeaths(tx, { limit: 1 });
        expect(page).toHaveLength(1);
        expect(page[0]!.attempt).toBe(2);
        expect(page[0]!.is_repeat_of_previous).toBe(true);
      });
    });
  });

  // ---- refusals -----------------------------------------------------------

  describe("the table refuses", () => {
    const insertHistory = async (
      tx: PoolClient,
      overrides: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      const base: Record<string, unknown> = {
        tenant_id: TENANT,
        outbox_id: randomUUID(),
        attempt: 1,
        revive_count_at_death: 0,
        dispatch_attempts: 1,
        died_at: at("2026-10-01T10:00:00Z"),
        reason: "r",
        entity: "Expense",
        operation: "create",
        target_record_id: "AH-T",
        source_table: "crm.expense_claim",
        source_id: randomUUID(),
        ...overrides,
      };
      const keys = Object.keys(base);
      await tx.query(
        `INSERT INTO crm.outbox_dead_letter (${keys.join(", ")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
        keys.map((k) => base[k]),
      );
    };

    it("an episode numbered below one", async () => {
      await inTenant(async (tx) => {
        await expect(insertHistory(tx, { attempt: 0 })).rejects.toThrow(
          /outbox_dead_letter_attempt_check/,
        );
      });
    });

    it("a negative dispatch count", async () => {
      await inTenant(async (tx) => {
        await expect(insertHistory(tx, { dispatch_attempts: -1 })).rejects.toThrow(
          /outbox_dead_letter_dispatch_attempts_check/,
        );
      });
    });

    it("a negative revive count", async () => {
      await inTenant(async (tx) => {
        await expect(insertHistory(tx, { revive_count_at_death: -1 })).rejects.toThrow(
          /outbox_dead_letter_revive_count_at_death_check/,
        );
      });
    });

    it("a reviver with no time of revival", async () => {
      await inTenant(async (tx) => {
        await expect(insertHistory(tx, { revived_by: REVIVER })).rejects.toThrow(
          /outbox_dead_letter_revive_pair/,
        );
      });
    });

    it("but accepts a time of revival with no reviver — the honest null", async () => {
      await inTenant(async (tx) => {
        await insertHistory(tx, { revived_at: at("2026-10-02T08:00:00Z") });
      });
    });

    it("a second row claiming to be the same episode", async () => {
      await inTenant(async (tx) => {
        const outboxId = randomUUID();
        await insertHistory(tx, { outbox_id: outboxId, attempt: 2 });
        await expect(insertHistory(tx, { outbox_id: outboxId, attempt: 2 })).rejects.toThrow(
          /uq_outbox_dead_letter_attempt/,
        );
      });
    });

    it("a reason longer than the column allows", async () => {
      await inTenant(async (tx) => {
        await expect(insertHistory(tx, { reason: "x".repeat(2001) })).rejects.toThrow(
          /outbox_dead_letter_reason_check/,
        );
      });
    });
  });

  // ---- isolation ----------------------------------------------------------

  describe("tenant isolation", () => {
    it("hides one tenant's deaths from another", async () => {
      // Two transactions, not one nested in the other: `withTenantContext` opens its own,
      // and the read has to happen after the write has committed for the absence to mean
      // "the policy hid it" rather than "it was not there yet".
      const outboxId = await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        expect(await attemptHistory(tx, row.id)).toHaveLength(1);
        return row.id;
      });

      await withTenantContext(client, OTHER_TENANT, async (other) => {
        expect(await attemptHistory(other, outboxId)).toHaveLength(0);
        expect(await recentDeaths(other)).toHaveLength(0);
      });
    });

    it("cannot smuggle a history row into another tenant", async () => {
      await inTenant(async (tx) => {
        await expect(
          tx.query(
            `INSERT INTO crm.outbox_dead_letter
               (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
                died_at, entity, operation, target_record_id, source_table, source_id)
             VALUES ($1, $2, 1, 0, 1, now(), 'Expense', 'create', 'AH-T', 'crm.expense_claim', $3)`,
            [OTHER_TENANT, randomUUID(), randomUUID()],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it("enables and FORCES row level security, because crm_app owns the table", async () => {
      const { rows } = await client.query<{ rls: boolean; forced: boolean }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crm' AND c.relname = 'outbox_dead_letter'`,
      );
      expect(rows[0]).toEqual({ rls: true, forced: true });
    });

    it("records the death as the invoker, so the policy applies to the trigger too", async () => {
      // A SECURITY DEFINER trigger would write history as its owner and escape the
      // policy; `schema.contract.test.ts` forbids one globally and this pins the one that
      // matters here.
      const { rows } = await client.query<{ secdef: boolean }>(
        `SELECT p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'crm' AND p.proname = 'outbox_dead_letter_record'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.secdef).toBe(false);
    });

    it("carries no foreign key at all, so nothing else's lifetime governs the history", async () => {
      // The precedent not to recreate: `crm.notification_delivery` cascades from
      // `crm.notification`, which is why delivery history cannot outlive the notification
      // it describes (ADR-0001). Neither reference here is enforced — not `outbox_id`,
      // and not `revived_by`, which as a RESTRICT handed this table a veto over deleting
      // a rep profile and broke an unrelated suite's teardown.
      const { rows } = await client.query<{ conname: string; target: string }>(
        `SELECT c.conname, f.relname AS target FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_class f ON f.oid = c.confrelid
          WHERE t.relname = 'outbox_dead_letter' AND c.contype = 'f'`,
      );
      expect(rows).toEqual([]);
    });

    it("keeps a reviver's id after their profile is gone, with a null name beside it", async () => {
      const GHOST = "e2dd0000-0000-4000-8000-0000000000ee";
      const outboxId = await inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,'ah-ghost','AH-GHOST','ah-ghost') ON CONFLICT DO NOTHING`,
          [GHOST, TENANT],
        );
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await reviveDeadLetter(tx, row.id, GHOST, at("2026-10-02T08:00:00Z"));
        return row.id;
      });

      await inTenant(async (tx) => {
        // The outbox row names the reviver too, and that one IS a RESTRICT (0022), so the
        // queue row has to go first — which is itself the gap this table closes.
        await tx.query("DELETE FROM crm.outbox WHERE id = $1", [outboxId]);
        await tx.query("DELETE FROM crm.rep_profile WHERE id = $1", [GHOST]);

        const [entry] = await attemptHistory(tx, outboxId);
        expect(entry!.revived_by).toBe(GHOST);
        expect(entry!.revived_by_name).toBeNull();
        expect(entry!.revived_at).toEqual(at("2026-10-02T08:00:00Z"));
      });
    });
  });

  // ---- the summary, as a pure function ------------------------------------

  describe("summariseAttemptHistory", () => {
    const entry = (over: Partial<DeadLetterAttempt> & { attempt: number }): DeadLetterAttempt => ({
      id: randomUUID(),
      outbox_id: "o",
      revive_count_at_death: over.attempt - 1,
      dispatch_attempts: 1,
      died_at: at("2026-10-01T10:00:00Z"),
      reason: "r",
      entity: "Expense",
      operation: "create",
      target_record_id: "AH-T",
      source_table: "crm.expense_claim",
      source_id: "s",
      revived_at: null,
      revived_by: null,
      revived_by_name: null,
      is_repeat_of_previous: false,
      ...over,
    });

    it("says nothing happened for an empty history", () => {
      expect(summariseAttemptHistory([])).toEqual({
        deaths: 0,
        revives: 0,
        distinctReasons: 0,
        repeatedReasons: [],
        unexplained: 0,
        alwaysTheSameReason: false,
        neverTheSameReason: false,
        unaccountedRevivals: 0,
        latestReason: null,
      });
    });

    it("claims neither shape for a single death — there is nothing to compare it to", () => {
      const s = summariseAttemptHistory([entry({ attempt: 1, reason: "only" })]);
      expect(s.deaths).toBe(1);
      expect(s.alwaysTheSameReason).toBe(false);
      expect(s.neverTheSameReason).toBe(false);
      expect(s.latestReason).toBe("only");
    });

    it("counts a null reason as unexplained rather than as a cause", () => {
      const s = summariseAttemptHistory([
        entry({ attempt: 1, reason: null }),
        entry({ attempt: 2, reason: "period locked", is_repeat_of_previous: false }),
      ]);
      expect(s.unexplained).toBe(1);
      expect(s.distinctReasons).toBe(1);
      expect(s.repeatedReasons).toEqual([]);
    });

    it("lists a repeated reason once, in first-seen order", () => {
      const s = summariseAttemptHistory([
        entry({ attempt: 1, reason: "b" }),
        entry({ attempt: 2, reason: "a", is_repeat_of_previous: false }),
        entry({ attempt: 3, reason: "b", is_repeat_of_previous: false }),
        entry({ attempt: 4, reason: "a", is_repeat_of_previous: false }),
      ]);
      expect(s.repeatedReasons).toEqual(["b", "a"]);
      expect(s.distinctReasons).toBe(2);
      // "b, a, b, a" is neither shape: no two CONSECUTIVE deaths share a reason, yet both
      // reasons recur. A summary that collapsed those would mislead in both directions.
      expect(s.alwaysTheSameReason).toBe(false);
      expect(s.neverTheSameReason).toBe(true);
    });

    it("orders by attempt regardless of the order it was handed", () => {
      const s = summariseAttemptHistory([
        entry({ attempt: 3, reason: "third" }),
        entry({ attempt: 1, reason: "first" }),
        entry({ attempt: 2, reason: "second" }),
      ]);
      expect(s.latestReason).toBe("third");
      expect(s.deaths).toBe(3);
    });

    it("counts closed episodes as revives", () => {
      const s = summariseAttemptHistory([
        entry({ attempt: 1, revived_at: at("2026-10-02T08:00:00Z"), revived_by: REVIVER }),
        entry({ attempt: 2, revived_at: at("2026-10-03T08:00:00Z") }),
        entry({ attempt: 3 }),
      ]);
      expect(s.revives).toBe(2);
      expect(s.unaccountedRevivals).toBe(0);
    });

    it("counts every death whose numbering disagrees with the revive bookkeeping", () => {
      const s = summariseAttemptHistory([
        entry({ attempt: 1, revive_count_at_death: 0 }),
        entry({ attempt: 2, revive_count_at_death: 0 }),
        entry({ attempt: 3, revive_count_at_death: 0 }),
      ]);
      expect(s.unaccountedRevivals).toBe(2);
    });
  });
});
