/**
 * Typed forms of the refusals in 0033, plus the three this layer makes itself.
 *
 * The rules live in the database for the reason every other package in this repo gives
 * (`packages/sample/src/errors.ts`, `packages/expense/src/errors.ts`): the interactive
 * route and a future offline flush must enforce one rule, not two, and a second
 * implementation in TypeScript would eventually disagree with the one that actually
 * decides. So these classes TRANSLATE rather than re-check — except where the check is
 * cheaper and kinder before half a megabyte crosses the wire, which is why size, base64
 * validity and the content-type allow-list are refused here as well.
 *
 * These are mapped by NAME in `packages/api/src/problems.ts`, and the mapping is what
 * decides whether a refusal reaches a client as its own status or as "an unexpected error
 * occurred". NOTHING IN THIS PACKAGE IS MAPPED YET: `problems.test.ts` asserts the mapping
 * structurally, but only over the modules named in its own list, and `@crm/storage` is not
 * in it — the package is reachable from no route (ADR-0001's open table). Adding it there
 * is part of wiring these routes, not a later tidy-up, and until it happens every class
 * below is a 500.
 *
 * Every class takes arguments that survive `new C("x", "y")`, because that is literally how
 * `problems.test.ts` discovers them: it constructs each exported function whose name ends
 * in `Error` and keeps the ones that come back as an `Error` naming themselves. A
 * constructor that throws on those arguments is skipped in silence, so it would be exempt
 * from the very gate this comment relies on.
 */

import { ATTACHMENT_CONTENT_TYPES } from "./subjects.js";

interface PgErrorShape {
  readonly message?: string;
  readonly constraint?: string;
  readonly code?: string;
}

/**
 * No such attachment — or one the caller may not see, which is deliberately the same
 * answer.
 *
 * The house convention for every record scoped by supervision (`requireVisiblePlan`,
 * `requireSupervision`): whether a colleague's attachment exists is itself information
 * about that colleague's work, so the refusal does not distinguish. It matters more here
 * than elsewhere, because what would leak is the existence of a named doctor's signature.
 */
export class AttachmentNotFoundError extends Error {
  constructor(id: string) {
    super(`no attachment ${id}`);
    this.name = "AttachmentNotFoundError";
  }
}

/** The subject row the attachment would hang off does not exist. */
export class AttachmentSubjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSubjectNotFoundError";
  }
}

/**
 * A subject table `crm.attachment_subject_rep` has no branch for.
 *
 * Fail-closed, and the opposite of the equivalent case in `crm.notification_subject_open`
 * (0024), which reads an unknown table as "not open" so its notifications prune. There
 * the failure being fixed is unbounded growth; here it is disclosure of a third party's
 * personal data, so an attachment nobody owns is one nobody may read — and therefore one
 * nobody may create.
 */
export class UnknownAttachmentSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAttachmentSubjectError";
  }
}

/**
 * The uploader neither owns the subject record nor supervises the rep who does.
 *
 * A 403 rather than the 404 a read gets: the caller already named a subject they can see,
 * so there is nothing left to conceal and "it does not exist" would be a lie they can
 * check.
 */
export class AttachmentForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentForbiddenError";
  }
}

/**
 * THE refusal this whole subsystem exists for: the image does not hash to the signature
 * the ledger committed to.
 *
 * A stored blob that disagrees with its commitment is worse than no blob at all — it
 * looks like evidence, reads like evidence, and is evidence of nothing, and the person who
 * finds out is whoever was relying on it in an inspection. It is also indistinguishable
 * from a deliberate swap.
 *
 * Its own class, and it should keep its own problem type, because a client must act on it
 * differently from every other conflict: re-sending the same bytes will never work, and
 * the right next step is to look at which capture was uploaded, not to retry.
 */
export class SignatureCommitmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureCommitmentMismatchError";
  }
}

/**
 * The sample transaction records no `signature_sha256`, so there is no commitment to
 * satisfy.
 *
 * Distinct from a mismatch: nothing is wrong with the image, the ledger row simply is not
 * one that claims a signature was taken (0017 requires one only for a disbursement). A
 * mismatch says "that is the wrong picture"; this says "that record never had one".
 */
export class MissingSignatureCommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSignatureCommitmentError";
  }
}

/**
 * The purpose and the subject table do not pair.
 *
 * Unreachable through this store — `putAttachment` derives the table from the purpose and
 * never takes it from a caller — and reachable from SQL, which is why 0033 carries both a
 * CHECK and an arm in the trigger. It is not cosmetic: a `disbursement_signature` pointed
 * at an expense claim would look up a commitment in the wrong table, find nothing, and be
 * refused as "that record never had a signature" — a true sentence about the wrong
 * question.
 */
export class AttachmentSubjectMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSubjectMismatchError";
  }
}

/** A signature cannot be replaced. See `SUPERSEDABLE_PURPOSES` for why. */
export class AttachmentNotSupersedableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentNotSupersedableError";
  }
}

/**
 * A replacement that does not hold together: a different subject, a row already
 * superseded, a chain that does not point back, or byte-identical content.
 *
 * One class for the four because a caller's remedy is the same in each — re-read the
 * current attachment and start again — and the message says which it was.
 */
export class AttachmentSupersessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSupersessionError";
  }
}

/**
 * An attempted UPDATE or DELETE the append-only triggers refuse.
 *
 * Reachable from a writer that goes around this store, which is exactly when the
 * guarantee matters and the readable message matters least — so it is translated rather
 * than left as a constraint violation.
 */
export class AttachmentImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentImmutableError";
  }
}

/** The stored octets disagree with the size, digest or backend the metadata row declares. */
export class AttachmentContentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentContentMismatchError";
  }
}

/**
 * The declared `content_type` and the leading magic bytes disagree.
 *
 * Its own class because it is the one of these a client can fix by sending a different
 * header, and because it is the check that stops a PDF being served to a browser as a
 * PNG. The sniff itself lives only in SQL (0033) — one implementation, so there is
 * nothing to drift.
 */
export class AttachmentContentTypeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentContentTypeMismatchError";
  }
}

/**
 * The device-minted id is already in use for different bytes.
 *
 * A retried offline upload of the SAME capture collapses into the row already there — the
 * guarantee README rule 7 exists for. The same id carrying different bytes is not a retry,
 * it is the swap this table is built to make impossible, and it is refused by name so the
 * two do not read alike.
 */
export class AttachmentIdReusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentIdReusedError";
  }
}

/**
 * Over the cap.
 *
 * Refused here rather than only by the schema because the error has to be a 413 naming
 * the limit, and a CHECK violation arriving from the database cannot say what to do about
 * it. The number itself is derived, not chosen — see `MAX_ATTACHMENT_BYTES`.
 */
export class AttachmentTooLargeError extends Error {
  constructor(
    readonly byteSize: number,
    readonly maxBytes: number,
  ) {
    super(
      `attachment is ${byteSize} bytes and the limit is ${maxBytes}. The cap follows from ` +
        `the API's 1 MiB JSON body limit and base64's 4/3 expansion, not from storage — ` +
        `downscale the image on the device.`,
    );
    this.name = "AttachmentTooLargeError";
  }
}

/** Empty, or not valid base64. */
export class InvalidAttachmentContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentContentError";
  }
}

/**
 * A content type outside the allow-list.
 *
 * It reads `ATTACHMENT_CONTENT_TYPES` itself rather than being handed the list. Passing it
 * in read better and made this the one class `problems.test.ts` could not discover: that
 * gate constructs every exported `*Error` as `new C("x", "y")`, a string is not an array,
 * `allowed.join` threw, and a constructor that throws there is skipped in silence — so the
 * single refusal in this package a client must act on by sending a different header was
 * exempt from the check that it maps to anything at all.
 */
export class UnsupportedAttachmentTypeError extends Error {
  constructor(readonly contentType: string) {
    super(
      `content type ${JSON.stringify(contentType)} is not stored here; this system accepts ` +
        `${ATTACHMENT_CONTENT_TYPES.join(", ")}. SVG is excluded deliberately — it is a ` +
        `script container.`,
    );
    this.name = "UnsupportedAttachmentTypeError";
  }
}

/**
 * The metadata row exists and its bytes do not.
 *
 * Impossible on the Postgres backend, where the row and the blob commit together, and
 * possible the moment a `BlobStore` that is not transactional is wired in — which is the
 * cost 0033's header names. Kept as its own refusal so that failure arrives as a stated
 * condition rather than as an empty body.
 */
export class MissingAttachmentBlobError extends Error {
  constructor(id: string, backend: string) {
    super(
      `attachment ${id} declares backend ${JSON.stringify(backend)} and that store holds no ` +
        `bytes for it — the metadata row and its blob have diverged`,
    );
    this.name = "MissingAttachmentBlobError";
  }
}

/**
 * Translates a Postgres refusal from 0033 into one of the classes above.
 *
 * Matched on the message text the trigger raised, as every other package here does. The
 * order is load-bearing in two places and both are commented, because a substring that
 * claims a message first silently retires the arm below it — a mistake
 * `translateSampleError` records having made.
 */
export function translateAttachmentError(err: unknown): Error {
  // ALREADY TRANSLATED ERRORS PASS THROUGH UNTOUCHED, and this guard is load-bearing
  // rather than tidy. Without it a second pass re-matches this package's OWN sentences as
  // though they came from Postgres, and three of them would be remapped: the signature
  // finality refusal says "append-only" and became an immutability error, the reused-id
  // refusal says the same, and `markSuperseded`'s "no current attachment to supersede"
  // became a 404. Translation has to be idempotent, because a store that translates and a
  // route that translates again is the normal arrangement here.
  if (err instanceof Error && TRANSLATED_NAMES.has(err.name)) return err;

  const e = err as PgErrorShape;
  const message = e?.message ?? "";

  // A second `current` attachment for one subject. The partial unique index is the
  // backstop under the supersession rules; reaching it means two uploads raced, so it
  // cannot say which won and does not guess.
  if (e?.constraint === "uq_attachment_current" || message.includes("uq_attachment_current")) {
    return new AttachmentSupersessionError(
      `that subject already has a current attachment of this purpose — supersede it with a reason ` +
        `rather than adding a second`,
    );
  }
  if (e?.constraint === "attachment_pkey" || message.includes("attachment_pkey")) {
    return new AttachmentIdReusedError(
      `attachment id is already in use — a retried upload of the same capture collapses into the ` +
        `row already there, so this is a different capture under a reused id`,
    );
  }

  if (message.includes("has no branch for subject table")) {
    return new UnknownAttachmentSubjectError(message);
  }
  if (message.includes("an attachment cannot be created for a subject that does not exist")) {
    return new AttachmentSubjectNotFoundError(message);
  }
  if (message.includes("neither owns nor supervises")) {
    return new AttachmentForbiddenError(message);
  }
  if (message.includes("hangs off")) {
    return new AttachmentSubjectMismatchError(message);
  }
  if (message.includes("records no signature_sha256")) {
    return new MissingSignatureCommitmentError(message);
  }
  if (message.includes("a stored signature that disagrees with the commitment")) {
    return new SignatureCommitmentMismatchError(message);
  }
  // BEFORE the supersession arm below: that one matches "cannot be superseded by", and
  // this message contains "cannot be superseded" — so the general arm would claim it and
  // a rep would be told their receipt was mispaired rather than that a signature is final.
  if (message.includes("a disbursement signature cannot be superseded")) {
    return new AttachmentNotSupersedableError(message);
  }
  if (
    message.includes("so it cannot be superseded by") ||
    message.includes("as its successor") ||
    message.includes("supersedes nothing")
  ) {
    return new AttachmentSupersessionError(message);
  }
  if (message.includes("to supersede") || message.includes("to store bytes for")) {
    return new AttachmentNotFoundError(message);
  }
  // Unreachable under RLS — the trigger's SELECT would not have found the row — and kept
  // because the trigger must not assume the policy above it is still there.
  if (message.includes("belongs to another tenant")) {
    return new AttachmentNotFoundError(message);
  }
  if (message.includes("and the bytes do not begin like one")) {
    return new AttachmentContentTypeMismatchError(message);
  }
  if (
    message.includes("declares sha256") ||
    message.includes("bytes and these are") ||
    message.includes("so its bytes do not live in this table")
  ) {
    return new AttachmentContentMismatchError(message);
  }
  if (
    message.includes("append-only") ||
    message.includes("write-once") ||
    message.includes("the only permitted update") ||
    message.includes("may set only")
  ) {
    return new AttachmentImmutableError(message);
  }

  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The names `translateAttachmentError` refuses to re-translate.
 *
 * Listed rather than derived from `instanceof`, for the reason `problems.ts` gives about
 * mapping by name: an `instanceof` across package boundaries breaks the moment two copies
 * of a module exist, and this guard has to hold in exactly that case.
 */
const TRANSLATED_NAMES: ReadonlySet<string> = new Set([
  "AttachmentContentMismatchError",
  "AttachmentContentTypeMismatchError",
  "AttachmentForbiddenError",
  "AttachmentIdReusedError",
  "AttachmentImmutableError",
  "AttachmentNotFoundError",
  "AttachmentNotSupersedableError",
  "AttachmentSubjectMismatchError",
  "AttachmentSubjectNotFoundError",
  "AttachmentSupersessionError",
  "AttachmentTooLargeError",
  "InvalidAttachmentContentError",
  "MissingAttachmentBlobError",
  "MissingSignatureCommitmentError",
  "SignatureCommitmentMismatchError",
  "UnknownAttachmentSubjectError",
  "UnsupportedAttachmentTypeError",
]);
