-- 0033_attachments.sql
--
-- Somewhere for a signature to live.
--
-- WHAT WAS BROKEN. `crm.sample_transaction.signature_sha256` (0017) commits to the bytes
-- a device captured when a doctor signed for a drug sample, and the bytes themselves had
-- nowhere to go: ADR-0001's open table says so in as many words, and 0017's own comment
-- calls the hash "weaker than holding the image and stronger than a boolean". That is a
-- compliance hole and not a convenience gap. A disbursement record says a signature was
-- taken, fixes WHICH signature was taken, and cannot produce it for the inspector who
-- asks. `crm.expense_claim.receipt_url` (0006) is the same shape from the other end: a
-- url column with nothing behind it and no service that would serve one.
--
-- ===========================================================================
-- WHERE THE BYTES GO, AND WHAT THAT COSTS
-- ===========================================================================
--
-- Postgres `bytea`, in a table of its own, behind a `BlobStore` interface in
-- `packages/storage`. Three candidates were considered and two were rejected on evidence
-- rather than on taste.
--
-- A FILESYSTEM PATH IS NOT AVAILABLE HERE, which is the decisive fact and it is a fact
-- about this deployment rather than a preference. `deploy/docker-compose.yml` gives the
-- `api` service no volume at all: a file written by a request would land in the
-- container's ephemeral layer, vanish on the next `docker compose up`, and be invisible
-- to the second API replica the README promises ("the API is stateless and scales
-- freely") and to the scheduler process, which runs in a different container. The managed
-- path (`deploy/VERCEL-SUPABASE.md`) is worse still — a serverless function has a
-- read-only filesystem. A blob store the deployment cannot durably hold is not a store.
--
-- LARGE OBJECTS ARE REJECTED ON ISOLATION. `lo_*` keeps bytes in `pg_largeobject`, a
-- cluster-wide catalog table that is not tenant-scoped, carries no `tenant_id` and cannot
-- be put under a policy — so a loid is readable by anyone holding `SELECT` on that
-- catalog regardless of `app.current_tenant_id`, and the isolation guarantee this whole
-- schema rests on (ADR-0001 item 2) would stop at the attachment table's edge. Orphaned
-- objects also outlive their rows and need `vacuumlo` to reap, which is a second
-- operational obligation for no gain.
--
-- SO: `bytea`. What it buys is exactly what ADR-0001 chose option (b) for — one backup,
-- one PITR timeline, one transaction boundary. The attachment row and its bytes commit
-- together, so there is no state where a disbursement claims an attachment that is not
-- there; RLS and `FORCE ROW LEVEL SECURITY` apply to the bytes as they do to every other
-- row in this schema; and `pg_dump` of the database is a complete evidential record,
-- which is the property an inspection actually needs.
--
-- WHAT IT COSTS, stated plainly so the replacement decision can be made on numbers rather
-- than on discomfort. Every blob is WAL-logged, replicated and re-dumped: a 20 KB
-- signature per disbursement is noise, a 400 KB receipt photo per expense claim is not,
-- and a tenant filing ten thousand claims a year adds roughly four gigabytes a year to a
-- database whose backups are sized for rows. Postgres is also the wrong place to serve
-- bytes from at volume — there is no CDN in front of it and no range-request support, so
-- a large attachment is read whole through a connection from a pool sized for queries.
--
-- WHEN IT WOULD NEED REPLACING: when attachment bytes dominate the backup, or when any
-- route wants to hand a client a signed URL instead of a body. That is why the seam is
-- `BlobStore` and not a function — ADR-0001 records object storage as a platform gap that
-- will eventually be filled, and the precedent is `ChannelSender` in
-- `packages/notify/src/sender.ts`: an interface with a working implementation behind it
-- and nothing claimed that is not built. `storage_backend` is on the metadata row rather
-- than in configuration for the same reason, so a deployment mid-migration can hold both
-- and each row says where to look for its own bytes.
--
-- AND ONE HONEST WART IN THAT SEAM. `BlobStore.put` takes the caller's transaction,
-- because a Postgres store MUST participate in it — that is the whole point. An S3
-- implementation cannot: its object would land before the row and an aborted transaction
-- would leave it orphaned. So the seam is not free, and a future S3 store needs a sweeper
-- for unreferenced objects. Saying that now is cheaper than discovering it later.
--
-- ===========================================================================
-- THE HASH IS ALREADY THE IDENTITY, SO A MISMATCH IS THE ONE IMPOSSIBLE STATE
-- ===========================================================================
--
-- `signature_sha256` is a commitment, and the ledger it sits in is append-only (0018), so
-- it can never be corrected. That makes the commitment the signature's identity: the
-- question "which image did the doctor sign" has one answer for the life of the record.
--
-- An attachment whose bytes disagree with that commitment is therefore WORSE THAN NO
-- ATTACHMENT. No attachment leaves an auditor with a hash and a stated gap, which is
-- weak and honest. A stored blob that does not hash to the commitment is a document that
-- looks like evidence, reads like evidence, and is evidence of nothing — and the person
-- who finds out is the one relying on it. It is also exactly what a swap would look like.
-- So the blob is verified against the commitment ON WRITE and a mismatch is refused, in
-- the database, so the rule holds for the route, for the offline flush, and for a psql
-- prompt.
--
-- The digest is computed from the STORED BYTES, never taken from the caller. A
-- client-supplied hash checked against client-supplied bytes proves only that the client
-- can run sha256. `pg_catalog.sha256(bytea)` is used rather than pgcrypto's `digest()`
-- deliberately: `digest` lives in `public` here, so its resolution depends on
-- `search_path`, and a hash check that can be silently dropped by a session setting is
-- not a check. `sha256` is in `pg_catalog`, is IMMUTABLE, and cannot be shadowed.
--
-- ===========================================================================
-- WHO MAY READ ONE, AND WHY THIS FUNCTION FAILS CLOSED WHERE 0024'S FAILS OPEN
-- ===========================================================================
--
-- A doctor's signature is biometric-adjacent personal data about a third party who is not
-- a user of this system and never consented to anything here; a receipt photograph can
-- carry a patient-facing venue, a room number and a date. Neither is ordinary CRM
-- content, so neither is reachable by "anyone in the tenant" — RLS admits every rep of
-- the tenant, exactly as it does for a peer's visit, and the only thing between a rep and
-- a colleague's attachments is the predicate below (README rule 19).
--
-- An attachment is readable by the rep whose record it hangs off and by whoever supervises
-- them, and by nobody else. `crm.rep_can_supervise` (0019) is that question's one
-- definition and is reused rather than restated.
--
-- `crm.attachment_subject_rep` resolves the owning rep with A BRANCH PER SUBJECT TABLE,
-- the shape `crm.notification_subject_open` (0024) and `crm.outbox_recipient` (0022)
-- already use, and for the same reason: `subject_table`/`subject_id` is deliberately not
-- a foreign key, so there is nothing to join generically and a `CASE` is the honest form.
-- Adding a subject means adding a branch, which is a visible act in a diff.
--
-- IT DEFAULTS THE OPPOSITE WAY TO 0024'S, and the inversion is the point. An unknown
-- subject table yields NULL — no owning rep — and a NULL owner means NOBODY may read the
-- attachment and nobody may create one. 0024 defaults a missing branch to "not open"
-- because the failure it fixes is unbounded growth and "keep forever when unsure" would
-- reintroduce it silently. The failure here is disclosure of a third party's personal
-- data, so "show it when unsure" is the unacceptable direction and the default inverts.
-- Two functions of identical shape, each leaning toward the failure that matters in its
-- own subsystem; `packages/storage/src/subject-coverage.contract.test.ts` asserts the
-- branches match the purposes the code can actually write.
--
-- A READ IS AUTHORISED AS OF TODAY, not as of the day the subject happened — the one
-- place this subsystem deliberately departs from README rule 8. A write is judged on the
-- date it occurred because a territory change must not invalidate June's hand-over. But
-- "who may look at this doctor's signature" is a question about who is accountable NOW:
-- dating it to the hand-over would give the manager who has since left the district
-- continuing access to its personal data and give the manager who runs it none, which is
-- backwards for both halves.
--
-- AND A READ OF THE BYTES IS RECORDED, in the same transaction that serves them.
-- `crm.attachment_access` is append-only and `readAttachmentContent` writes to it before
-- it returns a body, so a read that cannot be recorded is not served — the fail-closed
-- rule this repo applies everywhere, applied to the one table where the thing being
-- served is somebody else's biometric data. Metadata listings are not logged: they carry
-- no personal data, and logging every list would bury the reads that matter.
--
-- RETENTION: THERE IS NONE, DELIBERATELY. `crm.notification` is prunable (0024) precisely
-- because a notification is a COPY of a signal and the fact lives elsewhere. An
-- attachment is the opposite: it IS the regulated fact and there is no other copy, so no
-- job here deletes one and no horizon is configurable. Choosing a retention period for
-- sample-disbursement evidence is a statutory question about the jurisdictions this
-- product ships into, and inventing a default would quietly destroy the only copy of the
-- thing an inspection asks for. Left open in ADR-0001 with that reason rather than
-- answered by a number nobody chose.
--
-- ===========================================================================
-- APPEND-ONLY, BECAUSE "RETAKEN" AND "SWAPPED" MUST NOT LOOK THE SAME
-- ===========================================================================
--
-- The row is append-only and the bytes are immutable. A replacement is a NEW attachment
-- that NAMES the one it supersedes, and the superseded row keeps its bytes — the
-- continuation-row pattern of 0030 and the recall pattern of 0025, for the identical
-- reason: a record that can be overwritten is not a record. So a retake is two rows, a
-- chain and a reason; a swap is not expressible at all.
--
-- The one permitted UPDATE is `current -> superseded`, which must name its successor and
-- say why, exactly as 0023's one permitted UPDATE is a revocation. Everything else, and
-- every DELETE, is refused by a trigger.
--
-- A SIGNATURE CANNOT BE SUPERSEDED, and the refusal is explicit rather than emergent. The
-- hash check above would already make a DIFFERENT signature impossible, since the
-- commitment it must match is immutable — so the only blob that could pass is a
-- byte-identical one, which supersession refuses anyway as a no-op. Stating it as its own
-- refusal means the rep is told the real rule: a different signature is a different
-- hand-over, and the ledger's answer to a wrong hand-over is an adjustment carrying a
-- reason (0018), not a corrected image. A receipt IS supersedable — photographing the
-- wrong receipt is an ordinary mistake with no commitment behind it — and the superseded
-- photograph stays, so a reviewer sees both.
--
-- EXACTLY ONE CURRENT ATTACHMENT per (subject, purpose), by a partial unique index,
-- because "which receipt is the receipt" must have one answer.
--
-- THE ID COMES FROM THE DEVICE (README rule 7), like a visit and like a disbursement. A
-- signature is captured at a clinic desk with no signal, so the upload is retried, and a
-- retry must collapse into the row already there rather than produce a second attachment.
-- Reusing an id with DIFFERENT bytes is refused by name — that is the swap, arriving as
-- an id collision.
--
-- ===========================================================================
-- SIZE AND TYPE, IN THE SCHEMA
-- ===========================================================================
--
-- 512 KiB, and the number is DERIVED rather than picked. `MAX_BODY_BYTES` in
-- `packages/api/src/router.ts` is 1 MiB (the ERP's own cap is 10 MiB and is not ours),
-- the only body this API parses is JSON, and base64 inflates by 4/3 — so 512 KiB of blob
-- is 683 KiB of base64 with room left for the envelope, and 768 KiB would not fit. A cap
-- a route cannot deliver under is a cap that reports the wrong error: a rep would be told
-- "payload too large" by the router for a file the schema advertises as acceptable.
-- Signatures are kilobytes; a receipt photograph has to be downscaled on the device,
-- which is what every receipt-capture client does anyway.
--
-- The type allow-list is `image/png`, `image/jpeg`, `application/pdf` and nothing else.
-- No SVG: it is a script container and this system will eventually hand one to a browser.
-- No `application/octet-stream`: a type that says nothing cannot be rendered or validated.
--
-- AND THE DECLARED TYPE IS CHECKED AGAINST THE BYTES. A trigger sniffs the leading magic
-- bytes and refuses a PNG declared as a PDF, because `content_type` is otherwise a
-- client's claim about a file the client also supplied, and it is the claim a browser will
-- act on. Cheap — eight bytes — and it is the only type check that is about the content
-- rather than about the assertion.
--
-- ===========================================================================
-- WHAT IS NOT DONE HERE
-- ===========================================================================
--
-- `crm.expense_claim.receipt_url` is left in place and is now superseded by an attachment
-- of purpose `expense_receipt`. It is not dropped because `packages/expense/src/store.ts`
-- still selects and inserts it, and a migration that breaks another package's store to
-- tidy a column is the wrong trade; removing it belongs with the change that stops reading
-- it. No trigger forbids writing it either, for the same reason.
--
-- No virus scanning. The ERP's `files` contracts declare an `uploading -> scanning ->
-- available -> quarantined` lifecycle and have no runtime behind it; declaring the same
-- states here with nothing scanning would be that mistake with our name on it (README rule
-- 29). An attachment is `current` the moment its bytes verify, and the type allow-list
-- plus the magic-byte check are what is actually enforced.

-- ---------------------------------------------------------------------------
-- The metadata row. Separate from the bytes, and the separation IS the seam: the
-- `BlobStore` owns crm.attachment_blob and nothing else, so an S3 implementation writes
-- no row here and this table is unchanged by the swap.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.attachment (
  -- Device-minted, no default. See the header: a retried offline upload must collapse
  -- into the row already there.
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,

  -- What this attachment IS, which decides every rule that follows: whether a commitment
  -- must be matched, whether it may be superseded, and which table owns it.
  purpose            text NOT NULL CHECK (purpose IN ('disbursement_signature', 'expense_receipt')),

  -- The polymorphic subject, as crm.notification (0021) and crm.outbox (0004) carry one.
  -- Not a foreign key: a column cannot reference two tables, and the alternative — a
  -- nullable FK per subject kind — grows a column per producer and lets a row name two
  -- subjects at once. Existence is validated on write by the trigger below instead, the
  -- same posture ADR-0001 item 3 takes for ERP references.
  subject_table      text NOT NULL CHECK (subject_table IN ('crm.sample_transaction', 'crm.expense_claim')),
  subject_id         uuid NOT NULL,

  content_type       text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  -- 512 KiB. Derived from the API's 1 MiB JSON body cap and base64's 4/3 expansion — see
  -- the header. Zero bytes is not a file.
  byte_size          integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  -- Computed from the stored bytes by the blob trigger's cross-check, never trusted from
  -- a caller, and for a signature it must equal the ledger's commitment.
  content_sha256     char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),

  -- Which BlobStore holds the bytes. On the row rather than in configuration so a
  -- deployment part-way through a migration to object storage can hold both at once.
  storage_backend    text NOT NULL DEFAULT 'postgres' CHECK (storage_backend IN ('postgres')),

  -- The rep themself, or whoever supervises them — enforced below, and recorded either
  -- way, like crm.sample_count.counted_by (0017), so a reviewer can see the difference.
  uploaded_by        uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),

  -- `uploaded_at` is now(), which is the TRANSACTION timestamp: two attachments written
  -- in one transaction share it to the microsecond and nothing may order by it. 0027
  -- added a sequence to crm.outbox after exactly that tie decided a dispatch order. The
  -- same caveats hold — allocation is outside transaction control, so this column HAS
  -- GAPS and must never be read as a count — and the same guarantee is bought: a total
  -- order within one transaction, which is where the ambiguity is.
  seq                bigint NOT NULL GENERATED ALWAYS AS IDENTITY,

  status             text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),

  -- The chain, both ways. The forward link is enough to walk it; the back link makes "has
  -- this been replaced, and by what" a single-row read and lets the CHECK below tie the
  -- status to a real successor rather than to a boolean somebody set.
  --
  -- DEFERRABLE INITIALLY DEFERRED, and it has to be: superseding means marking the old
  -- row first (the partial unique index below admits only one `current` row per subject,
  -- so inserting the successor first would collide) and the successor therefore does not
  -- exist yet when the back link is written. Deferring to COMMIT is what makes
  -- "superseded by a row that was never written" fail instead of committing.
  supersedes_attachment_id    uuid REFERENCES crm.attachment (id) ON DELETE RESTRICT,
  superseded_by_attachment_id uuid REFERENCES crm.attachment (id) ON DELETE RESTRICT
                                DEFERRABLE INITIALLY DEFERRED,
  superseded_reason           text,

  -- A superseded row names its successor, and a row with a successor is superseded.
  CONSTRAINT attachment_superseded_pair
    CHECK ((status = 'superseded') = (superseded_by_attachment_id IS NOT NULL)),
  -- Replacing evidence without saying why is the act this table exists to make visible.
  CONSTRAINT attachment_superseded_reason
    CHECK (status <> 'superseded'
           OR (superseded_reason IS NOT NULL AND length(superseded_reason) BETWEEN 1 AND 500)),
  CONSTRAINT attachment_no_self_chain
    CHECK (supersedes_attachment_id IS DISTINCT FROM id
           AND superseded_by_attachment_id IS DISTINCT FROM id),

  -- A receipt cannot hang off a ledger row and a signature cannot hang off a claim. The
  -- pairing is here rather than only in the route because it decides which commitment
  -- applies, and a mispaired row would skip the signature check entirely.
  CONSTRAINT attachment_purpose_subject CHECK (
    (purpose = 'disbursement_signature' AND subject_table = 'crm.sample_transaction')
    OR (purpose = 'expense_receipt'     AND subject_table = 'crm.expense_claim')
  )
);

-- "Which signature is the signature" has one answer. Partial, so a superseded row does
-- not block its own replacement.
CREATE UNIQUE INDEX uq_attachment_current
  ON crm.attachment (tenant_id, subject_table, subject_id, purpose)
  WHERE status = 'current';

-- The listing query: every attachment on one subject, newest first, chain included.
CREATE INDEX idx_attachment_subject
  ON crm.attachment (tenant_id, subject_table, subject_id, seq DESC);
CREATE INDEX idx_attachment_uploader
  ON crm.attachment (tenant_id, uploaded_by, seq DESC);
-- "What replaced this one", without a sequential scan of the chain.
CREATE INDEX idx_attachment_supersedes
  ON crm.attachment (supersedes_attachment_id) WHERE supersedes_attachment_id IS NOT NULL;

SELECT crm.apply_tenant_isolation('crm.attachment');

-- ---------------------------------------------------------------------------
-- The bytes. One row per attachment, written once, never updated.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.attachment_blob (
  attachment_id  uuid PRIMARY KEY REFERENCES crm.attachment (id) ON DELETE RESTRICT,
  tenant_id      uuid NOT NULL,
  content        bytea NOT NULL,

  -- The same ceiling as the metadata row's `byte_size`, enforced against the actual
  -- octets rather than against the declaration. The trigger below ties the two together;
  -- this holds even if a future writer forgets to.
  CONSTRAINT attachment_blob_size CHECK (octet_length(content) BETWEEN 1 AND 524288)
);

-- ON DELETE RESTRICT above rather than CASCADE, which is the ordinary choice and the
-- wrong one here: crm.attachment cannot be deleted at all, so a cascade would describe a
-- path that does not exist and would quietly become the path if the append-only trigger
-- were ever relaxed.

-- EXTERNAL, not EXTENDED: every admitted content type (PNG, JPEG, PDF) is already
-- compressed, so TOAST's compression attempt costs CPU on every write and every read and
-- recovers approximately nothing. Out-of-line storage is still wanted — it is what keeps
-- a metadata listing from dragging half a megabyte per row through the heap.
ALTER TABLE crm.attachment_blob ALTER COLUMN content SET STORAGE EXTERNAL;

SELECT crm.apply_tenant_isolation('crm.attachment_blob');

-- ---------------------------------------------------------------------------
-- Who looked at the bytes. Append-only, written in the same transaction as the read.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.attachment_access (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  attachment_id  uuid NOT NULL REFERENCES crm.attachment (id) ON DELETE RESTRICT,
  read_by        uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  read_at        timestamptz NOT NULL DEFAULT now(),
  -- Same transaction clock problem as above, same answer: a burst of reads in one
  -- transaction shares `read_at`, so the order is in `seq` or nowhere.
  seq            bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  -- The request's correlation id, so an access record and a log line join. Nullable: a
  -- read from the scheduler or a psql prompt has no request behind it, and inventing one
  -- would make a fabricated id indistinguishable from a real one.
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 64)
);

CREATE INDEX idx_attachment_access_att ON crm.attachment_access (tenant_id, attachment_id, seq DESC);
CREATE INDEX idx_attachment_access_by  ON crm.attachment_access (tenant_id, read_by, seq DESC);

SELECT crm.apply_tenant_isolation('crm.attachment_access');

-- ---------------------------------------------------------------------------
-- Who owns an attachment, and who may read it.
-- ---------------------------------------------------------------------------

/**
 * The rep whose record this attachment hangs off, or NULL.
 *
 * One branch per subject table — see the header for why a CASE rather than a join, and
 * why an unknown branch returning NULL is the fail-closed direction here while the
 * identically shaped `crm.notification_subject_open` fails open.
 *
 * NULL also covers "the subject row does not exist", and the two are deliberately the
 * same answer: an attachment whose subject is gone has nobody accountable for it, and
 * there is no reader to authorise against.
 */
CREATE OR REPLACE FUNCTION crm.attachment_subject_rep(
  p_subject_table text,
  p_subject_id    uuid
)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE p_subject_table
    WHEN 'crm.sample_transaction' THEN
      (SELECT t.rep_profile_id FROM crm.sample_transaction t WHERE t.id = p_subject_id)
    WHEN 'crm.expense_claim' THEN
      (SELECT c.rep_profile_id FROM crm.expense_claim c WHERE c.id = p_subject_id)
    ELSE NULL
  END;
$$;

/**
 * A subject table no branch above knows about.
 *
 * Separate from the resolver for the reason 0024 separates its own: a refusal must be
 * able to say "this kind of subject has no owner rule" rather than "that row is missing",
 * because the two are fixed by different people.
 */
CREATE OR REPLACE FUNCTION crm.attachment_subject_unknown(p_subject_table text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject_table IS NULL
     OR p_subject_table NOT IN ('crm.sample_transaction', 'crm.expense_claim');
$$;

/**
 * Which subject table a purpose hangs off.
 *
 * The same pairing as the `attachment_purpose_subject` CHECK, as a function, because the
 * TRIGGER needs it — see the arm at the top of `crm.attachment_validate` and the ordering
 * note there. The CHECK stays spelled out rather than delegating to this, so the
 * constraint reads as its own statement in `\d crm.attachment`;
 * `subject-coverage.contract.test.ts` asserts the function, the CHECK and the TypeScript
 * constant all agree, which is the only thing that keeps three statements of one rule
 * honest.
 */
CREATE OR REPLACE FUNCTION crm.attachment_subject_table_for(p_purpose text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_purpose
    WHEN 'disbursement_signature' THEN 'crm.sample_transaction'
    WHEN 'expense_receipt'        THEN 'crm.expense_claim'
    ELSE NULL
  END;
$$;

/**
 * May this rep read this attachment's bytes?
 *
 * The single predicate every attachment route applies, and it is `crm.rep_can_supervise`
 * underneath — reused, not restated, because that function is where "whose data may I
 * read" is defined (0019, README rule 19) and a second implementation of it would
 * eventually disagree with the first.
 *
 * AS OF TODAY by default, unlike every write rule in this schema. See the header: a
 * hand-over is judged on the day it happened, but who may look at a third party's
 * signature is a question about who is accountable now.
 */
CREATE OR REPLACE FUNCTION crm.attachment_readable_by(
  p_attachment_id        uuid,
  p_reader_rep_profile_id uuid,
  p_on_date              date DEFAULT CURRENT_DATE
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM crm.attachment a
      -- A LATERAL rather than calling the resolver twice: it reads a table, so the
      -- planner is free to evaluate a repeated call twice, and the second call could in
      -- principle see a different row from the first.
      CROSS JOIN LATERAL (SELECT crm.attachment_subject_rep(a.subject_table, a.subject_id) AS owner) o
     WHERE a.id = p_attachment_id
       AND o.owner IS NOT NULL
       AND crm.rep_can_supervise(p_reader_rep_profile_id, o.owner, p_on_date)
  );
$$;

-- ---------------------------------------------------------------------------
-- The rules a new attachment must satisfy.
-- ---------------------------------------------------------------------------

/**
 * Five questions, each of which an inspection or a disclosure review asks.
 *
 *  - DOES THE SUBJECT EXIST, AND WHO OWNS IT? No owner, no attachment: an attachment
 *    nobody is accountable for is one nobody may read, so it must not be creatable.
 *  - MAY THE UPLOADER ACT FOR THAT REP? The rep themself or their supervisor, by the same
 *    predicate that governs the read.
 *  - DOES IT MATCH THE COMMITMENT? For a signature, the ledger's `signature_sha256` is
 *    the identity of the image and cannot be corrected, so a blob that does not hash to
 *    it is refused. This is the rule the whole migration exists for.
 *  - IS THE SUPERSESSION LEGITIMATE? The row being replaced must be the current one for
 *    the same subject and purpose, must already be marked superseded and must name THIS
 *    row as its successor — so a half-applied replacement cannot commit.
 *  - IS IT ACTUALLY A REPLACEMENT? Identical bytes replace nothing and would add a row to
 *    a chain for no reason.
 */
CREATE OR REPLACE FUNCTION crm.attachment_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner      uuid;
  commitment text;
  prev       record;
BEGIN
  -- FIRST, and the order is the finding rather than a preference.
  --
  -- A BEFORE INSERT row trigger runs AHEAD of constraint evaluation, so this function
  -- speaks before `attachment_purpose_subject` does — the same ordering ADR-0001 item 13
  -- records for the role lockout guard and the four-eyes CHECK. Without this arm a
  -- `disbursement_signature` pointed at an expense claim reached the commitment lookup,
  -- found no `crm.sample_transaction` with that id, and was refused with "records no
  -- signature_sha256": a true sentence about the wrong question, which sends the reader
  -- looking for a missing signature on a row that is not a disbursement at all. The CHECK
  -- stays underneath as the backstop; this is the arm that says what is actually wrong.
  IF NEW.subject_table IS DISTINCT FROM crm.attachment_subject_table_for(NEW.purpose) THEN
    RAISE EXCEPTION
      'a % hangs off %, not off % — the purpose decides the subject table and the two do not pair',
      NEW.purpose, crm.attachment_subject_table_for(NEW.purpose), NEW.subject_table
      USING ERRCODE = 'check_violation';
  END IF;

  -- Unreachable while the arm above and the `attachment_subject_table_check` CHECK both
  -- hold: a known purpose pins a known table, and an unknown purpose is refused by its own
  -- CHECK. It stays for the reason `translateSampleError` keeps its own unreachable arm — a
  -- trigger must not assume the constraint beside it is still there — and because
  -- `crm.attachment_subject_unknown` is the thing a refusal needs in order to say "this
  -- KIND of subject has no owner rule" rather than "that row is missing": the two are
  -- fixed by different people.
  IF crm.attachment_subject_unknown(NEW.subject_table) THEN
    RAISE EXCEPTION
      'crm.attachment_subject_rep has no branch for subject table %, so no rep owns this attachment and nobody could be authorised to read it',
      NEW.subject_table
      USING ERRCODE = 'check_violation';
  END IF;

  owner := crm.attachment_subject_rep(NEW.subject_table, NEW.subject_id);
  IF owner IS NULL THEN
    RAISE EXCEPTION
      'no row % in % — an attachment cannot be created for a subject that does not exist',
      NEW.subject_id, NEW.subject_table
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT crm.rep_can_supervise(NEW.uploaded_by, owner) THEN
    RAISE EXCEPTION
      'rep % neither owns nor supervises rep %, so may not attach to their %',
      NEW.uploaded_by, owner, NEW.subject_table
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.purpose = 'disbursement_signature' THEN
    SELECT t.signature_sha256 INTO commitment
      FROM crm.sample_transaction t WHERE t.id = NEW.subject_id;
    IF commitment IS NULL THEN
      RAISE EXCEPTION
        'sample transaction % records no signature_sha256, so there is no commitment for an image to satisfy',
        NEW.subject_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF commitment <> NEW.content_sha256 THEN
      RAISE EXCEPTION
        'this image hashes to %, but sample transaction % committed to % — refusing: a stored signature that disagrees with the commitment is evidence of nothing, and the ledger is append-only so the commitment cannot be corrected',
        NEW.content_sha256, NEW.subject_id, commitment
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.supersedes_attachment_id IS NOT NULL THEN
    IF NEW.purpose = 'disbursement_signature' THEN
      RAISE EXCEPTION
        'a disbursement signature cannot be superseded: the ledger commitment fixes which image is the signature and cannot be corrected (0018 is append-only). A different signature is a different hand-over — post an adjustment with a reason instead.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT a.status, a.subject_table, a.subject_id, a.purpose, a.content_sha256,
           a.superseded_by_attachment_id
      INTO prev
      FROM crm.attachment a WHERE a.id = NEW.supersedes_attachment_id;
    IF prev IS NULL THEN
      RAISE EXCEPTION 'no attachment % to supersede', NEW.supersedes_attachment_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF prev.subject_table <> NEW.subject_table
       OR prev.subject_id <> NEW.subject_id
       OR prev.purpose <> NEW.purpose THEN
      RAISE EXCEPTION
        'attachment % is the % of % %, so it cannot be superseded by the % of % %',
        NEW.supersedes_attachment_id, prev.purpose, prev.subject_table, prev.subject_id,
        NEW.purpose, NEW.subject_table, NEW.subject_id
        USING ERRCODE = 'check_violation';
    END IF;
    -- The old row is marked FIRST (the partial unique index admits one current row), so
    -- by the time the successor is inserted the chain must already point at it. Checking
    -- both halves here is what makes a half-applied replacement impossible.
    IF prev.status <> 'superseded' OR prev.superseded_by_attachment_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION
        'attachment % is % and names % as its successor — mark it superseded by % first, with a reason',
        NEW.supersedes_attachment_id, prev.status, prev.superseded_by_attachment_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF prev.content_sha256 = NEW.content_sha256 THEN
      RAISE EXCEPTION
        'attachment % already holds these exact bytes (%), so this supersedes nothing',
        NEW.supersedes_attachment_id, NEW.content_sha256
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attachment_validate
  BEFORE INSERT ON crm.attachment
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_validate();

/**
 * Append-only, with one exception.
 *
 * DELETE is refused outright: the bytes are the evidence and there is no retention
 * horizon that would remove them (see the header). UPDATE is refused except for the
 * single transition `current -> superseded`, which must name a successor and give a
 * reason — the same shape as 0023's one permitted UPDATE being a revocation.
 *
 * Every other column is compared rather than listed as mutable, so a column added by a
 * later migration is immutable by default. The alternative — enumerating what may change
 * — silently admits anything nobody remembered to name.
 */
CREATE OR REPLACE FUNCTION crm.attachment_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'crm.attachment is append-only (attempted DELETE on %). An attachment is the regulated record itself, not a copy of one — supersede it with a reason instead.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'current' OR NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'the only permitted update to crm.attachment is current -> superseded (attempted % -> % on %)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.purpose, NEW.subject_table, NEW.subject_id,
      NEW.content_type, NEW.byte_size, NEW.content_sha256, NEW.storage_backend,
      NEW.uploaded_by, NEW.uploaded_at, NEW.seq, NEW.supersedes_attachment_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.purpose, OLD.subject_table, OLD.subject_id,
      OLD.content_type, OLD.byte_size, OLD.content_sha256, OLD.storage_backend,
      OLD.uploaded_by, OLD.uploaded_at, OLD.seq, OLD.supersedes_attachment_id) THEN
    RAISE EXCEPTION
      'superseding attachment % may set only superseded_by_attachment_id, superseded_reason and status',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attachment_append_only
  BEFORE UPDATE OR DELETE ON crm.attachment
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_append_only();

/**
 * The bytes must agree with everything claimed about them.
 *
 * Three cross-checks against the metadata row, all of them comparing a CLIENT'S CLAIM
 * with the OCTETS ACTUALLY STORED, because every one of the three is a claim the client
 * also supplied the evidence for:
 *
 *  - the digest, computed here with `pg_catalog.sha256` rather than taken from the
 *    caller. This is what makes the signature commitment check in
 *    `crm.attachment_validate` mean something: that trigger compares `content_sha256`
 *    against the ledger, and `content_sha256` is only trustworthy because this one proves
 *    it describes the stored bytes;
 *  - the length, so `byte_size` in a listing is the size of the file and not a number
 *    somebody sent;
 *  - the leading magic bytes against `content_type`, because that header is what a
 *    browser will act on and a PDF declared as a PNG is how an upload becomes an exploit.
 *
 * A PDF's `%PDF-` may legally be preceded by junk, which some scanners emit. Not admitted
 * here: a lenient sniff is a sniff that can be satisfied by anything, and a client that
 * wants its receipt stored can strip the preamble.
 */
CREATE OR REPLACE FUNCTION crm.attachment_blob_verify()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  att    record;
  digest text := encode(sha256(NEW.content), 'hex');
  size   integer := octet_length(NEW.content);
BEGIN
  SELECT a.tenant_id, a.content_type, a.byte_size, a.content_sha256, a.storage_backend
    INTO att FROM crm.attachment a WHERE a.id = NEW.attachment_id;
  IF att IS NULL THEN
    RAISE EXCEPTION 'no attachment % to store bytes for', NEW.attachment_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF att.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'attachment % belongs to another tenant', NEW.attachment_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF att.storage_backend <> 'postgres' THEN
    RAISE EXCEPTION
      'attachment % declares storage_backend %, so its bytes do not live in this table',
      NEW.attachment_id, att.storage_backend
      USING ERRCODE = 'check_violation';
  END IF;

  IF size <> att.byte_size THEN
    RAISE EXCEPTION
      'attachment % declares % bytes and these are %',
      NEW.attachment_id, att.byte_size, size
      USING ERRCODE = 'check_violation';
  END IF;
  IF digest <> att.content_sha256 THEN
    RAISE EXCEPTION
      'attachment % declares sha256 % and these bytes hash to %',
      NEW.attachment_id, att.content_sha256, digest
      USING ERRCODE = 'check_violation';
  END IF;

  -- Parenthesised, and with an explicit ELSE: plpgsql's IF reads to the first bare `END`,
  -- so an unwrapped CASE is a syntax error here. `ELSE false` is unreachable while the
  -- CHECK on content_type holds and is still the right default — a type nothing knows how
  -- to recognise is refused rather than admitted unverified.
  IF NOT (CASE att.content_type
    WHEN 'image/png'       THEN substring(NEW.content from 1 for 8) = '\x89504e470d0a1a0a'::bytea
    WHEN 'image/jpeg'      THEN substring(NEW.content from 1 for 3) = '\xffd8ff'::bytea
    WHEN 'application/pdf' THEN substring(NEW.content from 1 for 5) = '\x255044462d'::bytea
    ELSE false
  END) THEN
    RAISE EXCEPTION
      'attachment % declares content_type % and the bytes do not begin like one (leading octets %)',
      NEW.attachment_id, att.content_type, encode(substring(NEW.content from 1 for 8), 'hex')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attachment_blob_verify
  BEFORE INSERT ON crm.attachment_blob
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_blob_verify();

/**
 * The bytes are written once.
 *
 * No permitted update at all, unlike the metadata row: there is no correction to an
 * attachment's content, only a successor. An UPDATE here would change what a committed
 * sha256 refers to, which is the one thing this subsystem must make impossible.
 */
CREATE OR REPLACE FUNCTION crm.attachment_blob_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.attachment_blob is write-once (attempted % on %). The content hash is a commitment; changing the bytes behind it would make every reference to it a lie.',
    TG_OP, OLD.attachment_id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER attachment_blob_immutable
  BEFORE UPDATE OR DELETE ON crm.attachment_blob
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_blob_immutable();

/**
 * The access log is append-only too, and for a sharper reason than the others.
 *
 * It records who looked at a third party's biometric data. A log whose rows can be
 * removed answers "who read this" with whatever survived, which is worse than having no
 * answer because it reads like one.
 */
CREATE OR REPLACE FUNCTION crm.attachment_access_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.attachment_access is append-only (attempted % on %)', TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER attachment_access_append_only
  BEFORE UPDATE OR DELETE ON crm.attachment_access
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_access_append_only();

-- ---------------------------------------------------------------------------

/**
 * The attachments on one subject, newest first, with the owning rep and the chain.
 *
 * A function rather than a view so the owner resolution happens once per row and so the
 * caller cannot forget to scope it: every caller passes the reader, and a reader who may
 * not see the subject gets an empty set rather than a refusal — the same shape
 * `crm.visible_account_ids` has, and for the same reason (README rule "fail closed": an
 * unresolvable identity yields an empty result set, never an unfiltered one).
 */
CREATE OR REPLACE FUNCTION crm.attachments_for_subject(
  p_reader_rep_profile_id uuid,
  p_subject_table         text,
  p_subject_id            uuid,
  p_on_date               date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id                          uuid,
  purpose                     text,
  content_type                text,
  byte_size                   integer,
  content_sha256              char(64),
  storage_backend             text,
  status                      text,
  uploaded_by                 uuid,
  uploaded_at                 timestamptz,
  seq                         bigint,
  supersedes_attachment_id    uuid,
  superseded_by_attachment_id uuid,
  superseded_reason           text,
  owner_rep_profile_id        uuid
)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.purpose, a.content_type, a.byte_size, a.content_sha256, a.storage_backend,
         a.status, a.uploaded_by, a.uploaded_at, a.seq,
         a.supersedes_attachment_id, a.superseded_by_attachment_id, a.superseded_reason,
         o.owner
    FROM crm.attachment a
    CROSS JOIN LATERAL (SELECT crm.attachment_subject_rep(a.subject_table, a.subject_id) AS owner) o
   WHERE a.subject_table = p_subject_table
     AND a.subject_id = p_subject_id
     AND o.owner IS NOT NULL
     AND crm.rep_can_supervise(p_reader_rep_profile_id, o.owner, p_on_date)
   ORDER BY a.seq DESC;
$$;
