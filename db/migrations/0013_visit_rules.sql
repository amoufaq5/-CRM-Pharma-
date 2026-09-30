-- 0013_visit_rules.sql
--
-- The two rules a visit must not be able to break, enforced in the database so
-- they hold for every caller — the API, a bulk offline sync, a background job,
-- an operator at a psql prompt.
--
-- Putting them in application code would mean the offline sync path and the
-- interactive path each enforcing them separately, which is how they start
-- disagreeing. This is the same argument as for crm.visible_account_ids.

/**
 * A rep may only record a visit against an account they covered ON THE DAY OF
 * THE VISIT.
 *
 * `occurred_at::date`, not `CURRENT_DATE`, and that is the whole point. A visit
 * made in June against an account that moved territory in July is still valid,
 * still the original rep's, and must not become editable by whoever holds the
 * account now. Territories are effective-dated precisely so this question has an
 * answer; this is where it gets asked.
 *
 * A planned visit with no date yet is checked against today, since that is the
 * only date available and planning ahead for an account you do not cover is
 * equally wrong.
 */
CREATE OR REPLACE FUNCTION crm.visit_check_territory()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  as_of date := COALESCE(NEW.occurred_at::date, NEW.planned_for, CURRENT_DATE);
BEGIN
  IF NOT crm.rep_can_see_account(NEW.rep_profile_id, NEW.erp_account_id::text, as_of) THEN
    RAISE EXCEPTION
      'rep % did not cover account % on % — a visit cannot be recorded outside the rep''s territory',
      NEW.rep_profile_id, NEW.erp_account_id, as_of
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER visit_check_territory
  BEFORE INSERT OR UPDATE OF rep_profile_id, erp_account_id, occurred_at, planned_for
  ON crm.visit
  FOR EACH ROW EXECUTE FUNCTION crm.visit_check_territory();

/**
 * A finished visit is a record of what happened, not a draft.
 *
 * Once `completed` or `cancelled`, the substance is frozen. This mirrors the
 * ERP's own `postedEntryImmutabilityGuard` on posted journal entries, and for
 * the same reason: a field-force record that can be silently rewritten after the
 * fact is worth nothing in a compliance review, which is the situation it exists
 * to survive.
 *
 * `notes` stays writable so a rep can add a late observation, and `updated_at`
 * moves with it. Everything else — the account, the products, the outcome, the
 * time — is fixed. A genuine correction is a new visit referencing the old one,
 * which leaves both in the record rather than replacing history with a better
 * story.
 */
CREATE OR REPLACE FUNCTION crm.visit_reject_edit_when_final()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('completed','cancelled') THEN
    RETURN NEW;
  END IF;
  IF (NEW.rep_profile_id, NEW.erp_account_id, NEW.erp_contact_id, NEW.visit_type,
      NEW.status, NEW.planned_for, NEW.occurred_at, NEW.duration_minutes,
      NEW.checkin_latitude, NEW.checkin_longitude, NEW.outcome)
     IS DISTINCT FROM
     (OLD.rep_profile_id, OLD.erp_account_id, OLD.erp_contact_id, OLD.visit_type,
      OLD.status, OLD.planned_for, OLD.occurred_at, OLD.duration_minutes,
      OLD.checkin_latitude, OLD.checkin_longitude, OLD.outcome)
  THEN
    RAISE EXCEPTION
      'visit % is % and cannot be edited; only notes may be appended. Record a correcting visit instead.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER visit_reject_edit_when_final
  BEFORE UPDATE ON crm.visit
  FOR EACH ROW EXECUTE FUNCTION crm.visit_reject_edit_when_final();

/** Detailing lines are part of the frozen substance. */
CREATE OR REPLACE FUNCTION crm.visit_product_reject_when_final()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  visit_status text;
  target uuid := COALESCE(NEW.visit_id, OLD.visit_id);
BEGIN
  SELECT status INTO visit_status FROM crm.visit WHERE id = target;
  IF visit_status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'visit % is % — its detailing lines cannot be changed', target, visit_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER visit_product_reject_when_final
  BEFORE INSERT OR UPDATE OR DELETE ON crm.visit_product
  FOR EACH ROW EXECUTE FUNCTION crm.visit_product_reject_when_final();

/**
 * A finished visit cannot be deleted either.
 *
 * Freezing the fields while leaving DELETE open would be a gap, not a rule: the
 * easiest way to rewrite history is to remove it. This also gives the
 * `ON DELETE CASCADE` from `visit_product` a clear answer — the cascade never
 * fires for a finished visit, because the parent delete is refused first.
 */
CREATE OR REPLACE FUNCTION crm.visit_reject_delete_when_final()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION
      'visit % is % and cannot be deleted; a finished visit is a record, not a draft', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER visit_reject_delete_when_final
  BEFORE DELETE ON crm.visit
  FOR EACH ROW EXECUTE FUNCTION crm.visit_reject_delete_when_final();
