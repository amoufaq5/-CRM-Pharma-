import type { PoolClient } from "pg";
import type { SnapshotProjection } from "./projection.js";

/**
 * Upserts a batch of projected rows.
 *
 * One multi-row statement rather than a loop: a snapshot refresh moves thousands
 * of rows, and a round trip each would dominate the wall clock.
 *
 * `synced_at` and `sync_token` are set on every write, including updates, so the
 * sweep in `deleteStale` can tell a row it just touched from one it did not.
 *
 * Identifiers come from the projection, which is a hand-written constant in this
 * package — never from a record, a request, or the ERP. Nothing user-controlled
 * reaches the SQL text; every VALUE is bound.
 */
export async function upsertRows(
  tx: PoolClient,
  projection: SnapshotProjection,
  tenantId: string,
  rows: readonly Record<string, unknown>[],
  syncToken: string,
  now: Date,
): Promise<number> {
  if (rows.length === 0) return 0;

  const cols = ["tenant_id", ...projection.columns, "synced_at", "sync_token"];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const values = [tenantId, ...projection.columns.map((c) => row[c] ?? null), now, syncToken];
    const placeholders = values.map((v) => `$${params.push(v)}`);
    return `(${placeholders.join(", ")})`;
  });

  // Everything except the key is overwritten. A snapshot row has no CRM-owned
  // state worth preserving — it is derived, and the ERP is always right about it.
  const updates = [...projection.columns, "synced_at", "sync_token"]
    .filter((c) => c !== projection.idColumn)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const { rowCount } = await tx.query(
    `INSERT INTO ${projection.table} (${cols.join(", ")})
     VALUES ${tuples.join(", ")}
     ON CONFLICT (tenant_id, ${projection.idColumn}) DO UPDATE SET ${updates}`,
    params,
  );
  return rowCount ?? 0;
}

/**
 * Re-stamps the sync token on rows whose ERP record was REJECTED this sweep.
 *
 * Without this, a full sweep deletes them: the record was never projected, so
 * its row keeps the previous token and `deleteStale` reads it as gone from the
 * ERP. But it is NOT gone — it exists and we merely could not represent this
 * version of it (one unparseable price, say). Deleting the last good copy turns
 * a data-quality problem into missing data on every rep's device, which is
 * strictly worse than serving a slightly stale row.
 *
 * Found by a test written for exactly this; it failed on the first run.
 */
export async function touchRows(
  tx: PoolClient,
  projection: SnapshotProjection,
  tenantId: string,
  recordIds: readonly string[],
  syncToken: string,
): Promise<number> {
  if (recordIds.length === 0) return 0;
  const { rowCount } = await tx.query(
    `UPDATE ${projection.table} SET sync_token = $3
      WHERE tenant_id = $1 AND ${projection.idColumn} = ANY($2::text[])`,
    [tenantId, recordIds, syncToken],
  );
  return rowCount ?? 0;
}

/**
 * Removes rows a completed full sweep did not touch.
 *
 * This is the ONLY way a deletion ever reaches a snapshot. `pack-erp-core`
 * entities declare `auditable` and not `soft_deletable`, so the ERP keeps no
 * tombstone and a deleted record simply stops being returned — which polling on
 * `updated_at` can never observe. An incrementally-refreshed snapshot therefore
 * accumulates ghosts until a full sweep reconciles it.
 *
 * Only ever called after a sweep that drained every page. Running it on a
 * partial sweep would delete everything the sweep had not reached yet.
 */
export async function deleteStale(
  tx: PoolClient,
  projection: SnapshotProjection,
  tenantId: string,
  syncToken: string,
): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM ${projection.table}
      WHERE tenant_id = $1 AND (sync_token IS DISTINCT FROM $2)`,
    [tenantId, syncToken],
  );
  return rowCount ?? 0;
}

export interface FreshnessRow {
  readonly snapshot: string;
  readonly high_water_mark: string | null;
  readonly last_refresh_at: Date | null;
  readonly last_success_at: Date | null;
  readonly last_full_sweep_at: Date | null;
  readonly rows_synced: string;
  readonly rows_deleted: string;
  readonly warn_after_seconds: number;
  readonly block_after_seconds: number;
  readonly last_error: string | null;
}

export async function readFreshness(
  tx: PoolClient,
  tenantId: string,
  snapshot: string,
): Promise<FreshnessRow | null> {
  const { rows } = await tx.query<FreshnessRow>(
    `SELECT snapshot, high_water_mark, last_refresh_at, last_success_at, last_full_sweep_at,
            rows_synced, rows_deleted, warn_after_seconds, block_after_seconds, last_error
       FROM crm.snapshot_freshness WHERE tenant_id = $1 AND snapshot = $2`,
    [tenantId, snapshot],
  );
  return rows[0] ?? null;
}

export interface FreshnessUpdate {
  readonly highWaterMark?: string | null;
  readonly rowsSynced: number;
  readonly rowsDeleted?: number;
  readonly fullSweep: boolean;
  readonly error?: string | null;
}

/**
 * Records the outcome of a refresh.
 *
 * `rows_synced` and `rows_deleted` ACCUMULATE rather than being replaced: they
 * are lifetime counters for a dashboard, and an incremental pass that moved
 * three rows should not make the snapshot look like it holds three.
 *
 * `last_success_at` advances only when the pass succeeded, while
 * `last_refresh_at` advances either way — so "we tried recently but it has been
 * failing for a day" is visible, which a single timestamp would hide.
 */
export async function writeFreshness(
  tx: PoolClient,
  tenantId: string,
  snapshot: string,
  update: FreshnessUpdate,
  now: Date,
): Promise<void> {
  const ok = update.error === undefined || update.error === null;
  await tx.query(
    `INSERT INTO crm.snapshot_freshness
       (tenant_id, snapshot, high_water_mark, last_refresh_at, last_success_at,
        last_full_sweep_at, rows_synced, rows_deleted, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, snapshot) DO UPDATE SET
       high_water_mark    = COALESCE(EXCLUDED.high_water_mark, crm.snapshot_freshness.high_water_mark),
       last_refresh_at    = EXCLUDED.last_refresh_at,
       last_success_at    = COALESCE(EXCLUDED.last_success_at, crm.snapshot_freshness.last_success_at),
       last_full_sweep_at = COALESCE(EXCLUDED.last_full_sweep_at, crm.snapshot_freshness.last_full_sweep_at),
       rows_synced        = crm.snapshot_freshness.rows_synced  + EXCLUDED.rows_synced,
       rows_deleted       = crm.snapshot_freshness.rows_deleted + EXCLUDED.rows_deleted,
       last_error         = EXCLUDED.last_error`,
    [
      tenantId,
      snapshot,
      update.highWaterMark ?? null,
      now,
      ok ? now : null,
      update.fullSweep && ok ? now : null,
      update.rowsSynced,
      update.rowsDeleted ?? 0,
      update.error ?? null,
    ],
  );
}

export type StalenessLevel = "fresh" | "warn" | "block" | "never_synced";

export interface Staleness {
  readonly snapshot: string;
  readonly level: StalenessLevel;
  readonly ageSeconds: number | null;
  readonly lastSuccessAt: Date | null;
}

/**
 * How stale a snapshot is against its configured budget.
 *
 * The UI shows "as of" wherever a snapshot value drives a decision, warns past
 * `warn_after_seconds`, and blocks the action past `block_after_seconds`. A
 * snapshot that has NEVER synced is `never_synced` rather than infinitely stale,
 * because those want different words in front of a rep: "prices may be out of
 * date" versus "this device has no price list yet".
 */
export function evaluateStaleness(row: FreshnessRow, now: Date): Staleness {
  if (row.last_success_at === null) {
    return { snapshot: row.snapshot, level: "never_synced", ageSeconds: null, lastSuccessAt: null };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - row.last_success_at.getTime()) / 1000));
  const level: StalenessLevel =
    ageSeconds >= row.block_after_seconds ? "block" : ageSeconds >= row.warn_after_seconds ? "warn" : "fresh";
  return { snapshot: row.snapshot, level, ageSeconds, lastSuccessAt: row.last_success_at };
}
