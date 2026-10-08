import { describe, expect, it } from "vitest";

import type { DisbursementBody, VisitBody } from "./api.js";
import {
  DEFAULT_BACKOFF,
  applyBatchFailure,
  applySyncResults,
  backoffMs,
  dueEntries,
  enqueueVisit,
  rejectUnreconcilable,
  reviveDue,
  summariseOutbox,
  enqueueDisbursement,
  enqueueSignature,
  rejectOrphanedDependents,
  type DisbursementEntry,
  type OutboxEntry,
  type SignatureEntry,
  type VisitEntry,
} from "./outbox.js";

const body = (id: string, account = "ACC-1"): VisitBody => ({ id, erpAccountId: account });

/**
 * A visit entry. Typed as `VisitEntry` rather than `OutboxEntry` deliberately: under the
 * union, spreading a partial over a base makes `kind` a union of all three and nothing is
 * assignable to anything. One helper per kind keeps the discriminant pinned.
 */
const entry = (over: Partial<VisitEntry> & { id: string }): VisitEntry => ({
  kind: "visit",
  body: body(over.id),
  state: "pending",
  attempts: 0,
  nextAttemptAt: 0,
  queuedAt: 0,
  ...over,
});

const disbursement = (id: string): DisbursementBody => ({
  id,
  lotId: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e",
  quantity: "2",
  occurredAt: "2026-10-08T09:00:00.000Z",
  erpAccountId: "ACC-1",
  recipientName: "Dr Ada",
  signatureSha256: "a".repeat(64),
});

const disbursementEntry = (over: Partial<DisbursementEntry> & { id: string }): DisbursementEntry => ({
  kind: "disbursement",
  body: disbursement(over.id),
  state: "pending",
  attempts: 0,
  nextAttemptAt: 0,
  queuedAt: 0,
  ...over,
});

const signatureEntry = (
  over: Partial<SignatureEntry> & { id: string; dependsOn: string },
): SignatureEntry => ({
  kind: "signature",
  body: { id: over.id, contentType: "image/png", contentBase64: "aGk=" },
  state: "pending",
  attempts: 0,
  nextAttemptAt: 0,
  queuedAt: 0,
  ...over,
});

describe("enqueueVisit", () => {
  it("adds a visit and makes it due immediately", () => {
    const out = enqueueVisit([], body("a"), 1000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", state: "pending", attempts: 0, nextAttemptAt: 1000, queuedAt: 1000 });
  });

  it("REPLACES the entry for a visit already queued, rather than queuing it twice", () => {
    // One queue slot per visit: the id is the record id, the server upserts by it, and a
    // rep correcting a visit before it syncs must not file two call reports.
    const first = enqueueVisit([], body("a", "ACC-1"), 1000);
    const second = enqueueVisit(first, body("a", "ACC-2"), 5000);
    expect(second).toHaveLength(1);
    const replaced = second[0];
    expect(replaced?.kind).toBe("visit");
    expect(replaced?.kind === "visit" ? replaced.body.erpAccountId : null).toBe("ACC-2");
  });

  it("keeps the original queue time when a row is replaced, and restarts its backoff", () => {
    // Queued-at is how long the rep has been waiting, which an edit does not reset.
    // Attempts are about a body the server has now never seen, which an edit does.
    const first = [entry({ id: "a", attempts: 4, nextAttemptAt: 900_000, queuedAt: 1000, lastReason: "500" })];
    const second = enqueueVisit(first, body("a", "ACC-9"), 60_000);
    expect(second[0]).toMatchObject({ queuedAt: 1000, attempts: 0, nextAttemptAt: 60_000 });
  });
});

describe("dueEntries", () => {
  it("sends the oldest first", () => {
    const entries = [entry({ id: "c", queuedAt: 300 }), entry({ id: "a", queuedAt: 100 }), entry({ id: "b", queuedAt: 200 })];
    expect(dueEntries(entries, 1000).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("holds back a row whose backoff has not elapsed", () => {
    const entries = [entry({ id: "a", nextAttemptAt: 5000 })];
    expect(dueEntries(entries, 4999)).toEqual([]);
    expect(dueEntries(entries, 5000)).toHaveLength(1);
  });

  it("never offers a rejected or blocked row", () => {
    const entries = [entry({ id: "a", state: "rejected" }), entry({ id: "b", state: "blocked" })];
    expect(dueEntries(entries, 10_000)).toEqual([]);
  });

  it("caps at the server's batch maximum even when asked for more", () => {
    // `z.array(VisitBody).max(200)` refuses a 201-row body WHOLE, so a queue that sent
    // everything it had after a fortnight offline would never drain. The cap is the
    // client's problem to respect.
    const entries = Array.from({ length: 250 }, (_, i) => entry({ id: `v${i}`, queuedAt: i }));
    expect(dueEntries(entries, 1, 1000)).toHaveLength(200);
    expect(dueEntries(entries, 1, 10)).toHaveLength(10);
  });

  it("orders deterministically when two rows were queued in the same millisecond", () => {
    const entries = [entry({ id: "b", queuedAt: 5 }), entry({ id: "a", queuedAt: 5 })];
    expect(dueEntries(entries, 10).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("backoffMs", () => {
  const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };

  it("doubles per attempt and stops at the ceiling", () => {
    expect(backoffMs(1, noJitter, () => 0.5)).toBe(15_000);
    expect(backoffMs(2, noJitter, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, noJitter, () => 0.5)).toBe(60_000);
    expect(backoffMs(20, noJitter, () => 0.5)).toBe(noJitter.maxMs);
  });

  it("spreads a van of devices that regained signal together", () => {
    const low = backoffMs(3, DEFAULT_BACKOFF, () => 0);
    const high = backoffMs(3, DEFAULT_BACKOFF, () => 1);
    expect(low).toBeLessThan(high);
    expect(high - low).toBeCloseTo(60_000 * DEFAULT_BACKOFF.jitter, -2);
  });
});

describe("applySyncResults", () => {
  const now = 1_000_000;
  const half = (): number => 0.5;

  it("removes an accepted row from the queue", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const out = applySyncResults(entries, entries, [{ id: "a", ok: true }, { id: "b", ok: true }], now, DEFAULT_BACKOFF, half);
    expect(out.entries).toEqual([]);
    expect(out.accepted).toEqual(["a", "b"]);
  });

  it("keeps a permanently rejected row, visible, rather than dropping it", () => {
    // A refused visit is still a visit that happened. Dropping it loses the rep's work
    // silently; keeping it pending loops forever. It stays, as `rejected`, for a human.
    const entries = [entry({ id: "a" })];
    const out = applySyncResults(entries, entries, [{ id: "a", ok: false, type: "outside_territory", error: "not your account" }], now, DEFAULT_BACKOFF, half);
    expect(out.entries[0]).toMatchObject({ state: "rejected", attempts: 1, lastReason: "not your account", lastType: "outside_territory" });
    expect(out.rejected).toEqual([{ id: "a", reason: "not your account" }]);
  });

  it("backs off a transient refusal and leaves it pending", () => {
    const entries = [entry({ id: "a" })];
    const out = applySyncResults(entries, entries, [{ id: "a", ok: false, type: "internal" }], now, { ...DEFAULT_BACKOFF, jitter: 0 }, half);
    expect(out.entries[0]).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: now + 15_000 });
    expect(out.retrying).toEqual(["a"]);
  });

  it("BLOCKS THE WHOLE QUEUE when one row says the tenant is deleted", () => {
    // Not just the row that drew it: every other pending row is bound for the same dead
    // tenant. This is the behaviour `tenant_deleted` was given its own problem type for.
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c", state: "rejected" })];
    const out = applySyncResults(entries, [entries[0]!], [{ id: "a", ok: false, type: "tenant_deleted", error: "gone" }], now, DEFAULT_BACKOFF, half);
    expect(out.stopped).toEqual({ reason: "gone" });
    expect(out.entries.filter((e) => e.state === "blocked").map((e) => e.id)).toEqual(["a", "b"]);
    // An already-rejected row is not re-labelled: it failed for its own reason.
    expect(out.entries.find((e) => e.id === "c")?.state).toBe("rejected");
  });

  it("does not spend an attempt on a row refused for an expired session", () => {
    const entries = [entry({ id: "a", attempts: 2 })];
    const out = applySyncResults(entries, entries, [{ id: "a", ok: false, type: "unauthenticated" }], now, DEFAULT_BACKOFF, half);
    expect(out.reauthenticate).toBe(true);
    expect(out.entries[0]).toMatchObject({ state: "pending", attempts: 2, nextAttemptAt: now });
  });

  it("leaves a row the response never mentioned exactly as it was", () => {
    // The server answers every row it is sent, so a missing id means a truncated reply or
    // a client bug. Keeping the row is the safe half of that choice.
    const entries = [entry({ id: "a" }), entry({ id: "b", attempts: 3, nextAttemptAt: 42 })];
    const out = applySyncResults(entries, entries, [{ id: "a", ok: true }], now, DEFAULT_BACKOFF, half);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ id: "b", attempts: 3, nextAttemptAt: 42 });
  });

  it("ignores a verdict for a row that was not in this batch", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const out = applySyncResults(entries, [entries[0]!], [{ id: "a", ok: true }, { id: "b", ok: false, type: "validation_failed" }], now, DEFAULT_BACKOFF, half);
    expect(out.entries.map((e) => e.id)).toEqual(["b"]);
    expect(out.entries[0]?.state).toBe("pending");
  });
});

describe("applyBatchFailure", () => {
  const now = 2_000_000;

  it("keeps every row and backs them all off when the network drops", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const out = applyBatchFailure(entries, entries, { disposition: "retry", reason: "offline" }, now, { ...DEFAULT_BACKOFF, jitter: 0 }, () => 0.5);
    expect(out.accepted).toEqual([]);
    expect(out.entries.every((e) => e.state === "pending" && e.nextAttemptAt === now + 15_000)).toBe(true);
    expect(out.retrying).toEqual(["a", "b"]);
  });

  it("blocks everything when the batch is refused because the tenant is gone", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const out = applyBatchFailure(entries, entries, { disposition: "stop", reason: "tenant deleted" }, now);
    expect(out.entries.every((e) => e.state === "blocked")).toBe(true);
    expect(out.stopped).toEqual({ reason: "tenant deleted" });
  });

  it("does not touch rows that were not in the batch", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b", nextAttemptAt: 99 })];
    const out = applyBatchFailure(entries, [entries[0]!], { disposition: "retry", reason: "offline" }, now);
    expect(out.entries.find((e) => e.id === "b")?.nextAttemptAt).toBe(99);
  });
});

describe("reviveDue", () => {
  it("voids the backoff on pending rows, because the reason for it has changed", () => {
    // The live run found this: a rep regains signal, presses Sync now, and nothing
    // happens for up to half an hour because the row is mid-backoff.
    const entries = [entry({ id: "a", nextAttemptAt: 900_000, attempts: 4 })];
    const out = reviveDue(entries, 1000);
    expect(out[0]).toMatchObject({ nextAttemptAt: 1000, state: "pending" });
  });

  it("keeps the attempt count, which is history rather than a timer", () => {
    expect(reviveDue([entry({ id: "a", nextAttemptAt: 900_000, attempts: 7 })], 1000)[0]?.attempts).toBe(7);
  });

  it("does NOT revive a rejected or blocked row", () => {
    // Those are not waiting on a network; reviving them is the infinite loop the
    // classifier exists to prevent.
    const entries = [entry({ id: "a", state: "rejected", nextAttemptAt: 900_000 }), entry({ id: "b", state: "blocked", nextAttemptAt: 900_000 })];
    expect(reviveDue(entries, 1000).map((e) => e.nextAttemptAt)).toEqual([900_000, 900_000]);
  });

  it("leaves a row that is already due untouched, so nothing is rewritten for nothing", () => {
    const already = entry({ id: "a", nextAttemptAt: 500 });
    expect(reviveDue([already], 1000)[0]).toBe(already);
  });
});

describe("summariseOutbox", () => {
  it("answers 'has my day gone in yet?'", () => {
    const entries = [
      entry({ id: "a", queuedAt: 10 }),
      entry({ id: "b", nextAttemptAt: 9_000_000, queuedAt: 20 }),
      entry({ id: "c", state: "rejected", queuedAt: 30 }),
      entry({ id: "d", state: "blocked", queuedAt: 40 }),
    ];
    expect(summariseOutbox(entries, 1000)).toEqual({ pending: 2, rejected: 1, blocked: 1, dueNow: 1, oldestQueuedAt: 10 });
  });

  it("has no oldest when there is nothing queued", () => {
    expect(summariseOutbox([], 1000).oldestQueuedAt).toBeNull();
  });
});

describe("rejectUnreconcilable", () => {
  it("refuses a pending entry whose key is not its own visit id", () => {
    // Such a row is immortal: the server echoes the body's id, this folds on the entry's
    // key, they never meet, and it is re-sent forever while being reported nowhere.
    const bad = entry({ id: "key-a", body: body("different-b") });
    const out = rejectUnreconcilable([bad]);
    expect(out.refused).toEqual(["key-a"]);
    expect(out.entries[0]?.state).toBe("rejected");
    expect(out.entries[0]?.lastReason).toContain("must match");
  });

  it("leaves a well-formed entry exactly as it is", () => {
    const good = entry({ id: "a" });
    const out = rejectUnreconcilable([good]);
    expect(out.refused).toEqual([]);
    expect(out.entries[0]).toBe(good);
  });

  it("does not re-judge a row that is already rejected or blocked", () => {
    const entries = [
      entry({ id: "a", state: "rejected", body: body("b") }),
      entry({ id: "c", state: "blocked", body: body("d") }),
    ];
    expect(rejectUnreconcilable(entries).refused).toEqual([]);
  });

  it("cannot be produced by enqueueVisit, which is the point", () => {
    const out = enqueueVisit([], body("x"), 1);
    expect(out[0]?.id).toBe(out[0]?.body.id);
    expect(rejectUnreconcilable(out).refused).toEqual([]);
  });
});

describe("dependencies", () => {
  it("holds a signature back while its disbursement is still queued", () => {
    // `POST /v1/samples/disbursements/:id/signature` answers 404 until that row exists,
    // and a 404 is permanent. A signature sent early would be refused forever for a
    // reason that was only ever about timing.
    const entries = [disbursementEntry({ id: "d1" }), signatureEntry({ id: "s1", dependsOn: "d1" })];
    expect(dueEntries(entries, 1000).map((e) => e.id)).toEqual(["d1"]);
    expect(dueEntries(entries, 1000, 200, "signature")).toEqual([]);
  });

  it("releases the signature once the disbursement has left the queue", () => {
    // Absence IS acceptance: the queue is this device's whole memory of what is unsent, so
    // a row that is gone is a row the server took — and that reading survives a restart
    // where a flag would not.
    const entries = [signatureEntry({ id: "s1", dependsOn: "d1" })];
    expect(dueEntries(entries, 1000).map((e) => e.id)).toEqual(["s1"]);
  });

  it("does not release a signature whose disbursement is merely backed off", () => {
    const entries = [
      disbursementEntry({ id: "d1", nextAttemptAt: 9_000_000, attempts: 2 }),
      signatureEntry({ id: "s1", dependsOn: "d1" }),
    ];
    expect(dueEntries(entries, 1000)).toEqual([]);
  });

  it("enqueueSignature records which disbursement it belongs to", () => {
    const queued = enqueueSignature([], { id: "s1", contentType: "image/png", contentBase64: "aGk=" }, "d1", 500);
    expect(queued[0]).toMatchObject({ kind: "signature", dependsOn: "d1", state: "pending", queuedAt: 500 });
  });

  it("queues a disbursement like any other record, keyed by its own id", () => {
    const queued = enqueueDisbursement([], disbursement("d1"), 500);
    expect(queued[0]).toMatchObject({ kind: "disbursement", id: "d1", state: "pending" });
    expect(queued[0]?.id).toBe(queued[0]?.body.id);
  });
});

describe("rejectOrphanedDependents", () => {
  it("REFUSES a signature whose disbursement was refused, naming the cause", () => {
    // Otherwise it is the immortal row in another costume: never sent (its dependency is
    // still in the queue), never reported, and counted as "waiting to send" on a screen
    // telling a rep their day has not gone in yet.
    const entries = [
      disbursementEntry({ id: "d1", state: "rejected", lastReason: "lot LOT-1 expired on 2026-09-01" }),
      signatureEntry({ id: "s1", dependsOn: "d1" }),
    ];
    const out = rejectOrphanedDependents(entries);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]?.id).toBe("s1");
    expect(out.refused[0]?.reason).toContain("the disbursement it belongs to was refused");
    expect(out.refused[0]?.reason).toContain("lot LOT-1 expired");
    expect(out.entries.find((e) => e.id === "s1")?.state).toBe("rejected");
  });

  it("blocks a signature whose disbursement is blocked, rather than rejecting it", () => {
    // A blocked queue is a deleted tenant, not a bad row: the distinction is what tells a
    // rep whether anything can ever be done about it.
    const entries = [
      disbursementEntry({ id: "d1", state: "blocked", lastReason: "tenant deleted" }),
      signatureEntry({ id: "s1", dependsOn: "d1" }),
    ];
    const out = rejectOrphanedDependents(entries);
    expect(out.entries.find((e) => e.id === "s1")?.state).toBe("blocked");
  });

  it("leaves a signature alone while its disbursement is still pending", () => {
    const entries = [disbursementEntry({ id: "d1" }), signatureEntry({ id: "s1", dependsOn: "d1" })];
    expect(rejectOrphanedDependents(entries).refused).toEqual([]);
  });

  it("leaves a signature alone when its disbursement has already been accepted", () => {
    // Gone from the queue is the success case, and it must not be read as a missing
    // prerequisite — that would refuse the signature at the exact moment it became
    // sendable.
    const entries = [signatureEntry({ id: "s1", dependsOn: "d1" })];
    expect(rejectOrphanedDependents(entries).refused).toEqual([]);
    expect(rejectOrphanedDependents(entries).entries[0]?.state).toBe("pending");
  });
});
