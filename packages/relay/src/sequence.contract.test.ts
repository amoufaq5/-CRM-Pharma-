import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { ErpClient, type FetchLike } from "@crm/acl";
import { ERP_SCHEMA_FIXTURE } from "@crm/acl/fixtures";
import { withTenantContext } from "@crm/db";

import { OutboxRelay } from "./relay.js";
import { claimBatch, enqueueOutbox } from "./store.js";

import { appPool, TENANT_OUTBOX_SEQ as TENANT } from "@crm/db/testing";

/**
 * `crm.outbox.seq` (migration 0027) and the claim order it buys.
 *
 * Its own file and its own tenant rather than extra cases in `relay.contract.test.ts`:
 * the suite shares one database with `fileParallelism: false`, and the reserved-tenant
 * block in `@crm/db/testing` exists because two files on one tenant id see each other's
 * rows. One of these tests holds a transaction open across another connection's work,
 * which is precisely the shape that would poison a neighbour's counts.
 *
 * `appPool()`, not `testPool()`: `OutboxRelay` opens its own connections and inherits the
 * pool's role, and the admin role bypasses RLS even under FORCE.
 */

const CREATE = "create";
const WIN = "transition:win";

/** An ERP that answers everything 200 and records the path of every call, in order. */
function recordingErp(calls: string[]): ErpClient {
  const fetchImpl: FetchLike = (url, init) => {
    const isSchema = url.endsWith("/v1/meta/schema");
    if (!isSchema) calls.push(`${init.method} ${url.replace("https://erp.example", "")}`);
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(isSchema ? ERP_SCHEMA_FIXTURE : { id: "x" })),
    });
  };
  return new ErpClient({
    baseUrl: "https://erp.example",
    credential: { token: () => Promise.resolve("t") },
    fetch: fetchImpl,
  });
}

describe("crm.outbox.seq orders rows enqueued in one transaction", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = appPool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]),
    );
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  beforeEach(async () => {
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]),
    );
  });

  /** Appends `operations` for one target record, in the order given, in ONE transaction. */
  async function enqueuePair(target: string, operations: readonly string[]): Promise<void> {
    await withTenantContext(admin, TENANT, async (tx) => {
      for (const operation of operations) {
        await enqueueOutbox(tx, TENANT, {
          entity: "Opportunity",
          operation,
          payload: { name: "Deal", account_id: "A", amount: "10.00" },
          targetRecordId: target,
          sourceTable: "crm.visit",
          sourceId: crypto.randomUUID(),
        });
      }
    });
  }

  async function seqOf(target: string, operation: string): Promise<number> {
    return withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ seq: string }>(
        `SELECT seq::text AS seq FROM crm.outbox
          WHERE tenant_id = $1 AND target_record_id = $2 AND operation = $3`,
        [TENANT, target, operation],
      );
      return Number(rows[0]!.seq);
    });
  }

  it("is the only thing that CAN order them — created_at is identical to the microsecond", async () => {
    // The premise of migration 0027. `created_at` defaults to `now()`, which is the
    // transaction timestamp, so this is not a matter of resolution: the two rows carry the
    // same instant because they were written in the same transaction, and no amount of
    // precision separates them.
    await enqueuePair("crm_seq_premise", [CREATE, WIN]);

    const { distinctCreatedAt, seqSpread } = await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ created: string; spread: string }>(
        `SELECT count(DISTINCT created_at)::text AS created,
                (max(seq) - min(seq))::text      AS spread
           FROM crm.outbox WHERE tenant_id = $1`,
        [TENANT],
      );
      return { distinctCreatedAt: Number(rows[0]!.created), seqSpread: Number(rows[0]!.spread) };
    });

    expect(distinctCreatedAt).toBe(1);
    expect(seqSpread).toBe(1);
  });

  it("claims a create before the transition that acts on it, every time", async () => {
    // Twenty rounds because the failure this replaces was a COIN FLIP, not a constant: the
    // tie on `created_at` was broken by whatever the plan produced, so a single round would
    // have passed half the time before 0027 and proved nothing.
    for (let round = 0; round < 20; round += 1) {
      const target = `crm_seq_fwd_${round}`;
      await enqueuePair(target, [CREATE, WIN]);

      const claimed = await withTenantContext(admin, TENANT, (tx) =>
        claimBatch(tx, TENANT, "seq-worker", 10, new Date()),
      );
      expect(claimed.map((r) => r.operation)).toEqual([CREATE, WIN]);
      expect(claimed.every((r) => r.target_record_id === target)).toBe(true);
    }
  });

  it("keeps enqueue order when the PHYSICAL order disagrees with it", async () => {
    /**
     * The half of the fix that is easy to miss, and the only test here that discriminates
     * on the realistic create-then-transition shape.
     *
     * `UPDATE … WHERE id IN (SELECT … ORDER BY …) RETURNING` does not return rows in the
     * subquery's order — it returns them in the order the update's scan found them, which
     * for a batch this size is heap order. Usually heap order IS insertion order, which is
     * why the old tie on `created_at` looked harmless and sat in ADR-0001 as a latent
     * inefficiency rather than a reproducible bug. It stops coinciding as soon as a row has
     * been rewritten in place — a retry, a reclaimed lease, any settle — so the `last_error`
     * nudge below manufactures what a backed-off queue reaches on its own: eight creates
     * sitting physically AFTER the transitions that depend on them.
     *
     * Verified against the old query shape: it returns all eight transitions first.
     */
    const targets = Array.from({ length: 8 }, (_, i) => `crm_seq_heap_${i}`);
    await withTenantContext(admin, TENANT, async (tx) => {
      for (const target of targets) {
        for (const operation of [CREATE, WIN]) {
          await enqueueOutbox(tx, TENANT, {
            entity: "Opportunity",
            operation,
            payload: {},
            targetRecordId: target,
            sourceTable: "crm.visit",
            sourceId: crypto.randomUUID(),
          });
        }
      }
    });
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query(
        `UPDATE crm.outbox SET last_error = 'rewritten in place'
          WHERE tenant_id = $1 AND operation = $2`,
        [TENANT, CREATE],
      ),
    );

    const claimed = await withTenantContext(admin, TENANT, (tx) =>
      claimBatch(tx, TENANT, "seq-worker", 16, new Date()),
    );
    expect(claimed).toHaveLength(16);
    for (const target of targets) {
      const create = claimed.findIndex((r) => r.target_record_id === target && r.operation === CREATE);
      const win = claimed.findIndex((r) => r.target_record_id === target && r.operation === WIN);
      expect(create).toBeGreaterThanOrEqual(0);
      expect(create).toBeLessThan(win);
    }
  });

  it("honours the REVERSE order too, so the key is the sequence and not the operation name", async () => {
    // An ERP transition before its create is not a sane thing to enqueue; asserting it
    // anyway is what separates "ordered by insertion" from "creates happen to sort first".
    await enqueuePair("crm_seq_rev", [WIN, CREATE]);

    const claimed = await withTenantContext(admin, TENANT, (tx) =>
      claimBatch(tx, TENANT, "seq-worker", 10, new Date()),
    );
    expect(claimed.map((r) => r.operation)).toEqual([WIN, CREATE]);
    expect(await seqOf("crm_seq_rev", WIN)).toBeLessThan(await seqOf("crm_seq_rev", CREATE));
  });

  it("dispatches in that order, so the ERP sees the create first", async () => {
    // The claim order is only worth having if it survives into the dispatch loop. The relay
    // iterates the claimed array, and `RETURNING` row order is unspecified — this is the
    // assertion that would fail if `claimBatch` stopped sorting its result.
    await enqueuePair("crm_seq_live", [CREATE, WIN]);

    const calls: string[] = [];
    const result = await new OutboxRelay({
      pool: p,
      client: recordingErp(calls),
      workerId: "seq-relay",
    }).drainTenant(TENANT);

    expect(result).toMatchObject({ claimed: 2, delivered: 2, dead: 0 });
    expect(calls).toEqual([
      "POST /v1/opportunitys",
      "POST /v1/opportunitys/crm_seq_live/win",
    ]);
  });

  it("does not outrank next_attempt_at — a backed-off row waits however low its seq", async () => {
    // Order of the keys, unchanged by 0027: due time first, enqueue order only as the
    // tie-breaker. A row parked by the backoff curve must not jump the queue.
    await enqueuePair("crm_seq_early", [CREATE]);
    await enqueuePair("crm_seq_later", [CREATE]);
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query(
        `UPDATE crm.outbox SET next_attempt_at = now() + interval '1 second'
          WHERE tenant_id = $1 AND target_record_id = 'crm_seq_early'`,
        [TENANT],
      ),
    );

    const claimed = await withTenantContext(admin, TENANT, (tx) =>
      claimBatch(tx, TENANT, "seq-worker", 10, new Date()),
    );
    expect(claimed.map((r) => r.target_record_id)).toEqual(["crm_seq_later"]);
  });

  it("does NOT order concurrent enqueues — a lower seq is claimed after a higher one", async () => {
    /**
     * The non-guarantee, pinned rather than described. `nextval` is handed out at INSERT
     * time and is not transactional, so the row holding the LOWER value can commit second
     * and be claimed by a later drain. This is the case `classify`'s `retry_ordering`
     * exists for, which is why 0027 does not remove it — a test that proved the sequence
     * fixed everything would be the argument for deleting the backstop.
     */
    const slow = await p.connect();
    try {
      await slow.query("SET ROLE crm_app");
      let allocated!: () => void;
      let commitNow!: () => void;
      const hasAllocated = new Promise<void>((resolve) => {
        allocated = resolve;
      });
      const mayCommit = new Promise<void>((resolve) => {
        commitNow = resolve;
      });

      const slowTx = withTenantContext(slow, TENANT, async (tx) => {
        await enqueueOutbox(tx, TENANT, {
          entity: "Opportunity",
          operation: CREATE,
          payload: {},
          targetRecordId: "crm_seq_slow",
          sourceTable: "crm.visit",
          sourceId: crypto.randomUUID(),
        });
        allocated();
        await mayCommit;
      });
      await hasAllocated;

      // Enqueued second, so it holds the HIGHER sequence value — and commits first.
      await enqueuePair("crm_seq_fast", [CREATE]);

      const firstDrain = await withTenantContext(admin, TENANT, (tx) =>
        claimBatch(tx, TENANT, "seq-worker", 10, new Date()),
      );
      expect(firstDrain.map((r) => r.target_record_id)).toEqual(["crm_seq_fast"]);

      commitNow();
      await slowTx;

      const secondDrain = await withTenantContext(admin, TENANT, (tx) =>
        claimBatch(tx, TENANT, "seq-worker", 10, new Date()),
      );
      expect(secondDrain.map((r) => r.target_record_id)).toEqual(["crm_seq_slow"]);
      expect(await seqOf("crm_seq_slow", CREATE)).toBeLessThan(await seqOf("crm_seq_fast", CREATE));
    } finally {
      slow.release();
    }
  });

  it("has GAPS — a collapsed duplicate burns a value before the conflict is seen", async () => {
    // `enqueueOutbox` returning `enqueued: false` is the normal path for a double-tap or a
    // replayed offline batch, and the column default is evaluated before the unique index
    // is consulted. So nothing may read `seq` as a count, or infer a missing row from one.
    await enqueuePair("crm_seq_gap_a", [CREATE]);
    const second = await withTenantContext(admin, TENANT, (tx) =>
      enqueueOutbox(tx, TENANT, {
        entity: "Opportunity",
        operation: CREATE,
        payload: {},
        targetRecordId: "crm_seq_gap_a",
        sourceTable: "crm.visit",
        sourceId: crypto.randomUUID(),
      }),
    );
    expect(second.enqueued).toBe(false);
    await enqueuePair("crm_seq_gap_b", [CREATE]);

    const first = await seqOf("crm_seq_gap_a", CREATE);
    const third = await seqOf("crm_seq_gap_b", CREATE);
    expect(third - first).toBe(2); // two rows, three values consumed
  });

  it("cannot be enqueued without a position", async () => {
    // The default and the NOT NULL together. A migration that dropped either would leave
    // rows with no place in the order, and the claim's ORDER BY would silently go back to
    // being arbitrary for them.
    const column = await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ is_nullable: string; column_default: string | null }>(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'crm' AND table_name = 'outbox' AND column_name = 'seq'`,
      );
      return rows[0];
    });
    expect(column?.is_nullable).toBe("NO");
    expect(column?.column_default).toContain("nextval");
  });
});
