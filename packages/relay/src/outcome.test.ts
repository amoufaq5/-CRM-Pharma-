import { describe, expect, it } from "vitest";
import { ErpError } from "@crm/acl";
import {
  TargetAlreadyPresentError,
  TargetConfirmedAbsentError,
  classify,
  isAmbiguousWriteFailure,
  isTerminal,
} from "./outcome.js";

/**
 * `ConstructorParameters`, not `Parameters`. A class is not callable, so
 * `Parameters<typeof ErpError>` fails its constraint and the conditional that used to
 * stand here collapsed the kind to `never` — which typechecks as long as nothing
 * typechecks it, and every call below was an error nobody ever saw. Test files are
 * excluded from `tsc` in this repo; `pnpm typecheck:tests` is what found it.
 */
const erp = (
  kind: ConstructorParameters<typeof ErpError>[0],
  status: number,
  code: string,
  detail?: string,
) => new ErpError(kind, status, code, detail, null);

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

/**
 * The defect this suite did not cover: a 409 means two different things at the ERP, and
 * only one of them is a delivered write.
 *
 * `invalid_transition` says the record was NOT touched. Reading it as success marked the
 * outbox row delivered and dropped the transition, leaving the CRM and the ERP
 * disagreeing about a record's state with nothing anywhere reporting it. Found by
 * reading, not by a failing test — which is why these exist now.
 */
describe("409 is not one thing", () => {
  it("retries an invalid_transition as an ordering problem, never as delivered", () => {
    const out = classify({
      error: new ErpError("conflict", 409, "invalid_transition", "'approve' cannot fire from 'draft'", null),
      isTransition: true,
    });
    expect(out.kind).toBe("retry_ordering");
    expect(out.kind).not.toBe("already_delivered");
    expect(isTerminal(out.kind)).toBe(false);
    // The sentence has to say what the ERP said, because the eventual dead letter is
    // read by a human deciding whether the two systems really disagree.
    expect(out.reason).toContain("cannot fire from 'draft'");
  });

  it("still treats a duplicate target id as delivered — the case the branch was written for", () => {
    for (const detail of [
      "duplicate key value violates unique constraint",
      "record already exists",
    ]) {
      const out = classify({
        error: new ErpError("conflict", 409, "conflict", detail, null),
        isTransition: false,

      });
      expect(out.kind).toBe("already_delivered");
    }
  });

  it("does not let an invalid_transition reach the conflict branch by its detail text", () => {
    // Belt and braces on the ORDER of the two branches: a detail mentioning
    // idempotency alongside the transition code must still not read as delivered.
    const out = classify({
      error: new ErpError("conflict", 409, "invalid_transition", "idempotency: already exists", null),
      isTransition: true,
    });
    expect(out.kind).toBe("retry_ordering");
  });
});

});

/**
 * The live duplicate-key answer, byte for byte.
 *
 * `operate-runtime/src/handlers.ts` wraps the write unit in a `catch` and forwards
 * `e.message`, so node-postgres's sentence reaches the client inside a 500. Used
 * as the inner error throughout this block so each assertion is measured against
 * the real thing rather than a shape invented for the test.
 */
const LIVE_DUPLICATE = () =>
  erp(
    "unavailable",
    500,
    "write_failed",
    'duplicate key value violates unique constraint "operate_entity_records_tenant_entity_record_key"',
  );

/** The same answer from a platform that stopped leaking the driver message. */
const SILENT_DUPLICATE = () => erp("unavailable", 500, "write_failed");

describe("what counts as ambiguous", () => {
  // The rule is "were we told an outcome", not a list of ERP codes. A list would be
  // the same defect one layer up from the leak this closes.
  it.each([
    ["the live duplicate-key 500", LIVE_DUPLICATE()],
    ["the same 500 with no detail at all", SILENT_DUPLICATE()],
    ["a 503 from the gateway", erp("unavailable", 503, "service_unavailable", "down")],
    ["the client's own 504 timeout", erp("unavailable", 504, "client_timeout", "POST /v1/items exceeded 15000ms")],
    ["an unreadable 502 body", erp("unavailable", 502, "unrecognised_error_shape")],
    ["a socket reset, which is not an ErpError at all", new Error("ECONNRESET")],
  ])("%s is ambiguous — the ERP did not say what happened to the record", (_label, error) => {
    expect(isAmbiguousWriteFailure(error)).toBe(true);
  });

  it.each([
    ["401", erp("unauthenticated", 401, "authentication_required")],
    ["403", erp("forbidden", 403, "forbidden", "role may not post")],
    ["404", erp("not_found", 404, "not_found")],
    ["409", erp("conflict", 409, "conflict_idempotency_mismatch")],
    ["409 invalid_transition", erp("conflict", 409, "invalid_transition", "'approve' cannot fire from 'draft'")],
    ["422 period_locked", erp("validation_failed", 422, "period_locked", "fiscal period is closed")],
    ["422 validation_failed", erp("validation_failed", 422, "validation_failed", "request_number is required")],
    ["429", erp("rate_limited", 429, "too_many_requests")],
  ])("%s is NOT ambiguous — it states an outcome, so a read could only repeat it", (_label, error) => {
    expect(isAmbiguousWriteFailure(error)).toBe(false);
  });
});

describe("a probe that read the record back", () => {
  it("settles the row as delivered, and says it ASKED rather than guessed", () => {
    const out = classify({
      error: new TargetAlreadyPresentError("crm-exp-42", SILENT_DUPLICATE()),
      isTransition: false,
    });
    expect(out.kind).toBe("already_delivered");
    expect(isTerminal(out.kind)).toBe(true);
    expect(out.reason).toContain("crm-exp-42");
    // The distinction is the whole increment: the row's `last_error` has to say
    // which mechanism settled it, or the next live run cannot tell them apart.
    expect(out.reason).toMatch(/read back from the ERP/);
  });

  it("settles a write whose 500 carried NO driver text — the case that used to die at the cap", () => {
    // The before/after in one pair. Same status, same code, no `detail`:
    // classification alone can only retry it, and a probe makes it delivered.
    expect(classify({ error: SILENT_DUPLICATE(), isTransition: false }).kind).toBe("retry_transient");
    expect(
      classify({ error: new TargetAlreadyPresentError("crm-exp-42", SILENT_DUPLICATE()), isTransition: false }).kind,
    ).toBe("already_delivered");
  });
});

describe("a probe that found the record ABSENT outranks the regex", () => {
  it("refuses to call a write delivered on a duplicate-key sentence the ERP contradicts", () => {
    // NON-VACUITY: the inner error is the real live 500, whose detail `ALREADY_EXISTS`
    // matches — asserted on the very next line. If the suppression were removed this
    // would read `already_delivered`, so the test cannot pass while the rule is broken.
    const inner = LIVE_DUPLICATE();
    expect(classify({ error: inner, isTransition: false }).kind).toBe("already_delivered");

    const out = classify({ error: new TargetConfirmedAbsentError("crm-exp-43", inner), isTransition: false });
    expect(out.kind).not.toBe("already_delivered");
    expect(out.kind).toBe("retry_transient");
    expect(isTerminal(out.kind)).toBe(false);
  });

  it("keeps the ERP's own sentence AND says the record is not there", () => {
    const out = classify({
      error: new TargetConfirmedAbsentError("crm-exp-43", LIVE_DUPLICATE()),
      isTransition: false,
    });
    expect(out.reason).toContain("duplicate key value");
    expect(out.reason).toContain("does not hold crm-exp-43");
  });

  it("does not let a 409 on another unique column read as delivered either", () => {
    // The disagreement that makes the probe authoritative rather than a second
    // opinion: a collision on some OTHER unique column — an invoice number, an
    // employee number — answers the same way while our record was never written.
    const out = classify({
      error: new TargetConfirmedAbsentError(
        "crm-exp-44",
        erp("conflict", 409, "conflict", 'duplicate key value violates unique constraint "invoice_number_key"'),
      ),
      isTransition: false,
    });
    expect(out.kind).not.toBe("already_delivered");
  });

  it("still dead-letters a failure that cannot fix itself, absence or not", () => {
    // Absence suppresses the existence GUESS and nothing else: a 403 is still a 403.
    const out = classify({
      error: new TargetConfirmedAbsentError("crm-exp-45", erp("forbidden", 403, "forbidden", "role may not post")),
      isTransition: false,
    });
    expect(out.kind).toBe("dead");
  });
});
