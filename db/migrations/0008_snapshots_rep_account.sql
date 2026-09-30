-- 0008_snapshots_rep_account.sql
--
-- The remaining snapshot tables, plus the bookkeeping incremental refresh needs.
--
-- These are the CRM's READ PATH (ADR-0001 item 8), not a cache: the deployed ERP
-- compares every filter and sort as text, so a numeric query against it is wrong
-- rather than merely slow, and we cannot add an index to
-- meta.operate_entity_records without owning it. Typed columns here are the
-- answer to both.

CREATE TABLE crm.rep_snapshot (
  tenant_id        uuid NOT NULL,
  erp_employee_id  crm.erp_record_id NOT NULL,

  employee_number  text NOT NULL,
  given_name       text,
  family_name      text,
  work_email       text,
  department_id    crm.erp_record_id,
  manager_id       crm.erp_record_id,
  position_id      crm.erp_record_id,
  status           text,
  employment_type  text,
  hire_date        date,

  erp_updated_at   timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  -- Stamped by each full sweep. A row whose token does not match the sweep that
  -- just finished no longer exists at the ERP — see the note on deletions below.
  sync_token       uuid,

  PRIMARY KEY (tenant_id, erp_employee_id)
);

CREATE INDEX idx_rep_snapshot_number  ON crm.rep_snapshot (tenant_id, employee_number);
CREATE INDEX idx_rep_snapshot_status  ON crm.rep_snapshot (tenant_id, status);
CREATE INDEX idx_rep_snapshot_updated ON crm.rep_snapshot (tenant_id, erp_updated_at);

SELECT crm.apply_tenant_isolation('crm.rep_snapshot');

CREATE TABLE crm.account_snapshot (
  tenant_id      uuid NOT NULL,
  erp_account_id crm.erp_record_id NOT NULL,

  name           text NOT NULL,
  legal_name     text,
  status         text,
  industry       text,
  billing_email  text,
  country        char(2),

  erp_updated_at timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  sync_token     uuid,

  PRIMARY KEY (tenant_id, erp_account_id)
);

CREATE INDEX idx_account_snapshot_name    ON crm.account_snapshot (tenant_id, name);
CREATE INDEX idx_account_snapshot_status  ON crm.account_snapshot (tenant_id, status);
CREATE INDEX idx_account_snapshot_updated ON crm.account_snapshot (tenant_id, erp_updated_at);

SELECT crm.apply_tenant_isolation('crm.account_snapshot');

-- product_snapshot predates the sweep mechanism; bring it in line.
ALTER TABLE crm.product_snapshot ADD COLUMN IF NOT EXISTS sync_token uuid;

-- ---------------------------------------------------------------------------
-- Incremental refresh bookkeeping.
--
-- high_water_mark is the newest erp_updated_at fully drained, and the resume
-- point after a restart. It is TEXT, holding the ERP's own ISO-8601 string
-- verbatim rather than a parsed timestamptz, because it is fed straight back
-- into ?updated_at[gte]= and a round trip through Postgres's timestamp
-- formatting could shift the microseconds and skip a record.
--
-- ON DELETIONS. The ERP emits no tombstones: pack-erp-core entities declare only
-- the `auditable` trait, not `soft_deletable`, so a deleted record simply stops
-- being returned. Polling by updated_at can therefore NEVER observe a deletion,
-- and an incrementally-refreshed snapshot accumulates ghosts indefinitely.
-- Only a full sweep can reconcile: it stamps every row it sees with a fresh
-- sync_token, then deletes the rows still carrying an older one.
-- last_full_sweep_at records when that last happened, so a snapshot that has
-- only ever been refreshed incrementally is visible as such rather than assumed
-- correct.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.snapshot_freshness ADD COLUMN IF NOT EXISTS high_water_mark    text;
ALTER TABLE crm.snapshot_freshness ADD COLUMN IF NOT EXISTS last_full_sweep_at timestamptz;
ALTER TABLE crm.snapshot_freshness ADD COLUMN IF NOT EXISTS rows_deleted       bigint NOT NULL DEFAULT 0;
