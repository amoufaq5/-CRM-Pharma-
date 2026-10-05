-- 0034_endpoint_probe.sql
--
-- "Does this endpoint actually work?" — asked by an administrator, answered by the
-- scheduler, read back over HTTP.
--
-- WHAT WAS BROKEN. An endpoint names an environment variable (`secret_env`) and nothing
-- anywhere could tell an administrator whether that variable holds a secret. The API
-- cannot answer it and must not try: the sender runs in the SCHEDULER process and reads a
-- different environment, so an API that checked `process.env` would report confidently
-- about the wrong one — and it would report confidently, which is worse than silence. The
-- same split applies to the relay: the SMTP host, port and AUTH username are scheduler
-- configuration, so only the scheduler can hold the conversation that proves them.
--
-- So the verdict is RECORDED by the process that can earn it and READ by the process the
-- administrator is talking to. This table is that handover. It is a request queue in one
-- direction and a result in the other, which is the same shape `crm.outbox` and
-- `crm.notification_delivery` have and for the same reason — the two halves run in
-- different processes and must not need to be up at the same moment.
--
-- WHAT A PROBE PROVES, AND WHAT IT REFUSES TO CLAIM. Four verdicts, each naming exactly
-- what was established, because a probe that reports "fine" without having proven
-- anything is worse than no probe:
--
--   delivered — a probe message was accepted by the destination. Only the webhook channel
--               can earn this: a signed POST to the configured URL that came back 2xx has
--               proven the secret, the signature, the network path and the receiver.
--   reachable — the destination accepted us but nothing was delivered. The email channel
--               earns this: the relay greeted us, STARTTLS came up, AUTH succeeded with
--               the password the endpoint's variable names, and MAIL FROM / RCPT TO were
--               both accepted — then RSET, so no message exists. That proves every piece
--               of configuration a send depends on without putting a message nobody asked
--               for in front of a human.
--   refused   — the destination answered and said no, permanently: a 4xx from a webhook, a
--               5xx from a relay, a missing secret, a relay that will not offer STARTTLS.
--               This is the verdict an administrator can act on.
--   unknown   — the probe could not be completed. A timeout, a connection refused, a 5xx
--               or a 429 from a webhook, a 4xx from a relay, or no prober for the channel
--               in the process that picked the request up. FAIL CLOSED: none of those are
--               evidence that the endpoint works, and reporting them as anything but
--               "we do not know" is the one outcome that would make this table a liability.
--
-- NOT ON crm.notification_delivery, AND DELIBERATELY NOT COUPLED TO A NOTIFICATION.
-- 0021 made `notification_delivery` cascade from `crm.notification`, which ADR-0001
-- records as a real consequence: the retention period for a notification became the
-- retention period for the record of where that signal went. A probe has no notification
-- and must never acquire one — it would inherit the same coupling and a prune would then
-- delete an endpoint's test history because an unrelated message aged out. It cascades
-- from the ENDPOINT instead, which is the thing it is a statement about: an endpoint that
-- no longer exists has no configuration left to describe.
--
-- RETENTION IS A RING, NOT A HORIZON. A probe result is operational, not an audit record:
-- nobody will ever ask which day in March an administrator tested a webhook, and the
-- useful answer is almost always the most recent one. So the newest 20 per endpoint are
-- kept and older COMPLETE ones are trimmed by the insert that supersedes them. That is a
-- bound no scheduled job has to be wired up to honour, which matters because an unbounded
-- table whose pruning lives in a job somebody still has to add is how this schema would
-- grow its next open item. An outstanding probe is never trimmed.
--
-- THE COOLDOWN IS IN THE SCHEMA, NOT IN THE ROUTE. A probe sends real traffic to a third
-- party because somebody clicked a button, so it needs a limit — and a limit enforced only
-- by the route is a limit every other caller skips. Two rules, both structural:
--
--   * ONE OUTSTANDING PROBE PER ENDPOINT, as a partial unique index. A queue of probes for
--     one endpoint answers one question repeatedly, and the scheduler would send them all.
--   * A PER-TENANT COOLDOWN between requests, as a trigger, because no CHECK can see
--     another row. `requested_at` is OVERWRITTEN with `now()` by that trigger rather than
--     merely defaulted: a caller who could supply it could backdate one probe and make the
--     next one legal immediately, which is the whole guard gone for the price of one
--     column in an INSERT.
--
-- The trigger tests the outstanding case BEFORE the cooldown even though the index would
-- catch it anyway, because the two refusals mean different things to the person reading
-- them — "one is already running, wait for it" against "you asked two minutes ago" — and a
-- cooldown that fires first would hide the first sentence behind the second for the whole
-- window. The index remains the guarantee: a trigger reads rows another transaction has
-- not committed yet, and two simultaneous requests are settled by the unique index alone.
--
-- The cooldown is per tenant (`crm.notification_policy.probe_cooldown_seconds`, 120s)
-- rather than a constant, and 0 is permitted. That is not the disabled-guard-as-a-boolean
-- 0026 argues against: a cooldown protects a THIRD PARTY from traffic, and a tenant whose
-- endpoint is a sink on its own loopback has no third party to protect. The guard it
-- relaxes costs one HTTP request, where 0026's guard stood between a tenant and a deleted
-- inbox.
--
-- THE TENANT CHECK IS NOT BELT AND BRACES. `endpoint_id` is a plain foreign key, as every
-- reference in this schema is (ADR-0001 records the composite-FK question as open). But a
-- foreign-key check runs with row security DISABLED, so an INSERT naming `tenant_id` =
-- mine and `endpoint_id` = yours passes the FK and passes the RLS policy, which only ever
-- looks at `tenant_id`. The trigger below asks `crm.notification_endpoint` under the
-- caller's own RLS and refuses the pair, which closes it for this table without changing
-- the convention everywhere else.

-- ---------------------------------------------------------------------------
-- The cooldown knob, beside the retention horizons it has nothing to do with — because
-- `crm.notification_policy` is this tenant's notification configuration and a second
-- single-row-per-tenant table would be a worse answer than a sixth column.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_policy
  ADD COLUMN probe_cooldown_seconds integer NOT NULL DEFAULT 120;

ALTER TABLE crm.notification_policy
  ADD CONSTRAINT notification_policy_probe_cooldown
    -- A day is the ceiling: longer than that and an administrator debugging a relay at
    -- 09:00 cannot retry before tomorrow, which is a cooldown that has become an outage.
    CHECK (probe_cooldown_seconds BETWEEN 0 AND 86400);

-- ---------------------------------------------------------------------------
-- The probe itself.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification_endpoint_probe (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,

  -- `now()` is the TRANSACTION timestamp, so two probes written in one transaction share
  -- `requested_at` to the microsecond and ordering by it is a coin toss. 0027 added a
  -- sequence to `crm.outbox` after proving exactly that tie; this table is born with one
  -- rather than acquiring it later, because the retention ring below has to know which 20
  -- rows are the newest and a wrong answer there deletes the result somebody is reading.
  seq           bigint NOT NULL GENERATED ALWAYS AS IDENTITY,

  endpoint_id   uuid NOT NULL REFERENCES crm.notification_endpoint (id) ON DELETE CASCADE,

  -- NOT NULL. A probe is a deliberate act with a cost at the far end, so it is attributable
  -- or it does not happen; "something asked for this" is not an answer an operator reading
  -- a receiver's access log can use.
  requested_by  uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  requested_at  timestamptz NOT NULL DEFAULT now(),

  state         text NOT NULL DEFAULT 'requested'
                  CHECK (state IN ('requested', 'in_flight', 'complete')),

  -- Claim count, not retry count. A scheduler that dies between claiming and settling
  -- leaves the row `in_flight`; the next pass past the lease picks it up again, and after
  -- three of those the probe is settled `unknown` rather than claimed forever. A probe is
  -- never retried after an answer, however bad the answer was — an endpoint that said no
  -- will say no again, and the administrator asked one question.
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  claimed_at    timestamptz,
  claimed_by    text CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 200),

  verdict       text CHECK (verdict IN ('delivered', 'reachable', 'refused', 'unknown')),
  -- The sentence an operator reads. Never a secret: both probers report the NAME of the
  -- variable they could not read, exactly as the senders do.
  detail        text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 2000),
  -- An HTTP status or an SMTP reply code. The two ranges do not overlap in a way that
  -- matters and `channel` says which is which, so one column is honest here.
  status        integer CHECK (status IS NULL OR status BETWEEN 100 AND 599),
  completed_at  timestamptz,

  -- A complete probe has all three, and an incomplete one has none of them. Without this
  -- a row could sit `complete` with no verdict — which an API would render as a probe that
  -- finished and found nothing, the one reading that is neither true nor fail-closed.
  CONSTRAINT notification_endpoint_probe_settled
    CHECK ((state = 'complete') = (verdict IS NOT NULL AND detail IS NOT NULL AND completed_at IS NOT NULL)),

  CONSTRAINT notification_endpoint_probe_claim_paired
    CHECK ((claimed_at IS NULL) = (claimed_by IS NULL)),

  -- In flight means somebody holds it. A row in that state with no claimant is a lease
  -- nobody can take over and nobody will ever settle.
  CONSTRAINT notification_endpoint_probe_in_flight_claimed
    CHECK (state <> 'in_flight' OR claimed_at IS NOT NULL)
);

-- One outstanding probe per endpoint. The whole queue bound, in one line: a second
-- request while the first is unanswered is refused by the database rather than by whoever
-- remembered to check.
CREATE UNIQUE INDEX uq_notification_endpoint_probe_outstanding
  ON crm.notification_endpoint_probe (endpoint_id) WHERE state <> 'complete';

-- What the scheduler claims on, in the order it should claim: oldest request first.
CREATE INDEX idx_notification_endpoint_probe_due
  ON crm.notification_endpoint_probe (tenant_id, seq) WHERE state <> 'complete';

-- What the API reads, and what the retention ring walks.
CREATE INDEX idx_notification_endpoint_probe_history
  ON crm.notification_endpoint_probe (endpoint_id, seq DESC);

SELECT crm.apply_tenant_isolation('crm.notification_endpoint_probe');

-- ---------------------------------------------------------------------------
-- The request guard: the tenant pairing, the cooldown, and a clock nobody supplies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_tenant uuid;
  cooldown     integer;
  previous     timestamptz;
BEGIN
  -- The clock is ours, not the caller's. See the header: a suppliable `requested_at`
  -- defeats the cooldown with one extra column in an INSERT.
  NEW.requested_at := now();

  -- Read under the CALLER's row security, so an endpoint in another tenant reads as
  -- absent. A foreign-key check would have accepted it: FK validation runs with row
  -- security disabled, and the RLS policy on this table only ever inspects `tenant_id`.
  SELECT e.tenant_id INTO owner_tenant
    FROM crm.notification_endpoint e WHERE e.id = NEW.endpoint_id;

  IF owner_tenant IS NULL OR owner_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'probe-foreign-endpoint: notification endpoint % is not visible in tenant %',
      NEW.endpoint_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM crm.notification_endpoint_probe p
     WHERE p.endpoint_id = NEW.endpoint_id AND p.state <> 'complete'
  ) THEN
    RAISE EXCEPTION
      'probe-outstanding: endpoint % already has a probe waiting for an answer', NEW.endpoint_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.probe_cooldown_seconds INTO cooldown
    FROM crm.notification_policy p WHERE p.tenant_id = NEW.tenant_id;
  -- A tenant that has never set a retention policy has no row here, and the absence must
  -- mean the default rather than no cooldown at all — the fail-closed reading, and the one
  -- that matches what `notificationPolicy()` would have written had anyone asked.
  cooldown := COALESCE(cooldown, 120);

  IF cooldown > 0 THEN
    SELECT max(p.requested_at) INTO previous
      FROM crm.notification_endpoint_probe p
     WHERE p.endpoint_id = NEW.endpoint_id;

    IF previous IS NOT NULL AND previous > NEW.requested_at - make_interval(secs => cooldown) THEN
      RAISE EXCEPTION
        'probe-cooldown: endpoint % was probed at % and may be probed again after % (cooldown % seconds)',
        NEW.endpoint_id,
        previous,
        previous + make_interval(secs => cooldown),
        cooldown
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER notification_endpoint_probe_guard
  BEFORE INSERT ON crm.notification_endpoint_probe
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_probe_guard();

-- ---------------------------------------------------------------------------
-- The settlement guard: a verdict is written once.
-- ---------------------------------------------------------------------------
/**
 * What may change about a probe after it exists.
 *
 * DELETE is deliberately NOT forbidden, unlike `crm.rep_role` (0023). A probe is
 * operational and the retention ring below removes old ones; an append-only rule here
 * would make the bound unenforceable and would be claiming an audit guarantee this table
 * does not provide.
 *
 * What is forbidden is rewriting an answer. `requested → in_flight → complete`, re-claim
 * while in flight, and nothing else — so a verdict an administrator has read cannot be
 * replaced by a later pass with a different one, and the row that said `refused` cannot
 * quietly become `delivered`.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_settle_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.endpoint_id <> OLD.endpoint_id
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'probe-immutable: probe % cannot be repointed or re-dated', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'complete' THEN
    RAISE EXCEPTION 'probe-settled: probe % already answered % and cannot be re-answered', OLD.id, OLD.verdict
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
       (OLD.state = 'requested' AND NEW.state IN ('requested', 'in_flight'))
    OR (OLD.state = 'in_flight' AND NEW.state IN ('in_flight', 'complete'))
  ) THEN
    RAISE EXCEPTION 'probe-transition: probe % cannot move from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER notification_endpoint_probe_settle_once
  BEFORE UPDATE ON crm.notification_endpoint_probe
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_probe_settle_once();

-- ---------------------------------------------------------------------------
-- The retention ring.
-- ---------------------------------------------------------------------------
/**
 * Keeps the newest 20 COMPLETE probes per endpoint, trimmed by the insert that makes an
 * older one redundant.
 *
 * Per endpoint rather than per tenant, so a tenant with forty endpoints keeps forty
 * histories instead of one endpoint's debugging session evicting everyone else's.
 *
 * An outstanding probe is never a candidate: it has no answer to keep and deleting it
 * would silently cancel a request somebody is waiting on.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_trim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM crm.notification_endpoint_probe p
   WHERE p.endpoint_id = NEW.endpoint_id
     AND p.state = 'complete'
     AND p.seq < (
       SELECT min(keep.seq) FROM (
         SELECT q.seq FROM crm.notification_endpoint_probe q
          WHERE q.endpoint_id = NEW.endpoint_id
          ORDER BY q.seq DESC
          LIMIT 20
       ) AS keep
     );
  RETURN NULL;
END
$$;

CREATE TRIGGER notification_endpoint_probe_trim
  AFTER INSERT ON crm.notification_endpoint_probe
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_probe_trim();

-- ---------------------------------------------------------------------------

/**
 * The distinct channels a tenant has configured, with how many endpoints are live.
 *
 * The boot-time coverage check's query, in one place. It is a function rather than a view
 * so the enabled/disabled split is computed once and named once: the whole point of the
 * check is that a DISABLED endpoint for a channel nobody can send is not a fault, and two
 * callers counting that differently would give an operator two different verdicts.
 *
 * Tenant-scoped by RLS like everything else, which is exactly the constraint the caller
 * has to live with: boot happens before any tenant context exists, so the scheduler walks
 * `crm.tenant` and asks this once per tenant.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_channels()
RETURNS TABLE (channel text, enabled_endpoints bigint, disabled_endpoints bigint)
LANGUAGE sql STABLE AS $$
  SELECT e.channel,
         count(*) FILTER (WHERE e.enabled),
         count(*) FILTER (WHERE NOT e.enabled)
    FROM crm.notification_endpoint e
   GROUP BY e.channel
   ORDER BY e.channel;
$$;
