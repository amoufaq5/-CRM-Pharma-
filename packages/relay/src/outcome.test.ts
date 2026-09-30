import { describe, expect, it } from "vitest";
import { ErpError } from "@crm/acl";
import { classify, isTerminal } from "./outcome.js";

const erp = (kind: Parameters<typeof ErpError>[0] extends never ? never : ConstructorParameters<typeof ErpError>[0], status: number, code: string, detail?: string) =>
  new ErpError(kind, status, code, detail, null);

describe("write-guard codes — all 422, told apart by CODE not status", () => {
  // The single most important behaviour here. `period_locked` and
  // `unbalanced_journal_entry` are the same HTTP status in the same bare
  // {error, detail} body; classifying on status would either retry our own bug
  // forever or silently drop legitimate spend.
  it("retries a locked fiscal period rather than dead-lettering it", () => {
    const out = classify({
      error: erp("validation_failed", 422, "period_locked", "cannot post into fiscal period in 'closed' state"),
      isTransition: false,
    });
    expect(out.kind).toBe("retry_period");
    expect(isTerminal(out.kind)).toBe(false);
  });

  it.each([
    "unbalanced_journal_entry",
    "empty_journal_entry",
    "document_locked",
    "document_locked_lines",
    "validation_failed",
  ])("dead-letters %s — it cannot fix itself", (code) => {
    const out = classify({ error: erp("validation_failed", 422, code, "nope"), isTransition: false });
    expect(out.kind).toBe("dead");
  });

  it("does not confuse the two despite the identical status", () => {
    const locked = classify({ error: erp("validation_failed", 422, "period_locked"), isTransition: false });
    const unbalanced = classify({ error: erp("validation_failed", 422, "unbalanced_journal_entry"), isTransition: false });
    expect(locked.kind).not.toBe(unbalanced.kind);
  });
});

describe("replay", () => {
  it("treats a conflict as already delivered, not as a failure", () => {
    // A previous attempt landed and we never saw the response. The ERP's
    // (tenant_id, entity, record_id) unique constraint is what makes this safe.
    const out = classify({ error: erp("conflict", 409, "conflict_idempotency_mismatch"), isTransition: false });
    expect(out.kind).toBe("already_delivered");
    expect(isTerminal(out.kind)).toBe(true);
  });

  it("recognises a duplicate-key detail even when the status is not 409", () => {
    const out = classify({
      error: erp("unknown", 500, "internal", 'duplicate key value violates unique constraint "…"'),
      isTransition: false,
    });
    expect(out.kind).toBe("already_delivered");
  });
});

describe("not_found depends on what we were doing", () => {
  it("retries a 404 on a TRANSITION — the create may not have landed yet", () => {
    const out = classify({ error: erp("not_found", 404, "not_found"), isTransition: true });
    expect(out.kind).toBe("retry_ordering");
  });

  it("dead-letters a 404 on a CREATE — a bad route never becomes a good one", () => {
    const out = classify({ error: erp("not_found", 404, "not_found"), isTransition: false });
    expect(out.kind).toBe("dead");
    expect(out.reason).toMatch(/stale slug|not served/);
  });
});

describe("transient versus terminal", () => {
  it.each([
    ["rate_limited", 429, "too_many_requests"],
    ["unavailable", 503, "service_unavailable"],
    ["unavailable", 504, "client_timeout"],
  ] as const)("retries %s", (kind, status, code) => {
    expect(classify({ error: erp(kind, status, code), isTransition: false }).kind).toBe("retry_transient");
  });

  it("retries a 401 — the service token is short-lived, so expiry is a refresh away", () => {
    expect(classify({ error: erp("unauthenticated", 401, "authentication_required"), isTransition: false }).kind).toBe(
      "retry_transient",
    );
  });

  it("dead-letters a 403 — RBAC will not change on its own", () => {
    // The concrete case: the service credential lacking `controller`, which the
    // expense journal posting needs. That wants a human, not a backoff curve.
    const out = classify({ error: erp("forbidden", 403, "forbidden", "role may not post"), isTransition: false });
    expect(out.kind).toBe("dead");
  });

  it("retries a non-ERP error such as a socket reset", () => {
    expect(classify({ error: new Error("ECONNRESET"), isTransition: false }).kind).toBe("retry_transient");
  });

  it("retries an UNRECOGNISED ERP code rather than dropping a rep's write", () => {
    // A new error code appearing in the ERP must not silently dead-letter work.
    // The attempt cap ends it if it really is permanent.
    const out = classify({ error: erp("unknown", 418, "brand_new_code"), isTransition: false });
    expect(out.kind).toBe("retry_transient");
    expect(out.reason).toContain("unclassified");
  });
});
