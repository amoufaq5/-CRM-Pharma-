/**
 * RFC 9457 problem details — the CRM's ONE error shape.
 *
 * The ERP emits two: RFC 9457 from the gateway and a bare `{error, detail}` from
 * handlers, on the same API (report R13), so every client must handle both and
 * guess which layer answered. That is a mistake worth not repeating, so
 * everything here goes out as `application/problem+json` and nothing is allowed
 * to bypass it — including an unexpected throw, which `toProblem` turns into a
 * 500 of the same shape rather than a stack trace.
 */
export const PROBLEM_BASE = "https://crm.pharma/errors";

export const PROBLEM_TYPES = {
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  not_found: "not-found",
  validation_failed: "validation-failed",
  conflict: "conflict",
  outside_territory: "outside-territory",
  visit_final: "visit-final",
  method_not_allowed: "method-not-allowed",
  unsupported_media_type: "unsupported-media-type",
  payload_too_large: "payload-too-large",
  internal: "internal",
  upstream_unavailable: "upstream-unavailable",
} as const;
export type ProblemKind = keyof typeof PROBLEM_TYPES;

const STATUS: Readonly<Record<ProblemKind, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  outside_territory: 403,
  visit_final: 409,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
  internal: 500,
  upstream_unavailable: 503,
};

const TITLE: Readonly<Record<ProblemKind, string>> = {
  unauthenticated: "Authentication required",
  forbidden: "Forbidden",
  not_found: "Not found",
  validation_failed: "Validation failed",
  conflict: "Conflict",
  outside_territory: "Outside your territory",
  visit_final: "Visit is final",
  method_not_allowed: "Method not allowed",
  unsupported_media_type: "Unsupported media type",
  payload_too_large: "Payload too large",
  internal: "Internal error",
  upstream_unavailable: "Upstream unavailable",
};

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /** Echoed so a support ticket and a log line can be joined. */
  readonly correlationId?: string;
  /** Per-field messages, for a 422 a form can render inline. */
  readonly errors?: Readonly<Record<string, string>>;
}

export class ApiError extends Error {
  constructor(
    readonly kind: ProblemKind,
    readonly detail?: string,
    readonly errors?: Readonly<Record<string, string>>,
  ) {
    super(detail ?? TITLE[kind]);
    this.name = "ApiError";
  }

  get status(): number {
    return STATUS[this.kind];
  }

  body(correlationId?: string): ProblemBody {
    return {
      type: `${PROBLEM_BASE}/${PROBLEM_TYPES[this.kind]}`,
      title: TITLE[this.kind],
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(this.errors !== undefined ? { errors: this.errors } : {}),
    };
  }
}

/** Shorthands, so a handler reads as prose. */
export const unauthenticated = (d?: string): ApiError => new ApiError("unauthenticated", d);
export const forbidden = (d?: string): ApiError => new ApiError("forbidden", d);
export const notFound = (d?: string): ApiError => new ApiError("not_found", d);
export const validationFailed = (d?: string, e?: Record<string, string>): ApiError =>
  new ApiError("validation_failed", d, e);

/**
 * Maps anything thrown into a problem.
 *
 * Domain errors from the packages below are recognised by NAME rather than by
 * `instanceof`. The api package must not import @crm/visit just to catch its
 * errors — and more practically, an `instanceof` across package boundaries
 * breaks the moment two copies of a module exist.
 *
 * Anything unrecognised becomes a 500 whose `detail` is deliberately generic:
 * an internal message can carry a table name, a column, or a fragment of SQL,
 * and a client is the wrong place for that. The real error goes to the log.
 */
export function toProblem(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? "";

  switch (name) {
    case "OutsideTerritoryError":
      return new ApiError("outside_territory", message);
    case "VisitIsFinalError":
    case "InvalidTransitionError":
      return new ApiError("visit_final", message);
    case "VisitNotFoundError":
      return new ApiError("not_found", message);
    case "InvalidDateRangeError":
      return new ApiError("validation_failed", message);
    case "OverlappingAssignmentError":
      return new ApiError("conflict", message);
    case "TerritoryCycleError":
      return new ApiError("validation_failed", message);
    case "ErpError":
      return new ApiError("upstream_unavailable", "the ERP could not be reached");
    default:
      return new ApiError("internal", "an unexpected error occurred");
  }
}
