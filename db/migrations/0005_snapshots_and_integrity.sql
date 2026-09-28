-- 0005_snapshots_and_integrity.sql
--
-- ADR-0001 item 8. These are the CRM's READ PATH, not a cache optimisation, and
-- the reason is a defect rather than a preference (report R19):
--
--   The deployed ERP runs --store pg. Its list SQL emits `document ->> 'field'`
--   with NO cast (entity-ops.ts:43-47), so every filter and sort is a TEXT
--   comparison. Verified live on Postgres 16.13:
--       ?total[gte]=1000  ->  returns {1000, 999}
--       the same as numeric ->  returns {1000}
--   A money filter silently returns a record below the threshold, and ?sort
--   orders 100, 20, 9 while the keyset cursor paginates that wrong order
--   consistently rather than erroring.
--
--   Nor can we index our way out: meta.operate_entity_records carries only
--   (tenant_id, entity) and the unique key, with no GIN on document, and adding
--   one would require OWNING that table — exactly what breaks RLS (R16).
--
-- So: typed columns here, and every numeric filter, sort and aggregation in the
-- product reads these tables. They stay DERIVED and never authoritative — no
-- user writes one, every row carries the ERP id and its updated_at, and a full
-- rebuild is one command.

CREATE TABLE crm.product_snapshot (
  tenant_id        uuid NOT NULL,
  erp_item_id      crm.erp_record_id NOT NULL,

  sku              text NOT NULL,
  name             text NOT NULL,
  item_type        text,
  unit_of_measure  text,
  category         text,
  barcode          text,

  -- Typed, which is the whole point.
  list_price       numeric(14,2),
  standard_cost    numeric(14,4),
  currency         char(3),
  reorder_point    numeric(14,3),
  status           text,

  -- Provenance. erp_updated_at drives the incremental refresh
  -- (?updated_at[gte]=), and ISO-8601 is safe under the ERP's text comparison
  -- because lexicographic order equals chronological order for that format.
  erp_updated_at   timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, erp_item_id)
);

CREATE INDEX idx_product_snapshot_sku      ON crm.product_snapshot (tenant_id, sku);
CREATE INDEX idx_product_snapshot_status   ON crm.product_snapshot (tenant_id, status);
CREATE INDEX idx_product_snapshot_price    ON crm.product_snapshot (tenant_id, list_price);
CREATE INDEX idx_product_snapshot_updated  ON crm.product_snapshot (tenant_id, erp_updated_at);

SELECT crm.apply_tenant_isolation('crm.product_snapshot');

-- How stale each snapshot is allowed to be before the UI stops warning and
-- starts blocking. One row per snapshot table; read by the ACL and surfaced as
-- "as of" wherever a snapshot value drives a decision.
CREATE TABLE crm.snapshot_freshness (
  tenant_id            uuid NOT NULL,
  snapshot             text NOT NULL,
  last_refresh_at      timestamptz,
  last_success_at      timestamptz,
  rows_synced          bigint NOT NULL DEFAULT 0,
  warn_after_seconds   integer NOT NULL DEFAULT 3600   CHECK (warn_after_seconds  > 0),
  block_after_seconds  integer NOT NULL DEFAULT 86400  CHECK (block_after_seconds > 0),
  last_error           text,
  PRIMARY KEY (tenant_id, snapshot),
  CHECK (block_after_seconds >= warn_after_seconds)
);

SELECT crm.apply_tenant_isolation('crm.snapshot_freshness');

-- ADR-0001 item 3. With no foreign keys available, integrity is enforced by the
-- ACL on write and DETECTED here. This job reports; it never auto-heals, because
-- an orphan means either an ERP deletion we should have been told about or an
-- ACL bug, and both want a human.
CREATE TABLE crm.referential_check_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  ran_at         timestamptz NOT NULL DEFAULT now(),
  source_table   text NOT NULL,
  source_column  text NOT NULL,
  erp_entity     text NOT NULL,
  checked_count  bigint NOT NULL,
  orphan_count   bigint NOT NULL,
  orphan_sample  jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (orphan_count >= 0 AND checked_count >= orphan_count)
);

CREATE INDEX idx_referential_check_orphans ON crm.referential_check_run (tenant_id, ran_at DESC)
  WHERE orphan_count > 0;

SELECT crm.apply_tenant_isolation('crm.referential_check_run');
