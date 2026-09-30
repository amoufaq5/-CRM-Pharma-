-- 0012_visits.sql
--
-- The visit: what a rep opens the app to do.
--
-- Three constraints shape this table, and none of them are negotiable.
--
-- 1. OFFLINE FIRST. A rep works in a hospital basement with no signal. The id is
--    minted on the DEVICE, not here, so a visit recorded offline keeps its
--    identity when it finally syncs and a double-sync collapses into the same
--    row instead of creating two. Same principle as the outbox's deterministic
--    ERP ids, for the same reason.
--
-- 2. TWO CLOCKS. `occurred_at` is when the rep says the visit happened;
--    `recorded_at` is when the server heard about it. They can differ by hours,
--    and every report about field activity must use the first while every
--    debugging question uses the second. Collapsing them into one timestamp
--    loses whichever you did not pick.
--
-- 3. AUTHORISATION IS DATED. A rep may record a visit against an account in
--    their territory ON THE DAY OF THE VISIT — not today. An account that moved
--    territory in July must not invalidate June's visit, nor make it editable by
--    whoever holds it now. The trigger below checks
--    crm.rep_can_see_account(rep, account, occurred_at::date) for exactly this
--    reason, and it is the payoff for territories being effective-dated.

CREATE TABLE crm.visit (
  -- Client-minted. Not DEFAULT gen_random_uuid(): the device generates it before
  -- the row ever reaches us.
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,

  rep_profile_id    uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  -- No FK: the ERP runs --store pg, so Account and Contact live in a JSONB blob
  -- with no per-entity table to reference (ADR-0001 item 3).
  erp_account_id    crm.erp_record_id NOT NULL,
  erp_contact_id    crm.erp_record_id,

  visit_type        text NOT NULL DEFAULT 'detailing'
                      CHECK (visit_type IN ('detailing','follow_up','sample_drop','training','cycle_meeting','other')),

  status            text NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','in_progress','completed','cancelled','missed')),

  planned_for       date,
  occurred_at       timestamptz,
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 0 AND 1440),

  -- Plain numerics rather than a PostGIS point. Recording where a rep checked in
  -- needs two numbers; geometry is for route optimisation and territory
  -- polygons, and arrives with the migration that first needs it so no
  -- environment fails on an extension nothing yet uses.
  checkin_latitude  numeric(9,6) CHECK (checkin_latitude IS NULL OR checkin_latitude BETWEEN -90 AND 90),
  checkin_longitude numeric(9,6) CHECK (checkin_longitude IS NULL OR checkin_longitude BETWEEN -180 AND 180),
  -- The device's own accuracy estimate. Kept because a check-in 3km out with a
  -- 5km error radius is not evidence of anything, and a compliance review that
  -- cannot tell those apart will reach the wrong conclusion about a rep.
  checkin_accuracy_m numeric(8,2) CHECK (checkin_accuracy_m IS NULL OR checkin_accuracy_m >= 0),

  outcome           text CHECK (outcome IS NULL OR outcome IN ('successful','no_access','rescheduled','declined')),
  notes             text,

  -- Two clocks. See the header.
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- A visit that happened must say when. A planned one need not yet.
  CONSTRAINT visit_occurred_when_done
    CHECK ((status IN ('in_progress','completed')) <= (occurred_at IS NOT NULL)),
  -- An outcome is a statement about a visit that took place.
  CONSTRAINT visit_outcome_only_when_completed
    CHECK (outcome IS NULL OR status = 'completed'),
  -- Latitude and longitude are meaningless apart.
  CONSTRAINT visit_checkin_pair
    CHECK ((checkin_latitude IS NULL) = (checkin_longitude IS NULL))
);

CREATE INDEX idx_visit_rep_date     ON crm.visit (tenant_id, rep_profile_id, occurred_at DESC);
CREATE INDEX idx_visit_account      ON crm.visit (tenant_id, erp_account_id, occurred_at DESC);
CREATE INDEX idx_visit_status       ON crm.visit (tenant_id, status, planned_for);
CREATE INDEX idx_visit_recorded     ON crm.visit (tenant_id, recorded_at);

SELECT crm.apply_tenant_isolation('crm.visit');

-- ---------------------------------------------------------------------------
-- Detailing lines: which products were discussed, in what order.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.visit_product (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  visit_id       uuid NOT NULL REFERENCES crm.visit (id) ON DELETE CASCADE,

  erp_item_id    crm.erp_record_id NOT NULL,

  -- Detailing order matters commercially: the first product discussed gets the
  -- attention, and the sequence is what a cycle plan prescribes and a manager
  -- reviews.
  position       integer NOT NULL CHECK (position >= 1),

  key_message    text,
  -- The HCP's response. A CRM-native concept with no ERP equivalent.
  reaction       text CHECK (reaction IN ('positive','neutral','negative','not_discussed')),

  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (visit_id, position),
  UNIQUE (visit_id, erp_item_id)
);

CREATE INDEX idx_visit_product_item ON crm.visit_product (tenant_id, erp_item_id);

SELECT crm.apply_tenant_isolation('crm.visit_product');
