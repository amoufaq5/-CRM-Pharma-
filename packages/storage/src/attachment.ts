import type { PoolClient } from "pg";

import type { BlobStore } from "./blob.js";
import { assertAttachmentContent, sha256Hex } from "./content.js";
import {
  AttachmentContentTypeMismatchError,
  AttachmentForbiddenError,
  AttachmentIdReusedError,
  AttachmentNotFoundError,
  AttachmentNotSupersedableError,
  AttachmentSupersessionError,
  MissingAttachmentBlobError,
  translateAttachmentError,
} from "./errors.js";
import {
  isSupersedablePurpose,
  subjectTableFor,
  type AttachmentContentType,
  type AttachmentPurpose,
  type AttachmentStatus,
  type AttachmentStorageBackend,
  type AttachmentSubjectTable,
} from "./subjects.js";

/**
 * The attachment store.
 *
 * Every function takes a `PoolClient` already inside `withTenantContext`, like every
 * other store in this repo: RLS confines the queries, a caller who forgets the wrapper
 * sees no rows rather than everyone's, and the explicit `AND tenant_id = $n` beside it is
 * the check with the policy as the backstop.
 *
 * Two things about the shape of this module are deliberate and worth reading before
 * changing it.
 *
 * EVERY READ OF AN ATTACHMENT TAKES A READER. There is no `getAttachment(id)` that answers
 * without being told who is asking. A signature is a third party's biometric-adjacent data
 * and RLS does not help — a rep and a colleague's rep are in the same tenant, so the policy
 * admits both rows and `crm.rep_can_supervise` is the only thing between them (README rule
 * 19). A function that could be called without a reader is a function a route will
 * eventually call without one.
 *
 * `attachmentSubjectOwner` is the one exception and is not a counter-example: it reads the
 * SUBJECT, not an attachment, and answers a rep id so that a route can decide who the
 * reader would have to be. It is an input to an authorisation decision and never a
 * response body — see its own note.
 *
 * THERE IS NO `supersedeAttachment`. Replacing an attachment is `putAttachment` with a
 * `supersedes` block, because the two halves — marking the old row and writing the new
 * one — must happen together and in that order, and an API with two entry points is an
 * API where one of them gets called alone.
 */

export interface AttachmentRow {
  readonly id: string;
  readonly purpose: AttachmentPurpose;
  readonly subject_table: AttachmentSubjectTable;
  readonly subject_id: string;
  readonly content_type: AttachmentContentType;
  readonly byte_size: number;
  readonly content_sha256: string;
  readonly storage_backend: AttachmentStorageBackend;
  readonly status: AttachmentStatus;
  readonly uploaded_by: string;
  readonly uploaded_at: Date;
  readonly seq: string;
  readonly supersedes_attachment_id: string | null;
  readonly superseded_by_attachment_id: string | null;
  readonly superseded_reason: string | null;
}

/** An `AttachmentRow` plus the rep the subject belongs to, which a listing resolves anyway. */
export interface OwnedAttachmentRow extends AttachmentRow {
  readonly owner_rep_profile_id: string;
}

export interface PutAttachmentInput {
  /**
   * Device-minted (README rule 7), like a visit id and a disbursement id. A signature is
   * captured at a clinic desk with no signal, so the upload is retried and a retry must
   * collapse into the row already there.
   */
  readonly id: string;
  readonly purpose: AttachmentPurpose;
  /**
   * The subject row's id. The TABLE is derived from the purpose and never supplied, so a
   * receipt cannot be attached to a ledger row by passing a mismatched pair.
   */
  readonly subjectId: string;
  readonly contentType: string;
  readonly content: Buffer;
  /** The rep themself, or someone who supervises them. Enforced by the trigger either way. */
  readonly uploadedBy: string;
  /**
   * Replace an existing attachment, keeping it in the record.
   *
   * The reason is required and bounded by a CHECK: replacing evidence without saying why
   * is the act this table exists to make visible.
   */
  readonly supersedes?: { readonly attachmentId: string; readonly reason: string };
}

export interface ReadAttachmentInput {
  readonly attachmentId: string;
  readonly readBy: string;
  /** The request's correlation id, so an access record and a log line join. */
  readonly correlationId?: string;
}

export interface AttachmentContent {
  readonly attachment: AttachmentRow;
  readonly content: Buffer;
}

export interface AttachmentAccessRow {
  readonly id: string;
  readonly attachment_id: string;
  readonly read_by: string;
  readonly read_at: Date;
  readonly seq: string;
  readonly correlation_id: string | null;
}

const ATTACHMENT_COLUMNS = `id, purpose, subject_table, subject_id, content_type, byte_size,
  content_sha256, storage_backend, status, uploaded_by, uploaded_at, seq,
  supersedes_attachment_id, superseded_by_attachment_id, superseded_reason`;

/**
 * Stores an attachment and its bytes in one transaction.
 *
 * Returns the row. Idempotent on the device-minted id: re-uploading the SAME capture
 * returns the row already there without a second blob write, and re-using the id for
 * DIFFERENT bytes is refused by name — that distinction is the whole reason the id comes
 * from the device rather than from a default.
 *
 * The order of the four statements matters and is the part worth not rearranging:
 *
 *   1. the existing row is read, so a retry is answered before anything is written;
 *   2. the superseded row is marked FIRST, because `uq_attachment_current` admits one
 *      current attachment per subject and inserting the successor first would collide
 *      with the row it is replacing;
 *   3. the metadata row is inserted, and its trigger refuses a supersession whose target
 *      does not already name it — so a half-applied replacement cannot commit;
 *   4. the bytes go in last, and their trigger verifies the digest, the length and the
 *      magic bytes against the row from (3). `content_sha256` is only trustworthy
 *      because of that check, and the signature commitment check in (3) is only
 *      meaningful because `content_sha256` is trustworthy.
 */
export async function putAttachment(
  tx: PoolClient,
  tenantId: string,
  store: BlobStore,
  input: PutAttachmentInput,
): Promise<AttachmentRow> {
  assertAttachmentContent(input.contentType, input.content);
  const contentType: AttachmentContentType = input.contentType;
  const digest = sha256Hex(input.content);
  const subjectTable = subjectTableFor(input.purpose);

  // Refused here rather than relying on the trigger, because this is the one supersession
  // rule that is a statement about the PURPOSE rather than about the rows — so a client
  // can be told a signature is final without uploading half a megabyte to find out.
  if (input.supersedes !== undefined && !isSupersedablePurpose(input.purpose)) {
    throw new AttachmentNotSupersedableError(
      `a ${input.purpose} cannot be superseded: the ledger commitment fixes which image is the ` +
        `signature and cannot be corrected (the custody ledger is append-only). A different ` +
        `signature is a different hand-over — post an adjustment with a reason instead.`,
    );
  }

  const existing = await findById(tx, tenantId, input.id);
  if (existing !== null) {
    // AUTHORISE BEFORE COMPARING, and the order is the finding rather than a preference.
    //
    // A first write is authorised by `crm.attachment_validate`; a retry writes no metadata
    // row, so no trigger speaks for it and this branch is the only thing that can. It has
    // to come first because the comparison below refuses in a sentence that names the
    // stored row's purpose, subject and content hash — so checking identity first would
    // answer a caller with no claim on the subject with facts about a colleague's doctor
    // signature. The predicate is `crm.attachment_readable_by`, which asks
    // `crm.rep_can_supervise(actor, owner)` as of today: the same question the trigger
    // asks, so the same act gets the same answer whether it is the first write or the
    // fourth retry of it.
    if (!(await isActorEntitled(tx, tenantId, existing.id, input.uploadedBy))) {
      throw new AttachmentForbiddenError(
        `rep ${input.uploadedBy} neither owns nor supervises the rep whose record attachment ` +
          `${existing.id} hangs off, so may not act on it`,
      );
    }
    if (
      existing.content_sha256 !== digest ||
      existing.subject_table !== subjectTable ||
      existing.subject_id !== input.subjectId ||
      existing.purpose !== input.purpose
    ) {
      throw new AttachmentIdReusedError(
        `attachment ${input.id} already records the ${existing.purpose} of ${existing.subject_table} ` +
          `${existing.subject_id} with sha256 ${existing.content_sha256}. A retried upload of the same ` +
          `capture collapses into it; this is a different capture under a reused id, which is the one ` +
          `thing an append-only attachment table must refuse.`,
      );
    }
    // `content_type` is compared too, separately, because the fault and the remedy are not
    // the comparison above's. Identical bytes can legally carry only ONE of the three
    // declared types — the trigger's magic-byte sniff decides which — so renaming stored
    // PNG bytes `application/pdf` is a declaration a first write is refused for. Left out,
    // it was accepted in silence and answered with the stored row, which made the retry
    // path the one way into this table more permissive than the write it replays.
    if (existing.content_type !== contentType) {
      throw new AttachmentContentTypeMismatchError(
        `attachment ${existing.id} holds bytes declared ${existing.content_type} and this upload ` +
          `calls the same bytes ${contentType} — they cannot both be right, and a first write of ` +
          `them under that type is refused by the magic-byte check`,
      );
    }
    // Same id, same bytes, same subject: a retry. The blob write is idempotent, so it is
    // repeated rather than skipped — a row whose metadata landed and whose bytes did not
    // (a connection lost between statements in an earlier attempt) is healed by the retry
    // instead of staying broken.
    await putBlob(store, tx, tenantId, input.id, input.content);
    return existing;
  }

  if (input.supersedes !== undefined) {
    await markSuperseded(
      tx,
      tenantId,
      input.supersedes.attachmentId,
      input.id,
      input.supersedes.reason,
      input.uploadedBy,
    );
  }

  let row: AttachmentRow;
  try {
    const { rows } = await tx.query<AttachmentRow>(
      `INSERT INTO crm.attachment
         (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
          content_sha256, storage_backend, uploaded_by, supersedes_attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        input.id,
        tenantId,
        input.purpose,
        subjectTable,
        input.subjectId,
        contentType,
        input.content.length,
        digest,
        store.backend,
        input.uploadedBy,
        input.supersedes?.attachmentId ?? null,
      ],
    );
    row = rows[0]!;
  } catch (err) {
    throw translateAttachmentError(err);
  }

  await putBlob(store, tx, tenantId, input.id, input.content);
  return row;
}

async function putBlob(
  store: BlobStore,
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  content: Buffer,
): Promise<void> {
  try {
    await store.put(tx, tenantId, attachmentId, content);
  } catch (err) {
    throw translateAttachmentError(err);
  }
}

/**
 * Marks an attachment superseded by a successor that does not exist yet.
 *
 * It cannot exist yet — see `putAttachment`'s step ordering — which is why
 * `superseded_by_attachment_id` is a DEFERRABLE INITIALLY DEFERRED foreign key in 0033.
 * The dangling reference is legal inside the transaction and refused at COMMIT, so
 * "superseded by a row nobody wrote" is not a state this schema can hold.
 */
async function markSuperseded(
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  successorId: string,
  reason: string,
  actor: string,
): Promise<void> {
  // The row being replaced is authorised SEPARATELY, before it is touched, even though the
  // insert that follows would refuse an unentitled actor anyway. Two reasons, and the
  // second is why this is not belt-and-braces. The trigger on the successor refuses after
  // this UPDATE has already run, so whether it affected a row or not is observable in the
  // refusal that comes back — "no current attachment to supersede" against the trigger's
  // own sentence tells a caller holding a guessed id whether a colleague has a current
  // attachment of that purpose. And a legitimate replacement cannot be refused here: the
  // trigger requires the predecessor to hang off the SAME subject, so an actor entitled to
  // attach to the subject is by construction entitled to the row they are replacing.
  if (!(await isActorEntitled(tx, tenantId, attachmentId, actor))) {
    throw new AttachmentSupersessionError(
      `no current attachment ${attachmentId} to supersede — it does not exist, it has already ` +
        `been replaced, or it is not yours to replace`,
    );
  }
  try {
    const { rowCount } = await tx.query(
      `UPDATE crm.attachment
          SET status = 'superseded',
              superseded_by_attachment_id = $3,
              superseded_reason = $4
        WHERE tenant_id = $1 AND id = $2 AND status = 'current'`,
      [tenantId, attachmentId, successorId, reason],
    );
    if ((rowCount ?? 0) === 0) {
      // Either there is no such attachment or it is already superseded, and the store
      // cannot tell which without a second read it would then have to reconcile. Both
      // mean the same thing to the caller: re-read the current attachment and start again.
      throw new AttachmentSupersessionError(
        `no current attachment ${attachmentId} to supersede — it does not exist, or it has already ` +
          `been replaced`,
      );
    }
  } catch (err) {
    if (err instanceof AttachmentSupersessionError) throw err;
    throw translateAttachmentError(err);
  }
}

/**
 * May this rep act on an attachment that already exists?
 *
 * `crm.attachment_readable_by` rather than a second supervision query: that function is
 * where the predicate lives, it resolves the owner through the same `CASE` the trigger
 * does, and it is already the gate on every read here.
 */
async function isActorEntitled(
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  actor: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT crm.attachment_readable_by(a.id, $3) AS ok
       FROM crm.attachment a WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, attachmentId, actor],
  );
  return rows[0]?.ok === true;
}

/** Unscoped lookup by id. Private: every exported read takes a reader. */
async function findById(tx: PoolClient, tenantId: string, id: string): Promise<AttachmentRow | null> {
  const { rows } = await tx.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM crm.attachment WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/**
 * One attachment's metadata, or null when the reader may not see it.
 *
 * Null for both "no such attachment" and "not yours", deliberately: whether a colleague
 * holds a named doctor's signature is itself information about that colleague's work, and
 * the house convention for every supervision-scoped record is that the two are one
 * answer.
 *
 * NO `on` PARAMETER, and its absence is the rule rather than an omission. 0033's header
 * states the one place this subsystem departs from README rule 8: a WRITE is judged on the
 * day it happened, so a territory change cannot invalidate June's hand-over, but "who may
 * look at this doctor's signature" is a question about who is accountable NOW — dating it
 * backwards would give the manager who has since left the district continuing access to
 * its personal data and give the manager who runs it none. `?on=` is a parameter several
 * team reads in this API do honour, so a route author threading it through here would be
 * following the house pattern into exactly that failure. It cannot be threaded through
 * something that does not accept it. The SQL functions keep their date argument for a
 * psql prompt asking an audit question; no caller in this package supplies one, and the
 * bytes and the access log never accepted one either.
 */
export async function getAttachment(
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  readBy: string,
): Promise<AttachmentRow | null> {
  const { rows } = await tx.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM crm.attachment a
      WHERE a.tenant_id = $1 AND a.id = $2
        AND crm.attachment_readable_by(a.id, $3, CURRENT_DATE)`,
    [tenantId, attachmentId, readBy],
  );
  return rows[0] ?? null;
}

/** `getAttachment`, as a refusal rather than a null, for a route holding a path parameter. */
export async function requireAttachment(
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  readBy: string,
): Promise<AttachmentRow> {
  const row = await getAttachment(tx, tenantId, attachmentId, readBy);
  if (row === null) throw new AttachmentNotFoundError(attachmentId);
  return row;
}

/**
 * Every attachment on one subject, newest first, superseded ones included.
 *
 * The chain is returned rather than filtered to the current row, because "this receipt
 * was replaced, here is the one it replaced and why" is the whole value of keeping it.
 * `crm.attachments_for_subject` does the scoping inside the query — never by filtering
 * afterwards on a rep id the caller supplied (README rule 19) — so a reader with no claim
 * on the subject gets an empty set.
 *
 * As of today, for the reason `getAttachment` gives.
 */
export async function listAttachmentsForSubject(
  tx: PoolClient,
  tenantId: string,
  input: {
    readonly readBy: string;
    readonly purpose: AttachmentPurpose;
    readonly subjectId: string;
  },
): Promise<readonly OwnedAttachmentRow[]> {
  const { rows } = await tx.query<OwnedAttachmentRow>(
    // `subject_table` and `subject_id` are echoed from the arguments rather than selected:
    // the function is already scoped to one subject, so it does not return them, and a row
    // shape that omitted them would not be an `AttachmentRow`.
    `SELECT f.id, f.purpose, $3::text AS subject_table, $4::uuid AS subject_id,
            f.content_type, f.byte_size, f.content_sha256, f.storage_backend, f.status,
            f.uploaded_by, f.uploaded_at, f.seq, f.supersedes_attachment_id,
            f.superseded_by_attachment_id, f.superseded_reason, f.owner_rep_profile_id
       FROM crm.attachments_for_subject($1, $3, $4, CURRENT_DATE) f
      WHERE f.purpose = $2`,
    [input.readBy, input.purpose, subjectTableFor(input.purpose), input.subjectId],
  );
  return rows;
}

/**
 * The bytes, and a record that they were read.
 *
 * THE ACCESS ROW IS WRITTEN BEFORE THE BODY IS RETURNED, in the same transaction, so a
 * read that cannot be recorded is not served. That is the fail-closed rule this repo
 * applies everywhere, applied to the one table whose content is somebody else's
 * biometric-adjacent data: an unrecordable privileged read is refused, not served
 * unaudited.
 *
 * A metadata listing is NOT logged. It carries no personal data, and logging every list
 * would bury the reads that matter under the reads that do not.
 */
export async function readAttachmentContent(
  tx: PoolClient,
  tenantId: string,
  store: BlobStore,
  input: ReadAttachmentInput,
): Promise<AttachmentContent> {
  const attachment = await requireAttachment(tx, tenantId, input.attachmentId, input.readBy);

  try {
    await tx.query(
      `INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by, correlation_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, attachment.id, input.readBy, input.correlationId ?? null],
    );
  } catch (err) {
    throw translateAttachmentError(err);
  }

  if (attachment.storage_backend !== store.backend) {
    // The row says its bytes are somewhere else. Impossible with one backend and the
    // reason `storage_backend` is on the row: a deployment part-way through a migration to
    // object storage holds both, and each row has to say which store to ask.
    throw new MissingAttachmentBlobError(attachment.id, attachment.storage_backend);
  }
  const content = await store.get(tx, tenantId, attachment.id);
  if (content === null) throw new MissingAttachmentBlobError(attachment.id, attachment.storage_backend);
  return { attachment, content };
}

/**
 * Who has read this attachment's bytes.
 *
 * Scoped by the same predicate as the content itself, so the people entitled to see a
 * signature are exactly the people entitled to see who else has. The question a
 * disclosure review asks about personal data is this one, and the alternative to a table
 * is answering it from application logs that nothing retains.
 */
export async function attachmentAccessLog(
  tx: PoolClient,
  tenantId: string,
  attachmentId: string,
  readBy: string,
  limit = 200,
): Promise<readonly AttachmentAccessRow[]> {
  // `Number.isFinite` first, because the clamp alone does not survive a NaN: a route
  // reading `Number(query.limit)` off a querystring hands it one for any garbage, and
  // `Math.max(1, Math.min(1000, NaN))` is NaN, which reaches Postgres as the text "NaN"
  // and answers a disclosure question with a 500.
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 200;
  const { rows } = await tx.query<AttachmentAccessRow>(
    `SELECT x.id, x.attachment_id, x.read_by, x.read_at, x.seq, x.correlation_id
       FROM crm.attachment_access x
      WHERE x.tenant_id = $1 AND x.attachment_id = $2
        AND crm.attachment_readable_by(x.attachment_id, $3, CURRENT_DATE)
      -- seq, not read_at: now() is the transaction clock, so a burst of reads in one
      -- transaction shares read_at to the microsecond (0027's finding, on crm.outbox).
      ORDER BY x.seq DESC
      LIMIT $4`,
    [tenantId, attachmentId, readBy, bounded],
  );
  return rows;
}

/**
 * The rep an attachment's subject belongs to, or null.
 *
 * Exposed because a route needs the owner before it has decided what to do — it is how a
 * route answers "whose claim is this" in order to apply supervision to an upload — and
 * because the fail-closed default is worth being able to observe: an unknown subject table
 * resolves to null, which means nobody may read the attachment, where the identically
 * shaped `crm.notification_subject_open` defaults the other way.
 *
 * THE TENANT IS AN ARGUMENT, not just the session's setting, so this read carries the
 * explicit predicate every other read here carries. `crm.attachment_subject_rep` takes no
 * tenant, and the owner branches must not be restated in TypeScript, so the predicate is
 * against `app.current_tenant_id` itself: a caller holding the wrong tenant, or one that
 * forgot `withTenantContext`, gets null rather than an answer about whichever context the
 * pooled connection was left in.
 *
 * It answers a rep id and never an attachment, so it is not a disclosure of content — but
 * it is still an answer about a colleague's work, and a route must treat it as an input to
 * an authorisation decision rather than as a response body.
 */
export async function attachmentSubjectOwner(
  tx: PoolClient,
  tenantId: string,
  purpose: AttachmentPurpose,
  subjectId: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ owner: string | null }>(
    // `NULLIF(…, '')` is the spelling every crm.* policy uses, and it is not decoration:
    // on a pooled connection the GUC reverts to the EMPTY STRING rather than to NULL once
    // it has existed, so the unguarded cast raises `invalid input syntax for type uuid`
    // instead of answering nothing (`packages/db/src/rls.contract.test.ts` pins both).
    `SELECT crm.attachment_subject_rep($2, $3) AS owner
      WHERE NULLIF(current_setting('app.current_tenant_id', true), '')::uuid = $1::uuid`,
    [tenantId, subjectTableFor(purpose), subjectId],
  );
  return rows[0]?.owner ?? null;
}
