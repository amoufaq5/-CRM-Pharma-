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
 * Why this works at all: every entity carries `updated_at` from the `auditable`
 * trait, and `?updated_at[gte]=` is accepted because reference and lifecycle
 * fields are filterable by default. Crucially, `updated_at` is a DATETIME, so the
 * ERP's text comparison is CORRECT for it — ISO-8601 sorts lexicographically in
 * chronological order. That accident is the only reason incremental polling is
 * sound on the deployed store; the same query against a numeric field would be
 * silently wrong (report R19).
 */
export class PollingChangeSource implements ChangeSource {
  private readonly pageSize: number;

  constructor(private readonly options: PollingChangeSourceOptions) {
    this.pageSize = Math.min(options.pageSize ?? 200, 500);
  }

  async changesSince(
    tenantId: string,
    entity: string,
    since: string,
    cursor?: string,
  ): Promise<ChangeBatch> {
    const page = await this.options.client.list(tenantId, entity, {
      // INCLUSIVE (gte, not gt). Two records can share an `updated_at` to the
      // millisecond, and re-reading one is free while skipping one is a silent
      // hole in the snapshot. Callers tolerate redelivery because every write is
      // keyed on a deterministic id.
      filters: [{ field: "updated_at", op: "gte", value: since }],
      sort: { field: "updated_at", direction: "asc" },
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
    };
  }
}
