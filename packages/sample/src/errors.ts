/**
 * Typed forms of the refusals in 0017/0018/0025.
 *
 * The rules live in the database so that the interactive path and the offline-sync
 * path cannot enforce different ones. These classes exist so a caller can tell an
 * expired lot from an empty bag without matching on message text, and so the API
 * can map each to the right status code.
 */

export class SampleLotNotFoundError extends Error {
  constructor(id: string) {
    super(`no sample lot ${id}`);
    this.name = "SampleLotNotFoundError";
  }
}

/** Not enough on hand. The balance is authoritative; the ledger refused. */
export class InsufficientHoldingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientHoldingError";
  }
}

/** The lot was out of date on the day of the hand-over. */
export class LotExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotExpiredError";
  }
}

/** The lot is quarantined or withdrawn — the recall path. */
export class LotNotReleasedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotNotReleasedError";
  }
}

/** The rep did not cover that account on the day. Same rule as a visit. */
export class OutsideTerritoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutsideTerritoryError";
  }
}

/** A transfer acceptance that does not match the transfer, or is already accepted. */
export class TransferMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferMismatchError";
  }
}

/**
 * The transfer already has its one terminal event: it was accepted, or recalled.
 *
 * A subclass of TransferMismatchError so `instanceof` still groups the transfer
 * refusals, but with its OWN `name`: the API maps by name, and these two want different
 * answers — "too late" is a 409 and "not yours" is a 403. It carried the parent's name
 * when it was written, which was the safe choice before the mapping existed; now that
 * `problems.ts` has a case for each, the name is the useful thing.
 */
export class TransferAlreadySettledError extends TransferMismatchError {
  override readonly name = "TransferAlreadySettledError";
}

/**
 * Someone other than the sender tried to take the material back.
 *
 * Only the sender can: it is their `quantity_in_transit` the recall draws down. A
 * receiver who does not want it is refusing, which is a different act and is not built.
 */
export class TransferNotSenderError extends TransferMismatchError {
  override readonly name = "TransferNotSenderError";
}

/** A disbursement with no recipient name or signature, or a write-off with no reason. */
export class IncompleteRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteRecordError";
  }
}

/** An attempt to edit the ledger or write a balance directly. */
export class LedgerImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerImmutableError";
  }
}

/**
 * A receipt or a return naming a warehouse the CRM's list does not have.
 *
 * The caller's mistake, and answerable: the list is at `GET /v1/samples/warehouses`. Before
 * 0058 there was no list, so any id of the right SHAPE was accepted and the ERP refused the
 * mirrored movement hours later from inside the relay queue — or accepted it against a real
 * warehouse belonging to another site, which is worse because nothing refuses it at all.
 */
export class UnknownWarehouseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownWarehouseError";
  }
}

/** A known depot that is not open. Well-formed request, refused by the warehouse's state. */
export class WarehouseInactiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarehouseInactiveError";
  }
}

/**
 * The warehouse list has never synced for this tenant, so nothing can be validated against it.
 *
 * An INTEGRATION state rather than the caller's error, and kept separate for that reason:
 * answering 422 here would tell a rep their warehouse id is wrong when the truth is that
 * the CRM has not fetched the list yet, and they would go looking for a typo that is not
 * there. Fails closed deliberately — the alternative, accepting any id while the list is
 * empty, is validation that stops validating exactly when the integration is unhealthy.
 */
export class WarehouseListUnsyncedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarehouseListUnsyncedError";
  }
}

/**
 * A change to the disposal SOP parameters that the database refuses (0059).
 *
 * Its own class rather than `SampleCountError`'s generality, because the two refusals it
 * carries want the same HTTP answer for a reason worth stating: both are well-formed
 * requests that the policy's current state refuses — a change to the value already in
 * force, and a direct UPDATE of a row that is a projection of the change log. Neither is
 * the caller mistyping something.
 */
export class DisposalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisposalPolicyError";
  }
}

export class SampleCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleCountError";
  }
}

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
  readonly detail?: string;
}

const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  sample_tx_disbursement_fields:
    "a disbursement must name the account, the recipient and carry a signature hash — handing a drug sample to a prescriber without an acknowledgement is not recordable",
  sample_tx_warehouse_fields: "a receipt or return must name the ERP warehouse it came from or went back to",
  sample_tx_transfer_out_fields: "a transfer must name another rep to send to, and cannot reference a transfer itself",
  sample_tx_transfer_in_fields: "an acceptance must name the sending rep and the transfer_out it accepts",
  sample_tx_transfer_recall_fields:
    "a recall must name the rep the material was sent to and the transfer_out it takes back",
  sample_tx_reason_required: "an adjustment, destruction or write-off must carry a reason",
  sample_tx_recipient_only_on_disbursement:
    "a recipient, signature or visit may only appear on a disbursement",
  sample_lot_drug_needs_expiry:
    "a drug sample lot must have an expiry date — lot tracking exists to answer whether it was in date",
  sample_lot_status_reason: "a quarantined or withdrawn lot must say why",
  // 0059. The route validates all three before the database sees them, so these are the
  // backstop under a caller that is not the route — and the readable sentence matters most
  // exactly there, at a psql prompt.
  disposal_policy_change_reason_check:
    "a change to the disposal policy must say why, in at least ten characters — it is the authority a regulated deadline is set under",
  disposal_policy_change_is_a_change: "a disposal policy change must actually change something",
  disposal_policy_change_grace_days_to_check: "a grace period must be between 0 and 365 days",
  disposal_policy_change_grace_days_from_check: "a grace period must be between 0 and 365 days",
};

/** Recognises the database's refusals. Anything unrecognised passes through unchanged. */
export function translateSampleError(err: unknown): Error {
  const e = err as PgErrorShape;
  const message = e?.message ?? "";

  if (e?.constraint !== undefined && e.constraint in CONSTRAINT_MESSAGES) {
    return new IncompleteRecordError(`${CONSTRAINT_MESSAGES[e.constraint]!} (${e.constraint})`);
  }
  // The structural backstop under the readable check in the apply trigger. Reached
  // only if a future code path bypasses that check, which is exactly when the
  // clearer error matters least and the guarantee matters most.
  if (e?.constraint === "sample_holding_quantity_on_hand_check") {
    return new InsufficientHoldingError(`that movement would drive a holding negative: ${message}`);
  }
  // The index is the backstop under the readable check in the validate trigger: it is
  // reached only when two terminal events race, so it cannot say WHICH one won. Since
  // 0025 there are two of them, and claiming an acceptance here would be a guess.
  if (e?.constraint === "uq_sample_tx_transfer_accepted" || message.includes("uq_sample_tx_transfer_accepted")) {
    return new TransferAlreadySettledError("that transfer already has a terminal event recorded against it");
  }
  if (message.includes("already been accepted") || message.includes("already been recalled")) {
    return new TransferAlreadySettledError(message);
  }
  /**
   * "transfer X already has a Y recorded against it" — 0025's ELSE branch, for a terminal
   * event of a kind the trigger does not recognise.
   *
   * It was matched below as a `TransferMismatchError` (409 conflict), which is the wrong
   * verdict: the sentence says the transfer is SETTLED, by something, and that is
   * `TransferAlreadySettledError`. Matched here instead, above the mismatch group, because
   * the group's `already has a` substring would otherwise claim it first.
   *
   * 0029's `sample_tx_transfer_of_only_settles` makes the branch unreachable in practice —
   * it forbids any kind but `transfer_in`/`transfer_recall` from carrying a `transfer_of`,
   * and it was added VALIDATED, so no pre-existing row can reach it either. The branch and
   * this arm stay anyway: the trigger must not assume a CHECK beside it is still there, and
   * a refusal that fires after someone drops the CHECK should name the right thing.
   */
  if (message.includes("already has a") && message.includes("recorded against it")) {
    return new TransferAlreadySettledError(message);
  }
  if (message.includes("only the sender can take material back")) {
    return new TransferNotSenderError(message);
  }

  if (message.includes("cannot record a")) return new InsufficientHoldingError(message);
  if (message.includes("expired on")) return new LotExpiredError(message);
  if (message.includes("and cannot be disbursed")) return new LotNotReleasedError(message);
  if (message.includes("did not cover account")) return new OutsideTerritoryError(message);
  if (message.includes("is not this rep's visit")) return new TransferMismatchError(message);
  if (
    message.includes("acceptance must match") ||
    message.includes("must take back exactly what was sent") ||
    message.includes("cannot accept it from") ||
    message.includes("must name the rep it was sent to") ||
    (message.includes("is a ") && message.includes("not a transfer_out")) ||
    message.includes("transfer_of")
  ) {
    return new TransferMismatchError(message);
  }
  if (message.includes("append-only") || message.includes("cannot be written directly")) {
    return new LedgerImmutableError(message);
  }
  if (message.includes("sample count")) return new SampleCountError(message);
  // 0059, and ABOVE nothing in particular — but below the `append-only` arm, deliberately:
  // an attempt to edit the history is `LedgerImmutableError` like every other append-only
  // refusal in this schema, and only the policy's own two refusals belong here.
  if (
    message.includes("disposal policy change changes nothing") ||
    message.includes("crm.disposal_policy is derived from") ||
    message.includes("a disposal policy is created at the defaults")
  ) {
    return new DisposalPolicyError(message);
  }

  return err instanceof Error ? err : new Error(String(err));
}
