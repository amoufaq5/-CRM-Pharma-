-- 0011_visibility.sql
--
-- "Which accounts may this rep see, on this date?"
--
-- This is the CRM's replacement for row-level authorisation the ERP does not
-- have. It is SQL rather than application code on purpose: every read path —
-- the API, a report, a background job, an operator at a psql prompt — gets the
-- same answer, and there is exactly one definition to audit. An authorisation
-- rule reimplemented per caller is an authorisation rule that will disagree with
-- itself.
--
-- All functions are SECURITY INVOKER (the default). They run as the caller,
-- inside the caller's tenant context, so RLS still applies underneath them.
-- SECURITY DEFINER here would quietly become a cross-tenant read.

/**
 * The territories a rep covers on `on_date`.
 *
 * A `primary` or `secondary` assignment covers that territory alone. A
 * `manager` assignment also covers everything beneath it — which is what makes
 * this recursive, and is the difference between a district manager seeing their
 * district and seeing only the one row with their name on it.
 *
 * STABLE, not IMMUTABLE: it reads tables, and `on_date` deliberately makes the
 * historical answer available rather than only today's.
 */
CREATE OR REPLACE FUNCTION crm.visible_territory_ids(
  p_rep_profile_id uuid,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (territory_id uuid)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE assigned AS (
    -- Directly assigned, and still in force on the date asked about.
    SELECT ta.territory_id, ta.role
      FROM crm.territory_assignment ta
     WHERE ta.rep_profile_id = p_rep_profile_id
       AND ta.valid_from <= p_on_date
       AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
  ),
  covered AS (
    SELECT a.territory_id, a.role FROM assigned a
    UNION
    -- Descend, but only under a manager assignment. A `primary` rep does not
    -- inherit a child territory merely because the hierarchy has one.
    SELECT t.id, c.role
      FROM crm.territory t
      JOIN covered c ON t.parent_id = c.territory_id
     WHERE c.role = 'manager'
  )
  SELECT DISTINCT c.territory_id FROM covered c;
$$;

/**
 * The ERP account ids a rep may see on `on_date`.
 *
 * The join is on the effective-dated account assignment, so an account that
 * moved territory mid-quarter is visible to whoever held it at the time — which
 * is the question a commission dispute actually asks, and one the ERP cannot
 * answer at all because it keeps no assignment history.
 */
CREATE OR REPLACE FUNCTION crm.visible_account_ids(
  p_rep_profile_id uuid,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (erp_account_id text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT aa.erp_account_id::text
    FROM crm.account_assignment aa
    JOIN crm.visible_territory_ids(p_rep_profile_id, p_on_date) v
      ON v.territory_id = aa.territory_id
   WHERE aa.valid_from <= p_on_date
     AND (aa.valid_to IS NULL OR aa.valid_to > p_on_date);
$$;

/**
 * Whether one rep may see one account. The single-account form of the above,
 * for an authorisation check on a record the caller already has in hand.
 */
CREATE OR REPLACE FUNCTION crm.rep_can_see_account(
  p_rep_profile_id uuid,
  p_erp_account_id text,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM crm.visible_account_ids(p_rep_profile_id, p_on_date) v
     WHERE v.erp_account_id = p_erp_account_id
  );
$$;

/**
 * Who covered an account on a date, and under which territory.
 *
 * The inverse question, and the one an incentive run asks: not "what can this
 * rep see now" but "who owned this customer when the order landed". Answerable
 * only because the assignment tables keep history; the ERP overwrites it.
 */
CREATE OR REPLACE FUNCTION crm.account_owners_on(
  p_erp_account_id text,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (rep_profile_id uuid, territory_id uuid, role text)
LANGUAGE sql STABLE AS $$
  SELECT ta.rep_profile_id, aa.territory_id, ta.role
    FROM crm.account_assignment aa
    JOIN crm.territory_assignment ta ON ta.territory_id = aa.territory_id
   WHERE aa.erp_account_id = p_erp_account_id
     AND aa.valid_from <= p_on_date
     AND (aa.valid_to IS NULL OR aa.valid_to > p_on_date)
     AND ta.valid_from <= p_on_date
     AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date);
$$;
