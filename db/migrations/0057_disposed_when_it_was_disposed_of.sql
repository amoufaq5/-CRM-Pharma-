-- An obligation was recorded as resolved on the day the SWEEP noticed, not the day the
-- material actually left.
--
-- THE DEFECT. `sweepExpiredStock` closes an obligation whose holding has reached zero, and
-- it attributes the resolution from the ledger rather than from a claim —
-- `crm.disposal_resolving_movement` returns the last decreasing movement on that (rep, lot)
-- since the obligation was discovered, which is 0020's own rule and a good one. But it then
-- writes `resolved_on = today`: the sweep's clock. The movement is right there, in hand,
-- carrying the date it happened, and the one field that records WHEN a regulated disposal
-- took place is filled in from when a cron job next ran.
--
-- A rep with a seven-day grace period who destroys expired stock on day three, swept on day
-- nine — a weekend, a paused scheduler, a failed run, a device that synced late — has that
-- disposal recorded as two days overdue. It was four days early. The manager's exposure
-- view, any audit of lateness, and `days_overdue` on the obligation all read the wrong
-- fact, and nothing in the record contradicts it: the ledger says the third and the
-- obligation says the ninth.
--
-- Writing this now because the field client is about to make the gap wider on purpose. A
-- write-off recorded on a device with no signal carries the moment the rep did it and may
-- not reach the server for days, so "when the sweep noticed" and "when it happened" stop
-- being nearly the same date.
--
-- THE FIX is the sweep's own reasoning about attribution, applied to the date as well: the
-- movement is exact where re-deriving is inference (the auto-write-off path says so in as
-- many words). So the function returns the movement's `occurred_at::date` and the sweep
-- uses it. The auto-write-off path is unaffected in value — it writes its movement with the
-- sweep's own clock — but it now reads the date from the same place, so there is one answer
-- to "when was this disposed of" rather than two.
--
-- BOUNDED BY THE SWEEP'S DATE, deliberately. A device clock running fast could otherwise
-- date a disposal next week, and a compliance record claiming material was destroyed in the
-- future is worse than one that is a few hours coarse. The movement keeps whatever
-- `occurred_at` it was given — the ledger is append-only and not this migration's business —
-- but the obligation cannot claim to have been resolved after it was observed.
--
-- The lower bound needs no clamp: the function already requires
-- `occurred_at >= discovered_on`, so a resolution cannot predate the discovery of what it
-- resolves.

-- A function's RETURNS TABLE cannot be widened in place, and nothing depends on this one
-- but the sweep and a test that selects two of its columns by name.
DROP FUNCTION IF EXISTS crm.disposal_resolving_movement(uuid, uuid, date);

/**
 * The movement that discharged an obligation, attributed from the ledger — with the date it
 * happened.
 *
 * The sweep sees a holding at zero and has to say HOW and WHEN. Rather than trusting
 * whoever resolved it to declare either, it reads the last decreasing movement on that
 * (rep, lot) at or after the obligation was discovered. The answer is therefore the
 * ledger's, not a claim about the ledger — which is the distinction an audit cares about.
 *
 * Returns nothing when no such movement exists, which the caller treats as "cannot
 * attribute" rather than inventing one.
 */
CREATE OR REPLACE FUNCTION crm.disposal_resolving_movement(
  p_rep_profile_id uuid,
  p_lot_id         uuid,
  p_since          date
)
RETURNS TABLE (transaction_id uuid, kind text, resolution text, occurred_on date)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.kind,
         CASE t.kind
           WHEN 'destruction'         THEN 'destroyed'
           WHEN 'return_to_warehouse' THEN 'returned'
           WHEN 'expiry_writeoff'     THEN 'written_off'
           WHEN 'transfer_out'        THEN 'transferred'
           WHEN 'adjustment_out'      THEN 'adjusted'
         END,
         t.occurred_at::date
    FROM crm.sample_transaction t
   WHERE t.rep_profile_id = p_rep_profile_id
     AND t.lot_id = p_lot_id
     AND crm.sample_effect(t.kind) < 0
     AND t.occurred_at >= p_since::timestamptz
   ORDER BY t.occurred_at DESC, t.recorded_at DESC
   LIMIT 1;
$$;

COMMENT ON FUNCTION crm.disposal_resolving_movement(uuid, uuid, date) IS
  'The last decreasing movement that explains a cleared holding, with its own date — so an obligation is recorded as resolved when the material left, not when the sweep next ran.';
