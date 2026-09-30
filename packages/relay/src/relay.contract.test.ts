import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { ErpClient, ErpError, type FetchLike, type TenantCredential } from "@crm/acl";
import { ERP_SCHEMA_FIXTURE } from "@crm/acl/fixtures";
import { withTenantContext } from "@crm/db";

import { OutboxRelay, type RelayEvent } from "./relay.js";
import { claimBatch, outboxLag, reclaimStale } from "./store.js";

import { TENANT_RELAY as TENANT } from "@crm/db/testing";

function pool(): Pool {
  return new Pool({
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 6,
  });
}

/** An ERP whose every non-schema response is scripted by the test. */
function fakeErp(handler: (url: string, method: string) => { status: number; body: unknown }): ErpClient {
  const fetchImpl: FetchLike = (url, init) => {
    const body = url.endsWith("/v1/meta/schema")
      ? { status: 200, body: ERP_SCHEMA_FIXTURE }
      : handler(url, init.method);
    return Promise.resolve({
      status: body.status,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body.body)),
    });
  };
  const credential: TenantCredential = { token: () => Promise.resolve("t") };
  return new ErpClient({ baseUrl: "https://erp.example", credential, fetch: fetchImpl });
}

describe("outbox relay against a real database", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  beforeEach(async () => {
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
    });
  });

  async function enqueue(over: Record<string, unknown> = {}): Promise<string> {
    return withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.outbox
           (tenant_id, entity, operation, payload, target_record_id, source_table, source_id, next_attempt_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'crm.expense_claim', gen_random_uuid(), now())
         RETURNING id`,
        [
          TENANT,
          (over["entity"] as string) ?? "Item",
          (over["operation"] as string) ?? "create",
          JSON.stringify(over["payload"] ?? { sku: "A", name: "Widget" }),
          (over["target_record_id"] as string) ?? `crm_${Math.random().toString(36).slice(2, 10)}`,
        ],
      );
      return rows[0]!.id;
    });
  }

  async function stateOf(id: string): Promise<{ state: string; attempts: number; last_error: string | null; dead_reason: string | null }> {
    return withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query(
        "SELECT state, attempts, last_error, dead_reason FROM crm.outbox WHERE id = $1",
        [id],
      );
      return rows[0];
    });
  }

  function relay(
    handler: (url: string, method: string) => { status: number; body: unknown },
    events: RelayEvent[] = [],
  ): OutboxRelay {
    return new OutboxRelay({
      pool: p,
      client: fakeErp(handler),
      workerId: "test-worker",
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
  }

  it("delivers a pending row and records the ERP response", async () => {
    const id = await enqueue();
    const result = await relay(() => ({ status: 201, body: { id: "crm_x", sku: "A" } })).drainTenant(TENANT);

    expect(result).toMatchObject({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect((await stateOf(id)).state).toBe("delivered");
  });

  it("sends the client-minted id as the record id, so a replay collapses", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = (url, init) => {
      if (!url.endsWith("/v1/meta/schema") && init.body !== undefined) sent = JSON.parse(init.body);
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(url.endsWith("/v1/meta/schema") ? ERP_SCHEMA_FIXTURE : { id: "x" })),
      });
    };
    const client = new ErpClient({
      baseUrl: "https://erp.example",
      credential: { token: () => Promise.resolve("t") },
      fetch: fetchImpl,
    });
    await enqueue({ target_record_id: "crm_deterministic" });
    await new OutboxRelay({ pool: p, client, workerId: "w" }).drainTenant(TENANT);
    expect(sent["id"]).toBe("crm_deterministic");
  });

  it("treats a 409 replay as delivered rather than retrying it forever", async () => {
    const id = await enqueue();
    const result = await relay(() => ({
      status: 409,
      body: { type: "https://crossengin.io/errors/idempotency-mismatch", title: "Conflict", status: 409 },
    })).drainTenant(TENANT);

    expect(result.delivered).toBe(1);
    expect((await stateOf(id)).state).toBe("delivered");
  });

  it("retries a locked fiscal period instead of dead-lettering legitimate spend", async () => {
    const id = await enqueue({ entity: "Item", operation: "update" });
    const events: RelayEvent[] = [];
    const result = await relay(
      () => ({ status: 422, body: { error: "period_locked", detail: "cannot post into fiscal period in 'closed' state" } }),
      events,
    ).drainTenant(TENANT);

    expect(result).toMatchObject({ retried: 1, dead: 0 });
    const after = await stateOf(id);
    expect(after.state).toBe("pending");
    expect(after.last_error).toContain("fiscal period");

    // And it waits on the PERIOD curve — a quarter-hour floor, not seconds.
    const retry = events.find((e) => e.type === "retry");
    expect(retry?.type === "retry" && retry.delayMs).toBeGreaterThan(5 * 60_000);
  });

  it("dead-letters an unbalanced journal entry — same 422, opposite handling", async () => {
    const id = await enqueue({ operation: "update" });
    const result = await relay(() => ({
      status: 422,
      body: { error: "unbalanced_journal_entry", detail: "debits (10.00) must equal credits (9.00)" },
    })).drainTenant(TENANT);

    expect(result.dead).toBe(1);
    const after = await stateOf(id);
    expect(after.state).toBe("dead");
    expect(after.dead_reason).toContain("unbalanced_journal_entry");
  });

  it("dead-letters a 403 — a missing `controller` role wants a human, not a backoff", async () => {
    const id = await enqueue({ operation: "update" });
    await relay(() => ({ status: 403, body: { error: "forbidden", detail: "role may not post" } })).drainTenant(TENANT);
    expect((await stateOf(id)).state).toBe("dead");
  });

  it("dead-letters a malformed operation without burning ten attempts first", async () => {
    const id = await enqueue({ operation: "obliterate" });
    await relay(() => ({ status: 200, body: {} })).drainTenant(TENANT);
    const after = await stateOf(id);
    expect(after.state).toBe("dead");
    expect(after.dead_reason).toContain("unknown outbox operation");
    expect(after.attempts).toBe(1);
  });

  it("increments attempts at CLAIM time, so a poison row cannot retry forever", async () => {
    const id = await enqueue();
    await relay(() => ({ status: 503, body: { error: "unavailable" } })).drainTenant(TENANT);
    expect((await stateOf(id)).attempts).toBe(1);
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("UPDATE crm.outbox SET next_attempt_at = now() WHERE id = $1", [id]);
    });
    await relay(() => ({ status: 503, body: { error: "unavailable" } })).drainTenant(TENANT);
    expect((await stateOf(id)).attempts).toBe(2);
  });

  it("dead-letters once the attempt cap is reached, naming the count", async () => {
    const id = await enqueue();
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("UPDATE crm.outbox SET attempts = 9 WHERE id = $1", [id]); // becomes 10 on claim
    });
    await relay(() => ({ status: 503, body: { error: "unavailable" } })).drainTenant(TENANT);
    const after = await stateOf(id);
    expect(after.state).toBe("dead");
    expect(after.dead_reason).toMatch(/giving up after 10 attempts/);
  });

  it("does not claim a row whose next_attempt_at is still in the future", async () => {
    const id = await enqueue();
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("UPDATE crm.outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [id]);
    });
    const result = await relay(() => ({ status: 200, body: {} })).drainTenant(TENANT);
    expect(result.claimed).toBe(0);
    expect((await stateOf(id)).state).toBe("pending");
  });

  it("settles each row independently — one poison row does not block its batch-mates", async () => {
    const good = await enqueue({ target_record_id: "crm_good" });
    const bad = await enqueue({ target_record_id: "crm_bad", operation: "obliterate" });
    const result = await relay(() => ({ status: 201, body: { id: "x" } })).drainTenant(TENANT);

    expect(result).toMatchObject({ claimed: 2, delivered: 1, dead: 1 });
    expect((await stateOf(good)).state).toBe("delivered");
    expect((await stateOf(bad)).state).toBe("dead");
  });
});

describe("concurrent workers and leases", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      for (let i = 0; i < 6; i += 1) {
        await tx.query(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id, source_table, source_id)
           VALUES ($1,'Item','create','{}'::jsonb,$2,'t',gen_random_uuid())`,
          [TENANT, `crm_c${i}`],
        );
      }
    });
  });

  afterAll(async () => {
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
    });
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  it("gives two concurrent workers DISJOINT rows (FOR UPDATE SKIP LOCKED)", async () => {
    // Without SKIP LOCKED the second worker blocks on the first's head-of-queue
    // row and throughput collapses to a single worker's.
    const [a, b] = await Promise.all([p.connect(), p.connect()]);
    try {
      await a.query("SET ROLE crm_app");
      await b.query("SET ROLE crm_app");
      const [first, second] = await Promise.all([
        withTenantContext(a, TENANT, (tx) => claimBatch(tx, TENANT, "worker-a", 3, new Date())),
        withTenantContext(b, TENANT, (tx) => claimBatch(tx, TENANT, "worker-b", 3, new Date())),
      ]);
      const ids = [...first, ...second].map((r) => r.id);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6); // no row claimed twice
    } finally {
      a.release();
      b.release();
    }
  });

  it("reclaims a lease abandoned by a dead worker", async () => {
    // Otherwise the rows sit in `in_flight` forever: no other worker looks at
    // them and nothing times them out. Permanently invisible, and the claim
    // looked like it worked.
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query(
        "UPDATE crm.outbox SET state='in_flight', claimed_at = now() - interval '10 minutes' WHERE tenant_id = $1",
        [TENANT],
      );
    });
    const reclaimed = await withTenantContext(admin, TENANT, (tx) =>
      reclaimStale(tx, TENANT, 60_000, new Date()),
    );
    expect(reclaimed).toBe(6);

    const lag = await withTenantContext(admin, TENANT, (tx) => outboxLag(tx, TENANT, new Date()));
    expect(lag.pending).toBe(6);
    expect(lag.inFlight).toBe(0);
  });

  it("leaves a FRESH lease alone", async () => {
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("UPDATE crm.outbox SET state='in_flight', claimed_at = now() WHERE tenant_id = $1", [TENANT]);
    });
    const reclaimed = await withTenantContext(admin, TENANT, (tx) =>
      reclaimStale(tx, TENANT, 60_000, new Date()),
    );
    expect(reclaimed).toBe(0);
  });

  it("reports lag, with the oldest undelivered age as the page-worthy signal", async () => {
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query(
        "UPDATE crm.outbox SET state='pending', created_at = now() - interval '2 hours' WHERE tenant_id = $1",
        [TENANT],
      );
    });
    const lag = await withTenantContext(admin, TENANT, (tx) => outboxLag(tx, TENANT, new Date()));
    // Depth is ambiguous — a big snapshot sync looks like a stuck queue. Age is not.
    expect(lag.oldestPendingAgeSeconds).toBeGreaterThan(7000);
  });
});

describe("tenant isolation of the relay itself", () => {
  let p: Pool;
  let admin: PoolClient;
  const OTHER = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [t]);
        await tx.query(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id, source_table, source_id)
           VALUES ($1,'Item','create','{}'::jsonb,$2,'t',gen_random_uuid())`,
          [t, `crm_${t.slice(0, 4)}`],
        );
      });
    }
  });

  afterAll(async () => {
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [t]);
      });
    }
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  it("a drain for one tenant cannot claim another tenant's rows", async () => {
    // The relay runs inside withTenantContext, so RLS confines it. Draining the
    // table globally would mean bypassing RLS, which this architecture refuses.
    const relay = new OutboxRelay({
      pool: p,
      client: fakeErp(() => ({ status: 201, body: { id: "x" } })),
      workerId: "w",
    });
    const result = await relay.drainTenant(TENANT);
    expect(result.claimed).toBe(1);

    const otherLag = await withTenantContext(admin, OTHER, (tx) => outboxLag(tx, OTHER, new Date()));
    expect(otherLag.pending).toBe(1); // untouched
  });
});
