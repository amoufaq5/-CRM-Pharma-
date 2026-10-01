-- 0016_call_plan_rules.sql
--
-- The rules a call plan cannot break, and the one definition of adherence.
--
-- In SQL for the same reason as crm.visible_account_ids (0011): the API, a bulk
-- import, a manager's report and an operator at a psql prompt must all get the
-- same answer. Adherence in particular is the number a territory review and an
-- incentive scheme argue over — two implementations of it is two sets of books.

/**
 * The territories a rep MANAGES on a date, including everything beneath them.
 *
 * Distinct from crm.visible_territory_ids, which answers "what can this rep see"
 * and is satisfied by a `primary` or `secondary` assignment. Approving someone
 * else's plan is a supervisory act, so being assigned to the same territory as
 * them is not enough.
 *
 * The recursive walk is repeated from 0011 rather than factored out of it:
 * 0011 is applied and hash-gated, so editing it would be refused by the migration
 * runner. The duplication is deliberate and bounded.
 */
CREATE OR REPLACE FUNCTION crm.managed_territory_ids(
  p_rep_profile_id uuid,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (territory_id uuid)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE managed AS (
    SELECT ta.territory_id
      FROM crm.territory_assignment ta
     WHERE ta.rep_profile_id = p_rep_profile_id
       AND ta.role = 'manager'
       AND ta.valid_from <= p_on_date
       AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
    UNION
    SELECT t.id
      FROM crm.territory t
      JOIN managed m ON t.parent_id = m.territory_id
  )
  SELECT DISTINCT m.territory_id FROM managed m;
$$;

/**
 * Whether a rep covered an account at ANY point in a date window.
 *
 * The point-in-time form (crm.rep_can_see_account) is the wrong question for a
 * plan: a cycle is a span, and a rep who picks up an account in week two may
 * legitimately plan to call on it. An overlap test, not a sample at one date —
 * asking on the cycle's first day alone would reject exactly the mid-cycle
 * reassignment the effective-dated tables exist to handle.
 *
 * Both ranges are half-open on the right (`valid_to > from`), matching 0011.
 */
CREATE OR REPLACE FUNCTION crm.rep_covers_account_during(
  p_rep_profile_id uuid,
  p_erp_account_id text,
  p_from           date,
  p_to             date
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM crm.account_assignment aa
      JOIN crm.territory_assignment ta ON ta.territory_id = aa.territory_id
     WHERE aa.erp_account_id = p_erp_account_id
       AND ta.rep_profile_id = p_rep_profile_id
       AND aa.valid_from <= p_to AND (aa.valid_to IS NULL OR aa.valid_to > p_from)
       AND ta.valid_from <= p_to AND (ta.valid_to IS NULL OR ta.valid_to > p_from)
     UNION ALL
    -- A manager's inherited coverage: assigned above the account's territory
    -- rather than to it. Checked at the window's start and end rather than every
    -- day in between, which is where the hierarchy could in principle change —
    -- a limitation worth knowing about and not worth a day-by-day walk.
    SELECT 1
      FROM crm.account_assignment aa
     WHERE aa.erp_account_id = p_erp_account_id
       AND aa.valid_from <= p_to AND (aa.valid_to IS NULL OR aa.valid_to > p_from)
       AND (aa.territory_id IN (SELECT territory_id FROM crm.managed_territory_ids(p_rep_profile_id, p_from))
         OR aa.territory_id IN (SELECT territory_id FROM crm.managed_territory_ids(p_rep_profile_id, p_to)))
  );
$$;

/**
 * A target must be an account the plan's rep covers during the cycle.
 *
 * Planning calls on someone else's customers is either a mistake or an attempt to
 * claim their activity. Either way the plan should not be storable.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_target_check_territory()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan   record;
  cyc    record;
BEGIN
  SELECT rep_profile_id, cycle_id INTO plan FROM crm.call_plan WHERE id = NEW.call_plan_id;
  SELECT starts_on, ends_on INTO cyc FROM crm.cycle WHERE id = plan.cycle_id;

  IF NOT crm.rep_covers_account_during(
           plan.rep_profile_id, NEW.erp_account_id::text, cyc.starts_on, cyc.ends_on) THEN
    RAISE EXCEPTION
      'rep % does not cover account % at any point in the cycle % to % — it cannot be a plan target',
      plan.rep_profile_id, NEW.erp_account_id, cyc.starts_on, cyc.ends_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER call_plan_target_check_territory
  BEFORE INSERT OR UPDATE OF erp_account_id, call_plan_id
  ON crm.call_plan_target
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_target_check_territory();

/**
 * The plan lifecycle, as a map rather than a pile of conditions.
 *
 *   draft     -> submitted | withdrawn
 *   submitted -> approved | draft (sent back) | withdrawn
 *   approved  -> superseded
 *   superseded, withdrawn -> terminal
 *
 * Also: once a plan is approved its substance is fixed. Which cycle, which rep
 * and which revision cannot change — a plan that can be re-pointed at a different
 * rep after approval is not an approved plan.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_check_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft'      THEN ARRAY['submitted', 'withdrawn']
      WHEN 'submitted'  THEN ARRAY['approved', 'draft', 'withdrawn']
      WHEN 'approved'   THEN ARRAY['superseded']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'call plan % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status IN ('approved', 'superseded', 'withdrawn')
     AND (NEW.cycle_id, NEW.rep_profile_id, NEW.revision)
         IS DISTINCT FROM (OLD.cycle_id, OLD.rep_profile_id, OLD.revision) THEN
    RAISE EXCEPTION
      'call plan % is % — its cycle, rep and revision are fixed. Supersede it with a new plan instead.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER call_plan_check_transition
  BEFORE UPDATE ON crm.call_plan
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_check_transition();

/**
 * The approver must manage the rep's territory on the day they approve.
 *
 * Four-eyes (the CHECK constraints in 0015) says the approver is someone else.
 * This says it is the RIGHT someone else. Without it any rep in the tenant could
 * approve any other rep's plan, which makes the signature decorative — and the
 * territory hierarchy exists precisely so this question has an answer.
 *
 * A rep with no territory assignment therefore cannot have a plan approved. That
 * is correct rather than awkward: their targets could not have passed the
 * coverage check either.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_check_approver()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  as_of date := COALESCE(NEW.approved_at::date, CURRENT_DATE);
BEGIN
  IF NEW.status <> 'approved' OR OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM crm.territory_assignment ta
     WHERE ta.rep_profile_id = NEW.rep_profile_id
       AND ta.valid_from <= as_of
       AND (ta.valid_to IS NULL OR ta.valid_to > as_of)
       AND ta.territory_id IN (SELECT territory_id FROM crm.managed_territory_ids(NEW.approved_by, as_of))
  ) THEN
    RAISE EXCEPTION
      'rep % does not manage any territory assigned to rep % on % — they cannot approve this plan',
      NEW.approved_by, NEW.rep_profile_id, as_of
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER call_plan_check_approver
  BEFORE UPDATE ON crm.call_plan
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_check_approver();

/**
 * Targets and products are part of what was approved.
 *
 * Freezing the plan row while leaving its targets editable would be a gap rather
 * than a rule: the adherence denominator lives in the target rows, so editing
 * them after the fact rewrites the score. Same reasoning as visit_product in
 * 0013.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_child_reject_when_final()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_status text;
  target_plan uuid := COALESCE(NEW.call_plan_id, OLD.call_plan_id);
BEGIN
  SELECT status INTO plan_status FROM crm.call_plan WHERE id = target_plan;
  -- A cascade from deleting the plan itself finds no row, and that is fine: the
  -- plan-level delete rule below has already decided whether this may happen.
  IF plan_status IS NOT NULL AND plan_status IN ('approved', 'superseded', 'withdrawn') THEN
    RAISE EXCEPTION
      'call plan % is % — its targets and products are fixed. Supersede it with a new plan instead.',
      target_plan, plan_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER call_plan_target_reject_when_final
  BEFORE INSERT OR UPDATE OR DELETE ON crm.call_plan_target
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_child_reject_when_final();

CREATE TRIGGER call_plan_product_reject_when_final
  BEFORE INSERT OR UPDATE OR DELETE ON crm.call_plan_product
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_child_reject_when_final();

/** An approved plan cannot be deleted. The easiest way to rewrite history is to remove it. */
CREATE OR REPLACE FUNCTION crm.call_plan_reject_delete_when_final()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'superseded') THEN
    RAISE EXCEPTION
      'call plan % is % and cannot be deleted; an approved plan is a record of what was agreed',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER call_plan_reject_delete_when_final
  BEFORE DELETE ON crm.call_plan
  FOR EACH ROW EXECUTE FUNCTION crm.call_plan_reject_delete_when_final();

-- ---------------------------------------------------------------------------
-- Adherence: planned versus actual, with exactly one definition.
-- ---------------------------------------------------------------------------

/**
 * Per-target adherence for one plan.
 *
 * WHAT COUNTS AS A CALL, stated once:
 *   - a visit by the plan's rep,
 *   - against the target's account,
 *   - with status `completed` — a planned or missed visit is not a call, and an
 *     in-progress one has not happened yet,
 *   - whose `occurred_at` falls inside the cycle window.
 *
 * `occurred_at`, never `recorded_at`. A visit made on the last day of the cycle
 * and synced two days later belongs to the cycle it happened in; using the sync
 * time would move activity between cycles according to the strength of a mobile
 * signal. This is why 0012 keeps both clocks.
 *
 * A target naming a contact counts only visits to that contact. A target naming
 * the institution counts every visit to it, including those recorded against a
 * specific contact — the narrower target is a promise about a person, the wider
 * one a promise about a place.
 *
 * `met` is computed here rather than by the caller so that "did they hit the
 * target" cannot mean >= in the API and > in a report.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_adherence(p_call_plan_id uuid)
RETURNS TABLE (
  target_id       uuid,
  erp_account_id  text,
  erp_contact_id  text,
  segment         text,
  target_calls    integer,
  actual_calls    integer,
  met             boolean,
  last_call_at    timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH plan AS (
    SELECT cp.id, cp.rep_profile_id, c.starts_on, c.ends_on
      FROM crm.call_plan cp
      JOIN crm.cycle c ON c.id = cp.cycle_id
     WHERE cp.id = p_call_plan_id
  )
  SELECT t.id,
         t.erp_account_id::text,
         t.erp_contact_id::text,
         t.segment,
         t.target_calls,
         COALESCE(v.n, 0)::integer,
         COALESCE(v.n, 0) >= t.target_calls,
         v.last_at
    FROM crm.call_plan_target t
    CROSS JOIN plan p
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, max(vi.occurred_at) AS last_at
        FROM crm.visit vi
       WHERE vi.rep_profile_id = p.rep_profile_id
         AND vi.erp_account_id = t.erp_account_id
         AND vi.status = 'completed'
         AND vi.occurred_at IS NOT NULL
         AND vi.occurred_at::date BETWEEN p.starts_on AND p.ends_on
         AND (t.erp_contact_id IS NULL OR vi.erp_contact_id = t.erp_contact_id)
    ) v ON true
   WHERE t.call_plan_id = p_call_plan_id
   ORDER BY t.erp_account_id, t.erp_contact_id NULLS FIRST;
$$;

/**
 * The plan-level summary, aggregated from the same function so the two can never
 * disagree.
 *
 * `coverage_pct` is targets visited at least once — the question "did we reach
 * them at all". `attainment_pct` is calls made against calls planned, capped per
 * target so one over-visited account cannot mask three neglected ones. Reporting
 * only the second is how a field force looks fully compliant while a third of its
 * customers were never seen.
 */
CREATE OR REPLACE FUNCTION crm.call_plan_summary(p_call_plan_id uuid)
RETURNS TABLE (
  targets          integer,
  targets_met      integer,
  targets_touched  integer,
  planned_calls    integer,
  actual_calls     integer,
  coverage_pct     numeric,
  attainment_pct   numeric
)
LANGUAGE sql STABLE AS $$
  WITH a AS (SELECT * FROM crm.call_plan_adherence(p_call_plan_id))
  SELECT count(*)::integer,
         count(*) FILTER (WHERE met)::integer,
         count(*) FILTER (WHERE actual_calls > 0)::integer,
         COALESCE(sum(target_calls), 0)::integer,
         COALESCE(sum(actual_calls), 0)::integer,
         CASE WHEN count(*) = 0 THEN NULL
              ELSE round(100.0 * count(*) FILTER (WHERE actual_calls > 0) / count(*), 1) END,
         CASE WHEN COALESCE(sum(target_calls), 0) = 0 THEN NULL
              ELSE round(100.0 * sum(least(actual_calls, target_calls)) / sum(target_calls), 1) END
    FROM a;
$$;
