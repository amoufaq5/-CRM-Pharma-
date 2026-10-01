-- 0020_disposal_obligations.sql
--
-- Expired stock in a rep's bag, and the obligation to get rid of it properly.
--
-- WHY THIS IS NOT A WRITE-OFF JOB, AND THAT IS DELIBERATE.
--
-- The obvious reading of "write off expired stock nightly" is: find holdings past
-- their expiry, post an `expiry_writeoff`, balance clean. Do not do that to a drug
-- sample. The material is still physically in the rep's bag at 3am; posting a movement
-- that removes it from the balance makes the system assert the stock is gone when it is
-- not, and the question an inspector asks is "where did these twenty expired units
-- actually go?". "A scheduled job stopped counting them" is the worst available answer —
-- worse than an untidy balance, because it looks like an answer.
--
-- So the sweep RAISES AN OBLIGATION and chases it. The material leaves custody only
-- through a movement a person recorded: a `destruction` (with a reason, and in practice
-- a witness) or a `return_to_warehouse`. The obligation closes when the holding reaches
-- zero, recording WHICH movement discharged it. What the job contributes is the thing
-- nobody was doing: noticing, dating, and escalating.
--
-- Promotional material is different and is treated differently — a leaflet past its
-- campaign date carries no custody obligation — so auto write-off is available for it,
-- per tenant, opt-in, and never for a drug sample.
--
-- Disbursement of expired stock was already impossible (0018 compares the expiry
-- against `occurred_at`), so this adds no protection there. It adds accountability for
-- what happens next.

-- The fourth scheduled job. The CHECK in 0009 enumerates them, so it is replaced rather
-- than extended — there is no ALTER for one value of a CHECK.
ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full', 'expiry_sweep'));

-- ---------------------------------------------------------------------------
-- Per-tenant policy. One row per tenant, created on demand by the sweep.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.disposal_policy (
  tenant_id              uuid PRIMARY KEY,

  -- How long a rep has to dispose of expired stock before the obligation is overdue.
  -- Stored per tenant because it is a commitment in an SOP, not a constant — and
  -- copied onto each obligation at discovery, so changing it never rewrites a deadline
  -- that has already been communicated.
  grace_days             integer NOT NULL DEFAULT 30 CHECK (grace_days BETWEEN 0 AND 365),

  -- Opt-in, and only ever consulted for promo_material. A drug sample is never written
  -- off by a machine; see the header.
  auto_writeoff_promo    boolean NOT NULL DEFAULT false,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Holds no tenant data beyond the id and two knobs, like crm.tenant — but it DOES carry
-- a tenant_id that scopes real decisions, so unlike the registry it is RLS-protected.
SELECT crm.apply_tenant_isolation('crm.disposal_policy');

-- ---------------------------------------------------------------------------
CREATE TABLE crm.disposal_obligation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,

  rep_profile_id         uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  lot_id                 uuid NOT NULL REFERENCES crm.sample_lot (id) ON DELETE RESTRICT,

  -- What was on hand when the sweep first noticed. The live number is the holding;
  -- this is the historical fact, and a shrinking holding against an unchanged
  -- discovery quantity is how partial disposal reads.
  quantity_at_discovery  numeric(16,3) NOT NULL CHECK (quantity_at_discovery > 0),

  -- The two dates the question "when did you know, and by when were you supposed to
  -- act" needs. `expired_on` is the lot's own date, carried here so the obligation is
  -- readable without a join.
  expired_on             date NOT NULL,
  discovered_on          date NOT NULL,
  due_by                 date NOT NULL,

  status                 text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'overdue', 'resolved')),

  resolved_on            date,
  -- How it was discharged, attributed from the ledger rather than declared: the sweep
  -- finds the decreasing movement that took the holding to zero and records which kind
  -- it was. `destroyed` and `returned` are the two defensible answers; the others are
  -- recorded as what they are rather than dressed up.
  resolution             text CHECK (resolution IS NULL OR resolution IN
                           ('destroyed', 'returned', 'written_off', 'transferred', 'adjusted')),
  resolving_transaction_id uuid REFERENCES crm.sample_transaction (id) ON DELETE RESTRICT,

  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT disposal_due_after_discovery CHECK (due_by >= discovered_on),
  CONSTRAINT disposal_resolved_pair
    CHECK ((status = 'resolved') = (resolved_on IS NOT NULL AND resolution IS NOT NULL))
);

-- One LIVE obligation per (rep, lot). The sweep runs daily and must not accumulate a
-- row per night for the same expired carton — the deadline would reset every time,
-- which is exactly the opposite of chasing it.
CREATE UNIQUE INDEX uq_disposal_obligation_live
  ON crm.disposal_obligation (rep_profile_id, lot_id)
  WHERE status IN ('open', 'overdue');

CREATE INDEX idx_disposal_obligation_due
  ON crm.disposal_obligation (tenant_id, due_by)
  WHERE status IN ('open', 'overdue');
CREATE INDEX idx_disposal_obligation_rep
  ON crm.disposal_obligation (tenant_id, rep_profile_id, status);

SELECT crm.apply_tenant_isolation('crm.disposal_obligation');

-- ---------------------------------------------------------------------------

/**
 * Expired stock a rep still holds: what the sweep acts on.
 *
 * Distinct from crm.expiring_sample_holdings, which answers "what is ABOUT to expire"
 * for a warning screen. This one is strictly past-dated and includes the material kind,
 * because the sweep treats a drug sample and a leaflet differently.
 */
CREATE OR REPLACE FUNCTION crm.expired_sample_holdings(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  rep_profile_id    uuid,
  lot_id            uuid,
  erp_item_id       text,
  lot_number        text,
  material_kind     text,
  expiry_date       date,
  days_expired      integer,
  quantity_on_hand  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT h.rep_profile_id, h.lot_id, l.erp_item_id::text, l.lot_number, l.material_kind,
         l.expiry_date, (p_as_of - l.expiry_date)::integer, h.quantity_on_hand
    FROM crm.sample_holding h
    JOIN crm.sample_lot l ON l.id = h.lot_id
   WHERE h.quantity_on_hand > 0
     AND l.expiry_date IS NOT NULL
     AND l.expiry_date < p_as_of
   ORDER BY l.expiry_date, h.rep_profile_id;
$$;

/**
 * The movement that discharged an obligation, attributed from the ledger.
 *
 * The sweep sees a holding at zero and has to say HOW. Rather than trusting whoever
 * resolved it to declare the reason, it reads the last decreasing movement on that
 * (rep, lot) at or after the obligation was discovered. The answer is therefore the
 * ledger's, not a claim about the ledger — which is the distinction an audit cares
 * about.
 *
 * Returns nothing when no such movement exists, which the caller treats as "cannot
 * attribute" rather than inventing one.
 */
CREATE OR REPLACE FUNCTION crm.disposal_resolving_movement(
  p_rep_profile_id uuid,
  p_lot_id         uuid,
  p_since          date
)
RETURNS TABLE (transaction_id uuid, kind text, resolution text)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.kind,
         CASE t.kind
           WHEN 'destruction'         THEN 'destroyed'
           WHEN 'return_to_warehouse' THEN 'returned'
           WHEN 'expiry_writeoff'     THEN 'written_off'
           WHEN 'transfer_out'        THEN 'transferred'
           WHEN 'adjustment_out'      THEN 'adjusted'
         END
    FROM crm.sample_transaction t
   WHERE t.rep_profile_id = p_rep_profile_id
     AND t.lot_id = p_lot_id
     AND crm.sample_effect(t.kind) < 0
     AND t.occurred_at >= p_since::timestamptz
   ORDER BY t.occurred_at DESC, t.recorded_at DESC
   LIMIT 1;
$$;

/**
 * Open obligations, oldest deadline first — the list a rep is asked to clear and a
 * manager chases.
 *
 * `days_overdue` is positive once past the deadline and negative while there is still
 * time, so one column sorts and reads for both.
 */
CREATE OR REPLACE FUNCTION crm.open_disposal_obligations(
  p_rep_profile_id uuid DEFAULT NULL,
  p_as_of          date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id                uuid,
  rep_profile_id    uuid,
  display_name      text,
  lot_id            uuid,
  erp_item_id       text,
  lot_number        text,
  material_kind     text,
  expired_on        date,
  discovered_on     date,
  due_by            date,
  days_overdue      integer,
  status            text,
  quantity_on_hand  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.rep_profile_id, rp.display_name, o.lot_id, l.erp_item_id::text, l.lot_number,
         l.material_kind, o.expired_on, o.discovered_on, o.due_by,
         (p_as_of - o.due_by)::integer, o.status,
         COALESCE(h.quantity_on_hand, 0)
    FROM crm.disposal_obligation o
    JOIN crm.rep_profile rp ON rp.id = o.rep_profile_id
    JOIN crm.sample_lot l ON l.id = o.lot_id
    LEFT JOIN crm.sample_holding h
           ON h.rep_profile_id = o.rep_profile_id AND h.lot_id = o.lot_id
   WHERE o.status IN ('open', 'overdue')
     AND (p_rep_profile_id IS NULL OR o.rep_profile_id = p_rep_profile_id)
   ORDER BY o.due_by, rp.display_name;
$$;

-- ---------------------------------------------------------------------------
-- Closing an adjacent hole: expired stock could be RECEIVED into custody.
--
-- 0018 checked the expiry on disbursement and nowhere else, so a rep could confirm
-- receipt of a carton that expired last week and the sweep would then raise a disposal
-- obligation for material that should never have been accepted. Refusing the record is
-- the right answer: if the warehouse sends expired stock, the rep does not take custody
-- of it — the warehouse takes it back.
--
-- `transfer_in` is deliberately NOT refused. Material already in someone's custody has
-- to be somewhere, and refusing the acceptance would strand it in transit forever with
-- nobody accountable. Expired stock can move between reps on its way to destruction;
-- it just cannot enter custody from the warehouse.
--
-- This replaces the function from 0018 rather than adding a second trigger, so there is
-- one place the disbursement and receipt rules are read together.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm.sample_transaction_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot     record;
  v       record;
  src     record;
BEGIN
  SELECT material_kind, expiry_date, status, lot_number
    INTO lot FROM crm.sample_lot WHERE id = NEW.lot_id;

  IF NEW.kind = 'receipt' THEN
    IF lot.expiry_date IS NOT NULL AND lot.expiry_date < NEW.occurred_at::date THEN
      RAISE EXCEPTION
        'lot % expired on % and cannot be received into custody (receipt recorded for %)',
        lot.lot_number, lot.expiry_date, NEW.occurred_at::date
        USING ERRCODE = 'check_violation';
    END IF;
    IF lot.status <> 'active' THEN
      RAISE EXCEPTION 'lot % is % and cannot be received into custody', lot.lot_number, lot.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.kind = 'disbursement' THEN
    IF lot.expiry_date IS NOT NULL AND lot.expiry_date < NEW.occurred_at::date THEN
      RAISE EXCEPTION
        'lot % expired on % and cannot be disbursed (hand-over recorded for %)',
        lot.lot_number, lot.expiry_date, NEW.occurred_at::date
        USING ERRCODE = 'check_violation';
    END IF;
    IF lot.status <> 'active' THEN
      RAISE EXCEPTION 'lot % is % and cannot be disbursed', lot.lot_number, lot.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT crm.rep_can_see_account(NEW.rep_profile_id, NEW.erp_account_id::text, NEW.occurred_at::date) THEN
      RAISE EXCEPTION
        'rep % did not cover account % on % — samples cannot be disbursed outside the rep''s territory',
        NEW.rep_profile_id, NEW.erp_account_id, NEW.occurred_at::date
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.visit_id IS NOT NULL THEN
      SELECT rep_profile_id, erp_account_id INTO v FROM crm.visit WHERE id = NEW.visit_id;
      IF v.rep_profile_id <> NEW.rep_profile_id OR v.erp_account_id <> NEW.erp_account_id THEN
        RAISE EXCEPTION
          'visit % is not this rep''s visit to account % — a disbursement cannot be attached to it',
          NEW.visit_id, NEW.erp_account_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.kind = 'transfer_in' THEN
    SELECT kind, lot_id, quantity, rep_profile_id, counterparty_rep_profile_id
      INTO src FROM crm.sample_transaction WHERE id = NEW.transfer_of;
    IF src IS NULL THEN
      RAISE EXCEPTION 'transfer_of % does not exist', NEW.transfer_of USING ERRCODE = 'check_violation';
    END IF;
    IF src.kind <> 'transfer_out' THEN
      RAISE EXCEPTION 'transfer_of % is a %, not a transfer_out', NEW.transfer_of, src.kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF src.lot_id <> NEW.lot_id OR src.quantity <> NEW.quantity THEN
      RAISE EXCEPTION
        'acceptance must match the transfer exactly (sent % of lot %, accepting % of lot %)',
        src.quantity, src.lot_id, NEW.quantity, NEW.lot_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF src.counterparty_rep_profile_id <> NEW.rep_profile_id
       OR src.rep_profile_id <> NEW.counterparty_rep_profile_id THEN
      RAISE EXCEPTION
        'transfer % was sent by % to %, so % cannot accept it from %',
        NEW.transfer_of, src.rep_profile_id, src.counterparty_rep_profile_id,
        NEW.rep_profile_id, NEW.counterparty_rep_profile_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
