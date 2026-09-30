-- 0007_outbox_lease.sql
--
-- Lease bookkeeping for the relay.
--
-- Without `claimed_at`, a worker that dies mid-dispatch leaves its rows in
-- `in_flight` forever: no other worker will touch them (they are not `pending`)
-- and nothing ever times them out. The row is not lost, it is just permanently
-- invisible, which is the worst of both — the claim looks successful and the
-- write never lands.

ALTER TABLE crm.outbox ADD COLUMN IF NOT EXISTS claimed_at  timestamptz;
ALTER TABLE crm.outbox ADD COLUMN IF NOT EXISTS claimed_by  text;
ALTER TABLE crm.outbox ADD COLUMN IF NOT EXISTS dead_at     timestamptz;
ALTER TABLE crm.outbox ADD COLUMN IF NOT EXISTS dead_reason text;

-- Finds leases to reclaim. Partial on `in_flight` because that is the only state
-- a stale claim can be in, and the table is dominated by `delivered` rows.
CREATE INDEX IF NOT EXISTS idx_outbox_stale_lease
  ON crm.outbox (claimed_at) WHERE state = 'in_flight';

-- A delivered row records what it produced at the ERP. Nullable because a
-- transition returns the record it acted on rather than a new id.
ALTER TABLE crm.outbox ADD COLUMN IF NOT EXISTS erp_response jsonb;
