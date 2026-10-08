-- A transfer the receiver cannot find is a transfer nobody accepts.
--
-- 0025 gave the SENDER a scoped list: `crm.recallable_transfers(rep)` answers "what did I
-- send that nobody has taken yet", named, with the lot and its expiry, so the recall button
-- has something to act on. The RECEIVER got nothing equivalent. Their half of the same
-- transfer was reachable only through `outstandingTransfers`, which returns raw
-- `crm.sample_transaction` rows for EITHER side — ids, no names, no lot number, no expiry —
-- and through the `sample_transfer_awaiting_acceptance` notification, which is a message
-- rather than a work list.
--
-- So a rep whose colleague handed them material had no screen that could say "Grace sent you
-- 4 of LOT-FIELD-1, expiring in a year — accept it?", and `POST /v1/samples/transfers/:id/accept`
-- needs that transfer's id. The material sits in the sender's `quantity_in_transit`
-- indefinitely, which is the open end 0025 closed for the sender and left open here.
--
-- THE SCOPING IS IN THE SQL, for the reason 0025 states about its mirror image: only the
-- receiver may accept, so a list that offered the action for a transfer the caller SENT would
-- be a button the database refuses (0018's `sample_tx_transfer_in_fields` and the acceptance
-- trigger check that the two reps are the sender and recipient of the row being accepted,
-- the right way round). Scoping after the fact, in a route, is one forgotten `AND` away from
-- offering a rep somebody else's work.
--
-- Deliberately the same columns as `recallable_transfers`, renamed for the direction
-- (`sent_by`/`sent_by_name` against its `sent_to`/`sent_to_name`). Two functions that are
-- mirror images are easier to keep honest than one function with a direction flag, and the
-- flag would have to be trusted by every caller.
--
-- `days_in_transit` is carried for both sides because it is the number that makes an
-- unaccepted transfer actionable: it is the sender's cue to recall and the receiver's cue
-- that they are holding up somebody's balance.

CREATE OR REPLACE FUNCTION crm.incoming_transfers(p_rep_profile_id uuid)
RETURNS TABLE (
  transaction_id   uuid,
  lot_id           uuid,
  lot_number       text,
  erp_item_id      text,
  expiry_date      date,
  quantity         numeric,
  sent_by          uuid,
  sent_by_name     text,
  occurred_at      timestamptz,
  days_in_transit  integer
)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.lot_id, l.lot_number, l.erp_item_id::text, l.expiry_date, t.quantity,
         t.rep_profile_id, rp.display_name, t.occurred_at,
         (CURRENT_DATE - t.occurred_at::date)::integer
    FROM crm.sample_transaction t
    JOIN crm.sample_lot l ON l.id = t.lot_id
    JOIN crm.rep_profile rp ON rp.id = t.rep_profile_id
   WHERE t.kind = 'transfer_out'
     AND t.counterparty_rep_profile_id = p_rep_profile_id
     AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction x WHERE x.transfer_of = t.id)
   ORDER BY t.occurred_at;
$$;

COMMENT ON FUNCTION crm.incoming_transfers(uuid) IS
  'Transfers sent TO this rep that nobody has accepted or recalled yet — the list an accept acts on. The mirror of crm.recallable_transfers.';
