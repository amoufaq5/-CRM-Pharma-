import {
  SYNC_BATCH_MAX,
  SyncResponse,
  type AcceptBody,
  type CountBody,
  type CountLineBody,
  type DisbursementBody,
  type RecallBody,
  type SignatureBody,
  type TransferBody,
  type VisitBody,
} from "./api.js";
import {
  applyBatchFailure,
  applySyncResults,
  dueEntries,
  rejectOrphanedDependents,
  rejectUnreconcilable,
  reviveDue,
  splitByAuthor,
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
  /**
   * The three transfer routes, each taking one movement.
   *
   * There is no `/v1/sync/transfers` to batch into, and that is the server's shape rather
   * than an omission here: a transfer, an acceptance and a recall each answer 201 with the
   * ledger row they wrote. So a batch is one, as it is for a signature.
   */
  postTransfer(body: TransferBody): Promise<TransportResult>;
  postAcceptance(transferId: string, body: AcceptBody): Promise<TransportResult>;
  postRecall(transferId: string, body: RecallBody): Promise<TransportResult>;
  /**
   * The count document, its lines and its commit — three routes for one act.
   *
   * The commit takes no body: which count to commit is in the path, and what it answers
   * (how many adjustments it wrote) is the finding rather than an acknowledgement.
   */
  postCount(body: CountBody): Promise<TransportResult>;
  postCountLine(countId: string, body: CountLineBody): Promise<TransportResult>;
  postCountCommit(countId: string): Promise<TransportResult>;
  /** Abandoning a count — a rep's only exit from one whose line was refused. 204. */
  postCountCancel(countId: string): Promise<TransportResult>;
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
  /**
   * The signed-in rep, and the only author whose rows this call may send.
   *
   * Required, not optional: a drain that does not know who is signed in cannot tell its
   * own rows from a colleague's, and the route it posts to attributes whatever it sends to
   * the token's rep. `splitByAuthor` has the whole argument.
   */
  readonly repProfileId: string;
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
  /**
   * Pending rows recorded by somebody else on this device, which were not sent.
   *
   * Reported rather than silently skipped: a rep looking at "3 waiting to send" that never
   * moves deserves to be told why, and the reason is that they are not that rep's to send.
   */
  readonly heldForOthers: number;
}

/**
 * How each kind is sent, in one table instead of a chain of special cases.
 *
 * It started as `if (kind === "signature")` around a cast, which was fine for one
 * single-item route and would have become four of them. The table makes the two things
 * that vary per kind — how many rows may ride in one request, and which route they go to —
 * declarations rather than control flow, and `Record<OutboxKind, …>` means the compiler
 * refuses a new kind that nobody taught the engine to send.
 *
 * `reply` is the other axis: a batched route answers with a per-row verdict for everything
 * it was handed, while a single-item route answers 201 or a problem document about the one
 * row. Normalising the second into the first (`rowsFromSingle`) keeps every disposition
 * decision in `classifyRowOutcome`, for all six kinds.
 */
export interface KindPlan {
  readonly batchMax: number;
  readonly reply: "per_row" | "single";
  readonly send: (batch: readonly OutboxEntry[], transport: SyncTransport) => Promise<TransportResult>;
}

/**
 * Narrow a single-item batch to its kind, or throw.
 *
 * `dueEntries` filtered by kind, so this cannot fail today — which is exactly why it is a
 * check and not a cast. A wrong `SEND_ORDER` or a future kind sharing a plan would
 * otherwise post one kind's body to another kind's route and be told, correctly, that it
 * is malformed.
 */
function only<K extends OutboxKind>(
  batch: readonly OutboxEntry[],
  kind: K,
): Extract<OutboxEntry, { kind: K }> {
  const entry = batch[0];
  if (entry === undefined || entry.kind !== kind) {
    throw new Error(`the ${kind} pass was handed a ${entry?.kind ?? "missing"} entry`);
  }
  return entry as Extract<OutboxEntry, { kind: K }>;
}

/** The same check for a batched kind: every row, narrowed, or a throw. */
function allOf<K extends OutboxKind>(
  batch: readonly OutboxEntry[],
  kind: K,
): readonly Extract<OutboxEntry, { kind: K }>[] {
  return batch.map((entry) => {
    if (entry.kind !== kind) {
      throw new Error(`the ${kind} pass was handed a ${entry.kind} entry`);
    }
    return entry as Extract<OutboxEntry, { kind: K }>;
  });
}

/**
 * The first row of a batch the caller has already established is non-empty.
 *
 * `batch[0]` is `T | undefined` under `noUncheckedIndexedAccess`, and the honest ways to
 * discharge that are a throw or a branch that cannot be taken. A throw says what would
 * have to be wrong for it to happen.
 */
function firstOf(batch: readonly OutboxEntry[]): OutboxEntry {
  const entry = batch[0];
  if (entry === undefined) throw new Error("a batch reported non-empty had no first entry");
  return entry;
}

export const SEND_PLANS: Readonly<Record<OutboxKind, KindPlan>> = {
  visit: {
    batchMax: SYNC_BATCH_MAX,
    reply: "per_row",
    send: (batch, transport) => transport.postVisits(allOf(batch, "visit").map((e) => e.body)),
  },
  disbursement: {
    batchMax: SYNC_BATCH_MAX,
    reply: "per_row",
    send: (batch, transport) =>
      transport.postDisbursements(allOf(batch, "disbursement").map((e) => e.body)),
  },
  // The signature route takes one signature for one disbursement, so a "batch" is one.
  signature: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => {
      const entry = only(batch, "signature");
      return transport.putSignature(entry.disbursementOf, entry.body);
    },
  },
  transfer: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => transport.postTransfer(only(batch, "transfer").body),
  },
  acceptance: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => {
      const entry = only(batch, "acceptance");
      return transport.postAcceptance(entry.transferOf, entry.body);
    },
  },
  recall: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => {
      const entry = only(batch, "recall");
      return transport.postRecall(entry.transferOf, entry.body);
    },
  },
  count: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => transport.postCount(only(batch, "count").body),
  },
  count_line: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => {
      const entry = only(batch, "count_line");
      return transport.postCountLine(entry.countOf, entry.body);
    },
  },
  count_commit: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => transport.postCountCommit(only(batch, "count_commit").countOf),
  },
  count_cancel: {
    batchMax: 1,
    reply: "single",
    send: (batch, transport) => transport.postCountCancel(only(batch, "count_cancel").countOf),
  },
};

/**
 * Dependencies last, so one drain can land a disbursement and then its signature, and a
 * transfer and then the recall that takes it back.
 */
const SEND_ORDER: readonly OutboxKind[] = [
  "visit",
  "disbursement",
  "signature",
  "transfer",
  "acceptance",
  "recall",
  // The count trio in document order. The dependencies are what actually enforce it —
  // order alone would let a commit past a line that failed and backed off — but sending
  // them in this order is what lands a whole count on one reconnection.
  "count",
  "count_line",
  "count_commit",
  // Last, and after the commit, so that a drain carrying both a finished count and an
  // abandoned one settles each the way it was meant: nothing a cancel touches is still
  // queued by the time it is sent, because queueing it discarded those rows.
  "count_cancel",
];

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
    const plan = SEND_PLANS[kind];
    while (batches < maxBatches) {
      const now = deps.now();
      const limit = Math.min(deps.batchSize ?? SYNC_BATCH_MAX, plan.batchMax);
      // Only this rep's rows are candidates. Everything else on the device is held, and
      // reported as held rather than counted as waiting.
      const batch = dueEntries(splitByAuthor(entries, deps.repProfileId).mine, now, limit, kind);
      if (batch.length === 0) break;

      const result = await plan.send(batch, deps.transport);
      batches += 1;

      let applied: ApplyResult;
      if (plan.reply === "single") {
        const normalised = rowsFromSingle(firstOf(batch), result);
        applied =
          "failure" in normalised
            ? applyBatchFailure(entries, batch, classifyTransportOutcome(normalised.failure as { kind: "network" }), now, policy, random)
            : applySyncResults(entries, batch, normalised.rows, now, policy, random);
      } else if (result.kind === "ok") {
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

  // Counted from the final queue, so "remaining" is what is left to SEND and the held
  // rows are named separately. One number covering both would be the screen saying a
  // rep's day has not gone in when there is nothing they can do about it.
  const { mine, held } = splitByAuthor(entries, deps.repProfileId);

  return {
    batches,
    accepted,
    rejected,
    retrying,
    stopped,
    reauthenticate,
    remaining: mine.filter((e: OutboxEntry) => e.state === "pending").length,
    heldForOthers: held.filter((e: OutboxEntry) => e.state === "pending").length,
  };
}
