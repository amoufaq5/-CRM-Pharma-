import { describe, expect, it } from "vitest";

import type {
  AcceptBody,
  CountBody,
  CountLineBody,
  DisbursementBody,
  RecallBody,
  SignatureBody,
  TransferBody,
  VisitBody,
} from "./api.js";
import {
  DEFAULT_BACKOFF,
  OUTBOX_KINDS,
  countLineKey,
  enqueueAcceptance,
  enqueueCount,
  enqueueCountCancel,
  enqueueCountCommit,
  enqueueCountLine,
  enqueueDisbursement,
  enqueueRecall,
  enqueueSignature,
  enqueueTransfer,
  enqueueVisit,
  type OutboxEntry,
} from "./outbox.js";
import type { CachedReference, ClientStore } from "./store.js";
import { SEND_PLANS, syncOnce, type SyncTransport, type TransportResult } from "./sync.js";

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
  transfers: TransferBody[];
  acceptances: { transferId: string; body: AcceptBody }[];
  recalls: { transferId: string; body: RecallBody }[];
  counts: CountBody[];
  countLines: { countId: string; body: CountLineBody }[];
  commits: string[];
  cancels: string[];
} {
  const batches: VisitBody[][] = [];
  const disbursementBatches: DisbursementBody[][] = [];
  const signatures: { disbursementId: string; body: SignatureBody }[] = [];
  const transfers: TransferBody[] = [];
  const acceptances: { transferId: string; body: AcceptBody }[] = [];
  const recalls: { transferId: string; body: RecallBody }[] = [];
  const counts: CountBody[] = [];
  const countLines: { countId: string; body: CountLineBody }[] = [];
  const commits: string[] = [];
  const cancels: string[] = [];
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
    transfers,
    acceptances,
    recalls,
    counts,
    countLines,
    commits,
    cancels,
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
    postTransfer: async (body) => {
      transfers.push(body);
      calls.push(`transfer:${body.id}`);
      return next();
    },
    postAcceptance: async (transferId, body) => {
      acceptances.push({ transferId, body });
      calls.push(`accept:${transferId}`);
      return next();
    },
    postRecall: async (transferId, body) => {
      recalls.push({ transferId, body });
      calls.push(`recall:${transferId}`);
      return next();
    },
    postCount: async (body) => {
      counts.push(body);
      calls.push(`count:${body.id}`);
      return next();
    },
    postCountLine: async (countId, body) => {
      countLines.push({ countId, body });
      calls.push(`line:${body.lotId}`);
      return next();
    },
    postCountCommit: async (countId) => {
      commits.push(countId);
      calls.push(`commit:${countId}`);
      return next();
    },
    postCountCancel: async (countId) => {
      cancels.push(countId);
      calls.push(`cancel:${countId}`);
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

/** The signed-in rep for every test that is not about who recorded a row. */
const REP = "11111111-1111-4111-8111-111111111111";
const MINE = { createdBy: REP } as const;

/**
 * The engine, with the signed-in rep supplied.
 *
 * A wrapper rather than twenty literals: `repProfileId` is required on `SyncDeps` so that
 * no caller can drain a queue without knowing whose rows it holds, and the tests that are
 * ABOUT that pass their own.
 */
const sync = (deps: Omit<Parameters<typeof syncOnce>[0], "repProfileId"> & { repProfileId?: string }) =>
  syncOnce({ repProfileId: REP, ...deps });

const queue = (ids: readonly string[], now = 1000): readonly OutboxEntry[] =>
  ids.reduce<readonly OutboxEntry[]>((acc, id) => enqueueVisit(acc, body(id), now, MINE), []);

describe("syncOnce", () => {
  const now = (): number => 10_000;

  it("drains a queue and empties it", async () => {
    const store = memoryStore(queue(["a", "b"]));
    const transport = recordingTransport([ok(["a", "b"])]);
    const report = await sync({ store, transport, now });

    expect(report.accepted).toEqual(["a", "b"]);
    expect(report.remaining).toBe(0);
    expect(store.entries).toEqual([]);
    expect(transport.batches).toHaveLength(1);
  });

  it("does nothing when nothing is due, and writes nothing", async () => {
    // A write per idle tick would churn IndexedDB on every foreground poll.
    const store = memoryStore(queue(["a"]).map((e) => ({ ...e, nextAttemptAt: 9_999_999 })));
    const transport = recordingTransport([ok([])]);
    const report = await sync({ store, transport, now });
    expect(report.batches).toBe(0);
    expect(store.writes).toBe(0);
    expect(transport.batches).toEqual([]);
  });

  it("sends more than one batch when the queue is longer than the cap", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `v${String(i).padStart(3, "0")}`);
    const store = memoryStore(queue(ids));
    const transport = recordingTransport([ok(ids.slice(0, 200)), ok(ids.slice(200))]);
    const report = await sync({ store, transport, now });

    expect(transport.batches.map((b) => b.length)).toEqual([200, 5]);
    expect(report.accepted).toHaveLength(205);
    expect(store.entries).toEqual([]);
  });

  it("keeps every row when the network is gone", async () => {
    const store = memoryStore(queue(["a", "b"]));
    const transport = recordingTransport([{ kind: "network" }]);
    const report = await sync({ store, transport, now, random: () => 0.5 });

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
    const report = await sync({ store, transport, now });

    expect(report.stopped).toEqual({ reason: "deleted in the ERP" });
    expect(transport.batches).toHaveLength(1);
    expect(store.entries.every((e) => e.state === "blocked")).toBe(true);
  });

  it("stops the loop on a 401 rather than burning the queue's attempts", async () => {
    const store = memoryStore(queue(["a", "b", "c"]));
    const transport = recordingTransport([{ kind: "status", status: 401 }]);
    const report = await sync({ store, transport, now });

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
    const report = await sync({ store, transport, now, random: () => 0.5 });

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
    const report = await sync({ store, transport, now, random: () => 0.5 });

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
    const report = await sync({ store, transport, now, maxBatches: 2 });
    expect(report.batches).toBe(2);
    expect(transport.batches).toHaveLength(2);
  });

  it("writes the queue after every batch, not only at the end", async () => {
    // A tab closed mid-drain must not re-send what the server already took.
    const ids = Array.from({ length: 205 }, (_, i) => `v${String(i).padStart(3, "0")}`);
    const store = memoryStore(queue(ids));
    const transport = recordingTransport([ok(ids.slice(0, 200)), ok(ids.slice(200))]);
    await sync({ store, transport, now });
    expect(store.writes).toBe(2);
  });

  it("sends a backed-off row when asked to revive, and does not when it is not", async () => {
    // The two callers that set `revive` are the `online` event and the Sync now button.
    // Both know something the backoff cannot: the condition that caused it is gone.
    const backedOff = queue(["a"]).map((e) => ({ ...e, attempts: 3, nextAttemptAt: 9_000_000 }));

    const quiet = memoryStore(backedOff);
    const quietTransport = recordingTransport([ok(["a"])]);
    const quietReport = await sync({ store: quiet, transport: quietTransport, now });
    expect(quietTransport.batches).toEqual([]);
    expect(quietReport.remaining).toBe(1);

    const revived = memoryStore(backedOff);
    const revivedTransport = recordingTransport([ok(["a"])]);
    const revivedReport = await sync({ store: revived, transport: revivedTransport, now, revive: true });
    expect(revivedTransport.batches).toHaveLength(1);
    expect(revivedReport.accepted).toEqual(["a"]);
  });

  it("does not write the queue when reviving changes nothing", async () => {
    const store = memoryStore(queue(["a"]));
    const transport = recordingTransport([ok(["a"])]);
    await sync({ store, transport, now, revive: true });
    // One write, for the drain — not two.
    expect(store.writes).toBe(1);
  });

  it("uses the injected backoff policy", async () => {
    const store = memoryStore(queue(["a"]));
    const transport = recordingTransport([{ kind: "network" }]);
    await sync({
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
    const withDisbursement = enqueueDisbursement([], disbursementBody("d1"), now, MINE);
    return enqueueSignature(withDisbursement, signatureBody("s1"), now, { ...MINE, disbursementId: "d1" });
  };

  it("sends the disbursement FIRST and then its signature, in one drain", async () => {
    // The whole point of the send order: a rep who signed at a clinic desk with no signal
    // gets both halves on one reconnection, because the disbursement leaving the queue is
    // what makes the signature due.
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([ok(["d1"]), { kind: "ok", status: 201, body: { id: "s1" } }]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual(["disbursements", "signature:d1"]);
    expect(transport.disbursementBatches[0]?.map((d) => d.id)).toEqual(["d1"]);
    expect(transport.signatures[0]).toMatchObject({ disbursementId: "d1", body: { id: "s1" } });
    expect(report.accepted).toEqual(["d1", "s1"]);
    expect(store.entries).toEqual([]);
  });

  it("does not attempt the signature when the disbursement could not be sent", async () => {
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([{ kind: "network" }]);
    const report = await sync({ store, transport, now, random: () => 0.5 });

    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.retrying).toEqual(["d1"]);
    expect(report.remaining).toBe(2);
  });

  it("REFUSES THE SIGNATURE in the same pass when its disbursement is refused", async () => {
    // Not next time: a signature left pending behind a refused disbursement is counted as
    // "waiting to send" on a screen that is telling the rep something false.
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([ok([], [{ id: "d1", type: "lot_expired", error: "lot LOT-1 expired" }])]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.rejected.map((r) => r.id).sort()).toEqual(["d1", "s1"]);
    expect(report.rejected.find((r) => r.id === "s1")?.reason).toContain("lot LOT-1 expired");
    expect(store.entries.map((e) => e.state)).toEqual(["rejected", "rejected"]);
  });

  it("treats a refusal of the signature itself as that row's own verdict", async () => {
    // One row per request, so a 409 is about this signature — `signature_mismatch` says
    // the bytes do not hash to what the ledger committed, and re-sending them can never
    // work.
    const store = memoryStore([...enqueueSignature([], signatureBody("s1"), 1000, { ...MINE, disbursementId: "d1" })]);
    const transport = recordingTransport([
      { kind: "status", status: 409, problemKind: "signature_mismatch", detail: "the stored image does not match the committed digest" },
    ]);
    const report = await sync({ store, transport, now });

    expect(report.rejected).toEqual([{ id: "s1", reason: "the stored image does not match the committed digest" }]);
    expect(store.entries[0]?.state).toBe("rejected");
  });

  it("sends signatures one at a time, because the route takes one", async () => {
    let queue = enqueueSignature([], signatureBody("s1"), 1000, { ...MINE, disbursementId: "d1" });
    queue = enqueueSignature(queue, signatureBody("s2"), 1001, { ...MINE, disbursementId: "d2" });
    const store = memoryStore(queue);
    const transport = recordingTransport([
      { kind: "ok", status: 201, body: {} },
      { kind: "ok", status: 201, body: {} },
    ]);
    const report = await sync({ store, transport, now });

    expect(transport.signatures.map((s) => s.body.id)).toEqual(["s1", "s2"]);
    expect(transport.calls).toEqual(["signature:d1", "signature:d2"]);
    expect(report.accepted).toEqual(["s1", "s2"]);
  });

  it("drains visits before disbursements before signatures", async () => {
    let queue = enqueueSignature(
      enqueueDisbursement(enqueueVisit([], body("v1"), 1000, MINE), disbursementBody("d1"), 1000, MINE),
      signatureBody("s1"),
      1000,
      { ...MINE, disbursementId: "d1" },
    );
    queue = [...queue];
    const store = memoryStore(queue);
    const transport = recordingTransport([ok(["v1"]), ok(["d1"]), { kind: "ok", status: 201, body: {} }]);
    await sync({ store, transport, now });
    expect(transport.calls).toEqual(["visits", "disbursements", "signature:d1"]);
  });

  it("stops the whole drain on a deleted tenant, before reaching later kinds", async () => {
    const store = memoryStore(bothQueued());
    const transport = recordingTransport([
      { kind: "status", status: 403, problemKind: "tenant_deleted", detail: "deleted in the ERP" },
    ]);
    const report = await sync({ store, transport, now });
    expect(transport.calls).toEqual(["disbursements"]);
    expect(report.stopped).toEqual({ reason: "deleted in the ERP" });
    expect(store.entries.every((e) => e.state === "blocked")).toBe(true);
  });
});

describe("syncOnce with transfers", () => {
  const now = (): number => 10_000;
  const REP2 = "99999999-9999-4999-8999-999999999999";
  const LOT = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c1e";
  const created = { kind: "ok", status: 201, body: {} } as const satisfies TransportResult;

  const transferBody = (id: string): TransferBody => ({
    id,
    lotId: LOT,
    quantity: "4",
    occurredAt: "2026-10-08T09:00:00.000Z",
    toRepProfileId: REP2,
  });

  const disbursementBodyFor = (id: string): DisbursementBody => ({
    id,
    lotId: LOT,
    quantity: "2",
    occurredAt: "2026-10-08T09:00:00.000Z",
    erpAccountId: "ACC-1",
    recipientName: "Dr Ada",
    signatureSha256: "c".repeat(64),
  });

  it("posts a transfer to its own route, one at a time", async () => {
    const store = memoryStore(enqueueTransfer([], transferBody("t1"), 1000, MINE));
    const transport = recordingTransport([created]);
    const report = await sync({ store, transport, now });

    expect(transport.transfers).toEqual([transferBody("t1")]);
    expect(report.accepted).toEqual(["t1"]);
    expect(store.entries).toEqual([]);
  });

  it("posts an acceptance to the transfer's path, carrying only its own id and clock", async () => {
    // The route reads the lot and the quantity off the transfer. A client that sent them
    // could disagree with what was sent, and the server would refuse it — so the body
    // cannot express the disagreement at all.
    const store = memoryStore(
      enqueueAcceptance([], { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" }, 1000, {
        ...MINE,
        transferOf: "t-from-grace",
      }),
    );
    const transport = recordingTransport([created]);
    await sync({ store, transport, now });

    expect(transport.acceptances).toEqual([
      { transferId: "t-from-grace", body: { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" } },
    ]);
  });

  it("posts a recall to the transfer's path", async () => {
    const store = memoryStore(
      enqueueRecall([], { id: "r1", occurredAt: "2026-10-08T11:00:00.000Z", reason: "wrong colleague" }, 1000, {
        ...MINE,
        transferOf: "t1",
      }),
    );
    const transport = recordingTransport([created]);
    await sync({ store, transport, now });
    expect(transport.recalls[0]?.transferId).toBe("t1");
    expect(transport.recalls[0]?.body.reason).toBe("wrong colleague");
  });

  it("sends a transfer BEFORE the recall that takes it back, in one drain", async () => {
    // Offline all afternoon: the transfer and the change of mind are both on the device,
    // and the recall's route cannot find a transfer the server has not been told about.
    let queue = enqueueTransfer([], transferBody("t1"), 1000, MINE);
    queue = enqueueRecall(queue, { id: "r1", occurredAt: "2026-10-08T11:00:00.000Z" }, 1001, {
      ...MINE,
      transferOf: "t1",
      transferUnsent: true,
    });
    const store = memoryStore(queue);
    const transport = recordingTransport([created, created]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual(["transfer:t1", "recall:t1"]);
    expect(report.accepted).toEqual(["t1", "r1"]);
    expect(store.entries).toEqual([]);
  });

  it("refuses the recall in the same pass when its transfer is refused", async () => {
    let queue = enqueueTransfer([], transferBody("t1"), 1000, MINE);
    queue = enqueueRecall(queue, { id: "r1", occurredAt: "2026-10-08T11:00:00.000Z" }, 1001, {
      ...MINE,
      transferOf: "t1",
      transferUnsent: true,
    });
    const store = memoryStore(queue);
    const transport = recordingTransport([
      { kind: "status", status: 409, problemKind: "insufficient_stock", detail: "rep holds 1.000 of lot LOT-1" },
    ]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual(["transfer:t1"]);
    expect(report.rejected).toEqual([
      { id: "t1", reason: "rep holds 1.000 of lot LOT-1" },
      { id: "r1", reason: "the transfer it belongs to was refused: rep holds 1.000 of lot LOT-1" },
    ]);
  });

  it("drains all six kinds in the declared order", async () => {
    let queue = enqueueVisit([], body("v1"), 1000, MINE);
    queue = enqueueDisbursement(queue, disbursementBodyFor("d1"), 1000, MINE);
    queue = enqueueSignature(queue, { id: "s1", contentType: "image/png", contentBase64: "aGk=" }, 1000, {
      ...MINE,
      disbursementId: "d1",
    });
    queue = enqueueTransfer(queue, transferBody("t1"), 1000, MINE);
    queue = enqueueAcceptance(queue, { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" }, 1000, {
      ...MINE,
      transferOf: "t-from-grace",
    });
    queue = enqueueRecall(queue, { id: "r1", occurredAt: "2026-10-08T11:00:00.000Z" }, 1000, {
      ...MINE,
      transferOf: "t-landed",
    });
    const store = memoryStore(queue);
    const transport = recordingTransport([ok(["v1"]), ok(["d1"]), created, created, created, created]);
    await sync({ store, transport, now });

    expect(transport.calls).toEqual([
      "visits",
      "disbursements",
      "signature:d1",
      "transfer:t1",
      "accept:t-from-grace",
      "recall:t-landed",
    ]);
  });

  it("does NOT send another rep's rows, and says how many it is holding", async () => {
    // The defect this prevents: every write route attributes the record to the caller, so
    // draining a colleague's unsent disbursement under this rep's token files a drug-sample
    // hand-over against the wrong person, with nothing downstream able to tell.
    const store = memoryStore([
      ...enqueueTransfer([], transferBody("mine"), 1000, MINE),
      ...enqueueTransfer([], transferBody("theirs"), 1000, { createdBy: REP2 }),
    ]);
    const transport = recordingTransport([created]);
    const report = await sync({ store, transport, now });

    expect(transport.transfers.map((t) => t.id)).toEqual(["mine"]);
    expect(report.accepted).toEqual(["mine"]);
    expect(report.heldForOthers).toBe(1);
    expect(report.remaining).toBe(0);
    // Still there, untouched, for the rep who recorded it.
    expect(store.entries.map((e) => e.id)).toEqual(["theirs"]);
    expect(store.entries[0]?.state).toBe("pending");
    expect(store.entries[0]?.attempts).toBe(0);
  });

  it("sends nothing at all when the whole queue belongs to somebody else", async () => {
    const store = memoryStore(enqueueTransfer([], transferBody("theirs"), 1000, { createdBy: REP2 }));
    const transport = recordingTransport([created]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual([]);
    expect(report.batches).toBe(0);
    expect(report.heldForOthers).toBe(1);
    expect(store.writes).toBe(0);
  });

  it("treats a 404 on an acceptance as permanent, not as something to retry", async () => {
    // Somebody recalled it first, or it was already accepted. The id cannot become valid
    // again, so retrying is a loop and the rep needs to be told.
    const store = memoryStore(
      enqueueAcceptance([], { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" }, 1000, {
        ...MINE,
        transferOf: "gone",
      }),
    );
    const transport = recordingTransport([
      { kind: "status", status: 404, problemKind: "not_found", detail: "transfer_of gone does not exist" },
    ]);
    const report = await sync({ store, transport, now });

    expect(report.rejected).toEqual([{ id: "a1", reason: "transfer_of gone does not exist" }]);
    expect(store.entries[0]?.state).toBe("rejected");
  });

  it("treats a conflict on an acceptance as permanent — somebody settled it first", async () => {
    const store = memoryStore(
      enqueueAcceptance([], { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" }, 1000, {
        ...MINE,
        transferOf: "t1",
      }),
    );
    const transport = recordingTransport([
      { kind: "status", status: 409, problemKind: "conflict", detail: "transfer t1 has already been settled" },
    ]);
    const report = await sync({ store, transport, now });
    expect(report.rejected).toEqual([{ id: "a1", reason: "transfer t1 has already been settled" }]);
  });

  it("keeps a transfer queued when the network is gone, like every other kind", async () => {
    const store = memoryStore(enqueueTransfer([], transferBody("t1"), 1000, MINE));
    const transport = recordingTransport([{ kind: "network" }]);
    const report = await sync({ store, transport, now, random: () => 0.5 });

    expect(report.retrying).toEqual(["t1"]);
    expect(store.entries[0]?.state).toBe("pending");
    expect(store.entries[0]?.nextAttemptAt).toBeGreaterThan(now());
  });

  it("throws rather than posting one kind's body to another kind's route", () => {
    // Unreachable through `dueEntries`, which filters by kind — and that is exactly why it
    // is a check rather than a cast. A wrong SEND_ORDER, or a future kind sharing a plan,
    // would otherwise post one kind's body to another kind's route and be told, correctly,
    // that a well-formed request is malformed.
    const transport = recordingTransport([created]);
    const [transfer] = enqueueTransfer([], transferBody("t1"), 1000, MINE);
    if (transfer === undefined) throw new Error("expected a queued transfer");

    // Synchronously, before anything is sent: the guard runs on the batch, not on the
    // answer, so a mismatched kind never becomes a request at all.
    expect(() => SEND_PLANS.acceptance.send([transfer], transport)).toThrow(
      /the acceptance pass was handed a transfer entry/,
    );
    expect(() => SEND_PLANS.visit.send([transfer], transport)).toThrow(
      /the visit pass was handed a transfer entry/,
    );
    expect(() => SEND_PLANS.recall.send([], transport)).toThrow(
      /the recall pass was handed a missing entry/,
    );
    // Nothing reached the network on any of those.
    expect(transport.calls).toEqual([]);
  });

  it("declares a plan for every kind, so a new one cannot be forgotten", () => {
    expect(Object.keys(SEND_PLANS).sort()).toEqual([...OUTBOX_KINDS].sort());
    // A single-item route must declare a batch of one: handing it two would send the
    // first and silently accept the second's verdict from the first's answer.
    for (const [kind, plan] of Object.entries(SEND_PLANS)) {
      if (plan.reply === "single") expect(plan.batchMax, kind).toBe(1);
    }
  });
});

describe("syncOnce with a count", () => {
  const now = (): number => 10_000;
  const created = { kind: "ok", status: 201, body: {} } as const satisfies TransportResult;
  const committed = { kind: "ok", status: 200, body: { adjustments: 2 } } as const satisfies TransportResult;
  const COUNT = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c99";
  const LOT_A = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c01";
  const LOT_B = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c02";

  const wholeCount = (): readonly OutboxEntry[] => {
    let q = enqueueCount([], { id: COUNT, countedAt: "2026-10-09T09:00:00.000Z", note: null }, 1000, MINE);
    q = enqueueCountLine(q, { lotId: LOT_A, countedQuantity: "7", deviceExpectedQuantity: "8" }, 1001, {
      ...MINE,
      countOf: COUNT,
    });
    q = enqueueCountLine(q, { lotId: LOT_B, countedQuantity: "3" }, 1002, { ...MINE, countOf: COUNT });
    return enqueueCountCommit(q, 1003, {
      ...MINE,
      id: "commit-1",
      countOf: COUNT,
      lineIds: [countLineKey(COUNT, LOT_A), countLineKey(COUNT, LOT_B)],
    });
  };

  it("lands a whole count — document, lines, commit — in ONE drain, in order", async () => {
    // What a rep gets for emptying their bag in a car park: the entire document goes up on
    // the next reconnection, and the commit is last because the ledger must not move until
    // every line it reconciles has arrived.
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([created, created, created, committed]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual([`count:${COUNT}`, `line:${LOT_A}`, `line:${LOT_B}`, `commit:${COUNT}`]);
    expect(report.accepted).toEqual([COUNT, countLineKey(COUNT, LOT_A), countLineKey(COUNT, LOT_B), "commit-1"]);
    expect(store.entries).toEqual([]);
  });

  it("sends the device's own expected figure with the line", async () => {
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([created, created, created, committed]);
    await sync({ store, transport, now });
    expect(transport.countLines[0]).toEqual({
      countId: COUNT,
      body: { lotId: LOT_A, countedQuantity: "7", deviceExpectedQuantity: "8" },
    });
    // And omits it where the device had nothing to say.
    expect(transport.countLines[1]?.body.deviceExpectedQuantity).toBeUndefined();
  });

  it("does NOT commit when a line could not be sent", async () => {
    // The hazard this design exists to prevent. A commit that went early would write
    // adjustments for the lots that arrived and leave the rest of the bag unreconciled —
    // and the missing line would land afterwards against a committed count, where nothing
    // would ever reconcile it.
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([created, created, { kind: "network" }]);
    const report = await sync({ store, transport, now, random: () => 0.5 });

    expect(transport.calls).toEqual([`count:${COUNT}`, `line:${LOT_A}`, `line:${LOT_B}`]);
    expect(transport.commits).toEqual([]);
    expect(report.retrying).toEqual([countLineKey(COUNT, LOT_B)]);
    // The commit is still there, still pending, waiting for the line.
    expect(store.entries.map((e) => e.id)).toEqual([countLineKey(COUNT, LOT_B), "commit-1"]);
    expect(store.entries.find((e) => e.id === "commit-1")?.state).toBe("pending");
  });

  it("refuses the commit when a line is refused, in the same pass", async () => {
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([
      created,
      created,
      { kind: "status", status: 409, problemKind: "conflict", detail: "lot LOT-2 has been written off" },
    ]);
    const report = await sync({ store, transport, now });

    expect(transport.commits).toEqual([]);
    expect(report.rejected).toEqual([
      { id: countLineKey(COUNT, LOT_B), reason: "lot LOT-2 has been written off" },
      { id: "commit-1", reason: "the count_line it belongs to was refused: lot LOT-2 has been written off" },
    ]);
  });

  it("refuses every part when the count document itself is refused", async () => {
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([
      { kind: "status", status: 409, problemKind: "conflict", detail: "you already have an open count" },
    ]);
    const report = await sync({ store, transport, now });

    expect(transport.calls).toEqual([`count:${COUNT}`]);
    expect(report.rejected.map((r) => r.id).sort()).toEqual(
      [COUNT, "commit-1", countLineKey(COUNT, LOT_A), countLineKey(COUNT, LOT_B)].sort(),
    );
  });

  it("accepts the commit's 200 and reports the count as sent", async () => {
    // The commit answers with the FINDING — how many adjustments it wrote — rather than an
    // acknowledgement, and a 200 is as much an acceptance as a 201 is.
    const store = memoryStore(wholeCount());
    const transport = recordingTransport([created, created, created, committed]);
    const report = await sync({ store, transport, now });
    expect(report.accepted).toContain("commit-1");
    expect(report.rejected).toEqual([]);
  });

  it("treats a repeated commit's answer as acceptance, since the server makes it idempotent", async () => {
    // A reply lost after the commit committed is retried, and 0056 made the second answer
    // the same as the first. Were it still a 409 this row would be marked refused and the
    // rep told their count failed while the ledger held its adjustments.
    const store = memoryStore(
      enqueueCountCommit([], 1000, { ...MINE, id: "commit-1", countOf: COUNT, lineIds: [] }),
    );
    const transport = recordingTransport([{ kind: "ok", status: 200, body: { adjustments: 1 } }]);
    const report = await sync({ store, transport, now });
    expect(report.accepted).toEqual(["commit-1"]);
    expect(store.entries).toEqual([]);
  });
});

describe("abandoning a count", () => {
  const now = (): number => 10_000;
  const COUNT = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c99";
  const LOT_A = "01995b2a-9c40-7c3a-b7e1-2f4d6a8b0c01";

  it("sends the cancel, and nothing else for that count", async () => {
    // The exit from the one state a rep can otherwise be stuck in: a count whose line was
    // refused stays open, and `uq_sample_count_one_open` refuses every count afterwards.
    // Queueing the cancel discards the document's own parts, because they are moot.
    let q = enqueueCount([], { id: COUNT, countedAt: "2026-10-09T09:00:00.000Z", note: null }, 1000, MINE);
    q = enqueueCountLine(q, { lotId: LOT_A, countedQuantity: "7" }, 1001, { ...MINE, countOf: COUNT });
    q = enqueueCountCancel(q, 1002, { ...MINE, id: "cancel-1", countOf: COUNT });
    expect(q.map((e) => e.kind)).toEqual(["count_cancel"]);

    const store = memoryStore(q);
    const transport = recordingTransport([{ kind: "ok", status: 204, body: null }]);
    const report = await sync({ store, transport, now });
    expect(transport.calls).toEqual([`cancel:${COUNT}`]);
    expect(report.accepted).toEqual(["cancel-1"]);
    expect(store.entries).toEqual([]);
  });

  it("accepts a 204, which carries no body at all", async () => {
    const store = memoryStore(enqueueCountCancel([], 1000, { ...MINE, id: "cancel-1", countOf: COUNT }));
    const transport = recordingTransport([{ kind: "ok", status: 204, body: null }]);
    const report = await sync({ store, transport, now });
    expect(report.accepted).toEqual(["cancel-1"]);
  });
});
