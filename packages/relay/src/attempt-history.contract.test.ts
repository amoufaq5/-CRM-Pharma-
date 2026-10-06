import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool } from "@crm/db/testing";

/**
 * A reserved tenant of this file's own, derived from the `e…` block in
 * `packages/db/src/testing.ts` by continuing its numbering past `TENANT_LIVE_ERP`
 * (`…017`). It is declared here because that file is not this change's to edit, and the
 * id is NOT `TENANT_DISPOSAL_SEQ`: this suite deletes every `crm.outbox` row in its
 * tenant after each test, so sharing a block with another file is a loaded gun even
 * while `fileParallelism: false` keeps them from firing it. Owed an entry in
 * `testing.ts` as `TENANT_ATTEMPT_HISTORY`.
 */
const TENANT = "e4100000-0000-4000-8000-000000000018";

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
 */
describe("a dead letter's per-attempt history", () => {
  let pool: Pool;
  let client: PoolClient;

  // Both derived from this file's own tenant block, so no fixture of another suite's can
  // already hold the id under a different `tenant_id` — which the composite
  // `outbox_revived_by_fkey` refuses, and which is exactly how a shared block fails.
  const REVIVER = "e4100000-0000-4000-8000-0000000000a1";
  const OTHER_TENANT = "e4100000-0000-4000-8000-0000000000b9";

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

    /**
     * 0038 closed this, and the test is inverted rather than deleted.
     *
     * The trigger used to copy `crm.outbox.revived_at` unguarded. That column holds ONE
     * value, overwritten by each revive, so a hand-written revive that did not set it
     * stamped the closing episode with an EARLIER revive's timestamp — an episode recorded
     * as having ended before it began, which the old assertion pinned as a known defect.
     *
     * 0038 trusts a supplied moment only when `revive_count` moved AND the timestamp is
     * not older than the death it closes, and uses `now()` otherwise. Guarding on the
     * counter alone was tried first and is not enough: a hand-written revive that bumps
     * the counter and forgets the timestamp passes that guard and still records the
     * impossible pair. Both paths are asserted below.
     */
    it("never closes an episode before the death it closes, on either revive path", async () => {
      for (const bumpsCounter of [true, false]) {
        await inTenant(async (tx) => {
          // Through the real writer, so the row is one the relay could actually produce.
          const { id } = await queued(tx);
          await tx.query(
            `UPDATE crm.outbox SET state = 'dead', dead_at = '2026-10-01T10:00:00.000Z',
                                   dead_reason = 'first' WHERE id = $1`,
            [id],
          );
          await tx.query(
            `UPDATE crm.outbox SET state = 'pending', revive_count = 1,
                                   revived_at = '2026-10-02T08:00:00.000Z', dead_at = NULL
              WHERE id = $1`,
            [id],
          );
          await tx.query(
            `UPDATE crm.outbox SET state = 'dead', dead_at = '2026-10-02T09:00:00.000Z',
                                   dead_reason = 'second' WHERE id = $1`,
            [id],
          );
          // The stale `revived_at` (08:00) is still on the row and is BEFORE this
          // episode's death (09:00), which is what makes it detectable as a leftover.
          await tx.query(
            `UPDATE crm.outbox SET state = 'pending', revive_count = $2, dead_at = NULL
              WHERE id = $1`,
            [id, bumpsCounter ? 2 : 1],
          );
          const { rows } = await tx.query<{ impossible: boolean | null }>(
            `SELECT bool_or(revived_at < died_at) AS impossible
               FROM crm.outbox_dead_letter
              WHERE outbox_id = $1 AND revived_at IS NOT NULL`,
            [id],
          );
          expect(rows[0]?.impossible, `counter ${bumpsCounter ? "moved" : "static"}`).toBe(false);
        });
      }
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

    it("says how many episodes are not in the list when one is deleted by hand", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "account missing");
        await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
        await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
        await markDead(tx, row.id, at("2026-10-02T09:00:00Z"), "period locked");

        // Nothing prunes this table today, so the only way a row goes is by hand — and
        // that is the case a ring would make routine. `attempt` survives the loss, so the
        // count does too, which is what makes the ring a safe retention answer where a
        // cascade was not.
        await tx.query("DELETE FROM crm.outbox_dead_letter WHERE outbox_id = $1 AND attempt = 1", [
          row.id,
        ]);

        const history = await attemptHistory(tx, row.id);
        expect(history).toHaveLength(1);
        const summary = summariseAttemptHistory(history);
        expect(summary.deaths).toBe(1);
        expect(summary.deathsEverRecorded).toBe(2);
        expect(summary.episodesMissing).toBe(1);
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

  // ---- the listing's order and its page size ------------------------------

  describe("the listing has a total order", () => {
    it("ties on died_at, which is why the sort cannot end there", async () => {
      // Two rows dead-lettered with ONE clock reading — the real shape of a batch that
      // dies before any ERP round trip (`UnknownOperationError` is refused by
      // `parseOperation`, so a whole batch of them settles inside one millisecond).
      await inTenant(async (tx) => {
        const a = await queued(tx, { entity: "Expense" });
        const b = await queued(tx, { entity: "JournalEntry" });
        const oneClockReading = at("2026-10-01T10:00:00Z");
        await markDead(tx, a.id, oneClockReading, "unknown outbox operation");
        await markDead(tx, b.id, oneClockReading, "unknown outbox operation");

        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(DISTINCT died_at) AS n FROM crm.outbox_dead_letter WHERE tenant_id = $1",
          [TENANT],
        );
        expect(Number(rows[0]!.n)).toBe(1);
      });
    });

    /**
     * A tie that neither `died_at` nor `attempt` can resolve, with the WRITE ORDER known.
     *
     * Three deaths at one instant across two outbox rows, arranged so that write order
     * disagrees with uuid order: the row with the LARGER uuid dies SECOND and then dies
     * again. So `ORDER BY seq DESC` (0041) leads with the larger uuid's second episode,
     * where the uuid tie-break this listing used before 0041 led with the smaller uuid's
     * first — the two orders differ in position 0 whatever plan Postgres picks, and only
     * one of them is what happened.
     *
     * Arranged rather than assumed, because the naive version of this test passed against
     * a sort that could not discriminate: with every key tied, a small sort preserves its
     * input and that input happened to arrive in index order. A tie that only agrees by
     * accident proves nothing, which is the whole reason this file exists.
     */
    const tiedAcrossTwoRows = async (
      tx: PoolClient,
    ): Promise<{ readonly smaller: string; readonly larger: string }> => {
      const one = await queued(tx, { entity: "Expense" });
      const two = await queued(tx, { entity: "JournalEntry" });
      const [smaller, larger] = [one.id, two.id].sort() as [string, string];
      const t = at("2026-10-01T10:00:00Z");

      await markDead(tx, smaller, t, "403 forbidden");
      await markDead(tx, larger, t, "403 forbidden");
      await reviveDeadLetter(tx, larger, REVIVER, t);
      await claimBatch(tx, TENANT, "worker-1", 10, t);
      await markDead(tx, larger, t, "403 forbidden, again");
      return { smaller, larger };
    };

    it("breaks a died_at tie on the order the rows were actually written", async () => {
      await inTenant(async (tx) => {
        const { smaller, larger } = await tiedAcrossTwoRows(tx);
        const got = await recentDeaths(tx, { limit: 50 });
        // Latest write first. Not `[[smaller,1],[larger,2],[larger,1]]`, which is what the
        // uuid tie-break produced and which puts the FIRST of the three deaths at the top
        // of a listing whose contract is "latest first".
        expect(got.map((r) => [r.outbox_id, r.attempt])).toEqual([
          [larger, 2],
          [larger, 1],
          [smaller, 1],
        ]);
        // And the key the order came from is on the row, so a reader can see it rather
        // than infer it: strictly decreasing down the page, three consecutive values.
        const seqs = got.map((r) => Number(r.seq));
        expect(seqs[0]! > seqs[1]! && seqs[1]! > seqs[2]!).toBe(true);
        expect(seqs[0]! - seqs[2]!).toBe(2);
      });
    });

    it("hands the ordering key back on both reads, as text", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "403");
        const [listed] = await recentDeaths(tx, { limit: 1 });
        const [historic] = await attemptHistory(tx, row.id);
        // Text, not a number: a bigint past 2^53 that arrives as a JavaScript number is a
        // bigint that silently rounds, and `pg` returns one as a string for that reason.
        expect(typeof listed!.seq).toBe("string");
        expect(listed!.seq).toMatch(/^[0-9]+$/);
        expect(historic!.seq).toBe(listed!.seq);
      });
    });

    it("refuses a hand-written seq outright, which is why no unique index guards it", async () => {
      // GENERATED ALWAYS, not a DEFAULT: 0036 part 1 needed `uq_disposal_obligation_seq` to
      // DETECT a hand-written value on a `DEFAULT nextval` column. Here the column type
      // rejects one before it reaches the heap, so an index could only catch an impossible
      // row — on a table the ring now DELETEs from on every death.
      await inTenant(async (tx) => {
        await expect(
          tx.query(
            `INSERT INTO crm.outbox_dead_letter
               (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
                died_at, entity, operation, target_record_id, source_table, source_id, seq)
             VALUES ($1,$2,1,0,1,now(),'Expense','create','AH-T','crm.expense_claim',$3, 999)`,
            [TENANT, randomUUID(), randomUUID()],
          ),
        ).rejects.toThrow(/identity column|non-DEFAULT value/);
      });
    });

    it("gives the same answer twice, and pages that nest", async () => {
      await inTenant(async (tx) => {
        await tiedAcrossTwoRows(tx);
        const first = await recentDeaths(tx, { limit: 50 });
        const second = await recentDeaths(tx, { limit: 50 });
        expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
        // A short page is a prefix of a long one. That is the property a listing needs and
        // the one a non-total sort cannot promise.
        expect((await recentDeaths(tx, { limit: 2 })).map((r) => r.id)).toEqual(
          first.slice(0, 2).map((r) => r.id),
        );
        expect(new Set(first.map((r) => r.id)).size).toBe(3);
      });
    });

    it("still puts the newest episode of one row first", async () => {
      await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "first");
        await reviveDeadLetter(tx, row.id, REVIVER, at("2026-10-02T08:00:00Z"));
        await claimBatch(tx, TENANT, "worker-1", 10, at("2026-10-02T08:01:00Z"));
        await markDead(tx, row.id, at("2026-10-02T09:00:00Z"), "second");
        expect((await recentDeaths(tx)).map((r) => r.attempt)).toEqual([2, 1]);
      });
    });

    it("binds the page size, so a fractional one is a number and not a syntax error", async () => {
      await inTenant(async (tx) => {
        for (const entity of ["Expense", "JournalEntry", "Item"]) {
          const row = await queued(tx, { entity });
          await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "403");
        }
        // `LIMIT ${1.9}` reached Postgres verbatim and errored; the floor is a page.
        expect(await recentDeaths(tx, { limit: 1.9 })).toHaveLength(1);
        // `Math.min(Math.max(NaN, 1), 500)` is NaN, which interpolated as the identifier
        // `NaN` and took the whole listing down. It now falls back to the default.
        expect(await recentDeaths(tx, { limit: Number.NaN })).toHaveLength(3);
        // Below the floor and above the ceiling both clamp rather than refuse.
        expect(await recentDeaths(tx, { limit: 0 })).toHaveLength(1);
        expect(await recentDeaths(tx, { limit: 10_000 })).toHaveLength(3);
      });
    });
  });

  // ---- the ring -----------------------------------------------------------

  /**
   * The history of ONE outbox row is bounded, and the bound costs reasons, never the count.
   *
   * 0036 recorded against itself that nothing prunes this table and argued that what bounds
   * it is the thing being counted — a row appears only when a write is permanently refused.
   * True of the table, false of a row: an ERP-side cause nobody fixes, with a revive pressed
   * each time, grows ONE row's history without limit. 0041 made the recording trigger a
   * ring.
   *
   * Driven through the real writers (`markDead`, `reviveDeadLetter`), never by inserting
   * history rows by hand, for the reason the rest of this file is: the trim lives in the
   * trigger, so a test that wrote the rows itself would be testing nothing at all.
   */
  describe("the ring", () => {
    /** Kill and revive one outbox row `n` times, through the paths the relay uses. */
    const diedNTimes = async (tx: PoolClient, n: number): Promise<string> => {
      const row = await queued(tx);
      for (let i = 1; i <= n; i += 1) {
        const t = new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + i * 60_000);
        expect(await markDead(tx, row.id, t, `refusal ${i}`)).toBe(true);
        if (i < n) {
          expect(
            await reviveDeadLetter(tx, row.id, REVIVER, new Date(t.getTime() + 30_000)),
          ).toBe(true);
        }
      }
      return row.id;
    };

    /** The ring's own number, read from the database so this file holds no second copy. */
    const ringSize = async (tx: PoolClient): Promise<number> => {
      const { rows } = await tx.query<{ n: number }>(
        "SELECT crm.outbox_dead_letter_ring_size() AS n",
      );
      return rows[0]!.n;
    };

    it("keeps the newest episodes and still reports every one that happened", async () => {
      await inTenant(async (tx) => {
        const size = await ringSize(tx);
        const deaths = size + 10;
        const outboxId = await diedNTimes(tx, deaths);

        const history = await attemptHistory(tx, outboxId);
        expect(history).toHaveLength(size);

        // THE PROPERTY THAT MAKES A RING ACCEPTABLE. `attempt` is allocated past every
        // episode ever recorded, so the newest surviving row carries the true count and
        // the summary can say how much it is not showing.
        const summary = summariseAttemptHistory(history);
        expect(summary.deaths).toBe(size);
        expect(summary.deathsEverRecorded).toBe(deaths);
        expect(summary.episodesMissing).toBe(deaths - size);

        // The newest are what survived, not the oldest, and they are contiguous.
        expect(history.map((h) => h.attempt)).toEqual(
          Array.from({ length: size }, (_, i) => deaths - size + 1 + i),
        );
        expect(history[0]!.reason).toBe(`refusal ${deaths - size + 1}`);
        expect(history[history.length - 1]!.reason).toBe(`refusal ${deaths}`);
        // Episode 1's reason is gone and is not recoverable. That is the stated cost.
        expect(history.some((h) => h.reason === "refusal 1")).toBe(false);
      });
    });

    it("trims nothing until the ring is actually full", async () => {
      await inTenant(async (tx) => {
        const size = await ringSize(tx);
        const outboxId = await diedNTimes(tx, size);
        const history = await attemptHistory(tx, outboxId);
        expect(history).toHaveLength(size);
        // The boundary, not just "fewer than the ring": a trim one episode early would
        // report a shortfall over a history that is complete.
        expect(summariseAttemptHistory(history).episodesMissing).toBe(0);
        expect(history[0]!.attempt).toBe(1);
      });
    });

    it("bounds each outbox row on its own, not the tenant", async () => {
      await inTenant(async (tx) => {
        const size = await ringSize(tx);
        const a = await diedNTimes(tx, size + 5);
        const b = await diedNTimes(tx, 3);
        // `b` is untouched by `a` filling its ring: the trim is scoped to `NEW.id`.
        expect(await attemptHistory(tx, a)).toHaveLength(size);
        expect(await attemptHistory(tx, b)).toHaveLength(3);
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.outbox_dead_letter WHERE tenant_id = $1",
          [TENANT],
        );
        expect(Number(rows[0]!.n)).toBe(size + 3);
      });
    });

    it("leaves the open episode and its revive bookkeeping alone", async () => {
      await inTenant(async (tx) => {
        const size = await ringSize(tx);
        const outboxId = await diedNTimes(tx, size + 3);
        const history = await attemptHistory(tx, outboxId);
        const newest = history[history.length - 1]!;
        // The highest-numbered episode is the one row the ring can never discard, which is
        // what keeps the trigger's revive branch able to find it.
        expect(newest.attempt).toBe(size + 3);
        expect(newest.revived_at).toBeNull();
        expect(await reviveDeadLetter(tx, outboxId, REVIVER, at("2027-01-01T08:00:00Z"))).toBe(
          true,
        );
        const after = await attemptHistory(tx, outboxId);
        expect(after).toHaveLength(size);
        expect(after[after.length - 1]!.revived_at).toEqual(at("2027-01-01T08:00:00Z"));
        expect(after[after.length - 1]!.revived_by).toBe(REVIVER);
      });
    });

    it("trims under FORCE RLS on the relay's own path, and reaches no other tenant", async () => {
      // THE HAZARD THIS GUARDS. DML as `crm_app` under FORCE ROW LEVEL SECURITY with no
      // tenant context matches zero rows and reports success — how 0032 shipped broken.
      // The trim is a DELETE, so getting it wrong is either a ring that never trims or a
      // delete that is not confined to one tenant, and the two failures look nothing alike.
      //
      // Driven end to end through `markDead` and `reviveDeadLetter` inside
      // `withTenantContext`, which is the relay's own path, with a second tenant holding
      // history of its own across the same transaction boundary.
      const size = await inTenant(ringSize);
      const FOREIGN_OUTBOX = randomUUID();

      try {
        await withTenantContext(client, OTHER_TENANT, async (other) => {
          for (let i = 1; i <= 5; i += 1) {
            await other.query(
              `INSERT INTO crm.outbox_dead_letter
                 (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
                  died_at, reason, entity, operation, target_record_id, source_table, source_id)
               VALUES ($1,$2,$3,$4,1,now(),$5,'Expense','create','AH-R','crm.expense_claim',$6)`,
              [OTHER_TENANT, FOREIGN_OUTBOX, i, i - 1, `seeded ${i}`, randomUUID()],
            );
          }
        });

        // One committed transaction per death, so the trim is exercised the way the relay
        // reaches it — a fresh tenant context each time, not one long open transaction.
        const outboxId = await inTenant(async (tx) => (await queued(tx)).id);
        for (let i = 1; i <= size + 2; i += 1) {
          const t = new Date(Date.UTC(2026, 9, 2, 10, 0, 0) + i * 60_000);
          await inTenant(async (tx) => {
            expect(await markDead(tx, outboxId, t, `real ${i}`)).toBe(true);
            if (i < size + 2) {
              expect(
                await reviveDeadLetter(tx, outboxId, REVIVER, new Date(t.getTime() + 1_000)),
              ).toBe(true);
            }
          });
        }

        await inTenant(async (tx) => {
          // The trim ran. A trim that matched zero rows — the 0032 shape — leaves
          // `size + 2` here, so this number IS the assertion that RLS did not blind it.
          expect(await attemptHistory(tx, outboxId)).toHaveLength(size);
        });

        // And it stopped at its own tenant and its own outbox row. A DELETE that had lost
        // either predicate, or had escaped the policy under definer's rights, would have
        // taken these five with it: they are the only other rows in the table.
        await withTenantContext(client, OTHER_TENANT, async (other) => {
          const theirs = await attemptHistory(other, FOREIGN_OUTBOX);
          expect(theirs.map((h) => h.reason)).toEqual([
            "seeded 1",
            "seeded 2",
            "seeded 3",
            "seeded 4",
            "seeded 5",
          ]);
        });
      } finally {
        await withTenantContext(client, OTHER_TENANT, async (other) => {
          await other.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [
            OTHER_TENANT,
          ]);
        });
      }
    });

    it("cannot be reached at all without a tenant context, so it cannot trim blindly", async () => {
      // The structural half of the argument, and the reason the trim does not have to lift
      // FORCE the way 0027's and 0041's own backfills do. With no `app.current_tenant_id`
      // the UPDATE that fires the trigger matches no row of `crm.outbox` in the first
      // place, so the trigger never runs — there is no path on which the trim executes
      // against an unscoped view of the table.
      const outboxId = await inTenant(async (tx) => {
        const row = await queued(tx);
        await markDead(tx, row.id, at("2026-10-01T10:00:00Z"), "first");
        return row.id;
      });

      const bare = await pool.connect();
      try {
        // Not `withTenantContext`: the point is a connection that never set the GUC.
        const { rowCount } = await bare.query(
          "UPDATE crm.outbox SET state = 'pending', dead_at = NULL WHERE id = $1",
          [outboxId],
        );
        expect(rowCount).toBe(0);
      } finally {
        bare.release();
      }

      await inTenant(async (tx) => {
        // Still dead, still one episode, still open. Nothing happened.
        const history = await attemptHistory(tx, outboxId);
        expect(history).toHaveLength(1);
        expect(history[0]!.revived_at).toBeNull();
      });
    });

    it("states the ring's size once, in the database", async () => {
      // The constant is a function and not a literal in the trigger, so there is one
      // definition to read and one to change. A test that hardcoded 50 would keep passing
      // after the first copy moved, which is the failure this assertion exists to prevent.
      await inTenant(async (tx) => {
        expect(await ringSize(tx)).toBe(50);
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'crm' AND p.proname = 'outbox_dead_letter_ring_size'`,
        );
        expect(Number(rows[0]!.n)).toBe(1);
        // And the trigger reads it rather than restating it.
        const { rows: src } = await tx.query<{ src: string }>(
          `SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'crm' AND p.proname = 'outbox_dead_letter_record'`,
        );
        expect(src[0]!.src).toContain("crm.outbox_dead_letter_ring_size()");
        expect(src[0]!.src).not.toMatch(/\b50\b/);
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
        // 0043 renamed the key with its columns: `(tenant_id, outbox_id, attempt)`, because
        // a unique index is enforced with row security disabled and the two-column form was
        // therefore cross-tenant.
        await expect(insertHistory(tx, { outbox_id: outboxId, attempt: 2 })).rejects.toThrow(
          /uq_outbox_dead_letter_tenant_attempt/,
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

    /**
     * THE EPISODE KEY IS TENANT-SCOPED, because a unique index is not confined by RLS.
     *
     * This schema records two halves of that asymmetry already — a foreign key's
     * referential check runs with row security disabled (0035, 0037), and a CHECK's
     * validation scan sees every row (0032, 0039). A UNIQUE INDEX is the same kind of
     * thing, and `uq_outbox_dead_letter_attempt (outbox_id, attempt)` was cross-tenant
     * while the trigger allocating `attempt` was confined. Two consequences: the index
     * answered "does another tenant hold history under this id", and the refusal took the
     * `UPDATE crm.outbox` that fired the trigger down with it — so a death could not be
     * recorded at all, in the table whose only purpose is to be the record of a death.
     *
     * Reachable by hand rather than by accident (`crm.outbox.id` is `gen_random_uuid()`),
     * which is not hypothetical in this table: 0036 gave it no foreign key on purpose and
     * reasons about hand-written rows throughout, and 0038 exists because one of them
     * recorded an episode as having ended before it began.
     */
    it("lets two tenants hold episode 1 under the same outbox id", async () => {
      const shared = randomUUID();
      const episode = (tenantId: string, marker: string) =>
        [tenantId, shared, 1, 0, 1, "Expense", "create", marker, "crm.expense_claim", randomUUID()] as const;
      const insert = `INSERT INTO crm.outbox_dead_letter
          (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
           died_at, entity, operation, target_record_id, source_table, source_id)
        VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10)`;

      await inTenant((tx) => tx.query(insert, [...episode(TENANT, "AH-SHARED-A")]));
      // Committed, and invisible to the other tenant — which is exactly the state in which
      // the old index refused: the policy hides the row, so nothing here could have known.
      await withTenantContext(client, OTHER_TENANT, async (other) => {
        const { rows } = await other.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM crm.outbox_dead_letter WHERE outbox_id = $1",
          [shared],
        );
        expect(rows[0]?.n).toBe("0");
        await other.query(insert, [...episode(OTHER_TENANT, "AH-SHARED-B")]);
      });

      // Each tenant sees its own episode 1 and nothing else.
      await inTenant(async (tx) => {
        const mine = await attemptHistory(tx, shared);
        expect(mine).toHaveLength(1);
        expect(mine[0]?.target_record_id).toBe("AH-SHARED-A");
      });
      await withTenantContext(client, OTHER_TENANT, async (other) => {
        const theirs = await attemptHistory(other, shared);
        expect(theirs).toHaveLength(1);
        expect(theirs[0]?.target_record_id).toBe("AH-SHARED-B");
      });
    });

    it("keys episodes on (tenant_id, outbox_id, attempt), not on (outbox_id, attempt)", async () => {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'crm' AND tablename = 'outbox_dead_letter' AND indexname LIKE 'uq_%'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toMatch(/UNIQUE INDEX uq_outbox_dead_letter_tenant_attempt/);
      expect(rows[0]?.indexdef).toMatch(/\(tenant_id, outbox_id, attempt\)/);
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

    it("accepts a reviver from ANOTHER tenant, and resolves no name for them", async () => {
      // The consequence of carrying `revived_by` with no reference at all, stated as a
      // test rather than left to the header. 0035 made every rep reference composite
      // because a referential check runs with row security disabled, so a single-column
      // FK lets one tenant name another tenant's row — and NO foreign key is exactly as
      // permissive on that property, in the one place `composite-fk.contract.test.ts`
      // cannot see it ("a column with no reference is outside what this guard can see").
      //
      // What it does NOT do is leak: `revived_by_name` is resolved by a LEFT JOIN inside
      // `crm.outbox_dead_letter_history`, which is SECURITY INVOKER, so the join is
      // RLS-filtered and a foreign rep reads as a recorded uuid beside a null name —
      // indistinguishable from an id that never existed, so there is no oracle either.
      const FOREIGN_REP = "e4100000-0000-4000-8000-0000000000f1";
      await withTenantContext(client, OTHER_TENANT, async (other) => {
        await other.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,'ah-foreign','AH-F','SHOULD NOT BE READABLE') ON CONFLICT DO NOTHING`,
          [FOREIGN_REP, OTHER_TENANT],
        );
      });
      try {
        await inTenant(async (tx) => {
          const outboxId = randomUUID();
          await tx.query(
            `INSERT INTO crm.outbox_dead_letter
               (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
                died_at, reason, entity, operation, target_record_id, source_table, source_id,
                revived_at, revived_by)
             VALUES ($1,$2,1,0,1,now(),'r','Expense','create','AH-T','crm.expense_claim',$3,
                     now(),$4)`,
            [TENANT, outboxId, randomUUID(), FOREIGN_REP],
          );
          const [entry] = await attemptHistory(tx, outboxId);
          expect(entry!.revived_by).toBe(FOREIGN_REP);
          expect(entry!.revived_by_name).toBeNull();
        });
      } finally {
        await withTenantContext(client, OTHER_TENANT, async (other) => {
          await other.query("DELETE FROM crm.rep_profile WHERE id = $1", [FOREIGN_REP]);
        });
      }
    });

    it("keeps a reviver's id after their profile is gone, with a null name beside it", async () => {
      const GHOST = "e4100000-0000-4000-8000-0000000000ae";
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
      // Deliberately NOT derived from `attempt`: nothing in the summary may read `seq`, so
      // a constant here is the assertion. `attempt` is the only key these answers rest on,
      // which is what lets them survive the ring trimming rows out from under them.
      seq: "1",
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
        deathsEverRecorded: 0,
        episodesMissing: 0,
        revives: 0,
        distinctReasons: 0,
        repeatedReasons: [],
        unexplained: 0,
        alwaysTheSameReason: false,
        neverTheSameReason: false,
        unaccountedRevivals: 0,
        impossibleRevivals: 0,
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

    it("reads the true death count off the newest episode, not off the list length", () => {
      // A page that starts at episode 3 — what a trimmed history, or a page boundary,
      // hands this function. `deaths` is what is in hand; `deathsEverRecorded` is what
      // happened; the difference is what is not being shown.
      const s = summariseAttemptHistory([
        entry({ attempt: 3, reason: "third" }),
        entry({ attempt: 4, reason: "fourth" }),
      ]);
      expect(s.deaths).toBe(2);
      expect(s.deathsEverRecorded).toBe(4);
      expect(s.episodesMissing).toBe(2);
    });

    it("never reports a negative shortfall", () => {
      // `attempt` is allocated per outbox row, so a list spanning two rows can hold more
      // entries than the highest `attempt` in it. The shortfall clamps rather than going
      // negative and reading as a surplus of episodes.
      const s = summariseAttemptHistory([
        entry({ attempt: 1, outbox_id: "o1" }),
        entry({ attempt: 1, outbox_id: "o2" }),
      ]);
      expect(s.deathsEverRecorded).toBe(1);
      expect(s.episodesMissing).toBe(0);
    });

    it("counts an episode that ended before it began", () => {
      const s = summariseAttemptHistory([
        entry({
          attempt: 1,
          died_at: at("2026-10-02T09:00:00Z"),
          revived_at: at("2026-10-02T08:00:00Z"),
        }),
        entry({
          attempt: 2,
          died_at: at("2026-10-03T09:00:00Z"),
          revived_at: at("2026-10-03T10:00:00Z"),
        }),
        entry({ attempt: 3, died_at: at("2026-10-04T09:00:00Z") }),
      ]);
      expect(s.impossibleRevivals).toBe(1);
      expect(s.revives).toBe(2);
    });

    it("does not call a same-instant revive impossible", () => {
      // A revive stamped with the death's own timestamp is odd and not contradictory, and
      // the test exists because `<=` here would report every such row as corrupt.
      const t = at("2026-10-02T09:00:00Z");
      expect(
        summariseAttemptHistory([entry({ attempt: 1, died_at: t, revived_at: t })])
          .impossibleRevivals,
      ).toBe(0);
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
