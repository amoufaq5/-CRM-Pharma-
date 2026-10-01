-- 0019_supervision.sql
--
-- "Whose data may this manager read?"
--
-- The supervisory counterpart to crm.visible_account_ids (0011), and in SQL for the
-- same reason: this is an authorisation rule, every caller must get the same answer,
-- and a rule reimplemented per route is one that will eventually disagree with itself.
--
-- WHAT MAKES IT NECESSARY. Every route built so far is scoped to the caller, which is
-- correct and leaves a manager unable to see the team they are accountable for. The
-- ERP cannot help: it has no row-level scoping at all, so "my team" is as
-- inexpressible there as "my accounts" (report R2). It is expressed here, from the
-- same effective-dated territory hierarchy.
--
-- AND IT IS DATED, like everything else. A manager who took over a district in October
-- supervises whoever held its territories on the date being asked about — not whoever
-- holds them now. That is the question a quarterly review and a commission dispute
-- both ask.

/**
 * The reps a manager supervises on a date.
 *
 * EXCLUDES THE MANAGER THEMSELVES. "My team" means the people reporting through me; a
 * manager appearing in their own roster makes every count off by one and every
 * per-rep average wrong. The authorisation helper below deliberately differs — see
 * its comment.
 *
 * Built on crm.managed_territory_ids (0016), so a regional manager reaches every
 * territory beneath them and a rep assigned `primary` to the same territory reaches
 * nobody. Supervision follows the hierarchy, not co-location.
 */
CREATE OR REPLACE FUNCTION crm.managed_rep_ids(
  p_manager_rep_profile_id uuid,
  p_on_date                date DEFAULT CURRENT_DATE
)
RETURNS TABLE (rep_profile_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ta.rep_profile_id
    FROM crm.territory_assignment ta
    JOIN crm.managed_territory_ids(p_manager_rep_profile_id, p_on_date) m
      ON m.territory_id = ta.territory_id
   WHERE ta.valid_from <= p_on_date
     AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
     AND ta.rep_profile_id <> p_manager_rep_profile_id;
$$;

/**
 * May this caller read that rep's records?
 *
 * INCLUDES THE CALLER THEMSELVES, unlike the roster above. The two questions are
 * different: "who is on my team" excludes me, "whose data may I read" includes me,
 * because I can always read my own. Collapsing them into one function would force
 * every caller to remember which semantics it had — so there are two, each named for
 * what it answers.
 *
 * This is the single predicate every team-facing route applies. RLS is no help here:
 * the manager and the rep are in the same tenant, so the policy admits both rows and
 * the ONLY thing standing between a manager and a peer's data is this check. A route
 * that forgets it leaks; a route that uses it cannot.
 */
CREATE OR REPLACE FUNCTION crm.rep_can_supervise(
  p_manager_rep_profile_id uuid,
  p_rep_profile_id         uuid,
  p_on_date                date DEFAULT CURRENT_DATE
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_manager_rep_profile_id = p_rep_profile_id
      OR EXISTS (
           SELECT 1 FROM crm.managed_rep_ids(p_manager_rep_profile_id, p_on_date) m
            WHERE m.rep_profile_id = p_rep_profile_id
         );
$$;

/**
 * A manager's team roster on a date, with the territories each rep covers.
 *
 * `territory_codes` is aggregated rather than returning a row per assignment, because
 * a roster is a list of people and a rep with two territories is still one person.
 */
CREATE OR REPLACE FUNCTION crm.team_roster(
  p_manager_rep_profile_id uuid,
  p_on_date                date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id   uuid,
  display_name     text,
  employee_number  text,
  status           text,
  territory_codes  text[]
)
LANGUAGE sql STABLE AS $$
  SELECT rp.id, rp.display_name, rp.employee_number, rp.status,
         array_agg(DISTINCT t.code ORDER BY t.code)
    FROM crm.managed_rep_ids(p_manager_rep_profile_id, p_on_date) m
    JOIN crm.rep_profile rp ON rp.id = m.rep_profile_id
    LEFT JOIN crm.territory_assignment ta
           ON ta.rep_profile_id = rp.id
          AND ta.valid_from <= p_on_date
          AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
    LEFT JOIN crm.territory t ON t.id = ta.territory_id
   GROUP BY rp.id, rp.display_name, rp.employee_number, rp.status
   ORDER BY rp.display_name;
$$;

-- ---------------------------------------------------------------------------
-- The territory review: one row per rep, for one cycle.
-- ---------------------------------------------------------------------------

/**
 * Per-rep adherence across a manager's team for one cycle.
 *
 * A LEFT JOIN onto the plan, and that is the important part: A REP WITH NO PLAN
 * APPEARS, with nulls. "Who has not got a plan this cycle" is the first question a
 * territory review asks, and an inner join would answer it by silently omitting them —
 * the team would look fully covered because the gaps were not in the result set.
 *
 * The numbers come from crm.call_plan_summary, so this rollup and a single rep's own
 * adherence screen cannot disagree about what counts as a call.
 */
CREATE OR REPLACE FUNCTION crm.cycle_team_adherence(
  p_manager_rep_profile_id uuid,
  p_cycle_id               uuid,
  p_on_date                date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id   uuid,
  display_name     text,
  employee_number  text,
  call_plan_id     uuid,
  plan_status      text,
  targets          integer,
  targets_met      integer,
  targets_touched  integer,
  planned_calls    integer,
  actual_calls     integer,
  coverage_pct     numeric,
  attainment_pct   numeric
)
LANGUAGE sql STABLE AS $$
  SELECT rp.id, rp.display_name, rp.employee_number,
         cp.id, cp.status,
         s.targets, s.targets_met, s.targets_touched,
         s.planned_calls, s.actual_calls, s.coverage_pct, s.attainment_pct
    FROM crm.managed_rep_ids(p_manager_rep_profile_id, p_on_date) m
    JOIN crm.rep_profile rp ON rp.id = m.rep_profile_id
    -- The LIVE plan only. A superseded one is history, and counting both would double
    -- every target the replacement inherited.
    LEFT JOIN crm.call_plan cp
           ON cp.rep_profile_id = rp.id
          AND cp.cycle_id = p_cycle_id
          AND cp.status IN ('draft', 'submitted', 'approved')
    LEFT JOIN LATERAL crm.call_plan_summary(cp.id) s ON cp.id IS NOT NULL
   ORDER BY rp.display_name;
$$;

-- ---------------------------------------------------------------------------
-- Custody oversight.
-- ---------------------------------------------------------------------------

/**
 * Expiring stock across a manager's team.
 *
 * Delegates to crm.expiring_sample_holdings per rep rather than restating its
 * predicate, so "expiring" has one definition. Expired stock in a rep's bag is the
 * most common sample-audit finding there is, and until now only the rep could see it.
 */
CREATE OR REPLACE FUNCTION crm.team_expiring_holdings(
  p_manager_rep_profile_id uuid,
  p_within_days            integer DEFAULT 60,
  p_as_of                  date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id    uuid,
  display_name      text,
  lot_id            uuid,
  erp_item_id       text,
  lot_number        text,
  expiry_date       date,
  days_remaining    integer,
  quantity_on_hand  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT rp.id, rp.display_name, e.lot_id, e.erp_item_id, e.lot_number,
         e.expiry_date, e.days_remaining, e.quantity_on_hand
    FROM crm.managed_rep_ids(p_manager_rep_profile_id, p_as_of) m
    JOIN crm.rep_profile rp ON rp.id = m.rep_profile_id
    CROSS JOIN LATERAL crm.expiring_sample_holdings(m.rep_profile_id, p_within_days, p_as_of) e
   ORDER BY e.expiry_date, rp.display_name;
$$;

/**
 * What each rep on the team is carrying, and when their bag was last counted.
 *
 * `last_counted_at` is the column that makes this worth having: the count document in
 * 0017 is only useful if someone can see whose count is overdue. A null means never
 * counted, which is a stronger finding than an old date and must not sort as though it
 * were recent — hence NULLS FIRST.
 *
 * `units_in_transit` is reported separately because material a rep has sent and nobody
 * has accepted is still their responsibility, and a manager chasing a gap needs to see
 * it rather than a single total that hides it.
 */
CREATE OR REPLACE FUNCTION crm.team_sample_exposure(
  p_manager_rep_profile_id uuid,
  p_as_of                  date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  rep_profile_id    uuid,
  display_name      text,
  lots_held         integer,
  units_on_hand     numeric,
  units_in_transit  numeric,
  earliest_expiry   date,
  expired_lots      integer,
  last_counted_at   timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT rp.id, rp.display_name,
         count(h.lot_id) FILTER (WHERE h.quantity_on_hand > 0)::integer,
         COALESCE(sum(h.quantity_on_hand), 0),
         COALESCE(sum(h.quantity_in_transit), 0),
         min(l.expiry_date) FILTER (WHERE h.quantity_on_hand > 0),
         count(*) FILTER (WHERE h.quantity_on_hand > 0 AND l.expiry_date < p_as_of)::integer,
         max(h.last_counted_at)
    FROM crm.managed_rep_ids(p_manager_rep_profile_id, p_as_of) m
    JOIN crm.rep_profile rp ON rp.id = m.rep_profile_id
    LEFT JOIN crm.sample_holding h ON h.rep_profile_id = rp.id
    LEFT JOIN crm.sample_lot l ON l.id = h.lot_id
   GROUP BY rp.id, rp.display_name
   ORDER BY max(h.last_counted_at) NULLS FIRST, rp.display_name;
$$;
