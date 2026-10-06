-- 0045_probe_budget.sql
--
-- A CEILING ON A TENANT'S TOTAL OUTBOUND PROBE VOLUME, beside the per-endpoint cooldown
-- it completes.
--
-- ===========================================================================
-- WHAT WAS BROKEN
-- ===========================================================================
--
-- 0034 bounded the RATE PER DESTINATION and recorded this open item against itself, in
-- ADR-0001's words: "Nothing bounds a tenant's total outbound probe volume. The cooldown
-- is per endpoint, which is the right scope (each endpoint is a different third party and
-- a quiet one should not be rationed by a noisy one) — but endpoints per tenant are
-- uncapped, so three endpoints means three probes back to back inside one cooldown
-- window."
--
-- The per-endpoint scope is not the defect and is not changed here. The defect is that the
-- only bound in the schema scales with a number nothing caps. At the default 120-second
-- cooldown one endpoint can emit 30 probes an hour, so N endpoints emit 30N — and N is
-- whatever an administrator has typed into `crm.notification_endpoint`. Every one of those
-- is a signed POST to somebody else's server or an authenticated SMTP envelope walk
-- against somebody else's relay, so the quantity that needs a ceiling is the SUM, and
-- until now the sum had none.
--
-- ===========================================================================
-- WHAT THE BOUND BOUNDS: A COUNT PER ROLLING WINDOW
-- ===========================================================================
--
-- `probe_budget_max_probes` requests per tenant inside the last
-- `probe_budget_window_seconds`, counted over `requested_at` — which is deliberately the
-- same shape as the cooldown one paragraph above it in the same table: a lookback window
-- expressed in seconds, read from `crm.notification_policy`, measured against
-- `requested_at`, enforced in the same BEFORE INSERT trigger. An operator configuring two
-- limits on one table should not have to learn two unrelated mechanisms, and "how far back
-- do we look, and what do we allow in that span" is now the single question both answer.
-- The cooldown is that question with the count fixed at one and the scope fixed to one
-- endpoint; this is the same question per tenant with the count configurable.
--
-- TWO ALTERNATIVES WERE AVAILABLE AND ARE REJECTED.
--
--   A COUNT PER CALENDAR PERIOD (N a day, N a month) was rejected twice over. First, it
--   answers "when may I retry?" with a period boundary — "at midnight UTC" — which is the
--   wrong sentence to hand an administrator debugging a relay at 09:00, and is exactly the
--   failure 0034 capped the cooldown at a day to avoid: a limit that has become an outage.
--   Second, a period that RESETS admits a burst of 2N across its boundary while refusing N+1
--   inside it, so the thing it bounds is not the thing it is named after. A rolling window
--   has no boundary to straddle, and the moment a slot frees is a property of the traffic
--   that consumed it rather than of the calendar.
--
--   A CONCURRENCY LIMIT was rejected because it does not bound the stated exposure. The
--   schema already has a strictly stronger concurrency rule — one OUTSTANDING probe per
--   endpoint, 0034's partial unique index — and probes settle within a `notify_dispatch`
--   tick, so simultaneity was never the uncapped dimension. ADR-0001's sentence is about
--   SEQUENTIAL volume: "three endpoints means three probes back to back". A cap on how many
--   are in flight at once says nothing about how many go out in an hour, which is the number
--   the third parties at the far end experience.
--
-- AND A THIRD, NEARER MISS: A SECOND COOLDOWN APPLIED TENANT-WIDE. That is this rule with
-- the count fixed at one, and it reintroduces precisely what 0034's per-endpoint scope was
-- chosen to avoid — a quiet endpoint rationed by a noisy one, one tenant-wide clock making
-- the third endpoint an administrator is commissioning wait on the first. A count greater
-- than one over a longer window lets the legitimate burst (a person walking every endpoint
-- they have just configured) through untouched and bounds only the case where something is
-- producing probes faster than a person can.
--
-- ===========================================================================
-- WHERE THE PARAMETER LIVES, AND WHY THESE DEFAULTS
-- ===========================================================================
--
-- Beside the cooldown's own length on `crm.notification_policy`, for the reason 0034 gave
-- for putting it there: that table IS this tenant's notification configuration, and a
-- second single-row-per-tenant table would be a worse answer than another column.
--
-- 120 PROBES PER 3600 SECONDS, and both halves are a judgement stated as a judgement, in
-- the manner 0026 states its floor.
--
-- The ceiling has to clear the worst LEGITIMATE burst by a margin, because a limit that
-- trips on correct use is a limit operators learn to raise by reflex — 0026's argument
-- against a nightly nag, and the reason its floor exists at all. The worst legitimate burst
-- on this route is a human commissioning a deployment: walking every endpoint they have,
-- fixing a variable name, walking the failures again. Every round trip in that loop costs a
-- person a minute or two of reading a verdict and editing configuration, so even an
-- unusually bad session — twenty endpoints, four rounds — is eighty probes and takes most of
-- an hour to produce. 120 an hour is a probe every thirty seconds sustained for a full hour,
-- which is not a rate a human hand produces.
--
-- And it has to bite on the misconfigured case. It does so in the dimension that was
-- uncapped: a client looping this route is held to 30 probes an hour PER ENDPOINT by the
-- cooldown, so the budget starts refusing once a tenant has five endpoints under machine
-- retry and refuses harder with every endpoint after that — 50 endpoints would otherwise
-- emit 1,500 an hour and are now held to 120. That is the whole point of the row this file
-- closes: the ceiling stops depending on how many endpoints exist.
--
-- THE WINDOW IS AN HOUR BECAUSE THE WINDOW IS ALSO THE LOCKOUT. The worst a tripped budget
-- costs is the wait until the oldest probe inside the window rolls out of it, which is at
-- most one window and usually much less. An hour is long enough for the count to describe a
-- burst and short enough that being wrong about the number is an inconvenience rather than
-- 0034's "cooldown that has become an outage".
--
-- THE FLOOR OF THE COUNT IS 1, NOT 0, AND THAT IS A DELIBERATE DIVERGENCE FROM THE
-- COOLDOWN. 0034 permits `probe_cooldown_seconds = 0` and argues it well: a cooldown
-- protects a THIRD PARTY from traffic, and a tenant whose endpoint is a sink on its own
-- loopback has no third party to protect. That argument does not transfer, for two reasons.
-- A tenant with the cooldown at 0 has already given up its only per-destination bound, so
-- this is the only bound left — and a 0 here would be exactly the thing 0026 refuses to
-- ship: a guard disabled by a value that does not look like a disabled guard, set once for
-- one night's reason and outliving it silently. A tenant that genuinely wants no practical
-- bound raises the number, which reads as a configured ceiling in the policy row and not as
-- an absence. That is 0026's reasoning for stopping its share ceiling at 99 rather than
-- letting it reach 100.
--
-- The ceiling of the count is 3,600: one probe a second sustained, past which the number has
-- stopped being a statement about anybody's inbox. The window's bounds are 60 seconds (a
-- window shorter than a minute cannot tell a burst from a person, and this limit exists to
-- never trip on a person) and 86,400 — the cooldown's own ceiling, for the cooldown's own
-- reason, because beyond a day a refusal outlives the working day of whoever has to act on
-- it.
--
-- ===========================================================================
-- THE REFUSAL: ATTRIBUTABLE, 429, AND IT NAMES THE MOMENT
-- ===========================================================================
--
-- A second limit on the same route that reads differently from the first is worse than no
-- second limit, so this one is built to the cooldown's pattern exactly:
--
--   * `probe-budget:` is a STABLE MARKER at the head of the RAISE message, matched by
--     `translateProbeError` in `packages/notify/src/probe.ts` the way `probe-cooldown:`,
--     `probe-outstanding:` and `probe-foreign-endpoint:` already are, and the way 0033's and
--     0040's triggers are matched. The prose after it is free to improve; the marker is the
--     contract.
--
--   * It carries WHEN A RETRY BECOMES LEGAL, as the cooldown's does, because that is the
--     only actionable half of a rate-limit refusal. `crm.notification_probe_budget` computes
--     it exactly rather than approximately: the row that has to age out of the window before
--     the count falls under the ceiling is the one at offset `used - max` in ascending
--     `requested_at` order, which is the oldest when the count is exactly at the ceiling and
--     correctly later when a ceiling has just been LOWERED under a tenant already over it.
--     Reporting the oldest row's expiry in that second case would name a moment at which the
--     retry still fails.
--
--   * It raises `check_violation`, which `problems.ts` maps to 429 and not 409 — this is
--     rate limiting, the state of the system is fine, only the pace is not. The same
--     distinction 0034 drew between its cooldown and its outstanding rule.
--
-- WHY IT IS TESTED AFTER THE COOLDOWN AND NOT BEFORE. 0034 orders its refusals so the
-- better-aimed sentence wins, and per-endpoint beats per-tenant for aim: "you asked about
-- THIS endpoint two minutes ago, wait until 09:04" tells an administrator what to do, where
-- "your tenant has spent its hourly budget" would hide that from them for the whole window.
-- It also puts the budget's refusal exactly where ADR-0001 says the gap is — it becomes
-- reachable only once a tenant is spreading probes ACROSS endpoints, which is the dimension
-- the cooldown deliberately does not see. The cheaper check running first is a convenience,
-- not the reason.
--
-- ===========================================================================
-- WHY A LOCK, AND WHY IT HAS TO BE AN XACT LOCK
-- ===========================================================================
--
-- 0034's own header says why a trigger is not enough on its own: "a trigger reads rows
-- another transaction has not committed yet, and two simultaneous requests are settled by
-- the unique index alone." Two administrators pressing test at the same moment on two
-- DIFFERENT endpoints pass the cooldown legitimately, and would each count the same
-- `used = max - 1` and each commit. The ceiling would then hold at max+1, max+2, … once per
-- concurrent request, which is a ceiling in name only.
--
-- A PARTIAL UNIQUE INDEX CANNOT EXPRESS THIS. An index enforces "at most one row per key";
-- it has no way to say "at most N rows in a moving span". The two structural answers that
-- remain are a materialised per-tenant counter row whose UPDATE row-lock serialises the
-- increment, and a lock. The counter was rejected: it can only count into a BUCKET, so it
-- drags the calendar-period semantics back in through the implementation after they were
-- rejected on their merits above, and it adds a row that can disagree with the table it
-- summarises.
--
-- So: `pg_advisory_xact_lock` keyed on the tenant, taken inside the guard immediately
-- before the count. Two facts make it sufficient, and both were verified against a real
-- cluster with two overlapping transactions rather than reasoned about:
--
--   1. The lock is XACT-SCOPED, not session-scoped with a matching unlock. It must be held
--      until COMMIT, because the whole point is that the row this transaction is inserting
--      becomes visible to the next counter at exactly that instant. A lock released at the
--      end of the trigger would hand the second transaction a count that still excludes the
--      first row — the race, restored, with a lock in front of it.
--
--   2. A statement inside a VOLATILE plpgsql function takes a FRESH snapshot in READ
--      COMMITTED. So the second transaction, having waited at the lock while the first
--      transaction's INSERT statement was already in flight, counts on a snapshot taken
--      after the first committed and SEES its row. Measured: without the lock both
--      transactions commit and the tenant ends over its ceiling; with it, the second is
--      refused with `probe-budget`.
--
-- THE KEY IS (45, hashtext(tenant_id)) — this migration's number as the namespace, so the
-- lock cannot be confused with another use of the advisory space, and a 32-bit hash of the
-- tenant for the second half. A hash collision between two tenants costs one tenant's probe
-- INSERT waiting on another tenant's, on a route an administrator drives by hand; it cannot
-- produce a wrong answer, only a brief wait. The lock is held to the end of the caller's
-- transaction by construction, which is worth knowing when a caller wraps a probe request
-- in a long transaction: it will serialise other probe requests for the same tenant for
-- that whole span. `requestProbe` is one INSERT and a SELECT.
--
-- ===========================================================================
-- THE RETENTION RING WAS REFUNDING THE BUDGET, AND IS CORRECTED HERE
-- ===========================================================================
--
-- This is the part that was not obvious and is the reason this file touches a second
-- function. 0034's ring keeps the newest 20 COMPLETE probes per endpoint and trims the rest
-- on insert. The budget counts rows in `crm.notification_endpoint_probe` inside the window.
-- Those two facts together mean the ring was handing budget back: a 21st probe on one
-- endpoint deletes the 1st, the count stays at 21, and the tenant can keep going.
--
-- The consequence is not marginal. With the cooldown at its default an endpoint emits 30
-- probes an hour and retains 21 of them, so the budget undercounts by nine per endpoint per
-- hour; and with the cooldown at 0 — which 0034 explicitly permits — a single endpoint can
-- emit UNBOUNDED probes an hour while never retaining more than 21 rows, so the budget would
-- not have been a bound at all in exactly the configuration that has no other one.
--
-- THE RULE, THEREFORE: the ring may not delete a row the budget is still counting. It keeps
-- the newest 20 complete per endpoint as before, AND anything inside the tenant's budget
-- window. That is strictly MORE retention than 0034 promised and never less, so no history
-- anybody relied on disappears; what changes is that "exactly 20" becomes "at least 20". The
-- table stays bounded with no scheduled job to wire up, which is what the ring is for — per
-- endpoint it now holds at most 20 plus whatever is inside the window, and what is inside
-- the window is what the budget caps.
--
-- Stated the other way round, because it is the honest summary: a bound computed from rows
-- cannot also be the reason those rows are deleted. One of the two had to give, and
-- retention is the one with no safety argument behind its exact number.
--
-- WHAT IS STILL NOT CLOSED, and is inherited rather than introduced. Deleting an endpoint
-- cascades its probes away, which drops them out of the count and refunds the budget for the
-- rest of the window. 0034's cooldown has the identical hole for the identical reason — it
-- reads `max(requested_at)` for an endpoint, so delete-and-recreate clears it — and closing
-- it means counting from a ledger that does not cascade from the endpoint, which is a table
-- rather than a column and is not what ADR-0001's row asks for. Both holes cost an
-- administrator one deliberate destructive act per refund.
--
-- ===========================================================================
-- RE-APPLICATION
-- ===========================================================================
--
-- `CREATE OR REPLACE` on every object, including `CREATE OR REPLACE TRIGGER` (Postgres 14+;
-- this repo is on 16), following 0040 and in its words: the migration runner wraps a whole
-- file in one transaction, but `scripts/setup-test-db.sh` applies files through `psql`
-- WITHOUT `-1`, where each statement commits on its own — so the atomicity has to be in the
-- statement rather than assumed from the caller. A `DROP TRIGGER IF EXISTS` then `CREATE`
-- would leave a committed instant in which `crm.notification_endpoint_probe` has no guard at
-- all, inside the file whose purpose is that it always has one.
--
-- The two ALTER TABLE statements are not idempotent and are not made so. A column that
-- already exists means this file has already been applied, and `crm._migrations` is what
-- decides that; `ADD COLUMN IF NOT EXISTS` would turn a hash-ledger question into a silent
-- one. There is nothing to backfill: both columns are NOT NULL with a DEFAULT, so every
-- existing policy row acquires the defaults, and the guard already COALESCEs an absent
-- policy row to the same numbers.

-- ---------------------------------------------------------------------------
-- 1. The two parameters, beside the cooldown's length.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_policy
  ADD COLUMN probe_budget_max_probes     integer NOT NULL DEFAULT 120,
  ADD COLUMN probe_budget_window_seconds integer NOT NULL DEFAULT 3600;

ALTER TABLE crm.notification_policy
  -- Floor 1, not 0: see the header on why this diverges from the cooldown, which may be
  -- disabled and this may not. Ceiling 3,600 — one a second sustained — so the column
  -- cannot hold a number that is a disabled guard wearing a value's clothes.
  ADD CONSTRAINT notification_policy_probe_budget_max
    CHECK (probe_budget_max_probes BETWEEN 1 AND 3600),

  -- A minute is the shortest span that can tell a burst from a person. A day is the longest
  -- a refusal may outlive, which is 0034's ceiling for its cooldown and the same sentence.
  ADD CONSTRAINT notification_policy_probe_budget_window
    CHECK (probe_budget_window_seconds BETWEEN 60 AND 86400);

-- ---------------------------------------------------------------------------
-- 2. The parameters as the guard reads them, in one place.
-- ---------------------------------------------------------------------------
/**
 * This tenant's budget configuration, with the defaults an absent policy row means.
 *
 * A tenant that has never configured retention has no row in `crm.notification_policy`, and
 * that absence must read as the defaults rather than as "no budget" — the fail-closed
 * reading, and the one 0034 gives for the cooldown. Its own function because THREE callers
 * need it (the request guard, the retention ring and `crm.notification_probe_budget`) and a
 * default written out three times is a default that will be changed in two places.
 *
 * The LEFT JOIN from a one-row source is what makes the result a row rather than no row: a
 * plain `SELECT … WHERE tenant_id = p_tenant` returns nothing for an unconfigured tenant,
 * and `SELECT … INTO` against nothing leaves the caller's variables NULL, which is the
 * shape of this bug rather than a defence against it.
 */
CREATE OR REPLACE FUNCTION crm.notification_probe_budget_config(p_tenant uuid)
RETURNS TABLE (max_probes integer, window_seconds integer)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p.probe_budget_max_probes, 120),
         COALESCE(p.probe_budget_window_seconds, 3600)
    FROM (SELECT p_tenant AS t) AS one
    LEFT JOIN crm.notification_policy p ON p.tenant_id = one.t;
$$;

-- ---------------------------------------------------------------------------
-- 3. The budget's state: the one place that decides.
-- ---------------------------------------------------------------------------
/**
 * How much of the window a tenant has spent, and when the next slot frees.
 *
 * In SQL next to the rows it reads, for 0026's reason: an operator — and the admin route
 * that reads it — can ask the question BEFORE a refusal answers it. A limit you can only
 * discover by tripping it is the thing `GET /v1/admin/notifications/prune-candidates` exists
 * to avoid, and the guard below and any reader must give the same number or the answer is
 * worse than none.
 *
 * `next_slot_at` is NULL while the tenant is under its ceiling, because a slot is free now
 * and naming a future moment would read as a refusal that has not happened. Over the
 * ceiling it is the offset-`used - max` row's `requested_at` plus the window: the oldest row
 * when the count sits exactly at the ceiling, and correctly a later row when a ceiling has
 * just been lowered under a tenant already above it — where naming the oldest would promise
 * a retry that still fails.
 *
 * STABLE, not IMMUTABLE: it reads two tables and `now()`. Counted under the caller's own row
 * security, which needs no predicate of its own to be safe — `crm.notification_policy` and
 * `crm.notification_endpoint_probe` are both FORCE RLS with a `tenant_id` policy, and 0002's
 * policy is the INSERT check too, so a probe row cannot exist outside the tenant whose
 * context wrote it. `p_tenant` is still passed and still filtered on: it is what the
 * `(tenant_id, seq)` index is for, and it keeps the function answerable about one tenant
 * from a context that could see several.
 */
CREATE OR REPLACE FUNCTION crm.notification_probe_budget(p_tenant uuid)
RETURNS TABLE (used bigint, max_probes integer, window_seconds integer, next_slot_at timestamptz)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    SELECT c.max_probes, c.window_seconds FROM crm.notification_probe_budget_config(p_tenant) c
  ),
  inside AS (
    SELECT q.requested_at
      FROM crm.notification_endpoint_probe q, cfg
     WHERE q.tenant_id = p_tenant
       -- Strictly greater, so the window is half-open exactly as the cooldown's
       -- `previous > NEW.requested_at - interval` is. A probe is spent for the window's
       -- length and then it is not.
       AND q.requested_at > now() - make_interval(secs => cfg.window_seconds)
     ORDER BY q.requested_at
  )
  SELECT (SELECT count(*) FROM inside),
         cfg.max_probes,
         cfg.window_seconds,
         CASE WHEN (SELECT count(*) FROM inside) >= cfg.max_probes
              THEN (SELECT i.requested_at + make_interval(secs => cfg.window_seconds)
                      FROM inside i
                    OFFSET (SELECT count(*) FROM inside) - cfg.max_probes
                     LIMIT 1)
              ELSE NULL END
    FROM cfg;
$$;

-- ---------------------------------------------------------------------------
-- 4. The request guard, with the budget as its last refusal.
-- ---------------------------------------------------------------------------
/**
 * 0034's guard, unchanged in its first three rules and with a fourth appended.
 *
 * Reproduced in full rather than patched, because `CREATE OR REPLACE FUNCTION` replaces a
 * body outright and there is no other way to express it. The tenant pairing, the outstanding
 * check, the overwritten clock and the cooldown are 0034's, byte for byte including their
 * comments — the point of this file is to add a bound, not to re-litigate them.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_tenant uuid;
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

  -- -----------------------------------------------------------------------
  -- The tenant's total, which nothing bounded before this migration.
  -- -----------------------------------------------------------------------
  -- Serialise the count-then-insert per tenant, FIRST. Without this, two administrators
  -- pressing test at the same moment on two different endpoints each read `used = max - 1`,
  -- each pass, and each commit: the ceiling holds at max+1 once per concurrent request.
  -- Verified by overlapping two real transactions in both configurations — see the header.
  --
  -- XACT-scoped and never explicitly released: the row being inserted becomes visible to
  -- the next counter at COMMIT, so the lock has to reach COMMIT too. The namespace is this
  -- migration's number; the second half is a 32-bit hash of the tenant, where a collision
  -- costs one tenant's INSERT a brief wait on another's and cannot produce a wrong answer.
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

-- Replaced rather than dropped and recreated, so there is no committed instant in which the
-- table has no request guard. See the header on `setup-test-db.sh` applying without `-1`.
CREATE OR REPLACE TRIGGER notification_endpoint_probe_guard
  BEFORE INSERT ON crm.notification_endpoint_probe
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_probe_guard();

-- ---------------------------------------------------------------------------
-- 5. The retention ring, which may no longer refund the budget.
-- ---------------------------------------------------------------------------
/**
 * Keeps the newest 20 COMPLETE probes per endpoint, AND anything inside the tenant's budget
 * window, trimmed by the insert that makes an older row redundant.
 *
 * The first clause and the per-endpoint scope are 0034's and its reasons are unchanged: a
 * probe result is operational rather than audit, the useful answer is the most recent one,
 * and a tenant with forty endpoints keeps forty histories instead of one endpoint's
 * debugging session evicting everyone else's. An outstanding probe is still never a
 * candidate — it has no answer to keep and deleting it would silently cancel a request
 * somebody is waiting on.
 *
 * WHAT IS NEW IS THE WINDOW CLAUSE, and the header argues it at length: the budget is
 * computed from these rows, so a ring that deletes one inside the window hands the tenant
 * its slot back. With the cooldown at 0 — permitted — that made the budget no bound at all
 * on a single endpoint, because the row count stalls at 21 however many probes are sent.
 *
 * The table remains bounded, which is the ring's whole purpose: per endpoint, at most 20
 * complete rows outside the window plus whatever lies inside it, and what lies inside it is
 * exactly what `probe_budget_max_probes` caps. The two bounds now hold each other up instead
 * of one quietly dissolving the other.
 *
 * The window comes from `crm.notification_probe_budget_config`, so the ring and the guard
 * cannot disagree about where the window starts. Reading it costs one indexed lookup on a
 * path an administrator drives by hand.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_probe_trim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  win integer;
BEGIN
  SELECT c.window_seconds INTO win
    FROM crm.notification_probe_budget_config(NEW.tenant_id) c;

  DELETE FROM crm.notification_endpoint_probe p
   WHERE p.endpoint_id = NEW.endpoint_id
     AND p.state = 'complete'
     -- Inverted from the budget's own predicate on purpose: the budget counts
     -- `requested_at > now() - window`, so the ring may only touch the complement. Writing
     -- it as the complement rather than as a second threshold is what makes "the ring never
     -- deletes a row the budget counts" true by construction instead of by arithmetic.
     AND NOT (p.requested_at > now() - make_interval(secs => win))
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

CREATE OR REPLACE TRIGGER notification_endpoint_probe_trim
  AFTER INSERT ON crm.notification_endpoint_probe
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_probe_trim();
