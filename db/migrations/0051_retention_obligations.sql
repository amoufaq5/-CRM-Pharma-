-- What happens to each of this CRM's tables when its tenant is deleted, and who decided.
--
-- 0050 made the CRM stop when the ERP deletes a tenant, and said plainly what it was not
-- doing: "It is NOT the erasure. Erasing the CRM's copies needs a decision this schema cannot
-- make for itself — `crm.expense_claim` may be a statutory accounting record in some
-- jurisdictions, and a deletion that destroys it is as wrong as one that keeps everything."
-- This is that vocabulary.
--
-- MIRRORED, NOT INVENTED. CrossEngin's ADR-0317 solved the same problem one layer in, and its
-- rule is the one worth copying verbatim:
--
--     Silence is not "none". A subsystem in scope must say what it destroyed, say it found
--     nothing, or say it is lawfully keeping it. An absent attestation refuses the tombstone.
--
-- ADR-0317 is also exact about why that rule exists, and it is not what anybody would guess:
-- "The thing that made the first tombstone false was not a wrong number — every number in it
-- was whatever the author typed. It was a subsystem NOBODY ASKED, whose silence read as
-- nothing to delete." And on the cryptography: "A proof over a scope assembled from nothing
-- is a correct proof of a false claim."
--
-- So the unit here is not a deletion routine. It is a REGISTER with one row per tenant-scoped
-- table, complete by construction, where a table nobody has thought about is a refusal rather
-- than an omission.
--
-- THE OBLIGATION CODES ARE THE ERP'S OWN SPELLINGS, for the five that overlap. A CRM
-- obligation the ERP's enum can express uses the ERP's word for it, so a deletion recorded on
-- both sides of the boundary reads as one record rather than two dialects. A test in
-- `scripts/verify-live-erp.sh` compares the shared codes against the ERP's source, because a
-- vocabulary copied by hand is a vocabulary that drifts.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD: an `anonymise` disposition. The follow-up this closes
-- named three options — erase, retain-with-obligation, anonymise — and writing it turned up
-- that no table in this schema wants the third. A visit naming a doctor is the plausible
-- candidate and it is `undecided` below, so choosing anonymisation for it now would be
-- pre-empting the decision this register exists to collect. A disposition with no row using it
-- and no code implementing it is the "built and unreachable" this repository keeps finding; it
-- goes in when something needs it, with the columns that make it real.

-- ---------------------------------------------------------------------------
-- 1. The obligations, declared once.
-- ---------------------------------------------------------------------------
-- Five taken verbatim from the ERP's `RETENTION_OBLIGATIONS` (`tenant-lifecycle/src/
-- gdpr-deletion.ts`, read at `origin/main` 2026-10-06) and two this CRM needs that it has no
-- word for.
--
-- `none` is kept even though `erase` already means "no obligation", and the reason is fidelity:
-- the vocabularies match code for code, so neither side has to translate. A CHECK below stops
-- it ever being used as a basis for keeping something, which is the one way it could lie.
--
-- `drug_sample_custody` carries NO period, unlike every ERP code. That is deliberate and it is
-- the honest shape: how long a pharma company must keep custody records for drug samples
-- differs by jurisdiction, and baking one number into the code name would make every
-- deployment outside that jurisdiction either wrong or forced to misuse the code. The period
-- lives in `obligation_note`, per row, where the deployment's actual rule can be named.
--
-- `deletion_evidence` is not a statutory retention at all. It is the receipt: destroying the
-- proof that a deletion happened defeats the deletion, which is ADR-0318's argument ("a
-- tombstone outlives what it describes") applied to our own copy of it.
CREATE OR REPLACE FUNCTION crm.retention_obligations()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    -- The ERP's, spelled as the ERP spells them.
    'tax_records_7y',
    'medical_records_10y',
    'audit_logs_3y',
    'financial_transactions_7y',
    'anti_money_laundering_5y',
    'none',
    -- This CRM's.
    'drug_sample_custody',
    'deletion_evidence'
  ];
$$;

-- ---------------------------------------------------------------------------
-- 2. The register.
-- ---------------------------------------------------------------------------
-- PLATFORM-WIDE, with no `tenant_id` and no RLS, because it describes the SCHEMA and not a
-- tenant: every tenant's data in `crm.visit` is governed by the same decision about what
-- `crm.visit` is. That makes it the third table in `crm` without a tenant column, which the
-- schema invariant test enumerates rather than infers, so adding it is a deliberate act that
-- fails a test until someone writes down why.
--
-- A DEPLOYMENT MAY AMEND IT, which is the other reason it is a table and not a constant in
-- TypeScript. Retention law is jurisdictional: the same table is lawfully erasable in one
-- country and must be kept for seven years in another, and a deployment cannot be asked to
-- fork the code to say so.
CREATE TABLE crm.data_disposition (
  -- Bare table name within `crm`, which is the only schema this register governs. A trigger
  -- below refuses a name that is not a real tenant-scoped table there, because a row naming
  -- `crm.vist` would describe nothing while making the register look complete.
  table_name         text PRIMARY KEY CHECK (table_name ~ '^[a-z][a-z0-9_]{2,62}$'),

  -- `undecided` is a FIRST-CLASS value and the point of the whole design. A table with no row
  -- is silence, and silence refuses the plan with "nobody has looked at this". A table marked
  -- `undecided` also refuses the plan — but it refuses with the QUESTION, which is the
  -- difference between a bug and an agenda item. ADR-0317's rule applied one level up: a
  -- declared "we have not decided" is not the same as nothing, and neither is a yes.
  disposition        text NOT NULL
                       CHECK (disposition IN ('erase', 'retain', 'undecided')),

  -- The lawful basis for keeping it. Required for `retain` and forbidden otherwise, so a row
  -- cannot carry a legal justification for something it is about to destroy.
  obligation         text CHECK (obligation IS NULL OR obligation = ANY (crm.retention_obligations())),

  -- The deployment's actual rule, in words: which law, which jurisdiction, how long. Required
  -- with an obligation, because a code alone is not a basis anybody can check — and it is
  -- where the period lives for the one obligation that deliberately has no period in its name.
  obligation_note    text CHECK (obligation_note IS NULL OR length(obligation_note) BETWEEN 10 AND 1000),

  -- What a future attestation will cite as the place the retained data still is. The ERP's
  -- `retainedDataReference` by another name, and required for the same reason: "we kept it" is
  -- not an answer to a data subject without "and it is here".
  retained_reference text CHECK (retained_reference IS NULL OR length(retained_reference) BETWEEN 3 AND 200),

  -- Required for `undecided`: what somebody has to answer. A register whose undecided rows do
  -- not say what the question is just moves the silence somewhere harder to find.
  question           text CHECK (question IS NULL OR length(question) BETWEEN 10 AND 1000),

  -- Who decided, and when. NULL for `undecided`, which is the whole of its meaning.
  decided_by         text CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 200),
  decided_at         timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Each disposition paired with exactly the fields that make it mean something. Written as
  -- one constraint per disposition rather than one big expression, so a refusal names which
  -- rule was broken.
  CONSTRAINT data_disposition_retain_has_basis
    CHECK (disposition <> 'retain' OR (obligation IS NOT NULL
                                       AND obligation <> 'none'
                                       AND obligation_note IS NOT NULL
                                       AND retained_reference IS NOT NULL
                                       AND decided_by IS NOT NULL
                                       AND decided_at IS NOT NULL)),
  CONSTRAINT data_disposition_erase_has_no_basis
    CHECK (disposition <> 'erase' OR (obligation IS NULL
                                      AND retained_reference IS NULL
                                      AND question IS NULL
                                      AND decided_by IS NOT NULL
                                      AND decided_at IS NOT NULL)),
  CONSTRAINT data_disposition_undecided_has_a_question
    CHECK (disposition <> 'undecided' OR (question IS NOT NULL
                                          AND obligation IS NULL
                                          AND obligation_note IS NULL
                                          AND retained_reference IS NULL
                                          AND decided_by IS NULL
                                          AND decided_at IS NULL))
);

-- `none` is in the vocabulary for fidelity with the ERP and is not a basis for keeping
-- anything. The retain constraint above already refuses it; this says so where a reader of the
-- column will look.
COMMENT ON COLUMN crm.data_disposition.obligation IS
  'A code from crm.retention_obligations(). Never ''none'' on a retain row: ''none'' exists only so this vocabulary matches the ERP''s code for code.';

/**
 * A register row must name a real tenant-scoped table in `crm`.
 *
 * 0047's lesson, in a new place: a misspelled name describes nothing and fails nothing, and
 * here it is worse than usual because the register's whole claim is completeness — a row for
 * `crm.vist` would make `crm.visit` look covered while governing no rows at all.
 *
 * Checked by a trigger and not a foreign key because the thing being referenced is
 * `pg_catalog`, which cannot be referenced. The same reason the completeness functions below
 * are functions.
 */
CREATE OR REPLACE FUNCTION crm.data_disposition_names_a_real_table()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('crm.' || quote_ident(NEW.table_name)) IS NULL THEN
    RAISE EXCEPTION
      'data-disposition-unknown-table: there is no table crm.% — a register row naming a table that does not exist would make the register look complete while governing nothing',
      NEW.table_name
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = to_regclass('crm.' || quote_ident(NEW.table_name))
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION
      'data-disposition-not-tenant-scoped: crm.% has no tenant_id, so no tenant owns any of its rows and a disposition for it would be meaningless',
      NEW.table_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER data_disposition_names_a_real_table
  BEFORE INSERT OR UPDATE ON crm.data_disposition
  FOR EACH ROW EXECUTE FUNCTION crm.data_disposition_names_a_real_table();

-- ---------------------------------------------------------------------------
-- 3. Completeness, which is the only property that matters.
-- ---------------------------------------------------------------------------
/**
 * Tables that hold a tenant's rows and that nobody has decided about.
 *
 * THIS IS THE "SILENCE IS NOT NONE" GUARD, and it is a function rather than a test so the
 * running system can refuse rather than only the suite. Empty is the only acceptable answer: a
 * tenant-scoped table absent from the register is a table whose rows would survive an erasure
 * nobody noticed, which is precisely the false tombstone ADR-0317 was written about.
 *
 * Derived from `pg_catalog` and never from a list, because a list is the thing that goes stale.
 * A migration that adds a tenant-scoped table and forgets its disposition fails a test the same
 * day instead of being discovered by a data subject.
 */
CREATE OR REPLACE FUNCTION crm.undeclared_tenant_tables()
RETURNS SETOF text
LANGUAGE sql STABLE AS $$
  SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'crm'
     AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT EXISTS (SELECT 1 FROM crm.data_disposition d WHERE d.table_name = c.relname)
   ORDER BY c.relname;
$$;

/**
 * And the other direction: a register row whose table has been dropped.
 *
 * The trigger above refuses one at write time, so this can only become non-empty by a later
 * migration dropping a table and leaving its row — which would be harmless except that it makes
 * the register's row count disagree with the schema, and a count that cannot be reconciled is
 * how a completeness claim quietly stops being checked.
 */
CREATE OR REPLACE FUNCTION crm.disposition_orphans()
RETURNS SETOF text
LANGUAGE sql STABLE AS $$
  SELECT d.table_name
    FROM crm.data_disposition d
   WHERE to_regclass('crm.' || quote_ident(d.table_name)) IS NULL
   ORDER BY d.table_name;
$$;

/** The tables somebody still has to decide about, with the question. */
CREATE OR REPLACE FUNCTION crm.undecided_dispositions()
RETURNS TABLE (table_name text, question text)
LANGUAGE sql STABLE AS $$
  SELECT d.table_name, d.question
    FROM crm.data_disposition d
   WHERE d.disposition = 'undecided'
   ORDER BY d.table_name;
$$;

-- ---------------------------------------------------------------------------
-- 4. The decisions, as they stand today.
-- ---------------------------------------------------------------------------
-- Seeded complete — every tenant-scoped table in the schema at 0051 gets a row — and seeded
-- HONEST: a table is `erase` or `retain` only where the answer does not depend on a lawyer, and
-- `undecided` everywhere it does, with the question written out. 19 of the 39 are undecided,
-- which is not a gap in this migration; it is the gap this migration exists to make visible.
--
-- `decided_by` is `'crm:0051'` on the decided rows rather than a person's name, and that is a
-- deliberate admission: these are the engineering-obvious ones, decided by the migration that
-- wrote them, and any of them can be overridden by a deployment whose counsel disagrees.
-- Nothing here is a legal opinion.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES
  -- ERASE: copies whose source of truth has itself been destroyed. Keeping a deleted tenant's
  -- product catalog or employee roster serves nobody and is a copy of ERP master data we were
  -- only ever a cache for.
  ('product_snapshot', 'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('account_snapshot', 'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('rep_snapshot',     'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('snapshot_freshness', 'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),

  -- ERASE: this CRM's own operational state. None of it is a record of anything that happened
  -- in the world — it is how this deployment scheduled and configured itself.
  ('scheduled_job',          'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('referential_check_run',  'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('territory',              'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('territory_assignment',   'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('account_assignment',     'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('cycle',                  'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('disposal_policy',        'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('expense_account_map',    'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('notification_policy',    'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('notification',           'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),

  -- ERASE, and this one is not merely allowed but required: an endpoint row names where a
  -- tenant's signals were pushed and the environment variable holding the secret that signed
  -- them. There is nothing to weigh.
  ('notification_endpoint',       'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('notification_endpoint_probe', 'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),
  ('erp_service_principal',       'erase', NULL, NULL, NULL, NULL, 'crm:0051', now()),

  -- RETAIN: money. The case 0050's header named, and the ERP has a code for it.
  ('expense_claim', 'retain', 'financial_transactions_7y',
   'An expense claim is an accounting record of a payment to an employee. Most jurisdictions require books and supporting vouchers to be kept for 6-7 years; this deployment must confirm its own period and amend this note.',
   'crm.expense_claim, retained with its tenant_id and no further processing',
   NULL, 'crm:0051', now()),

  -- RETAIN: the proof. 0050's receipt on the registry row, and the log of how we came to
  -- believe it. Destroying the evidence that a deletion happened defeats the deletion — the
  -- ERP's ADR-0318 argument about its own tombstone, applied to our copy.
  ('tenant', 'retain', 'deletion_evidence',
   'This row IS the record that the tenant was deleted and when, carrying the ERP tombstone id, its proof hash and its chain coordinate. Erasing it would destroy the only CRM-side evidence that the deletion was observed and acted on.',
   'crm.tenant, status erp_deleted with the ERP tombstone receipt',
   NULL, 'crm:0051', now()),
  ('tenant_deletion_check', 'retain', 'deletion_evidence',
   'The observation log behind the receipt: which answers the ERP gave, when, and with what reason. It is how a reader establishes that the stop was based on a tombstone rather than on an inference.',
   'crm.tenant_deletion_check, the newest 20 observations per tenant',
   NULL, 'crm:0051', now()),

  -- UNDECIDED: controlled material and its custody chain. Pharma sample custody is regulated
  -- and the period is jurisdictional, which is exactly why `drug_sample_custody` carries no
  -- number in its name.
  ('sample_lot', 'undecided', NULL, NULL, NULL,
   'Sample lot records identify controlled and promotional material by lot and expiry. Which regulation governs retention of lot-level custody records in this deployment''s jurisdiction, and for how long after the relationship ends?',
   NULL, NULL),
  ('sample_holding', 'undecided', NULL, NULL, NULL,
   'The derived balance of controlled material in a named employee''s possession. Retain as part of the custody chain, or erase as a derived figure recomputable from the ledger that may itself be retained?',
   NULL, NULL),
  ('sample_transaction', 'undecided', NULL, NULL, NULL,
   'The append-only custody ledger for drug samples: who received what, when, and who signed. The most likely retention obligation in this schema and the one most likely to be mandatory. Which rule, and how long?',
   NULL, NULL),
  ('sample_count', 'undecided', NULL, NULL, NULL,
   'A physical count document reconciling a rep''s bag against the ledger. Part of the custody evidence, or an internal control record that may be erased?',
   NULL, NULL),
  ('sample_count_line', 'undecided', NULL, NULL, NULL,
   'The per-lot lines of a count document. Follows whatever is decided for sample_count, and is listed separately so the pair cannot be decided by halves.',
   NULL, NULL),
  ('disposal_obligation', 'undecided', NULL, NULL, NULL,
   'The record that expired controlled material was found in a rep''s possession and had to be destroyed by a deadline. Likely a mandatory retention; which regulation, and does it survive the end of the commercial relationship?',
   NULL, NULL),

  -- UNDECIDED: third parties. A visit names a healthcare professional who is not this tenant's
  -- employee and never agreed to anything with us.
  ('visit', 'undecided', NULL, NULL, NULL,
   'A visit names a healthcare professional, a date, a location and what was discussed. Anti-bribery and pharmacovigilance rules may require retention; data-protection rules may require erasure, and the HCP is a third party who contracted with nobody here. Which obligation wins, and is partial anonymisation (dropping the HCP identity, keeping the aggregate) acceptable instead?',
   NULL, NULL),
  ('visit_product', 'undecided', NULL, NULL, NULL,
   'Which products were detailed or sampled at a visit. Follows the visit decision, including whether anonymisation is an option.',
   NULL, NULL),

  -- UNDECIDED: employment records.
  ('rep_profile', 'undecided', NULL, NULL, NULL,
   'The employee identity this CRM holds: name, employee number, IdP subject and ERP employee id. Employment-record retention is jurisdictional and may outlast the commercial relationship. Which rule applies, and does it reach a CRM copy of data whose source is the ERP?',
   NULL, NULL),
  ('rep_role', 'undecided', NULL, NULL, NULL,
   'The append-only grant history: who was an administrator or approver, when, and who granted it. This is the access-control audit trail that makes every approval in this schema attributable. Erasing it would leave the retained expense approvals unattributable, so it is bound up with whatever is decided for expense_claim.',
   NULL, NULL),

  -- UNDECIDED: signatures and the log of who read them.
  ('attachment', 'undecided', NULL, NULL, NULL,
   'Attachment metadata, including the signature captures a sample receipt is evidenced by. Part of the custody evidence for samples and of the voucher trail for expenses, so it cannot be decided before those are.',
   NULL, NULL),
  ('attachment_blob', 'undecided', NULL, NULL, NULL,
   'The bytes: an HCP''s handwritten signature and photographed receipts. The most sensitive content in this schema. Follows attachment, and is listed separately because keeping metadata while destroying bytes is a real and possibly correct third answer.',
   NULL, NULL),
  ('attachment_access', 'undecided', NULL, NULL, NULL,
   'Every read of an attachment''s bytes, by whom and when. The disclosure log for the most sensitive content here. Retain as an audit trail, or erase with what it describes?',
   NULL, NULL),

  -- UNDECIDED: approvals and the queue.
  ('call_plan', 'undecided', NULL, NULL, NULL,
   'A rep''s planned coverage and its approval. Likely erasable as internal planning, but it carries an approver and a decision timestamp, which is the shape of a record somebody wants to keep.',
   NULL, NULL),
  ('call_plan_target', 'undecided', NULL, NULL, NULL,
   'Which accounts a plan targeted. Names third-party HCPs, so it follows the visit decision rather than the call_plan one.',
   NULL, NULL),
  ('call_plan_product', 'undecided', NULL, NULL, NULL,
   'Which products a plan intended to detail. Follows call_plan.',
   NULL, NULL),
  ('outbox', 'undecided', NULL, NULL, NULL,
   'Queued writes to the ERP, including expense postings. A pending row for a stopped tenant is a write that was intended and never made, which is either evidence worth keeping or noise worth destroying — and the rows naming money may follow expense_claim.',
   NULL, NULL),
  ('outbox_dead_letter', 'undecided', NULL, NULL, NULL,
   'The history of writes that failed permanently, with their reasons. Operational by nature, but it is the only record that something a rep believes happened never reached the ERP.',
   NULL, NULL),

  -- UNDECIDED: and the one 0046 already argued about.
  ('notification_delivery', 'undecided', NULL, NULL, NULL,
   'Evidence that a named employee''s data was pushed to a specific third-party endpoint, which 0046 gave a two-year horizon of its own precisely because it is "evidence about a disclosure". That argument says retain; the deletion says erase. Which survives?',
   NULL, NULL);

-- The seed must have covered everything. Asserted HERE, in the migration, and not only in the
-- test suite: a deployment applying this file gets the guarantee rather than inheriting a
-- promise made in CI. If a later migration adds a tenant-scoped table without a disposition,
-- it is `scripts/typecheck-tests.sh`'s sibling test that catches it — but a hole present at
-- 0051 would be a hole shipped, so this refuses to apply.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(t) INTO missing FROM crm.undeclared_tenant_tables() AS t;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'data-disposition-incomplete: these tenant-scoped tables have no disposition: %. Silence is not "none" — every table a tenant owns rows in must say erase, retain with an obligation, or undecided with the question.',
      array_to_string(missing, ', ');
  END IF;
END
$$;
