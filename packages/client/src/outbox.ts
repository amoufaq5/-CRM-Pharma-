import type { VisitBody } from "./api.js";
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

export interface OutboxEntry {
  readonly id: string;
  readonly kind: "visit";
  readonly body: VisitBody;
  readonly state: OutboxState;
  /** How many times this row has been SENT, not how many batches it rode in. */
  readonly attempts: number;
  /** Epoch ms. A pending entry is due when this is in the past. */
  readonly nextAttemptAt: number;
  readonly queuedAt: number;
  readonly lastReason?: string;
  readonly lastType?: string;
}

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

export function enqueueVisit(
  entries: readonly OutboxEntry[],
  body: VisitBody,
  now: number,
): readonly OutboxEntry[] {
  const existing = entries.find((e) => e.id === body.id);
  const entry: OutboxEntry = {
    id: body.id,
    kind: "visit",
    body,
    state: "pending",
    // A re-queued row starts its backoff over: the body changed, so the previous
    // refusal was about something that no longer exists.
    attempts: 0,
    nextAttemptAt: now,
    queuedAt: existing?.queuedAt ?? now,
  };
  return existing === undefined ? [...entries, entry] : entries.map((e) => (e.id === body.id ? entry : e));
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
): readonly OutboxEntry[] {
  return entries
    .filter((e) => e.state === "pending" && e.nextAttemptAt <= now)
    .slice()
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, Math.min(limit, SYNC_BATCH_MAX)));
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
    if (entry.state !== "pending" || entry.body.id === entry.id) return entry;
    refused.push(entry.id);
    return {
      ...entry,
      state: "rejected" as const,
      lastReason: `this device stored a queue entry keyed ${entry.id} holding a visit with id ${entry.body.id}; the two must match or the server's answer can never be matched to it`,
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
