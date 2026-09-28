import { z } from "zod";

/**
 * The ERP returns TWO different error shapes on the same API and a client that
 * handles only one will misread the other (report R13):
 *
 *   - The gateway emits RFC 9457 `application/problem+json` —
 *     `{ type, title, status, detail, … }` with types under
 *     https://crossengin.io/errors/… — for auth, routing, negotiation,
 *     idempotency, rate limiting and sunset.
 *   - Handlers emit a bare `{ error, detail }` — `{"error":"forbidden",…}`,
 *     `{"error":"not_found"}`, `{"error":"tenant_required"}` — for RBAC and CRUD
 *     outcomes.
 *
 * Both are normalised to one `ErpError` so callers never branch on which layer
 * happened to answer.
 */
export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});

export const HandlerErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});

export type ErpErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "rate_limited"
  | "tenant_required"
  | "unavailable"
  | "unknown";

export class ErpError extends Error {
  constructor(
    readonly kind: ErpErrorKind,
    readonly status: number,
    readonly code: string,
    readonly detail: string | undefined,
    readonly raw: unknown,
  ) {
    super(`ERP ${status} ${code}${detail !== undefined ? `: ${detail}` : ""}`);
    this.name = "ErpError";
  }

  /** Whether re-sending the identical request could plausibly succeed. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable";
  }
}

const KIND_BY_CODE: Readonly<Record<string, ErpErrorKind>> = {
  forbidden: "forbidden",
  not_found: "not_found",
  tenant_required: "tenant_required",
  validation_failed: "validation_failed",
  authentication_required: "unauthenticated",
  insufficient_scope: "forbidden",
  conflict_idempotency_mismatch: "conflict",
  unprocessable_entity: "validation_failed",
  too_many_requests: "rate_limited",
  quota_exceeded: "rate_limited",
  service_unavailable: "unavailable",
  gateway_timeout: "unavailable",
};

function kindForStatus(status: number): ErpErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/** The trailing path segment of an RFC 9457 type URI: `…/errors/not-found` → `not_found`. */
export function codeFromProblemType(type: string): string {
  const slug = type.split("/").filter((s) => s.length > 0).pop() ?? "";
  return slug.replace(/-/g, "_");
}

/** Normalises either ERP error shape — or neither — into one `ErpError`. */
export function toErpError(status: number, body: unknown): ErpError {
  const problem = ProblemDetailsSchema.safeParse(body);
  if (problem.success) {
    const code = codeFromProblemType(problem.data.type);
    return new ErpError(
      KIND_BY_CODE[code] ?? kindForStatus(problem.data.status),
      problem.data.status,
      code,
      problem.data.detail ?? problem.data.title,
      body,
    );
  }
  const handler = HandlerErrorSchema.safeParse(body);
  if (handler.success) {
    return new ErpError(
      KIND_BY_CODE[handler.data.error] ?? kindForStatus(status),
      status,
      handler.data.error,
      handler.data.detail,
      body,
    );
  }
  // Neither shape: a proxy page, an HTML 502, a truncated body. Still typed.
  return new ErpError(kindForStatus(status), status, "unrecognised_error_shape", undefined, body);
}
