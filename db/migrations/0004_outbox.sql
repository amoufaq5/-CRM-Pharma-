-- 0004_outbox.sql
--
-- ADR-0001 items 5 and 6. A rep action commits to crm.* and appends here in ONE
-- transaction; a relay drains this table and calls the ERP's HTTP API, so every
-- ERP invariant still runs (RBAC, write-guards, period locks, GL write-effects,
-- sequences, audit). The CRM never writes ERP tables over SQL.
--
-- target_record_id is minted HERE, deterministically, and sent as the record's
-- `id`. The ERP's resolveRecordId accepts a client-supplied id matching
-- ^[A-Za-z0-9_-]{1,200}$, and every entity is unique on
-- (tenant_id, entity, record_id). That unique constraint — a durable database
-- guarantee — is what makes redelivery safe, NOT the ERP's Idempotency-Key
-- store, which is in-memory in the deployed binary, dies on restart and does not
-- span instances (report R6). A unique violation on replay is SUCCESS.

CREATE TABLE crm.outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,

  -- What to do at the ERP. `entity` is an ERP entity name; `operation` is either
  -- a CRUD verb or a lifecycle transition name.
  entity             text NOT NULL,
  operation          text NOT NULL,
  payload            jsonb NOT NULL,

  -- The id we will hand the ERP (create) or address (transition/update).
  target_record_id   crm.erp_record_id NOT NULL,

  -- Correlates back to the CRM aggregate that produced this, for support.
  source_table       text NOT NULL,
  source_id          uuid NOT NULL,

  state              text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,

  -- An outbox row is itself idempotent: the same logical intent enqueued twice
  -- collapses. Without this a double-tap in the mobile app becomes two ERP writes
  -- with two different target ids, which no downstream constraint would catch.
  UNIQUE (tenant_id, entity, operation, target_record_id)
);

-- The relay's claim query: due pending work, oldest first.
CREATE INDEX idx_outbox_due ON crm.outbox (tenant_id, next_attempt_at)
  WHERE state IN ('pending', 'in_flight');
CREATE INDEX idx_outbox_dead ON crm.outbox (tenant_id) WHERE state = 'dead';

SELECT crm.apply_tenant_isolation('crm.outbox');
