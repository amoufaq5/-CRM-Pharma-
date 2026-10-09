-- Who shortened the grace period from thirty days to seven, when, and why?
--
-- THE DEFECT, and it is 0023's own words left half-answered. That migration's header
-- names the debt it was written to clear:
--
--     `crm.disposal_policy` (0020) and `crm.notification_endpoint` (0021) were therefore
--     settable only by someone with a psql prompt — which in practice means settable by
--     anyone with the application password, WITH NO RECORD OF WHO CHANGED WHAT.
--
-- 0023 built the role model and answered the first half: `PUT /v1/admin/samples/disposal-policy`
-- requires the `compliance` role, and a district manager with a full team is refused. The
-- second half was never built. The write is still
--
--     UPDATE crm.disposal_policy SET grace_days = 7, updated_at = now()
--
-- which leaves a timestamp and nothing else: not who, not what it was before, not why. These
-- are the SOP parameters every rep in the tenant is measured against — the days they get
-- before an obligation goes overdue, and whether a machine may write off promotional material
-- at all — and the question an inspector asks about an SOP parameter is never "what is it
-- now". It is "what was it in March, who changed it, and on whose authority".
--
-- Worse than absent: the shape of the UPDATE makes the absence invisible. `updated_at` moves,
-- so the row LOOKS maintained. A reader cannot tell a policy that has stood untouched for a
-- year from one that was loosened last Tuesday by someone who then lost the role.
--
-- THE RULE IS ALREADY IN THIS SCHEMA, one table over. 0018 refuses a direct write to
-- `crm.sample_holding` because "the balance is a projection of the ledger. Allowing a bare
-- UPDATE would reopen exactly the gap this file closes — a number that disagrees with the
-- movements behind it and no way to tell which is wrong." A policy knob is a balance and a
-- policy change is a movement. So:
--
--   * `crm.disposal_policy_change` is the ledger: append-only, attributed, reasoned, carrying
--     both the old value and the new one;
--   * inserting a change is the ONLY way to change the policy — a trigger applies it;
--   * `crm.disposal_policy` refuses a direct UPDATE, by the same `pg_trigger_depth()` test
--     0018 uses, so the policy row cannot drift from the log that explains it.
--
-- THE `from` VALUES ARE STAMPED BY THE DATABASE, never accepted from the caller. A log where
-- the previous value is whatever the writer claimed it was is not evidence of anything: a
-- client could record "30 → 7" while the row had already been 7, or "7 → 7" to make a real
-- loosening look like a no-op. The trigger reads the live row under `FOR UPDATE` and
-- overwrites whatever arrived. The caller supplies only what they want it to BECOME, and the
-- reason.
--
-- A REASON IS REQUIRED, not required-when-it-tightens. Conditional evidence is the kind that
-- is missing in the one case somebody wanted it missing, and the direction a change "tightens"
-- in is not even obvious — a shorter grace period is stricter on reps and better for
-- compliance, and turning promo auto-write-off ON is the one setting that lets a scheduled job
-- remove material from a balance with no person involved, which 0020's entire header exists to
-- argue against for drug samples. Ten characters minimum, which is enough to stop `.` and not
-- enough to pretend prose is guaranteed.
--
-- A NO-OP IS REFUSED rather than recorded. A change row that changes nothing is noise in the
-- one log a reader is relying on to be short, and the API already refuses an empty body; this
-- is the same rule where it cannot be forgotten.
--
-- WHAT IS DELIBERATELY STILL ALLOWED on `crm.disposal_policy`:
--
--   * INSERT **of the default row only**, because it is created lazily on first read (0020's
--     own choice: "a policy row for a tenant that has no samples is noise"). An INSERT that
--     NAMES a value is refused: a fresh tenant whose policy was created at seven days by a
--     psql prompt would be a policy nobody set, which is the whole defect in a new costume.
--     The bootstrap story is 0023's — start at the defaults, grant the role, change it
--     through the log — and a tenant with no rep profiles has nobody to measure anyway. An
--     `INSERT … ON CONFLICT DO UPDATE` cannot sneak past either, because the DO UPDATE path
--     fires the BEFORE UPDATE trigger like any other update (measured, not assumed).
--   * DELETE, because `crm.data_disposition` says `erase` for this table and
--     `executeTenantErasure` deletes it with a plain statement at trigger depth 1. A guard
--     that refused would break a tenant erasure, which is a far worse outcome than the one it
--     would prevent — and the deletion is not unrecorded anyway: it happens under a signed
--     tombstone that attests the row count it removed.
--
-- NO FOUR EYES, and the reason is operational rather than principled. 0023 accepted that a
-- tenant needs two administrators to stay administrable, because a role grant is rare. An SOP
-- parameter is rarer still, and requiring a second compliance officer to approve every change
-- would mean a tenant with one compliance officer cannot set its own grace period at all —
-- with the only workaround being the psql prompt this whole lineage exists to get away from.
-- Attribution plus an append-only history is the level that fits; if a deployment wants four
-- eyes it is a rule to add here, over a log that already exists.

CREATE TABLE crm.disposal_policy_change (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,

  -- WHO. Required, and never the process: every write path resolves a principal, so a change
  -- with no author would have to come from SQL — which is exactly the state this closes.
  changed_by     uuid NOT NULL,
  -- `clock_timestamp()`, not `now()`, and the difference is the only ordering this log has.
  -- `now()` is the TRANSACTION clock, so two changes written in one transaction share a
  -- timestamp to the microsecond and "newest first" picks between them arbitrarily — which
  -- is how the first hand-test of this table read back the wrong row. The wall clock at the
  -- moment of the statement is also simply what `changed_at` claims to be.
  changed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- WHY. See the header: required for every change, in both directions.
  reason         text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),

  -- WHAT, both halves. Stamped by the trigger from the live row; see the header.
  grace_days_from          integer NOT NULL CHECK (grace_days_from BETWEEN 0 AND 365),
  grace_days_to            integer NOT NULL CHECK (grace_days_to   BETWEEN 0 AND 365),
  auto_writeoff_promo_from boolean NOT NULL,
  auto_writeoff_promo_to   boolean NOT NULL,

  -- Something actually moved. Enforced here as well as in the trigger: the trigger is the
  -- readable refusal, this is the one that survives somebody rewriting the trigger.
  CONSTRAINT disposal_policy_change_is_a_change CHECK (
    grace_days_from <> grace_days_to OR auto_writeoff_promo_from IS DISTINCT FROM auto_writeoff_promo_to
  ),

  -- Composite, like every other reference inside `crm` (0035/0037): a referential check runs
  -- with row security disabled, so a single-column key would let one tenant's change row name
  -- a rep in another. RESTRICT because this row is the audit trail and outlives nothing — the
  -- same reading every `*_by` reference in this schema carries.
  CONSTRAINT disposal_policy_change_changed_by_fkey
    FOREIGN KEY (tenant_id, changed_by) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE RESTRICT
);

-- The read is always "this tenant's changes, newest first", which is both the screen and the
-- provenance line on the policy itself.
CREATE INDEX idx_disposal_policy_change_recent
  ON crm.disposal_policy_change (tenant_id, changed_at DESC);

SELECT crm.apply_tenant_isolation('crm.disposal_policy_change');

/**
 * Applies a policy change, and stamps what it changed FROM.
 *
 * BEFORE INSERT rather than AFTER, so the row that lands already carries the old values and
 * no second statement can be lost between the two.
 *
 * Self-provisioning, like `disposalPolicy()` in `@crm/sample`: a tenant whose default row has
 * never been read still has a policy — the defaults — and a first change must not fail on a
 * missing row. `FOR UPDATE` serialises two changes racing, so the second one's `from` is the
 * first one's `to` rather than both recording the same starting point.
 */
CREATE OR REPLACE FUNCTION crm.disposal_policy_change_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur record;
BEGIN
  INSERT INTO crm.disposal_policy (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT grace_days, auto_writeoff_promo INTO cur
    FROM crm.disposal_policy WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  -- Whatever arrived in the `from` columns is discarded. The caller does not get to say what
  -- the policy used to be.
  NEW.grace_days_from := cur.grace_days;
  NEW.auto_writeoff_promo_from := cur.auto_writeoff_promo;

  -- A change may name one knob or both; the one it leaves out keeps its value, so the row
  -- still reads as a complete statement of the policy before and after.
  NEW.grace_days_to := COALESCE(NEW.grace_days_to, cur.grace_days);
  NEW.auto_writeoff_promo_to := COALESCE(NEW.auto_writeoff_promo_to, cur.auto_writeoff_promo);

  IF NEW.grace_days_to = NEW.grace_days_from
     AND NEW.auto_writeoff_promo_to IS NOT DISTINCT FROM NEW.auto_writeoff_promo_from THEN
    RAISE EXCEPTION
      'that disposal policy change changes nothing (grace_days % and auto_writeoff_promo % are already in force)',
      cur.grace_days, cur.auto_writeoff_promo
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE crm.disposal_policy
     SET grace_days = NEW.grace_days_to,
         auto_writeoff_promo = NEW.auto_writeoff_promo_to,
         updated_at = now()
   WHERE tenant_id = NEW.tenant_id;

  RETURN NEW;
END
$$;

CREATE TRIGGER disposal_policy_change_apply
  BEFORE INSERT ON crm.disposal_policy_change
  FOR EACH ROW EXECUTE FUNCTION crm.disposal_policy_change_apply();

/**
 * The history is history.
 *
 * Same discipline as the custody ledger (0018) and as a role grant (0023): a record of what
 * an SOP parameter used to be is worth nothing if it can be edited afterwards. A mistake is
 * corrected by changing the policy back, with a reason, which leaves both the error and the
 * correction in the log.
 */
CREATE OR REPLACE FUNCTION crm.disposal_policy_change_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.disposal_policy_change is append-only (attempted % on %). Change the policy back, with a reason.',
    TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER disposal_policy_change_append_only
  BEFORE UPDATE OR DELETE ON crm.disposal_policy_change
  FOR EACH ROW EXECUTE FUNCTION crm.disposal_policy_change_append_only();

/**
 * Nothing changes the policy directly.
 *
 * `pg_trigger_depth() > 1` is 0018's own test for "we were reached from the log's trigger
 * rather than from a client statement", and it is the whole mechanism: the policy row is a
 * projection of the change log, exactly as a holding is a projection of the ledger.
 *
 * INSERT and DELETE are allowed, for the reasons the header gives at length — the lazy default
 * row, and the tenant erasure that must be able to remove it.
 */
CREATE OR REPLACE FUNCTION crm.disposal_policy_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The lazy default row, and nothing else. The literals are 0020's declared column
    -- defaults, named here a second time because a trigger cannot ask a column what its
    -- default is — so a contract test inserts a bare row and asserts it is ACCEPTED, which
    -- turns a later change to either default into an immediate red test rather than a
    -- silently un-creatable policy.
    IF (NEW.grace_days, NEW.auto_writeoff_promo) IS DISTINCT FROM (30, false) THEN
      RAISE EXCEPTION
        'a disposal policy is created at the defaults and changed through crm.disposal_policy_change (attempted grace_days=%, auto_writeoff_promo=%)',
        NEW.grace_days, NEW.auto_writeoff_promo
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'crm.disposal_policy is derived from crm.disposal_policy_change and cannot be updated directly. Insert a change row with an author and a reason.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER disposal_policy_guard
  BEFORE INSERT OR UPDATE ON crm.disposal_policy
  FOR EACH ROW EXECUTE FUNCTION crm.disposal_policy_guard();

-- ---------------------------------------------------------------------------
-- The retention decision, which arrives with the table (0051).
--
-- UNDECIDED, and the question is real rather than a placeholder. The policy row itself is
-- `erase` — a config knob of a tenant that no longer exists serves nobody — but this table is
-- not a knob. It is the record that a named employee changed the deadline a regulated disposal
-- is measured against, which is the same kind of thing as `disposal_obligation`, and that row
-- has been `undecided` since 0051 for exactly the reason that applies here. The two must be
-- answered together: keeping obligations while erasing the policy they were judged under
-- leaves a deadline nobody can explain, and keeping the changes while erasing the obligations
-- leaves an explanation of nothing.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('disposal_policy_change', 'undecided', NULL, NULL, NULL,
  'The record that a named employee changed the grace period or the promo auto-write-off switch, when, and why. It is the authority a disposal deadline was set under, so it follows whatever is decided for disposal_obligation — and must be decided WITH it, because retaining either alone leaves a record that cannot be read.',
  NULL, NULL)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE crm.disposal_policy_change IS
  'Append-only log of changes to the tenant''s disposal SOP parameters. The policy row is a projection of this table, as a holding is of the custody ledger.';
COMMENT ON COLUMN crm.disposal_policy_change.grace_days_from IS
  'The value in force immediately before this change, stamped by the trigger from the live row — never accepted from the caller, because a log whose previous value is whatever the writer claimed is not evidence.';
