-- 0009_scheduler.sql
--
-- The CRM's own tenant registry and its scheduled-job table.
--
-- WHY A REGISTRY OF OUR OWN. The scheduler needs to know which tenants to work,
-- and it cannot ask the ERP: crm_app holds SELECT on exactly one ERP table
-- (meta.operate_entity_records) and nothing else. Widening that to read
-- meta.tenants would break the allow-list discipline this integration is built
-- on (ADR-0001 Q5) for the sake of a list we should own anyway — the CRM serves
-- a SUBSET of ERP tenants, and it needs per-tenant scheduling knobs the ERP has
-- no concept of.

-- Deliberately NOT under RLS, and deliberately holding no tenant data.
--
-- RLS here would be circular: reading which tenants exist would require already
-- having chosen one. This is the same exception crm._migrations takes, for the
-- same reason — it describes the deployment, not a tenant's records. It is
-- therefore restricted to ids, a display name and scheduling configuration.
-- Nothing a tenant would consider theirs belongs in this table.
CREATE TABLE crm.tenant (
  tenant_id     uuid PRIMARY KEY,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenant_status ON crm.tenant (status);

-- One row per (tenant, job). Tenant-scoped and under RLS like everything else:
-- the scheduler enumerates tenants from the registry above, then does every
-- other query inside withTenantContext. That costs one query per tenant instead
-- of one overall, which is the right trade for not having a second table that
-- opts out of isolation.
CREATE TABLE crm.scheduled_job (
  tenant_id      uuid NOT NULL,
  job            text NOT NULL
                   CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full')),

  interval_ms    integer NOT NULL CHECK (interval_ms >= 1000),
  enabled        boolean NOT NULL DEFAULT true,

  -- Advanced AT CLAIM TIME, so a second instance in the same window finds
  -- nothing due. There is no lease and no in-flight state: both jobs are
  -- idempotent, so a worker dying mid-run simply means the job runs again next
  -- window. That is self-healing, where a lease would need reclaiming.
  next_run_at    timestamptz NOT NULL DEFAULT now(),

  last_run_at    timestamptz,
  last_success_at timestamptz,
  last_status    text CHECK (last_status IS NULL OR last_status IN ('ok', 'error')),
  last_error     text,
  last_duration_ms integer,
  -- Consecutive failures, for backing a job off and for alerting. Reset on success.
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),

  PRIMARY KEY (tenant_id, job)
);

CREATE INDEX idx_scheduled_job_due ON crm.scheduled_job (tenant_id, next_run_at)
  WHERE enabled;

SELECT crm.apply_tenant_isolation('crm.scheduled_job');
