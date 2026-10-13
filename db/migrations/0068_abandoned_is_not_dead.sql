-- Stopping a tenant stranded its queued work. `abandoned` is not `dead`.
--
-- WHAT IS BROKEN. 0050 marks a tenant `erp_deleted` when the ERP says it was deleted, and
-- `activeTenants` is `status = 'active'` — so the mark removes the tenant from every job at once.
-- That is the intent: pushing a deleted tenant's rep names and account ids to a third party after
-- the controller ended the relationship is the disclosure the deletion exists to stop.
--
-- But a `pending` row in `crm.outbox` and a `pending` row in `crm.notification_delivery` for a
-- stopped tenant then sit FOREVER: never sent, never dead-lettered, never pruned — the delivery
-- prune keys on `state = 'delivered'`, which a row that never ran will never reach. Nothing is
-- wrong today; the rows are evidence of what was queued when the music stopped. It is unbounded
-- and nobody decided it.
--
-- ADR-0001's open row named exactly what is cheap and what is not: "a settlement that says
-- 'abandoned because the tenant was deleted' is cheap, and whether these rows should then be
-- destroyed or retained is the decision that is not." This does the cheap half and leaves the
-- other where it already lives: both tables are `undecided` in `crm.data_disposition` (0051),
-- with their questions written out, and this migration does not answer them. A settlement is a
-- STATE, not a retention decision.
--
-- WHY A FIFTH STATE AND NOT `dead`, which was the first thing I tried. `dead` already exists and
-- carries a `dead_reason`, so `dead_reason = 'tenant-deleted: …'` is the cheapest possible change
-- and it is wrong, for a reason that shows up two files away:
--
--   * `dead` means A DESTINATION REFUSED US, or we gave up after the attempt cap. It is the state
--     `crm.outbox_dead_letter` records a history for, the state `deadLetter` lists for an operator
--     to retry, and the state the dead-letter ALARM counts. An abandoned row in that list is a
--     write somebody would try to revive — against a tenant whose schema the ERP has dropped.
--   * worse, the alarm raises `erp_write_failed` AT A REP. Marking these `dead` would notify the
--     reps of a tenant that no longer exists, about writes nobody will ever make, which is the
--     disclosure 0050 stopped arriving one tick later by a different door.
--
-- `abandoned` is therefore its own terminal state: nobody will ever try this, because the tenant
-- is gone. It is not in any retry path, not in the dead-letter history, not in the alarm, and a
-- reader of either table can tell "we tried and failed" from "we never tried and never will".
--
-- WHO DOES IT, and this is where 0067 pays for itself. The tenant is stopped, so no per-tenant job
-- runs for it — which is the same wall the receipt verification hit. 0067 built `crm.platform_job`
-- for exactly this class and its header said the first instance "will not be its last"; this is
-- the second. There are two paths deliberately:
--
--   * AT THE MARK, in the same transaction that stops the tenant. No window at all: the tenant is
--     stopped and its queue is settled by one commit, so there is never an instant in which a
--     deleted tenant has live pending work.
--   * A PLATFORM SWEEP as the backstop, for the rows of a tenant stopped before this shipped, or
--     stopped by hand in SQL — which 0053's registry rules permit and this repository's own
--     fixtures do.

-- ---------------------------------------------------------------------------
-- 1. The fifth state, on both tables.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.outbox DROP CONSTRAINT outbox_state_check;
ALTER TABLE crm.outbox ADD CONSTRAINT outbox_state_check
  CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead', 'abandoned'));

ALTER TABLE crm.notification_delivery DROP CONSTRAINT notification_delivery_state_check;
ALTER TABLE crm.notification_delivery ADD CONSTRAINT notification_delivery_state_check
  CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead', 'abandoned'));

-- WHY it was abandoned, on the row. `crm.outbox` has `dead_reason` and could carry it there, and
-- deliberately does not: `dead_reason` is read by the dead-letter history and the retry path, and
-- a column that means two things is a column every reader has to think about. The same column on
-- both tables, so one query answers "what did we abandon, and under what authority" across them.
ALTER TABLE crm.outbox ADD COLUMN abandoned_at timestamptz;
ALTER TABLE crm.outbox ADD COLUMN abandoned_reason text
  CHECK (abandoned_reason IS NULL OR length(abandoned_reason) BETWEEN 10 AND 1000);
ALTER TABLE crm.notification_delivery ADD COLUMN abandoned_at timestamptz;
ALTER TABLE crm.notification_delivery ADD COLUMN abandoned_reason text
  CHECK (abandoned_reason IS NULL OR length(abandoned_reason) BETWEEN 10 AND 1000);

-- The state and its evidence, paired in both directions — and in TWO constraints rather than one,
-- which is a correction. The single `(state = 'abandoned') = (at IS NOT NULL AND reason IS NOT
-- NULL)` I wrote first has a hole the suite found: setting a REASON ALONE on a pending row leaves
-- both sides false, so it is accepted, and the row then carries an explanation for a settlement
-- that never happened. Split, each half refuses by name and the conjunction is airtight:
-- abandoned ⟺ a timestamp ⟺ a reason.
--
-- An `abandoned` row with no reason would be a settlement nobody can account for; a reason on a
-- row in any other state would be a column that sometimes means something, which is 0065's
-- argument for `to_address`'s pairing.
ALTER TABLE crm.outbox
  ADD CONSTRAINT outbox_abandoned_says_when
    CHECK ((state = 'abandoned') = (abandoned_at IS NOT NULL)),
  ADD CONSTRAINT outbox_abandoned_says_why
    CHECK ((abandoned_at IS NOT NULL) = (abandoned_reason IS NOT NULL));
ALTER TABLE crm.notification_delivery
  ADD CONSTRAINT notification_delivery_abandoned_says_when
    CHECK ((state = 'abandoned') = (abandoned_at IS NOT NULL)),
  ADD CONSTRAINT notification_delivery_abandoned_says_why
    CHECK ((abandoned_at IS NOT NULL) = (abandoned_reason IS NOT NULL));

COMMENT ON COLUMN crm.outbox.abandoned_reason IS
  'Why nobody will ever send this. Its own column rather than dead_reason, because `dead` means a destination refused us — it is the state the dead-letter history, the retry path and the alarm all read — and an abandoned row in that list is a write somebody would try to revive against a tenant whose schema has been dropped.';

-- ---------------------------------------------------------------------------
-- 2. Settling, which is the whole of it.
-- ---------------------------------------------------------------------------
/**
 * Abandons every unsent row for a tenant the ERP has deleted.
 *
 * SECURITY INVOKER, and the tenant predicate is written out as well as enforced by RLS (0043's
 * rule): a reader of this function must be able to see the tenant match rather than infer it from
 * a policy two files away. It must be called inside `withTenantContext` like every other write in
 * this schema.
 *
 * IT REFUSES TO RUN FOR A LIVE TENANT, in so many words, and that is the only guard that really
 * matters here: this function's whole job is to make queued work unsendable, so running it
 * against an active tenant would destroy that tenant's pending ERP writes and notifications.
 * Checked against `crm.tenant` — the RLS-exempt registry — rather than against an argument,
 * because a caller that could assert "this tenant is deleted" would be a caller that could be
 * wrong about it.
 *
 * IDEMPOTENT, so both callers can run it without coordinating: the sweep touches only
 * `pending` and `in_flight`, so a second pass over an already-settled tenant moves nothing. A
 * `dead` row is deliberately LEFT ALONE — it has its own account of itself, written when a
 * destination refused it, and overwriting that with "the tenant was deleted" would erase the
 * reason somebody may need.
 */
CREATE OR REPLACE FUNCTION crm.abandon_stopped_tenant_work(p_tenant_id uuid)
RETURNS TABLE (outbox_rows bigint, delivery_rows bigint)
LANGUAGE plpgsql AS $$
DECLARE
  tomb   text;
  status text;
  why    text;
  n_outbox   bigint := 0;
  n_delivery bigint := 0;
BEGIN
  SELECT t.status, t.erp_tombstone_id INTO status, tomb
    FROM crm.tenant t WHERE t.tenant_id = p_tenant_id;

  IF status IS NULL THEN
    RAISE EXCEPTION
      'abandon-unregistered-tenant: % has no row in crm.tenant, so nothing says it was deleted — refusing to make its queued work unsendable on a caller''s word',
      p_tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF status <> 'erp_deleted' THEN
    RAISE EXCEPTION
      'abandon-live-tenant: % is %, not erp_deleted — abandoning its queue would destroy pending ERP writes and notifications for a tenant that is still being served',
      p_tenant_id, status
      USING ERRCODE = 'check_violation';
  END IF;

  -- The tombstone id is in the sentence, so the row says under WHAT AUTHORITY it was abandoned.
  -- 0050 refuses the `erp_deleted` mark without a receipt, so this is never null here — and it is
  -- the difference between "somebody abandoned this" and "the ERP deleted the tenant on this
  -- date, under this tombstone, and here is the consequence".
  why := 'tenant-deleted: the ERP deleted this tenant under tombstone ' || coalesce(tomb, '(none)')
         || ', so this was never sent and never will be. Settled by crm.abandon_stopped_tenant_work.';

  WITH settled AS (
    UPDATE crm.outbox
       SET state = 'abandoned', abandoned_at = now(), abandoned_reason = why
     WHERE tenant_id = p_tenant_id AND state IN ('pending', 'in_flight')
    RETURNING 1
  ) SELECT count(*) INTO n_outbox FROM settled;

  WITH settled AS (
    UPDATE crm.notification_delivery
       SET state = 'abandoned', abandoned_at = now(), abandoned_reason = why
     WHERE tenant_id = p_tenant_id AND state IN ('pending', 'in_flight')
    RETURNING 1
  ) SELECT count(*) INTO n_delivery FROM settled;

  RETURN QUERY SELECT n_outbox, n_delivery;
END
$$;

/**
 * The tenants the ERP has deleted, which is all a platform sweep can see without a context.
 *
 * I WROTE THIS AS `SECURITY DEFINER` FIRST, returning the pending counts per tenant, and it was
 * wrong twice over. `schema.contract.test.ts` refuses a `SECURITY DEFINER` function in `crm` in so
 * many words — "adding one has to be a conscious act that fails this test and makes someone argue
 * for it" — and the argument does not survive contact with the schema: such a function runs as its
 * OWNER, the owner is `crm_app`, and every table it would count is RLS-FORCED. So with no tenant
 * context the policy yields nothing and the counts would all be zero. The exemption would have
 * bought a function that reports every deployment clean.
 *
 * So this returns the tenant list and nothing else — `crm.tenant` is the one registry with no
 * policy, readable with no context — and the caller enters each tenant's own context to count and
 * settle. The same shape as `checkChannelCoverage` for endpoints and 0067's receipt sweep, and for
 * the same reason: the enumeration is the only part that can happen outside a tenant.
 */
CREATE OR REPLACE FUNCTION crm.stopped_tenants()
RETURNS TABLE (tenant_id uuid, erp_tombstone_id text, erp_tombstone_deleted_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id, t.erp_tombstone_id, t.erp_tombstone_deleted_at
    FROM crm.tenant t
   WHERE t.status = 'erp_deleted'
   ORDER BY t.tenant_id;
$$;

/**
 * What one stopped tenant still holds unsent. Called inside that tenant's context.
 *
 * Its own function rather than inline SQL in the caller, for `crm.notification_delivery_history`'s
 * reason: the predicate that defines "unsent" is a property of these tables, and two callers
 * writing it out would eventually write it differently — the settle below and the sweep that
 * reports on it have to agree exactly, or the sweep's line will not match what it did.
 */
CREATE OR REPLACE FUNCTION crm.unsent_work(p_tenant_id uuid)
RETURNS TABLE (outbox_rows bigint, delivery_rows bigint)
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM crm.outbox o
           WHERE o.tenant_id = p_tenant_id AND o.state IN ('pending', 'in_flight')),
         (SELECT count(*) FROM crm.notification_delivery d
           WHERE d.tenant_id = p_tenant_id AND d.state IN ('pending', 'in_flight'));
$$;

-- ---------------------------------------------------------------------------
-- 3. The platform job.
-- ---------------------------------------------------------------------------
-- The SECOND instance of 0067's platform work, which its header predicted. The at-the-mark path
-- leaves no window, so this is the backstop: rows of a tenant stopped before this shipped, or
-- stopped by hand in SQL. On a healthy deployment it settles nothing, every night, and says so.
CREATE OR REPLACE FUNCTION crm.platform_jobs()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['receipt_verify',
               -- 0068. Settles the queued work of a tenant the ERP deleted, which no per-tenant
               -- job can reach: `activeTenants` is `status = 'active'`.
               'abandon_stopped_work'];
$$;

INSERT INTO crm.platform_job (job, interval_ms)
VALUES ('abandon_stopped_work', 24 * 60 * 60 * 1000)
ON CONFLICT (job) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Terminal, in the database rather than by reachability.
-- ---------------------------------------------------------------------------
-- `abandoned` is unreachable from every live code path today, and that is an ARGUMENT rather
-- than a guarantee: the relay's `markDead` guards on `state <> 'delivered'` and its
-- `releaseForRetry` on `state <> 'dead'`, so either would happily overwrite an abandoned row if
-- ever handed its id — and the only thing stopping them is that the tenant is not in
-- `activeTenants`, which is a fact two files away about a different table.
--
-- A trigger makes it a property of the row. It is 0052's append-only shape and 0049's frozen
-- destination applied to a state: there is no legitimate transition out of `abandoned`, because
-- the tenant it belongs to has been deleted and cannot come back (0050 makes the mark terminal).
-- An operator who really needs to reverse one is reversing a tenant deletion, which is not a
-- thing this schema admits.
CREATE OR REPLACE FUNCTION crm.abandoned_is_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'abandoned' AND NEW.state <> 'abandoned' THEN
    RAISE EXCEPTION
      'abandoned-is-terminal: %.% was abandoned because the ERP deleted its tenant, so it cannot become % — there is no retry for a write to a schema that no longer exists',
      TG_TABLE_NAME, OLD.id, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER outbox_abandoned_is_terminal
  BEFORE UPDATE ON crm.outbox
  FOR EACH ROW EXECUTE FUNCTION crm.abandoned_is_terminal();

CREATE OR REPLACE TRIGGER notification_delivery_abandoned_is_terminal
  BEFORE UPDATE ON crm.notification_delivery
  FOR EACH ROW EXECUTE FUNCTION crm.abandoned_is_terminal();

-- ---------------------------------------------------------------------------
-- 5. What `abandoned` does NOT do, which is the part a later reader will assume is an oversight.
-- ---------------------------------------------------------------------------
-- `crm.notification_prune_candidates.delivery_unsettled` is an allow-list —
-- `state IN ('pending', 'in_flight', 'dead')` — so `abandoned` is absent from it and an abandoned
-- delivery does NOT hold its notification back from the prune. That is deliberate, it is the
-- opposite of what 0046's argument says about `dead`, and the difference is the whole point of
-- having a fifth state:
--
--   * A DEAD delivery is an UNRESOLVED disclosure attempt. 0046 holds its notification because
--     "pruning its notification would create a permanent orphan rather than a retained record",
--     and because somebody may still act on it — the dead-letter listing exists for exactly that.
--   * AN ABANDONED delivery is RESOLVED, definitively, by the tenant ceasing to exist. Nobody is
--     waiting for it and nobody can act on it. Holding its notification back would make a deleted
--     tenant's inbox unprunable forever, which is the unboundedness this migration exists to
--     close, moved one table over.
--
-- Asserted by a contract test rather than left to this comment, because an omission that is
-- correct looks exactly like an omission that is a bug.
COMMENT ON FUNCTION crm.abandoned_is_terminal() IS
  'Refuses any transition out of `abandoned`. The state is unreachable from every live code path, which is an argument and not a guarantee — the relay''s own settle predicates would overwrite it if ever handed the id.';
