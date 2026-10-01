-- 0015_call_plans.sql
--
-- The cycle plan: what a rep INTENDS to do, against which the visits in 0012 are
-- measured.
--
-- Nothing in the ERP corresponds to this. It has no planning period, no target,
-- no coverage or frequency concept, and no way to say "this account should be
-- seen twice this month" — which is the central object of a pharma field force
-- and the number every territory review and incentive scheme is built on.
--
-- THREE DECISIONS SHAPE THESE TABLES.
--
-- 1. A VISIT DOES NOT REFERENCE A PLAN. Adherence is computed by matching rep +
--    account + date window (0016), not by a foreign key from crm.visit. A rep
--    records a visit offline, possibly before a plan exists and certainly without
--    knowing its id; and re-planning must not orphan or invalidate visits that
--    already happened. The join is on facts, so it survives both.
--
-- 2. AN APPROVED PLAN IS FROZEN. If "we planned three calls" can be edited after
--    the calls happened, adherence measures nothing. A change after approval is a
--    new plan that supersedes the old one, leaving both in the record — the same
--    rule as a completed visit (0013) and as the ERP's own posted-entry
--    immutability guard.
--
-- 3. APPROVAL IS FOUR-EYED AND AUTHORISED. The approver is neither the rep nor
--    whoever submitted it, and must actually manage the rep's territory. The
--    territory hierarchy exists to answer that; 0016 asks it.

CREATE TABLE crm.cycle (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,

  code         text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),

  -- Inclusive on both ends. A cycle is a calendar fact the whole field force
  -- shares, so it is stored once rather than per plan.
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,

  status       text NOT NULL DEFAULT 'planning'
                 CHECK (status IN ('planning', 'active', 'closed')),

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, code),
  CONSTRAINT cycle_dates_ordered CHECK (ends_on >= starts_on),
  -- A guard rail, not a business rule. Pharma cycles run a month to a quarter; a
  -- span past a year is almost always a mistyped year, and the cost of that
  -- mistake is every adherence number in the cycle being quietly wrong.
  CONSTRAINT cycle_plausible_length CHECK (ends_on - starts_on <= 400)
);

-- Overlapping cycles are ALLOWED: a brand team's cycle and a national cycle can
-- legitimately cover the same weeks. No EXCLUDE constraint, deliberately — the
-- thing that must not overlap is two live plans for the same rep in the same
-- cycle, which is what the partial unique index below enforces.
CREATE INDEX idx_cycle_window ON crm.cycle (tenant_id, starts_on, ends_on);
CREATE INDEX idx_cycle_status ON crm.cycle (tenant_id, status);

SELECT crm.apply_tenant_isolation('crm.cycle');

-- ---------------------------------------------------------------------------

CREATE TABLE crm.call_plan (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,

  cycle_id         uuid NOT NULL REFERENCES crm.cycle (id) ON DELETE RESTRICT,
  -- Whose plan it is. Not who wrote it: a manager may build a plan for a new
  -- rep, and the distinction is what makes four-eyes meaningful.
  rep_profile_id   uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'approved', 'superseded', 'withdrawn')),

  submitted_by     uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  submitted_at     timestamptz,
  approved_by      uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  approved_at      timestamptz,
  approval_note    text,

  -- Set when a later plan replaces this one, so the chain of what was planned
  -- when stays walkable. Self-referencing, and DEFERRABLE INITIALLY DEFERRED for
  -- a reason worth stating: `uq_call_plan_live` below permits only one live plan
  -- per rep and cycle, so the original must leave the live set BEFORE its
  -- replacement is inserted — and the only status that takes it out of that set,
  -- `superseded`, requires a successor that does not exist yet. Deferring the
  -- foreign key to commit resolves the ordering without weakening the invariant:
  -- a superseded plan still must point at a real successor, just not until the
  -- transaction ends.
  superseded_by    uuid REFERENCES crm.call_plan (id) ON DELETE RESTRICT
                     DEFERRABLE INITIALLY DEFERRED,
  revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- A status and the fields that status asserts cannot disagree. `(a) <= (b)` is
  -- boolean implication: if the left is true the right must be.
  CONSTRAINT call_plan_submitted_pair
    CHECK ((status IN ('submitted', 'approved')) <= (submitted_at IS NOT NULL AND submitted_by IS NOT NULL)),
  CONSTRAINT call_plan_approved_pair
    CHECK ((status = 'approved') <= (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CONSTRAINT call_plan_superseded_pair
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CONSTRAINT call_plan_not_own_successor
    CHECK (superseded_by IS DISTINCT FROM id),

  -- FOUR EYES, in the schema rather than in a service. The approver is neither
  -- the rep whose plan it is nor whoever submitted it. Same rule the ERP applies
  -- to privileged actions (executedBy <> approvedBy), and the same reason: a
  -- self-approved plan is an unreviewed plan with a signature on it.
  CONSTRAINT call_plan_four_eyes_rep
    CHECK (approved_by IS NULL OR approved_by <> rep_profile_id),
  CONSTRAINT call_plan_four_eyes_submitter
    CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by)
);

-- One LIVE plan per rep per cycle. Superseded and withdrawn plans accumulate
-- freely — that is the history — but "the plan for this rep this cycle" must have
-- exactly one answer, or adherence has to pick one and will pick differently in
-- different places.
CREATE UNIQUE INDEX uq_call_plan_live
  ON crm.call_plan (tenant_id, cycle_id, rep_profile_id)
  WHERE status IN ('draft', 'submitted', 'approved');

CREATE INDEX idx_call_plan_rep    ON crm.call_plan (tenant_id, rep_profile_id, status);
CREATE INDEX idx_call_plan_cycle  ON crm.call_plan (tenant_id, cycle_id, status);
CREATE INDEX idx_call_plan_review ON crm.call_plan (tenant_id, status) WHERE status = 'submitted';

SELECT crm.apply_tenant_isolation('crm.call_plan');

-- ---------------------------------------------------------------------------

CREATE TABLE crm.call_plan_target (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  call_plan_id    uuid NOT NULL REFERENCES crm.call_plan (id) ON DELETE CASCADE,

  -- No FK: the ERP serves from a single JSONB table, so there is no per-entity
  -- table to reference (ADR-0001 item 3). The territory trigger in 0016 is what
  -- keeps these ids meaningful.
  erp_account_id  crm.erp_record_id NOT NULL,
  -- Optional. A target may name an individual prescriber rather than the whole
  -- institution; adherence counts accordingly.
  erp_contact_id  crm.erp_record_id,

  -- The tenant's own segmentation vocabulary. Not an enum: A/B/C/D is one
  -- convention among many, and a tenant that uses 'specialist'/'gp' should not
  -- have to pretend otherwise.
  segment         text CHECK (segment IS NULL OR length(segment) BETWEEN 1 AND 32),

  target_calls    integer NOT NULL CHECK (target_calls BETWEEN 1 AND 100),
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- NULLS NOT DISTINCT is load-bearing (Postgres 15+). A plain UNIQUE treats two
  -- NULL contacts as different values, so the same account could be targeted
  -- twice at institution level and both rows would count toward adherence
  -- separately. The duplicate is the bug; this is what refuses it.
  UNIQUE NULLS NOT DISTINCT (call_plan_id, erp_account_id, erp_contact_id)
);

CREATE INDEX idx_call_plan_target_account ON crm.call_plan_target (tenant_id, erp_account_id);
CREATE INDEX idx_call_plan_target_plan    ON crm.call_plan_target (tenant_id, call_plan_id);

SELECT crm.apply_tenant_isolation('crm.call_plan_target');

-- ---------------------------------------------------------------------------
-- What to detail, and in what order. Deliberately the same shape as
-- crm.visit_product (0012): the plan prescribes the sequence, the visit records
-- the one that happened, and comparing them is a subtraction rather than a
-- translation.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.call_plan_product (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  call_plan_id    uuid NOT NULL REFERENCES crm.call_plan (id) ON DELETE CASCADE,

  erp_item_id     crm.erp_record_id NOT NULL,
  position        integer NOT NULL CHECK (position >= 1),
  key_message     text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (call_plan_id, position),
  UNIQUE (call_plan_id, erp_item_id)
);

CREATE INDEX idx_call_plan_product_item ON crm.call_plan_product (tenant_id, erp_item_id);

SELECT crm.apply_tenant_isolation('crm.call_plan_product');
