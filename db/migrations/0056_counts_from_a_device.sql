-- A count happens where the stock is, which is not where the network is.
--
-- The cycle count is the one custody document whose whole purpose is to be taken away from
-- a desk: a rep empties their bag and counts it, in a car park, a clinic corridor, a hotel
-- room. 0017 and 0018 built it as an interactive document — open it, record a line per lot,
-- commit — and that shape is right. What it could not do is happen offline, for three
-- reasons this migration and its store siblings fix.
--
-- 1. THE COUNT HAD NO DEVICE-MINTED ID. `crm.sample_count.id` defaults to
--    `gen_random_uuid()` and `openCount` never accepted one, so the id existed only after a
--    round trip — and `POST /v1/samples/counts/:id/lines` needs it in the path. A rep with
--    no signal could not start a count at all. Everything else in this schema that a device
--    records has had a device-minted id since 0012 and 0017 (a visit, a disbursement, a
--    transfer, a recall); the count was the exception, and nothing in it wanted to be. The
--    id column needs no change — this is a store and API change — but it is recorded here
--    because it is the reason the rest of this file exists.
--
-- 2. COMMITTING WAS NOT IDEMPOTENT, which an offline queue cannot live with.
--    `crm.commit_sample_count` raises `check_violation` on a count that is not `open`, so a
--    reply lost after the commit committed — a dropped connection, a dead tunnel, a phone
--    that slept — came back on retry as a 409. The client classifies a conflict as
--    permanent and correctly so, which means the rep is told their count was REFUSED while
--    the ledger holds the adjustments it wrote. The worst shape of failure available: the
--    screen and the database disagree, and the screen is the one the rep believes.
--
--    Made idempotent by answering the same question twice with the same number. A count
--    that is already committed returns how many adjustments it wrote rather than raising,
--    which needs those adjustments to be FINDABLE — hence (3). A `cancelled` count still
--    raises, because that is a real refusal rather than a repeat.
--
-- 3. AN ADJUSTMENT KNEW WHICH COUNT WROTE IT ONLY IN PROSE. The reason string reads
--    `cycle count <uuid>: counted 9, held 10`, which is the link written as text because
--    there was no column for it. Parsing it back is the kind of thing that works until a
--    message is reworded. `count_id` makes it structural, and the question an audit
--    actually asks — "which movements did this count produce?" — becomes a WHERE clause.
--    The reason string stays exactly as it was: it is what a person reads.
--
-- The FK is COMPOSITE — `(tenant_id, count_id)` — because 0035's rule has no exceptions and
-- `AWAITING_CONVERSION` in the composite-key guard is empty for a reason: a single-column
-- reference into a tenant-scoped table is stopped from naming another tenant's row by RLS
-- alone, and referential checks bypass RLS. An adjustment that could cite a count in
-- another tenant is exactly the shape that rule exists to forbid. (Written single-column
-- first, and the guard caught it within the hour.)
--
-- `ON DELETE RESTRICT`, like every other reference out of this ledger, and that is safe for
-- the erasure rather than in spite of it: `packages/erasure` derives its delete order from
-- the live FK graph (children before parents) and REFUSES a plan where a retained child
-- references an erased parent, naming the edge. So if a future register erases counts while
-- retaining the ledger, the plan says so loudly instead of failing mid-transaction. Neither
-- table is decided yet; both are among the 19 questions Compliance owes an answer to.

ALTER TABLE crm.sample_transaction ADD COLUMN count_id uuid;
ALTER TABLE crm.sample_transaction
  ADD CONSTRAINT sample_transaction_count_id_fkey
  FOREIGN KEY (tenant_id, count_id) REFERENCES crm.sample_count (tenant_id, id)
  ON DELETE RESTRICT;

-- Only an adjustment can come from a count. A disbursement or a transfer carrying one would
-- be a movement a count claims to have produced and did not.
ALTER TABLE crm.sample_transaction
  ADD CONSTRAINT sample_tx_count_only_adjustments
  CHECK (count_id IS NULL OR kind IN ('adjustment_in', 'adjustment_out'));

-- Partial, because almost every row is not an adjustment from a count, and the query this
-- serves always names one.
CREATE INDEX idx_sample_tx_count ON crm.sample_transaction (tenant_id, count_id)
  WHERE count_id IS NOT NULL;

/**
 * What the DEVICE showed the counter, when the counter was a device.
 *
 * `expected_quantity` is captured when the line is written, and 0017's comment says why:
 * "so the variance a reviewer sees is the one the counter saw". A count taken offline
 * breaks that sentence without touching it. The line reaches the server hours later, so the
 * balance it snapshots is the balance AT ARRIVAL — which may have moved, by this rep's own
 * queued disbursements going up ahead of it, or by a colleague's transfer being accepted in
 * between.
 *
 * So the device sends what it had on screen, and it lands in its own column rather than
 * over the server's figure. That ordering is deliberate: a client that could overwrite
 * `expected_quantity` could make any variance disappear from review — send expected equal
 * to counted and the ledger still writes the real adjustment, while the reviewer sees a
 * clean count. Two columns means a reviewer sees all three numbers (shown, held, counted)
 * and nobody can hide the gap between them.
 *
 * Null for a count taken at a desk, where the two would be the same number anyway.
 */
ALTER TABLE crm.sample_count_line
  ADD COLUMN device_expected_quantity numeric(16,3)
  CHECK (device_expected_quantity IS NULL OR device_expected_quantity >= 0);

/**
 * Commits a count: one adjustment per discrepancy, written through the ledger, linked to
 * the count that found it — and the same answer however many times it is asked.
 *
 * The arithmetic is 0018's and is unchanged: the delta is computed against the balance as
 * it stands NOW, not against the line's snapshot, so the balance after the commit equals
 * what was counted. That is what makes a count a reconciliation rather than an assertion.
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

  -- The replay. An offline client cannot tell a lost reply from a refusal, so committing
  -- twice has to mean what committing once meant: the same count of adjustments, taken from
  -- the rows the first commit linked to this count. Nothing is written the second time.
  IF cnt.status = 'committed' THEN
    SELECT count(*) INTO written FROM crm.sample_transaction WHERE count_id = p_count_id;
    RETURN written;
  END IF;

  -- A cancelled count is a genuine refusal and stays one: somebody abandoned this document,
  -- and committing it would resurrect findings they withdrew.
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
        id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at, count_id
      ) VALUES (
        gen_random_uuid(), cnt.tenant_id, line.lot_id, cnt.rep_profile_id,
        CASE WHEN delta > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
        abs(delta),
        format('cycle count %s: counted %s, held %s', p_count_id, line.counted_quantity, current_qty),
        cnt.counted_at,
        p_count_id
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

COMMENT ON COLUMN crm.sample_transaction.count_id IS
  'The cycle count that produced this adjustment, when one did. Structural rather than parsed out of the reason string, and what makes a repeated commit answerable with the same number.';
