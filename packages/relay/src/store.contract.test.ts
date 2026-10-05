import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool } from "@crm/db/testing";

import { attemptHistory, summariseAttemptHistory } from "./attempt-history.js";
import {
  claimBatch,
  enqueueOutbox,
  markDead,
  markDelivered,
  markRetry,
  outboxLag,
  reclaimStale,
} from "./store.js";

/**
 * The outbox store, against a real Postgres.
 *
 * `store.ts` had no suite of its own: `relay.contract.test.ts` drives it through
 * `OutboxRelay` and `dead-letters.contract.test.ts` through the dead-letter reads, so the
 * four settle functions were only ever exercised on the happy path where the row is in the
 * state the caller expects. That is the half `reclaimStale` makes untrue — it exists so a
 * killed worker's rows are not stranded, and the overlap it creates is two live workers
 * settling the same row in whichever order their ERP round trips finish.
 *
 * Every assertion here reads the state back from the database, and the ones that matter
 * read `crm.outbox_dead_letter` as well, because 0036's trigger turns a wrong settlement
 * into a permanent entry in a record of regulated failures. A fake `PgConnection` that
 * recorded `{sql, params}` would assert the WHERE clause is spelled correctly and nothing
 * about whether it matched a row.
 *
 * `appPool()` connects as `crm_app`, so RLS is live under FORCE and the isolation
 * assertions mean something; a superuser bypasses the policy even under FORCE.
 */

/**
 * A reserved tenant of this file's own, derived from the `e…` block in
 * `packages/db/src/testing.ts` by continuing its numbering past `TENANT_LIVE_ERP`
 * (`…017`) and this file's sibling (`…018`). Declared here because `testing.ts` is not
 * this change's to edit; owed an entry there as `TENANT_RELAY_STORE`.
 */
const TENANT = "e5100000-0000-4000-8000-000000000019";
const OTHER_TENANT = "e5100000-0000-4000-8000-0000000000b9";

describe("the outbox store", () => {
  let pool: Pool;
  let client: PoolClient;

  const at = (iso: string): Date => new Date(iso);
  /** Comfortably past the `now()` default on `next_attempt_at`, so a claim finds the row. */
  const DUE = at("2027-01-01T09:00:00Z");

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  const reset = async (): Promise<void> => {
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  afterAll(async () => {
    await reset();
    client?.release();
    await pool?.end();
  });

  afterEach(reset);

  const queued = async (
    tx: PoolClient,
    opts: { entity?: string; tenant?: string } = {},
  ): Promise<string> => {
    const { id } = await enqueueOutbox(tx, opts.tenant ?? TENANT, {
      entity: opts.entity ?? "Expense",
      operation: "create",
      payload: { amount: 12 },
      targetRecordId: `ST-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      sourceTable: "crm.expense_claim",
      sourceId: randomUUID(),
    });
    return id;
  };

  const stateOf = async (tx: PoolClient, id: string): Promise<string | null> => {
    const { rows } = await tx.query<{ state: string }>(
      "SELECT state FROM crm.outbox WHERE id = $1",
      [id],
    );
    return rows[0]?.state ?? null;
  };

  /** A row in flight, as a worker that has claimed it sees the world. */
  const inFlight = async (tx: PoolClient): Promise<string> => {
    const id = await queued(tx);
    expect(await claimBatch(tx, TENANT, "worker-a", 10, DUE)).toHaveLength(1);
    return id;
  };

  // ---- a settlement that arrives too late ---------------------------------

  describe("a worker settling a row it no longer holds", () => {
    it("cannot kill a write the ERP already accepted", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        expect(await markDelivered(tx, id, DUE, { ok: true })).toBe(true);

        // Worker A's round trip finally returns with a permanent refusal. The write
        // landed; A's verdict is stale.
        expect(await markDead(tx, id, DUE, "403 forbidden")).toBe(false);
        expect(await stateOf(tx, id)).toBe("delivered");
      });
    });

    it("...and therefore records no death that never happened", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDelivered(tx, id, DUE, { ok: true });
        await markDead(tx, id, DUE, "403 forbidden");

        // The reason this guard is in the store and not left to the relay: 0036's trigger
        // records whatever the state change says, nothing prunes the table, and the rep
        // would have been told urgently that a write that succeeded had failed.
        expect(await attemptHistory(tx, id)).toHaveLength(0);
      });
    });

    it("cannot put a dead row back in the queue by retrying it", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        expect(await markDead(tx, id, DUE, "ledger account LA-1 not found")).toBe(true);

        // Worker B's round trip returns a transient fault for the same row.
        expect(await markRetry(tx, id, at("2027-01-01T09:05:00Z"), "503")).toBe(false);
        expect(await stateOf(tx, id)).toBe("dead");
      });
    });

    it("...and therefore does not close the episode as a revive nobody performed", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDead(tx, id, DUE, "ledger account LA-1 not found");
        await markRetry(tx, id, at("2027-01-01T09:05:00Z"), "503");

        const history = await attemptHistory(tx, id);
        expect(history).toHaveLength(1);
        // Still open. A `dead -> pending` here would have stamped `revived_at` with no
        // actor and no `revive_count`, which is the hand-written path the history exists
        // to expose — manufactured by the relay itself.
        expect(history[0]!.revived_at).toBeNull();
        expect(summariseAttemptHistory(history).unaccountedRevivals).toBe(0);
      });
    });

    it("lets a late delivery win over a death, and closes the episode", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDead(tx, id, at("2027-01-01T09:00:00Z"), "503 at the last attempt");

        // The one ordering left alone, deliberately: the write DID land, so the delivery
        // is the truth and the episode genuinely ended.
        expect(await markDelivered(tx, id, at("2027-01-01T09:30:00Z"), { ok: true })).toBe(true);
        expect(await stateOf(tx, id)).toBe("delivered");

        const history = await attemptHistory(tx, id);
        expect(history).toHaveLength(1);
        // CLOSED, and closed on the TRANSACTION clock rather than on the `now` handed to
        // `markDelivered`. `crm.outbox` has nowhere to put "the episode ended at", so
        // 0036's trigger falls back to `now()` — which means `died_at` comes from the
        // relay's clock and `revived_at` from the server's. Comparable in production,
        // where the relay's clock IS the wall clock, and not under an injected one, which
        // is why this asserts a time was recorded rather than which.
        expect(history[0]!.revived_at).not.toBeNull();
        // Ended without an actor, which is what the column says it means.
        expect(history[0]!.revived_by).toBeNull();
      });
    });
  });

  describe("the settle functions in their ordinary states", () => {
    it("kills a row in flight", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        expect(await markDead(tx, id, DUE, "403")).toBe(true);
        expect(await stateOf(tx, id)).toBe("dead");
      });
    });

    it("kills a row that was never claimed", async () => {
      await inTenant(async (tx) => {
        // `dead-letters.contract.test.ts` settles pending rows directly, and an operation
        // refused by `parseOperation` dead-letters without a claim ever succeeding. The
        // guard must not reach either.
        const id = await queued(tx);
        expect(await markDead(tx, id, DUE, "unknown outbox operation")).toBe(true);
        expect(await stateOf(tx, id)).toBe("dead");
      });
    });

    it("re-states a death on a row that is already dead, without adding an episode", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDead(tx, id, DUE, "first");
        expect(await markDead(tx, id, at("2027-01-01T09:00:01Z"), "first, again")).toBe(true);
        expect(await attemptHistory(tx, id)).toHaveLength(1);
      });
    });

    it("retries a row in flight", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        expect(await markRetry(tx, id, at("2027-01-01T09:05:00Z"), "503")).toBe(true);
        expect(await stateOf(tx, id)).toBe("pending");
      });
    });

    it("reports a miss for an id that is not there", async () => {
      await inTenant(async (tx) => {
        const ghost = randomUUID();
        expect(await markDelivered(tx, ghost, DUE, { ok: true })).toBe(false);
        expect(await markRetry(tx, ghost, DUE, "503")).toBe(false);
        expect(await markDead(tx, ghost, DUE, "403")).toBe(false);
      });
    });
  });

  // ---- what a collapsed duplicate collapsed ONTO --------------------------

  describe("enqueueOutbox reports the state it found", () => {
    const sameWrite = {
      entity: "Expense",
      operation: "create",
      payload: { amount: 12 },
      targetRecordId: "ST-COLLAPSE",
      sourceTable: "crm.expense_claim",
      sourceId: "00000000-0000-4000-8000-0000000000c1",
    } as const;

    it("says pending for a row it just wrote", async () => {
      await inTenant(async (tx) => {
        expect(await enqueueOutbox(tx, TENANT, sameWrite)).toMatchObject({
          enqueued: true,
          state: "pending",
        });
      });
    });

    it("says pending for the ordinary double-tap, and the same id", async () => {
      await inTenant(async (tx) => {
        const first = await enqueueOutbox(tx, TENANT, sameWrite);
        const second = await enqueueOutbox(tx, TENANT, sameWrite);
        expect(second).toEqual({ enqueued: false, id: first.id, state: "pending" });
      });
    });

    it("says DEAD when the same write collapses onto a permanent refusal", async () => {
      await inTenant(async (tx) => {
        const first = await enqueueOutbox(tx, TENANT, sameWrite);
        await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        await markDead(tx, first.id, DUE, "ledger account LA-1 not found");

        // `enqueued: false` used to be the whole answer, and a caller reading it as
        // "already queued" was wrong: the intent is dropped, the rep's app says recorded
        // for the second time, and the only way back is a revive by a person.
        const again = await enqueueOutbox(tx, TENANT, sameWrite);
        expect(again).toEqual({ enqueued: false, id: first.id, state: "dead" });
      });
    });

    it("says delivered when the write already landed", async () => {
      await inTenant(async (tx) => {
        const first = await enqueueOutbox(tx, TENANT, sameWrite);
        await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        await markDelivered(tx, first.id, DUE, { ok: true });
        expect(await enqueueOutbox(tx, TENANT, sameWrite)).toEqual({
          enqueued: false,
          id: first.id,
          state: "delivered",
        });
      });
    });

    it("says in_flight while a worker holds it", async () => {
      await inTenant(async (tx) => {
        const first = await enqueueOutbox(tx, TENANT, sameWrite);
        await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        expect((await enqueueOutbox(tx, TENANT, sameWrite)).state).toBe("in_flight");
        expect((await enqueueOutbox(tx, TENANT, sameWrite)).id).toBe(first.id);
      });
    });
  });

  // ---- claiming and reclaiming -------------------------------------------

  describe("claimBatch", () => {
    it("consumes an attempt at claim time, not on failure", async () => {
      await inTenant(async (tx) => {
        const id = await queued(tx);
        const [claimed] = await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        expect(claimed!.attempts).toBe(1);
        expect(await stateOf(tx, id)).toBe("in_flight");
      });
    });

    it("does not claim a row another worker holds", async () => {
      await inTenant(async (tx) => {
        await inFlight(tx);
        expect(await claimBatch(tx, TENANT, "worker-b", 10, DUE)).toHaveLength(0);
      });
    });

    it("does not claim a dead row — its way back is a revive, not a drain", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDead(tx, id, DUE, "403");
        expect(await claimBatch(tx, TENANT, "worker-b", 10, DUE)).toHaveLength(0);
      });
    });

    it("does not claim a row that is not due yet", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markRetry(tx, id, at("2027-06-01T00:00:00Z"), "503");
        expect(await claimBatch(tx, TENANT, "worker-b", 10, DUE)).toHaveLength(0);
        expect(await claimBatch(tx, TENANT, "worker-b", 10, at("2027-06-01T00:00:01Z"))).toHaveLength(1);
      });
    });

    it("returns rows in enqueue order, which is seq and not created_at", async () => {
      await inTenant(async (tx) => {
        // Three rows in ONE transaction, so `created_at` is identical to the microsecond
        // and `seq` is the only thing that orders them (0027).
        const entities = ["Expense", "JournalEntry", "Item"];
        for (const entity of entities) await queued(tx, { entity });
        const claimed = await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        expect(claimed.map((r) => r.entity)).toEqual(entities);
      });
    });
  });

  describe("reclaimStale", () => {
    it("returns an expired lease to pending so another worker can take it", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        const later = new Date(DUE.getTime() + 120_000);
        expect(await reclaimStale(tx, TENANT, 60_000, later)).toBe(1);
        expect(await stateOf(tx, id)).toBe("pending");
        expect(await claimBatch(tx, TENANT, "worker-b", 10, later)).toHaveLength(1);
      });
    });

    it("leaves a lease that is still live alone", async () => {
      await inTenant(async (tx) => {
        await inFlight(tx);
        expect(await reclaimStale(tx, TENANT, 60_000, new Date(DUE.getTime() + 1_000))).toBe(0);
      });
    });

    it("does not touch a dead row, and records nothing about one", async () => {
      await inTenant(async (tx) => {
        const id = await inFlight(tx);
        await markDead(tx, id, DUE, "403");
        expect(await reclaimStale(tx, TENANT, 60_000, new Date(DUE.getTime() + 120_000))).toBe(0);
        expect(await stateOf(tx, id)).toBe("dead");
        expect(await attemptHistory(tx, id)).toHaveLength(1);
        expect((await attemptHistory(tx, id))[0]!.revived_at).toBeNull();
      });
    });
  });

  describe("outboxLag", () => {
    it("counts each state and ages the oldest undelivered row", async () => {
      await inTenant(async (tx) => {
        const pending = await queued(tx, { entity: "Expense" });
        const dead = await queued(tx, { entity: "JournalEntry" });
        const delivered = await queued(tx, { entity: "Item" });
        await claimBatch(tx, TENANT, "worker-a", 10, DUE);
        await markDead(tx, dead, DUE, "403");
        await markDelivered(tx, delivered, DUE, { ok: true });
        await markRetry(tx, pending, DUE, "503");

        const lag = await outboxLag(tx, TENANT, new Date(DUE.getTime() + 3_600_000));
        expect(lag).toMatchObject({ pending: 1, inFlight: 0, dead: 1 });
        // `created_at` is the real `now()` of this transaction, so the age is measured
        // against a date in 2027 and is large rather than exact.
        expect(lag.oldestPendingAgeSeconds).toBeGreaterThan(0);
      });
    });

    it("reports no age at all when nothing is waiting", async () => {
      await inTenant(async (tx) => {
        expect(await outboxLag(tx, TENANT, DUE)).toEqual({
          pending: 0,
          inFlight: 0,
          dead: 0,
          oldestPendingAgeSeconds: null,
        });
      });
    });
  });

  // ---- isolation ----------------------------------------------------------

  describe("tenant isolation", () => {
    it("cannot settle another tenant's row", async () => {
      const foreign = await withTenantContext(client, OTHER_TENANT, (tx) =>
        queued(tx, { tenant: OTHER_TENANT }),
      );

      await inTenant(async (tx) => {
        // Every settle takes an id alone, which is safe only because RLS is the predicate
        // the caller cannot forget. All three miss, and the row is untouched.
        expect(await markDead(tx, foreign, DUE, "403")).toBe(false);
        expect(await markRetry(tx, foreign, DUE, "503")).toBe(false);
        expect(await markDelivered(tx, foreign, DUE, { ok: true })).toBe(false);
        expect(await stateOf(tx, foreign)).toBeNull();
      });

      await withTenantContext(client, OTHER_TENANT, async (tx) => {
        expect(await stateOf(tx, foreign)).toBe("pending");
      });
    });

    it("cannot enqueue into another tenant", async () => {
      await inTenant(async (tx) => {
        await expect(
          enqueueOutbox(tx, OTHER_TENANT, {
            entity: "Expense",
            operation: "create",
            payload: {},
            targetRecordId: "ST-SMUGGLE",
            sourceTable: "crm.expense_claim",
            sourceId: randomUUID(),
          }),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it("does not claim or count another tenant's queue", async () => {
      await withTenantContext(client, OTHER_TENANT, (tx) => queued(tx, { tenant: OTHER_TENANT }));
      await inTenant(async (tx) => {
        expect(await claimBatch(tx, TENANT, "worker-a", 10, DUE)).toHaveLength(0);
        expect((await outboxLag(tx, TENANT, DUE)).pending).toBe(0);
      });
    });
  });
});
