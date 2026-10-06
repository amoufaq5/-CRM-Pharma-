/**
 * The jobs the scheduler runs.
 *
 * Since migration 0050 the database's copy of this list is `crm.scheduled_jobs()`, a single
 * declaration the CHECK calls — because this list had been restated in four migrations by
 * then (0009, 0022, 0024, 0031), which is the lockstep 0049 removed for the notification
 * kinds. This union cannot go the same way: a `switch` needs the names at compile time. So
 * the two copies stay and a test asserts they agree, which is the arrangement 0049 left
 * behind for `NOTIFICATION_KINDS`.
 */
export const JOB_NAMES = [
  "relay_drain",
  "snapshot_incremental",
  "snapshot_full",
  "expiry_sweep",
  "notify_dispatch",
  "notify_prune",
  "expense_post",
  "tenant_deletion_watch",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Default cadences, and why each is what it is.
 *
 * - **relay_drain (30s).** This is a rep's write waiting to reach the ERP. The
 *   interval is the floor on how stale "sent" looks in the UI, so it is the
 *   tightest of the three.
 * - **snapshot_incremental (5 min).** Product prices and the rep roster do not
 *   change by the second, and each pass is a full ERP round trip per entity.
 * - **snapshot_full (24h).** The expensive one — it reads EVERY record — but it
 *   is the only thing that reconciles deletions, since the ERP keeps no
 *   tombstones and incremental polling can never observe a record's absence.
 *   Daily is the trade between cost and how long a deleted product may linger
 *   on a rep's device.
 * - **expiry_sweep (24h).** Expiry is a date, so there is nothing a shorter interval
 *   could notice — and the obligations it raises carry deadlines in days. Daily is
 *   also what makes "discovered_on" mean something: a sweep that ran hourly would
 *   record the same date and cost twelve times as much.
 * - **notify_dispatch (30s).** A notification is only useful while it is still news, so
 *   this matches the relay rather than the sweep. The work is usually zero rows.
 * - **notify_prune (24h).** Retention is measured in days, so nothing a shorter interval
 *   could notice — and the pass is capped at 50,000 rows, so a tenant turning retention
 *   on after a year of growth drains over a few nights rather than in one long
 *   transaction. Daily is what makes that cap a schedule rather than a cliff.
 * - **expense_post (5 min).** The one job that acts on money, and the interval is a
 *   deliberate compromise rather than a cadence. It is not 30 seconds, because a sweep
 *   that posts an approved claim within half a minute makes approval and payment feel like
 *   one act and leaves no window in which an approver who has just realised their mistake
 *   can do anything about it. It is not daily, because a rep who is owed money should not
 *   wait for a night to pass. Five minutes matches the snapshot: long enough to be a
 *   separate act, short enough that nobody plans around it.
 * - **tenant_deletion_watch (24h).** Asks the ERP whether a tenant has been deleted
 *   (`GET /v1/platform/tenants/{id}/tombstones`), and on a `tenant_deletion` tombstone marks
 *   the tenant `erp_deleted`, which removes it from every job above. Daily, and the interval
 *   is an argument rather than a default: a tenant deletion is a deliberate, four-eyes,
 *   human act at the other end, not an event that arrives in bursts, so there is nothing a
 *   tighter cadence would catch sooner than the next working day. Against that, every tick
 *   is one HTTP round trip per tenant to a route that answers an empty list almost always,
 *   and a process that asked every thirty seconds would spend most of its ERP budget
 *   confirming that nothing happened. What a day really costs is bounded and worth stating:
 *   up to 24 hours in which this CRM keeps serving reps, pushing webhooks and polling
 *   snapshots for a tenant whose controller has ended the relationship. If that window ever
 *   needs to be minutes, the answer is not a tighter poll — it is the webhook producer the
 *   ADR's Q9 is waiting on, which would make this job the fallback rather than the signal.
 */
export const DEFAULT_INTERVALS_MS: Readonly<Record<JobName, number>> = {
  relay_drain: 30_000,
  snapshot_incremental: 5 * 60_000,
  snapshot_full: 24 * 60 * 60_000,
  expiry_sweep: 24 * 60 * 60_000,
  notify_dispatch: 30_000,
  notify_prune: 24 * 60 * 60_000,
  expense_post: 5 * 60_000,
  tenant_deletion_watch: 24 * 60 * 60_000,
};

/**
 * Backoff for a job that keeps failing: the interval is multiplied by
 * 2^(consecutive failures), capped.
 *
 * Without this, a tenant whose ERP credential has expired re-attempts every 30
 * seconds forever, burying every other tenant's log lines and hammering a
 * server that is already refusing us.
 */
export const MAX_FAILURE_BACKOFF_MULTIPLIER = 32;

export function failureBackoffMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 1;
  return Math.min(2 ** consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
}

/**
 * When a job should next run.
 *
 * Jitter is ±10%, applied on every scheduling decision. Several instances
 * starting together — a rolling deploy, say — would otherwise stay in lockstep
 * forever, so every tenant's work would land in the same instant of each window
 * instead of spreading across it.
 */
export function nextRunAt(
  now: Date,
  intervalMs: number,
  consecutiveFailures: number,
  random: () => number = Math.random,
): Date {
  const base = intervalMs * failureBackoffMultiplier(consecutiveFailures);
  const jitter = base * 0.1 * (random() * 2 - 1);
  return new Date(now.getTime() + Math.max(1000, Math.round(base + jitter)));
}
