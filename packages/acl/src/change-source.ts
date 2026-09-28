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
 * Polling works because every ERP entity carries `updated_at` from the
 * `auditable` trait and the list API supports `?updated_at[gte]=`. ISO-8601 is
 * safe under the ERP's text comparison (report R19) precisely because
 * lexicographic order equals chronological order for that format — this is the
 * one place that defect does not bite, and the reason we can poll at all.
 */
export interface ChangedRecord {
  readonly entity: string;
  readonly recordId: string;
  readonly updatedAt: string;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface ChangeBatch {
  readonly records: readonly ChangedRecord[];
  /** Pass to the next call to continue. Null when the source is caught up. */
  readonly cursor: string | null;
  /** The high-water mark to persist; resume from here after a restart. */
  readonly highWaterMark: string | null;
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
}
