/**
 * What a failed row MEANS for a queue that has to drain itself unattended.
 *
 * This is the decision an offline client gets wrong by default. The lazy readings are
 * "retry everything" — which spins forever on a visit the server will never accept, and
 * keeps hammering a tenant that no longer exists — and "drop what failed", which loses a
 * rep's call report because a lot expired. Both are silent. So every refusal the API can
 * answer with is classified here, once, by hand, and the classification is the thing the
 * tests pin.
 *
 * The vocabulary is `ProblemKind` in `packages/api/src/problems.ts`, and two of its
 * comments are instructions to this file:
 *
 *   - `tenant_deleted` — "an offline client holding a queue of unsent visits needs to
 *     stop retrying and say so rather than spin on a refusal it reads as transient
 *     permissions". That is `stop`, and it is the only disposition that halts the queue
 *     as a whole rather than one row.
 *   - `signature_mismatch` — "re-sending the same bytes can never work". Permanent.
 */

export const DISPOSITIONS = ["accepted", "retry", "permanent", "reauthenticate", "stop"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * Transient: the request was fine and the server was not. These are the only kinds that
 * earn another attempt, because an attempt that cannot succeed is not a retry, it is a
 * loop.
 */
const TRANSIENT = new Set(["internal", "upstream_unavailable", "too_many_requests"]);

/**
 * Permanent for THIS row: the server understood it and refuses it. Retrying the identical
 * body cannot change the answer, so the row leaves the queue and is surfaced for a human
 * — never dropped silently, because a rejected visit is still a visit that happened.
 */
const PERMANENT = new Set([
  "validation_failed",
  "forbidden",
  "not_found",
  "conflict",
  "outside_territory",
  "visit_final",
  "plan_final",
  "invalid_transition",
  "lot_expired",
  "insufficient_stock",
  "last_administrator",
  "unmapped_category",
  "signature_mismatch",
  "method_not_allowed",
  "unsupported_media_type",
  "payload_too_large",
]);

export interface RowOutcome {
  readonly disposition: Disposition;
  /** Why, in one phrase, for the queue's own record and for the screen. */
  readonly reason: string;
}

/**
 * One row's verdict from a sync response.
 *
 * An UNKNOWN kind is `permanent`, and that choice is the conservative one in the
 * direction that matters: a new refusal the client has never heard of is far more likely
 * to be a rule it is breaking than a server hiccup, and treating it as transient would
 * put a row in an infinite loop against a server that will never take it. The row is
 * surfaced by name, so a kind added to the API shows up as "the server refused this and
 * this client does not understand why" — which is a bug report, not a silence.
 */
export function classifyRowOutcome(row: {
  readonly ok: boolean;
  readonly type?: string | undefined;
  readonly error?: string | undefined;
}): RowOutcome {
  if (row.ok) return { disposition: "accepted", reason: "accepted" };

  const kind = row.type ?? "";
  const detail = row.error ?? "";

  if (kind === "tenant_deleted") {
    return {
      disposition: "stop",
      reason: detail === "" ? "this tenant has been deleted in the ERP" : detail,
    };
  }
  if (kind === "unauthenticated") {
    return { disposition: "reauthenticate", reason: detail === "" ? "the session expired" : detail };
  }
  if (TRANSIENT.has(kind)) {
    return { disposition: "retry", reason: detail === "" ? `${kind}, retrying` : detail };
  }
  if (PERMANENT.has(kind)) {
    return { disposition: "permanent", reason: detail === "" ? kind : detail };
  }
  return {
    disposition: "permanent",
    reason:
      detail === ""
        ? `the server refused this with "${kind}", which this client does not recognise`
        : `${detail} (unrecognised refusal "${kind}")`,
  };
}

/**
 * A whole-batch failure: the request never got a per-row answer.
 *
 * Nothing in the batch was necessarily rejected — a 503 or a dropped connection says
 * NOTHING about the rows — so every one of them stays queued. The upsert-by-device-id is
 * what makes that safe: re-sending a visit the server did in fact accept collapses onto
 * the same row.
 */
export function classifyTransportOutcome(outcome:
  | { readonly kind: "network" }
  | { readonly kind: "status"; readonly status: number; readonly problemKind?: string | undefined; readonly detail?: string | undefined }): RowOutcome {
  if (outcome.kind === "network") {
    return { disposition: "retry", reason: "offline or unreachable" };
  }
  const { status } = outcome;
  const kind = outcome.problemKind ?? "";
  const detail = outcome.detail ?? "";

  if (kind === "tenant_deleted") {
    return { disposition: "stop", reason: detail === "" ? "this tenant has been deleted in the ERP" : detail };
  }
  if (status === 401) {
    return { disposition: "reauthenticate", reason: detail === "" ? "the session expired" : detail };
  }
  // 408 and 429 are "ask again", and 5xx is the server's problem rather than the body's.
  if (status === 408 || status === 429 || status >= 500) {
    return { disposition: "retry", reason: detail === "" ? `HTTP ${status}` : detail };
  }
  // Any other 4xx against the BATCH — a malformed envelope, a body over the cap, a
  // revoked role — will answer the same way next time, so it is not a retry. The rows
  // keep their places and the reason is shown, because the fix is a person's.
  return { disposition: "permanent", reason: detail === "" ? `HTTP ${status}` : detail };
}
