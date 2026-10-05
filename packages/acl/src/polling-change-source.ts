import type { ChangeBatch, ChangedRecord, ChangeSource } from "./change-source.js";
import type { ErpClient } from "./client.js";

export interface PollingChangeSourceOptions {
  readonly client: ErpClient;
  /** Records per request. Clamped to the ERP's 500 ceiling. */
  readonly pageSize?: number;
}

/**
 * `ChangeSource` over the ERP's list API, driven by `updated_at`.
 *
 * Polling rather than push because the ERP cannot push: `meta.webhook_endpoints`
 * and `meta.webhook_deliveries` are fully specified tables with a complete
 * delivery state machine and no code that writes or delivers them, and there is
 * no broker and no CDC writer (report R4). The platform has committed to
 * building outbound webhooks (ADR-0001 Q9); when they land, a
 * `WebhookChangeSource` replaces this behind the same interface and no caller
 * changes.
 *
 * WHETHER IT CAN POLL INCREMENTALLY AT ALL IS A PROPERTY OF THE SERVED SCHEMA, and this
 * comment used to assert it always could: "every entity carries `updated_at` from the
 * `auditable` trait, and `?updated_at[gte]=` is accepted because reference and lifecycle
 * fields are filterable by default". Checked against a real `operate-server` serving
 * `pack-erp-core`, both halves are false — 0 of 51 entities declare `updated_at` and 0
 * have it filterable, because `buildUiSchema` reads the manifest's `fields` and not
 * `resolvedFields`, so a trait's columns never appear. See `change-source.ts`.
 *
 * So the filter is applied only where the schema says it will be honoured. Where it will
 * not, this reads everything it can page through and returns `mode: "full_sweep"`. The
 * filter is never sent speculatively: the ERP ignores an unknown filter rather than
 * refusing it, so a speculative one would produce an unbounded result set that looked
 * bounded — and `ErpClient.assertFilterable` would refuse it anyway, which is the guard
 * working as intended.
 *
 * Where it IS honoured, `updated_at` is a DATETIME and the ERP's text comparison is
 * correct for it: ISO-8601 sorts lexicographically in chronological order. That accident
 * is the only reason incremental polling is sound on the deployed store; the same query
 * against a numeric field would be silently wrong (report R19).
 */
export class PollingChangeSource implements ChangeSource {
  private readonly pageSize: number;

  constructor(private readonly options: PollingChangeSourceOptions) {
    this.pageSize = Math.min(options.pageSize ?? 200, 500);
  }

  /**
   * Can `since` be honoured for this entity?
   *
   * Asked of the served schema, not assumed. Both the filter AND the sort have to be
   * supported: a filtered-but-unsorted page would still be correct, but the cursor would
   * walk the view's default order while the watermark advanced by `updated_at`, and the
   * two can disagree about what has been seen.
   */
  async supportsIncremental(tenantId: string, entity: string): Promise<boolean> {
    const schema = await this.options.client.schema(tenantId);
    const ent = schema.entity(entity);
    return (
      ent.filterableFields.includes("updated_at") && ent.sortableFields.includes("updated_at")
    );
  }

  async changesSince(
    tenantId: string,
    entity: string,
    since: string,
    cursor?: string,
  ): Promise<ChangeBatch> {
    const incremental = await this.supportsIncremental(tenantId, entity);
    const page = await this.options.client.list(tenantId, entity, {
      // INCLUSIVE (gte, not gt). Two records can share an `updated_at` to the
      // millisecond, and re-reading one is free while skipping one is a silent
      // hole in the snapshot. Callers tolerate redelivery because every write is
      // keyed on a deterministic id.
      ...(incremental
        ? {
            filters: [{ field: "updated_at", op: "gte", value: since }],
            sort: { field: "updated_at", direction: "asc" as const },
          }
        : {}),
      limit: this.pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const records: ChangedRecord[] = [];
    let high: string | null = null;
    for (const raw of page.data) {
      const rec = raw as Record<string, unknown>;
      const id = typeof rec["id"] === "string" ? rec["id"] : null;
      const updatedAt = typeof rec["updated_at"] === "string" ? rec["updated_at"] : null;
      // A record with no id or no updated_at cannot be stored or resumed from.
      // Skipping beats guessing: it will reappear on the next pass if it is real.
      if (id === null || updatedAt === null) continue;
      records.push({ entity, recordId: id, updatedAt, record: rec });
      if (high === null || updatedAt > high) high = updatedAt;
    }

    return {
      records,
      cursor: page.nextCursor,
      // Only advance the mark once the page is drained. Advancing mid-page would
      // skip the rest of it if the process died before the next call.
      highWaterMark: page.nextCursor === null ? high : null,
      // Carried so a caller cannot mistake one for the other. In `full_sweep` the records
      // are still correct; what is untrue of them is that `since` bounded the read.
      mode: incremental ? "incremental" : "full_sweep",
    };
  }
}
