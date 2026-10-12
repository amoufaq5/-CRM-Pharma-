-- The orphan check Q1's answer promised, and the register that makes it mean something.
--
-- WHAT IS BROKEN. ADR-0001 Q1 chose "3-degraded" over migrating the ERP to typed columns, and
-- the answer was not "no foreign keys". It was:
--
--     3-degraded. No FKs; ACL-enforced integrity PLUS A NIGHTLY ORPHAN CHECK.
--
-- `crm.referential_check_run` has existed since migration 0005 to hold its results, with a
-- partial index on `orphan_count > 0` so a human could find the interesting rows, and a header
-- saying "this job reports; it never auto-heals, because an orphan means either an ERP deletion
-- we should have been told about or an ACL bug, and both want a human". Nothing has ever written
-- a row. The scheduler registers ten jobs and none of them is this one, so the table is empty in
-- every deployment and the half of Q1 meant to catch what the absent foreign keys cannot was
-- never delivered.
--
-- WHY IT WAS NOT BUILT, WHICH IS THE PART WORTH ANSWERING FIRST. The open row recorded the
-- reason honestly and it is a real objection:
--
--     what it should CHECK is a real question: a snapshot row naming an ERP record that no
--     longer exists is the obvious case and is also the expected steady state of a full sweep
--     against a system that keeps no per-record tombstone, so an orphan count that is always
--     non-zero teaches nobody anything.
--
-- That objection kills the obvious design and not the useful one. It is an argument against
-- checking the SNAPSHOTS against the ERP — and the snapshots are the CRM's mirror of somebody
-- else's master data, which drifts by design and is reconciled by `deleteStale`, not by an
-- orphan report. The check that earns its place runs the other way round: the CRM's OWN
-- operational rows against the CRM's OWN mirror.
--
--   * `crm.visit.erp_account_id` is NOT NULL and the ACL validated it against
--     `crm.account_snapshot` when the visit was recorded.
--   * `crm.sample_lot.erp_item_id` is NOT NULL and was validated against
--     `crm.product_snapshot`.
--   * `crm.sample_transaction.erp_warehouse_id` was validated against
--     `crm.warehouse_snapshot`, and since 0058 a receipt naming a depot the ERP does not have
--     is refused at the point of entry.
--
-- So a CRM row naming a record its own snapshot does not hold is not a steady state. It is one
-- of exactly two things, and the table's 0005 header already named both: an ERP deletion nobody
-- told us about, or an ACL bug. Both want a human, neither is expected, and a zero here is a
-- claim worth making.
--
-- THE FAIL-CLOSED RULE, which is the difference between this check and a liar. Every row would
-- read as an orphan against a snapshot that has never synced, and most would against one that
-- is a week behind. `evaluateStaleness` already distinguishes `never_synced` from stale, so the
-- runner refuses to count orphans against a mirror it cannot trust and records `unverifiable`
-- with the reason. A run that says "we could not look" is not a run that says "there is nothing
-- there" — the same distinction `ChannelCoverageReport.unreadable` draws, and 0051's distinction
-- between an `undecided` disposition and no row at all.
--
-- AND A REGISTER, because the check is only as good as its completeness. A runner driven by a
-- list in TypeScript is a list that goes stale the first time somebody adds a column — which is
-- how `crm.referential_check_run` came to be empty for sixty-one migrations. 0051 solved this
-- shape already: derive the population from `pg_catalog`, declare a decision per member, and
-- refuse the whole thing when a member has no decision. This is that, for the `crm.erp_record_id`
-- domain:
--
--   * every column of that domain in `crm` needs a row in `crm.erp_reference_register`;
--   * `crm.unregistered_erp_references()` derives the gap from the catalog and must be empty;
--   * a reference with no mirror to check it against is declared `reference` with a QUESTION
--     rather than omitted, so "we cannot check this one" is in the register instead of being
--     the silence that looks like completeness.
--
-- THREE KINDS, because not every column of that domain is a reference. `account_snapshot.
-- erp_account_id` IS the mirror's key — the thing references are checked against, with nothing
-- above it to check. `crm.outbox.target_record_id` is the CRM's own deterministic id for a record
-- it is about to create at the ERP, so before the write lands there is deliberately nothing
-- there. Calling either an "unverifiable reference" would be false, and a register that said so
-- would train whoever reads it to ignore the real ones.

-- ---------------------------------------------------------------------------
-- 1. The register.
-- ---------------------------------------------------------------------------
-- PLATFORM-WIDE, no RLS, like `crm.data_disposition` and for the same reason: it describes the
-- SCHEMA rather than anybody's rows, and a tenant that could edit which of its references get
-- checked would be a tenant whose references are not checked.
CREATE TABLE crm.erp_reference_register (
  -- Bare names within `crm`, which is the only schema this register governs. The trigger below
  -- refuses a pair that is not a real column, because a row naming `crm.vist.erp_account_id`
  -- would describe nothing while making the register look complete.
  source_table       text NOT NULL CHECK (source_table  ~ '^[a-z][a-z0-9_]{2,62}$'),
  source_column      text NOT NULL CHECK (source_column ~ '^[a-z][a-z0-9_]{2,62}$'),

  -- `reference`   — names a record the ERP owns. The only kind the check looks at.
  -- `mirror_key`  — IS a snapshot's key: what references are checked against.
  -- `own_id`      — the CRM's own deterministic id for a record it creates at the ERP, so
  --                 nothing is there until the write lands and an absence is not an orphan.
  kind               text NOT NULL CHECK (kind IN ('reference', 'mirror_key', 'own_id')),

  -- The ERP entity as the ERP's manifest spells it (`Account`, `Item`, `Employee`, …). Carried
  -- as text and not validated against the captured baseline: the entity-name allow-list is
  -- ADR-0001 Q5's own open question, and a second opinion here would be a third copy.
  erp_entity         text NOT NULL CHECK (length(erp_entity) BETWEEN 2 AND 100),

  -- The bare `crm` snapshot table that can answer "does this record exist", and its key column.
  -- Both or neither.
  verifiable_against text CHECK (verifiable_against IS NULL OR verifiable_against ~ '^[a-z][a-z0-9_]{2,62}$'),
  verify_column      text CHECK (verify_column      IS NULL OR verify_column      ~ '^[a-z][a-z0-9_]{2,62}$'),

  -- Required exactly when a reference has NO mirror: what would have to exist before this one
  -- could be checked. 0051's rule — a register whose unanswerable rows do not say what the
  -- question is just moves the silence somewhere harder to find.
  question           text CHECK (question IS NULL OR length(question) BETWEEN 10 AND 1000),

  -- What this column means, in a sentence, always. The register is read by whoever is deciding
  -- whether an orphan matters, and "visit.erp_account_id" alone does not tell them.
  note               text NOT NULL CHECK (length(note) BETWEEN 10 AND 1000),

  declared_by        text NOT NULL CHECK (length(declared_by) BETWEEN 1 AND 200),
  declared_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (source_table, source_column),

  -- One constraint per rule, so a refusal names which rule was broken rather than handing back
  -- a disjunction to read.
  CONSTRAINT erp_reference_mirror_is_a_table_and_a_column
    CHECK ((verifiable_against IS NULL) = (verify_column IS NULL)),
  CONSTRAINT erp_reference_only_a_reference_is_checkable
    CHECK (kind = 'reference' OR (verifiable_against IS NULL AND question IS NULL)),
  -- XOR, deliberately: a reference either has a mirror or has a question, never both and never
  -- neither. Neither is the silence this register exists to make impossible.
  CONSTRAINT erp_reference_has_a_mirror_or_a_question
    CHECK (kind <> 'reference' OR ((verifiable_against IS NOT NULL) <> (question IS NOT NULL)))
);

COMMENT ON TABLE crm.erp_reference_register IS
  'Every crm.erp_record_id column in the schema, and whether an orphan check can verify it. Completeness is enforced by crm.unregistered_erp_references(), derived from pg_catalog — ADR-0001 Q1''s "nightly orphan check" is only worth running if it knows what it is not checking.';

/**
 * A register row must name a real column, and a mirror it names must be able to answer.
 *
 * Both halves matter and the second is the one that bites: a row declaring
 * `verifiable_against = 'account_snapshot', verify_column = 'erp_acount_id'` would make the
 * runner's join fail at 3am on a typo, where this refuses it in the migration that wrote it.
 */
CREATE OR REPLACE FUNCTION crm.erp_reference_names_real_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src regclass;
  tgt regclass;
BEGIN
  src := to_regclass('crm.' || quote_ident(NEW.source_table));
  IF src IS NULL THEN
    RAISE EXCEPTION
      'erp-reference-unknown-table: there is no table crm.% — a register row naming a table that does not exist would make the register look complete while governing nothing',
      NEW.source_table
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = src AND a.attname = NEW.source_column
                    AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE EXCEPTION
      'erp-reference-unknown-column: crm.% has no column %',
      NEW.source_table, NEW.source_column
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.verifiable_against IS NOT NULL THEN
    tgt := to_regclass('crm.' || quote_ident(NEW.verifiable_against));
    IF tgt IS NULL THEN
      RAISE EXCEPTION
        'erp-reference-unknown-mirror: there is no table crm.% to verify crm.%.% against',
        NEW.verifiable_against, NEW.source_table, NEW.source_column
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = tgt AND a.attname = NEW.verify_column
                      AND a.attnum > 0 AND NOT a.attisdropped) THEN
      RAISE EXCEPTION
        'erp-reference-unknown-mirror-column: crm.% has no column % — the orphan check would fail on this row rather than report on it',
        NEW.verifiable_against, NEW.verify_column
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- A mirror the check joins per tenant must be tenant-scoped, or the join would compare a
    -- tenant's rows against everybody's and report a clean result for the wrong reason.
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = tgt AND a.attname = 'tenant_id' AND NOT a.attisdropped) THEN
      RAISE EXCEPTION
        'erp-reference-mirror-not-tenant-scoped: crm.% has no tenant_id, so an orphan check against it would cross tenants',
        NEW.verifiable_against
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER erp_reference_names_real_columns
  BEFORE INSERT OR UPDATE ON crm.erp_reference_register
  FOR EACH ROW EXECUTE FUNCTION crm.erp_reference_names_real_columns();

-- ---------------------------------------------------------------------------
-- 2. Completeness, which is the only property that matters.
-- ---------------------------------------------------------------------------
/**
 * Columns of the `crm.erp_record_id` domain that nobody has declared.
 *
 * 0051's guard, for a different population. Empty is the only acceptable answer: a column
 * naming an ERP record and absent from the register is a reference the orphan check does not
 * know about, which is how a check comes to pass while missing the thing it was built for.
 *
 * Derived from `pg_catalog` and never from a list — the list is the thing that goes stale, and
 * the sixty-one migrations `crm.referential_check_run` spent empty are what a stale list costs.
 */
CREATE OR REPLACE FUNCTION crm.unregistered_erp_references()
RETURNS TABLE (source_table text, source_column text)
LANGUAGE sql STABLE AS $$
  SELECT c.relname, a.attname
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'crm'
     AND c.relkind = 'r'
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.atttypid = 'crm.erp_record_id'::regtype
     AND NOT EXISTS (SELECT 1 FROM crm.erp_reference_register r
                      WHERE r.source_table = c.relname AND r.source_column = a.attname)
   ORDER BY c.relname, a.attname;
$$;

/**
 * And the other direction: a register row whose column has been dropped or retyped.
 *
 * The trigger refuses a row naming a column that does not exist, so this can only become
 * non-empty by a later migration dropping one and leaving its row — harmless except that it
 * makes the register's count disagree with the schema, and a count that cannot be reconciled is
 * how a completeness claim quietly stops being checked.
 */
CREATE OR REPLACE FUNCTION crm.erp_reference_orphans()
RETURNS TABLE (source_table text, source_column text)
LANGUAGE sql STABLE AS $$
  SELECT r.source_table, r.source_column
    FROM crm.erp_reference_register r
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('crm.' || quote_ident(r.source_table))
        AND a.attname = r.source_column
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.atttypid = 'crm.erp_record_id'::regtype)
   ORDER BY r.source_table, r.source_column;
$$;

/** The references no mirror can answer for, with the question each one is waiting on. */
CREATE OR REPLACE FUNCTION crm.unverifiable_erp_references()
RETURNS TABLE (source_table text, source_column text, erp_entity text, question text)
LANGUAGE sql STABLE AS $$
  SELECT r.source_table, r.source_column, r.erp_entity, r.question
    FROM crm.erp_reference_register r
   WHERE r.kind = 'reference' AND r.verifiable_against IS NULL
   ORDER BY r.source_table, r.source_column;
$$;

/** What a run has to walk: the checkable references, in a stable order. */
CREATE OR REPLACE FUNCTION crm.checkable_erp_references()
RETURNS TABLE (
  source_table       text,
  source_column      text,
  erp_entity         text,
  verifiable_against text,
  verify_column      text,
  -- Whether the source column may be NULL. The runner must not count a null as an orphan, and
  -- reading it from the catalog rather than from the register means the two cannot disagree.
  source_nullable    boolean
)
LANGUAGE sql STABLE AS $$
  SELECT r.source_table, r.source_column, r.erp_entity, r.verifiable_against, r.verify_column,
         NOT a.attnotnull
    FROM crm.erp_reference_register r
    JOIN pg_attribute a ON a.attrelid = to_regclass('crm.' || quote_ident(r.source_table))
                       AND a.attname = r.source_column
                       AND a.attnum > 0 AND NOT a.attisdropped
   WHERE r.kind = 'reference' AND r.verifiable_against IS NOT NULL
   ORDER BY r.source_table, r.source_column;
$$;

-- ---------------------------------------------------------------------------
-- 3. What a run records.
-- ---------------------------------------------------------------------------
-- `seq`, FIRST, because without it this table cannot be read in order. `ran_at` defaults to
-- `now()` — the TRANSACTION timestamp — and one pass writes a row per checkable reference in one
-- transaction, so every row of a sweep shares it to the microsecond and "the latest run" falls
-- through to whatever the plan returned. 0027, 0033, 0041 and 0046 each learned this on a
-- different table; it is cheaper to learn it from them.
ALTER TABLE crm.referential_check_run ADD COLUMN seq bigint GENERATED BY DEFAULT AS IDENTITY;

-- The verdict, which is the whole fail-closed rule made into a value.
--
--   clean        — the reference was checked and every row resolves.
--   orphans      — checked, and `orphan_count` rows do not. An ERP deletion nobody told us
--                  about, or an ACL bug. Both want a human (0005's header).
--   unverifiable — NOT CHECKED, because the mirror cannot be trusted: never synced, or stale
--                  past its own `block_after_seconds`. Every row would read as an orphan and the
--                  count would be a statement about the mirror rather than about the data.
--
-- There is deliberately no `error` verdict. A run that threw writes nothing and the job fails,
-- which is the scheduler's own reporting; a verdict is for an answer we actually have.
ALTER TABLE crm.referential_check_run
  ADD COLUMN verdict text NOT NULL DEFAULT 'clean'
    CHECK (verdict IN ('clean', 'orphans', 'unverifiable'));
ALTER TABLE crm.referential_check_run ALTER COLUMN verdict DROP DEFAULT;

-- Which mirror answered, and how old its answer was. Both recorded per run rather than looked up
-- afterwards, because the question an operator asks about an orphan is "did the ERP delete it, or
-- is our mirror behind" — and the mirror's age at the moment of the check is the only thing that
-- separates those two, and it moves.
ALTER TABLE crm.referential_check_run ADD COLUMN snapshot_table text;
ALTER TABLE crm.referential_check_run ADD COLUMN snapshot_last_success_at timestamptz;
-- Null when the mirror has never synced, which `unverifiable` also says. Carried as its own
-- column rather than inferred, because "never" and "a very long time" are different sentences.
ALTER TABLE crm.referential_check_run ADD COLUMN snapshot_age_seconds bigint
  CHECK (snapshot_age_seconds IS NULL OR snapshot_age_seconds >= 0);

-- A verdict that claims nothing was wrong must have actually looked.
ALTER TABLE crm.referential_check_run
  ADD CONSTRAINT referential_check_unverifiable_counts_nothing
    CHECK (verdict <> 'unverifiable' OR (checked_count = 0 AND orphan_count = 0)),
  ADD CONSTRAINT referential_check_orphans_found_some
    CHECK ((verdict = 'orphans') = (orphan_count > 0));

COMMENT ON COLUMN crm.referential_check_run.verdict IS
  'clean | orphans | unverifiable. `unverifiable` means the mirror could not be trusted and NOTHING was counted — a run that says "we could not look" must not read like one that says "there is nothing there".';
COMMENT ON COLUMN crm.referential_check_run.orphan_sample IS
  'Up to a handful of the offending ids, so an operator can go and look at one. A sample and not the set: an orphan count in the thousands is one fault, and storing thousands of ids per run would make this table the biggest thing in the database.';

-- `ran_at DESC` was 0005's ordering and `seq DESC` is the one that works; the old index stays
-- because a time range is still how an operator asks "what happened last week".
CREATE INDEX idx_referential_check_seq ON crm.referential_check_run (tenant_id, seq DESC);

-- ---------------------------------------------------------------------------
-- 4. Telling somebody.
-- ---------------------------------------------------------------------------
-- 0063's lesson applied without being asked: a finding nobody is told about is a finding that
-- waits for somebody to run a query. `referential_orphans_found` is `warning` rather than
-- `urgent` — an orphan is a data-integrity fault that wants a human this week, not a page at
-- 3am, and 0064's `urgent` is reserved for a deadline that has passed.
CREATE OR REPLACE FUNCTION crm.notification_kinds()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['disposal_obligation_raised',
               'disposal_obligation_overdue',
               'call_plan_submitted',
               'call_plan_approved',
               'call_plan_returned',
               'sample_transfer_awaiting_acceptance',
               'sample_transfer_recalled',
               'erp_write_failed',
               'expense_post_blocked',
               'config_change_awaiting_approval',
               'config_change_approval_overdue',
               -- 0066. ADR-0001 Q1's orphan check found a CRM row naming an ERP record its own
               -- mirror does not hold: an ERP deletion nobody told us about, or an ACL bug.
               'referential_orphans_found'];
$$;

-- The subject is the RUN, which is the row that holds the sample an operator goes and looks at.
--
-- OPEN means the run is the newest one for its (table, column) AND still found orphans. A run
-- superseded by a later clean one is closed — somebody fixed it, or the mirror caught up — and
-- that is exactly the shape every other arm here uses: the notice is about a state, and the
-- state is read from the live table rather than from the notification.
CREATE OR REPLACE FUNCTION crm.notification_subject_open(p_subject_table text, p_subject_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE p_subject_table
    -- A regulated disposal nobody has completed. The notification is how the rep knows.
    WHEN 'crm.disposal_obligation' THEN EXISTS (
      SELECT 1 FROM crm.disposal_obligation o
       WHERE o.id = p_subject_id AND o.status IN ('open', 'overdue'))
    -- A write the rep believes landed and never did. 0022 raises this; until the row is
    -- revived or abandoned, it is the only thing saying so.
    WHEN 'crm.outbox' THEN EXISTS (
      SELECT 1 FROM crm.outbox b
       WHERE b.id = p_subject_id AND b.state = 'dead')
    -- Material in transit: a transfer_out with no acceptance recorded against it. The
    -- same predicate `outstandingTransfers` uses, so the two cannot disagree.
    WHEN 'crm.sample_transaction' THEN EXISTS (
      SELECT 1 FROM crm.sample_transaction t
       WHERE t.id = p_subject_id AND t.kind = 'transfer_out'
         AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction a WHERE a.transfer_of = t.id))
    -- A plan still waiting on an approver. `draft` is not open in this sense: nobody is
    -- waiting on a draft, and its author can see it in their own list.
    WHEN 'crm.call_plan' THEN EXISTS (
      SELECT 1 FROM crm.call_plan p
       WHERE p.id = p_subject_id AND p.status = 'submitted')
    -- A claim the sweeper could not hand over (0031). `approved` is the one open state: a
    -- rep is owed money and the ERP has not been told. Every other state is settled —
    -- `posted` and `reimbursed` succeeded, `rejected` and `draft` are not owed.
    WHEN 'crm.expense_claim' THEN EXISTS (
      SELECT 1 FROM crm.expense_claim c
       WHERE c.id = p_subject_id AND c.state = 'approved')
    -- 0062. Undecided means somebody still has to look at it. A withdrawn or rejected
    -- proposal is finished, and an APPROVED one is finished too — the change it authorised
    -- either landed in the same transaction or was refused by the write.
    WHEN 'crm.config_proposal' THEN EXISTS (
      SELECT 1 FROM crm.config_proposal cp
       WHERE cp.id = p_subject_id AND cp.decision IS NULL)
    -- 0066. The newest run for its reference, and still finding orphans. A later run that came
    -- back clean closes it: the fault is the live state, not the history of having reported it.
    WHEN 'crm.referential_check_run' THEN EXISTS (
      SELECT 1 FROM crm.referential_check_run r
       WHERE r.id = p_subject_id
         AND r.verdict = 'orphans'
         AND NOT EXISTS (SELECT 1 FROM crm.referential_check_run later
                          WHERE later.tenant_id = r.tenant_id
                            AND later.source_table = r.source_table
                            AND later.source_column = r.source_column
                            AND later.seq > r.seq))
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION crm.notification_subject_unknown(p_subject_table text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject_table IS NOT NULL
     AND p_subject_table NOT IN ('crm.disposal_obligation', 'crm.outbox',
                                 'crm.sample_transaction', 'crm.call_plan',
                                 'crm.expense_claim', 'crm.config_proposal',
                                 'crm.referential_check_run');
$$;

-- ---------------------------------------------------------------------------
-- 5. The register, as the schema stands today.
-- ---------------------------------------------------------------------------
-- Seeded COMPLETE — every `crm.erp_record_id` column at 0066 gets a row, and
-- `crm.unregistered_erp_references()` is asserted empty by the contract suite — and seeded
-- HONEST: a reference gets a mirror only where one really exists, and a question everywhere it
-- does not. Of 23 columns, 10 are checkable references, 7 are references with no mirror and say
-- what they are waiting on, 4 are the mirrors' own keys and 2 are the CRM's own ids.
--
-- `declared_by` is `'crm:0066'` rather than a person's name, the admission 0051's seeding makes:
-- these are the readings an engineer can take from the schema, and the questions are for
-- whoever owns the subsystem.
INSERT INTO crm.erp_reference_register
  (source_table, source_column, kind, erp_entity, verifiable_against, verify_column, question, note, declared_by)
VALUES
  -- ---- the mirrors' own keys ------------------------------------------------
  ('account_snapshot', 'erp_account_id', 'mirror_key', 'Account', NULL, NULL, NULL,
   'The account mirror''s key. What other references are checked against; a full sweep plus deleteStale is what reconciles it, not an orphan report.', 'crm:0066'),
  ('product_snapshot', 'erp_item_id', 'mirror_key', 'Item', NULL, NULL, NULL,
   'The product mirror''s key. Reconciled by the sweep, for the reason this migration''s header gives: the ERP keeps no per-record tombstone, so drift here is expected and an orphan count would always be non-zero.', 'crm:0066'),
  ('rep_snapshot', 'erp_employee_id', 'mirror_key', 'Employee', NULL, NULL, NULL,
   'The employee mirror''s key, which crm.rep_profile.erp_employee_id is checked against.', 'crm:0066'),
  ('warehouse_snapshot', 'erp_warehouse_id', 'mirror_key', 'Warehouse', NULL, NULL, NULL,
   'The warehouse mirror''s key. Since 0058 a receipt naming a depot absent from it is refused at the point of entry.', 'crm:0066'),

  -- ---- the CRM's own ids for records it creates -----------------------------
  ('outbox', 'target_record_id', 'own_id', 'StockMovement/Expense/JournalEntry', NULL, NULL, NULL,
   'The CRM''s own deterministic id for a record it is about to create at the ERP. Absent there until the write lands, which is the queue''s whole purpose — an absence is not an orphan.', 'crm:0066'),
  ('outbox_dead_letter', 'target_record_id', 'own_id', 'StockMovement/Expense/JournalEntry', NULL, NULL, NULL,
   'The same id on a push that died. The record it names was never created, which is what the dead letter says.', 'crm:0066'),

  -- ---- checkable references -------------------------------------------------
  ('account_assignment', 'erp_account_id', 'reference', 'Account', 'account_snapshot', 'erp_account_id', NULL,
   'Which accounts a rep covers. An orphan here means a rep is assigned to an account the ERP no longer publishes, and their account list is silently short.', 'crm:0066'),
  ('call_plan_target', 'erp_account_id', 'reference', 'Account', 'account_snapshot', 'erp_account_id', NULL,
   'An account a plan commits to visiting. An orphan means a planned call cannot be recorded, because the ACL refuses a visit to an account absent from the mirror.', 'crm:0066'),
  ('visit', 'erp_account_id', 'reference', 'Account', 'account_snapshot', 'erp_account_id', NULL,
   'The account a visit happened at. NOT NULL and validated against the mirror when recorded, so an orphan is an ERP deletion nobody told us about or an ACL bug — 0005''s two cases exactly.', 'crm:0066'),
  ('sample_transaction', 'erp_account_id', 'reference', 'Account', 'account_snapshot', 'erp_account_id', NULL,
   'The account a sample was disbursed to. Nullable — a transfer between reps names no account — so a null is not an orphan.', 'crm:0066'),
  ('call_plan_product', 'erp_item_id', 'reference', 'Item', 'product_snapshot', 'erp_item_id', NULL,
   'A product a plan commits to detailing.', 'crm:0066'),
  ('visit_product', 'erp_item_id', 'reference', 'Item', 'product_snapshot', 'erp_item_id', NULL,
   'A product discussed at a visit.', 'crm:0066'),
  ('sample_lot', 'erp_item_id', 'reference', 'Item', 'product_snapshot', 'erp_item_id', NULL,
   'The product a sample lot is of. An orphan matters more here than anywhere: a regulated custody record naming a product the ERP cannot identify is a disposal somebody has to account for.', 'crm:0066'),
  ('sample_transaction', 'erp_warehouse_id', 'reference', 'Warehouse', 'warehouse_snapshot', 'erp_warehouse_id', NULL,
   'The depot a lot came from or went back to. Nullable: most movements name none.', 'crm:0066'),
  ('rep_profile', 'erp_employee_id', 'reference', 'Employee', 'rep_snapshot', 'erp_employee_id', NULL,
   'ADR-0001 Q3''s mapping, refreshed by the reconciler. Nullable, and a null with a non-null last_reconciled_at is already reported as an orphan by the reconciler itself — this catches the case where the mapping was never re-checked.', 'crm:0066'),
  ('rep_snapshot', 'manager_id', 'reference', 'Employee', 'rep_snapshot', 'erp_employee_id', NULL,
   'A mirrored employee''s manager, checked against the same mirror. The one self-reference here, and worth checking: a manager absent from the mirror means a supervision chain the CRM cannot walk.', 'crm:0066'),

  -- ---- references with no mirror, and the question each is waiting on --------
  ('call_plan_target', 'erp_contact_id', 'reference', 'Contact', NULL, NULL,
   'There is no contact snapshot. Should the CRM mirror ERP Contacts, or is a contact id carried through to the ERP without the CRM ever needing to resolve it? Until one of those is answered this reference cannot be checked.',
   'The individual at an account a plan names. Carried and never resolved by the CRM.', 'crm:0066'),
  ('visit', 'erp_contact_id', 'reference', 'Contact', NULL, NULL,
   'Same question as call_plan_target.erp_contact_id: no contact mirror exists, so nothing can answer whether this id is still a Contact at the ERP.',
   'Who the rep actually saw. Nullable, and the field a regulated visit record is weakest on.', 'crm:0066'),
  ('sample_transaction', 'erp_contact_id', 'reference', 'Contact', NULL, NULL,
   'Same question again, and it matters most here: a sample disbursed to a contact the ERP cannot identify is a custody record with a gap in it.',
   'The HCP a sample was handed to.', 'crm:0066'),
  ('expense_claim', 'erp_expense_id', 'reference', 'Expense', NULL, NULL,
   'This is the id the ERP ASSIGNED to a record the CRM created, so it is neither the CRM''s own id nor a reference to master data. Checking it needs a read of ERP Expense by id — an HTTP call per claim — which is a different mechanism from this one. Should the orphan check grow an ERP-reading mode, or should the relay re-verify on settle?',
   'The ERP Expense a posted claim became.', 'crm:0066'),
  ('expense_claim', 'erp_journal_entry_id', 'reference', 'JournalEntry', NULL, NULL,
   'Same shape as erp_expense_id, and blocked behind the same question — and additionally behind Q2: the JournalEntry cannot be posted at all yet, so this column is null in every deployment.',
   'The ERP JournalEntry a posted claim produced.', 'crm:0066'),
  ('rep_snapshot', 'position_id', 'reference', 'Position', NULL, NULL,
   'There is no position mirror and nothing in the CRM reads this column. Should it be mirrored, or dropped from the rep projection?',
   'A mirrored employee''s ERP Position. Projected because the ERP publishes it; unread by any CRM code.', 'crm:0066'),
  ('rep_snapshot', 'department_id', 'reference', 'Department', NULL, NULL,
   'Same question as position_id: no mirror, no reader. Mirror it or stop projecting it.',
   'A mirrored employee''s ERP Department. Projected and unread.', 'crm:0066');

-- ---------------------------------------------------------------------------
-- 6. The job, which is the half of Q1's answer that was missing.
-- ---------------------------------------------------------------------------
-- 24 HOURS, and the interval is an argument rather than a default. An orphan appears when the
-- ERP deletes a record the CRM still points at, and the only thing that OBSERVES such a deletion
-- is `snapshot_full` — which runs daily, because the ERP keeps no tombstones and incremental
-- polling can never see a record's absence. So a tighter cadence here could not find anything
-- sooner: this check reads the mirror, and the mirror only learns about a deletion once a day.
-- Running it more often would re-report the same finding against the same mirror.
--
-- It is also deliberately NOT the same tick as `snapshot_full`. A check that ran inside the
-- refresh would be measuring a mirror mid-update, and the jitter in `nextRunAt` means the two
-- land apart in practice anyway — but what matters is the reporting: a failed refresh must not
-- also lose the orphan report for a mirror that was fine yesterday.
CREATE OR REPLACE FUNCTION crm.scheduled_jobs()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['relay_drain',
               'snapshot_incremental',
               'snapshot_full',
               'expiry_sweep',
               'notify_dispatch',
               'notify_prune',
               'expense_post',
               'tenant_deletion_watch',
               'notify_approvals',
               -- 0066. ADR-0001 Q1's "nightly orphan check", built at last.
               'referential_check'];
$$;
