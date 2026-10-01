-- 0018_sample_custody_rules.sql
--
-- What makes the custody ledger accountable rather than merely recorded.
--
-- The ERP's inventory tables fail on exactly this layer: `StockMovement` and
-- `StockLevel` both exist and nothing connects them, so a balance is whatever the
-- last caller said it was. Here the balance is DERIVED, in the same transaction as
-- the movement, by a trigger no caller can skip — and a movement that would drive
-- it negative aborts the transaction rather than being written.
--
-- Everything below is in SQL for the same reason as crm.visible_account_ids: the
-- interactive path and the offline-sync path must enforce one rule, not two.

/**
 * Which way a kind moves a balance. The single place direction is decided.
 *
 * IMMUTABLE and no table access, so it can be used inside CHECKs and indexes if
 * ever needed, and so the planner can fold it.
 */
CREATE OR REPLACE FUNCTION crm.sample_effect(p_kind text)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'receipt'             THEN  1
    WHEN 'transfer_in'         THEN  1
    WHEN 'adjustment_in'       THEN  1
    WHEN 'disbursement'        THEN -1
    WHEN 'transfer_out'        THEN -1
    WHEN 'return_to_warehouse' THEN -1
    WHEN 'destruction'         THEN -1
    WHEN 'expiry_writeoff'     THEN -1
    WHEN 'adjustment_out'      THEN -1
  END;
$$;

/**
 * The rules a movement must satisfy before it touches a balance.
 *
 * Four of them, and each one is a question a sample audit asks:
 *
 *  - WAS IT IN DATE? A disbursement of an expired lot is refused, compared
 *    against `occurred_at` rather than now, because a sync three days later must
 *    not retroactively invalidate a hand-over that was legitimate when it
 *    happened — nor legitimise one that was not.
 *  - WAS THE LOT RELEASED? Quarantined and withdrawn lots cannot be handed out.
 *    This is the recall path: flipping one lot row stops every rep at once.
 *  - WAS IT THEIR CUSTOMER? Same dated territory rule as a visit
 *    (crm.rep_can_see_account on the day it happened), so the two cannot disagree
 *    about whether a rep covered an account.
 *  - DOES THE VISIT AGREE? If the disbursement names a visit, that visit must be
 *    the same rep's and the same account's. A sample attributed to the wrong call
 *    report is worse than one attributed to none.
 */
CREATE OR REPLACE FUNCTION crm.sample_transaction_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot     record;
  v       record;
  src     record;
BEGIN
  SELECT material_kind, expiry_date, status, lot_number
    INTO lot FROM crm.sample_lot WHERE id = NEW.lot_id;

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

  -- A transfer_in must accept a real, matching, unaccepted transfer_out. Without
  -- this the pair is two independent rows and the in-transit quantity is a number
  -- nobody reconciles — which is precisely the ERP's failure mode here.
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

  RETURN NEW;
END
$$;

CREATE TRIGGER sample_transaction_validate
  BEFORE INSERT ON crm.sample_transaction
  FOR EACH ROW EXECUTE FUNCTION crm.sample_transaction_validate();

/**
 * Applies the movement to the balance, in the same transaction that records it.
 *
 * This is the whole point of the table. A caller cannot post a movement without
 * moving the balance, cannot move the balance without a movement, and cannot drive
 * either negative. The readable error below fires first; the `>= 0` CHECKs on
 * crm.sample_holding are the structural backstop underneath it.
 *
 * A transfer touches TWO holdings: the sender's in-transit falls and the
 * receiver's on-hand rises, together. Material is therefore never in neither
 * place, which is the property an unlinked movement pair cannot offer.
 */
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

  ELSE
    UPDATE crm.sample_holding
       SET quantity_on_hand = quantity_on_hand + (eff * NEW.quantity),
           last_movement_at = NEW.occurred_at
     WHERE rep_profile_id = NEW.rep_profile_id AND lot_id = NEW.lot_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER sample_transaction_apply
  AFTER INSERT ON crm.sample_transaction
  FOR EACH ROW EXECUTE FUNCTION crm.sample_transaction_apply();

/**
 * The ledger is append-only.
 *
 * A custody record that can be edited is not a custody record. A mistake is
 * corrected by an `adjustment_in`/`adjustment_out` carrying a reason, which leaves
 * both the error and the correction in the log — the same discipline as a
 * completed visit (0013) and as the ERP's posted journal entries.
 */
CREATE OR REPLACE FUNCTION crm.sample_transaction_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.sample_transaction is append-only (attempted % on %). Post an adjustment with a reason instead.',
    TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER sample_transaction_append_only
  BEFORE UPDATE OR DELETE ON crm.sample_transaction
  FOR EACH ROW EXECUTE FUNCTION crm.sample_transaction_append_only();

/**
 * Nothing writes a holding directly.
 *
 * The balance is a projection of the ledger. Allowing a bare UPDATE would reopen
 * exactly the gap this file closes — a number that disagrees with the movements
 * behind it and no way to tell which is wrong. The trigger function above runs as
 * part of the INSERT on crm.sample_transaction, which is how it is distinguished
 * from a direct write.
 */
CREATE OR REPLACE FUNCTION crm.sample_holding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- pg_trigger_depth() > 1 means we were reached from the ledger trigger rather
  -- than from a client statement.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- A count stamps last_counted_at and nothing else; allowed because it asserts
  -- when the shelf was looked at, not what is on it.
  IF TG_OP = 'UPDATE'
     AND (NEW.quantity_on_hand, NEW.quantity_in_transit) IS NOT DISTINCT FROM
         (OLD.quantity_on_hand, OLD.quantity_in_transit) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'crm.sample_holding is derived from crm.sample_transaction and cannot be written directly (attempted %)',
    TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER sample_holding_guard
  BEFORE INSERT OR UPDATE OR DELETE ON crm.sample_holding
  FOR EACH ROW EXECUTE FUNCTION crm.sample_holding_guard();

-- ---------------------------------------------------------------------------

/**
 * Commits a count: one adjustment per line whose count disagrees with the balance.
 *
 * The variance becomes a ledger entry rather than an edit, so the balance still
 * equals the sum of its movements afterwards and the count is auditable as the
 * reason. Returns how many adjustments it wrote.
 *
 * `expected_quantity` on the line is what the counter saw. The adjustment is
 * computed against the CURRENT balance, because that is what has to end up
 * matching the shelf — but a line whose expected quantity has since moved is
 * reported through the returned count differing from the variance the reviewer
 * saw, rather than silently absorbing the movement.
 */
CREATE OR REPLACE FUNCTION crm.commit_sample_count(p_count_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  cnt        record;
  line       record;
  current_qty numeric(16,3);
  delta      numeric(16,3);
  written    integer := 0;
BEGIN
  SELECT * INTO cnt FROM crm.sample_count WHERE id = p_count_id FOR UPDATE;
  IF cnt IS NULL THEN
    RAISE EXCEPTION 'no sample count %', p_count_id USING ERRCODE = 'no_data_found';
  END IF;
  IF cnt.status <> 'open' THEN
    RAISE EXCEPTION 'sample count % is %, not open', p_count_id, cnt.status USING ERRCODE = 'check_violation';
  END IF;

  FOR line IN SELECT * FROM crm.sample_count_line WHERE count_id = p_count_id ORDER BY lot_id LOOP
    SELECT COALESCE(quantity_on_hand, 0) INTO current_qty
      FROM crm.sample_holding
     WHERE rep_profile_id = cnt.rep_profile_id AND lot_id = line.lot_id;
    current_qty := COALESCE(current_qty, 0);
    delta := line.counted_quantity - current_qty;

    IF delta <> 0 THEN
      INSERT INTO crm.sample_transaction (
        id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at
      ) VALUES (
        gen_random_uuid(), cnt.tenant_id, line.lot_id, cnt.rep_profile_id,
        CASE WHEN delta > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
        abs(delta),
        format('cycle count %s: counted %s, held %s', p_count_id, line.counted_quantity, current_qty),
        cnt.counted_at
      );
      written := written + 1;
    END IF;

    UPDATE crm.sample_holding SET last_counted_at = cnt.counted_at
     WHERE rep_profile_id = cnt.rep_profile_id AND lot_id = line.lot_id;
  END LOOP;

  UPDATE crm.sample_count SET status = 'committed', committed_at = now() WHERE id = p_count_id;
  RETURN written;
END
$$;

/**
 * Lots a rep still holds that have expired, or expire within `p_within_days`.
 *
 * The query a compliance screen runs and a nightly job acts on. Expired stock in a
 * rep's bag is the most common sample-audit finding there is, and the ERP cannot
 * express the question at all.
 */
CREATE OR REPLACE FUNCTION crm.expiring_sample_holdings(
  p_rep_profile_id uuid DEFAULT NULL,
  p_within_days    integer DEFAULT 60,
  p_as_of          date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id    uuid,
  lot_id            uuid,
  erp_item_id       text,
  lot_number        text,
  expiry_date       date,
  days_remaining    integer,
  quantity_on_hand  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT h.rep_profile_id, h.lot_id, l.erp_item_id::text, l.lot_number, l.expiry_date,
         (l.expiry_date - p_as_of)::integer, h.quantity_on_hand
    FROM crm.sample_holding h
    JOIN crm.sample_lot l ON l.id = h.lot_id
   WHERE h.quantity_on_hand > 0
     AND l.expiry_date IS NOT NULL
     AND l.expiry_date <= p_as_of + p_within_days
     AND (p_rep_profile_id IS NULL OR h.rep_profile_id = p_rep_profile_id)
   ORDER BY l.expiry_date, h.rep_profile_id;
$$;
