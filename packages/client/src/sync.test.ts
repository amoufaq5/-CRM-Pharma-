import { describe, expect, it } from "vitest";

import type { DisbursementBody, SignatureBody, VisitBody } from "./api.js";
import { DEFAULT_BACKOFF, enqueueDisbursement, enqueueSignature, enqueueVisit, type OutboxEntry } from "./outbox.js";
import type { CachedReference, ClientStore } from "./store.js";
import { syncOnce, type SyncTransport, type TransportResult } from "./sync.js";

/** A store in memory: the whole reason `ClientStore` is an interface with no storage. */
function memoryStore(entries: readonly OutboxEntry[] = []): ClientStore & { entries: readonly OutboxEntry[]; writes: number } {
  const state = {
    entries,
    writes: 0,
    readOutbox: async (): Promise<readonly OutboxEntry[]> => state.entries,
    replaceOutbox: async (next: readonly OutboxEntry[]): Promise<void> => {
      state.entries = next;
      state.writes += 1;
    },
    readCache: async (): Promise<CachedReference | null> => null,
    writeCache: async (): Promise<void> => undefined,
  };
  return state;
}

/**
 * One recorder for all three routes, because the engine's job is to call the right one in
 * the right order and the test has to be able to see which it called.
 */
function recordingTransport(answers: readonly TransportResult[]): SyncTransport & {
  batches: VisitBody[][];
  disbursementBatches: DisbursementBody[][];
  signatures: { disbursementId: string; body: SignatureBody }[];
  calls: string[];
} {
  const batches: VisitBody[][] = [];
  const disbursementBatches: DisbursementBody[][] = [];
  const signatures: { disbursementId: string; body: SignatureBody }[] = [];
  const calls: string[] = [];
  let i = 0;
  const next = (): TransportResult => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return answer ?? { kind: "network" };
  };
  return {
    batches,
    disbursementBatches,
    signatures,
    calls,
    postVisits: async (visits) => {
      batches.push([...visits]);
      calls.push("visits");
      return next();
    },
    postDisbursements: async (disbursements) => {
      disbursementBatches.push([...disbursements]);
      calls.push("disbursements");
      return next();
    },
    putSignature: async (disbursementId, body) => {
      signatures.push({ disbursementId, body });
      calls.push(`signature:${disbursementId}`);
      return next();
    },
  };
}

const ok = (ids: readonly string[], rejected: readonly { id: string; type: string; error?: string }[] = []): TransportResult => ({
  kind: "ok",
  status: 200,
  body: {
    accepted: ids.length,
    rejected: rejected.length,
    results: [...ids.map((id) => ({ id, ok: true })), ...rejected.map((r) => ({ id: r.id, ok: false, type: r.type, error: r.error }))],
  },
});

const body = (id: string): VisitBody => ({ id, erpAccountId: "ACC-1" });

const queue = (ids: readonly string[], now = 1000): readonly OutboxEntry[] =>
  ids.reduce<readonly OutboxEntry[]>((acc, id) => enqueueVisit(acc, body(id), now), []);

describe("syncOnce", () => {
  const now = (): number => 10_000;

  it("drains a queue and empties it", async () => {
    const store = memoryStore(queue(["a", "b"]));
    const transport = recordingTransport([ok(["a", "b"])]);
    const report = await syncOnce({ store, transport, now });

    expect(report.accepted).toEqual(["a", "b"]);
    expect(report.remaining).toBe(0);
    expect(store.entries).toEqual([]);
    expect(transport.batches).toHaveLength(1);
  });

  it("does nothing when nothing is due, and writes nothing", async () => {
    // A write per idle tick would churn IndexedDB on every foreground poll.
    const store = memoryStore(queue(["a"]).map((e) => ({ ...e, nextAttemptAt: 9_999_999 })));
    const transport = recordingTransport([ok([])]);
    const report = await syncOnce({ store, transport, now });
    expect(report.batches).toBe(0);
    expect(store.writes).toBe(0);
    expect(transport.batches).toEqual([]);
  });

  it("sends more than one batch when the queue is longer than the cap", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `v${String(i).padStart(3, "0")}`);
    const store = memoryStore(queue(ids));
    const transport = recordingTransport([ok(ids.slice(0, 200)), ok(ids.slice(200))]);
    const report = await syncOnce({ store, transport, now });

    expect(transport.batches.map((b) => b.length)).toEqual([200, 5]);
    expect(report.accepted).toHaveLength(205);
    expect(store.entries).toEqual([]);
  });

  it("keeps every row when the network is gone", async () => {
    const store = memoryStore(queue(["a", "b"]));
    const transport = recordingTransport([{ kind: "network" }]);
    const report = await syncOnce({ store, transport, now, random: () => 0.5 });

    expect(report.accepted).toEqual([]);
    expect(report.retrying).toEqual(["a", "b"]);
    expect(report.remaining).toBe(2);
    expect(store.entries.every((e) => e.state === "pending" && e.attempts === 1)).toBe(true);
    // One batch, then the loop stops: the rows it would send next are no longer due.
    expect(transport.batches).toHaveLength(1);
  });

  it("stops the loop the moment the tenant is gone, without sending another batch", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `v${i}`);
    const store = memoryStore(queue(ids));
    const transport = recordingTransport([
      { kind: "status", status: 403, problemKind: "tenant_deleted", detail: "deleted in the ERP" },
    ]);
    const report = await syncOnce({ store, transport, now });

    expect(report.stopped).toEqual({ reason: "deleted in the ERP" });
    expect(transport.batches).toHaveLength(1);
    expect(store.entries.every((e) => e.state === "blocked")).toBe(true);
  });

  it("stops the loop on a 401 rather than burning the queue's attempts", async () => {
    const store = memoryStore(queue(["a", "b", "c"]));
    const transport = recordingTransport([{ kind: "status", status: 401 }]);
    const report = await syncOnce({ store, transport, now });

    expect(report.reauthenticate).toBe(true);
    expect(transport.batches).toHaveLength(1);
    expect(store.entries.every((e) => e.attempts === 0)).toBe(true);
  });

  it("separates the rejected from the accepted inside one batch", async () => {
    const store = memoryStore(queue(["a", "b", "c"]));
    const transport = recordingTransport([
      ok(["a"], [
        { id: "b", type: "outside_territory", error: "not your account" },
        { id: "c", type: "internal", error: "boom" },
      ]),
      ok(["c"]),
    ]);
    const report = await syncOnce({ store, transport, now, random: () => 0.5 });

    expect(report.accepted).toEqual(["a"]);
    expect(report.rejected).toEqual([{ id: "b", reason: "not your account" }]);
    expect(report.retrying).toEqual(["c"]);
    // `c` is backed off, so the second batch is never sent in this pass.
    expect(transport.batches).toHaveLength(1);
    expect(store.entries.map((e) => [e.id, e.state])).toEqual([
      ["b", "rejected"],
      ["c", "pending"],
    ]);
  });

  it("REFUSES A 200 THAT IS NOT THE CONTRACT, and keeps the rows", async () => {
    // The dangerous shape: a proxy or a captive portal answering 200 with HTML. Reading
    // that as success would drop the batch from the queue on the strength of a reply
    // nobody could parse.
    const store = memoryStore(queue(["a"]));
    const transport = recordingTransport([{ kind: "ok", status: 200, body: { hello: "portal" } }]);
    const report = await syncOnce({ store, transport, now, random: () => 0.5 });

    expect(report.accepted).toEqual([]);
    expect(report.retrying).toEqual(["a"]);
    expect(report.remaining).toBe(1);
    expect(store.entries[0]?.lastReason).toMatch(/did not match the sync contract/);
  });

  it("honours maxBatches so one call cannot spin", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `v${String(i).padStart(4, "0")}`);
    const store = memoryStore(queue(ids));
    // Every batch succeeds, so without a limit this would send five.
    const transport = recordingTransport([ok(ids)]);
    const report = await syncOnce({ store, transport, now, maxBatches: 2 });
    expect(report.batches).toBe(2);
    expect(transport.batches).toHaveLength(2);
  });

  it("writes the queue after every batch, not only at the end", async () => {
    // A tab closed mid-drain must not re-send what the server already took.
    const ids = Array.from({ length: 205 }, (_, i) => `v${String(i).padStart(3, "0")}`);
    const store = memoryStore(queue(ids));
    const transport = recordingTransport([ok(ids.slice(0, 200)), ok(ids.slice(200))]);
    await syncOnce({ store, transport, now });
    expect(store.writes).toBe(2);
  });

  it("sends a backed-off row when asked to revive, and does not when it is not", async () => {
    // The two callers that set `revive` are the `online` event and the Sync now button.
    // Both know something the backoff cannot: the condition that caused it is gone.
    const backedOff = queue(["a"]).map((e) => ({ ...e, attempts: 3, nextAttemptAt: 9_000_000 }));

    const quiet = memoryStore(backedOff);
    const quietTransport = recordingTransport([ok(["a"])]);
    const quietReport = await syncOnce({ store: quiet, transport: quietTransport, now });
    expect(quietTransport.batches).toEqual([]);
    expect(quietReport.remaining).toBe(1);

    const revived = memoryStore(backedOff);
    const revivedTransport = recordingTransport([ok(["a"])]);
    const revivedReport = await syncOnce({ store: revived, transport: revivedTransport, now, revive: true });
    expect(revivedTransport.batches).toHaveLength(1);
    expect(revivedReport.accepted).toEqual(["a"]);
  });

  it("does not write the queue when reviving changes nothing", async () => {
    const store = memoryStore(queue(["a"]));
    const transport = recordingTransport([ok(["a"])]);
    await syncOnce({ store, transport, now, revive: true });
    // One write, for the drain — not two.
    expect(store.writes).toBe(1);
  });

  it("uses the injected backoff policy", async () => {
    const store = memoryStore(queue(["a"]));
    const transport = recordingTransport([{ kind: "network" }]);
    await syncOnce({
      store,
      transport,
      now,
      random: () => 0.5,
      backoff: { ...DEFAULT_BACKOFF, baseMs: 1000, jitter: 0 },
    });
    expect(store.entries[0]?.nextAttemptAt).toBe(11_000);
  });
});

describe("syncOnce with samples", () => {
  const now = (): number => 10_000;

  const disbursementBody = (id: string): DisbursementBody => ({
    id,
    lotId: "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e",
    quantity: "2",
    occurredAt: "2026-10-08T09:00:00.000Z",
    erpAccountId: "ACC-1",
    recipientName: "Dr Ada",
    signatureSha256: "b".repeat(64),
  });

  const signatureBody = (id: string): SignatureBody => ({ id, contentType: "image/png", contentBase64: "aGk=" });

  const bothQueued = (now = 1000): readonly OutboxEntry[] => {
    const withDisbursement = enqueueDisbursement([], disbursementBody("d1"), now);
    return enqueueSignature(withDisbursement, signatureBody("s1"), "d1", now);
  };

  it("sends the disbursement FIRST and then its signature, in one drain", async () => {
    // The whole point of the send order: a rep who signed at a clinic desk with no signal
    // gets both halves on one reconnection, because the disbursement leaving the queue is
    // what makes the signature due.
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([ok(["d1"]), { kind: "ok", status: 201, body: { id: "s1" } }]);
    const report = await syncOnce({ store, transport, now });

    expect(transport.calls).toEqual(["disbursements", "signature:d1"]);
    expect(transport.disbursementBatches[0]?.map((d) => d.id)).toEqual(["d1"]);
    expect(transport.signatures[0]).toMatchObject({ disbursementId: "d1", body: { id: "s1" } });
    expect(report.accepted).toEqual(["d1", "s1"]);
    expect(store.entries).toEqual([]);
  });

  it("does not attempt the signature when the disbursement could not be sent", async () => {
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([{ kind: "network" }]);
    const report = await syncOnce({ store, transport, now, random: () => 0.5 });

    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.retrying).toEqual(["d1"]);
    expect(report.remaining).toBe(2);
  });

  it("REFUSES THE SIGNATURE in the same pass when its disbursement is refused", async () => {
    // Not next time: a signature left pending behind a refused disbursement is counted as
    // "waiting to send" on a screen that is telling the rep something false.
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([ok([], [{ id: "d1", type: "lot_expired", error: "lot LOT-1 expired" }])]);
    const report = await syncOnce({ store, transport, now });

    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.rejected.map((r) => r.id).sort()).toEqual(["d1", "s1"]);
    expect(report.rejected.find((r) => r.id === "s1")?.reason).toContain("lot LOT-1 expired");
    expect(store.entries.map((e) => e.state)).toEqual(["rejected", "rejected"]);
  });

  it("treats a refusal of the signature itself as that row's own verdict", async () => {
    // One row per request, so a 409 is about this signature — `signature_mismatch` says
    // the bytes do not hash to what the ledger committed, and re-sending them can never
    // work.
    const store = memoryStore([...enqueueSignature([], signatureBody("s1"), "d1", 1000)]);
    const transport = recordingTransport([
      { kind: "status", status: 409, problemKind: "signature_mismatch", detail: "the stored image does not match the committed digest" },
    ]);
    const report = await syncOnce({ store, transport, now });

    expect(report.rejected).toEqual([{ id: "s1", reason: "the stored image does not match the committed digest" }]);
    expect(store.entries[0]?.state).toBe("rejected");
  });

  it("sends signatures one at a time, because the route takes one", async () => {
    let queue = enqueueSignature([], signatureBody("s1"), "d1", 1000);
    queue = enqueueSignature(queue, signatureBody("s2"), "d2", 1001);
    const store = memoryStore(queue);
    const transport = recordingTransport([
      { kind: "ok", status: 201, body: {} },
      { kind: "ok", status: 201, body: {} },
    ]);
    const report = await syncOnce({ store, transport, now });

    expect(transport.signatures.map((s) => s.body.id)).toEqual(["s1", "s2"]);
    expect(transport.calls).toEqual(["signature:d1", "signature:d2"]);
    expect(report.accepted).toEqual(["s1", "s2"]);
  });

  it("drains visits before disbursements before signatures", async () => {
    let queue = enqueueSignature(
      enqueueDisbursement(enqueueVisit([], body("v1"), 1000), disbursementBody("d1"), 1000),
      signatureBody("s1"),
      "d1",
      1000,
    );
    queue = [...queue];
    const store = memoryStore(queue);
    const transport = recordingTransport([ok(["v1"]), ok(["d1"]), { kind: "ok", status: 201, body: {} }]);
    await syncOnce({ store, transport, now });
    expect(transport.calls).toEqual(["visits", "disbursements", "signature:d1"]);
  });

  it("stops the whole drain on a deleted tenant, before reaching later kinds", async () => {
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([
      { kind: "status", status: 403, problemKind: "tenant_deleted", detail: "deleted in the ERP" },
    ]);
    const report = await syncOnce({ store, transport, now });
    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.stopped).toEqual({ reason: "deleted in the ERP" });
    expect(store.entries.every((e) => e.state === "blocked")).toBe(true);
  });
});
