import { ErpError } from "@crm/acl";

/**
 * What the relay should do with an outbox row after one dispatch attempt.
 *
 * `retry_ordering` and `retry_period` are distinguished from `retry_transient`
 * because they wait on entirely different things — a sibling row landing, versus
 * an accountant opening next month — and collapsing them into one backoff curve
 * would either hammer the ERP or park an order for a day.
 */
export type OutcomeKind =
  | "delivered"
  | "already_delivered"
  | "retry_transient"
  | "retry_ordering"
  | "retry_period"
  | "dead";

export interface Outcome {
  readonly kind: OutcomeKind;
  readonly reason: string;
}

/**
 * ERP write-guard codes. All of these arrive as HTTP **422** carrying the
 * handler's bare `{error, detail}` body, so the status alone cannot tell them
 * apart — `period_locked` (wait and retry) and `unbalanced_journal_entry` (our
 * bug, never retry) are the same status. Classification is therefore on the
 * CODE, and that is the single most important thing in this file.
 *
 * Sources: `operate-runtime/src/write-guards.ts`.
 */
const GUARD_PERIOD_LOCKED = "period_locked";
const GUARD_FATAL = new Set([
  "unbalanced_journal_entry", // debits != credits — we built the entry wrong
  "empty_journal_entry", // no lines — we built the entry wrong
  "document_locked", // posted-entry immutability; will never re-open
  "document_locked_lines",
  "validation_failed", // schema rejection; the payload is wrong, not late
]);

/**
 * Postgres/ERP signals that the record already exists — a replay, not a failure.
 *
 * KEPT, and deliberately. The live server answers a duplicate record id
 * `500 {"error":"write_failed","detail":"duplicate key value violates unique
 * constraint …"}` because `operate-runtime/src/handlers.ts` forwards the driver's
 * message verbatim, so today this regex alone settles a redelivery, for free and
 * without a second request. What it is NOT is evidence: it reads a sentence the
 * platform never promised to keep, and it cannot tell a collision on OUR id from a
 * collision on some other unique column — a duplicate `invoice_number` would match
 * this and mean the write never landed.
 *
 * So it is now the fallback, not the mechanism: it answers only when the probe
 * could not (see `TargetConfirmedAbsentError`), and for the operations the probe
 * cannot speak for at all.
 */
const ALREADY_EXISTS = /duplicate key|already exists|unique constraint|idempotenc/i;

/**
 * A dispatch read the target record back and the ERP HOLDS it: a previous attempt
 * landed and its response was lost.
 *
 * Minted by `dispatch`, never by the ERP. The ERP's own duplicate-key answer is a
 * 500 that says nothing about the record; this says something about the record,
 * which is why it exists as a distinct type rather than as a synthesised 409 —
 * nothing here should pretend the platform answered something it did not.
 *
 * PACKAGE-PRIVATE, and absent from the barrel on purpose: it and
 * `TargetConfirmedAbsentError` are minted by `dispatch` and consumed by `classify` in this
 * file, and neither is ever thrown past the relay's edge. So neither has a problem mapping,
 * and `problems.test.ts` asserts they stay unexported rather than merely noticing they are
 * — exporting one would force the mapping decision instead of silently becoming a 500.
 */
export class TargetAlreadyPresentError extends Error {
  constructor(
    readonly recordId: string,
    readonly writeError: unknown,
  ) {
    super(`the ERP holds ${recordId}: an earlier attempt landed and its response was lost`);
    this.name = "TargetAlreadyPresentError";
  }
}

/**
 * A dispatch read the target record back and the ERP does NOT hold it: whatever
 * the write error said, the write did not land.
 *
 * Carries the original failure, which is what actually gets classified — the
 * absence only decides that no existence GUESS may override it.
 */
export class TargetConfirmedAbsentError extends Error {
  constructor(
    readonly recordId: string,
    readonly writeError: unknown,
  ) {
    super(`the ERP does not hold ${recordId}: the write did not land`);
    this.name = "TargetConfirmedAbsentError";
  }
}

/**
 * Whether a write failure leaves it unknown what happened to the record.
 *
 * The line is drawn on whether we were TOLD an outcome, not on a list of ERP
 * codes. Below 500 the ERP made a decision and reported it: 401, 403, 404, 409,
 * 422 and 429 each state what happened, and reading the record back could only
 * confirm what we already have. At 500 and above the server failed to describe its
 * own outcome — `write_failed` is emitted by a `catch` around the write unit
 * itself, which is as close to "I do not know" as a server gets. And a failure
 * that is not an `ErpError` at all — a reset mid-flight, the client-side timeout
 * before any body was read — says least of all: the write may have been executed
 * and the answer lost.
 *
 * Enumerating codes instead would be the same defect one layer up from the one
 * this closes. The leak dependency exists because a classification was built on
 * knowledge of the platform's internals that the platform never promised; a
 * hand-maintained list of its 5xx codes would break the same way, silently, in the
 * same expensive direction.
 */
export function isAmbiguousWriteFailure(error: unknown): boolean {
  if (!(error instanceof ErpError)) return true;
  return error.status >= 500;
}

/**
 * The ERP's code for "that transition cannot fire from this state".
 *
 * Named rather than inlined because it is the one 409 that must NOT be read as a
 * delivered write — see the branch that uses it.
 */
const INVALID_TRANSITION = "invalid_transition";

export interface ClassifyInput {
  readonly error: unknown;
  /** True when this row drives a lifecycle transition rather than a create. */
  readonly isTransition: boolean;
}

/**
 * Classifies one dispatch failure.
 *
 * The bias throughout is that an ambiguous failure retries rather than dies:
 * a dead-lettered write is invisible until someone reads a dashboard, while a
 * retried one costs a request. The exceptions are failures we know cannot fix
 * themselves — a malformed payload, a permission we do not hold, an immutable
 * document — where retrying forever only hides the problem.
 */
export function classify(input: ClassifyInput): Outcome {
  if (input.error instanceof TargetAlreadyPresentError) {
    return {
      kind: "already_delivered",
      reason:
        `the ERP already holds ${input.error.recordId} — read back from the ERP, ` +
        `not inferred from the error text`,
    };
  }

  if (input.error instanceof TargetConfirmedAbsentError) {
    // The probe outranks the regex, and this is where that happens. Without the
    // suppression the override would be inert: the error a probe runs on is usually
    // the very duplicate-key sentence `ALREADY_EXISTS` matches, so classifying the
    // inner failure normally would hand back `already_delivered` for a record the
    // ERP demonstrably does not have. An answer beats a guess; a guess that
    // contradicts an answer is simply wrong.
    const inner = classifyFailure(input.error.writeError, input.isTransition, true);
    return {
      kind: inner.kind,
      reason: `${inner.reason} — and the ERP does not hold ${input.error.recordId}, so the write did not land`,
    };
  }

  return classifyFailure(input.error, input.isTransition, false);
}

function classifyFailure(error: unknown, isTransition: boolean, targetConfirmedAbsent: boolean): Outcome {
  const err = error;

  if (!(err instanceof ErpError)) {
    // A socket reset, a DNS blip, a bug in our own dispatch code. Retrying a
    // network fault is right; retrying our bug is merely wasteful, and the
    // attempt cap ends it.
    return { kind: "retry_transient", reason: `non-ERP error: ${String(err).slice(0, 200)}` };
  }

  if (err.code === GUARD_PERIOD_LOCKED) {
    // ADR-0001 item 11. A late claim against a closed month is ROUTINE, not an
    // error: the entry is correct and the period simply is not open yet. Dead-
    // lettering it would silently drop legitimate spend, so it waits.
    return { kind: "retry_period", reason: err.detail ?? "fiscal period locked" };
  }

  if (GUARD_FATAL.has(err.code)) {
    return { kind: "dead", reason: `${err.code}: ${err.detail ?? "write guard refused"}` };
  }

  // A 409 FROM A TRANSITION IS NOT A SUCCESS, and reading it as one was a real defect
  // here until an expense-posting chain made it matter.
  //
  // The ERP answers 409 for at least two different things. One is the duplicate target
  // id below, which genuinely means the write landed. The other is
  // `invalid_transition` — `'approve' cannot fire from 'draft'`
  // (operate-runtime/src/handlers.ts) — which means the write did NOT land and never
  // touched the record. Classifying that as `already_delivered` marked the outbox row
  // delivered and dropped the transition silently, with the ERP and the CRM left
  // disagreeing about a record's state and nothing anywhere saying so.
  //
  // Treated as ordering for the same reason a 404 on a transition is: the sibling row
  // that moves the record into the right state is very likely still queued behind this
  // one. If the state is genuinely unreachable — somebody moved the record in the ERP's
  // own UI — the attempt cap ends it and the dead-letter alarm puts it in front of a
  // human, which is the correct destination for a disagreement no retry can settle.
  if (err.code === INVALID_TRANSITION) {
    if (isTransition) {
      return {
        kind: "retry_ordering",
        reason: `the ERP refused this transition from the record's current state (${
          err.detail ?? "no detail"
        }) — a sibling write may not have landed yet`,
      };
    }
    // Not reachable from a create today: only the transition handler emits this code.
    // Dead rather than retried, because a create cannot be waiting on an ordering it
    // does not participate in.
    return { kind: "dead", reason: `invalid_transition on a non-transition write: ${err.detail ?? ""}` };
  }

  if (!targetConfirmedAbsent && (err.kind === "conflict" || ALREADY_EXISTS.test(err.detail ?? ""))) {
    // The deterministic target id already exists at the ERP, so a previous
    // attempt DID land and we never saw the response. The unique constraint on
    // (tenant_id, entity, record_id) is what makes this safe to call success —
    // not the Idempotency-Key header, whose store is in-memory in the deployed
    // binary and dies on restart (report R6).
    //
    // Reached only when nothing better is available: a `create` whose failure was
    // ambiguous has been read back from the ERP first, and lands here only if that
    // read could not answer. `targetConfirmedAbsent` is the case where it answered
    // NO, and an inference from a sentence must not overturn it.
    return { kind: "already_delivered", reason: `already at the ERP: ${err.code}` };
  }

  if (err.kind === "not_found") {
    if (isTransition) {
      // Very likely ordering: the create that this transition acts on has not
      // landed yet. Retrying lets the sibling row catch up. The attempt cap
      // stops it if the record genuinely does not exist.
      return { kind: "retry_ordering", reason: "target record not found (create may not have landed yet)" };
    }
    // A 404 on a create means the ROUTE is wrong — a slug we got from a stale
    // schema, or an entity this tenant is not served. Retrying cannot fix that.
    return { kind: "dead", reason: "route not found — stale slug or entity not served to this tenant" };
  }

  if (err.kind === "forbidden") {
    // RBAC will not change on its own. A missing `controller` role on the
    // service credential (needed to post the expense journal entry) lands here,
    // and it wants a human, not a backoff curve.
    return { kind: "dead", reason: `forbidden: ${err.detail ?? "the service credential lacks the required role"}` };
  }

  if (err.kind === "validation_failed") {
    return { kind: "dead", reason: `rejected: ${err.detail ?? err.code}` };
  }

  if (err.retryable || err.kind === "unauthenticated") {
    // 401 is retryable on purpose: the service token is short-lived, so an
    // expired one is a refresh away rather than a misconfiguration.
    return { kind: "retry_transient", reason: `${err.code}: ${err.detail ?? "transient"}` };
  }

  // Unrecognised. Retry rather than dead-letter — a new ERP error code should
  // not silently drop a rep's order — and let the attempt cap end it.
  return { kind: "retry_transient", reason: `unclassified ${err.status} ${err.code}` };
}

/** Whether a kind means "stop trying" (terminal) or "come back later". */
export function isTerminal(kind: OutcomeKind): boolean {
  return kind === "delivered" || kind === "already_delivered" || kind === "dead";
}
