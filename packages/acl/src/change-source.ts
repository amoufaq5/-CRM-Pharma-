/**
 * The seam between "how the CRM learns an ERP record changed" and every caller.
 *
 * Today there is only one implementation, and it polls. The ERP CANNOT push:
 * `meta.webhook_endpoints` and `meta.webhook_deliveries` are fully specified
 * tables with a complete delivery state machine and no code that writes or
 * delivers them, there is no broker, no LISTEN/NOTIFY and no CDC writer
 * (report R4).
 *
 * The platform has committed to implementing outbound webhooks (ADR-0001 Q9),
 * so this interface exists from day one: swapping `PollingChangeSource` for a
 * `WebhookChangeSource` must not touch a single caller.
 *
 * POLLING INCREMENTALLY IS NOT ALWAYS POSSIBLE, and the comment that used to stand here
 * said it always was. It claimed every entity carries `updated_at` from the `auditable`
 * trait and the list API accepts `?updated_at[gte]=`. Measured against a real
 * `operate-server` serving `pack-erp-core`: **0 of 51 entities declare `updated_at` in
 * the served schema and 0 have it in `filterableFields`**. The column exists on every
 * record — the trait really does add it — but `buildUiSchema` reads the manifest's own
 * `fields` rather than `resolvedFields`, so the trait's columns are never declared, and
 * `updated_at` is neither a reference nor a lifecycle field so nothing adds it to the
 * filterable set either.
 *
 * The consequence is not academic: `?updated_at[gte]=2099-01-01` returns the row anyway,
 * because the ERP ignores an unknown filter instead of refusing it (report R19's sibling,
 * and the reason README rule 3 exists). A watermark would advance against a result set it
 * never bounded.
 *
 * So a batch now says which mode produced it. Where `updated_at` is filterable the poll
 * is incremental and the watermark means what it says; where it is not, the source reads
 * EVERYTHING and says so, and the caller must not treat the watermark as a bound on what
 * was examined. Falling back loudly rather than refusing is deliberate — snapshots are
 * the read path, not an optimisation (ADR-0001 item 8), and a job that fails every five
 * minutes leaves a rep's prices as stale as the 24-hour full sweep while burying every
 * other log line. Falling back SILENTLY would have been worse than either: it is exactly
 * the ERP's own dropped-filter bug, recreated one layer up.
 *
 * Where it does work, ISO-8601 is safe under the ERP's text comparison (report R19)
 * because lexicographic order equals chronological order for that format — the one place
 * that defect does not bite.
 */
export interface ChangedRecord {
  readonly entity: string;
  readonly recordId: string;
  readonly updatedAt: string;
  readonly record: Readonly<Record<string, unknown>>;
}

/**
 * How a batch was actually obtained.
 *
 * `full_sweep` means the source could not filter by `updated_at` and read everything it
 * could page through. The records are still correct; what is NOT true of such a batch is
 * that `since` bounded it, so nothing may conclude from a short batch that little
 * changed.
 */
export type ChangeMode = "incremental" | "full_sweep";

export interface ChangeBatch {
  readonly records: readonly ChangedRecord[];
  /** Pass to the next call to continue. Null when the source is caught up. */
  readonly cursor: string | null;
  /** The high-water mark to persist; resume from here after a restart. */
  readonly highWaterMark: string | null;
  /**
   * Which mode produced this batch. Present so a caller cannot mistake a full sweep for
   * an incremental one — the distinction is invisible in the records themselves.
   */
  readonly mode: ChangeMode;
}

export interface ChangeSource {
  /**
   * Changes to `entity` at or after `since` (an ISO-8601 instant).
   *
   * Implementations MUST be inclusive of `since` rather than exclusive: two
   * records can share an `updated_at` to the millisecond, and skipping is worse
   * than repeating. Callers must therefore tolerate redelivery — which they do,
   * because every write is keyed on a deterministic id.
   */
  changesSince(
    tenantId: string,
    entity: string,
    since: string,
    cursor?: string,
  ): Promise<ChangeBatch>;

  /**
   * Whether `changesSince` can honour `since` for this entity.
   *
   * Separate from the batch so a caller can report the degradation BEFORE it reads
   * anything, which is what a scheduler summary and an operator both want.
   */
  supportsIncremental(tenantId: string, entity: string): Promise<boolean>;
}
