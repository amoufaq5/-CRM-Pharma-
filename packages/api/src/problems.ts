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
  plan_final: "plan-final",
  lot_expired: "lot-expired",
  insufficient_stock: "insufficient-stock",
  last_administrator: "last-administrator",
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
  plan_final: 409,
  // Both are well-formed requests the material's state refuses, which is a conflict
  // rather than a validation failure — and a mobile client branches on them: an expired
  // lot means bin it, a short balance means re-count the bag.
  lot_expired: 409,
  insufficient_stock: 409,
  // Its own type because it is the one refusal an administrator must be able to act on
  // without reading prose: a client can say "appoint a successor first" and offer the
  // grant form, where a bare 409 would just look like a failed request.
  last_administrator: 409,
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
  plan_final: "Call plan is final",
  lot_expired: "Lot is expired or withdrawn",
  insufficient_stock: "Not enough stock on hand",
  last_administrator: "Last administrator",
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
    // Sample custody (0017/0018). Each one is a question a sample audit asks, so the
    // refusal travels to the client with its reason intact rather than as a 500.
    case "LotExpiredError":
    case "LotNotReleasedError":
      return new ApiError("lot_expired", message);
    case "InsufficientHoldingError":
      return new ApiError("insufficient_stock", message);
    case "IncompleteRecordError":
      return new ApiError("validation_failed", message);
    case "LedgerImmutableError":
    case "TransferMismatchError":
    case "SampleCountError":
      return new ApiError("conflict", message);
    case "SampleLotNotFoundError":
    case "CallPlanNotFoundError":
      return new ApiError("not_found", message);

    // Call plans (0015/0016).
    case "TargetOutsideTerritoryError":
      return new ApiError("outside_territory", message);
    case "InvalidPlanTransitionError":
    case "PlanFrozenError":
      return new ApiError("plan_final", message);
    case "ApprovalRefusedError":
      return new ApiError("forbidden", message);
    case "DuplicatePlanError":
    case "DuplicateTargetError":
      return new ApiError("conflict", message);
    case "InvalidCycleError":
      return new ApiError("validation_failed", message);

    // Roles (0023). Four eyes and the lockout guard are the database's rules; they reach
    // the client as refusals with their sentences intact, because every one of them tells
    // an administrator what to do instead.
    case "UnknownRoleError":
      return new ApiError("validation_failed", message);
    case "SelfGrantError":
      return new ApiError("forbidden", message);
    case "RoleAlreadyHeldError":
    case "GrantAlreadyRevokedError":
    case "GrantImmutableError":
      return new ApiError("conflict", message);
    case "LastAdministratorError":
      return new ApiError("last_administrator", message);
    case "InvalidEndpointError":
    case "InvalidRetentionError":
      return new ApiError("validation_failed", message);

    case "ErpError":
      return new ApiError("upstream_unavailable", "the ERP could not be reached");
    default:
      return new ApiError("internal", "an unexpected error occurred");
  }
}
