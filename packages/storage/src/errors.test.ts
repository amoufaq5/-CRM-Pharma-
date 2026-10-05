import { describe, expect, it } from "vitest";

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
      new UnsupportedAttachmentTypeError("x", ["image/png"]),
      new MissingAttachmentBlobError("a", "postgres"),
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
    const err = new UnsupportedAttachmentTypeError("text/html", ["image/png", "application/pdf"]);
    expect(err.message).toContain("text/html");
    expect(err.message).toContain("image/png, application/pdf");
    expect(err.contentType).toBe("text/html");
  });
});
