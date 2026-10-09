import type {
  AcceptBody,
  CountBody,
  CountLineBody,
  WriteOffBody,
  DisbursementBody,
  RecallBody,
  SignatureBody,
  TransferBody,
  VisitBody,
} from "./api.js";
import { SYNC_BATCH_MAX } from "./api.js";
import { classifyRowOutcome, type Disposition, type RowOutcome } from "./outcome.js";

/**
 * The outbox, as a pure function of its entries.
 *
 * A rep records a visit in a lift with no signal; the row has to survive the app being
 * killed, the device rebooting, and a fortnight of no network, and then has to land
 * exactly once. Every bit of that is state, and state in a UI is where offline clients
 * go wrong — so the transitions live here, with no storage and no clock of their own, and
 * the IndexedDB adapter is reduced to "save these entries".
 *
 * The entry id IS the record id, which is the device-minted visit id. One queue slot per
 * visit, so editing an unsent visit replaces its body rather than enqueuing a second
 * write — and a replay collapses onto the same server row either way.
 */
export const OUTBOX_STATES = ["pending", "rejected", "blocked"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/**
 * The kinds, in the order they must be SENT.
 *
 * Not alphabetical and not arbitrary: a signature's upload route 404s until its
 * disbursement exists, so signatures go last — and in the same pass, because a
 * disbursement accepted at the top of a drain leaves the queue and unblocks its signature
 * before the loop reaches it. A rep who signed at a clinic desk with no signal gets both
 * halves in one reconnection rather than two.
 *
 * A recall comes after a transfer for the same reason, and it is the only other pair with
 * a dependency: `POST /v1/samples/transfers/:id/recall` cannot find a transfer the server
 * has not been told about. An ACCEPTANCE has no dependency at all, because the transfer it
 * settles was sent from somebody else's device and is already on the server by the time
 * this rep can see it — which is why an acceptance carries the transfer's id without
 * waiting for it.
 */
export const OUTBOX_KINDS = [
  "visit",
  "disbursement",
  "signature",
  "transfer",
  "acceptance",
  "recall",
  "count",
  "count_line",
  "count_commit",
  "count_cancel",
  "write_off",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

interface OutboxEntryBase {
  readonly id: string;
  readonly state: OutboxState;
  /** How many times this row has been SENT, not how many batches it rode in. */
  readonly attempts: number;
  /** Epoch ms. A pending entry is due when this is in the past. */
  readonly nextAttemptAt: number;
  readonly queuedAt: number;
  readonly lastReason?: string;
  readonly lastType?: string;
  /**
   * Entry ids that must all be ACCEPTED before this one can be sent.
   *
   * "Accepted" is read as "no longer in the queue", which is the only definition that
   * survives a restart: the queue is the whole of this device's memory, so a row that left
   * it is a row the server took.
   *
   * A LIST because a count made it one. A signature waits for its disbursement and a
   * recall for its transfer — one parent each — but a count's COMMIT must wait for the
   * count and for every line in it, or it commits a document with some of its findings
   * missing: adjustments written for the lots that arrived, and the rest never reconciled.
   * Order alone cannot express that, because a line that fails and backs off leaves the
   * kind's pass empty and the commit would sail past it.
   */
  readonly dependsOn?: readonly string[];
  /**
   * The rep this row was recorded by, from `/v1/me` at the moment it was queued.
   *
   * THE QUEUE IS PER DEVICE AND THE RECORD IS PER PERSON, and those are not the same
   * thing. Every write route attributes the record to the CALLER — the rep in the token,
   * never anything in the body — so a second rep signing in on a shared device would have
   * sent the first rep's unsent visits and sample disbursements under their own name. For
   * a drug-sample hand-over that is a false custody record with a real person's name on
   * it, and nothing downstream could ever tell.
   *
   * So a row names its author and the engine sends only rows whose author is signed in.
   * Rows belonging to anybody else are HELD — not sent, not deleted, and visible — because
   * the two safe-looking alternatives are both wrong: sending them misattributes somebody's
   * work, and dropping them destroys a record a regulator may ask for.
   *
   * Optional only because a row written before this field existed has none, and such a row
   * is held for the same reason: a device that cannot say whose a record is must not guess.
   */
  readonly createdBy?: string;
}

export interface VisitEntry extends OutboxEntryBase {
  readonly kind: "visit";
  readonly body: VisitBody;
}

export interface DisbursementEntry extends OutboxEntryBase {
  readonly kind: "disbursement";
  readonly body: DisbursementBody;
}

export interface SignatureEntry extends OutboxEntryBase {
  readonly kind: "signature";
  readonly body: SignatureBody;
  /**
   * The disbursement this signature belongs to — the id in the route's PATH.
   *
   * Its own field rather than a second use of `dependsOn`, which is what it was. The two
   * happened to be the same id and so the dependency doubled as the path parameter; that
   * is an accident, not a reason, and the accident only held because every dependent had
   * exactly one parent. A count's commit has several.
   */
  readonly disbursementOf: string;
  /** Always set, to the disbursement: the upload route 404s until that row exists. */
  readonly dependsOn: readonly string[];
}

export interface TransferEntry extends OutboxEntryBase {
  readonly kind: "transfer";
  readonly body: TransferBody;
}

/**
 * An acceptance of a transfer somebody else sent.
 *
 * `transferOf` is the path parameter, and it is NOT `dependsOn`: the transfer was recorded
 * on the sender's device and reached this one through `GET /v1/samples/transfers/incoming`,
 * so it already exists on the server. Making it a dependency would have been a lie this
 * queue could never satisfy — nothing in this device's outbox will ever land it.
 */
export interface AcceptanceEntry extends OutboxEntryBase {
  readonly kind: "acceptance";
  readonly body: AcceptBody;
  readonly transferOf: string;
}

/**
 * A recall of a transfer this rep sent.
 *
 * Carries the id as `transferOf` like an acceptance, and MAY also carry it as `dependsOn` —
 * when the transfer is still in this device's own queue, because it was sent offline and
 * recalled before it ever reached the server. The screen prefers discarding an unsent
 * transfer outright in that case, which is cheaper and leaves no ledger rows at all; the
 * dependency is here so that a recall queued behind an unsent transfer waits for it rather
 * than drawing a 404 that is only ever about timing.
 */
export interface RecallEntry extends OutboxEntryBase {
  readonly kind: "recall";
  readonly body: RecallBody;
  readonly transferOf: string;
}

/**
 * A count: the document, its lines, and the commit that closes it.
 *
 * Three kinds for one act, because the server is three routes — and that is the right
 * shape rather than an awkward one: the open establishes the id the lines are addressed
 * to, each line is independently refusable (a lot that has since been written off), and
 * the commit is the moment the ledger moves. What the device adds is that all three are
 * recorded at once, where the stock is, and drain in order whenever a signal returns.
 */
export interface CountEntry extends OutboxEntryBase {
  readonly kind: "count";
  readonly body: CountBody;
}

export interface CountLineEntry extends OutboxEntryBase {
  readonly kind: "count_line";
  readonly body: CountLineBody;
  /** The count this line belongs to — the id in the route's path. */
  readonly countOf: string;
  /** The count itself: a line for a count the server has never heard of is refused. */
  readonly dependsOn: readonly string[];
}

export interface CountCommitEntry extends OutboxEntryBase {
  readonly kind: "count_commit";
  /** The route takes no body: which count to commit is in the path. */
  readonly body: Record<string, never>;
  readonly countOf: string;
  /** The count AND every line in it. This is why `dependsOn` is a list. */
  readonly dependsOn: readonly string[];
}

/**
 * Abandoning a count, which is a rep's only way out of one.
 *
 * It exists because a count whose LINE was refused permanently stays open on the server,
 * and `uq_sample_count_one_open` then refuses every count that rep tries afterwards.
 * Without a cancel that works offline, a rep in that state has no action left that does:
 * the commit will not go (its line is refused), a new count will not open, and the only
 * screen that could fix it is one they may not reach for days.
 *
 * Depends on the count only when the count is still unsent here — the same rule as a
 * recall's — because a cancel of a count the server has never seen is a 404 about timing.
 */
export interface CountCancelEntry extends OutboxEntryBase {
  readonly kind: "count_cancel";
  readonly body: Record<string, never>;
  readonly countOf: string;
}

/**
 * Material leaving custody for good: destroyed, or written off because it expired.
 *
 * No dependency and no second half. It is the simplest kind in this queue and the most
 * consequential: a row that says regulated material no longer exists, carrying the only
 * record of why. The server's `reason` is required for that reason, and the form refuses an
 * empty one at the keyboard rather than queueing something the server must reject.
 */
export interface WriteOffEntry extends OutboxEntryBase {
  readonly kind: "write_off";
  readonly body: WriteOffBody;
}

export type OutboxEntry =
  | VisitEntry
  | DisbursementEntry
  | SignatureEntry
  | TransferEntry
  | AcceptanceEntry
  | RecallEntry
  | CountEntry
  | CountLineEntry
  | CountCommitEntry
  | CountCancelEntry
  | WriteOffEntry;

export interface BackoffPolicy {
  /** First delay, doubled per attempt. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** 0 to 1; the fraction of the delay that is randomised. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 15_000, maxMs: 30 * 60_000, jitter: 0.2 };

/**
 * Exponential with jitter, and the jitter is not decoration: a van of reps regaining
 * signal in the same tunnel would otherwise retry in lockstep forever. `random` is
 * injected so a test can see the bare curve.
 */
export function backoffMs(attempts: number, policy: BackoffPolicy, random: () => number): number {
  const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempts - 1));
  const spread = raw * policy.jitter;
  return Math.round(raw - spread / 2 + random() * spread);
}

/**
 * Queue one record, keyed by its own id.
 *
 * One slot per record, whatever the kind: the entry id IS the record id, the server
 * upserts by it, and editing something unsent replaces its body rather than queuing a
 * second write of the same thing.
 */
export function enqueue(
  entries: readonly OutboxEntry[],
  next: NewOutboxEntry,
  now: number,
): readonly OutboxEntry[] {
  const existing = entries.find((e) => e.id === next.id);
  const entry = {
    ...next,
    state: "pending" as const,
    // A re-queued row starts its backoff over: the body changed, so the previous refusal
    // was about something that no longer exists.
    attempts: 0,
    nextAttemptAt: now,
    queuedAt: existing?.queuedAt ?? now,
  } as OutboxEntry;
  return existing === undefined ? [...entries, entry] : entries.map((e) => (e.id === next.id ? entry : e));
}

/** The fields `enqueue` sets itself, so a caller supplies only the record. */
type OutboxEntryStatus = Pick<OutboxEntryBase, "state" | "attempts" | "nextAttemptAt" | "queuedAt">;

export type NewOutboxEntry =
  | Omit<VisitEntry, keyof OutboxEntryStatus>
  | Omit<DisbursementEntry, keyof OutboxEntryStatus>
  | Omit<SignatureEntry, keyof OutboxEntryStatus>
  | Omit<TransferEntry, keyof OutboxEntryStatus>
  | Omit<AcceptanceEntry, keyof OutboxEntryStatus>
  | Omit<RecallEntry, keyof OutboxEntryStatus>
  | Omit<CountEntry, keyof OutboxEntryStatus>
  | Omit<CountLineEntry, keyof OutboxEntryStatus>
  | Omit<CountCommitEntry, keyof OutboxEntryStatus>
  | Omit<CountCancelEntry, keyof OutboxEntryStatus>
  | Omit<WriteOffEntry, keyof OutboxEntryStatus>;

/**
 * Every helper takes the rep, and takes it as a REQUIRED option rather than an optional
 * field, so that adding a kind cannot quietly produce rows nobody can attribute. The
 * compiler is the thing enforcing it: a new call site that forgets does not build.
 */
export interface Attribution {
  /** `/v1/me`'s `repProfileId` for the signed-in rep. */
  readonly createdBy: string;
}

export function enqueueVisit(
  entries: readonly OutboxEntry[],
  body: VisitBody,
  now: number,
  opts: Attribution,
): readonly OutboxEntry[] {
  return enqueue(entries, { id: body.id, kind: "visit", body, createdBy: opts.createdBy }, now);
}

export function enqueueDisbursement(
  entries: readonly OutboxEntry[],
  body: DisbursementBody,
  now: number,
  opts: Attribution,
): readonly OutboxEntry[] {
  return enqueue(entries, { id: body.id, kind: "disbursement", body, createdBy: opts.createdBy }, now);
}

/**
 * A signature, which cannot be sent until its disbursement has been.
 *
 * `dependsOn` is the disbursement's id rather than a flag, because the ORDER is the
 * contract: `POST /v1/samples/disbursements/:id/signature` answers 404 while that row does
 * not exist, and a 404 is permanent — a signature sent too early would be refused forever
 * for a reason that was only ever about timing.
 */
export function enqueueSignature(
  entries: readonly OutboxEntry[],
  body: SignatureBody,
  now: number,
  opts: Attribution & { readonly disbursementId: string },
): readonly OutboxEntry[] {
  return enqueue(
    entries,
    {
      id: body.id,
      kind: "signature",
      body,
      disbursementOf: opts.disbursementId,
      dependsOn: [opts.disbursementId],
      createdBy: opts.createdBy,
    },
    now,
  );
}

/** Material leaving this rep. Nothing depends on it until a recall does. */
export function enqueueTransfer(
  entries: readonly OutboxEntry[],
  body: TransferBody,
  now: number,
  opts: Attribution,
): readonly OutboxEntry[] {
  return enqueue(entries, { id: body.id, kind: "transfer", body, createdBy: opts.createdBy }, now);
}

/**
 * Accepting material somebody else sent.
 *
 * No `dependsOn`: the transfer is already on the server — it is how this device heard of
 * it — so waiting would be waiting for a row that will never be in this queue.
 */
export function enqueueAcceptance(
  entries: readonly OutboxEntry[],
  body: AcceptBody,
  now: number,
  opts: Attribution & { readonly transferOf: string },
): readonly OutboxEntry[] {
  return enqueue(
    entries,
    { id: body.id, kind: "acceptance", body, transferOf: opts.transferOf, createdBy: opts.createdBy },
    now,
  );
}

/**
 * Taking back material nobody accepted.
 *
 * `dependsOn` is set only when the transfer is still unsent on this device, which is the
 * one case where the recall would otherwise race its own prerequisite and draw a permanent
 * 404 for a reason that was only ever about order.
 */
export function enqueueRecall(
  entries: readonly OutboxEntry[],
  body: RecallBody,
  now: number,
  opts: Attribution & { readonly transferOf: string; readonly transferUnsent?: boolean },
): readonly OutboxEntry[] {
  return enqueue(
    entries,
    {
      id: body.id,
      kind: "recall",
      body,
      transferOf: opts.transferOf,
      createdBy: opts.createdBy,
      ...(opts.transferUnsent === true ? { dependsOn: [opts.transferOf] } : {}),
    },
    now,
  );
}

/**
 * The key a count line is stored under: one slot per (count, lot).
 *
 * Deliberately not a fresh uuid. The server's line has no id of its own — its identity is
 * `(count_id, lot_id)`, a UNIQUE constraint and an upsert — so a rep who recounts a lot
 * must REPLACE the figure rather than queue a second line for the same shelf. Keying the
 * queue the way the server keys the row is what makes that automatic.
 */
export function countLineKey(countId: string, lotId: string): string {
  return `${countId}:${lotId}`;
}

/** The count document itself. Its lines and its commit both wait for this. */
export function enqueueCount(
  entries: readonly OutboxEntry[],
  body: CountBody,
  now: number,
  opts: Attribution,
): readonly OutboxEntry[] {
  return enqueue(entries, { id: body.id, kind: "count", body, createdBy: opts.createdBy }, now);
}

export function enqueueCountLine(
  entries: readonly OutboxEntry[],
  body: CountLineBody,
  now: number,
  opts: Attribution & { readonly countOf: string },
): readonly OutboxEntry[] {
  return enqueue(
    entries,
    {
      id: countLineKey(opts.countOf, body.lotId),
      kind: "count_line",
      body,
      countOf: opts.countOf,
      dependsOn: [opts.countOf],
      createdBy: opts.createdBy,
    },
    now,
  );
}

/**
 * The commit, which waits for the count and for every line.
 *
 * `lineIds` is taken from the caller rather than derived from the queue, because the queue
 * at commit time is the only moment the document is complete: the rep has finished
 * counting, and nothing else will be added. Deriving it later — from whatever happens to
 * be queued when the commit becomes due — would let a line refused in the meantime
 * silently drop out of the wait.
 */
export function enqueueCountCommit(
  entries: readonly OutboxEntry[],
  now: number,
  opts: Attribution & { readonly id: string; readonly countOf: string; readonly lineIds: readonly string[] },
): readonly OutboxEntry[] {
  return enqueue(
    entries,
    {
      id: opts.id,
      kind: "count_commit",
      body: {},
      countOf: opts.countOf,
      dependsOn: [opts.countOf, ...opts.lineIds],
      createdBy: opts.createdBy,
    },
    now,
  );
}

/** Material out of custody. Keyed by its own id, like every other movement. */
export function enqueueWriteOff(
  entries: readonly OutboxEntry[],
  body: WriteOffBody,
  now: number,
  opts: Attribution,
): readonly OutboxEntry[] {
  return enqueue(entries, { id: body.id, kind: "write_off", body, createdBy: opts.createdBy }, now);
}

/**
 * Everything this device still holds for one count: the document, its lines, its commit.
 *
 * Used by both ways out of a count, which are deliberately different things. A count that
 * never left this device is DISCARDED — the server has never heard of it, so there is
 * nothing to cancel and no ledger rows either way. A count the server already holds open
 * is CANCELLED, which is a real request, and whatever is still queued for it is moot the
 * moment that request is made.
 */
export function partsOfCount(entries: readonly OutboxEntry[], countId: string): readonly OutboxEntry[] {
  return entries.filter((e) => e.id === countId || ("countOf" in e && e.countOf === countId));
}

/** Drop a count that never left this device, with its lines and its commit. */
export function discardCount(entries: readonly OutboxEntry[], countId: string): readonly OutboxEntry[] {
  const parts = new Set(partsOfCount(entries, countId).map((e) => e.id));
  return entries.filter((e) => !parts.has(e.id));
}

/**
 * Abandon a count the SERVER holds open, dropping anything still queued for it.
 *
 * No dependency: a cancel only makes sense for a count that has already landed, which is
 * what distinguishes it from the discard above.
 */
export function enqueueCountCancel(
  entries: readonly OutboxEntry[],
  now: number,
  opts: Attribution & { readonly id: string; readonly countOf: string },
): readonly OutboxEntry[] {
  return enqueue(
    discardCount(entries, opts.countOf),
    { id: opts.id, kind: "count_cancel", body: {}, countOf: opts.countOf, createdBy: opts.createdBy },
    now,
  );
}

/**
 * The next batch to send: pending, due, oldest first, capped.
 *
 * The cap is the server's (`z.array(VisitBody).max(200)`), and respecting it here is what
 * stops a long-offline queue from deadlocking — a 201-row body is refused whole, so a
 * client that sent everything it had would never drain.
 *
 * `blocked` and `rejected` entries are never due. Blocked means the tenant is gone;
 * rejected means a human has to look.
 */
export function dueEntries(
  entries: readonly OutboxEntry[],
  now: number,
  limit: number = SYNC_BATCH_MAX,
  kind?: OutboxKind,
): readonly OutboxEntry[] {
  // "In the queue" is the whole test for an unsatisfied dependency. A row that has left
  // it was accepted — the queue is this device's entire memory of what is unsent, so
  // absence is acceptance, and that reading survives a restart where a flag would not.
  const present = new Set(entries.map((e) => e.id));
  return entries
    .filter(
      (e) =>
        e.state === "pending" &&
        e.nextAttemptAt <= now &&
        (kind === undefined || e.kind === kind) &&
        // EVERY dependency, not the first: a count's commit waits for the count and for
        // each of its lines, and a commit that went early would write adjustments for the
        // lots that happened to arrive and leave the rest unreconciled.
        (e.dependsOn ?? []).every((id) => !present.has(id)),
    )
    .slice()
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, Math.min(limit, SYNC_BATCH_MAX)));
}

/**
 * Split the queue by who recorded it: what the signed-in rep may send, and what is held.
 *
 * This is the other half of "may this row be sent", and it is not a filter in the engine
 * by accident — it is here, pure and testable, because the failure it prevents is silent.
 * Every write route attributes a record to the caller in the token, so sending another
 * rep's queued row files their visit, or their drug-sample hand-over, under the name of
 * whoever happens to be signed in. Nothing downstream can detect it afterwards: the row
 * is perfectly well-formed and names a real person who did not do it.
 *
 * Held rows are left exactly as they are — pending, with their attempt counts and their
 * backoff intact — so that the rep they belong to can sign back in and send them. Nothing
 * is deleted, because a record of a controlled hand-over is not this app's to throw away,
 * and nothing is rejected, because there is nothing wrong with the row.
 */
export function splitByAuthor(
  entries: readonly OutboxEntry[],
  repProfileId: string,
): { readonly mine: readonly OutboxEntry[]; readonly held: readonly OutboxEntry[] } {
  const mine: OutboxEntry[] = [];
  const held: OutboxEntry[] = [];
  for (const entry of entries) {
    // An unattributed row (written before `createdBy` existed) is held rather than
    // claimed. A device that cannot say whose a record is must not guess, and guessing
    // "the person in front of it" is exactly the mistake this function exists to stop.
    (entry.createdBy === repProfileId ? mine : held).push(entry);
  }
  return { mine, held };
}

/** How many rows are held for somebody else, for a screen that has to say so. */
export function heldForOthers(entries: readonly OutboxEntry[], repProfileId: string): number {
  return splitByAuthor(entries, repProfileId).held.filter((e) => e.state === "pending").length;
}

/**
 * A row whose prerequisite will never land cannot land either, so it is refused now.
 *
 * The alternative is the immortal-row failure in another costume: a signature waiting on a
 * disbursement the server refused would sit pending forever, never sent (its dependency
 * is still in the queue), never reported, and counted as "waiting to send" on a screen
 * that says a rep's day has not gone in yet. One refusal propagates, naming the row it
 * came from, because "your signature could not be filed because the disbursement was
 * refused" is the sentence a person can act on.
 */
export function rejectOrphanedDependents(
  entries: readonly OutboxEntry[],
): { readonly entries: readonly OutboxEntry[]; readonly refused: readonly { readonly id: string; readonly reason: string }[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refused: { id: string; reason: string }[] = [];
  const next = entries.map((entry) => {
    if (entry.state !== "pending") return entry;
    // The FIRST dependency that is in the queue and no longer pending. One is enough to
    // condemn this row, and naming one gives the rep a sentence; listing all of them would
    // give them a paragraph about a document they cannot repair either way.
    const parent = (entry.dependsOn ?? [])
      .map((id) => byId.get(id))
      .find((p) => p !== undefined && p.state !== "pending");
    if (parent === undefined) return entry;
    const reason = `the ${parent.kind} it belongs to was ${parent.state === "blocked" ? "blocked" : "refused"}: ${parent.lastReason ?? "no reason given"}`;
    refused.push({ id: entry.id, reason });
    return { ...entry, state: parent.state, lastReason: reason };
  });
  return { entries: next, refused };
}

export interface ApplyResult {
  readonly entries: readonly OutboxEntry[];
  readonly accepted: readonly string[];
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly retrying: readonly string[];
  /** Set when the tenant is gone: every pending row is blocked and sending must stop. */
  readonly stopped: { readonly reason: string } | null;
  readonly reauthenticate: boolean;
}

/**
 * Fold one batch's per-row verdicts back into the queue.
 *
 * A row the response does not mention stays exactly as it was — pending, same attempt
 * count. The server answers every row it was sent, so a missing id means the response was
 * truncated or the client sent something it did not record, and in both cases keeping the
 * row is the safe half of the choice.
 */
export function applySyncResults(
  entries: readonly OutboxEntry[],
  sent: readonly OutboxEntry[],
  results: readonly { readonly id: string; readonly ok: boolean; readonly type?: string | undefined; readonly error?: string | undefined }[],
  now: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): ApplyResult {
  const byId = new Map(results.map((r) => [r.id, r]));
  const sentIds = new Set(sent.map((e) => e.id));

  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const retrying: string[] = [];
  let stopped: { reason: string } | null = null;
  let reauthenticate = false;

  const next: OutboxEntry[] = [];
  for (const entry of entries) {
    const result = byId.get(entry.id);
    if (result === undefined || !sentIds.has(entry.id)) {
      next.push(entry);
      continue;
    }
    const outcome: RowOutcome = classifyRowOutcome(result);
    const attempts = entry.attempts + 1;
    switch (outcome.disposition satisfies Disposition) {
      case "accepted":
        accepted.push(entry.id);
        continue; // leaves the queue
      case "permanent":
        rejected.push({ id: entry.id, reason: outcome.reason });
        next.push({ ...entry, state: "rejected", attempts, lastReason: outcome.reason, ...(result.type !== undefined ? { lastType: result.type } : {}) });
        continue;
      case "retry":
        retrying.push(entry.id);
        next.push({
          ...entry,
          attempts,
          nextAttemptAt: now + backoffMs(attempts, policy, random),
          lastReason: outcome.reason,
          ...(result.type !== undefined ? { lastType: result.type } : {}),
        });
        continue;
      case "reauthenticate":
        // The row is innocent: a 401 is about the session, so it keeps its attempt count
        // and becomes due immediately — once there is a token again.
        reauthenticate = true;
        next.push({ ...entry, nextAttemptAt: now, lastReason: outcome.reason });
        continue;
      case "stop":
        stopped = { reason: outcome.reason };
        next.push({ ...entry, state: "blocked", attempts, lastReason: outcome.reason });
        continue;
    }
  }

  // One refusal naming the tenant condemns the whole queue, not just the row that drew
  // it: every other pending row is going to the same dead tenant, and spinning on them
  // is exactly what `tenant_deleted` exists to prevent.
  const entriesOut =
    stopped === null
      ? next
      : next.map((e) =>
          e.state === "pending" ? { ...e, state: "blocked" as const, lastReason: stopped?.reason ?? "tenant deleted" } : e,
        );

  return { entries: entriesOut, accepted, rejected, retrying, stopped, reauthenticate };
}

/** A whole-batch failure: nobody is accepted, nobody is rejected, everyone waits. */
export function applyBatchFailure(
  entries: readonly OutboxEntry[],
  sent: readonly OutboxEntry[],
  outcome: RowOutcome,
  now: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): ApplyResult {
  const sentIds = new Set(sent.map((e) => e.id));
  const retrying: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  const next = entries.map((entry) => {
    if (!sentIds.has(entry.id) || entry.state !== "pending") return entry;
    const attempts = entry.attempts + 1;
    if (outcome.disposition === "stop") {
      return { ...entry, state: "blocked" as const, attempts, lastReason: outcome.reason };
    }
    if (outcome.disposition === "permanent") {
      // The BATCH was refused, not this row's content — but re-sending the identical
      // envelope cannot work either, so it waits for a person rather than looping.
      rejected.push({ id: entry.id, reason: outcome.reason });
      return { ...entry, state: "rejected" as const, attempts, lastReason: outcome.reason };
    }
    if (outcome.disposition === "reauthenticate") {
      return { ...entry, lastReason: outcome.reason };
    }
    retrying.push(entry.id);
    return { ...entry, attempts, nextAttemptAt: now + backoffMs(attempts, policy, random), lastReason: outcome.reason };
  });

  return {
    entries: outcome.disposition === "stop" ? next.map((e) => (e.state === "pending" ? { ...e, state: "blocked" as const, lastReason: outcome.reason } : e)) : next,
    accepted: [],
    rejected,
    retrying,
    stopped: outcome.disposition === "stop" ? { reason: outcome.reason } : null,
    reauthenticate: outcome.disposition === "reauthenticate",
  };
}

/**
 * Make every pending row due now, because the reason it was waiting has changed.
 *
 * FOUND BY THE LIVE RUN, and it was a real defect rather than a test artefact. A failed
 * attempt pushes a row 15 seconds out, doubling to half an hour. The rep then regains
 * signal, sees "online", presses Sync now — and NOTHING HAPPENS, silently, for up to
 * thirty minutes, because `dueEntries` correctly answers that nothing is due. A button
 * that does nothing is worse than no button.
 *
 * The backoff answers "the server or the network is unwell, stop hammering it". Both
 * events that call this are new information that the condition has gone: the browser
 * fired `online`, or a person explicitly asked. So the wait is void, and only for rows
 * that are actually waiting on it — `rejected` and `blocked` rows are not backing off,
 * they are refused, and reviving them would be the loop this file exists to prevent.
 *
 * Attempt counts are kept: they are the row's history, not its timer, and clearing them
 * would hide a row that has failed forty times behind a fresh-looking queue.
 */
export function reviveDue(entries: readonly OutboxEntry[], now: number): readonly OutboxEntry[] {
  return entries.map((entry) =>
    entry.state === "pending" && entry.nextAttemptAt > now ? { ...entry, nextAttemptAt: now } : entry,
  );
}

/**
 * An entry whose key is not its own visit id can never be reconciled, so it is refused
 * rather than sent.
 *
 * `enqueueVisit` makes the two the same by construction — the entry id IS the record id —
 * so nothing in this app can produce the mismatch. A store written by an older build, a
 * hand-edited database, or a future entry kind that forgets the rule can: and the failure
 * is the worst-shaped one available. The server echoes the id it was SENT (the body's),
 * `applySyncResults` matches on the entry's key, the two never meet, and the row stays
 * pending forever — sent on every drain, never accepted, never rejected, never reported.
 * An immortal row that costs a request a minute and shows up nowhere.
 *
 * Found by a fixture that made exactly that mistake while testing something else.
 */
export function rejectUnreconcilable(
  entries: readonly OutboxEntry[],
): { readonly entries: readonly OutboxEntry[]; readonly refused: readonly string[] } {
  const refused: string[] = [];
  const next = entries.map((entry) => {
    // Only a body that CARRIES an id can disagree with its key. A count line has none —
    // its identity on the server is (count, lot), which is exactly how this queue keys it —
    // and a commit has no body at all; both are reconciled by the entry's own id, because
    // their routes answer about the one row they were sent.
    const bodyId = "id" in entry.body ? entry.body.id : undefined;
    if (entry.state !== "pending" || bodyId === undefined || bodyId === entry.id) return entry;
    refused.push(entry.id);
    return {
      ...entry,
      state: "rejected" as const,
      lastReason: `this device stored a queue entry keyed ${entry.id} holding a ${entry.kind} with id ${String(bodyId)}; the two must match or the server's answer can never be matched to it`,
    };
  });
  return { entries: next, refused };
}

export interface OutboxSummary {
  readonly pending: number;
  readonly rejected: number;
  readonly blocked: number;
  readonly dueNow: number;
  readonly oldestQueuedAt: number | null;
}

/** What the screen says when a rep asks "has my day gone in yet?". */
export function summariseOutbox(entries: readonly OutboxEntry[], now: number): OutboxSummary {
  const pending = entries.filter((e) => e.state === "pending");
  const oldest = entries.reduce<number | null>((min, e) => (min === null || e.queuedAt < min ? e.queuedAt : min), null);
  return {
    pending: pending.length,
    rejected: entries.filter((e) => e.state === "rejected").length,
    blocked: entries.filter((e) => e.state === "blocked").length,
    dueNow: pending.filter((e) => e.nextAttemptAt <= now).length,
    oldestQueuedAt: oldest,
  };
}

/**
 * Bring a row stored by an older build into the current shape.
 *
 * `dependsOn` used to be a single id, and a signature used it as the route's path
 * parameter as well. A queue written before that changed would otherwise break in two
 * silent ways: `dependsOn.every` is not a function on a string, so every row would look
 * undue forever, and a signature's `disbursementOf` would be undefined, so its upload
 * would go to `/v1/samples/disbursements/undefined/signature`.
 *
 * Applied where the store is read, once, rather than defended against at every use. It is
 * deliberately a named function with a date attached to its reason: when there are no
 * devices left holding a pre-`0056` queue it can be deleted outright, and the way to tell
 * is that this function stops finding anything.
 */
export function normalizeStoredEntry(entry: OutboxEntry): OutboxEntry {
  const raw = entry as OutboxEntry & { dependsOn?: unknown; disbursementOf?: unknown };
  const deps =
    typeof raw.dependsOn === "string"
      ? [raw.dependsOn]
      : Array.isArray(raw.dependsOn)
        ? (raw.dependsOn as readonly string[])
        : undefined;

  if (entry.kind === "signature") {
    const path = typeof raw.disbursementOf === "string" ? raw.disbursementOf : deps?.[0];
    if (path === undefined) return entry;
    return { ...entry, disbursementOf: path, dependsOn: deps ?? [path] };
  }
  if (deps === undefined) {
    // No dependency at all, which is most rows. `dependsOn` is left ABSENT rather than set
    // to an empty array: these are stored as JSON and a key that is not there is cheaper
    // to read back than one holding nothing.
    return entry;
  }
  return { ...entry, dependsOn: deps };
}

/** Every row, normalized. What a store's read hands to the engine. */
export function normalizeStoredOutbox(entries: readonly OutboxEntry[]): readonly OutboxEntry[] {
  return entries.map(normalizeStoredEntry);
}
