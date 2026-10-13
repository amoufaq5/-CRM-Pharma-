-- A probe is about a destination, and it has to outlive the row that named one.
--
-- THE THIRD LEG OF ONE DEFECT, and the last one. ADR-0001's open row says an endpoint "can be
-- created and disabled but never removed", and the reason there is no DELETE route is written in
-- `routes.ts`: deleting an endpoint used to erase the record of everything ever sent to it. 0046
-- dropped `crm.notification_delivery`'s cascade from the notification and 0048 dropped its cascade
-- from the endpoint, so a delivery record now survives both its parents with the destination copied
-- onto it. `notification_endpoint_probe_endpoint_id_fkey` is still `ON DELETE CASCADE`, and it is
-- the only thing a cascade still destroys — so this file is 0048 again, on the other child.
--
-- AND IT IS NOT MERELY SYMMETRY. 0045's hourly probe budget counts rows in THIS table: a deletion
-- that took the probes with it would hand the tenant back its share of a budget that exists
-- because "a probe sends real traffic to a third party". ADR-0001's row names that exact bypass as
-- the thing that follows if a DELETE route is ever added — "the same bypass 0045 found in the
-- retention ring, by a different route". Detaching the probes closes it STRUCTURALLY: the rows the
-- budget counts are not the endpoint's to delete.
--
-- THE COOLDOWN NEEDED THE OTHER HALF OF THAT ARGUMENT, and this is the part that is a change of
-- rule rather than of plumbing. 0034's cooldown keyed on `endpoint_id`, so it bounded how often a
-- ROW could be probed. But the thing it protects is a third party's server, and
-- "disable the old endpoint, create a new one" — the only way to move a destination since 0049 —
-- already produced a fresh row with no cooldown at all. So an administrator who wanted to probe
-- the same url twice in a minute never needed a DELETE route; they needed a second endpoint. The
-- cooldown now keys on the DESTINATION the probe is addressed to, which is only possible because
-- the row above copies it. Two consequences, both intended:
--
--   * Two endpoints that share a url share a cooldown. That is the point: one server, one
--     protection. The refusal names the url so the reason is legible rather than mysterious.
--   * A deleted-and-recreated endpoint keeps the cooldown of the destination it points at, which
--     is what makes the DELETE route 0071 adds safe to have.
--
-- `uq_notification_endpoint_probe_outstanding` STAYS PER ENDPOINT, deliberately. It is about a
-- row's own claim — one probe of this endpoint waiting for an answer, enforced by a partial unique
-- index because a trigger cannot see another transaction's uncommitted row — where the cooldown is
-- about traffic. Per-destination it would also be subsumed: a just-requested probe on a sibling
-- endpoint is now the destination's `previous`, so the cooldown refuses the second one first.
--
-- WHAT THIS FILE DOES NOT DO: delete anything. There is still no DELETE route and no cap; that is
-- 0071, and it needs this file to exist first.

-- ---------------------------------------------------------------------------
-- 1. The destination, copied onto the probe.
-- ---------------------------------------------------------------------------
--
-- 0048's shape exactly: copy what the row needs to stay legible, let the trigger that makes the
-- copies be the tenant guard the key used to provide, and tighten to NOT NULL after the backfill
-- rather than inventing a destination with a DEFAULT.
--
-- WHAT IS COPIED: `channel` and `url` — the destination. NOT `secret_env`, for 0048's reason: it
-- names an environment variable rather than holding a value, and rotating which variable an
-- endpoint reads is a legitimate change that must not be frozen per probe. Which is also why
-- `claimDueProbes` must still JOIN the live endpoint to actually probe: the copies are for the
-- record, not for the work.
ALTER TABLE crm.notification_endpoint_probe ADD COLUMN endpoint_channel text;
ALTER TABLE crm.notification_endpoint_probe ADD COLUMN endpoint_url     text;

-- BOTH TABLES ARE LIFTED, which is 0046's lesson about a backfill that joins two FORCEd tables:
-- lifting only the target leaves the join contributing zero rows and the `SET NOT NULL` as the
-- only thing that complains.
ALTER TABLE crm.notification_endpoint_probe NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_endpoint       NO FORCE ROW LEVEL SECURITY;

UPDATE crm.notification_endpoint_probe p
   SET endpoint_channel = e.channel,
       endpoint_url     = e.url
  FROM crm.notification_endpoint e
 WHERE e.tenant_id = p.tenant_id
   AND e.id        = p.endpoint_id;

ALTER TABLE crm.notification_endpoint       FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_endpoint_probe FORCE ROW LEVEL SECURITY;

-- Any row the backfill could not reach had no endpoint, which the cascade made impossible — so
-- this is zero rows on every real database, and a refusal rather than an invention if it is not.
ALTER TABLE crm.notification_endpoint_probe ALTER COLUMN endpoint_channel SET NOT NULL;
ALTER TABLE crm.notification_endpoint_probe ALTER COLUMN endpoint_url     SET NOT NULL;

-- The key goes LAST, after the copies exist, so a half-applied run through psql without `-1`
-- never leaves a window in which neither the key nor the copy is protecting the row.
ALTER TABLE crm.notification_endpoint_probe
  DROP CONSTRAINT notification_endpoint_probe_endpoint_id_fkey;

-- The destination lookup the cooldown now does, which without this is a sequential scan of every
-- probe the tenant has ever requested on every probe request.
CREATE INDEX idx_notification_endpoint_probe_destination
  ON crm.notification_endpoint_probe (tenant_id, endpoint_channel, endpoint_url, requested_at DESC);

-- ---------------------------------------------------------------------------
-- 2. The guard, which is now also the thing that makes the copies.
-- ---------------------------------------------------------------------------
--
-- REPRODUCED IN FULL from `pg_proc` and not from the file that created it: `CREATE OR REPLACE
-- FUNCTION` replaces a whole body, so a version rebuilt from 0034 would silently revert 0045's
-- budget — which is how 0041 reverted 0038's guard, caught only by 0038's own test. Three changes
-- and nothing else: the lookup fetches the destination and assigns it, the cooldown keys on that
-- destination, and the cooldown's refusal names it.
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ep           record;
  cooldown     integer;
  previous     timestamptz;
  budget       record;
BEGIN
  -- The clock is ours, not the caller's. See 0034's header: a suppliable `requested_at`
  -- defeats the cooldown with one extra column in an INSERT — and now the budget too, since
  -- a backdated row falls out of the window it should have been counted in.
  NEW.requested_at := now();

  -- Read under the CALLER's row security, so an endpoint in another tenant reads as
  -- absent. A foreign-key check would have accepted it: FK validation runs with row
  -- security disabled, and the RLS policy on this table only ever inspects `tenant_id`.
  -- Since 0070 this is also the only check there is — the key is gone — and it is the
  -- stronger of the two, which is the argument 0048 made when it dropped the other one.
  SELECT e.tenant_id, e.channel, e.url INTO ep
    FROM crm.notification_endpoint e WHERE e.id = NEW.endpoint_id;

  IF ep.tenant_id IS NULL OR ep.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'probe-foreign-endpoint: notification endpoint % is not visible in tenant %',
      NEW.endpoint_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0070: the record of WHERE this probe went, taken at request time. Assigned here rather
  -- than supplied, for the reason `requested_at` is: a caller who could write it could
  -- write a destination this probe was never addressed to, and the cooldown below reads it.
  NEW.endpoint_channel := ep.channel;
  NEW.endpoint_url     := ep.url;

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
    -- 0070: BY DESTINATION, not by endpoint id. The cooldown protects a third party's server,
    -- and two endpoint rows pointing at one url are one server. Keyed on the tenant too, so a
    -- url two tenants happen to share is two cooldowns — a tenant must never be told to wait
    -- because of what another tenant did, which would also be a disclosure that the other
    -- tenant exists.
    SELECT max(p.requested_at) INTO previous
      FROM crm.notification_endpoint_probe p
     WHERE p.tenant_id        = NEW.tenant_id
       AND p.endpoint_channel = NEW.endpoint_channel
       AND p.endpoint_url     = NEW.endpoint_url;

    IF previous IS NOT NULL AND previous > NEW.requested_at - make_interval(secs => cooldown) THEN
      RAISE EXCEPTION
        'probe-cooldown: % was probed at % and may be probed again after % (cooldown % seconds) — the cooldown is per DESTINATION, so another endpoint pointing at the same url shares it',
        left(NEW.endpoint_url, 200),
        previous,
        previous + make_interval(secs => cooldown),
        cooldown
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- The tenant's total, which nothing bounded before 0045.
  -- -----------------------------------------------------------------------
  -- Serialise the count-then-insert per tenant, FIRST. Without this, two administrators
  -- pressing test at the same moment on two different endpoints each read `used = max - 1`,
  -- each pass, and each commit: the ceiling holds at max+1 once per concurrent request.
  -- Verified by overlapping two real transactions in both configurations — see 0045's header.
  --
  -- XACT-scoped and never explicitly released: the row being inserted becomes visible to
  -- the next counter at COMMIT, so the lock has to reach COMMIT too. The namespace is 0045's
  -- number; the second half is a 32-bit hash of the tenant, where a collision costs one
  -- tenant's INSERT a brief wait on another's and cannot produce a wrong answer.
  PERFORM pg_advisory_xact_lock(45, hashtext(NEW.tenant_id::text));

  SELECT b.used, b.max_probes, b.window_seconds, b.next_slot_at
    INTO budget
    FROM crm.notification_probe_budget(NEW.tenant_id) b;

  IF budget.used >= budget.max_probes THEN
    RAISE EXCEPTION
      'probe-budget: tenant % has requested % of % permitted probes in the last % seconds and may probe again after % — a probe sends real traffic to a third party, and this bounds the total across every endpoint',
      NEW.tenant_id,
      budget.used,
      budget.max_probes,
      budget.window_seconds,
      budget.next_slot_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON COLUMN crm.notification_endpoint_probe.endpoint_url IS
  'Where this probe went, copied at request time (0070). The row outlives the endpoint, so a joined url would vanish with it — and the cooldown keys on this, because it protects a server rather than a row.';

-- ---------------------------------------------------------------------------
-- 3. The hazard dropping a cascade always brings, and where the answer had to go.
-- ---------------------------------------------------------------------------
--
-- With the key gone a probe can outlive its endpoint while still `requested`, and the claim joins
-- the live endpoint because a probe needs the `secret_env` this file deliberately does not copy.
-- An INNER join would therefore claim such a row in its first CTE and drop it from the result:
-- consumed every pass, never answered, never counted — 0046's hazard on the delivery table, one
-- subsystem over.
--
-- I WROTE A SETTLE FUNCTION FIRST, like 0069's, and this schema refused it. 0034's
-- `notification_endpoint_probe_settle_once` admits `requested → in_flight` and
-- `in_flight → complete` and nothing else, so a function moving a `requested` probe straight to
-- `complete` is refused by name — and that rule is RIGHT: an answer comes from a claim, or it is
-- an answer nobody obtained. The trigger caught a design that would have put a verdict on a row
-- no process ever ran.
--
-- So the answer lives where every other verdict is decided. The claim LEFT JOINs the endpoint,
-- hands the runner a probe with no secret and `endpoint_present = false`, and
-- `EndpointProbeRunner.outcomeFor` answers it `unknown` — 0034's verdict for "we cannot say",
-- beside the two cases already there ("no prober for this channel", "claimed too many times and
-- never answered"). `refused` would be a claim about a third party that never spoke, which is the
-- mistake 0069 corrected on the delivery table.
--
-- NOTHING IN SQL IS NEEDED FOR IT, which is why this section is a comment and not a function. It
-- is here because the next reader will look for one.
