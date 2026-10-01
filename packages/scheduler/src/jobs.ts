/** The jobs the scheduler runs. Mirrors the CHECK on `crm.scheduled_job.job`. */
export const JOB_NAMES = ["relay_drain", "snapshot_incremental", "snapshot_full", "expiry_sweep"] as const;
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
 */
export const DEFAULT_INTERVALS_MS: Readonly<Record<JobName, number>> = {
  relay_drain: 30_000,
  snapshot_incremental: 5 * 60_000,
  snapshot_full: 24 * 60 * 60_000,
  expiry_sweep: 24 * 60 * 60_000,
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
