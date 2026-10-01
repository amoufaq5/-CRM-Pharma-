import { withTenantContext } from "@crm/db";
import type { OutboxRelay } from "@crm/relay";
import type { NotificationDispatcher } from "@crm/notify";
import { sweepExpiredStock } from "@crm/sample";
import type { SnapshotRefresher } from "@crm/sync";
import type { Pool, PoolClient } from "pg";

import type { JobName } from "./jobs.js";
import { activeTenants, claimDueJobs, ensureJobs, recordResult } from "./store.js";

export interface SchedulerOptions {
  readonly pool: Pool;
  readonly relay: OutboxRelay;
  readonly refresher: SnapshotRefresher;
  /**
   * Optional: without it the `notify_dispatch` job reports that it is unconfigured rather
   * than failing. In-app notifications still land — they are rows, written by whatever
   * raised them — so a deployment with no webhook endpoints needs no dispatcher.
   */
  readonly notifications?: NotificationDispatcher;
  /** How often to look for due work. Not the job cadence — that is per job. */
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onEvent?: (event: SchedulerEvent) => void;
  /** Injected so tests drive time instead of waiting for it. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type SchedulerEvent =
  | { readonly type: "tick_start"; readonly tenants: number }
  | { readonly type: "job_start"; readonly tenantId: string; readonly job: JobName }
  | {
      readonly type: "job_ok";
      readonly tenantId: string;
      readonly job: JobName;
      readonly durationMs: number;
      readonly detail: string;
    }
  | {
      readonly type: "job_error";
      readonly tenantId: string;
      readonly job: JobName;
      readonly durationMs: number;
      readonly error: string;
    }
  | { readonly type: "tick_error"; readonly error: string }
  | { readonly type: "stopped" };

const DEFAULT_TICK_MS = 10_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Resolve immediately on shutdown rather than making the operator wait out
    // a full tick interval before the process exits.
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Drives the relay and the snapshot refresher on a timer.
 *
 * The shape, and the reasons:
 *
 * - **Run-then-wait, never `setInterval`.** A tick that outruns its interval
 *   must not have the next one start on top of it. `setInterval` would stack
 *   them until the process died; this waits the interval AFTER the work
 *   finishes, so a slow tick self-throttles.
 * - **One tenant's failure is isolated.** A tenant whose ERP credential has
 *   expired must not stop every other tenant's relay. Each tenant, and each job
 *   within it, is caught separately.
 * - **Every query runs inside `withTenantContext`** except reading the tenant
 *   registry, which holds no tenant data. The scheduler never sees across
 *   tenants.
 * - **Graceful stop.** `stop()` waits for the tick in flight, so a deploy does
 *   not kill a half-drained outbox mid-dispatch.
 */
export class Scheduler {
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Starts the loop. Returns immediately; use `stop()` to drain and finish. */
  start(): void {
    if (this.running !== null) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = (async () => {
      while (!signal.aborted) {
        try {
          await this.tick();
        } catch (err) {
          // The loop itself must survive anything — a dropped connection, a
          // registry read failing. Dying here would silently stop every tenant.
          this.options.onEvent?.({ type: "tick_error", error: String(err).slice(0, 500) });
        }
        if (signal.aborted) break;
        await this.sleep(this.tickIntervalMs, signal);
      }
      this.options.onEvent?.({ type: "stopped" });
    })();
  }

  /** Signals shutdown and waits for the in-flight tick to finish. */
  async stop(): Promise<void> {
    this.controller?.abort();
    const running = this.running;
    this.running = null;
    this.controller = null;
    await running;
  }

  /** One pass over every active tenant. Exposed so tests drive it directly. */
  async tick(): Promise<void> {
    const client = await this.options.pool.connect();
    let tenants: readonly { tenant_id: string }[] = [];
    try {
      tenants = await activeTenants(client);
    } finally {
      client.release();
    }

    this.options.onEvent?.({ type: "tick_start", tenants: tenants.length });

    for (const tenant of tenants) {
      try {
        await this.tickTenant(tenant.tenant_id);
      } catch (err) {
        // Isolated on purpose: one tenant's problem is not everyone's.
        this.options.onEvent?.({ type: "tick_error", error: `${tenant.tenant_id}: ${String(err).slice(0, 300)}` });
      }
    }
  }

  private async tickTenant(tenantId: string): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      const now = this.now();
      await withTenantContext(client, tenantId, (tx) => ensureJobs(tx, tenantId, now));
      const due = await withTenantContext(client, tenantId, (tx) =>
        claimDueJobs(tx, tenantId, now, this.random),
      );

      for (const job of due) {
        await this.runJob(client, tenantId, job.job);
      }
    } finally {
      client.release();
    }
  }

  private async runJob(client: PoolClient, tenantId: string, job: JobName): Promise<void> {
    this.options.onEvent?.({ type: "job_start", tenantId, job });
    const started = Date.now();
    try {
      const detail = await this.execute(tenantId, job);
      const durationMs = Date.now() - started;
      await withTenantContext(client, tenantId, (tx) =>
        recordResult(tx, tenantId, job, { ok: true, durationMs }, this.now(), this.random),
      );
      this.options.onEvent?.({ type: "job_ok", tenantId, job, durationMs, detail });
    } catch (err) {
      const durationMs = Date.now() - started;
      const error = String(err).slice(0, 2000);
      await withTenantContext(client, tenantId, (tx) =>
        recordResult(tx, tenantId, job, { ok: false, durationMs, error }, this.now(), this.random),
      ).catch(() => undefined);
      this.options.onEvent?.({ type: "job_error", tenantId, job, durationMs, error });
    }
  }

  /** Dispatches to the thing that actually does the work. Returns a one-line summary. */
  private async execute(tenantId: string, job: JobName): Promise<string> {
    switch (job) {
      case "relay_drain": {
        const r = await this.options.relay.drainTenant(tenantId);
        return (
          `claimed=${r.claimed} delivered=${r.delivered} retried=${r.retried} dead=${r.dead} ` +
          `pending=${r.lag.pending} oldest=${r.lag.oldestPendingAgeSeconds ?? "-"}s`
        );
      }
      case "expiry_sweep": {
        // The only job that works purely inside the CRM's own tables — no ERP call — so
        // it runs in one transaction and either the whole night's sweep lands or none of
        // it does. That is the right granularity for something that runs again tomorrow.
        const client = await this.options.pool.connect();
        try {
          const r = await withTenantContext(client, tenantId, (tx) =>
            sweepExpiredStock(tx, tenantId, { asOf: this.now() }),
          );
          return (
            `expired=${r.expiredHoldings} opened=${r.opened} resolved=${r.resolved} ` +
            `overdue=${r.markedOverdue} autoWrittenOff=${r.autoWrittenOff} ` +
            `unattributed=${r.unattributed} graceDays=${r.policy.grace_days}`
          );
        } finally {
          client.release();
        }
      }
      case "notify_dispatch": {
        const dispatcher = this.options.notifications;
        if (dispatcher === undefined) return "no dispatcher configured; in-app notifications unaffected";
        const r = await dispatcher.drainTenant(tenantId);
        return (
          `claimed=${r.claimed} delivered=${r.delivered} retried=${r.retried} ` +
          `dead=${r.dead} pending=${r.pending}`
        );
      }
      case "snapshot_incremental":
      case "snapshot_full": {
        const mode = job === "snapshot_full" ? "full" : "incremental";
        const results = await this.options.refresher.refreshAll(tenantId, mode);
        const failed = results.filter((r): r is { snapshot: never; error: string } => "error" in r);
        if (failed.length > 0) {
          // Surfaced as a job failure so the backoff and the failure counter
          // engage; refreshAll already made sure the other snapshots still ran.
          throw new Error(`${failed.length} snapshot(s) failed: ${failed.map((f) => f.error).join("; ")}`);
        }
        const ok = results.filter((r): r is Exclude<typeof r, { error: string }> => !("error" in r));
        const upserted = ok.reduce((n, r) => n + r.upserted, 0);
        const deleted = ok.reduce((n, r) => n + r.deleted, 0);
        const rejected = ok.reduce((n, r) => n + r.rejected.length, 0);
        return `mode=${mode} upserted=${upserted} deleted=${deleted} rejected=${rejected}`;
      }
    }
  }
}
