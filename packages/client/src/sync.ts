import { SYNC_BATCH_MAX, SyncResponse, type VisitBody } from "./api.js";
import { applyBatchFailure, applySyncResults, dueEntries, rejectUnreconcilable, reviveDue, DEFAULT_BACKOFF, type ApplyResult, type BackoffPolicy, type OutboxEntry } from "./outbox.js";
import { classifyTransportOutcome } from "./outcome.js";
import type { ClientStore } from "./store.js";

/**
 * The drain loop: read the queue, send one batch, fold the answer back, repeat.
 *
 * Impure only through what is injected. `transport` is the single seam the browser fills
 * with `fetch`, and it returns a tagged result rather than throwing, because "the network
 * is gone" is the NORMAL case for this client and an exception is the wrong shape for a
 * normal case.
 */
export type TransportResult =
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | { readonly kind: "status"; readonly status: number; readonly problemKind?: string | undefined; readonly detail?: string | undefined }
  | { readonly kind: "network"; readonly detail?: string | undefined };

export interface SyncTransport {
  postVisits(visits: readonly VisitBody[]): Promise<TransportResult>;
}

export interface SyncDeps {
  readonly store: ClientStore;
  readonly transport: SyncTransport;
  readonly now: () => number;
  readonly random?: () => number;
  readonly backoff?: BackoffPolicy;
  /** Batch size, capped at the server's maximum however large this is. */
  readonly batchSize?: number;
  /** Safety valve on the loop, not on the queue: how many batches one call may send. */
  readonly maxBatches?: number;
  /**
   * Void the backoff on every pending row before draining.
   *
   * Set when something has changed that the backoff cannot know about: the browser fired
   * `online`, or a person pressed Sync now. Without it, a queue that has backed off once
   * ignores both for up to half an hour — which is how "Sync now" becomes a button that
   * does nothing.
   */
  readonly revive?: boolean;
}

export interface SyncReport {
  readonly batches: number;
  readonly accepted: readonly string[];
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly retrying: readonly string[];
  readonly stopped: { readonly reason: string } | null;
  readonly reauthenticate: boolean;
  /** Rows still pending after this call — not an error, just how much is left. */
  readonly remaining: number;
}

export async function syncOnce(deps: SyncDeps): Promise<SyncReport> {
  const random = deps.random ?? Math.random;
  const policy = deps.backoff ?? DEFAULT_BACKOFF;
  const batchSize = Math.min(deps.batchSize ?? SYNC_BATCH_MAX, SYNC_BATCH_MAX);
  const maxBatches = deps.maxBatches ?? 25;

  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const retrying: string[] = [];
  let stopped: { reason: string } | null = null;
  let reauthenticate = false;
  let batches = 0;

  let entries = await deps.store.readOutbox();

  // Before anything is sent: a row that cannot be reconciled is refused here, visibly,
  // rather than sent forever and reported nowhere.
  const screened = rejectUnreconcilable(entries);
  if (screened.refused.length > 0) {
    entries = screened.entries;
    await deps.store.replaceOutbox(entries);
    for (const id of screened.refused) {
      rejected.push({ id, reason: entries.find((e) => e.id === id)?.lastReason ?? "unreconcilable queue entry" });
    }
  }

  if (deps.revive === true) {
    const revived = reviveDue(entries, deps.now());
    if (revived.some((e, i) => e !== entries[i])) {
      entries = revived;
      await deps.store.replaceOutbox(entries);
    }
  }

  while (batches < maxBatches) {
    const now = deps.now();
    const batch = dueEntries(entries, now, batchSize);
    if (batch.length === 0) break;

    const response = await deps.transport.postVisits(batch.map((e) => e.body));
    batches += 1;

    let applied: ApplyResult;
    if (response.kind === "ok") {
      const parsed = SyncResponse.safeParse(response.body);
      if (!parsed.success) {
        // A 200 whose body is not the contract is not success. Treating it as one would
        // silently drop the batch from the queue on the strength of a response nobody
        // could read, so it is a transport failure and the rows stay.
        applied = applyBatchFailure(
          entries,
          batch,
          { disposition: "retry", reason: "the server's reply did not match the sync contract" },
          now,
          policy,
          random,
        );
      } else {
        applied = applySyncResults(entries, batch, parsed.data.results, now, policy, random);
      }
    } else {
      applied = applyBatchFailure(entries, batch, classifyTransportOutcome(response), now, policy, random);
    }

    entries = applied.entries;
    await deps.store.replaceOutbox(entries);

    accepted.push(...applied.accepted);
    rejected.push(...applied.rejected);
    retrying.push(...applied.retrying);
    reauthenticate = reauthenticate || applied.reauthenticate;
    if (applied.stopped !== null) {
      stopped = applied.stopped;
      break;
    }
    // A 401 stops the loop too: every further batch would draw the same answer, and
    // burning the queue's attempt counts against an expired token is how a session
    // refresh turns into a backed-off queue that looks broken.
    if (applied.reauthenticate) break;
    // Nothing accepted and nothing retried means no progress is available this pass.
    if (applied.accepted.length === 0 && applied.rejected.length === 0 && applied.retrying.length === 0) break;
  }

  return {
    batches,
    accepted,
    rejected,
    retrying,
    stopped,
    reauthenticate,
    remaining: entries.filter((e: OutboxEntry) => e.state === "pending").length,
  };
}
