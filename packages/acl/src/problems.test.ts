import { describe, expect, it } from "vitest";
import { codeFromProblemType, ErpError, toErpError } from "./problems.js";

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
