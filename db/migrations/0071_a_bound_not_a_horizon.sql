-- A bound on a tenant's destinations, and a horizon this file deliberately refuses to add.
--
-- THE LAST CLAUSE OF ADR-0001's ENDPOINT ROW: "`crm.notification_endpoint` with no horizon and no
-- cap while every replacement adds a row". The other two clauses are closed — 0069 gave an
-- unsendable push a settled state retention can reach, and 0070 detached the probes so a deletion
-- neither erases the record that a destination was tested nor refunds the hourly budget those rows
-- are counted for.
--
-- WHAT THIS DOES NOT ADD, AND WHY. A horizon means deleting disabled endpoints after some period,
-- and this schema's whole posture on this subsystem is the opposite one. 0048 dropped a cascade so
-- a delivery record outlives its endpoint; 0049 froze a live endpoint's destination so its history
-- cannot be re-attributed; 0060 made the amendment log the source of truth and refused a direct
-- UPDATE; 0070 did 0048's move a third time. Every one of those decisions says the same thing: the
-- record of where a tenant's signals went is worth more than the tidiness of the configuration
-- table. A horizon would delete the one row that explains what a surviving delivery's copied url
-- meant, and it would do it on a schedule, unattributed — `crm.record_config_change` fires AFTER
-- INSERT OR UPDATE and not on DELETE, which is exactly why 0062 made a withdrawal a nullable-column
-- amendment rather than a deletion. A sweep that quietly removed configuration would be the one
-- write in this schema nobody signed.
--
-- SO THE BOUND IS A CAP, and a cap is a better answer than a horizon for the specific complaint:
-- unbounded growth comes from REPLACEMENT, which is an act somebody performs, where a horizon
-- answers it with a deletion nobody performs. A cap refuses the act, at the moment it happens, to
-- the person performing it, and names what to do instead.
--
-- PER TENANT AND RAISABLE, like 0045's probe budget and 0034's cooldown, rather than a constant in
-- SQL. Fifty is a number nobody should reach — a tenant with three channels and a handful of
-- destinations, rotating a url a few times a year, reaches it after decades — and a number this
-- file cannot know is right for everybody is a number the tenant has to be able to move. The hard
-- ceiling in the CHECK is 500: above that the fan-out per signal is the problem rather than the
-- table, and `raiseNotification` writes one delivery row per matching endpoint.
--
-- THE REFUSAL NAMES BOTH WAYS OUT, which is what makes a cap a bound rather than a cliff:
-- RE-ENABLE a disabled endpoint that already points where you want (the amendment log admits it,
-- and reusing the row keeps one destination's history in one place), or RAISE the cap, which is a
-- configuration change with an author and a reason like any other. Without that sentence a tenant
-- at the cap has a 409 and no next step.

-- ---------------------------------------------------------------------------
-- 1. The number, where the other notification numbers live.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_policy
  ADD COLUMN max_endpoints integer NOT NULL DEFAULT 50
    CHECK (max_endpoints BETWEEN 1 AND 500);

COMMENT ON COLUMN crm.notification_policy.max_endpoints IS
  'How many notification endpoints this tenant may hold, disabled ones included. A bound on the table rather than a horizon over it: configuration here is never deleted, because a delivery record outliving its endpoint (0048) is only legible while the endpoint row explains its copied url.';

/**
 * What a tenant holds against what it may hold.
 *
 * Shaped like `crm.notification_probe_budget` and for the same reasons: the count and the ceiling
 * come back together, because a refusal that cannot say "47 of 50" is a refusal nobody can act on,
 * and a caller that wants to warn before the wall needs both numbers in one read.
 *
 * A TENANT WITH NO POLICY ROW GETS THE DEFAULT, not "no cap" — the fail-closed reading 0034 gives
 * the cooldown and 0045 gives the budget, and the one that matches what `notificationPolicy()`
 * would have written had anybody asked. `crm.notification_policy` is created on first write, so
 * most tenants have no row for most of their life.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_cap(p_tenant uuid)
RETURNS TABLE (used bigint, max_endpoints integer)
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM crm.notification_endpoint e WHERE e.tenant_id = p_tenant),
         COALESCE((SELECT p.max_endpoints FROM crm.notification_policy p
                    WHERE p.tenant_id = p_tenant), 50);
$$;

-- ---------------------------------------------------------------------------
-- 2. The guard, with 0045's lock and 0045's reason for it.
-- ---------------------------------------------------------------------------
/**
 * Refuses an endpoint past the tenant's cap.
 *
 * SERIALISED PER TENANT, FIRST, and this is not caution: 0045 verified the failure by overlapping
 * two real transactions. Without the lock, two administrators creating an endpoint in the same
 * moment each read `used = max - 1`, each pass, and each commit — the ceiling holds at `max + 1`
 * once per concurrent request. XACT-scoped and never released explicitly, because the row being
 * inserted becomes visible to the next counter only at COMMIT, so the lock has to reach COMMIT
 * too. The namespace is this migration's number; the second half is a 32-bit hash of the tenant,
 * where a collision costs one tenant's INSERT a brief wait on another's and cannot produce a wrong
 * answer.
 *
 * COUNTED AFTER THE LOCK AND BEFORE THE INSERT, so the number in the refusal is the number that
 * refused it.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_cap_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap record;
BEGIN
  PERFORM pg_advisory_xact_lock(71, hashtext(NEW.tenant_id::text));

  SELECT c.used, c.max_endpoints INTO cap
    FROM crm.notification_endpoint_cap(NEW.tenant_id) c;

  IF cap.used >= cap.max_endpoints THEN
    RAISE EXCEPTION
      'endpoint-cap: tenant % already holds % of % permitted notification endpoints, disabled ones included — re-enable a disabled endpoint that already points where you want (one destination, one row, one history), or raise crm.notification_policy.max_endpoints, which is a configuration change with an author and a reason',
      NEW.tenant_id, cap.used, cap.max_endpoints
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- BEFORE INSERT only. An amendment cannot add a row, and a tenant sitting ABOVE a cap it has just
-- lowered must still be able to disable and re-point what it has: a guard on UPDATE would freeze
-- the configuration of exactly the tenant trying to tidy it up. Lowering the cap is therefore
-- allowed to leave a tenant over it, which the CHECK on the column deliberately does not prevent
-- either — the cap governs the act of adding, not the state of the table.
CREATE OR REPLACE TRIGGER notification_endpoint_cap
  BEFORE INSERT ON crm.notification_endpoint
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_cap_guard();

COMMENT ON FUNCTION crm.notification_endpoint_cap_guard() IS
  'Refuses an endpoint past crm.notification_policy.max_endpoints. BEFORE INSERT only: the cap governs the act of adding a destination, not the state of a table a tenant may be tidying.';
