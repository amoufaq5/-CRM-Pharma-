import { SYNC_BATCH_MAX, SyncResponse, type DisbursementBody, type SignatureBody, type VisitBody } from "./api.js";
import {
  applyBatchFailure,
  applySyncResults,
  dueEntries,
  rejectOrphanedDependents,
  rejectUnreconcilable,
  reviveDue,
  DEFAULT_BACKOFF,
  type ApplyResult,
  type BackoffPolicy,
  type OutboxEntry,
  type OutboxKind,
} from "./outbox.js";
import { classifyTransportOutcome } from "./outcome.js";
import type { ClientStore } from "./store.js";

/**
 * The drain loop: read the queue, send one batch per kind in order, fold each answer back.
 *
 * Impure only through what is injected. `transport` returns a tagged result rather than
 * throwing, because "the network is gone" is the NORMAL case for this client and an
 * exception is the wrong shape for a normal case.
 *
 * THE ORDER OF KINDS IS LOAD-BEARING. A signature's upload route answers 404 until its
 * disbursement row exists, and a 404 is permanent — so signatures go last, and in the same
 * pass: a disbursement accepted at the top of the drain leaves the queue, which is what
 * `dueEntries` reads as "its dependency is satisfied". A rep who signed at a clinic desk
 * with no signal gets both halves in one reconnection.
 */
export type TransportResult =
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | { readonly kind: "status"; readonly status: number; readonly problemKind?: string | undefined; readonly detail?: string | undefined }
  | { readonly kind: "network"; readonly detail?: string | undefined };

export interface SyncTransport {
  postVisits(visits: readonly VisitBody[]): Promise<TransportResult>;
  postDisbursements(disbursements: readonly DisbursementBody[]): Promise<TransportResult>;
  /** One at a time: the route takes one signature for one disbursement. */
  putSignature(disbursementId: string, body: SignatureBody): Promise<TransportResult>;
}

export interface SyncDeps {
  readonly store: ClientStore;
  readonly transport: SyncTransport;
  readonly now: () => number;
  readonly random?: () => number;
  readonly backoff?: BackoffPolicy;
  /** Batch size for the batched kinds, capped at the server's maximum however large. */
  readonly batchSize?: number;
  /** Safety valve on the loop, not on the queue: how many requests one call may send. */
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

/** How many of each kind may ride in one request. */
const BATCH_MAX: Readonly<Record<OutboxKind, number>> = {
  visit: SYNC_BATCH_MAX,
  disbursement: SYNC_BATCH_MAX,
  // The signature route takes one signature for one disbursement, so a "batch" is one.
  signature: 1,
};

/** Dependencies last, so one drain can land a disbursement and then its signature. */
const SEND_ORDER: readonly OutboxKind[] = ["visit", "disbursement", "signature"];

/**
 * A single-item route's answer, in the per-row shape the fold already understands.
 *
 * Normalising here rather than in the transport keeps every decision in the tested layer:
 * the transport reports what HTTP said, and what that means for a queued row is decided
 * once, in `classifyRowOutcome`, for all three kinds.
 */
function rowsFromSingle(entry: OutboxEntry, result: TransportResult):
  | { readonly rows: readonly { id: string; ok: boolean; type?: string; error?: string }[] }
  | { readonly failure: TransportResult } {
  if (result.kind === "ok") return { rows: [{ id: entry.id, ok: true }] };
  if (result.kind === "network") return { failure: result };
  // A status refusal IS about this row — it is the only row in the request — so it becomes
  // a per-row verdict rather than a batch failure, and the classifier decides whether it
  // is permanent. A 401 or a tenant_deleted still reaches the queue-wide dispositions
  // through the same path.
  return {
    rows: [
      {
        id: entry.id,
        ok: false,
        ...(result.problemKind !== undefined ? { type: result.problemKind } : {}),
        ...(result.detail !== undefined ? { error: result.detail } : {}),
      },
    ],
  };
}

export async function syncOnce(deps: SyncDeps): Promise<SyncReport> {
  const random = deps.random ?? Math.random;
  const policy = deps.backoff ?? DEFAULT_BACKOFF;
  const maxBatches = deps.maxBatches ?? 25;

  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const retrying: string[] = [];
  let stopped: { reason: string } | null = null;
  let reauthenticate = false;
  let batches = 0;

  let entries = await deps.store.readOutbox();

  // Before anything is sent: rows that can never be reconciled, and rows whose
  // prerequisite has already been refused, are refused here — visibly — rather than sent
  // forever and reported nowhere.
  const screened = rejectUnreconcilable(entries);
  const orphaned = rejectOrphanedDependents(screened.entries);
  if (screened.refused.length > 0 || orphaned.refused.length > 0) {
    entries = orphaned.entries;
    await deps.store.replaceOutbox(entries);
    for (const id of screened.refused) {
      rejected.push({ id, reason: entries.find((e) => e.id === id)?.lastReason ?? "unreconcilable queue entry" });
    }
    rejected.push(...orphaned.refused.map((r) => ({ id: r.id, reason: r.reason })));
  }

  if (deps.revive === true) {
    const revived = reviveDue(entries, deps.now());
    if (revived.some((e, i) => e !== entries[i])) {
      entries = revived;
      await deps.store.replaceOutbox(entries);
    }
  }

  for (const kind of SEND_ORDER) {
    while (batches < maxBatches) {
      const now = deps.now();
      const limit = Math.min(deps.batchSize ?? SYNC_BATCH_MAX, BATCH_MAX[kind]);
      const batch = dueEntries(entries, now, limit, kind);
      if (batch.length === 0) break;

      let applied: ApplyResult;
      if (kind === "signature") {
        // Narrowed, not cast. `dueEntries` filtered by kind so the cast would have been
        // correct today — and a future kind with a dependency would have made it quietly
        // wrong, sending someone else's body to the signature route.
        const entry = batch[0];
        if (entry === undefined || entry.kind !== "signature") {
          throw new Error(`the signature pass was handed a ${entry?.kind ?? "missing"} entry`);
        }
        const result = await deps.transport.putSignature(entry.dependsOn, entry.body);
        batches += 1;
        const normalised = rowsFromSingle(entry, result);
        applied =
          "failure" in normalised
            ? applyBatchFailure(entries, batch, classifyTransportOutcome(normalised.failure as { kind: "network" }), now, policy, random)
            : applySyncResults(entries, batch, normalised.rows, now, policy, random);
      } else {
        const bodies = batch.map((e) => e.body);
        const result =
          kind === "visit"
            ? await deps.transport.postVisits(bodies as readonly VisitBody[])
            : await deps.transport.postDisbursements(bodies as readonly DisbursementBody[]);
        batches += 1;

        if (result.kind === "ok") {
          const parsed = SyncResponse.safeParse(result.body);
          applied = parsed.success
            ? applySyncResults(entries, batch, parsed.data.results, now, policy, random)
            : // A 200 whose body is not the contract is not success. Treating it as one
              // would silently drop the batch from the queue on the strength of a response
              // nobody could read, so it is a transport failure and the rows stay.
              applyBatchFailure(
                entries,
                batch,
                { disposition: "retry", reason: "the server's reply did not match the sync contract" },
                now,
                policy,
                random,
              );
        } else {
          applied = applyBatchFailure(entries, batch, classifyTransportOutcome(result), now, policy, random);
        }
      }

      entries = applied.entries;
      await deps.store.replaceOutbox(entries);

      accepted.push(...applied.accepted);
      rejected.push(...applied.rejected);
      retrying.push(...applied.retrying);
      reauthenticate = reauthenticate || applied.reauthenticate;

      // A refusal that condemns a prerequisite condemns what waits on it, in the same
      // pass: otherwise a signature whose disbursement was just refused stays pending
      // until the next drain, counted as "waiting to send" on a screen that is wrong.
      if (applied.rejected.length > 0) {
        const cascade = rejectOrphanedDependents(entries);
        if (cascade.refused.length > 0) {
          entries = cascade.entries;
          await deps.store.replaceOutbox(entries);
          rejected.push(...cascade.refused.map((r) => ({ id: r.id, reason: r.reason })));
        }
      }

      if (applied.stopped !== null) {
        stopped = applied.stopped;
        break;
      }
      // A 401 stops the loop too: every further request would draw the same answer, and
      // burning the queue's attempt counts against an expired token is how a session
      // refresh turns into a backed-off queue that looks broken.
      if (applied.reauthenticate) break;
      if (applied.accepted.length === 0 && applied.rejected.length === 0 && applied.retrying.length === 0) break;
    }
    if (stopped !== null || reauthenticate) break;
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
