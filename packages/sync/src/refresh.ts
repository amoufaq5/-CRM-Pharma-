import { randomUUID } from "node:crypto";
import type { ErpClient } from "@crm/acl";
import { PollingChangeSource } from "@crm/acl";
import { withTenantContext } from "@crm/db";
import type { Pool, PoolClient } from "pg";

import { CoercionError } from "./coerce.js";
import { PROJECTIONS, projectionFor, type SnapshotName, type SnapshotProjection } from "./projection.js";
import {
  deleteStale,
  readFreshness,
  touchRows,
  upsertRows,
  writeFreshness,
} from "./snapshot-store.js";

/** The beginning of time for a snapshot that has never synced. */
export const EPOCH = "1970-01-01T00:00:00.000Z";

export interface RejectedRecord {
  readonly recordId: string;
  readonly reason: string;
}

export interface RefreshResult {
  readonly snapshot: SnapshotName;
  readonly mode: "incremental" | "full";
  readonly read: number;
  readonly upserted: number;
  readonly deleted: number;
  /** Records that could not be coerced. Non-empty means data the CRM cannot represent. */
  readonly rejected: readonly RejectedRecord[];
  readonly highWaterMark: string | null;
  /**
   * The ERP could not bound this read, so `since` applied to nothing.
   *
   * `ChangeSource` reports `mode: "full_sweep"` when the entity does not publish
   * `updated_at` as both filterable and sortable — which, measured against a real
   * `operate-server` serving `pack-erp-core`, is ALL 51 of them. Nothing read this flag
   * until now, so a `snapshot_incremental` job paged the entire entity every five minutes
   * per tenant while the only human-visible line said `mode=incremental`.
   *
   * Carried here rather than inferred, because the inference is wrong in both directions: a
   * caller cannot tell from the record count whether a bound applied, and the request's own
   * `mode` is what we ASKED for, not what the ERP did.
   */
  readonly degraded: boolean;
}

export interface SnapshotRefresherOptions {
  readonly pool: Pool;
  readonly client: ErpClient;
  /** Records per ERP page. */
  readonly pageSize?: number;
  /** Safety stop, so a clock skew or a cursor bug cannot loop forever. */
  readonly maxPages?: number;
  readonly now?: () => Date;
  readonly newSyncToken?: () => string;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 10_000;

/**
 * Fills the typed snapshot tables from the ERP.
 *
 * Two modes, and the difference matters more than it looks:
 *
 * - **incremental** resumes from the stored high-water mark and pulls only what
 *   changed. Cheap, and the normal case. It can never observe a DELETION,
 *   because the ERP keeps no tombstone and a deleted record simply stops being
 *   returned — so an incrementally-refreshed snapshot accumulates ghosts.
 * - **full** reads every record, stamps each with a fresh sync token, and then
 *   deletes the rows still carrying an older one. This is the only thing that
 *   reconciles deletions, and it is why `last_full_sweep_at` is tracked
 *   separately from `last_success_at`.
 *
 * Both resume safely: an interrupted run leaves the high-water mark where it
 * was, so the next pass re-reads rather than skipping. Re-reading is free
 * because every write is an upsert keyed on the ERP id.
 */
export class SnapshotRefresher {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => Date;
  private readonly newSyncToken: () => string;
  private readonly changes: PollingChangeSource;

  constructor(private readonly options: SnapshotRefresherOptions) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.now = options.now ?? (() => new Date());
    this.newSyncToken = options.newSyncToken ?? (() => randomUUID());
    this.changes = new PollingChangeSource({ client: options.client, pageSize: this.pageSize });
  }

  async refresh(
    tenantId: string,
    snapshot: SnapshotName,
    mode: "incremental" | "full" = "incremental",
  ): Promise<RefreshResult> {
    const projection = projectionFor(snapshot);
    const client = await this.options.pool.connect();
    try {
      const since =
        mode === "full"
          ? EPOCH
          : await withTenantContext(client, tenantId, async (tx) => {
              const row = await readFreshness(tx, tenantId, snapshot);
              return row?.high_water_mark ?? EPOCH;
            });

      const syncToken = this.newSyncToken();
      const result = await this.sweep(client, tenantId, projection, since, syncToken, mode);

      // A full sweep that drained every page has seen the ERP's complete current
      // state, so anything still carrying an older token is gone at the source.
      // Guarded on `drained`: running this after a partial sweep would delete
      // everything the sweep had not reached yet.
      let deleted = 0;
      if (mode === "full" && result.drained) {
        deleted = await withTenantContext(client, tenantId, (tx) =>
          deleteStale(tx, projection, tenantId, syncToken),
        );
      }

      await withTenantContext(client, tenantId, (tx) =>
        writeFreshness(
          tx,
          tenantId,
          snapshot,
          {
            // Only advance the mark when the sweep actually finished AND the ERP could
            // bound it. An interrupted run must re-read rather than skip — and so must a
            // DEGRADED one, for a less obvious reason: a full sweep's pages walk a view
            // the ERP did not sort (34 of 51 entities publish no sortable field at all),
            // so keyset paging over it can revisit and skip rows. The max `updated_at`
            // over what we happened to read can therefore sit ABOVE the newest record we
            // actually stored, and resuming from it would skip the ones we missed. A
            // watermark is a promise that everything older is accounted for, and an
            // unordered read cannot make it.
            highWaterMark: result.drained && !result.degraded ? result.highWaterMark : null,
            rowsSynced: result.upserted,
            rowsDeleted: deleted,
            fullSweep: mode === "full" && result.drained,
            error: result.rejected.length > 0 ? `${result.rejected.length} record(s) rejected` : null,
          },
          this.now(),
        ),
      );

      return {
        snapshot,
        mode,
        read: result.read,
        upserted: result.upserted,
        deleted,
        rejected: result.rejected,
        highWaterMark: result.drained && !result.degraded ? result.highWaterMark : null,
        degraded: result.degraded,
      };
    } catch (err) {
      // The failure is recorded so a snapshot that has been failing for a day is
      // visible as such rather than merely looking old.
      await withTenantContext(client, tenantId, (tx) =>
        writeFreshness(
          tx,
          tenantId,
          snapshot,
          { rowsSynced: 0, fullSweep: false, error: String(err).slice(0, 2000) },
          this.now(),
        ),
      ).catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Refreshes every snapshot, continuing past one that fails. */
  async refreshAll(
    tenantId: string,
    mode: "incremental" | "full" = "incremental",
  ): Promise<readonly (RefreshResult | { snapshot: SnapshotName; error: string })[]> {
    const out: (RefreshResult | { snapshot: SnapshotName; error: string })[] = [];
    // DERIVED FROM `PROJECTIONS`, not a second list. This was a hard-coded triple, which
    // meant a new snapshot was declared, tested, migrated — and then never refreshed by
    // the scheduler, because the only job that drives all of them enumerated the names
    // again. `projectionFor` already refuses a name with no projection; this makes the
    // reverse impossible too.
    for (const { name } of PROJECTIONS) {
      try {
        out.push(await this.refresh(tenantId, name, mode));
      } catch (err) {
        // One snapshot failing must not leave the others unrefreshed — a broken
        // product feed should not also stop the rep roster updating.
        out.push({ snapshot: name, error: String(err).slice(0, 500) });
      }
    }
    return out;
  }

  private async sweep(
    client: PoolClient,
    tenantId: string,
    projection: SnapshotProjection,
    since: string,
    syncToken: string,
    mode: "incremental" | "full",
  ): Promise<{
    read: number;
    upserted: number;
    rejected: RejectedRecord[];
    highWaterMark: string | null;
    drained: boolean;
    degraded: boolean;
  }> {
    let cursor: string | undefined;
    let read = 0;
    let upserted = 0;
    let high: string | null = null;
    const rejected: RejectedRecord[] = [];
    let pages = 0;
    let drained = false;
    let degraded = false;

    do {
      if (pages >= this.maxPages) {
        throw new Error(
          `${projection.name} sweep exceeded ${this.maxPages} pages — refusing to loop. ` +
            (degraded
              ? // The likelier cause by far, and the old message named the wrong one: the
                // ERP publishes `updated_at` as filterable on no entity, so `since`
                // bounded nothing and this read is the WHOLE entity. A reader sent to look
                // for a changed keyset sort field would find nothing wrong with it.
                `This entity does not support an incremental read (it published no ` +
                `filterable, sortable \`updated_at\`), so \`since\` bounded nothing and this ` +
                `was a full pass over every record. Either the entity is larger than ` +
                `${String(this.maxPages)} pages or the ERP's keyset sort field changed.`
              : `A cursor that never terminates usually means the ERP's keyset sort field changed.`),
        );
      }
      pages += 1;

      const batch = await this.changes.changesSince(
        tenantId,
        projection.entity,
        since,
        cursor,
      );
      read += batch.records.length;
      // Sticky across pages: one unbounded page makes the whole sweep unbounded, and a
      // later page that happened to be filterable would not undo it.
      if (batch.mode === "full_sweep") degraded = true;

      const projected: Record<string, unknown>[] = [];
      const pageRejected: string[] = [];
      for (const change of batch.records) {
        try {
          projected.push(projection.project(change.record));
        } catch (err) {
          // One malformed record must not abandon the sweep, but it must not
          // vanish either: nulling a bad price would make a product look free.
          // The row is skipped and named.
          rejected.push({
            recordId: change.recordId,
            reason: err instanceof CoercionError ? err.message : String(err),
          });
          pageRejected.push(change.recordId);
        }
        if (high === null || change.updatedAt > high) high = change.updatedAt;
      }

      if (projected.length > 0) {
        upserted += await withTenantContext(client, tenantId, (tx) =>
          upsertRows(tx, projection, tenantId, projected, syncToken, this.now()),
        );
      }

      // Re-stamp the rows of records we could not project, so the full sweep's
      // delete pass does not mistake "unrepresentable" for "deleted at the ERP"
      // and drop the last good copy.
      if (pageRejected.length > 0) {
        await withTenantContext(client, tenantId, (tx) =>
          touchRows(tx, projection, tenantId, pageRejected, syncToken),
        );
      }

      cursor = batch.cursor ?? undefined;
      if (batch.cursor === null) drained = true;
    } while (cursor !== undefined);

    // `mode` is unused in the loop but load-bearing in the caller's delete step;
    // named here so the signature reads honestly. NOTE it is a different thing from
    // `degraded`: this is the mode we asked for, that is what the ERP could actually do.
    // The two sitting next to each other under similar names is how the degradation went
    // unread for as long as it did.
    void mode;

    return { read, upserted, rejected, highWaterMark: high, drained, degraded };
  }
}
