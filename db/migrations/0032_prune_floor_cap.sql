-- 0032_prune_floor_cap.sql
--
-- THE PRUNE GUARD'S FLOOR WAS A PERMANENT, UNATTRIBUTED, NON-EXPIRING BYPASS.
--
-- 0026 ships two knobs and spends four paragraphs on why one of them is a window:
--
--   "the obvious override — a boolean column, or a `force` option on the nightly job —
--    fails the only test that matters: it gets set once, for one night's reason, and then
--    outlives the reason, silent and permanent"
--
-- and then gives the other knob exactly those properties. `prune_guard_floor_rows` is the
-- left operand of an AND, so it short-circuits the ceiling entirely:
--
--   SELECT crm.notification_prune_guard_trips(900000, 1000000, 25, 1000000);  -- false
--
-- A single `PUT /v1/admin/notifications/prune-guard {"guardFloorRows": 1000000}` — no
-- expiry, no grantor recorded, not reported as `overridden` — let a pass that deletes 90%
-- of a million-row inbox through the guard every night, and the scheduler's summary line
-- read like a normal pass. The ceiling is capped at 99 because "a ceiling that permits
-- 100% is not a ceiling"; the floor was capped at a million, which is not a floor.
--
-- TWO CHANGES, AND NEITHER IS A THIRD KNOB.
--
-- 1. The floor is capped at 1000 rows. 0026 says what the floor is for — "the count below
--    which the share is not consulted at all ... beneath about a hundred rows the ratio is
--    noise" — and that purpose is served in the hundreds. 1000 is ten times the default
--    and three orders of magnitude below the old cap, so the worst a misconfigured floor
--    can now cost is a thousand rows before the tripwire fires, which is a number an
--    operator can read and recover from. A tenant that genuinely wants more deleted
--    unattended raises the CEILING, which is reported, or opens the OVERRIDE WINDOW, which
--    names them and expires.
--
--    Existing rows are clamped rather than the migration failing. A floor above the new
--    cap is a bypass somebody is relying on tonight; refusing to deploy leaves it in place,
--    and clamping removes it, which is the direction this migration exists to go.
--
-- 2. The ceiling becomes separately askable, so the floor can no longer hide it.
--    `notification_prune_ceiling_exceeded` is the right-hand operand of the AND, lifted
--    into its own function, and `notification_prune_guard_trips` is redefined in terms of
--    it — one rule, one place, exactly as before, but now a caller can see the case the
--    old function could not express: the pass is over the ceiling AND the floor waived it.
--    `prunePreview` and `pruneNotifications` report that as `floorWaived`, so a pass the
--    floor let through no longer reads like a pass that was within its ceiling.

-- ---------------------------------------------------------------------------
-- 1. The cap.
-- ---------------------------------------------------------------------------
UPDATE crm.notification_policy
   SET prune_guard_floor_rows = 1000, updated_at = now()
 WHERE prune_guard_floor_rows > 1000;

ALTER TABLE crm.notification_policy
  DROP CONSTRAINT notification_policy_prune_guard_floor;
ALTER TABLE crm.notification_policy
  ADD CONSTRAINT notification_policy_prune_guard_floor
    CHECK (prune_guard_floor_rows BETWEEN 0 AND 1000);

-- ---------------------------------------------------------------------------
-- 2. The ceiling, askable on its own.
-- ---------------------------------------------------------------------------
/**
 * Is this pass over the tenant's share ceiling?
 *
 * Integer arithmetic, for the reason 0026 gives: `p_prunable * 100 > p_max_share *
 * p_inbox_total` is exact, needs no guard against an empty inbox, and cannot trip at a
 * boundary the reported percentage rounds the other way.
 */
CREATE OR REPLACE FUNCTION crm.notification_prune_ceiling_exceeded(
  p_prunable    bigint,
  p_inbox_total bigint,
  p_max_share   integer
)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_prunable * 100 > p_max_share::bigint * p_inbox_total;
$$;

/**
 * Does this prune take too much of the inbox to run unattended?
 *
 * Unchanged in behaviour and now defined in one place each: the ceiling above, the floor
 * here. Replacing the body rather than adding a second function, so there is no way for
 * the two to answer differently.
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
     AND crm.notification_prune_ceiling_exceeded(p_prunable, p_inbox_total, p_max_share);
$$;
