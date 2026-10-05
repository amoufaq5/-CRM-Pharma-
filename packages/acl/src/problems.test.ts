import { describe, expect, it } from "vitest";
import { codeFromProblemType, describeFieldErrors, ErpError, toErpError } from "./problems.js";

describe("toErpError — the gateway's RFC 9457 shape", () => {
  it("maps a problem+json body to a typed error", () => {
    const err = toErpError(403, {
      type: "https://crossengin.io/errors/insufficient-scope",
      title: "Insufficient scope",
      status: 403,
      detail: "token lacks the required scope",
    });
    expect(err.kind).toBe("forbidden");
    expect(err.code).toBe("insufficient_scope");
    expect(err.detail).toBe("token lacks the required scope");
    expect(err.retryable).toBe(false);
  });

  it("treats rate limiting and 5xx as retryable", () => {
    const rate = toErpError(429, {
      type: "https://crossengin.io/errors/too-many-requests",
      title: "Too many requests",
      status: 429,
    });
    expect(rate.kind).toBe("rate_limited");
    expect(rate.retryable).toBe(true);
    expect(toErpError(503, { error: "upstream" }).retryable).toBe(true);
  });
});

describe("toErpError — the handler's bare shape", () => {
  it.each([
    ["forbidden", 403, "forbidden"],
    ["not_found", 404, "not_found"],
    ["tenant_required", 401, "tenant_required"],
    ["validation_failed", 422, "validation_failed"],
  ] as const)("maps {error:%s} to kind %s", (code, status, kind) => {
    const err = toErpError(status, { error: code, detail: "x" });
    expect(err.kind).toBe(kind);
    expect(err.code).toBe(code);
  });

  it("falls back to the HTTP status for an unrecognised code", () => {
    const err = toErpError(404, { error: "something_new" });
    expect(err.kind).toBe("not_found");
    expect(err.code).toBe("something_new");
  });
});

describe("toErpError — neither shape", () => {
  it("still produces a typed error for an HTML proxy page", () => {
    const err = toErpError(502, "<html>Bad Gateway</html>");
    expect(err).toBeInstanceOf(ErpError);
    expect(err.kind).toBe("unavailable");
    expect(err.code).toBe("unrecognised_error_shape");
    expect(err.raw).toBe("<html>Bad Gateway</html>");
  });

  it("does not mistake an empty object for a valid shape", () => {
    expect(toErpError(500, {}).code).toBe("unrecognised_error_shape");
  });
});

describe("codeFromProblemType", () => {
  it("takes the last path segment and snake-cases it", () => {
    expect(codeFromProblemType("https://crossengin.io/errors/not-found")).toBe("not_found");
    expect(codeFromProblemType("https://crossengin.io/errors/idempotency-mismatch")).toBe(
      "idempotency_mismatch",
    );
  });

  it("does not throw on a malformed type", () => {
    expect(codeFromProblemType("")).toBe("");
  });
});

describe("toErpError — a 422's field errors", () => {
  // The exact body a live operate-server emits for a rejected write
  // (`operate-runtime/src/handlers.ts`): `fields`, and no `detail`. Every other
  // fixture in this file supplies a `detail`, which is why the loss below went
  // unnoticed until scripts/verify-live-erp.sh drove a bad payload at a real server.
  const LIVE_422 = {
    error: "validation_failed",
    fields: [{ field: "request_number", code: "required", message: "request_number is required" }],
  };

  it("carries the rejected field into detail when the handler sent no detail", () => {
    const err = toErpError(422, LIVE_422);
    expect(err.kind).toBe("validation_failed");
    expect(err.code).toBe("validation_failed");
    expect(err.detail).toBe("request_number is required");
  });

  it("joins several field errors, so a dead letter names every one", () => {
    expect(
      toErpError(422, {
        error: "validation_failed",
        fields: [
          { field: "sku", code: "required", message: "sku is required" },
          { field: "status", code: "enum", message: "status must be one of: draft, active" },
        ],
      }).detail,
    ).toBe("sku is required; status must be one of: draft, active");
  });

  it("prefers an explicit detail over the fields array", () => {
    expect(toErpError(422, { ...LIVE_422, detail: "spelled out" }).detail).toBe("spelled out");
  });

  it("leaves detail undefined when there are no field errors to describe", () => {
    expect(toErpError(422, { error: "validation_failed" }).detail).toBeUndefined();
    expect(toErpError(422, { error: "validation_failed", fields: [] }).detail).toBeUndefined();
  });

  it("names the field and code when a future ERP omits the message", () => {
    expect(describeFieldErrors({ fields: [{ field: "days", code: "type" }] })).toBe("days: type");
    expect(describeFieldErrors({ fields: [{ field: "days" }] })).toBe("days: invalid");
  });

  it("keeps a body whose fields array is unreadable CLASSIFIABLE rather than unrecognised", () => {
    // The fail-safe direction, and the reason `fields` is parsed separately from
    // HandlerErrorSchema: a 422 that became `unrecognised_error_shape` would
    // classify as a transient retry and burn the attempt cap on a payload no
    // retry can fix.
    const err = toErpError(422, { error: "validation_failed", fields: "not an array" });
    expect(err.code).toBe("validation_failed");
    expect(err.kind).toBe("validation_failed");
    expect(err.detail).toBeUndefined();
    expect(describeFieldErrors({ fields: "not an array" })).toBeUndefined();
  });
});
