-- Two things 0049 left in TypeScript, and one index nothing references.
--
-- ADR-0001's row, in its own words: "`normaliseKinds` dedups and sorts an endpoint's allow-list;
-- `notification_endpoint_kinds_known` only checks containment, so `ARRAY['x','x']` is legal from
-- SQL and two spellings of one allow-list store as two different arrays — which matters only for
-- comparing endpoints, which nothing does yet, so it is recorded rather than fixed. Normalising in
-- a trigger would be the move if anything ever needs to." And separately: `crm.notification` still
-- carries `UNIQUE (tenant_id, id)` and nothing references it.
--
-- SOMETHING NOW NEEDS TO. 0071 capped the endpoints a tenant may hold and told an administrator
-- who hits the cap to "re-enable a disabled endpoint that already points where you want" — which
-- is an instruction to COMPARE endpoints. The premise the row deferred on ("nothing does yet")
-- expired one migration ago, and an allow-list whose stored spelling depends on the order somebody
-- typed it in makes exactly that comparison harder: two endpoints filtered to the same three
-- kinds read as different rows in a listing somebody is scanning under pressure.

-- ---------------------------------------------------------------------------
-- 1. One definition of a normal allow-list.
-- ---------------------------------------------------------------------------
/**
 * Sorted and de-duplicated, with NULL preserved.
 *
 * NULL IS NOT AN EMPTY ARRAY HERE and the distinction is 0049's: NULL means EVERY kind, where an
 * empty array would mean none, and `notification_endpoint_kinds_not_empty` refuses the second
 * precisely so that "receives nothing" cannot be written by accident. So this must not turn one
 * into the other in either direction.
 *
 * WHICH THE FIRST VERSION OF THIS FUNCTION DID, in the one line that looks harmless:
 * `array_agg` over an empty set returns NULL, so `ARRAY[]::text[]` came back as NULL and an
 * endpoint written with an explicitly empty allow-list — the thing the not-empty CHECK exists to
 * refuse — would have been silently promoted to EVERY KIND. 0049's own suite caught it
 * ("leaves emptiness to the constraint that was already asking"), which is what that test is for.
 * The empty case is therefore returned untouched, so the constraint still answers.
 *
 * IMMUTABLE, so it can be used in a CHECK as well as in a trigger — which is what makes the
 * assertion below ("a stored allow-list is already normal") a property of the table rather than a
 * habit of its writers.
 */
CREATE OR REPLACE FUNCTION crm.normalise_notification_kinds(p_kinds text[])
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_kinds IS NULL THEN NULL
           -- NOT `array_agg`'s answer for an empty input, which is NULL — see the header. An
           -- empty allow-list stays empty and reaches the CHECK that refuses it.
           WHEN cardinality(p_kinds) = 0 THEN p_kinds
           ELSE (SELECT array_agg(DISTINCT k ORDER BY k) FROM unnest(p_kinds) AS k)
         END;
$$;

COMMENT ON FUNCTION crm.normalise_notification_kinds(text[]) IS
  'Sorts and de-duplicates an endpoint kind allow-list, preserving NULL (which means every kind). The database''s copy of what `normaliseKinds` has always done in TypeScript.';

-- ---------------------------------------------------------------------------
-- 2. The endpoint row, normalised whoever writes it.
-- ---------------------------------------------------------------------------
--
-- A TRIGGER AND NOT A CHECK on the write path, because the point is to accept the human's input
-- and store it in one shape — refusing `ARRAY['b','a']` would mean every caller had to sort
-- before writing, which is the duplication this closes rather than the rule it wants.
--
-- The CHECK comes after it, as the guard on the guard: with the trigger in place, a row whose
-- allow-list is not normal cannot exist, so the constraint can assert it — and it is a VALIDATED
-- check, which 0039 records as the one scan that sees every row, so it also proves no such row
-- exists today.
CREATE OR REPLACE FUNCTION crm.notification_endpoint_normalise_kinds()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.kinds := crm.normalise_notification_kinds(NEW.kinds);
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER notification_endpoint_normalise_kinds
  BEFORE INSERT OR UPDATE ON crm.notification_endpoint
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_normalise_kinds();

-- Normalise what is already there before asserting it, or the CHECK below refuses a database whose
-- rows were written under the old rule.
--
-- TWO GUARDS COME OFF, AND BOTH ARE DELIBERATE.
--
-- FORCE ROW LEVEL SECURITY, because this runs as `crm_app`, which owns the table and is subject to
-- its policy like anybody else: with no tenant context the UPDATE touches zero rows and reports
-- success, which is 0032's exact failure.
--
-- AND 0060's `notification_endpoint_guard`, which refuses a direct UPDATE of `kinds` in so many
-- words — "derived from crm.notification_endpoint_change and cannot be updated directly. Insert a
-- change row with an author and a reason." That guard is right and this write is not an
-- amendment: nothing about any endpoint's MEANING changes here, only the spelling of an array,
-- so there is no author to name and no reason to give, and writing a change row claiming an
-- amendment that did not happen is the thing section 3 below exists to prevent. So the guard is
-- stood down by name, for one statement, and put back — the shape `wipeEndpoints` uses, and for
-- the same reason: undoing a guarantee visibly beats finding a statement that slips past it.
--
-- FOUND BY RUNNING IT, not by reading it. On an empty database this UPDATE touches no rows and
-- every test passes; the guard only speaks when there is something to normalise. A throwaway
-- database migrated to 0071, given one denormal endpoint and then handed this file, is what
-- turned a green suite into `ERROR: … cannot be updated directly`.
ALTER TABLE crm.notification_endpoint NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_endpoint DISABLE TRIGGER notification_endpoint_guard;

UPDATE crm.notification_endpoint
   SET kinds = crm.normalise_notification_kinds(kinds)
 WHERE kinds IS DISTINCT FROM crm.normalise_notification_kinds(kinds);

ALTER TABLE crm.notification_endpoint ENABLE TRIGGER notification_endpoint_guard;
ALTER TABLE crm.notification_endpoint FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.notification_endpoint
  ADD CONSTRAINT notification_endpoint_kinds_normal
    CHECK (kinds IS NULL OR kinds = crm.normalise_notification_kinds(kinds));

-- ---------------------------------------------------------------------------
-- 3. The amendment log, which is where the comparison lives.
-- ---------------------------------------------------------------------------
--
-- THE REASON THIS CANNOT BE LEFT TO THE TRIGGER ABOVE. `crm.notification_endpoint` is a projection
-- of this log (0060): `notification_endpoint_change_apply` reads the live row into the `_from`
-- columns, compares them with the `_to` columns, refuses an amendment that changes nothing, and
-- then applies it. With the endpoint normalised and the log not, an amendment supplying
-- `ARRAY['b','a']` against a stored `ARRAY['a','b']` would pass that comparison, write a log row
-- claiming a change, and then normalise to exactly what was there — a history asserting an
-- amendment that never happened. So the log normalises `kinds_to` BEFORE the comparison, and the
-- two agree by construction.
--
-- REPRODUCED IN FULL from `pg_proc`, not from 0060 — `CREATE OR REPLACE FUNCTION` replaces a whole
-- body, and the newest definition of a function several migrations have touched is not in the file
-- that created it. One line added, nothing else changed.
CREATE OR REPLACE FUNCTION crm.notification_endpoint_change_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur record;
BEGIN
  -- 0072. Before anything reads it: the comparison below and the row this log keeps must be about
  -- the same array, and `crm.notification_endpoint` normalises what it stores.
  NEW.kinds_to := crm.normalise_notification_kinds(NEW.kinds_to);

  SELECT min_severity, kinds, enabled, description INTO cur
    FROM crm.notification_endpoint
   WHERE tenant_id = NEW.tenant_id AND id = NEW.endpoint_id
     FOR UPDATE;
  IF cur IS NULL THEN
    -- Unreachable through the foreign key, which is checked after this trigger; named so a
    -- future caller that reaches it gets a sentence rather than a null-field error.
    RAISE EXCEPTION 'no notification endpoint % in this tenant', NEW.endpoint_id
      USING ERRCODE = 'no_data_found';
  END IF;

  NEW.min_severity_from := cur.min_severity;
  NEW.kinds_from        := cur.kinds;
  NEW.enabled_from      := cur.enabled;
  NEW.description_from  := cur.description;

  IF NEW.min_severity_to = NEW.min_severity_from
     AND NEW.kinds_to IS NOT DISTINCT FROM NEW.kinds_from
     AND NEW.enabled_to IS NOT DISTINCT FROM NEW.enabled_from
     AND NEW.description_to IS NOT DISTINCT FROM NEW.description_from THEN
    RAISE EXCEPTION
      'that endpoint amendment changes nothing (endpoint % is already %, enabled=%)',
      NEW.endpoint_id, cur.min_severity, cur.enabled
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE crm.notification_endpoint
     SET min_severity = NEW.min_severity_to,
         kinds        = NEW.kinds_to,
         enabled      = NEW.enabled_to,
         description  = NEW.description_to,
         updated_at   = now()
   WHERE tenant_id = NEW.tenant_id AND id = NEW.endpoint_id;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The index nothing references.
-- ---------------------------------------------------------------------------
--
-- `crm.notification` has carried `UNIQUE (tenant_id, id)` since 0021, when the delivery table
-- referenced it compositely. 0046 dropped that key so a delivery record could outlive the
-- notification it describes, and nothing has referenced it since — which this file verified from
-- `pg_constraint` rather than by reading migrations, and which the new drift guard now asserts for
-- every table rather than for this one.
--
-- IT IS NOT FREE: a unique constraint is an index, and every inbox write maintains it. A signal
-- fanned out to three endpoints writes one notification row, and an expiry sweep writes thousands
-- in one transaction.
--
-- NOTHING IS LOST BY DROPPING IT. `id` is the primary key, so a lookup by id is already served,
-- and the tenant term in every query is a filter under a policy rather than a selectivity problem.
-- What a composite key GAVE was the ability to be referenced by `(tenant_id, id)` — the thing
-- 0035 and 0037 made every reference in this schema do — and the moment something needs that
-- again it comes back in the migration that needs it, which is what this one is for the other
-- direction. The row said this "wants its own migration and its own reason"; this is both.
ALTER TABLE crm.notification DROP CONSTRAINT notification_tenant_id_id_key;
