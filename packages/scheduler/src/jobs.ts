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
  "notify_approvals",
  "referential_check",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Jobs that belong to the DEPLOYMENT rather than to a tenant (0067).
 *
 * The same two-copies arrangement as `JOB_NAMES` and `crm.scheduled_jobs()`, mirrored by
 * `crm.platform_jobs()` and asserted equal by a test. The reason this list exists at all is
 * narrower than it looks: an erasure receipt belongs to a tenant that has been ERASED, and
 * `activeTenants` is `status = 'active'` — so nothing in `JOB_NAMES` can ever reach one, and the
 * alternative was putting a deleted tenant back into the loop 0050 took it out of.
 */
export const PLATFORM_JOB_NAMES = ["receipt_verify", "abandon_stopped_work"] as const;
export type PlatformJobName = (typeof PLATFORM_JOB_NAMES)[number];

/**
 * - **receipt_verify (24h).** Re-verifies every stored erasure receipt against a known-answer
 *   self-test, so a bug in our own canonicalisation can be told from a rewritten row. Daily
 *   because the receipts are append-only and a rewrite is a deliberate act by somebody with
 *   database access, not an event that arrives in bursts — and a sweep reads every receipt in the
 *   deployment. What a day costs is worth stating rather than hiding: a day in which evidence of
 *   a rewritten deletion record sits unreported.
 * - **abandon_stopped_work (24h).** Settles the queued work of a tenant the ERP deleted (0068),
 *   which no per-tenant job can reach for the same reason: `activeTenants` is `status = 'active'`.
 *   THE BACKSTOP AND NOT THE MECHANISM — `watchTenantDeletion` settles in the same transaction
 *   that stops the tenant, so there is never an instant in which a deleted tenant has live pending
 *   work. This exists for rows stopped before 0068 shipped, or stopped by hand in SQL. Daily, and
 *   on a healthy deployment it settles nothing every night and says so.
 */
export const DEFAULT_PLATFORM_INTERVALS_MS: Readonly<Record<PlatformJobName, number>> = {
  receipt_verify: 24 * 60 * 60_000,
  abandon_stopped_work: 24 * 60 * 60_000,
};

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
 * - **notify_approvals (15 min).** Tells whoever can act on a configuration change that takes
 *   two people, and the cadence is an argument about WHAT IT IS FOR rather than about cost.
 *   The common case is already immediate: the route that creates a proposal tells every holder
 *   of the grant through the same function this job calls. What this catches is the audience
 *   MOVING afterwards — a tenant whose only officer asked for something, and an officer
 *   appointed later who is now eligible for everything pending. The act that creates that
 *   state is a role grant, which happens in a session an administrator is sitting in, so what
 *   matters is "before they have moved on", not "within the minute". Fifteen minutes is longer
 *   than `expense_post`, because nothing here is owed to anybody; far shorter than daily,
 *   because the thing waiting is a person. The pass is one query returning zero rows on a
 *   tenant with nothing pending, which is almost every tenant almost always.
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
 * - **referential_check (24h).** ADR-0001 Q1's answer was "no FKs; ACL-enforced integrity plus a
 *   NIGHTLY orphan check", and this is it — the table has held its results since migration 0005
 *   with nothing writing them. The cadence is forced rather than chosen: the check reads the
 *   snapshots, and the only thing that ever observes an ERP deletion is `snapshot_full`, which
 *   runs daily because the ERP keeps no tombstones. A tighter interval could not find anything
 *   sooner; it would re-report yesterday's finding against yesterday's mirror. The pass is one
 *   anti-join per checkable reference — ten queries, zero rows on a healthy tenant.
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
  notify_approvals: 15 * 60_000,
  referential_check: 24 * 60 * 60_000,
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
