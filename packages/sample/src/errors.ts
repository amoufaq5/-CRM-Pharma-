/**
 * Typed forms of the refusals in 0017/0018.
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
  sample_tx_reason_required: "an adjustment, destruction or write-off must carry a reason",
  sample_tx_recipient_only_on_disbursement:
    "a recipient, signature or visit may only appear on a disbursement",
  sample_lot_drug_needs_expiry:
    "a drug sample lot must have an expiry date — lot tracking exists to answer whether it was in date",
  sample_lot_status_reason: "a quarantined or withdrawn lot must say why",
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
  if (e?.constraint === "uq_sample_tx_transfer_accepted" || message.includes("uq_sample_tx_transfer_accepted")) {
    return new TransferMismatchError("that transfer has already been accepted");
  }

  if (message.includes("cannot record a")) return new InsufficientHoldingError(message);
  if (message.includes("expired on")) return new LotExpiredError(message);
  if (message.includes("and cannot be disbursed")) return new LotNotReleasedError(message);
  if (message.includes("did not cover account")) return new OutsideTerritoryError(message);
  if (message.includes("is not this rep's visit")) return new TransferMismatchError(message);
  if (
    message.includes("acceptance must match") ||
    message.includes("cannot accept it from") ||
    message.includes("is a ") && message.includes("not a transfer_out") ||
    message.includes("transfer_of")
  ) {
    return new TransferMismatchError(message);
  }
  if (message.includes("append-only") || message.includes("cannot be written directly")) {
    return new LedgerImmutableError(message);
  }
  if (message.includes("sample count")) return new SampleCountError(message);

  return err instanceof Error ? err : new Error(String(err));
}
