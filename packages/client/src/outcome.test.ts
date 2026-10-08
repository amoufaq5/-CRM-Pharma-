import { describe, expect, it } from "vitest";

import { DISPOSITIONS, classifyRowOutcome, classifyTransportOutcome } from "./outcome.js";

/**
 * The classification IS the offline protocol's correctness. A wrong entry here is either
 * a queue that spins forever against a refusal it cannot satisfy, or a rep's call report
 * discarded because a server said 503.
 */
describe("classifyRowOutcome", () => {
  it("accepts an accepted row", () => {
    expect(classifyRowOutcome({ ok: true })).toEqual({ disposition: "accepted", reason: "accepted" });
  });

  it("STOPS on tenant_deleted, which is the one disposition that condemns the queue", () => {
    // packages/api/src/problems.ts says it in as many words: "an offline client holding a
    // queue of unsent visits needs to stop retrying and say so".
    const out = classifyRowOutcome({ ok: false, type: "tenant_deleted", error: "tenant gone" });
    expect(out).toEqual({ disposition: "stop", reason: "tenant gone" });
  });

  it("asks for a new session on unauthenticated rather than failing the row", () => {
    expect(classifyRowOutcome({ ok: false, type: "unauthenticated" }).disposition).toBe("reauthenticate");
  });

  it.each(["internal", "upstream_unavailable", "too_many_requests"])("retries %s", (type) => {
    expect(classifyRowOutcome({ ok: false, type }).disposition).toBe("retry");
  });

  it.each([
    "validation_failed",
    "forbidden",
    "not_found",
    "conflict",
    "outside_territory",
    "visit_final",
    "plan_final",
    "invalid_transition",
    "lot_expired",
    "insufficient_stock",
    "last_administrator",
    "unmapped_category",
    "signature_mismatch",
    "method_not_allowed",
    "unsupported_media_type",
    "payload_too_large",
  ])("never retries %s", (type) => {
    expect(classifyRowOutcome({ ok: false, type }).disposition).toBe("permanent");
  });

  it("treats a refusal it has never heard of as permanent, and says so by name", () => {
    // The conservative direction: an unknown refusal is far likelier to be a rule this
    // client breaks than a hiccup, and a row looping against a server that will never
    // take it is the worse failure. The kind travels in the reason so it reads as a bug
    // report rather than a silence.
    const out = classifyRowOutcome({ ok: false, type: "sample_quota_exceeded" });
    expect(out.disposition).toBe("permanent");
    expect(out.reason).toContain("sample_quota_exceeded");
    expect(out.reason).toContain("does not recognise");
  });

  it("keeps the server's detail as the reason when there is one", () => {
    const out = classifyRowOutcome({ ok: false, type: "outside_territory", error: "account A-1 is not in your territory" });
    expect(out.reason).toBe("account A-1 is not in your territory");
  });

  it("has a reason for every disposition it can return", () => {
    const seen = new Set(
      ["tenant_deleted", "unauthenticated", "internal", "validation_failed"].map(
        (type) => classifyRowOutcome({ ok: false, type }).disposition,
      ),
    );
    seen.add("accepted");
    expect([...seen].sort()).toEqual([...DISPOSITIONS].sort());
  });
});

describe("classifyTransportOutcome", () => {
  it("retries a network failure, because it says nothing about the rows", () => {
    expect(classifyTransportOutcome({ kind: "network" })).toEqual({
      disposition: "retry",
      reason: "offline or unreachable",
    });
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", (status) => {
    expect(classifyTransportOutcome({ kind: "status", status }).disposition).toBe("retry");
  });

  it("re-authenticates on 401", () => {
    expect(classifyTransportOutcome({ kind: "status", status: 401 }).disposition).toBe("reauthenticate");
  });

  it("stops on a tenant_deleted problem whatever its status", () => {
    // It arrives as a 403, which every other 403 here says "ask an administrator" about.
    // This one has no administrator left to ask.
    expect(
      classifyTransportOutcome({ kind: "status", status: 403, problemKind: "tenant_deleted" }).disposition,
    ).toBe("stop");
  });

  it("does not retry an ordinary 4xx against the batch", () => {
    expect(classifyTransportOutcome({ kind: "status", status: 413 }).disposition).toBe("permanent");
    expect(classifyTransportOutcome({ kind: "status", status: 403 }).disposition).toBe("permanent");
  });
});
