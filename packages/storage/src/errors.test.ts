import { describe, expect, it } from "vitest";

import { ATTACHMENT_CONTENT_TYPES } from "./subjects.js";
import {
  AttachmentContentMismatchError,
  AttachmentContentTypeMismatchError,
  AttachmentForbiddenError,
  AttachmentIdReusedError,
  AttachmentImmutableError,
  AttachmentNotFoundError,
  AttachmentNotSupersedableError,
  AttachmentSubjectNotFoundError,
  AttachmentSupersessionError,
  AttachmentTooLargeError,
  InvalidAttachmentContentError,
  MissingAttachmentBlobError,
  MissingSignatureCommitmentError,
  ReceiptClaimStateError,
  SignatureCommitmentMismatchError,
  UnknownAttachmentSubjectError,
  UnsupportedAttachmentTypeError,
  translateAttachmentError,
} from "./errors.js";

/**
 * The translator, against the sentences 0033 actually raises.
 *
 * Every string below is copied from the migration, which is the only way this test means
 * anything: a translator matched against sentences invented here would pass while the
 * database said something else. `attachment.contract.test.ts` closes the loop by running
 * the real refusals through the real translator against a live cluster; this file pins the
 * mapping and, more importantly, the ORDER of two arms that would otherwise shadow each
 * other.
 */
describe("translateAttachmentError", () => {
  const pg = (message: string, constraint?: string): unknown =>
    constraint === undefined ? { message } : { message, constraint };

  it("names every error class with its own class name, which is what problems.ts dispatches on", () => {
    const instances: readonly Error[] = [
      new AttachmentNotFoundError("a"),
      new AttachmentSubjectNotFoundError("m"),
      new UnknownAttachmentSubjectError("m"),
      new AttachmentForbiddenError("m"),
      new SignatureCommitmentMismatchError("m"),
      new MissingSignatureCommitmentError("m"),
      new AttachmentNotSupersedableError("m"),
      new AttachmentSupersessionError("m"),
      new AttachmentImmutableError("m"),
      new AttachmentContentMismatchError("m"),
      new AttachmentContentTypeMismatchError("m"),
      new AttachmentIdReusedError("m"),
      new AttachmentTooLargeError(1, 2),
      new InvalidAttachmentContentError("m"),
      new UnsupportedAttachmentTypeError("x"),
      new MissingAttachmentBlobError("a", "postgres"),
      new ReceiptClaimStateError("m"),
    ];
    for (const instance of instances) {
      expect(instance.name, instance.constructor.name).toBe(instance.constructor.name);
    }
    // Deliberately close to the real count: a barrel that stopped exporting its errors
    // would otherwise pass problems.test.ts by exporting none.
    expect(instances.length).toBeGreaterThanOrEqual(16);
  });

  it("maps a missing owner branch to the fail-closed unknown-subject refusal", () => {
    const err = translateAttachmentError(
      pg(
        "crm.attachment_subject_rep has no branch for subject table crm.visit, so no rep owns this attachment and nobody could be authorised to read it",
      ),
    );
    expect(err).toBeInstanceOf(UnknownAttachmentSubjectError);
  });

  it("maps a missing subject row to its own refusal, not to the unknown-table one", () => {
    const err = translateAttachmentError(
      pg(
        "no row 0cb8f5c0-0000-4000-8000-000000000001 in crm.expense_claim — an attachment cannot be created for a subject that does not exist",
      ),
    );
    expect(err).toBeInstanceOf(AttachmentSubjectNotFoundError);
    expect(err).not.toBeInstanceOf(UnknownAttachmentSubjectError);
  });

  it("maps an uploader with no claim on the rep to a forbidden refusal", () => {
    const err = translateAttachmentError(
      pg("rep A neither owns nor supervises rep B, so may not attach to their crm.expense_claim"),
    );
    expect(err).toBeInstanceOf(AttachmentForbiddenError);
  });

  it("maps a ledger row with no commitment separately from a mismatched one", () => {
    expect(
      translateAttachmentError(
        pg("sample transaction X records no signature_sha256, so there is no commitment for an image to satisfy"),
      ),
    ).toBeInstanceOf(MissingSignatureCommitmentError);
  });

  it("maps a commitment mismatch to the refusal the whole table exists for", () => {
    const err = translateAttachmentError(
      pg(
        "this image hashes to aaa, but sample transaction X committed to bbb — refusing: a stored signature that disagrees with the commitment is evidence of nothing, and the ledger is append-only so the commitment cannot be corrected",
      ),
    );
    expect(err).toBeInstanceOf(SignatureCommitmentMismatchError);
    // The sentence has to survive: it names both hashes, which is what the person
    // reconciling the upload needs.
    expect(err.message).toContain("committed to bbb");
  });

  /**
   * The order that matters.
   *
   * The signature refusal contains "cannot be superseded"; the general supersession
   * refusal matches "so it cannot be superseded by". Matched the other way round, a rep
   * replacing a signature would be told their receipt was mispaired — which sends them
   * looking for a subject error that does not exist.
   */
  it("reads a signature's finality as finality, not as a mispaired supersession", () => {
    const err = translateAttachmentError(
      pg(
        "a disbursement signature cannot be superseded: the ledger commitment fixes which image is the signature and cannot be corrected (0018 is append-only). A different signature is a different hand-over — post an adjustment with a reason instead.",
      ),
    );
    expect(err).toBeInstanceOf(AttachmentNotSupersedableError);
    expect(err).not.toBeInstanceOf(AttachmentSupersessionError);
  });

  it("maps a mispaired supersession to the supersession refusal", () => {
    const err = translateAttachmentError(
      pg(
        "attachment A is the expense_receipt of crm.expense_claim C, so it cannot be superseded by the expense_receipt of crm.expense_claim D",
      ),
    );
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
  });

  it("maps a chain that does not point back, and identical bytes, to the supersession refusal", () => {
    for (const message of [
      "attachment A is current and names <NULL> as its successor — mark it superseded by B first, with a reason",
      "attachment A already holds these exact bytes (aaa), so this supersedes nothing",
    ]) {
      expect(translateAttachmentError(pg(message)), message).toBeInstanceOf(AttachmentSupersessionError);
    }
  });

  it("maps a second current attachment to the supersession refusal, by constraint name", () => {
    const err = translateAttachmentError(
      pg('duplicate key value violates unique constraint "uq_attachment_current"', "uq_attachment_current"),
    );
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
    expect(err.message).toContain("supersede it with a reason");
  });

  it("maps a racing duplicate id to the reused-id refusal, by constraint name", () => {
    const err = translateAttachmentError(
      pg('duplicate key value violates unique constraint "attachment_pkey"', "attachment_pkey"),
    );
    expect(err).toBeInstanceOf(AttachmentIdReusedError);
  });

  it("maps a missing supersession target and a missing blob target to not-found", () => {
    for (const message of [
      "no attachment A to supersede",
      "no attachment A to store bytes for",
    ]) {
      expect(translateAttachmentError(pg(message)), message).toBeInstanceOf(AttachmentNotFoundError);
    }
  });

  it("maps a cross-tenant blob write to not-found rather than naming the other tenant", () => {
    const err = translateAttachmentError(pg("attachment A belongs to another tenant"));
    expect(err).toBeInstanceOf(AttachmentNotFoundError);
  });

  it("maps a magic-byte disagreement to its own refusal, because a client can fix the header", () => {
    const err = translateAttachmentError(
      pg(
        "attachment A declares content_type application/pdf and the bytes do not begin like one (leading octets 89504e470d0a1a0a)",
      ),
    );
    expect(err).toBeInstanceOf(AttachmentContentTypeMismatchError);
    expect(err).not.toBeInstanceOf(AttachmentContentMismatchError);
  });

  it("maps a size, digest or backend disagreement to the content-mismatch refusal", () => {
    for (const message of [
      "attachment A declares 10 bytes and these are 11",
      "attachment A declares sha256 aaa and these bytes hash to bbb",
      "attachment A declares storage_backend s3, so its bytes do not live in this table",
    ]) {
      expect(translateAttachmentError(pg(message)), message).toBeInstanceOf(AttachmentContentMismatchError);
    }
  });

  it("maps every append-only and write-once refusal to the immutable error", () => {
    for (const message of [
      "crm.attachment is append-only (attempted DELETE on A). An attachment is the regulated record itself, not a copy of one — supersede it with a reason instead.",
      "crm.attachment_blob is write-once (attempted UPDATE on A). The content hash is a commitment; changing the bytes behind it would make every reference to it a lie.",
      "crm.attachment_access is append-only (attempted DELETE on A)",
      "the only permitted update to crm.attachment is current -> superseded (attempted superseded -> current on A)",
      "superseding attachment A may set only superseded_by_attachment_id, superseded_reason and status",
    ]) {
      expect(translateAttachmentError(pg(message)), message).toBeInstanceOf(AttachmentImmutableError);
    }
  });

  /**
   * 0040's three refusals, verbatim, and the arm that reads them.
   *
   * The match is on the `receipt-claim-state:` MARKER rather than on any of these
   * sentences, which is the point of having one — 0034's probe triggers do the same thing
   * and for the same reason. The sentences are still copied in full, because what this test
   * has to catch is a marker that was reworded on one side only.
   */
  it("maps every claim-state refusal to its own class, by the marker and not by the prose", () => {
    for (const message of [
      "receipt-claim-state: expense claim A is not visible in tenant T, so there is no claim state that could admit this receipt",
      "receipt-claim-state: expense claim A is approved, so the receipt standing on it cannot be stood down — standing it down is the first half of a replacement, and it would leave a claim that has left draft with no current receipt at all",
      "receipt-claim-state: expense claim A is submitted, so its receipt is fixed and may no longer be replaced — an approver may be reading this image at the moment it changes, and a decision taken against evidence it never saw is corrected by a new claim, not by a new photograph",
      "receipt-claim-state: expense claim A is posted, and a receipt may be attached only while a claim is draft or submitted — after that the decision has been taken, or there is nothing left to evidence",
    ]) {
      expect(translateAttachmentError(pg(message)), message).toBeInstanceOf(ReceiptClaimStateError);
    }
  });

  /**
   * NOT a supersession error, and this is the assertion that keeps it that way.
   *
   * The replacement refusals talk about a receipt that "may no longer be replaced" and
   * about standing one down, which is a hair away from the sentences
   * `AttachmentSupersessionError` claims. If the marker arm were ever moved below those, two
   * refusals with completely different remedies — "re-read and start again" versus "file a
   * new claim" — would collapse into one.
   */
  it("keeps a claim-state refusal out of the supersession arm, whose remedy is a different one", () => {
    const err = translateAttachmentError(
      pg(
        "receipt-claim-state: expense claim A is submitted, so its receipt is fixed and may no longer be replaced — an approver may be reading this image at the moment it changes, and a decision taken against evidence it never saw is corrected by a new claim, not by a new photograph",
      ),
    );
    expect(err.name).toBe("ReceiptClaimStateError");
    expect(err).not.toBeInstanceOf(AttachmentSupersessionError);
    expect(err).not.toBeInstanceOf(AttachmentImmutableError);
  });

  it("does not re-translate a claim-state refusal on a second pass", () => {
    const once = translateAttachmentError(pg("receipt-claim-state: expense claim A is posted, and a receipt may be attached only while a claim is draft or submitted — after that the decision has been taken, or there is nothing left to evidence"));
    expect(translateAttachmentError(once)).toBe(once);
  });

  it("passes an unrecognised Error through untouched", () => {
    const original = new Error("connection terminated unexpectedly");
    expect(translateAttachmentError(original)).toBe(original);
  });

  it("wraps a non-Error throw rather than returning it", () => {
    const err = translateAttachmentError("something fell over");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something fell over");
  });

  it("wraps undefined without reading a property off it", () => {
    expect(translateAttachmentError(undefined)).toBeInstanceOf(Error);
    expect(translateAttachmentError(null).message).toBe("null");
  });

  it("keeps the too-large refusal's numbers readable, because a client renders them", () => {
    const err = new AttachmentTooLargeError(600_000, 524_288);
    expect(err.byteSize).toBe(600_000);
    expect(err.maxBytes).toBe(524_288);
    expect(err.message).toContain("600000");
    expect(err.message).toContain("524288");
  });

  it("names the backend in a diverged-blob refusal, because that is which store to go and look in", () => {
    const err = new MissingAttachmentBlobError("A", "postgres");
    expect(err.message).toContain("postgres");
    expect(err.message).toContain("diverged");
  });

  it("names the rejected content type and the allow-list", () => {
    const err = new UnsupportedAttachmentTypeError("text/html");
    expect(err.message).toContain("text/html");
    expect(err.message).toContain(ATTACHMENT_CONTENT_TYPES.join(", "));
    expect(err.contentType).toBe("text/html");
  });

  /**
   * The constructor shape `problems.test.ts` depends on.
   *
   * That gate finds a domain package's error classes by constructing each exported
   * `*Error` as `new C("x", "y")` and keeping the ones that answer with their own name. A
   * constructor that THROWS on those arguments is skipped in silence — which is what the
   * allow-list parameter did here, exempting the one refusal a client fixes by sending a
   * different header from the check that it maps to anything at all. Asserted rather than
   * remembered, because the next error class added here will be written by someone reading
   * the classes above and not this comment.
   */
  it("constructs every exported error the way problems.test.ts discovers them", async () => {
    const mod = (await import("./index.js")) as unknown as Record<string, unknown>;
    const found: string[] = [];
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function" || !name.endsWith("Error")) continue;
      const instance = new (value as new (...a: unknown[]) => unknown)("x", "y");
      if (instance instanceof Error && instance.name === name) found.push(name);
    }
    // Every class in the barrel, not all but one: `translateAttachmentError` also ends in
    // "Error" and is excluded by the name check rather than by throwing, exactly as it is
    // over there.
    expect(found).toHaveLength(18);
  });
});
