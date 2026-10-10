import { withTenantContext } from "@crm/db";
import type { OutboxRelay } from "@crm/relay";
import {
  notifyPendingApprovals,
  pruneNotifications,
  type EndpointProbeRunner,
  type NotificationDispatcher,
} from "@crm/notify";
import { sweepExpiredStock } from "@crm/sample";
import { summariseExpensePostSweep, sweepApprovedExpenseClaims } from "@crm/expense";
import {
  summariseTenantDeletionWatch,
  watchTenantDeletion,
  type SnapshotRefresher,
} from "@crm/sync";
import type { TombstoneReader } from "@crm/acl";
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
  /**
   * Optional: answers endpoint probes an administrator has requested (0034).
   *
   * Deliberately NOT its own `scheduled_job` kind. `notify_dispatch` already ticks every
   * 30s per tenant, which is the latency an administrator waiting on a test-send needs,
   * and a second job would add a row to `crm.scheduled_job` and a value to its CHECK for
   * work that is answered by a function call. The probe has to run HERE and not in the
   * API because the secret an endpoint names lives in this process's environment — a
   * check in the API would answer confidently about the wrong one.
   */
  readonly endpointProbes?: EndpointProbeRunner;
  /**
   * Optional: asks, per tenant, whether every channel its endpoints name has a sender in
   * THIS process.
   *
   * The same question the binary answers once at boot, asked again on each `notify_dispatch`
   * tick — because an `email` endpoint created a minute after a webhook-only scheduler
   * started was not noticed until the next restart. Its deliveries retry with a readable
   * reason (a missing sender is a fact about the binary, not the destination) and nobody is
   * told, which is the gap.
   *
   * The reason this is a verdict and not a log line is the objection the ADR raised against
   * doing it at all: a check per tick is a line every thirty seconds, and a line that is
   * always there is a line nobody reads. So the Scheduler remembers the last verdict per
   * tenant and reports only a CHANGE — a deployment that boots covered and stays covered
   * says nothing more, and the moment a channel becomes unsendable it says so once.
   *
   * Injected as a function rather than taken as the notify module's checker, so the
   * Scheduler depends on the answer and not on how it is obtained; that is also what lets a
   * test drive the transition rather than build endpoints.
   */
  readonly channelCoverage?: (tenantId: string) => Promise<ChannelCoverageAnswer>;
  /**
   * Optional: reads the ERP's tenant-deletion receipts, so `tenant_deletion_watch` can ask.
   *
   * Optional for the reason `notifications` is, and the reason matters more here. The route
   * it reads exists only when the ERP runs `--tenant-deletion-routes`, and is readable only
   * by a role an operator put in `--tenant-tombstone-read-role` — neither of which this
   * process can arrange. A deployment missing either would otherwise have a job that fails
   * on every tick forever, which is how a real signal becomes a line nobody reads. So
   * without it the job reports itself unconfigured, and with it a 403 or a 404 is recorded
   * as `unknown` WITH its reason rather than thrown: `packages/acl`'s classifier never
   * infers a deletion, and never reports a refusal as a clean bill of health either.
   *
   * An `ErpClient` satisfies this. Taken as the narrow reader interface so a test can supply
   * four lines instead of a server, and so the Scheduler depends on the answer rather than on
   * how it is obtained — `channelCoverage`'s precedent.
   */
  readonly tombstones?: TombstoneReader;
  /** How often to look for due work. Not the job cadence — that is per job. */
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onEvent?: (event: SchedulerEvent) => void;
  /** Injected so tests drive time instead of waiting for it. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * What a coverage check answers. Structural on purpose — see `channelCoverage`.
 *
 * `verdict` is the whole of the dedup key: `covered`, `dormant` (a channel with no sender
 * here, but every endpoint on it disabled, so nothing is late yet) or `unsendable`.
 */
export interface ChannelCoverageAnswer {
  readonly verdict: string;
  readonly lines: readonly string[];
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
  /**
   * The last channel-coverage verdict per tenant, so only a change is reported.
   *
   * Absent means `covered`, deliberately: the binary already logs the boot verdict, so a
   * deployment that starts unsendable has been told once and does not need telling again
   * every thirty seconds. What that costs is stated rather than hidden — this is
   * per-process state, so a restart forgets it and a still-unsendable tenant is reported
   * again by the boot check, which is the right surface for it anyway.
   */
  private readonly coverage = new Map<string, string>();

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

  /**
   * The channel-coverage verdict for this tenant, but ONLY when it has changed.
   *
   * Returns a fragment to append to the job's summary line, or an empty string — which is
   * the whole design. A check per tick with a line per tick would be a line every thirty
   * seconds per tenant, and the ADR's objection to running this check at all was precisely
   * that. Reporting the transition instead gives the thing the boot check cannot: the
   * moment an endpoint appears on a channel this process has no sender for.
   *
   * A failure to ASK is swallowed, like the probe runner's below and for the same reason:
   * the notifications went out, and an unanswerable diagnostic is not a reason to engage
   * the job's failure backoff and stop delivering for this tenant. It is reported in the
   * line rather than thrown.
   */
  private async coverageChange(tenantId: string): Promise<string> {
    const check = this.options.channelCoverage;
    if (check === undefined) return "";
    let answer: ChannelCoverageAnswer;
    try {
      answer = await check(tenantId);
    } catch (err) {
      return ` | coverage UNKNOWN: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Absent means `covered`: see the field's comment. So a boot that is already
    // unsendable is reported by the binary and not again here, and a tenant that becomes
    // unsendable later is reported once, at the tick that notices.
    const previous = this.coverage.get(tenantId) ?? "covered";
    if (answer.verdict === previous) return "";
    this.coverage.set(tenantId, answer.verdict);
    const detail = answer.lines.length > 0 ? `: ${answer.lines.join("; ")}` : "";
    return ` | coverage ${previous} -> ${answer.verdict}${detail}`;
  }

  /** Dispatches to the thing that actually does the work. Returns a one-line summary. */
  private async execute(tenantId: string, job: JobName): Promise<string> {
    switch (job) {
      case "relay_drain": {
        const r = await this.options.relay.drainTenant(tenantId);
        return (
          `claimed=${r.claimed} delivered=${r.delivered} retried=${r.retried} dead=${r.dead} ` +
          `alarmed=${r.alarmed} unattributed=${r.unattributed} ` +
          // A refused settlement means two workers raced the same row — which `reclaimStale`
          // makes possible by design — and the loser's outcome was discarded rather than
          // written. The counter existed and no deployed process could see it: this line was
          // the operator's only view of a drain, and a race read exactly like a quiet one.
          // Prefixed rather than folded in, so a non-zero value is legible at a glance in a
          // line that is otherwise all zeroes on a healthy tenant.
          `${r.settleLost > 0 ? `LOST=${r.settleLost} ` : ""}` +
          // `oldest=-s` is not a duration, and this line is the operator's only view of a
          // drain. An empty queue says so in words.
          `pending=${r.lag.pending} oldest=` +
          `${r.lag.oldestPendingAgeSeconds === null ? "none" : `${r.lag.oldestPendingAgeSeconds}s`}`
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
      case "notify_prune": {
        // In the CRM's own tables only, like the expiry sweep, so it runs in one
        // transaction: either tonight's prune lands or none of it does.
        const client = await this.options.pool.connect();
        try {
          const r = await withTenantContext(client, tenantId, (tx) =>
            pruneNotifications(tx, tenantId, { asOf: this.now() }),
          );
          return (
            `deletedRead=${r.deletedRead} deletedUnread=${r.deletedUnread} ` +
            `keptSubjectOpen=${r.keptSubjectOpen} keptDeliveryUnsettled=${r.keptDeliveryUnsettled} ` +
            `unknownSubjects=${r.unknownSubjects} more=${r.moreRemaining} ` +
            `retainRead=${r.policy.retain_read_days}d retainUnread=${r.policy.retain_unread_days}d ` +
            // The guard's numbers go in every line, not only on a refusal: a share that
            // has been creeping towards the ceiling is the warning, and it is only
            // visible if the ordinary line carries it.
            `share=${r.sharePercent}%/${r.guard.prune_max_share_percent}% ` +
            `prunable=${r.prunableTotal} inbox=${r.inboxTotal}` +
            (r.overridden ? " overridden=true" : "") +
            // A pass the FLOOR let through over the ceiling used to read like a pass that
            // was within it — `overridden` is only ever true when the guard tripped, and
            // the floor stops it tripping. Named here so the log says which knob did it.
            (r.floorWaived ? ` FLOOR-WAIVED: ${r.floorWaivedReason ?? "under the row floor"}` : "") +
            // A refusal deleted NOTHING, so it must not read like a quiet zero.
            (r.refused ? ` REFUSED: ${r.refusalReason ?? "over the ceiling"}` : "") +
            // Phase two: `crm.notification_delivery`, under its own horizon and its own
            // share of its own table (0046). Its numbers go in the same line because it is
            // the same pass and the same transaction — a second line would read like a
            // second job, which is the thing it deliberately is not. A share OF THE INBOX
            // says nothing about a delete from the delivery table, which is why the two
            // phases measure separately and refuse independently.
            ` | deliveries deleted=${r.delivery.deleted} keptUnsettled=${r.delivery.keptUnsettled} ` +
            `orphaned=${r.delivery.orphaned} more=${r.delivery.moreRemaining} ` +
            `retainDelivery=${r.delivery.retainDeliveryDays}d ` +
            `share=${r.delivery.sharePercent}%/${r.guard.prune_max_share_percent}% ` +
            `prunable=${r.delivery.prunableTotal} pushes=${r.delivery.deliveryTotal}` +
            (r.delivery.overridden ? " overridden=true" : "") +
            (r.delivery.floorWaived
              ? ` FLOOR-WAIVED: ${r.delivery.floorWaivedReason ?? "under the row floor"}`
              : "") +
            (r.delivery.refused
              ? ` REFUSED: ${r.delivery.refusalReason ?? "over the ceiling"}`
              : "")
          );
        } finally {
          client.release();
        }
      }
      case "notify_approvals": {
        // In the CRM's own tables only, like the two sweeps above, so it runs in one
        // transaction: either this pass's notices land or none of them do.
        //
        // The counters are the whole value of the line. `notified` is zero on a healthy
        // tenant and non-zero exactly when the audience MOVED — an officer appointed since
        // the last tick — which is the state this job exists for. `blocked` is the one
        // condition the product cannot fix for itself: a proposal nobody in the tenant may
        // decide, waiting on an administrator to appoint a second holder of the grant. It is
        // prefixed rather than folded in, like the relay's `LOST=`, so a non-zero value is
        // legible at a glance in a line that is otherwise all zeroes.
        const client = await this.options.pool.connect();
        try {
          const r = await withTenantContext(client, tenantId, (tx) =>
            notifyPendingApprovals(tx, tenantId),
          );
          return (
            `${r.blocked > 0 ? `BLOCKED=${r.blocked} ` : ""}` +
            // A blocked proposal with nobody to tell is the end of the chain: the only
            // administrator is the person waiting. Named separately because it is the one
            // case where a non-zero `blocked` produced no notification and never will.
            `${r.unreportable > 0 ? `UNREPORTABLE=${r.unreportable} ` : ""}` +
            `pending=${r.pending} notified=${r.notified} alreadyKnown=${r.alreadyKnown}`
          );
        } finally {
          client.release();
        }
      }
      case "tenant_deletion_watch": {
        const tombstones = this.options.tombstones;
        if (tombstones === undefined) {
          // Not a failure. See the option's doc: the route may not exist and the read may not
          // be granted, and a job that failed on every tick for a deployment that cannot fix
          // it would bury the tenants that CAN be watched.
          return "unconfigured: no tombstone reader (the ERP needs --tenant-deletion-routes and a --tenant-tombstone-read-role this credential holds)";
        }
        // A plain pool client: `watchTenantDeletion` opens its own tenant context, and the
        // registry read it may do afterwards is of the RLS-exempt `crm.tenant` and must not
        // be inside one.
        const client = await this.options.pool.connect();
        try {
          return summariseTenantDeletionWatch(await watchTenantDeletion(client, tombstones, tenantId));
        } finally {
          client.release();
        }
      }
      case "expense_post": {
        // A PLAIN pool client, deliberately not wrapped: the sweep opens one transaction
        // per claim, so one claim that cannot post must not roll back the ones that
        // already did. It refuses a client that is already in a tenant context rather than
        // nesting a BEGIN inside one, which is why the wrapper is its job and not ours.
        const client = await this.options.pool.connect();
        try {
          return summariseExpensePostSweep(
            await sweepApprovedExpenseClaims(client, tenantId, { asOf: this.now() }),
          );
        } finally {
          client.release();
        }
      }
      case "notify_dispatch": {
        // Asked FIRST, and outside the dispatcher guard, because the answer is about this
        // process's senders rather than about anything the dispatcher does — a deployment
        // with no dispatcher configured at all is exactly one that wants to hear that an
        // endpoint has appeared on a channel it cannot send.
        const coverage = await this.coverageChange(tenantId);

        const dispatcher = this.options.notifications;
        if (dispatcher === undefined) {
          return `no dispatcher configured; in-app notifications unaffected${coverage}`;
        }
        const r = await dispatcher.drainTenant(tenantId);
        const line =
          `claimed=${r.claimed} delivered=${r.delivered} retried=${r.retried} ` +
          `dead=${r.dead} pending=${r.pending}` +
          // Only when non-zero, like `LOST=` on the relay line: an orphan means somebody
          // removed a notification out from under a queued push, which is not an endpoint
          // problem and is not something a healthy deployment ever shows.
          (r.orphaned > 0 ? ` ORPHANED=${r.orphaned}` : "");
        // Probes ride this tick rather than a job of their own. A probe failure must not
        // fail the dispatch: the notifications went out, and an administrator's test-send
        // going unanswered is not a reason to engage the job's failure backoff and stop
        // delivering for this tenant.
        const probes = this.options.endpointProbes;
        if (probes === undefined) return `${line}${coverage}`;
        try {
          const p = await probes.runTenant(tenantId);
          if (p.claimed === 0) return `${line}${coverage}`;
          const verdicts = Object.entries(p.byVerdict)
            .filter(([, n]) => n > 0)
            .map(([v, n]) => `${v}=${String(n)}`)
            .join(" ");
          return (
            `${line} | probes=${p.claimed} ${verdicts}` +
            `${p.abandoned > 0 ? ` abandoned=${String(p.abandoned)}` : ""}${coverage}`
          );
        } catch (err) {
          return `${line} | probes FAILED: ${err instanceof Error ? err.message : String(err)}${coverage}`;
        }
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
        const read = ok.reduce((n, r) => n + r.read, 0);
        // `mode` is what we ASKED for. `degraded` is what the ERP could actually do, and
        // until it was reported this line said `mode=incremental` while the job paged
        // every record of every entity — the one human-visible signal asserting the
        // opposite of what happened. Named per snapshot, because which entities cannot be
        // read incrementally is the fact an operator acts on.
        const degraded = ok.filter((r) => r.degraded).map((r) => r.snapshot);
        return (
          `mode=${mode} read=${read} upserted=${upserted} deleted=${deleted} rejected=${rejected}` +
          (degraded.length === 0
            ? ""
            : ` UNBOUNDED: ${degraded.join(",")} published no filterable+sortable updated_at, ` +
              `so \`since\` bounded nothing and each was read in full; their high-water marks ` +
              `were NOT advanced, because a keyset walk over an unsorted view can skip rows`)
        );
      }
    }
  }
}
