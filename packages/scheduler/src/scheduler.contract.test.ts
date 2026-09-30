import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import type { OutboxRelay } from "@crm/relay";
import type { SnapshotRefresher } from "@crm/sync";

import { Scheduler, type SchedulerEvent } from "./scheduler.js";
import { claimDueJobs, ensureJobs, jobHealth, recordResult } from "./store.js";
import { JOB_NAMES } from "./jobs.js";

// A distinct tenant pair per suite. Sharing fixture rows across suites couples
// them to vitest's beforeAll/afterAll interleaving, which is not a property
// worth depending on — and which cost an hour the first time it bit.
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LOOP_TENANT = "33333333-3333-4333-8333-333333333333";
const RESULT_TENANT = "44444444-4444-4444-8444-444444444444";

function pool(): Pool {
  return new Pool({
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 8,
  });
}

/** Stand-ins that record what they were asked to do. */
function stubRelay(behaviour: (tenantId: string) => Promise<unknown> = async () => undefined) {
  const calls: string[] = [];
  const relay = {
    drainTenant: async (tenantId: string) => {
      calls.push(tenantId);
      await behaviour(tenantId);
      return { claimed: 0, delivered: 0, retried: 0, dead: 0, lag: { pending: 0, inFlight: 0, dead: 0, oldestPendingAgeSeconds: null } };
    },
  } as unknown as OutboxRelay;
  return { relay, calls };
}

function stubRefresher(behaviour: (mode: string) => Promise<unknown> = async () => undefined) {
  const calls: Array<{ tenantId: string; mode: string }> = [];
  const refresher = {
    refreshAll: async (tenantId: string, mode: "incremental" | "full") => {
      calls.push({ tenantId, mode });
      await behaviour(mode);
      return [{ snapshot: "product", mode, read: 0, upserted: 0, deleted: 0, rejected: [], highWaterMark: null }];
    },
  } as unknown as SnapshotRefresher;
  return { refresher, calls };
}

describe("scheduler against a real database", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await admin.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1::uuid[])", [[TENANT, OTHER]]);
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  beforeEach(async () => {
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        await tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id = $1", [t]);
      });
    }
    await admin.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1::uuid[])", [[TENANT, OTHER]]);
    await admin.query(
      "INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,'Tenant A'), ($2,'Tenant B')",
      [TENANT, OTHER],
    );
  });

  function scheduler(opts: Partial<Parameters<typeof Scheduler.prototype.constructor>[0]> = {}, events: SchedulerEvent[] = []) {
    const { relay } = stubRelay();
    const { refresher } = stubRefresher();
    return new Scheduler({
      pool: p,
      relay,
      refresher,
      random: () => 0.5,
      onEvent: (e) => events.push(e),
      ...opts,
    } as ConstructorParameters<typeof Scheduler>[0]);
  }

  it("creates the job rows for a tenant on first sight", async () => {
    await scheduler().tick();
    const health = await withTenantContext(admin, TENANT, (tx) => jobHealth(tx, TENANT));
    expect(health.map((h) => h.job).sort()).toEqual([...JOB_NAMES].sort());
  });

  it("backfills a job introduced by a later release, without resetting tuned intervals", async () => {
    await scheduler().tick();
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("UPDATE crm.scheduled_job SET interval_ms = 999000 WHERE tenant_id=$1 AND job='relay_drain'", [TENANT]);
      await tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id=$1 AND job='snapshot_full'", [TENANT]);
    });
    await scheduler().tick();

    const health = await withTenantContext(admin, TENANT, (tx) => jobHealth(tx, TENANT));
    expect(health.map((h) => h.job)).toContain("snapshot_full");
    const tuned = await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ interval_ms: number }>(
        "SELECT interval_ms FROM crm.scheduled_job WHERE tenant_id=$1 AND job='relay_drain'", [TENANT]);
      return rows[0]?.interval_ms;
    });
    expect(tuned).toBe(999000); // ON CONFLICT DO NOTHING left the operator's value alone
  });

  it("runs each due job and records success", async () => {
    const { relay, calls } = stubRelay();
    const { refresher, calls: refreshCalls } = stubRefresher();
    await new Scheduler({ pool: p, relay, refresher, random: () => 0.5 }).tick();

    expect(calls).toContain(TENANT);
    expect(refreshCalls.filter((c) => c.tenantId === TENANT).map((c) => c.mode).sort()).toEqual([
      "full",
      "incremental",
    ]);

    const health = await withTenantContext(admin, TENANT, (tx) => jobHealth(tx, TENANT));
    for (const h of health) {
      expect(h.last_status).toBe("ok");
      expect(h.consecutive_failures).toBe(0);
    }
  });

  it("does not re-run a job before it is due", async () => {
    const { relay, calls } = stubRelay();
    const { refresher } = stubRefresher();
    const s = new Scheduler({ pool: p, relay, refresher, random: () => 0.5 });
    await s.tick();
    await s.tick();
    // Claim advances next_run_at, so a second pass in the same window finds
    // nothing — which is also what stops two instances duplicating work.
    // Both registered tenants are worked once each, and neither twice.
    expect(calls.filter((c) => c === TENANT)).toHaveLength(1);
    expect(calls.filter((c) => c === OTHER)).toHaveLength(1);
  });

  it("records a failure, counts it, and backs the job off", async () => {
    const { relay } = stubRelay(() => Promise.reject(new Error("ERP unreachable")));
    const { refresher } = stubRefresher();
    const events: SchedulerEvent[] = [];
    await new Scheduler({ pool: p, relay, refresher, random: () => 0.5, onEvent: (e) => events.push(e) }).tick();

    const health = await withTenantContext(admin, TENANT, (tx) => jobHealth(tx, TENANT));
    const drain = health.find((h) => h.job === "relay_drain")!;
    expect(drain.last_status).toBe("error");
    expect(drain.last_error).toContain("ERP unreachable");
    expect(drain.consecutive_failures).toBe(1);
    expect(events.some((e) => e.type === "job_error")).toBe(true);
  });

  it("resets the failure count on recovery, so a fixed tenant is not stuck in backoff", async () => {
    const failing = stubRelay(() => Promise.reject(new Error("down")));
    const { refresher } = stubRefresher();
    await new Scheduler({ pool: p, relay: failing.relay, refresher, random: () => 0.5 }).tick();

    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET next_run_at = now() WHERE tenant_id = $1", [TENANT]),
    );
    const healthy = stubRelay();
    await new Scheduler({ pool: p, relay: healthy.relay, refresher, random: () => 0.5 }).tick();

    const health = await withTenantContext(admin, TENANT, (tx) => jobHealth(tx, TENANT));
    expect(health.find((h) => h.job === "relay_drain")?.consecutive_failures).toBe(0);
  });

  it("isolates one tenant's failure from the others", async () => {
    // A tenant whose ERP credential expired must not stop everyone else's relay.
    const seen: string[] = [];
    const relay = {
      drainTenant: async (tenantId: string) => {
        seen.push(tenantId);
        if (tenantId === TENANT) throw new Error("this tenant is broken");
        return { claimed: 0, delivered: 0, retried: 0, dead: 0, lag: { pending: 0, inFlight: 0, dead: 0, oldestPendingAgeSeconds: null } };
      },
    } as unknown as OutboxRelay;
    const { refresher } = stubRefresher();
    await new Scheduler({ pool: p, relay, refresher, random: () => 0.5 }).tick();

    expect(seen).toContain(TENANT);
    expect(seen).toContain(OTHER);
    const otherHealth = await withTenantContext(admin, OTHER, (tx) => jobHealth(tx, OTHER));
    expect(otherHealth.find((h) => h.job === "relay_drain")?.last_status).toBe("ok");
  });

  it("skips a paused tenant entirely", async () => {
    await admin.query("UPDATE crm.tenant SET status = 'paused' WHERE tenant_id = $1", [TENANT]);
    const { relay, calls } = stubRelay();
    const { refresher } = stubRefresher();
    await new Scheduler({ pool: p, relay, refresher, random: () => 0.5 }).tick();
    expect(calls).toEqual([OTHER]);
  });

  it("skips a disabled JOB while still running the tenant's others", async () => {
    await scheduler().tick();
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET enabled = false, next_run_at = now() WHERE tenant_id=$1 AND job='relay_drain'", [TENANT]),
    );
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET next_run_at = now() WHERE tenant_id=$1 AND job<>'relay_drain'", [TENANT]),
    );
    const { relay, calls } = stubRelay();
    const { refresher, calls: rc } = stubRefresher();
    await new Scheduler({ pool: p, relay, refresher, random: () => 0.5 }).tick();

    expect(calls).not.toContain(TENANT);
    expect(rc.some((c) => c.tenantId === TENANT)).toBe(true);
  });

  it("gives two concurrent instances DISJOINT work", async () => {
    // The whole multi-instance story: claim advances next_run_at atomically, so
    // no lock, lease or heartbeat is needed.
    await scheduler().tick();
    await withTenantContext(admin, TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET next_run_at = now() WHERE tenant_id = $1", [TENANT]),
    );

    const [a, b] = await Promise.all([p.connect(), p.connect()]);
    try {
      await a.query("SET ROLE crm_app");
      await b.query("SET ROLE crm_app");
      const now = new Date();
      const [first, second] = await Promise.all([
        withTenantContext(a, TENANT, (tx) => claimDueJobs(tx, TENANT, now, () => 0.5)),
        withTenantContext(b, TENANT, (tx) => claimDueJobs(tx, TENANT, now, () => 0.5)),
      ]);
      const jobs = [...first, ...second].map((j) => j.job);
      expect(jobs).toHaveLength(3);
      expect(new Set(jobs).size).toBe(3); // no job claimed twice
    } finally {
      a.release();
      b.release();
    }
  });

  it("cannot see another tenant's jobs even when asked directly", async () => {
    await scheduler().tick();
    const leaked = await withTenantContext(admin, OTHER, async (tx) => {
      const { rows } = await tx.query("SELECT 1 FROM crm.scheduled_job WHERE tenant_id = $1", [TENANT]);
      return rows.length;
    });
    expect(leaked).toBe(0);
  });
});

describe("the loop itself", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
    await admin.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [LOOP_TENANT]);
    await admin.query("INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,'A')", [LOOP_TENANT]);
  });

  afterAll(async () => {
    await withTenantContext(admin, LOOP_TENANT, (tx) =>
      tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id = $1", [LOOP_TENANT]),
    );
    await admin.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [LOOP_TENANT]);
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  it("does not stack ticks when the work outruns the interval", async () => {
    // setInterval would pile the next tick onto the running one until the
    // process died. Run-then-wait self-throttles instead.
    let concurrent = 0;
    let maxConcurrent = 0;
    const relay = {
      drainTenant: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 25));
        concurrent -= 1;
        return { claimed: 0, delivered: 0, retried: 0, dead: 0, lag: { pending: 0, inFlight: 0, dead: 0, oldestPendingAgeSeconds: null } };
      },
    } as unknown as OutboxRelay;
    const { refresher } = stubRefresher();

    const s = new Scheduler({
      pool: p,
      relay,
      refresher,
      tickIntervalMs: 1, // far shorter than the work
      random: () => 0.5,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    await s.stop();

    expect(maxConcurrent).toBe(1);
  });

  it("stop() waits for the tick in flight rather than killing it mid-dispatch", async () => {
    let finished = false;
    const relay = {
      drainTenant: async () => {
        await new Promise((r) => setTimeout(r, 60));
        finished = true;
        return { claimed: 0, delivered: 0, retried: 0, dead: 0, lag: { pending: 0, inFlight: 0, dead: 0, oldestPendingAgeSeconds: null } };
      },
    } as unknown as OutboxRelay;
    const { refresher } = stubRefresher();

    await withTenantContext(admin, LOOP_TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET next_run_at = now() WHERE tenant_id = $1", [LOOP_TENANT]),
    );

    const s = new Scheduler({ pool: p, relay, refresher, tickIntervalMs: 5, random: () => 0.5 });
    s.start();
    await new Promise((r) => setTimeout(r, 15)); // let the tick begin
    await s.stop();
    // A deploy must not kill a half-drained outbox.
    expect(finished).toBe(true);
  });

  it("survives a tick that throws and keeps going", async () => {
    const events: SchedulerEvent[] = [];
    let calls = 0;
    const relay = {
      drainTenant: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { claimed: 0, delivered: 0, retried: 0, dead: 0, lag: { pending: 0, inFlight: 0, dead: 0, oldestPendingAgeSeconds: null } };
      },
    } as unknown as OutboxRelay;
    const { refresher } = stubRefresher();

    await withTenantContext(admin, LOOP_TENANT, (tx) =>
      tx.query("UPDATE crm.scheduled_job SET next_run_at = now(), interval_ms = 1000 WHERE tenant_id = $1", [LOOP_TENANT]),
    );

    const s = new Scheduler({ pool: p, relay, refresher, tickIntervalMs: 5, random: () => 0.5, onEvent: (e) => events.push(e) });
    s.start();
    await new Promise((r) => setTimeout(r, 80));
    await s.stop();

    // Dying in the loop would silently stop every tenant, so it must not.
    expect(events.filter((e) => e.type === "tick_start").length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
  });

  it("stop() is safe when the scheduler was never started", async () => {
    await expect(new Scheduler({ pool: p, relay: stubRelay().relay, refresher: stubRefresher().refresher }).stop())
      .resolves.toBeUndefined();
  });

  it("start() twice does not spawn a second loop", async () => {
    const events: SchedulerEvent[] = [];
    const s = new Scheduler({
      pool: p, relay: stubRelay().relay, refresher: stubRefresher().refresher,
      tickIntervalMs: 10_000, random: () => 0.5, onEvent: (e) => events.push(e),
    });
    s.start();
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    await s.stop();
    expect(events.filter((e) => e.type === "stopped")).toHaveLength(1);
  });
});

describe("recordResult", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await withTenantContext(admin, RESULT_TENANT, (tx) =>
      tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id = $1", [RESULT_TENANT]),
    );
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  it("is a no-op for a job row that no longer exists", async () => {
    // A job removed between claim and settle — a release that drops one, say —
    // must not throw and abort the rest of the tick.
    await withTenantContext(admin, RESULT_TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.scheduled_job WHERE tenant_id = $1", [RESULT_TENANT]);
      await expect(
        recordResult(tx, RESULT_TENANT, "relay_drain", { ok: true, durationMs: 1 }, new Date()),
      ).resolves.toBeUndefined();
    });
  });

  it("stores the duration, for spotting a job that is slowing down", async () => {
    await withTenantContext(admin, RESULT_TENANT, async (tx) => {
      await ensureJobs(tx, RESULT_TENANT, new Date());
      await recordResult(tx, RESULT_TENANT, "relay_drain", { ok: true, durationMs: 1234.7 }, new Date());
      const { rows } = await tx.query<{ last_duration_ms: number }>(
        "SELECT last_duration_ms FROM crm.scheduled_job WHERE tenant_id=$1 AND job='relay_drain'", [RESULT_TENANT]);
      expect(rows[0]?.last_duration_ms).toBe(1235);
    });
  });
});
