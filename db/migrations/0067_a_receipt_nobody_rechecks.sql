-- A receipt nobody re-checks, and the work that belongs to the deployment rather than to a tenant.
--
-- WHAT IS BROKEN. 0052 writes a cryptographic receipt when a tenant is erased — a content
-- manifest hash over the per-table attestations, and a proof hash that commits to that manifest
-- AND to who did it, for whom, under what authority. 0054 versioned the manifest format so a
-- receipt stays checkable for as long as it is kept, and 0052 made both tables append-only so
-- neither can be rewritten through the application role. `verifyTombstone` recomputes both hashes
-- and is pure.
--
-- Nothing ever calls it except an operator typing `crm-erasure receipts <tenant>`. The ERP solved
-- the same shape with a scheduled integrity proof (its ADR-0287/0288: row-against-anchor and
-- chain verification per tenant, on a timer, recording the verdict and declaring an incident on a
-- compromised finding), and this CRM has every piece of the cheap version. What it did not have
-- is the thing the open row named as the blocker:
--
--     What it does not have is a decision about what a failed verification MEANS here: a receipt
--     that no longer recomputes is either a bug in our own canonicalisation or evidence that
--     somebody with database access rewrote a deletion record, and those want very different
--     responses. Recorded rather than guessed at, because a job that cried wolf about its own
--     hashing bug would be worse than no job.
--
-- THE DECISION, and it is answerable rather than a judgement call. The two causes can be told
-- apart, decisively, by a KNOWN-ANSWER SELF-TEST. Before any stored receipt is looked at, the
-- verifier hashes a FIXED vector — a committed set of attestations with a hard-coded expected
-- digest, one vector per entry in `MANIFEST_VERSIONS` — and compares. A hashing bug cannot hide
-- from a known-answer test, and no amount of tampering with stored rows can make one fail. So:
--
--   * the self-test FAILS → this build cannot hash correctly. Nothing is called tampered, and
--     the sweep refuses to report on receipts at all. `self_test_failed`.
--   * the self-test passes and EVERY receipt of a version fails → the stored receipts were
--     produced by a build whose canonicalisation differed from this one, i.e. a format change
--     shipped without a new version number. A version-discipline bug, not a crime.
--     `unreproducible`.
--   * the self-test passes and SOME receipts of a version fail while their siblings pass → a
--     receipt was rewritten after it was written, under a format this build reproduces
--     perfectly for every other row. `tampered`.
--   * everything recomputes → `verified`.
--
-- That is the whole answer, and the cohort is what makes the third arm sound: "one of forty
-- failed" is not something a canonicalisation bug can produce.
--
-- AND THE STRUCTURAL PROBLEM THE JOB RAN INTO, which is why this migration contains a second
-- thing. A receipt belongs to a tenant that has been ERASED. `activeTenants` is
-- `status = 'active'`, so a stopped tenant never gets a job tick — deliberately, since 0050's
-- whole point is that a deleted tenant's background work stops. There is therefore NO per-tenant
-- job that can ever verify a receipt, and inventing one would mean putting a deleted tenant back
-- into the loop 0050 took it out of.
--
-- So this adds the concept that was missing: PLATFORM WORK. `crm.platform_job` is
-- `crm.scheduled_job` with the tenant taken out — work that is about the deployment rather than
-- about anybody's data. Receipt verification is its first instance and will not be its last; the
-- register-completeness checks 0066 added are the obvious second.
--
-- WHO IS TOLD, and the answer is nobody, which is not an oversight. `crm.notification` is
-- addressed to a rep (`recipient_rep_profile_id`, NOT NULL) and endpoints are per tenant. A
-- deleted tenant has no reps, and telling every live tenant's administrators about another
-- tenant's erasure receipt would be a cross-tenant disclosure — precisely what the erasure
-- exists to prevent. So the channel for a platform finding is the process's own log line, which
-- carries `TAMPERED=` in capitals for a log shipper to alert on, plus the row and the route. The
-- CRM has no platform notification channel at all, and that is named as open rather than faked.

-- ---------------------------------------------------------------------------
-- 1. Work that belongs to the deployment.
-- ---------------------------------------------------------------------------
-- Declared in SQL as well as in TypeScript, like `crm.scheduled_jobs()` since 0050 and for the
-- same reason: a `switch` needs the names at compile time, so the two copies stay and a test
-- asserts they agree.
CREATE OR REPLACE FUNCTION crm.platform_jobs()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['receipt_verify'];
$$;

-- PLATFORM-WIDE, no `tenant_id` and no RLS, which is the whole point of the table: it schedules
-- work that is about the deployment. Shaped after `crm.scheduled_job` deliberately — same
-- columns, same meanings, same `enabled` switch — so an operator who knows one knows the other,
-- and the tenant column's absence is the only difference to read.
CREATE TABLE crm.platform_job (
  job                  text PRIMARY KEY CHECK (job = ANY (crm.platform_jobs())),
  -- A day's floor rather than `scheduled_job`'s one second. Nothing platform-level is a rep
  -- waiting on a write, and a tighter interval on a sweep that reads every receipt in the
  -- deployment would be a cost with no reader.
  interval_ms          integer NOT NULL CHECK (interval_ms >= 60000),
  enabled              boolean NOT NULL DEFAULT true,
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_status          text CHECK (last_status IS NULL OR last_status IN ('ok', 'error')),
  last_error           text,
  last_detail          text,
  last_duration_ms     integer,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
);

CREATE INDEX idx_platform_job_due ON crm.platform_job (next_run_at) WHERE enabled;

COMMENT ON TABLE crm.platform_job IS
  'crm.scheduled_job with the tenant taken out: work about the deployment rather than about anybody''s data. Receipt verification is the first, and it HAS to be here — a receipt belongs to an erased tenant, and crm.scheduled_job is only ever claimed for a tenant whose status is active.';

-- ---------------------------------------------------------------------------
-- 2. What a verification sweep records.
-- ---------------------------------------------------------------------------
-- PLATFORM-WIDE TOO, and that is the interesting half. The receipts it reads are tenant-scoped
-- under FORCE row security and are read inside each tenant's own context — but the VERDICT is
-- about the deployment's evidence as a whole, and a `tampered` finding that could only be seen
-- from inside the tenant it concerns would be a finding nobody can see, since that tenant is
-- gone. It deliberately stores no attestation content and no tenant display name: a receipt id
-- and a tenant id are what an operator needs to go and look, and the sweep must not become a
-- second copy of the data the erasure destroyed.
CREATE TABLE crm.receipt_verification_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `seq`, for 0066's reason and 0041's before it: `ran_at` is the transaction clock, and two
  -- sweeps in one transaction — which a test does — would tie.
  seq         bigint GENERATED BY DEFAULT AS IDENTITY,
  ran_at      timestamptz NOT NULL DEFAULT now(),

  -- verified         — every receipt recomputed.
  -- self_test_failed — this build cannot hash correctly, so NOTHING was read and nothing is
  --                    called tampered. The one verdict that says "we lost the ability to check".
  -- unreproducible   — the self-test passed and every receipt of a version failed: a format
  --                    change shipped under an existing version number. Our bug.
  -- tampered         — the self-test passed and SOME receipts failed while their siblings
  --                    passed. A receipt was rewritten after it was written.
  verdict     text NOT NULL CHECK (verdict IN ('verified', 'self_test_failed', 'unreproducible', 'tampered')),

  receipts_checked integer NOT NULL CHECK (receipts_checked >= 0),
  receipts_failed  integer NOT NULL CHECK (receipts_failed  >= 0),
  tenants_checked  integer NOT NULL CHECK (tenants_checked  >= 0),

  -- Per manifest version: how many were read and how many failed. This is the cohort the
  -- `tampered`/`unreproducible` distinction is drawn from, so it is stored rather than derived —
  -- a later reader must be able to see the evidence the verdict rests on, not just the verdict.
  by_version  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Which vectors this build reproduced, by version. Empty only when the self-test itself threw.
  self_test   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Up to a handful of (tenant, receipt, problem) triples. A sample, for 0066's reason: an
  -- operator needs one to go and look at, and a sweep that stored every problem would become the
  -- biggest thing in the database on the day the canonicalisation broke.
  failures    jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- A sweep that could not even look must not say it found nothing.
  CONSTRAINT receipt_verification_self_test_reads_nothing
    CHECK (verdict <> 'self_test_failed' OR (receipts_checked = 0 AND receipts_failed = 0)),
  CONSTRAINT receipt_verification_failures_pair_with_verdict
    CHECK ((verdict IN ('tampered', 'unreproducible')) = (receipts_failed > 0)),
  CONSTRAINT receipt_verification_failed_is_a_subset
    CHECK (receipts_failed <= receipts_checked)
);

CREATE INDEX idx_receipt_verification_seq ON crm.receipt_verification_run (seq DESC);
-- The interesting rows, like 0005's partial index on `orphan_count > 0`.
CREATE INDEX idx_receipt_verification_bad ON crm.receipt_verification_run (seq DESC)
  WHERE verdict <> 'verified';

COMMENT ON COLUMN crm.receipt_verification_run.verdict IS
  'verified | self_test_failed | unreproducible | tampered. The three bad ones are deliberately not one value: a known-answer self-test tells a bug in our own hashing from a rewritten row, and those want very different responses — which is the decision ADR-0001 recorded as missing.';

-- ---------------------------------------------------------------------------
-- 3. Reading it.
-- ---------------------------------------------------------------------------
/** The newest sweep, which is the only one that is still a claim. */
CREATE OR REPLACE FUNCTION crm.latest_receipt_verification()
RETURNS SETOF crm.receipt_verification_run
LANGUAGE sql STABLE AS $$
  SELECT * FROM crm.receipt_verification_run ORDER BY seq DESC LIMIT 1;
$$;

/**
 * Every tenant that holds a receipt, whatever its status.
 *
 * THE RLS DANCE THIS EXISTS TO AVOID. `crm.tenant_tombstone` is tenant-scoped under FORCE row
 * security, so a cross-tenant count of receipts returns zero — correctly, and silently, which
 * would report every deployment clean. `crm.tenant` is the one RLS-exempt registry (its own
 * exemption is argued in `schema.contract.test.ts`), so the enumeration comes from there and the
 * caller enters each tenant's context to read its receipts, exactly as `checkChannelCoverage`
 * does for endpoints.
 *
 * EVERY STATUS, and that is the point: a receipt belongs to a tenant that has been erased, so a
 * list filtered to `active` would be a list of tenants with no receipts.
 */
CREATE OR REPLACE FUNCTION crm.tenants_with_receipts()
RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id, t.status FROM crm.tenant t ORDER BY t.created_at, t.tenant_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. The job, enabled by default.
-- ---------------------------------------------------------------------------
-- 24 HOURS. The receipts are append-only and a rewrite is a deliberate act by somebody with
-- database access, not an event that arrives in bursts — so there is nothing a tighter cadence
-- would catch sooner than the next working day, and a sweep reads every receipt in the
-- deployment. Against that, a day is a day in which evidence of a rewritten deletion record sits
-- unreported, which is worth stating rather than hiding: if that window ever needs to be
-- minutes, the answer is not a tighter poll but an append-only guarantee the application role
-- cannot defeat, which is what 0052's triggers already attempt and what the open row on the
-- registry's authority is about.
--
-- Seeded here rather than created on first tick, unlike `crm.scheduled_job`: there is exactly
-- one row per job for the whole deployment, so there is no tenant to discover it for.
INSERT INTO crm.platform_job (job, interval_ms)
VALUES ('receipt_verify', 24 * 60 * 60 * 1000)
ON CONFLICT (job) DO NOTHING;
