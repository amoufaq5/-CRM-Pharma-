import type { PoolClient } from "pg";
import {
  DEFAULT_INTERVALS_MS,
  JOB_NAMES,
  nextRunAt,
  type JobName,
  type PlatformJobName,
} from "./jobs.js";

export interface TenantRow {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
}

/**
 * The tenants this deployment works, read from the CRM's OWN registry.
 *
 * Not from the ERP: crm_app holds SELECT on one ERP table and nothing else, and
 * widening that for a tenant list would break the allow-list discipline. The
 * registry carries no tenant data, so it needs no tenant context to read —
 * which is exactly why it can answer "which contexts exist".
 */
export async function activeTenants(tx: PoolClient): Promise<readonly TenantRow[]> {
  const { rows } = await tx.query<TenantRow>(
    "SELECT tenant_id, display_name, status FROM crm.tenant WHERE status = 'active' ORDER BY created_at",
  );
  return rows;
}

export interface DueJob {
  readonly tenant_id: string;
  readonly job: JobName;
  readonly interval_ms: number;
  readonly consecutive_failures: number;
}

/**
 * Claims the jobs due for one tenant, advancing `next_run_at` in the same
 * statement.
 *
 * Advancing at claim time is the whole concurrency story. A second instance
 * arriving in the same window finds nothing due, so no lock, lease or heartbeat
 * is needed — and because both jobs are idempotent, an instance that dies
 * mid-run costs one skipped window rather than a stuck row someone has to
 * reclaim. `FOR UPDATE SKIP LOCKED` keeps two instances claiming at the same
 * instant from serialising on each other.
 *
 * The provisional advance uses the CURRENT failure count; `recordResult` sets
 * the real next run once the outcome is known.
 */
export async function claimDueJobs(
  tx: PoolClient,
  tenantId: string,
  now: Date,
  random: () => number = Math.random,
): Promise<readonly DueJob[]> {
  const { rows } = await tx.query<DueJob>(
    `SELECT tenant_id, job, interval_ms, consecutive_failures
       FROM crm.scheduled_job
      WHERE tenant_id = $1 AND enabled AND next_run_at <= $2
      ORDER BY next_run_at
      FOR UPDATE SKIP LOCKED`,
    [tenantId, now],
  );
  for (const row of rows) {
    await tx.query(
      "UPDATE crm.scheduled_job SET next_run_at = $3, last_run_at = $4 WHERE tenant_id = $1 AND job = $2",
      [tenantId, row.job, nextRunAt(now, row.interval_ms, row.consecutive_failures, random), now],
    );
  }
  return rows;
}

export interface JobResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string;
  /**
   * The job's summary line, kept on the row for a PLATFORM job (0067).
   *
   * Ignored by `recordResult` below, which governs the per-tenant table — a tenant's last job
   * line is one of thousands and the log is where it belongs. For the deployment's own jobs there
   * is exactly one row, and its most recent answer about the erasure evidence is worth being able
   * to read without finding the log.
   */
  readonly detail?: string;
}

/**
 * Records a job's outcome and sets its real next run.
 *
 * On success the failure counter resets, so a tenant that recovers returns to
 * its normal cadence immediately rather than serving out a long backoff it no
 * longer deserves.
 */
export async function recordResult(
  tx: PoolClient,
  tenantId: string,
  job: JobName,
  result: JobResult,
  now: Date,
  random: () => number = Math.random,
): Promise<void> {
  const { rows } = await tx.query<{ interval_ms: number; consecutive_failures: number }>(
    "SELECT interval_ms, consecutive_failures FROM crm.scheduled_job WHERE tenant_id = $1 AND job = $2",
    [tenantId, job],
  );
  const row = rows[0];
  if (row === undefined) return;

  const failures = result.ok ? 0 : row.consecutive_failures + 1;
  await tx.query(
    `UPDATE crm.scheduled_job SET
       last_success_at      = CASE WHEN $3 THEN $6 ELSE last_success_at END,
       last_status          = CASE WHEN $3 THEN 'ok' ELSE 'error' END,
       last_error           = $4,
       last_duration_ms     = $5,
       consecutive_failures = $7,
       next_run_at          = $8
     WHERE tenant_id = $1 AND job = $2`,
    [
      tenantId,
      job,
      result.ok,
      result.error ?? null,
      Math.round(result.durationMs),
      now,
      failures,
      nextRunAt(now, row.interval_ms, failures, random),
    ],
  );
}

/**
 * Creates any missing job rows for a tenant at their default cadence.
 *
 * Run on every tick rather than only at provisioning, so a tenant added by hand
 * — or a job introduced by a later release — starts running without anyone
 * remembering to backfill a row. `ON CONFLICT DO NOTHING` leaves a tenant's
 * tuned intervals and their `enabled` flag alone.
 */
export async function ensureJobs(tx: PoolClient, tenantId: string, now: Date): Promise<number> {
  let created = 0;
  for (const job of JOB_NAMES) {
    const { rowCount } = await tx.query(
      `INSERT INTO crm.scheduled_job (tenant_id, job, interval_ms, next_run_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, job) DO NOTHING`,
      [tenantId, job, DEFAULT_INTERVALS_MS[job], now],
    );
    created += rowCount ?? 0;
  }
  return created;
}

export interface JobHealth {
  readonly tenant_id: string;
  readonly job: JobName;
  readonly enabled: boolean;
  readonly last_status: string | null;
  readonly last_success_at: Date | null;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
  readonly next_run_at: Date;
}

/** Every job row for a tenant — what a health endpoint and an operator both read. */
export async function jobHealth(tx: PoolClient, tenantId: string): Promise<readonly JobHealth[]> {
  const { rows } = await tx.query<JobHealth>(
    `SELECT tenant_id, job, enabled, last_status, last_success_at,
            consecutive_failures, last_error, next_run_at
       FROM crm.scheduled_job WHERE tenant_id = $1 ORDER BY job`,
    [tenantId],
  );
  return rows;
}

/**
 * Work that belongs to the DEPLOYMENT rather than to a tenant (0067).
 *
 * WHY THIS EXISTS AT ALL, because a second scheduling table needs a reason. An erasure receipt
 * belongs to a tenant that has been ERASED, and `activeTenants` above is `status = 'active'` —
 * deliberately, since 0050's whole point is that a deleted tenant's background work stops. So
 * there is no per-tenant job that can ever reach a receipt, and the alternative was putting a
 * deleted tenant back into the loop 0050 took it out of.
 *
 * `crm.platform_job` is `crm.scheduled_job` with the tenant taken out and the same semantics
 * everywhere else, so an operator who knows one knows the other. These two functions are the
 * tenant-free twins of `claimDueJobs` and `recordResult`, and the one thing they do NOT share is
 * `ensureJobs`: there is exactly one row per job for the whole deployment, so 0067 seeds it and
 * nothing has to discover it per tenant.
 */
export interface DuePlatformJob {
  readonly job: PlatformJobName;
  readonly interval_ms: number;
  readonly consecutive_failures: number;
}

/**
 * Claims the platform jobs that are due, advancing `next_run_at` in the same statement.
 *
 * The same concurrency story as `claimDueJobs`, and it matters more here: there is one row per
 * job for the whole deployment, so every instance of the scheduler contends for the SAME row
 * rather than for a per-tenant one. Advancing at claim time under `FOR UPDATE SKIP LOCKED` means
 * a second instance arriving in the same window finds nothing due and does not wait.
 */
export async function claimDuePlatformJobs(
  tx: PoolClient,
  now: Date,
  random: () => number = Math.random,
): Promise<readonly DuePlatformJob[]> {
  const { rows } = await tx.query<DuePlatformJob>(
    `WITH due AS (
       SELECT job FROM crm.platform_job
        WHERE enabled AND next_run_at <= $1
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
     )
     UPDATE crm.platform_job p
        SET last_run_at = $1,
            next_run_at = $2
      WHERE p.job IN (SELECT job FROM due)
      RETURNING p.job, p.interval_ms, p.consecutive_failures`,
    // The provisional advance uses the CURRENT failure count, like the per-tenant claim;
    // `recordPlatformResult` sets the real next run once the outcome is known.
    [now, nextRunAt(now, 60_000, 0, random)],
  );
  return rows;
}

export async function recordPlatformResult(
  tx: PoolClient,
  job: PlatformJobName,
  result: JobResult,
  now: Date,
  random: () => number = Math.random,
): Promise<void> {
  const { rows } = await tx.query<{ interval_ms: number; consecutive_failures: number }>(
    "SELECT interval_ms, consecutive_failures FROM crm.platform_job WHERE job = $1",
    [job],
  );
  const row = rows[0];
  if (row === undefined) return;

  const failures = result.ok ? 0 : row.consecutive_failures + 1;
  await tx.query(
    `UPDATE crm.platform_job SET
       last_success_at      = CASE WHEN $2 THEN $5 ELSE last_success_at END,
       last_status          = CASE WHEN $2 THEN 'ok' ELSE 'error' END,
       last_error           = $3,
       last_detail          = $6,
       last_duration_ms     = $4,
       consecutive_failures = $7,
       next_run_at          = $8
     WHERE job = $1`,
    [
      job,
      result.ok,
      result.error ?? null,
      Math.round(result.durationMs),
      now,
      // `last_detail` is the summary line, kept on the row as well as logged. The per-tenant
      // table has no such column and does not need one: a tenant's last job line is one of
      // thousands, where this is the deployment's single most recent answer about its own
      // erasure evidence, and an operator reading the row should not have to find the log.
      result.detail ?? null,
      failures,
      nextRunAt(now, row.interval_ms, failures, random),
    ],
  );
}
