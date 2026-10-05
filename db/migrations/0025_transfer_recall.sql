-- 0025_transfer_recall.sql
--
-- Taking back a transfer nobody accepted.
--
-- WHAT WAS BROKEN. `transfer_out` moves material out of the sender's
-- `quantity_on_hand` and into their `quantity_in_transit`, where it stays until a
-- `transfer_in` accepts it. Nothing made the receiver accept. If they never did —
-- they were on leave, the boxes were never collected, the wrong rep was picked from
-- the list — the quantity sat in transit forever: still the sender's
-- responsibility, visible in `GET /v1/samples/transfers`, and impossible to get
-- back. An `adjustment_in` could not fix it either, because an adjustment only
-- touches `quantity_on_hand`, so using one would have the rep holding the material
-- twice. Recorded as an open item in ADR-0001 ("A transfer that is never accepted
-- leaves material in `quantity_in_transit` indefinitely").
--
-- THE RULE. A recall is a NEW ledger kind, `transfer_recall`, carrying
-- `transfer_of` to the original like an acceptance does, and recorded BY THE
-- SENDER — the rep whose in-transit balance it clears. Its effect is the exact
-- inverse of the `transfer_out`: in-transit falls, on-hand rises, by the same
-- quantity, in one statement. So the sender's total custody is unchanged, and the
-- material is never in neither place nor in both — the property the acceptance
-- branch already has and the reason an adjustment pair is not an acceptable
-- substitute.
--
-- A transfer therefore has exactly ONE terminal event: accepted, or recalled, never
-- both and never twice. `uq_sample_tx_transfer_accepted` already enforced that
-- (one row may reference a given transfer), so it needed no change — but its name
-- now understates it, and is left alone rather than churned: it predates the
-- second kind of terminal event, not the index's meaning.
--
-- CONSEQUENCE WORTH KNOWING. A recall is NOT refused for an expired or withdrawn
-- lot, deliberately, for the reason 0020 gives for not refusing a `transfer_in`:
-- material already in custody has to be somewhere, and refusing the only way out
-- of transit would strand it there with nobody accountable — which is the bug this
-- file closes. A withdrawn lot is in fact the likeliest reason to recall a
-- transfer. The judgement about expiry is made where it belongs, on the
-- disbursement.

-- ---------------------------------------------------------------------------
-- The kind. 0017 enumerates them in a CHECK, so it is replaced rather than
-- extended — there is no ALTER for one value of a CHECK.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.sample_transaction DROP CONSTRAINT sample_transaction_kind_check;
ALTER TABLE crm.sample_transaction ADD CONSTRAINT sample_transaction_kind_check
  CHECK (kind IN (
    'receipt',             -- + from ERP-controlled stock
    'transfer_in',         -- + accepted from another rep
    'transfer_recall',     -- + taken back by the sender, out of in-transit
    'adjustment_in',       -- + count variance upward
    'disbursement',        -- - handed to an HCP
    'transfer_out',        -- - sent to another rep (to in_transit)
    'return_to_warehouse', -- - back into ERP stock
    'destruction',         -- - witnessed destruction
    'expiry_writeoff',     -- - written off as expired
    'adjustment_out'       -- - count variance downward
  ));

-- The same shape as the acceptance's constraint, and for the same reason: a recall
-- that does not say which transfer it ends, or which rep the material was with, is
-- two unrelated rows again. The sender is `rep_profile_id` and the rep it was sent
-- to is the counterparty — the identical orientation to the `transfer_out` it
-- reverses, so neither row has to be read backwards.
ALTER TABLE crm.sample_transaction ADD CONSTRAINT sample_tx_transfer_recall_fields
  CHECK (
    kind <> 'transfer_recall' OR (
      counterparty_rep_profile_id IS NOT NULL
      AND counterparty_rep_profile_id <> rep_profile_id
      AND transfer_of IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Direction. Still the single place it is decided.
-- ---------------------------------------------------------------------------

/**
 * A recall is +1: it ends with the material back in the sender's bag.
 *
 * That is the same convention `transfer_out` follows at -1 — the sign describes
 * what happens to `quantity_on_hand`, and the in-transit leg is the apply
 * trigger's business. Reading it as 0 because the rep's total custody does not
 * change would make `crm.disposal_resolving_movement`, which asks this function
 * which movements are decreasing, no longer able to answer.
 */
CREATE OR REPLACE FUNCTION crm.sample_effect(p_kind text)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'receipt'             THEN  1
    WHEN 'transfer_in'         THEN  1
    WHEN 'transfer_recall'     THEN  1
    WHEN 'adjustment_in'       THEN  1
    WHEN 'disbursement'        THEN -1
    WHEN 'transfer_out'        THEN -1
    WHEN 'return_to_warehouse' THEN -1
    WHEN 'destruction'         THEN -1
    WHEN 'expiry_writeoff'     THEN -1
    WHEN 'adjustment_out'      THEN -1
  END;
$$;

-- ---------------------------------------------------------------------------
-- Validation. Replaces the function from 0020 — which replaced 0018's — so the
-- disbursement, receipt, acceptance and recall rules stay readable together.
--
-- Two changes beyond the new branch, both on the shared transfer path:
--
--   - the `transfer_of` lookup is hoisted, because an acceptance and a recall ask
--     the same two questions of it first (does it exist, is it a transfer_out);
--   - the terminal-event check is now explicit rather than left to the unique
--     index. The index is still the backstop that holds under a race, but a
--     refusal that can say "already accepted, by that rep, on that day" is worth
--     more than one naming an index — and after this file "already accepted" is
--     only half of what could have happened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm.sample_transaction_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot     record;
  v       record;
  src     record;
  term    record;
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

  -- An acceptance and a recall are the two ways a transfer ends. Both must name a
  -- real, matching, still-open transfer_out: without that the pair is two
  -- independent rows and the in-transit quantity is a number nobody reconciles —
  -- which is precisely the ERP's failure mode here.
  IF NEW.kind IN ('transfer_in', 'transfer_recall') THEN
    SELECT kind, lot_id, quantity, rep_profile_id, counterparty_rep_profile_id
      INTO src FROM crm.sample_transaction WHERE id = NEW.transfer_of;
    IF src IS NULL THEN
      RAISE EXCEPTION 'transfer_of % does not exist', NEW.transfer_of USING ERRCODE = 'check_violation';
    END IF;
    IF src.kind <> 'transfer_out' THEN
      RAISE EXCEPTION 'transfer_of % is a %, not a transfer_out', NEW.transfer_of, src.kind
        USING ERRCODE = 'check_violation';
    END IF;

    -- `id <> NEW.id` is load-bearing. A BEFORE trigger runs before `ON CONFLICT (id) DO
    -- NOTHING` arbitrates, so without it a REDELIVERED offline movement — same
    -- device-minted id, already in the table — would be refused as a second terminal
    -- event instead of collapsing into the row already there. The device mints the id
    -- precisely so a retried sync is a no-op (rule 7); a row cannot be its own
    -- duplicate.
    SELECT kind, rep_profile_id, occurred_at
      INTO term FROM crm.sample_transaction
     WHERE transfer_of = NEW.transfer_of AND id <> NEW.id;
    IF FOUND THEN
      IF term.kind = 'transfer_in' THEN
        RAISE EXCEPTION
          'transfer % has already been accepted by % on % and can no longer be %',
          NEW.transfer_of, term.rep_profile_id, term.occurred_at::date,
          CASE WHEN NEW.kind = 'transfer_in' THEN 'accepted' ELSE 'recalled' END
          USING ERRCODE = 'check_violation';
      ELSIF term.kind = 'transfer_recall' THEN
        RAISE EXCEPTION
          'transfer % has already been recalled by its sender on % and can no longer be %',
          NEW.transfer_of, term.occurred_at::date,
          CASE WHEN NEW.kind = 'transfer_in' THEN 'accepted' ELSE 'recalled' END
          USING ERRCODE = 'check_violation';
      ELSE
        -- `transfer_of` is only constrained on the two kinds that use it, so some
        -- other kind could be holding the one slot the unique index allows. Say so
        -- rather than report a terminal event that is not one.
        RAISE EXCEPTION 'transfer % already has a % recorded against it', NEW.transfer_of, term.kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.kind = 'transfer_in' THEN
    IF src.lot_id <> NEW.lot_id OR src.quantity <> NEW.quantity THEN
      RAISE EXCEPTION
        'acceptance must match the transfer exactly (sent % of lot %, accepting % of lot %)',
        src.quantity, src.lot_id, NEW.quantity, NEW.lot_id
        USING ERRCODE = 'check_violation';
    END IF;
    -- The accepting rep must be the one it was sent to, and the sender must be the
    -- one who sent it. Otherwise material could be intercepted by a third rep.
    IF src.counterparty_rep_profile_id <> NEW.rep_profile_id
       OR src.rep_profile_id <> NEW.counterparty_rep_profile_id THEN
      RAISE EXCEPTION
        'transfer % was sent by % to %, so % cannot accept it from %',
        NEW.transfer_of, src.rep_profile_id, src.counterparty_rep_profile_id,
        NEW.rep_profile_id, NEW.counterparty_rep_profile_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.kind = 'transfer_recall' THEN
    -- Only the sender, because only the sender's balance has the material: it is
    -- in THEIR in-transit column and the recall is what puts it back in their bag.
    -- A receiver who does not want it is refusing, not recalling — a different act,
    -- with a different destination for the material, and not this kind.
    IF src.rep_profile_id <> NEW.rep_profile_id THEN
      RAISE EXCEPTION
        'transfer % was sent by % to %, so % cannot recall it — only the sender can take material back',
        NEW.transfer_of, src.rep_profile_id, src.counterparty_rep_profile_id, NEW.rep_profile_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF src.counterparty_rep_profile_id <> NEW.counterparty_rep_profile_id THEN
      RAISE EXCEPTION
        'recall of transfer % must name the rep it was sent to (%), not %',
        NEW.transfer_of, src.counterparty_rep_profile_id, NEW.counterparty_rep_profile_id
        USING ERRCODE = 'check_violation';
    END IF;
    -- All of it or none of it. A partial recall would leave the remainder in transit
    -- against a transfer that already has its one terminal event, so nothing could
    -- ever clear it — and splitting the original into two settleable halves is an
    -- accounting story of its own, not a quantity argument.
    IF src.lot_id <> NEW.lot_id OR src.quantity <> NEW.quantity THEN
      RAISE EXCEPTION
        'a recall must take back exactly what was sent (sent % of lot %, recalling % of lot %)',
        src.quantity, src.lot_id, NEW.quantity, NEW.lot_id
        USING ERRCODE = 'check_violation';
    END IF;
    -- No check that the recall is dated after the transfer. An acceptance has none
    -- either, and a recall that was stricter than an acceptance about dates would be
    -- a difference nobody could account for. `occurred_at` is what the rep says
    -- happened; the ledger keeps `recorded_at` for when we heard.
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Application. Replaces 0018's, with the one new branch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm.sample_transaction_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eff       integer := crm.sample_effect(NEW.kind);
  on_hand   numeric(16,3);
  in_trans  numeric(16,3);
BEGIN
  -- Lock (or create) this rep's holding row before reading it, so two concurrent
  -- disbursements cannot both see enough stock.
  INSERT INTO crm.sample_holding (tenant_id, rep_profile_id, lot_id)
  VALUES (NEW.tenant_id, NEW.rep_profile_id, NEW.lot_id)
  ON CONFLICT (rep_profile_id, lot_id) DO NOTHING;

  SELECT quantity_on_hand, quantity_in_transit INTO on_hand, in_trans
    FROM crm.sample_holding
   WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id
     FOR UPDATE;

  IF eff < 0 AND on_hand < NEW.quantity THEN
    RAISE EXCEPTION
      'rep % holds % of lot % — cannot record a % of %',
      NEW.rep_profile_id, on_hand, NEW.lot_id, NEW.kind, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.kind = 'transfer_out' THEN
    -- Out of the bag and into transit: the quantity stays this rep's
    -- responsibility until someone accepts it.
    UPDATE crm.sample_holding
       SET quantity_on_hand = quantity_on_hand - NEW.quantity,
           quantity_in_transit = quantity_in_transit + NEW.quantity,
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id;

  ELSIF NEW.kind = 'transfer_in' THEN
    -- The receiver gains it; the sender's transit balance clears. One statement
    -- each, one transaction, so the total across both reps is unchanged at every
    -- point an observer could look.
    UPDATE crm.sample_holding
       SET quantity_on_hand = quantity_on_hand + NEW.quantity,
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id;

    UPDATE crm.sample_holding
       SET quantity_in_transit = quantity_in_transit - NEW.quantity,
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.counterparty_rep_profile_id AND lot_id = NEW.lot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the sending rep % holds no record of lot %', NEW.counterparty_rep_profile_id, NEW.lot_id
        USING ERRCODE = 'check_violation';
    END IF;

  ELSIF NEW.kind = 'transfer_recall' THEN
    -- The exact inverse of the transfer_out, on the ONE holding it moved: out of
    -- transit and back into the bag. A single UPDATE rather than two, because no
    -- other rep's row is involved — the receiver never took custody — and because
    -- the two columns must move together or the rep briefly holds the material
    -- nowhere.
    --
    -- The guard the generic path cannot give us: `eff` is +1 here, so the check
    -- above does not run, and in-transit is the balance this draws down.
    -- Unreachable while every transfer has one terminal event, and kept because
    -- that is exactly when a backstop earns its place.
    IF in_trans < NEW.quantity THEN
      RAISE EXCEPTION
        'rep % holds % of lot % in transit — cannot record a % of %',
        NEW.rep_profile_id, in_trans, NEW.lot_id, NEW.kind, NEW.quantity
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE crm.sample_holding
       SET quantity_in_transit = quantity_in_transit - NEW.quantity,
           quantity_on_hand = quantity_on_hand + NEW.quantity,
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id;

  ELSE
    UPDATE crm.sample_holding
       SET quantity_on_hand = quantity_on_hand + (eff * NEW.quantity),
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id;
  END IF;

  RETURN NEW;
END
$$;

/**
 * Transfers this rep sent that still have no terminal event — the ones they can
 * take back.
 *
 * Deliberately narrower than `outstandingTransfers`, which answers "where is my
 * material" for either side of the transfer. Only the sender can recall, so a list
 * offering the action must not show a rep the transfers sent TO them: that would
 * put a button in front of someone the database will refuse.
 */
CREATE OR REPLACE FUNCTION crm.recallable_transfers(p_rep_profile_id uuid)
RETURNS TABLE (
  transaction_id   uuid,
  lot_id           uuid,
  lot_number       text,
  erp_item_id      text,
  expiry_date      date,
  quantity         numeric,
  sent_to          uuid,
  sent_to_name     text,
  occurred_at      timestamptz,
  days_in_transit  integer
)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.lot_id, l.lot_number, l.erp_item_id::text, l.expiry_date, t.quantity,
         t.counterparty_rep_profile_id, rp.display_name, t.occurred_at,
         (CURRENT_DATE - t.occurred_at::date)::integer
    FROM crm.sample_transaction t
    JOIN crm.sample_lot l ON l.id = t.lot_id
    JOIN crm.rep_profile rp ON rp.id = t.counterparty_rep_profile_id
   WHERE t.kind = 'transfer_out'
     AND t.rep_profile_id = p_rep_profile_id
     AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction x WHERE x.transfer_of = t.id)
   ORDER BY t.occurred_at;
$$;
