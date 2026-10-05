-- 0026_prune_guard.sql
--
-- A ceiling on how much one prune may take.
--
-- WHAT WAS BROKEN. 0024 bounded the inbox and recorded this open item against itself: a
-- prune is irreversible and there is no undo, so the two horizons are the only thing
-- standing between a tenant and a deleted inbox. An administrator who means to type 365
-- into `retain_unread_days` and types 1 loses a year of unread messages that night, and
-- the first evidence of it is a job summary saying how many it took. Every other safety
-- rule in 0024 — the two horizons, the CHECK between them, the open-subject exemption —
-- assumes the two numbers themselves are right.
--
-- THE RULE. A pass that would delete more than `prune_max_share_percent` of the tenant's
-- inbox deletes NOTHING and says why. Not a reduced amount: a half-applied prune is
-- still irreversible, and it leaves the operator unable to tell whether the number in
-- front of them is the whole mistake or a slice of it. Refusing wholesale is the only
-- reading that puts a human in front of the data while it still exists.
--
-- A SHARE, NOT AN ABSOLUTE ROW CAP. Both were available and the choice is the design.
-- An absolute cap protects the wrong tenants: pick 5,000 and a tenant holding two
-- million notifications can never run a legitimate steady-state prune; pick 500,000 and
-- a tenant holding 800 loses all 800 without the guard noticing. The failure being
-- defended against is a horizon wrong by an order of magnitude, and that failure has the
-- same signature at every scale — it takes most of the inbox at once, where a correct
-- nightly prune takes a day's worth. A share reads that signature identically for the
-- tenant with 800 rows and the tenant with two million. An absolute cap would mostly
-- slow legitimate first prunes down, which is the one thing a guard must not do.
--
-- AN ABSOLUTE NUMBER APPEARS ANYWAY — AS A FLOOR, NOT A SECOND CEILING.
-- `prune_guard_floor_rows` (100) is the count below which the share is not consulted at
-- all. Beneath about a hundred rows the ratio is noise: a tenant holding nine
-- notifications with seven past their horizon sits at 78% and has nothing to lose, and
-- refusing that pass makes the guard a nightly nag that operators learn to override by
-- reflex — strictly worse than no guard. So: a percentage for the decision, an absolute
-- number for when the decision is worth making.
--
-- THE SHARE IS MEASURED AGAINST WHAT THE PASS WANTS, NOT WHAT IT WOULD TAKE TONIGHT.
-- 0024's 50,000-row cap is a BATCH size — a throttle that reports `moreRemaining` and
-- drains a backlog over several nights. Judging the guard on the batched number would
-- make it useless exactly where it matters: a tenant with two million notifications and
-- a one-day horizon would see 50,000 rows (2.5% of the inbox) proposed every night, pass
-- the check every night, and have an empty inbox in forty nights with no refusal ever
-- logged. So the guard is computed from the FULL count past the horizon and the batch cap
-- is applied afterwards. A pass that hits the batch cap is normal; a pass that trips the
-- guard is not; the two numbers are never the same question.
--
-- THE CEILING STOPS AT 99. A ceiling that permits 100% is not a ceiling, and stored as a
-- number it would not look like one — the policy row would read like a configured value
-- rather than a disabled guard. Emptying an inbox in one pass stays possible, but only by
-- saying so for a bounded window, which is the next paragraph.
--
-- THE OVERRIDE IS A WINDOW, NOT A FLAG. A tenant turning retention on after a year of
-- growth has a legitimate backlog that IS most of its inbox and must be able to drain it;
-- a guard with no way past it is a blocker rather than a speed bump. But the obvious
-- override — a boolean column, or a `force` option on the nightly job — fails the only
-- test that matters: it gets set once, for one night's reason, and then outlives the
-- reason, silent and permanent, so the next horizon typo goes through unguarded. This
-- override is three columns that cannot be any of those things: who granted it, when, and
-- until when, with a CHECK bounding the window to at most seven days from the moment it
-- was granted. It is NULL by default, it names a person, it expires on its own, and
-- renewing it is another deliberate act by somebody who has to look at the number again.
--
-- THE CONSEQUENCE WORTH KNOWING. The guard refuses a pass; it never trims one. A tenant
-- whose first prune is genuinely 90% of its inbox will be refused every night until
-- somebody grants a window. That is the intended trade: the alternative is a guard that
-- cannot tell that case apart from the typo it exists to catch.

-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_policy
  -- The ceiling. 25% by default: comfortably above any steady-state nightly prune —
  -- which is one day of a year's retention, well under a percent — and far below the
  -- share a horizon short by an order of magnitude takes.
  ADD COLUMN prune_max_share_percent integer NOT NULL DEFAULT 25,

  -- The floor. See the header: this is when to bother deciding, not a second ceiling.
  ADD COLUMN prune_guard_floor_rows integer NOT NULL DEFAULT 100,

  -- The break-glass window. All three NULL is the normal state of a tenant.
  ADD COLUMN prune_guard_override_by         text,
  ADD COLUMN prune_guard_override_granted_at timestamptz,
  ADD COLUMN prune_guard_override_until      timestamptz;

ALTER TABLE crm.notification_policy
  ADD CONSTRAINT notification_policy_prune_max_share
    CHECK (prune_max_share_percent BETWEEN 1 AND 99),

  ADD CONSTRAINT notification_policy_prune_guard_floor
    CHECK (prune_guard_floor_rows BETWEEN 0 AND 1000000),

  -- A window with no grantor, or a grantor with no window, is a half-written override and
  -- the prune would have to guess which half to believe. Either all three or none.
  ADD CONSTRAINT notification_policy_prune_override_whole
    CHECK (num_nulls(prune_guard_override_by, prune_guard_override_granted_at,
                     prune_guard_override_until) IN (0, 3)),

  ADD CONSTRAINT notification_policy_prune_override_named
    CHECK (prune_guard_override_by IS NULL
           OR length(prune_guard_override_by) BETWEEN 1 AND 200),

  -- What makes the override temporary, in the database rather than in the caller. The
  -- span is bounded here; the ANCHOR is `now()` in `grantPruneGuardOverride`, which is the
  -- only writer — a CHECK cannot reference the clock and stay immutable, so bounding the
  -- distance between two stored columns is the enforceable half of "at most seven days".
  ADD CONSTRAINT notification_policy_prune_override_bounded
    CHECK (prune_guard_override_until IS NULL
           OR (prune_guard_override_until >  prune_guard_override_granted_at
           AND prune_guard_override_until <= prune_guard_override_granted_at
                                             + interval '7 days'));

-- ---------------------------------------------------------------------------

/**
 * Does this prune take too much of the inbox to run unattended?
 *
 * In SQL, next to the columns it reads, so an operator can ask the question of a
 * candidate count before a job answers it — the same reason 0024 made the candidate set a
 * view instead of a function body.
 *
 * Integer arithmetic rather than a ratio: `p_prunable * 100 > p_max_share * p_inbox_total`
 * is exact, needs no guard against an empty inbox, and cannot trip at a boundary the
 * reported percentage rounds the other way.
 */
CREATE OR REPLACE FUNCTION crm.notification_prune_guard_trips(
  p_prunable    bigint,
  p_inbox_total bigint,
  p_max_share   integer,
  p_floor_rows  integer
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_prunable > p_floor_rows
     AND p_prunable * 100 > p_max_share::bigint * p_inbox_total;
$$;
