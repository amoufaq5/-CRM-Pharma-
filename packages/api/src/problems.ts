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
  // Separate from the two `*_final` types above, because "this is over" and "not from
  // HERE" are different sentences and the pair was answering both with the first. A
  // `planned → completed` refusal came back titled "Visit is final" with a detail saying
  // otherwise, so a client rendering `title` — which is what a title is for — showed the
  // wrong thing. One type for every domain rather than one per domain: the fact is
  // identical, the `detail` names the record and the states, and `conflict` is already
  // shared across a dozen domains on exactly that reasoning.
  invalid_transition: "invalid-transition",
  lot_expired: "lot-expired",
  insufficient_stock: "insufficient-stock",
  last_administrator: "last-administrator",
  // ITS OWN TYPE, not `forbidden`, and the reason is what a client does with it. Every other
  // 403 here is about this caller — wrong role, wrong territory, suspended profile — and the
  // remedy is to ask an administrator. This one says the tenant itself is gone: the ERP
  // dropped its schema and signed a tombstone for it (0050), there is no administrator left
  // to ask, and an offline client holding a queue of unsent visits needs to stop retrying
  // and say so rather than spin on a refusal it reads as transient permissions.
  tenant_deleted: "tenant-deleted",
  unmapped_category: "unmapped-category",
  // A cooldown is rate limiting, and 429 is the status for it. 409 was the alternative
  // and is wrong in a way a client acts on: a conflict says "the state refuses this", a
  // 429 says "ask again later", and the probe cooldown's own message carries the moment a
  // retry becomes legal.
  // Its own type, for the reason `lot_expired` and `unmapped_category` have theirs: the
  // stored image does not hash to what the append-only ledger committed to, and a client
  // must act on that differently from every other conflict — re-sending the same bytes can
  // never work, and the next step is to look at which capture was uploaded, not to retry.
  signature_mismatch: "signature-mismatch",
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
  invalid_transition: 409,
  // Both are well-formed requests the material's state refuses, which is a conflict
  // rather than a validation failure — and a mobile client branches on them: an expired
  // lot means bin it, a short balance means re-count the bag.
  lot_expired: 409,
  insufficient_stock: 409,
  // Its own type because it is the one refusal an administrator must be able to act on
  // without reading prose: a client can say "appoint a successor first" and offer the
  // grant form, where a bare 409 would just look like a failed request.
  last_administrator: 409,
  // 403 and not 410. `410 Gone` is about the REQUESTED RESOURCE having been removed, and the
  // resource here is whatever route they called, which is still perfectly present for every
  // other tenant. The fact is about the caller's authorisation to use it at all, which is a
  // 403 — and the type above is what tells a client which 403 this is.
  tenant_deleted: 403,
  // Its own type because it is the one expense refusal a client must ACT on rather than
  // merely report: the claim is correct and nothing is wrong with it, Finance simply has
  // not said which ledger account the category posts to. A bare 409 would read as "your
  // claim is bad".
  unmapped_category: 409,
  signature_mismatch: 409,
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
  invalid_transition: "Transition not allowed",
  lot_expired: "Lot is expired or withdrawn",
  insufficient_stock: "Not enough stock on hand",
  last_administrator: "Last administrator",
  tenant_deleted: "Tenant deleted",
  unmapped_category: "Category not mapped to an account",
  signature_mismatch: "Signature does not match the ledger commitment",
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

/**
 * The tenant's ERP presence is gone, so this CRM has stopped working it.
 *
 * Names the tenant id, which is not a leak: the caller's own token carries it, and the whole
 * point is that an operator reading a support ticket can match it against `crm.tenant`.
 */
export const tenantDeleted = (tenantId: string): ApiError =>
  new ApiError(
    "tenant_deleted",
    `tenant ${tenantId} has been deleted at the ERP, and this CRM has stopped processing its data. ` +
      `No request for this tenant will be served.`,
  );
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
      return new ApiError("visit_final", message);
    // TWO FACTS, ONE CLASS. `InvalidTransitionError` is raised for every transition the map
    // refuses — `completed → in_progress`, where the visit really is over, and
    // `planned → completed`, where it is not — and the pair used to answer `visit_final`
    // for both, so the second came back titled "Visit is final" with a detail saying
    // otherwise. The class already branched on it to choose its sentence; it now says so,
    // and the mapper reads the flag rather than reconstructing the transition map.
    case "InvalidTransitionError":
      return new ApiError(
        (err as { fromIsFinal?: boolean }).fromIsFinal === true ? "visit_final" : "invalid_transition",
        message,
      );
    case "VisitNotFoundError":
      return new ApiError("not_found", message);
    case "InvalidDateRangeError":
      return new ApiError("validation_failed", message);
    // A value this CRM's own column admits and a JSON number cannot name: reachable from
    // `crm.sample_transaction.quantity`, which is `numeric(16,3)` where a double carries 15
    // significant digits. 422 and at the point of entry, deliberately — the alternative is
    // recording custody of a quantity that can never be mirrored, and the rep who typed it
    // is the one person who can fix it. Unreachable from `crm.expense_claim.amount`
    // (`numeric(14,2)`), and mapped anyway, because an unreachable path that answers 500 is
    // just a 500 nobody has met yet.
    case "ErpDecimalError":
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
    // The disposal SOP parameters (0059). A change to the value already in force, and a
    // direct UPDATE of a row that is a projection of its own change log: both well-formed
    // requests the policy's state refuses, which is a conflict and not a validation
    // failure. The route rejects an empty body and a reason that is too short before the
    // database is asked, so what reaches here is the state, not the shape.
    case "DisposalPolicyError":
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
    // The warehouse list (0058). Three refusals rather than one, because a client does
    // three different things with them: pick again from the list, pick a different depot,
    // or wait for the list to sync. A 422 for the third would send a rep hunting a typo
    // in an id that was never checked against anything.
    case "UnknownWarehouseError":
      return new ApiError("validation_failed", message);
    case "WarehouseInactiveError":
      return new ApiError("conflict", message);
    case "WarehouseListUnsyncedError":
      return new ApiError("upstream_unavailable", message);

    // Call plans (0015/0016).
    case "TargetOutsideTerritoryError":
      return new ApiError("outside_territory", message);
    // `PlanFrozenError` really does mean the plan is closed to change; the transition
    // error does not, and shared the title with it.
    case "PlanFrozenError":
      return new ApiError("plan_final", message);
    case "InvalidPlanTransitionError":
      return new ApiError("invalid_transition", message);
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
    // The endpoint probe (0034, 0045). Six refusals, each a different instruction to the
    // administrator: the endpoint is gone; the rep asking is gone; one is already running;
    // you asked about THIS endpoint too recently; your tenant has spent its probe budget for
    // the window; the number you tried to set is out of range. A 500 for any of them would
    // be the API reporting its own surprise at a rule it enforces.
    case "EndpointNotFoundError":
    // Also a 404, and a separate class on purpose: "the endpoint is not here" and "the rep
    // asking is not here" send an administrator to look at different things.
    case "ProbeRequesterNotFoundError":
      return new ApiError("not_found", message);
    case "ProbeInFlightError":
      return new ApiError("conflict", message);
    case "ProbeCooldownError":
    // 0045's tenant-wide total, which the cooldown's per-endpoint scope deliberately cannot
    // see. Also 429 and also rate limiting — the state of the system is fine, only the pace
    // is not — and a separate class because the two ask for different actions: one says wait
    // for THIS endpoint, the other says the tenant has spent its window across all of them.
    // Both messages carry the moment a retry becomes legal, which is the actionable half.
    case "ProbeBudgetExceededError":
      return new ApiError("too_many_requests", message);
    case "InvalidProbeCooldownError":
    case "InvalidProbeBudgetError":
      return new ApiError("validation_failed", message);
    // 0060. A no-op amendment, a direct write to a column that is a projection of the
    // endpoint's change log, a rewrite of who opened the route, an endpoint created with no
    // author: every one of them is a well-formed request the endpoint's own state refuses,
    // which is the reading `conflict` carries for `lot_expired` and `insufficient_stock`
    // too. `InvalidEndpointError` below stays a 422, because that one is about what the
    // operator typed.
    case "EndpointAmendmentError":
    // 0062. Every `four-eyes-*` refusal, and every refusal to re-decide or rewrite a
    // proposal. All of them are well-formed requests that the state refuses — the change
    // takes two people and nobody has agreed, the approval was for another row or another
    // value, it has already been spent, somebody decided a moment earlier — and the last of
    // those is a RACE as often as a mistake: two approvers clicking at once is the ordinary
    // case. `conflict` is the reading that carries, and the message is the trigger's, because
    // every one of them names what to do next.
    case "ConfigFourEyesError":
    case "ConfigProposalError":
      return new ApiError("conflict", message);
    // Not a conflict and not an error the state produced: there is no rule requiring a second
    // person for this change, so the remedy is cheerful — make it. 422, because what was
    // wrong is what was asked for.
    case "NoFourEyesRuleError":
      return new ApiError("validation_failed", message);
    case "ConfigProposalNotFoundError":
      return new ApiError("not_found", message);
    // And this one is OURS, not the caller's: a missing `reason` in a request body is refused
    // by the route's own schema long before the database sees it, so reaching the trigger's
    // refusal means a route forgot to open an attribution block. 500 is the honest answer;
    // dressing it as a 422 would send an administrator looking for something to retype.
    //
    // WITHOUT THE MESSAGE, deliberately. The trigger's sentence names `crm.notification_policy`
    // and tells the reader to call `withAttribution`, which is exactly the internal detail this
    // file refuses to put in a 500 — there is a test asserting no 500 body matches `crm.` — and
    // it is advice for whoever is reading the server log, not for the caller.
    case "UnattributedChangeError":
      return new ApiError("internal", "an unexpected error occurred");
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
    // Same fact as the two above, so the same type. It answered a bare `conflict`, which
    // was not wrong — just less than the client could have been told, and inconsistent
    // with two sibling state machines in the same API.
    case "InvalidExpenseClaimTransitionError":
      return new ApiError("invalid_transition", message);
    // A rep with no `erp_employee_id` cannot be the subject of an ERP Expense. A
    // configuration gap in the mapping table ADR-0001 Q3 exists for, not a bad request —
    // but the caller can do nothing with a 500, and an administrator can act on this.
    case "RepNotMappedToEmployeeError":
    case "MissingAccountSnapshotError":
    case "ApprovalFieldsError":
    case "RejectionFieldsError":
    case "MissingErpExpenseIdError":
    // The claim's ERP write is in `crm.outbox` and the ERP refused it permanently, so the
    // posting is refused rather than marked done against a write that will never land. A
    // conflict and not an upstream failure: the request is well formed, the ERP answered
    // definitively, and a 503 would invite exactly the retry that cannot work. The message
    // names the outbox row and the route that re-queues it, so it travels intact.
    case "ErpWriteDeadLetteredError":
      return new ApiError("conflict", message);
    case "InvalidAmountError":
    case "InvalidCurrencyError":
    case "InvalidDateError":
    case "InvalidAccountCodeError":
    case "InvalidCategoryError":
      return new ApiError("validation_failed", message);

    // Attachments (0033, @crm/storage). A signature is a doctor's biometric-adjacent
    // personal data and a receipt may be commercially sensitive, so "missing" and "not
    // yours" are ONE answer — whether a colleague holds a named doctor's signature is
    // itself information about that colleague's work.
    case "AttachmentNotFoundError":
    case "AttachmentSubjectNotFoundError":
      return new ApiError("not_found", message);
    // Forbidden and not another 404: the route's own 404 gate ran first, so the caller has
    // already named a subject they can see and there is nothing left to conceal. The
    // `TransferNotSenderError` reasoning — "it does not exist" would be a lie they can
    // check.
    case "AttachmentForbiddenError":
      return new ApiError("forbidden", message);
    case "SignatureCommitmentMismatchError":
      return new ApiError("signature_mismatch", message);
    // Well-formed requests the subject's state refuses. `MissingSignatureCommitment` is
    // distinct from a mismatch: that transaction never claimed a signature, where a
    // mismatch says "wrong picture".
    case "MissingSignatureCommitmentError":
    case "AttachmentNotSupersedableError":
    case "AttachmentSupersessionError":
    case "AttachmentIdReusedError":
    case "AttachmentImmutableError":
    // 0040. A 409 like its neighbours, and its own case so the sentence survives: the
    // remedy is not a supersession error's "re-read the current attachment and start
    // again" but "file a new claim", and the message names the state the claim is in.
    case "ReceiptClaimStateError":
      return new ApiError("conflict", message);
    // The request's own fields contradict each other — declared size, digest or type
    // against the bytes actually sent — which is what a 422 with `errors` renders inline.
    // NOT 415 for the content-type case: the media type IS accepted, the bytes merely are
    // not that type.
    case "AttachmentContentMismatchError":
    case "AttachmentContentTypeMismatchError":
    case "AttachmentSubjectMismatchError":
    case "InvalidAttachmentContentError":
      return new ApiError("validation_failed", message);
    case "UnsupportedAttachmentTypeError":
      return new ApiError("unsupported_media_type", message);
    case "AttachmentTooLargeError":
      return new ApiError("payload_too_large", message);
    // The metadata row exists and its bytes do not. Impossible on the Postgres backend,
    // where the row and the blob commit together, and the stated cost of the `BlobStore`
    // seam the moment a non-transactional store is wired in. Not a generic 500, because
    // 0033 keeps it as its own refusal precisely so the failure arrives as a stated
    // condition rather than an empty body, and the message names which store to look in.
    case "MissingAttachmentBlobError":
      return new ApiError("upstream_unavailable", message);
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
