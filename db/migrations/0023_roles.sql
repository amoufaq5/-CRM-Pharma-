-- 0023_roles.sql
--
-- "Who in this tenant may configure it?"
--
-- WHAT WAS BROKEN. Two increments in a row declined to build an admin write route
-- with the same sentence: every principal in the API is a rep profile, so there is
-- nothing to restrict an administrative write to. `crm.disposal_policy` (0020) and
-- `crm.notification_endpoint` (0021) were therefore settable only by someone with a
-- psql prompt — which in practice means settable by anyone with the application
-- password, with no record of who changed what. The debt was accumulating: every
-- tenant-wide parameter a later increment adds would have landed in the same place.
--
-- THE RULE. A role is a dated GRANT on a rep profile, held by nobody implicitly.
-- Not a column on rep_profile: a column cannot say when a role was given, by whom,
-- or that it was taken away in March — and "who was the compliance officer when this
-- obligation went overdue" is exactly the question an auditor asks. So it is a grant
-- table, effective-dated like territory assignment (0010), and the grants themselves
-- are the audit trail.
--
-- TWO ROLES, NOT A PERMISSION SYSTEM. There are precisely two administrative surfaces
-- in this codebase, so there are two roles and no mechanism for inventing more at
-- runtime: `administrator` configures the tenant (where its signals are pushed, and
-- who holds roles), `compliance` owns the SOP parameters reps are held to (the
-- disposal grace period, the promo auto-write-off switch). A role list in a CHECK
-- constraint rather than a table is deliberate — a role nothing checks is worse than
-- no role at all, and a migration is the right place to notice that.
--
-- THE ROLES ARE NOT SUPERVISION. A first-line manager supervises reps and therefore
-- reads their data (0019); that must not let them change a tenant-wide commitment
-- their own team is measured against. The two predicates stay separate and no route
-- accepts either in place of the other.
--
-- BOOTSTRAP IS DELIBERATELY MANUAL. A grant cannot name its own holder as grantor
-- (the four-eyes CHECK below), so the first administrator in a tenant is inserted by
-- whoever runs the migrations, in SQL. There is no other way to make a closed system
-- start, and an API that could mint its own first administrator would be a way in.

-- ---------------------------------------------------------------------------
-- The grants.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.rep_role (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,

  rep_profile_id  uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  role            text NOT NULL CHECK (role IN ('administrator', 'compliance')),

  -- Half-open [valid_from, valid_to), as everywhere else in this schema.
  valid_from      date NOT NULL DEFAULT CURRENT_DATE,
  valid_to        date,

  -- Four eyes, the same rule as a call plan approval (0015): nobody grants
  -- themselves a role and nobody revokes their own. The second half is what stops
  -- an administrator quietly dropping the role that constrains them — and together
  -- they mean a tenant needs two administrators to stay administrable, which is the
  -- correct operational requirement rather than an inconvenience.
  granted_by      uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  grant_reason    text,

  revoked_by      uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,
  revoked_at      timestamptz,
  revoke_reason   text,

  CONSTRAINT rep_role_no_self_grant  CHECK (granted_by <> rep_profile_id),
  CONSTRAINT rep_role_no_self_revoke CHECK (revoked_by IS NULL OR revoked_by <> rep_profile_id),

  -- A revocation is a pair of facts or neither of them. A revoked_at with no
  -- revoked_by is a role that stopped for no attributable reason.
  CONSTRAINT rep_role_revocation_paired CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),

  -- NOT `>`, deliberately. valid_to = valid_from is an EMPTY half-open range: a grant
  -- made and revoked the same day, which is the normal shape of correcting a mistake
  -- within the hour. Refusing it would force the corrector to either backdate the
  -- revocation into yesterday or delete the row, and deleting it is exactly what the
  -- append-only trigger below exists to prevent. An empty range is never in force,
  -- and because an empty daterange overlaps nothing, the exclusion constraint keeps
  -- ignoring it — so a same-day correction does not block a fresh grant tomorrow.
  CONSTRAINT rep_role_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),

  -- One live grant of a role per rep. Two overlapping rows are not a security hole,
  -- but they make "when did they get this" unanswerable, and revoking one would
  -- silently leave the other in force.
  CONSTRAINT rep_role_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    rep_profile_id WITH =,
    role WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

SELECT crm.apply_tenant_isolation('crm.rep_role');

-- Not partial on `valid_to IS NULL`: a time-boxed grant with a future end date is
-- live too, and an index that only covers open-ended ones would be silently useless
-- for exactly the rows a careful administrator creates.
CREATE INDEX idx_rep_role_lookup ON crm.rep_role (tenant_id, role, rep_profile_id, valid_from);

-- ---------------------------------------------------------------------------
-- Append-only, with one sanctioned mutation.
-- ---------------------------------------------------------------------------

/**
 * A grant is history. It may be ended; it may not be edited or erased.
 *
 * The one permitted UPDATE is a revocation, and only from unrevoked to revoked — so
 * a revocation cannot be reversed by clearing the fields, and a role that was taken
 * away cannot be made to look as though it never was. Re-granting is a new row,
 * which is what the audit trail should show anyway.
 *
 * Checked in a trigger rather than by convention because the alternative is every
 * caller remembering, and `crm.revoke_rep_role` below is then provably the only path.
 */
CREATE OR REPLACE FUNCTION crm.rep_role_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crm.rep_role is append-only: revoke the grant instead of deleting it (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role grant % was already revoked at %', OLD.id, OLD.revoked_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id            <> OLD.id
     OR NEW.tenant_id      <> OLD.tenant_id
     OR NEW.rep_profile_id <> OLD.rep_profile_id
     OR NEW.role           <> OLD.role
     OR NEW.valid_from     <> OLD.valid_from
     OR NEW.granted_by     <> OLD.granted_by
     OR NEW.granted_at     <> OLD.granted_at
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason THEN
    RAISE EXCEPTION 'only the revocation of a role grant may be updated (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'the only permitted update to a role grant is its revocation (id %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER rep_role_append_only
  BEFORE UPDATE OR DELETE ON crm.rep_role
  FOR EACH ROW EXECUTE FUNCTION crm.rep_role_append_only();

/**
 * End a grant. The only sanctioned mutation of crm.rep_role.
 *
 * `p_on_date` is CLAMPED INTO the grant's own window, not written over it:
 *   * forward to valid_from, because a revocation dated before the grant began would
 *     describe a negative range the CHECK refuses — and the caller's intent there is
 *     plainly "this never took effect", which valid_to = valid_from says exactly;
 *   * back to an existing valid_to, because revoking a grant that already lapsed must
 *     RECORD the revocation without EXTENDING the role. Written the obvious way
 *     (valid_to = GREATEST(p_on_date, valid_from)) a time-boxed grant revoked after
 *     its end date would be handed the extra months back.
 *
 * Returns false rather than raising when nothing matched, so a double revoke from a
 * retried request is idempotent at the API boundary instead of a 500. An ALREADY
 * revoked grant still raises, from the trigger: that is a different mistake and the
 * caller should hear about it.
 *
 * `p_tenant_id` is required and checked here, NOT left to RLS. Every other store in
 * this codebase carries `WHERE tenant_id = $1` as well as its policy, and this one must
 * too: the first version of this function scoped on the id alone, and a rep of one
 * tenant revoked a grant in another on any connection whose role bypasses RLS — which
 * the API contract suite's does. The policy is the backstop, not the check.
 */
DROP FUNCTION IF EXISTS crm.revoke_rep_role(uuid, uuid, date, text);

CREATE OR REPLACE FUNCTION crm.revoke_rep_role(
  p_id            uuid,
  p_tenant_id     uuid,
  p_revoked_by    uuid,
  p_on_date       date DEFAULT CURRENT_DATE,
  p_revoke_reason text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE crm.rep_role
     SET valid_to      = GREATEST(valid_from, LEAST(p_on_date, COALESCE(valid_to, p_on_date))),
         revoked_by    = p_revoked_by,
         revoked_at    = now(),
         revoke_reason = p_revoke_reason
   WHERE id = p_id
     AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END
$$;

-- ---------------------------------------------------------------------------
-- The predicates. One definition, every caller.
-- ---------------------------------------------------------------------------

/**
 * Does this rep hold that role on that date?
 *
 * The single predicate every administrative route applies, in SQL for the reason
 * crm.rep_can_supervise (0019) is: an authorisation rule reimplemented per route is
 * one that will eventually disagree with itself.
 *
 * REQUIRES AN ACTIVE PROFILE. A suspended or departed rep holds no role, whatever
 * their grants say. resolvePrincipal already refuses them at the API edge, so this
 * is belt and braces there — but a job or a view asking this question gets the same
 * answer, and the answer a security predicate gives must not depend on who asked.
 */
CREATE OR REPLACE FUNCTION crm.rep_has_role(
  p_rep_profile_id uuid,
  p_role           text,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM crm.rep_role r
      JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
     WHERE r.rep_profile_id = p_rep_profile_id
       AND r.role = p_role
       AND rp.status = 'active'
       AND r.valid_from <= p_on_date
       AND (r.valid_to IS NULL OR r.valid_to > p_on_date)
  );
$$;

/**
 * Every role a rep holds on a date, for the principal to carry.
 *
 * Returns a sorted array rather than a set so a caller can compare it, and so the
 * JSON a client sees is stable between requests.
 */
CREATE OR REPLACE FUNCTION crm.rep_roles(
  p_rep_profile_id uuid,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT r.role ORDER BY r.role), ARRAY[]::text[])
    FROM crm.rep_role r
    JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
   WHERE r.rep_profile_id = p_rep_profile_id
     AND rp.status = 'active'
     AND r.valid_from <= p_on_date
     AND (r.valid_to IS NULL OR r.valid_to > p_on_date);
$$;

/**
 * Who holds a role right now — the list an administrator needs before revoking the
 * last one, and the list a deployment check needs to prove a tenant is administrable.
 */
CREATE OR REPLACE FUNCTION crm.role_holders(
  p_role    text,
  p_on_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id  uuid,
  display_name    text,
  employee_number text,
  valid_from      date,
  granted_by      uuid
)
LANGUAGE sql STABLE AS $$
  SELECT rp.id, rp.display_name, rp.employee_number, r.valid_from, r.granted_by
    FROM crm.rep_role r
    JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
   WHERE r.role = p_role
     AND rp.status = 'active'
     AND r.valid_from <= p_on_date
     AND (r.valid_to IS NULL OR r.valid_to > p_on_date)
   ORDER BY rp.display_name;
$$;

-- ---------------------------------------------------------------------------
-- Lockout.
-- ---------------------------------------------------------------------------
--
-- A tenant with no administrator cannot be given one, because a grant cannot name its
-- own holder as grantor. So the last administrator leaving is not an inconvenience to
-- be fixed in the application later — it is a one-way door out of the API, openable
-- only by whoever has the migration credentials. Both ways through that door are
-- closed here, in the database, because they are the same mistake arriving by
-- different routes and a check in one route is a check somebody walks around.

/**
 * Is at least one OTHER rep an administrator on a date?
 *
 * `p_except_grant_id` excludes the grant being ended, so the question is "what is left
 * afterwards" rather than "what is true now".
 */
CREATE OR REPLACE FUNCTION crm.other_administrator_exists(
  p_tenant_id       uuid,
  p_on_date         date,
  p_except_grant_id uuid DEFAULT NULL,
  p_except_rep_id   uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM crm.rep_role r
      JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
     WHERE r.tenant_id = p_tenant_id
       AND r.role = 'administrator'
       AND rp.status = 'active'
       AND (p_except_grant_id IS NULL OR r.id <> p_except_grant_id)
       AND (p_except_rep_id   IS NULL OR r.rep_profile_id <> p_except_rep_id)
       AND r.valid_from <= p_on_date
       AND (r.valid_to IS NULL OR r.valid_to > p_on_date)
  );
$$;

/**
 * Route one: revoking the grant.
 *
 * Checked on the revocation date rather than today, so dating a revocation into the
 * future does not slip past a successor who has not been appointed yet. A one-day gap
 * is still refused — an administrator-less day is a locked-out day, and the remedy is
 * to date the successor's grant from the same day, not to accept the gap.
 */
CREATE OR REPLACE FUNCTION crm.rep_role_no_lockout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'administrator'
     AND NOT crm.other_administrator_exists(NEW.tenant_id, NEW.valid_to, NEW.id) THEN
    RAISE EXCEPTION
      'refusing to revoke the last administrator of tenant % — grant the role to their successor first, '
      'effective on or before %',
      NEW.tenant_id, NEW.valid_to
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Postgres fires BEFORE ROW triggers in alphabetical name order, so `append_only` runs
-- first and a malformed update is rejected for being malformed rather than for a
-- lockout it was never going to cause. The names carry that ordering; do not rename
-- one of them without checking it still holds.
CREATE TRIGGER rep_role_no_lockout
  BEFORE UPDATE ON crm.rep_role
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION crm.rep_role_no_lockout();

/**
 * Route two: suspending or departing the holder.
 *
 * crm.rep_has_role requires an ACTIVE profile, so taking the last administrator off
 * active locks the tenant out exactly as revoking them would, while leaving a grant
 * row that looks live. HR and security are the same door here.
 *
 * Only the transition AWAY from active is checked: reactivating somebody cannot lock
 * anyone out, and a profile that is already suspended is already not counted.
 */
CREATE OR REPLACE FUNCTION crm.rep_profile_no_admin_lockout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active'
     AND EXISTS (
       SELECT 1 FROM crm.rep_role r
        WHERE r.rep_profile_id = OLD.id
          AND r.role = 'administrator'
          AND r.valid_from <= CURRENT_DATE
          AND (r.valid_to IS NULL OR r.valid_to > CURRENT_DATE)
     )
     AND NOT crm.other_administrator_exists(OLD.tenant_id, CURRENT_DATE, NULL, OLD.id) THEN
    RAISE EXCEPTION
      'rep % is the last administrator of tenant % — appoint a successor before setting status to %',
      OLD.id, OLD.tenant_id, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER rep_profile_no_admin_lockout
  BEFORE UPDATE OF status ON crm.rep_profile
  FOR EACH ROW EXECUTE FUNCTION crm.rep_profile_no_admin_lockout();
