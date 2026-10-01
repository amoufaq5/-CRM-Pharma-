-- 0017_sample_custody.sql
--
-- Drug sample and promotional material custody. The regulatory obligation the
-- CRM takes on because the ERP cannot discharge it (report R3, ADR-0001 Q4).
--
-- WHY HERE AND NOT IN THE ERP. You can model a rep as a `Warehouse` with
-- `warehouse_type: "virtual"` today, and `StockLevel`/`StockMovement` will accept
-- the rows. What you do not get, from the report's own audit of that path:
--
--   - no lot, no expiry, no serial — so "was this in date when it was handed
--     over" is unanswerable, which is the central question in a sample audit;
--   - nothing keeps `StockLevel` and `StockMovement` consistent. Grepping the ERP
--     for `quantity_on_hand` outside the pack declaration returns zero hits:
--     posting a movement does not change a level. Both are hand-maintained from
--     outside, non-atomically;
--   - no Warehouse-to-Employee link, so custody is a string in a `code` field
--     reconciled by eye;
--   - no linked transfer with in-transit and acceptance — two unrelated rows;
--   - no distinction between saleable stock, promo material and regulated drug
--     samples: `item_type` has no sample value;
--   - no acknowledgement on hand-over, and no count document.
--
-- Every one of those is a thing a regulator asks for. So the CRM owns custody
-- end-to-end and mirrors only the AGGREGATE movement to the ERP when material
-- physically leaves ERP-controlled stock — a `StockMovement` of type `issue`,
-- enqueued through the outbox like every other ERP write. The ERP learns that ten
-- boxes left the warehouse; the lot, the expiry and the name of the doctor who
-- signed for them live here, because there is nowhere there to put them.

CREATE TABLE crm.sample_lot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,

  -- The ERP Item this lot is of. No FK (ADR-0001 item 3); the product snapshot
  -- carries the name and strength for display.
  erp_item_id     crm.erp_record_id NOT NULL,

  lot_number      text NOT NULL CHECK (length(lot_number) BETWEEN 1 AND 64),
  expiry_date     date,

  -- The distinction the ERP's `item_type` cannot express, and it is not cosmetic:
  -- a drug sample is accountable unit by unit and a pen is not.
  material_kind   text NOT NULL
                    CHECK (material_kind IN ('drug_sample', 'promo_material')),
  -- Controlled substances carry stricter obligations than this schema yet
  -- discharges (unit-level serial custody). Flagged so the gap is visible in the
  -- data rather than only in a document.
  controlled      boolean NOT NULL DEFAULT false,

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'quarantined', 'withdrawn')),
  status_reason   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, erp_item_id, lot_number),

  -- A drug sample with no expiry is not accountable. Lot tracking exists to
  -- answer "was it in date"; a null there makes the answer "we cannot say",
  -- which in an audit is the same as "no".
  CONSTRAINT sample_lot_drug_needs_expiry
    CHECK (material_kind <> 'drug_sample' OR expiry_date IS NOT NULL),
  CONSTRAINT sample_lot_status_reason
    CHECK (status = 'active' OR status_reason IS NOT NULL)
);

CREATE INDEX idx_sample_lot_item   ON crm.sample_lot (tenant_id, erp_item_id);
CREATE INDEX idx_sample_lot_expiry ON crm.sample_lot (tenant_id, expiry_date)
  WHERE status = 'active';

SELECT crm.apply_tenant_isolation('crm.sample_lot');

-- ---------------------------------------------------------------------------
-- The balance. One row per (rep, lot), maintained ONLY by the trigger in 0018.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.sample_holding (
  tenant_id            uuid NOT NULL,
  rep_profile_id       uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  lot_id               uuid NOT NULL REFERENCES crm.sample_lot (id) ON DELETE RESTRICT,

  -- Physically in the rep's bag.
  quantity_on_hand     numeric(16,3) NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  -- Handed to another rep and not yet accepted. Still THIS rep's responsibility:
  -- material in transit must be accounted for somewhere, and the ERP's unlinked
  -- transfer_out/transfer_in pair is exactly how it stops being.
  quantity_in_transit  numeric(16,3) NOT NULL DEFAULT 0 CHECK (quantity_in_transit >= 0),

  last_movement_at     timestamptz,
  last_counted_at      timestamptz,

  PRIMARY KEY (rep_profile_id, lot_id)
);

-- The >= 0 CHECKs above are the accountability guarantee, not a nicety: a
-- disbursement of more than is held fails the transaction rather than being
-- recorded. 0018 raises a readable error first; this is the backstop that holds
-- even if a future code path forgets to ask.

CREATE INDEX idx_sample_holding_lot ON crm.sample_holding (tenant_id, lot_id);
CREATE INDEX idx_sample_holding_nonzero ON crm.sample_holding (tenant_id, rep_profile_id)
  WHERE quantity_on_hand > 0 OR quantity_in_transit > 0;

SELECT crm.apply_tenant_isolation('crm.sample_holding');

-- ---------------------------------------------------------------------------
-- The ledger. Append-only; 0018 refuses UPDATE and DELETE.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.sample_transaction (
  -- Device-minted, like a visit (0012). A disbursement happens at a clinic desk
  -- with no signal, and a retried sync must collapse into the same row rather
  -- than hand the doctor's samples out twice in the record.
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,

  lot_id            uuid NOT NULL REFERENCES crm.sample_lot (id) ON DELETE RESTRICT,
  -- Whose balance this row moves. For a transfer_in, the ACCEPTING rep.
  rep_profile_id    uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  -- Nine kinds, each with one unambiguous direction. A single `adjustment` kind
  -- with a signed quantity was the alternative and is worse: every reader then has
  -- to remember which sign means which way, and one that remembers wrong corrupts
  -- a balance silently. `crm.sample_effect` in 0018 is the single place direction
  -- is decided.
  kind              text NOT NULL CHECK (kind IN (
                      'receipt',             -- + from ERP-controlled stock
                      'transfer_in',         -- + accepted from another rep
                      'adjustment_in',       -- + count variance upward
                      'disbursement',        -- - handed to an HCP
                      'transfer_out',        -- - sent to another rep (to in_transit)
                      'return_to_warehouse', -- - back into ERP stock
                      'destruction',         -- - witnessed destruction
                      'expiry_writeoff',     -- - written off as expired
                      'adjustment_out'       -- - count variance downward
                    )),

  -- Always positive. The sign comes from `kind`.
  quantity          numeric(16,3) NOT NULL CHECK (quantity > 0),

  -- Disbursement: who received it.
  erp_account_id    crm.erp_record_id,
  erp_contact_id    crm.erp_record_id,
  visit_id          uuid REFERENCES crm.visit (id) ON DELETE RESTRICT,
  recipient_name    text,
  -- The sha256 of the signature captured on the device.
  --
  -- There is no file storage in this system yet (report §13: no attachment
  -- runtime), so the image itself has nowhere to live. The hash commits to it:
  -- when object storage arrives the blob can be attached and verified against
  -- this, and until then the record says a signature was taken and fixes which
  -- one. That is weaker than holding the image and stronger than a boolean.
  signature_sha256  text CHECK (signature_sha256 IS NULL OR signature_sha256 ~ '^[0-9a-f]{64}$'),

  -- Receipt / return: which ERP warehouse the material came from or went back to.
  -- This is what the mirrored StockMovement is posted against.
  erp_warehouse_id  crm.erp_record_id,

  -- Transfer: the other rep. Sender on a transfer_in, recipient on a transfer_out.
  counterparty_rep_profile_id uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  -- A transfer_in names the transfer_out it accepts, which is what makes the pair
  -- a linked transfer rather than two rows that happen to agree.
  transfer_of       uuid REFERENCES crm.sample_transaction (id) ON DELETE RESTRICT,

  reason            text,

  -- Two clocks, as for a visit. `occurred_at` is when custody actually changed;
  -- `recorded_at` is when we heard. An expiry check must use the first.
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sample_tx_disbursement_fields CHECK (
    kind <> 'disbursement' OR (
      erp_account_id IS NOT NULL
      AND recipient_name IS NOT NULL AND length(recipient_name) BETWEEN 1 AND 200
      AND signature_sha256 IS NOT NULL
    )
  ),
  CONSTRAINT sample_tx_warehouse_fields CHECK (
    kind NOT IN ('receipt', 'return_to_warehouse') OR erp_warehouse_id IS NOT NULL
  ),
  CONSTRAINT sample_tx_transfer_out_fields CHECK (
    kind <> 'transfer_out' OR (
      counterparty_rep_profile_id IS NOT NULL
      AND counterparty_rep_profile_id <> rep_profile_id
      AND transfer_of IS NULL
    )
  ),
  CONSTRAINT sample_tx_transfer_in_fields CHECK (
    kind <> 'transfer_in' OR (
      counterparty_rep_profile_id IS NOT NULL
      AND counterparty_rep_profile_id <> rep_profile_id
      AND transfer_of IS NOT NULL
    )
  ),
  -- A quantity that moved for no recorded reason is the one an audit asks about.
  CONSTRAINT sample_tx_reason_required CHECK (
    kind NOT IN ('adjustment_in', 'adjustment_out', 'destruction', 'expiry_writeoff')
    OR (reason IS NOT NULL AND length(reason) BETWEEN 1 AND 500)
  ),
  -- Only a disbursement has a recipient. A signature on a write-off would be
  -- evidence of nothing.
  CONSTRAINT sample_tx_recipient_only_on_disbursement CHECK (
    kind = 'disbursement' OR (recipient_name IS NULL AND signature_sha256 IS NULL AND visit_id IS NULL)
  )
);

CREATE INDEX idx_sample_tx_rep_lot  ON crm.sample_transaction (tenant_id, rep_profile_id, lot_id, occurred_at DESC);
CREATE INDEX idx_sample_tx_account  ON crm.sample_transaction (tenant_id, erp_account_id, occurred_at DESC)
  WHERE kind = 'disbursement';
CREATE INDEX idx_sample_tx_lot      ON crm.sample_transaction (tenant_id, lot_id, occurred_at);
CREATE INDEX idx_sample_tx_visit    ON crm.sample_transaction (tenant_id, visit_id) WHERE visit_id IS NOT NULL;
-- An outstanding transfer_out: one row, not yet accepted. The query a "where is
-- my material" screen runs.
CREATE UNIQUE INDEX uq_sample_tx_transfer_accepted
  ON crm.sample_transaction (transfer_of) WHERE transfer_of IS NOT NULL;

SELECT crm.apply_tenant_isolation('crm.sample_transaction');

-- ---------------------------------------------------------------------------
-- The count document. The ERP has `StockLevel.last_counted_at` — a bare
-- timestamp with nothing behind it. A reconciliation nobody can review is not a
-- reconciliation, so the count is a document with lines, and committing it writes
-- adjustment transactions for the variances rather than editing the balance.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.sample_count (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,

  rep_profile_id  uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  -- Who performed the count. May be the rep themself for a self-count, or a
  -- manager for a supervised one — recorded either way, so the difference is
  -- visible to whoever reviews it.
  counted_by      uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'committed', 'cancelled')),

  counted_at      timestamptz NOT NULL,
  committed_at    timestamptz,
  note            text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sample_count_committed_pair
    CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);

CREATE INDEX idx_sample_count_rep ON crm.sample_count (tenant_id, rep_profile_id, counted_at DESC);
CREATE UNIQUE INDEX uq_sample_count_one_open
  ON crm.sample_count (tenant_id, rep_profile_id) WHERE status = 'open';

SELECT crm.apply_tenant_isolation('crm.sample_count');

CREATE TABLE crm.sample_count_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  count_id           uuid NOT NULL REFERENCES crm.sample_count (id) ON DELETE CASCADE,
  lot_id             uuid NOT NULL REFERENCES crm.sample_lot (id) ON DELETE RESTRICT,

  counted_quantity   numeric(16,3) NOT NULL CHECK (counted_quantity >= 0),
  -- The balance at the moment the line was written, so the variance a reviewer
  -- sees is the one the counter saw. Recomputing it at commit time would silently
  -- absorb any movement in between.
  expected_quantity  numeric(16,3) NOT NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (count_id, lot_id)
);

SELECT crm.apply_tenant_isolation('crm.sample_count_line');
