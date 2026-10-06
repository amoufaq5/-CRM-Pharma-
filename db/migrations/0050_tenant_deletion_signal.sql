-- The CRM learns that the ERP deleted a tenant, and stops.
--
-- THE GAP. CrossEngin's ADR-0316 to ADR-0320 (landed on its `main` as #192–#196, read on
-- 2026-10-06) made a tenant deletion true: a tenant serving its own activated manifest gets
-- its own Postgres schema, the schema is dropped on a GDPR Article 17 deletion, and a
-- tombstone is composed from per-subsystem attestations and anchored in the forensic chain,
-- all in one transaction. ADR-0316 says plainly what it was closing — the flow used to issue
-- a signed `TombstoneRecord` while "every row of the tenant's actual business data survived",
-- so the tombstone "was not incomplete. It was false, and it was cryptographically signed."
--
-- The CRM holds that tenant's `product_snapshot`, `rep_snapshot` and `account_snapshot`, its
-- `crm.outbox` rows, its `crm.expense_claim` rows carrying `erp_ledger_account_code`, its
-- notifications, its attachments and its `crm.erp_service_principal`. Nothing listened. So
-- the ERP's proof became true about the ERP and false about a system holding copies of the
-- same personal data — the identical defect, one system over, and not one the ERP can close
-- for us.
--
-- WHAT THIS MIGRATION IS, AND WHAT IT IS NOT. It is the SIGNAL: a place to record that the
-- deletion was observed, the evidence it was observed by, and a status that takes the tenant
-- out of every loop that touches its data. It is NOT the erasure. Erasing the CRM's copies
-- needs a decision this schema cannot make for itself — `crm.expense_claim` may be a
-- statutory accounting record in some jurisdictions, and a deletion that destroys it is as
-- wrong as one that keeps everything. ADR-0316's own answer to that shape of question is
-- `retentionObligation` on an attestation: "we did not delete this, and here is the law that
-- says so". The CRM needs the same vocabulary before it can erase anything, and inventing it
-- in the migration that first notices the problem would be guessing.
--
-- So the rule here is narrower and defensible on its own: ONCE WE KNOW, WE STOP. A tenant
-- whose controller relationship has ended is a tenant whose data we must stop processing,
-- and stopping is something we can do correctly today.

-- ---------------------------------------------------------------------------
-- 1. The job vocabulary, declared once (0049's shape, for 0049's reason).
-- ---------------------------------------------------------------------------
-- `scheduled_job_job_check` is the fourth literal list of job names in this schema's
-- history: 0009 wrote three, and 0022, 0024 and 0031 each dropped the constraint and
-- restated the whole set to add one. That is exactly the lockstep 0046 objected to and 0049
-- fixed for the notification kinds, and it has already cost three migrations — so the list
-- moves into a function and the CHECK calls it. Adding a job is now one
-- `CREATE OR REPLACE FUNCTION`.
--
-- Unlike `crm.notification_kinds()` this list has a SECOND copy that is not SQL: `JobName`
-- in `packages/scheduler/src/jobs.ts`, which is the union the dispatcher switches on. That
-- copy cannot be removed — a `switch` needs the names at compile time — so a test asserts
-- the two agree, which is the same arrangement 0049 left for `NOTIFICATION_KINDS`.
--
-- The narrowing caveat 0049 recorded applies here verbatim: `CREATE OR REPLACE FUNCTION`
-- does not revalidate the constraints that call it, so REMOVING a job name goes through
-- `DROP CONSTRAINT` + `ADD CONSTRAINT` and the scan names the rows. Widening needs no scan
-- because every existing row already satisfies a superset.
CREATE OR REPLACE FUNCTION crm.scheduled_jobs()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['relay_drain',
               'snapshot_incremental',
               'snapshot_full',
               'expiry_sweep',
               'notify_dispatch',
               'notify_prune',
               'expense_post',
               'tenant_deletion_watch'];
$$;

ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job = ANY (crm.scheduled_jobs()));

-- ---------------------------------------------------------------------------
-- 2. The terminal status, and the receipt that is the only way to reach it.
-- ---------------------------------------------------------------------------
-- `crm.tenant` is the CRM's own registry and the one deliberately RLS-exempt table: the
-- scheduler reads `WHERE status = 'active'` from it to decide whose work to do. That single
-- enumeration point is what makes a status the right mechanism — one word takes a tenant out
-- of `relay_drain`, `snapshot_incremental`, `snapshot_full`, `expiry_sweep`,
-- `notify_dispatch`, `notify_prune` and `expense_post` at once, rather than seven places
-- each remembering to ask.
--
-- Three consequences of that, all intended, and worth naming because each one looks like a
-- bug from a distance:
--
--   * Queued ERP writes for a deleted tenant are never sent. They would fail anyway — the
--     tenant's schema is gone — and a write we cannot deliver is better left visibly pending
--     than retried to the dead-letter cap against a tenant that no longer exists.
--   * Pending webhook notifications are never pushed. This is the point: pushing a deleted
--     tenant's rep names and account ids to a third party AFTER the controller ended the
--     relationship is the disclosure the deletion exists to stop.
--   * The watch job itself stops running for that tenant, because it is no longer active.
--     Correct: the mark is terminal, so there is nothing left to observe.
--
-- A plain DROP/ADD for this CHECK rather than a function, deliberately, and the asymmetry
-- with part 1 is the distinction 0046 drew: the job list is restated in TypeScript and has
-- been widened three times, where this list has one home, has never been widened, and is
-- read by one query. A function here would be indirection bought with nothing.
ALTER TABLE crm.tenant DROP CONSTRAINT tenant_status_check;
ALTER TABLE crm.tenant ADD CONSTRAINT tenant_status_check
  CHECK (status IN ('active', 'paused', 'disabled', 'erp_deleted'));

-- The receipt, copied from the ERP's `tombstoneReceipt` payload. Columns and not a jsonb
-- blob, because every one of them is something a person has to be able to ask about without
-- knowing a path expression — and because a CHECK cannot constrain what it cannot see.
ALTER TABLE crm.tenant
  ADD COLUMN erp_tombstone_id               text,
  ADD COLUMN erp_tombstone_kind             text,
  ADD COLUMN erp_tombstone_deleted_at       timestamptz,
  ADD COLUMN erp_tombstone_proof_sha256     text,
  ADD COLUMN erp_tombstone_chain_entry_hash text,
  ADD COLUMN erp_tombstone_observed_at      timestamptz;

-- THE STATUS CANNOT BE TYPED WITHOUT THE RECEIPT, and the receipt cannot be filed without
-- the status. An operator with a psql prompt cannot quarantine a tenant by writing one word,
-- which matters because this status stops a whole tenant's field force from syncing: the
-- only thing that produces it is a tombstone the ERP actually returned.
ALTER TABLE crm.tenant
  ADD CONSTRAINT tenant_erp_deleted_needs_receipt
    CHECK ((status = 'erp_deleted') = (erp_tombstone_id IS NOT NULL));

-- THE KIND IS CHECKED, and this is the sharpest line in the file.
--
-- `GET /v1/platform/tenants/{id}/tombstones` returns BOTH kinds the ERP can store —
-- `DELETABLE_TOMBSTONE_KINDS = ["tenant_deletion", "data_subject_erasure"]`. A
-- `data_subject_erasure` tombstone is about ONE person exercising Article 17, in a tenant
-- that is otherwise entirely alive. Reading the list and reacting to whatever is in it would
-- take a working tenant's whole field force offline the first time one employee asked to be
-- forgotten. The classifier in `packages/acl` filters on kind, and this CHECK is the second
-- layer, because a rule that only exists in the code that happens to call it is one refactor
-- from being gone.
ALTER TABLE crm.tenant
  ADD CONSTRAINT tenant_erp_tombstone_kind
    CHECK (erp_tombstone_kind IS NULL OR erp_tombstone_kind = 'tenant_deletion');

-- Shape checks on the evidence. A proof hash that is not a sha256 is not a proof, and the
-- point of storing it is that somebody can later match it against the ERP's chain.
ALTER TABLE crm.tenant
  ADD CONSTRAINT tenant_erp_tombstone_proof_shape
    CHECK (erp_tombstone_proof_sha256 IS NULL OR erp_tombstone_proof_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT tenant_erp_tombstone_chain_shape
    CHECK (erp_tombstone_chain_entry_hash IS NULL OR erp_tombstone_chain_entry_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT tenant_erp_tombstone_id_shape
    CHECK (erp_tombstone_id IS NULL OR erp_tombstone_id ~ '^tomb_[A-Za-z0-9_-]{12,40}$');

-- `chain_entry_hash` is NULLABLE on purpose: the ERP's own receipt types it as
-- `string | null`, because a tombstone is stored whether or not the chain anchor came back,
-- and ADR-0319 is explicit that the deletion commits with its proof rather than waiting on
-- anything. A null here means "deleted, with no chain coordinate we can quote" — which is
-- weaker evidence and still a deletion. Requiring it would make us refuse to believe a
-- deletion that happened.

/**
 * `erp_deleted` is terminal, and the evidence under it is write-once.
 *
 * A deletion is a fact about the world, not a state we manage: the ERP dropped the schema and
 * signed for it, and there is no observation that could undo that. So there is no transition
 * out, and the receipt cannot be rewritten to point at a different tombstone — which would
 * leave the status attesting to a deletion nobody can check, the shape 0047 closed for an
 * approved expense claim.
 *
 * Reinstating a tenant after this is deliberately DDL, as 0044's lifecycle escape hatch is:
 * if the ERP is ever able to resurrect one, that is a new fact needing its own migration and
 * its own argument, not an UPDATE somebody can type at four in the morning.
 */
CREATE OR REPLACE FUNCTION crm.tenant_erp_deleted_is_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'erp_deleted' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'tenant-erp-deleted-terminal: tenant % is erp_deleted and cannot become % — the ERP dropped this tenant''s schema and signed a tombstone for it (%), which no observation here can undo. Reinstating a tenant is a migration, not an update.',
      OLD.tenant_id, NEW.status, OLD.erp_tombstone_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.erp_tombstone_id               IS DISTINCT FROM OLD.erp_tombstone_id
  OR NEW.erp_tombstone_kind             IS DISTINCT FROM OLD.erp_tombstone_kind
  OR NEW.erp_tombstone_deleted_at       IS DISTINCT FROM OLD.erp_tombstone_deleted_at
  OR NEW.erp_tombstone_proof_sha256     IS DISTINCT FROM OLD.erp_tombstone_proof_sha256
  OR NEW.erp_tombstone_chain_entry_hash IS DISTINCT FROM OLD.erp_tombstone_chain_entry_hash
  OR NEW.erp_tombstone_observed_at      IS DISTINCT FROM OLD.erp_tombstone_observed_at THEN
    RAISE EXCEPTION
      'tenant-erp-deleted-terminal: tenant % is erp_deleted, so its tombstone receipt is fixed at % — rewriting the evidence would leave the status attesting to a deletion nobody can check.',
      OLD.tenant_id, OLD.erp_tombstone_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER tenant_erp_deleted_is_terminal
  BEFORE UPDATE ON crm.tenant
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_erp_deleted_is_terminal();

-- ---------------------------------------------------------------------------
-- 3. Every observation, including the ones that answered nothing.
-- ---------------------------------------------------------------------------
-- A fail-closed signal that silently never fires is worse than no signal: the deployment
-- believes it is watching. So each check is recorded with its verdict, and `unknown` is a
-- first-class answer rather than an absence — because almost everything that can go wrong
-- here produces one. The ERP's own route says so in as many words: a stored tombstone it
-- cannot re-parse comes back `503 tombstones_unreadable` with the detail "a stored tombstone
-- could not be read; do not treat this as an absence".
--
-- The three verdicts, and why there are exactly three:
--
--   live     — the ERP answered 200 and the list holds no `tenant_deletion` tombstone. An
--              AFFIRMATIVE not-deleted, which is the only kind worth recording.
--   deleted  — a `tenant_deletion` tombstone for this tenant, in hand.
--   unknown  — anything else: 403 (the read role was never granted), 404 (the ERP does not
--              run `--tenant-deletion-routes`), 503, a timeout, an unparseable body. None of
--              these mean "not deleted", and none of them mean "deleted".
--
-- There is deliberately no fourth verdict for "probably deleted". Nothing here ever INFERS a
-- deletion — not from an empty entity list, not from a 401, not from the tenant's schema
-- having vanished. The only thing that marks a tenant is a tombstone that names it.
CREATE TABLE crm.tenant_deletion_check (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,

  -- `now()` is the transaction timestamp, so two checks written in one transaction share it
  -- exactly and nothing may order by it. The same lesson as 0027's outbox, 0033's attachment
  -- access, 0041's dead letters and 0046's deliveries; this is the fifth table to need it and
  -- the first to be written with it from the start without being told.
  seq         bigint NOT NULL GENERATED ALWAYS AS IDENTITY,

  checked_at  timestamptz NOT NULL DEFAULT now(),
  verdict     text NOT NULL CHECK (verdict IN ('live', 'deleted', 'unknown')),

  -- The HTTP status the ERP answered with, or NULL when there was no answer at all (a
  -- timeout, a refused connection). Distinguishing those matters: a 403 is a configuration
  -- fault somebody must fix, where a timeout is weather.
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),

  -- Why, in the words of whatever refused. Required for `unknown`, because an unknown with
  -- no reason is the thing this table exists to stop.
  detail      text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 500),

  CONSTRAINT tenant_deletion_check_unknown_has_reason
    CHECK (verdict <> 'unknown' OR detail IS NOT NULL)
);

CREATE INDEX idx_tenant_deletion_check_recent
  ON crm.tenant_deletion_check (tenant_id, seq DESC);

SELECT crm.apply_tenant_isolation('crm.tenant_deletion_check');

/**
 * Keeps the newest 20 checks per tenant, trimmed by the insert that makes a 21st.
 *
 * 0034's ring and 0034's reasoning, with one thing that makes it simpler here: the
 * observation that matters is copied onto `crm.tenant` in the SAME transaction that records
 * it, so the ring never has to make an exception for the `deleted` row. At the daily cadence
 * the job ships with, twenty is about three weeks — long enough to see "we have been getting
 * 403 since the deployment" and short enough that nobody mistakes it for an audit trail. The
 * audit trail is the tombstone, and it is the ERP's.
 *
 * Trimmed by `seq` and not `checked_at`, for the reason the column exists.
 */
CREATE OR REPLACE FUNCTION crm.tenant_deletion_check_trim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM crm.tenant_deletion_check c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.seq < (SELECT min(k.seq)
                    FROM (SELECT k2.seq
                            FROM crm.tenant_deletion_check k2
                           WHERE k2.tenant_id = NEW.tenant_id
                           ORDER BY k2.seq DESC
                           LIMIT 20) k);
  RETURN NULL;
END
$$;

CREATE OR REPLACE TRIGGER tenant_deletion_check_trim
  AFTER INSERT ON crm.tenant_deletion_check
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_deletion_check_trim();
