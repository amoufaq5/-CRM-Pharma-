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

/**
 * The field-level half of a 422, which the handler puts in `fields` and NOT in
 * `detail`.
 *
 * `operate-runtime/src/handlers.ts` answers a rejected write with
 * `{ error: "validation_failed", fields: [{field, code, message}] }` and no
 * `detail` at all — verified against a live operate-server, where every offline
 * fixture in this repo had supplied a `detail` and so the gap was invisible. A
 * mapper reading only `detail` therefore normalises the one ERP error whose cause
 * is fully described into an error carrying no cause, and because the relay
 * dead-letters a 422 rather than retrying it, `crm.outbox.dead_reason` — the
 * whole of what a human gets, and the thing README rule 31's "way back" depends
 * on — read `validation_failed: write guard refused`.
 *
 * Parsed SEPARATELY from `HandlerErrorSchema` rather than as a member of it, and
 * leniently. If `fields` were a required-shape member, an ERP that one day
 * changed it would make the whole body unrecognisable — turning a precisely
 * classified 422 into `unrecognised_error_shape`, which classifies as a transient
 * retry and burns the attempt cap on a payload that will never be accepted. A
 * body this cannot read keeps whatever `detail` it had.
 */
const HandlerFieldErrorsSchema = z.object({
  fields: z.array(
    z
      .object({ field: z.string(), code: z.string().optional(), message: z.string().optional() })
      .passthrough(),
  ),
});

/** Renders the `fields` array into one readable sentence, or undefined if there is nothing to say. */
export function describeFieldErrors(body: unknown): string | undefined {
  const parsed = HandlerFieldErrorsSchema.safeParse(body);
  if (!parsed.success || parsed.data.fields.length === 0) return undefined;
  const parts = parsed.data.fields.map((f) =>
    // `message` already names the field ("name is required"), so it stands alone.
    // Without one, the pair is the only thing that identifies what was rejected.
    f.message !== undefined && f.message !== "" ? f.message : `${f.field}: ${f.code ?? "invalid"}`,
  );
  return parts.join("; ");
}

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
      handler.data.detail ?? describeFieldErrors(body),
      body,
    );
  }
  // Neither shape: a proxy page, an HTML 502, a truncated body. Still typed.
  return new ErpError(kindForStatus(status), status, "unrecognised_error_shape", undefined, body);
}
