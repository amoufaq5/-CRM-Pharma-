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
  unmapped_category: "unmapped-category",
  // A cooldown is rate limiting, and 429 is the status for it. 409 was the alternative
  // and is wrong in a way a client acts on: a conflict says "the state refuses this", a
  // 429 says "ask again later", and the probe cooldown's own message carries the moment a
  // retry becomes legal.
  too_many_requests: "too-many-requests",
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
  // Its own type because it is the one expense refusal a client must ACT on rather than
  // merely report: the claim is correct and nothing is wrong with it, Finance simply has
  // not said which ledger account the category posts to. A bare 409 would read as "your
  // claim is bad".
  unmapped_category: 409,
  too_many_requests: 429,
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
  unmapped_category: "Category not mapped to an account",
  too_many_requests: "Too many requests",
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
    // A transfer that already has its one terminal event — accepted, or recalled
    // already. A conflict rather than a validation failure: the request was well formed
    // and the material's state refuses it.
    case "TransferAlreadySettledError":
    case "SampleCountError":
      return new ApiError("conflict", message);
    // Not a conflict: only the sender may take material back, because it is their
    // `quantity_in_transit` the recall draws down. 403 rather than the 404 the
    // supervision helpers return, because an outstanding transfer is already visible to
    // BOTH reps — hiding its existence from the one who can see it buys nothing and
    // would send them hunting for a typo.
    case "TransferNotSenderError":
      return new ApiError("forbidden", message);
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
    // The endpoint probe (0034). Four refusals, each a different instruction to the
    // administrator: the endpoint is gone; one is already running; you asked too recently;
    // the cooldown you tried to set is out of range. A 500 for any of them would be the
    // API reporting its own surprise at a rule it enforces.
    case "EndpointNotFoundError":
    // Also a 404, and a separate class on purpose: "the endpoint is not here" and "the rep
    // asking is not here" send an administrator to look at different things.
    case "ProbeRequesterNotFoundError":
      return new ApiError("not_found", message);
    case "ProbeInFlightError":
      return new ApiError("conflict", message);
    case "ProbeCooldownError":
      return new ApiError("too_many_requests", message);
    case "InvalidProbeCooldownError":
      return new ApiError("validation_failed", message);
    case "InvalidEndpointError":
    case "InvalidRetentionError":
    // A `mailto:` endpoint that is not one mailbox. Reachable from an admin route
    // configuring a channel, so it gets a real status rather than a 500.
    case "InvalidMailEndpointError":
      return new ApiError("validation_failed", message);

    // Expenses (0006, @crm/expense). ADR-0001 item 11.
    //
    // THE ONE THAT MATTERS: an unmapped category is the designed refusal that makes the
    // Finance dependency safe — the claim stays in draft rather than posting to a guessed
    // ledger account. It reached a client as a 500 "an unexpected error occurred" until
    // these cases existed, which turned the system's most deliberate refusal into a bug
    // report. The structural test below now covers this package so it cannot recur.
    case "UnmappedCategoryError":
      return new ApiError("unmapped_category", message);
    case "ExpenseClaimNotFoundError":
      return new ApiError("not_found", message);
    // Four eyes, refused by a CHECK in 0006. Forbidden rather than conflict: the state is
    // fine, the actor is not.
    case "FourEyesViolationError":
    // The same rule for the other decision, refused by its own CHECK in 0030. Mapped as
    // its own case rather than folded into the one above, because the two errors say
    // different things and a rejection reported as "cannot be approved by the rep who
    // submitted it" sends the reader looking for an approval nobody attempted.
    case "RejectionFourEyesViolationError":
      return new ApiError("forbidden", message);
    case "InvalidExpenseClaimTransitionError":
      return new ApiError("conflict", message);
    // A rep with no `erp_employee_id` cannot be the subject of an ERP Expense. A
    // configuration gap in the mapping table ADR-0001 Q3 exists for, not a bad request —
    // but the caller can do nothing with a 500, and an administrator can act on this.
    case "RepNotMappedToEmployeeError":
    case "MissingAccountSnapshotError":
    case "ApprovalFieldsError":
    case "RejectionFieldsError":
    case "MissingErpExpenseIdError":
      return new ApiError("conflict", message);
    case "InvalidAmountError":
    case "InvalidCurrencyError":
    case "InvalidDateError":
    case "InvalidAccountCodeError":
    case "InvalidCategoryError":
      return new ApiError("validation_failed", message);

    // @crm/relay. Exported from its barrel and mapped nowhere until now, so it fell
    // through to a 500 — and escaped the structural test below only because `@crm/relay`
    // was missing from that test's module list. Both are fixed together; mapping the class
    // without adding the package would leave the next one free to do the same.
    case "DeadLetterNotFoundError":
      return new ApiError("not_found", message);
    case "ErpError":
      return new ApiError("upstream_unavailable", "the ERP could not be reached");
    default:
      return new ApiError("internal", "an unexpected error occurred");
  }
}
