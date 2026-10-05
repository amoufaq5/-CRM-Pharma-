import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import type { OutboxRelay } from "@crm/relay";
import type { SnapshotRefresher } from "@crm/sync";

import { Scheduler, type SchedulerEvent } from "./scheduler.js";
import { claimDueJobs, ensureJobs, jobHealth, recordResult } from "./store.js";
import { JOB_NAMES } from "./jobs.js";

// A distinct tenant per suite, from the shared registry in @crm/db/testing.
// Sharing fixture rows couples suites to vitest's hook interleaving and to each
// other's cleanup, neither of which is worth depending on.
import {
  TENANT_SCHEDULER_A as TENANT,
  TENANT_SCHEDULER_B as OTHER,
  TENANT_SCHEDULER_LOOP as LOOP_TENANT,
  TENANT_SCHEDULER_RESULT as RESULT_TENANT,
  appPool,
} from "@crm/db/testing";

/**
 * `appPool()`, not `testPool()`: this pool is handed to code that opens its OWN
 * connections, and those inherit the pool's role. The admin pool would run every one of
 * them as a superuser, which bypasses row-level security even under `FORCE` — so a
 * missing tenant predicate would be invisible to this whole suite. One was.
 * See the comment on `appPool` in `@crm/db/testing`.
 */

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
    p = appPool();
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

  // `ConstructorParameters<typeof Scheduler>`, not `Parameters<typeof
  // Scheduler.prototype.constructor>`: the latter is typed `Function`, fails the
  // constraint, and degrades the whole options type to `never` — invisible while test
  // files sat outside `tsc`.
  function scheduler(
    opts: Partial<ConstructorParameters<typeof Scheduler>[0]> = {},
    events: SchedulerEvent[] = [],
  ) {
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

  /**
   * The expiry sweep is the only job that calls nothing outside the CRM's own tables, so
   * the test exercises the real thing rather than a stub — and asserts the summary line,
   * because for this job the log IS the notification: there is no channel that tells a
   * rep an obligation was raised.
   */
  it("runs the expiry sweep and reports what it found", async () => {
    const { relay } = stubRelay();
    const { refresher } = stubRefresher();
    const events: SchedulerEvent[] = [];

    let lotId = "";
    let repId = "";
    await withTenantContext(admin, TENANT, async (tx) => {
      // Tolerate residue from an earlier failed run: the fixture owns this subject, and a
      // half-cleaned database should not make the next run fail for the wrong reason.
      //
      // The list has to match the teardown at the end of this test, in the same FK order.
      // It did not: it cleared notifications and the profile but not the holdings and
      // ledger rows that reference the profile, so a run aborted midway left the NEXT run
      // failing on `sample_holding_rep_profile_id_fkey` — a confusing way to be told
      // "the previous run died".
      await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.sample_transaction ENABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      await tx.query(
        `DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND subject = 'sched-sweep'`,
        [TENANT],
      );
      const r = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1,'sched-sweep','SS-1','Sweep Rep') RETURNING id`,
        [TENANT],
      );
      repId = r.rows[0]!.id;
      const l = await tx.query<{ id: string }>(
        `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
         VALUES ($1,'item-sweep','LOT-SCHED','2026-03-31','drug_sample') RETURNING id`,
        [TENANT],
      );
      lotId = l.rows[0]!.id;
      // Received well inside its shelf life; it goes stale in the bag.
      await tx.query(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'receipt',12,'wh1','2026-01-10T08:00:00Z')`,
        [TENANT, lotId, repId],
      );
    });

    await new Scheduler({
      pool: p,
      relay,
      refresher,
      random: () => 0.5,
      now: () => new Date("2026-04-10T02:00:00Z"),
      onEvent: (e) => events.push(e),
    }).tick();

    const ok = events.find((e) => e.type === "job_ok" && e.job === "expiry_sweep");
    expect(ok).toBeDefined();
    expect((ok as { detail: string }).detail).toContain("expired=1");
    expect((ok as { detail: string }).detail).toContain("opened=1");
    expect((ok as { detail: string }).detail).toContain("autoWrittenOff=0");
    expect((ok as { detail: string }).detail).toContain("graceDays=30");

    await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ status: string; due_by: string }>(
        "SELECT status, due_by::text AS due_by FROM crm.disposal_obligation WHERE tenant_id = $1",
        [TENANT],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("open");
      expect(rows[0]!.due_by).toBe("2026-05-10");

      // The drug sample is still on the balance. The job noticed; it did not pretend the
      // stock had gone.
      const held = await tx.query<{ q: string }>(
        "SELECT quantity_on_hand::text AS q FROM crm.sample_holding WHERE lot_id = $1",
        [lotId],
      );
      expect(held.rows[0]!.q).toBe("12.000");

      // The sweep now tells the rep, and a notification references rep_profile with
      // ON DELETE RESTRICT — so it goes before the profile does.
      await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.sample_transaction ENABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE id = $1", [repId]);
    });
  });

  /**
   * The prune, like the sweep, touches nothing outside the CRM — so the real thing runs
   * rather than a stub, and the summary line is asserted because for this job the log is
   * where `unknownSubjects` becomes visible at all. A producer that forgets a branch in
   * `crm.notification_subject_open` is reported here and nowhere else.
   */
  it("runs the notification prune and reports what it took and held back", async () => {
    const { relay } = stubRelay();
    const { refresher } = stubRefresher();
    const events: SchedulerEvent[] = [];
    const NOW = new Date("2026-06-01T02:00:00Z");
    const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

    let repId = "";
    await withTenantContext(admin, TENANT, async (tx) => {
      // Same residue tolerance as the sweep above, in FK order.
      await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      await tx.query(`DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND subject = 'sched-prune'`, [TENANT]);

      const r = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1,'sched-prune','SP-1','Prune Rep') RETURNING id`,
        [TENANT],
      );
      repId = r.rows[0]!.id;

      // An ERP write that is still dead: the notification about it must survive, however
      // old, because it is the only thing telling the rep their write never landed.
      const dead = await tx.query<{ id: string }>(
        `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                 source_table, source_id, state)
         VALUES ($1,'Item','create','{}'::jsonb,'crm_prune_1','crm.visit',gen_random_uuid(),'dead')
         RETURNING id`,
        [TENANT],
      );

      const add = (kind: string, dedup: string, days: number, table: string | null, id: string | null) =>
        tx.query(
          `INSERT INTO crm.notification
             (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key,
              subject_table, subject_id, created_at, read_at)
           VALUES ($1,$2,$3,'info','s','b',$4,$5,$6,$7,$7)`,
          [TENANT, repId, kind, dedup, table, id, daysAgo(days)],
        );
      await add("call_plan_approved", "pr-old", 400, null, null);
      await add("erp_write_failed", "pr-dead", 400, "crm.outbox", dead.rows[0]!.id);
      await add("call_plan_approved", "pr-unknown", 400, "crm.not_a_table", repId);
      await add("call_plan_approved", "pr-recent", 2, null, null);
    });

    await new Scheduler({
      pool: p,
      relay,
      refresher,
      random: () => 0.5,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    }).tick();

    const ok = events.find((e) => e.type === "job_ok" && e.job === "notify_prune");
    expect(ok).toBeDefined();
    const detail = (ok as { detail: string }).detail;
    // Two taken (the plain old one and the unrecognised-subject one), one held back
    // because its ERP write is still dead, one not yet past any horizon.
    expect(detail).toContain("deletedRead=2");
    expect(detail).toContain("keptSubjectOpen=1");
    expect(detail).toContain("unknownSubjects=1");
    expect(detail).toContain("retainRead=30d");

    await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ dedup_key: string }>(
        "SELECT dedup_key FROM crm.notification WHERE tenant_id = $1 ORDER BY dedup_key",
        [TENANT],
      );
      expect(rows.map((r) => r.dedup_key)).toEqual(["pr-dead", "pr-recent"]);

      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE id = $1", [repId]);
    });
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
      expect(jobs).toHaveLength(JOB_NAMES.length);
      expect(new Set(jobs).size).toBe(JOB_NAMES.length); // no job claimed twice
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
    p = appPool();
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
    p = appPool();
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
