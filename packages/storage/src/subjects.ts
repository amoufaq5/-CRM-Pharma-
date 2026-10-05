/**
 * What an attachment can BE, and what it can hang off.
 *
 * The vocabulary is here, in one pure module, because three independent things have to
 * agree about it: the CHECK constraints on `crm.attachment` (0033), the branches in
 * `crm.attachment_subject_rep`, and the routes that write one.
 * `subject-coverage.contract.test.ts` asserts all three against each other rather than
 * trusting that they were kept in step.
 */

/**
 * Why an attachment exists. It decides every rule that follows — whether a hash
 * commitment must be matched, whether the attachment may ever be replaced, and which
 * table owns it — so it is a closed set rather than a free-text label.
 */
export const ATTACHMENT_PURPOSES = ["disbursement_signature", "expense_receipt"] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

/**
 * The tables an attachment may hang off.
 *
 * `crm.attachment.subject_table`/`subject_id` is the polymorphic shape
 * `crm.notification` (0021) and `crm.outbox` (0004) already use, and it is not a foreign
 * key for the reason stated there: a column cannot reference two tables. Existence is
 * validated on write by a trigger instead.
 */
export const ATTACHMENT_SUBJECT_TABLES = ["crm.sample_transaction", "crm.expense_claim"] as const;
export type AttachmentSubjectTable = (typeof ATTACHMENT_SUBJECT_TABLES)[number];

/**
 * Which table each purpose hangs off, as a total function.
 *
 * A caller supplies the purpose and the subject id and never the table name, so a
 * receipt cannot be attached to a ledger row by passing the wrong pair. The database
 * carries the same rule in `attachment_purpose_subject`, because a mispaired row would
 * skip the signature commitment check entirely.
 */
export const SUBJECT_TABLE_BY_PURPOSE: Readonly<Record<AttachmentPurpose, AttachmentSubjectTable>> = {
  disbursement_signature: "crm.sample_transaction",
  expense_receipt: "crm.expense_claim",
};

/**
 * The purposes an attachment may be replaced for.
 *
 * A receipt may: photographing the wrong receipt is an ordinary mistake with no
 * commitment behind it, and the superseded photograph stays so a reviewer sees both.
 *
 * A signature may NOT, and the reason is not squeamishness: `signature_sha256` on the
 * append-only sample ledger (0017/0018) fixes which image is the signature and can never
 * be corrected, so a different image is a different hand-over. The ledger's answer to a
 * wrong hand-over is an adjustment carrying a reason, not a corrected picture.
 */
export const SUPERSEDABLE_PURPOSES: readonly AttachmentPurpose[] = ["expense_receipt"];

/**
 * The purposes whose bytes must hash to a commitment that already exists elsewhere.
 *
 * Exported so a route can say "this upload will be checked against the ledger" before it
 * sends half a megabyte, and so the contract test can assert the set the trigger actually
 * enforces is this one.
 */
export const COMMITTED_PURPOSES: readonly AttachmentPurpose[] = ["disbursement_signature"];

/**
 * The content types a blob may declare.
 *
 * PNG and JPEG for a signature capture and a photographed receipt, PDF for one that
 * arrived by email. SVG is deliberately absent — it is a script container and something
 * will eventually hand one to a browser — and so is `application/octet-stream`, which
 * says nothing and therefore cannot be validated or rendered.
 */
export const ATTACHMENT_CONTENT_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

/** Where an attachment's bytes live. One value today; the column exists so there can be two. */
export const ATTACHMENT_STORAGE_BACKENDS = ["postgres"] as const;
export type AttachmentStorageBackend = (typeof ATTACHMENT_STORAGE_BACKENDS)[number];

/** `current` or `superseded`. There is no deleted state; see 0033's header. */
export const ATTACHMENT_STATUSES = ["current", "superseded"] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export function isAttachmentPurpose(value: unknown): value is AttachmentPurpose {
  return typeof value === "string" && (ATTACHMENT_PURPOSES as readonly string[]).includes(value);
}

export function isAttachmentSubjectTable(value: unknown): value is AttachmentSubjectTable {
  return typeof value === "string" && (ATTACHMENT_SUBJECT_TABLES as readonly string[]).includes(value);
}

export function isAttachmentContentType(value: unknown): value is AttachmentContentType {
  return typeof value === "string" && (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isAttachmentStatus(value: unknown): value is AttachmentStatus {
  return typeof value === "string" && (ATTACHMENT_STATUSES as readonly string[]).includes(value);
}

export function subjectTableFor(purpose: AttachmentPurpose): AttachmentSubjectTable {
  return SUBJECT_TABLE_BY_PURPOSE[purpose];
}

export function isSupersedablePurpose(purpose: AttachmentPurpose): boolean {
  return SUPERSEDABLE_PURPOSES.includes(purpose);
}

export function isCommittedPurpose(purpose: AttachmentPurpose): boolean {
  return COMMITTED_PURPOSES.includes(purpose);
}
