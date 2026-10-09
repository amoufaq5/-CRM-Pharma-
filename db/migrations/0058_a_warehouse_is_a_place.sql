-- The CRM had no idea what a warehouse was, and a return had to guess.
--
-- `crm.sample_transaction.erp_warehouse_id` has been an opaque text id since 0017: a
-- `crm.erp_record_id` with a shape check and nothing behind it. Nothing could say whether
-- a given id was a warehouse, whether it was open, or what it was called. Two consequences
-- followed, and both reached a rep:
--
-- 1. MATERIAL RECEIVED FROM A COLLEAGUE COULD NOT BE RETURNED AT ALL. The device addresses
--    a return off `last_received_from` — the warehouse this rep last received THIS lot from
--    — because that was the only non-fabricated answer available. A lot that arrived by
--    transfer has no such receipt, so the field client's return form says, in as many
--    words, that it does not know where the material came from and offers the write-off
--    instead. A write-off destroys stock that a depot could have put back on a shelf.
--    ADR-0001 recorded it as the gap a warehouse list would close.
--
-- 2. AN INVENTED ID WAS ACCEPTED AND FAILED HOURS LATER. `POST /v1/samples/receipts` takes
--    the warehouse from the client, and every id matching `^[A-Za-z0-9_-]{1,200}$` was
--    equally acceptable. The movement was written, the mirrored `StockMovement` was
--    enqueued, and the ERP refused it from inside the relay queue — where the rep who typed
--    it is no longer standing, and where the only remedy is a dead letter somebody must
--    notice. Worse than refusing it: an id that is real but belongs to another site is
--    accepted by the ERP and posted against the wrong warehouse's balance.
--
-- So: a fourth snapshot, built exactly like the other three (0005, 0008). `Warehouse` is
-- a pack-erp-core entity served at `/v1/warehouses`, with code, name, type, city, country
-- and status, and the ERP is authoritative about every one of those. Nothing here is
-- writable by the CRM; a full rebuild is one command; a row is a mirror of somebody else's
-- record.
--
-- WHY THIS IS NOT A FOREIGN KEY, which is the first thing to reach for and would be wrong.
-- A snapshot is a cache of another system's truth, and a full sweep DELETES the rows that
-- vanished at the ERP (`deleteStale`, 0008) — that is the only mechanism by which a
-- deletion ever reaches the CRM, because the ERP emits no tombstones. A composite FK from
-- the append-only ledger into this table would make the sweep fail the moment a warehouse
-- is closed and removed upstream: `ON DELETE RESTRICT` pins the snapshot row forever and
-- the refresh breaks, `CASCADE` would delete custody history, and `SET NULL` would violate
-- `sample_tx_warehouse_fields`. The ledger must not depend referentially on a table whose
-- contents another system can retract.
--
-- The rule therefore lives where the write happens — `requireActiveWarehouse`, called by
-- the receipt and the return — and it is a check AT THE MOMENT OF THE WRITE, not an
-- invariant over history. A movement keeps the warehouse it was posted against even after
-- that warehouse closes, because the movement happened. That is the same reasoning 0017
-- applies to a lot: what the record says is what was true then.
--
-- `status` IS CARRIED AND USED. The ERP declares `active | inactive | closed`, and a return
-- addressed to a closed depot is a lorry sent to a locked gate. Only `active` is offered
-- and only `active` is accepted — but the SET of acceptable values is the snapshot's, not a
-- hard-coded list, so a status the ERP adds later reads as "not active" rather than as a
-- crash.

CREATE TABLE crm.warehouse_snapshot (
  tenant_id         uuid NOT NULL,
  erp_warehouse_id  crm.erp_record_id NOT NULL,

  -- `code` is what a human calls a depot and what appears on paperwork; `name` is the long
  -- form. Both are NOT NULL at the ERP, so both are here, and a picker shows the code.
  code              text NOT NULL,
  name              text NOT NULL,
  warehouse_type    text,
  address_line1     text,
  city              text,
  country           char(2),
  status            text,

  erp_updated_at    timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  sync_token        uuid,

  PRIMARY KEY (tenant_id, erp_warehouse_id)
);

-- `code` is how a rep recognises a depot and how `?q=` searches; `status` filters the
-- picker down to the ones a return may be addressed to; `erp_updated_at` serves the
-- incremental refresh, as on every other snapshot.
CREATE INDEX idx_warehouse_snapshot_code    ON crm.warehouse_snapshot (tenant_id, code);
CREATE INDEX idx_warehouse_snapshot_status  ON crm.warehouse_snapshot (tenant_id, status);
CREATE INDEX idx_warehouse_snapshot_updated ON crm.warehouse_snapshot (tenant_id, erp_updated_at);

SELECT crm.apply_tenant_isolation('crm.warehouse_snapshot');

COMMENT ON TABLE crm.warehouse_snapshot IS
  'Mirror of the ERP''s Warehouse entity. Derived, never authoritative: it is what lets a return name a destination, and what stops a receipt naming one that does not exist.';
COMMENT ON COLUMN crm.warehouse_snapshot.status IS
  'The ERP''s own status. Only an active warehouse is offered as a return destination or accepted as one; anything else — including a value the ERP adds later — is not active.';

-- ---------------------------------------------------------------------------
-- The retention decision, which arrives with the table or not at all.
--
-- 0051's register governs every tenant-scoped table in `crm`, and its completeness guard
-- treats SILENCE as a refusal: a table with no row makes a stopped tenant's erasure plan
-- unactionable and names the table. That guard went red the moment this file created the
-- snapshot, which is the guard working — a new tenant-scoped table is a new retention
-- question, and the only wrong answer is not noticing there is one.
--
-- `erase`, with the same reasoning 0051 gives for the other three snapshots: this is a copy
-- of ERP master data we were only ever a cache for. When a tenant is gone from the ERP, its
-- warehouse list has no source left to be a cache of, and keeping a dead tenant's depot
-- addresses serves nobody. No obligation, because there is nothing to weigh: the custody
-- ledger that CITES a warehouse is governed by its own row, and that row is the one that
-- decides whether the history is kept.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('warehouse_snapshot', 'erase', NULL, NULL, NULL, NULL, 'crm:0058', now())
ON CONFLICT (table_name) DO NOTHING;
