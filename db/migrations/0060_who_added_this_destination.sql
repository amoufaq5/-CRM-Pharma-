-- Who added this destination for the tenant's signals, and who turned it off?
--
-- THE LAST CLAUSE OF 0023'S HEADER. That migration named two tables settable "only by
-- someone with a psql prompt — which in practice means settable by anyone with the
-- application password, with no record of who changed what". 0059 answered the first,
-- `crm.disposal_policy`. This is the second.
--
-- AND IT IS THE MORE SENSITIVE OF THE TWO. A disposal policy is a number reps are measured
-- against. An endpoint is where a notification GOES: 0021 is explicit that a notification
-- "carries a rep's name, an account id and sometimes a lot number", which is why the url
-- CHECK admits `https://` and loopback and nothing else. Adding an endpoint adds a data
-- egress to a third party. Until now the row recording that egress said when it was created
-- and nothing about who created it, or why.
--
-- Disabling one is the mirror image and no less consequential: the signals simply stop. The
-- nightly disposal sweep goes on raising obligations, the webhook goes on not firing, and
-- nobody is told — which is precisely the `enabled`-but-silent state 0034's probe exists to
-- expose, arrived at by an UPDATE nobody can attribute.
--
-- TWO MECHANISMS, BECAUSE THERE ARE TWO KINDS OF FACT HERE, and using one for both would be
-- the mistake:
--
--   * WHAT AN ENDPOINT IS — its channel, url and secret_env — is already FROZEN for the life
--     of the row (0049), because a delivery record names the destination it went to and a
--     repointed url would make every earlier record wrong. A frozen fact is row data, not an
--     event, so the creation's author and reason join it as columns and 0049's own freeze
--     list is extended to cover them. The creation record is then as immutable as the
--     destination it describes, by the mechanism that already guards it.
--
--   * HOW AN ENDPOINT IS TUNED — min_severity, kinds, enabled, description — changes over
--     time, so it gets a log. `crm.notification_endpoint_change` is append-only, attributed
--     and reasoned, and the endpoint's four tunable columns are a PROJECTION of it: inserting
--     a change is the only way to amend an endpoint, exactly as 0059 made the disposal policy
--     a projection of its own log and 0018 made a holding a projection of the custody ledger.
--
-- NO BACKFILL, AND THAT IS 0047'S DISTINCTION RATHER THAN A CONCESSION. The new columns are
-- nullable and a BEFORE INSERT trigger requires them, because this is a rule about the ACT of
-- creating an endpoint: "a freeze governs an act, so no existing row can be wrong" (0040,
-- quoted by 0049). An endpoint created before this migration is not a rule violation — it is
-- from before the rule, and its NULL author is the honest record of that. A NOT NULL with a
-- made-up default would have invented an author instead, which is worse than admitting there
-- is none.
--
-- WHAT IS STILL ALLOWED, and both for reasons that would be worse to get wrong:
--
--   * DELETE, because `crm.data_disposition` says `erase` for this table and
--     `executeTenantErasure` removes it with a plain statement at trigger depth 1. A guard
--     that refused would break a tenant erasure. Nothing else deletes an endpoint — there is
--     no DELETE route, and `enabled = false` is how an endpoint stops — so this is the
--     erasure's door and not a general one.
--   * An UPDATE from inside the change log's trigger, which is the whole point, and 0049's
--     freeze trigger still runs beside it. Trigger order for one event is alphabetical, so
--     `notification_endpoint_freeze_destination` fires before `notification_endpoint_guard`
--     and an attempt to repoint a url directly still gets the better-aimed sentence.

-- ---------------------------------------------------------------------------
-- 1. Who added this destination.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_endpoint ADD COLUMN created_by uuid;
ALTER TABLE crm.notification_endpoint ADD COLUMN created_reason text
  CHECK (created_reason IS NULL OR length(created_reason) BETWEEN 10 AND 1000);

-- Composite, like every other reference inside `crm` (0035/0037): a referential check runs
-- with row security disabled, so a single-column key would let one tenant's endpoint name a
-- rep in another. RESTRICT because this is the audit trail and outlives nothing.
ALTER TABLE crm.notification_endpoint
  ADD CONSTRAINT notification_endpoint_created_by_fkey
  FOREIGN KEY (tenant_id, created_by) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE RESTRICT;

/**
 * The creation record is as frozen as the destination it describes.
 *
 * 0049 publishes the frozen set as a function rather than a comment so that something can
 * query it; adding to that function is how a new frozen column arrives, and the existing
 * `notification_endpoint_freeze_destination` trigger picks it up with no further change.
 *
 * `created_at` is NOT in the list and the omission is deliberate: it has no author to
 * contradict and `updated_at` next to it moves on every amendment, so freezing one
 * timestamp and not the other would be a rule nobody could state.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_frozen_columns()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['channel', 'url', 'secret_env', 'created_by', 'created_reason'];
$$;

/**
 * And the refusal gets a second sentence, because the first one is now wrong for two of the
 * five columns it guards.
 *
 * 0049's message explains a frozen DESTINATION: "endpoint X has delivery records naming url
 * = …, so it cannot become … — every notification already pushed would start claiming it
 * went somewhere it did not." Measured against a `created_by` rewrite, that sentence sends an
 * operator hunting through delivery records for a problem that is not there. The columns are
 * frozen for related but distinct reasons — one so the delivery log stays true about WHERE,
 * the other so it stays true about WHO AUTHORISED it — and a guard that cannot tell an
 * operator which rule they broke is the flaw this repository keeps fixing elsewhere
 * (`visit_final` versus `invalid_transition`, `lot_expired` versus `insufficient_stock`).
 *
 * One list, one trigger, two sentences. The list stays queryable, which is 0049's reason for
 * publishing it as a function in the first place.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_freeze_destination()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col        text;
  after_row  jsonb;
  prior_row  jsonb;
BEGIN
  after_row := to_jsonb(NEW);
  prior_row := to_jsonb(OLD);

  FOREACH col IN ARRAY crm.notification_endpoint_frozen_columns() LOOP
    IF (after_row ->> col) IS DISTINCT FROM (prior_row ->> col) THEN
      IF col IN ('created_by', 'created_reason') THEN
        RAISE EXCEPTION
          'endpoint-creation-frozen: endpoint % was added by somebody for a stated reason, and % cannot be rewritten (% to %). The record of who opened a route out of this tenant is not editable; disable this endpoint and create a new one.',
          OLD.id, col,
          COALESCE(prior_row ->> col, 'null'), COALESCE(after_row ->> col, 'null')
          USING ERRCODE = 'check_violation';
      END IF;
      RAISE EXCEPTION
        'endpoint-destination-frozen: endpoint % has delivery records naming % = %, so it cannot become % — every notification already pushed would start claiming it went somewhere it did not. Disable this endpoint and create a new one.',
        OLD.id, col,
        COALESCE(prior_row ->> col, 'null'), COALESCE(after_row ->> col, 'null')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The amendment log, which the tunable columns are a projection of.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification_endpoint_change (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,

  endpoint_id    uuid NOT NULL,
  changed_by     uuid NOT NULL,
  -- `clock_timestamp()`, not `now()`, for 0059's reason: `now()` is the transaction clock, so
  -- two amendments in one transaction would share a timestamp to the microsecond and "newest
  -- first" would pick between them arbitrarily.
  changed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),

  -- THE COMPLETE STATE, BEFORE AND AFTER, rather than only what moved.
  --
  -- Two of these four columns are legitimately NULL at rest — `kinds` NULL means every kind,
  -- `description` NULL means none — so "not specified by the caller" and "set to null" are
  -- indistinguishable in a partial record, and a COALESCE against the live row would read
  -- "clear the allow-list" as "leave it alone". So the caller supplies all four `*_to`
  -- values, merged from the live row under `FOR UPDATE`, and the trigger supplies all four
  -- `*_from` values itself. "Did the allow-list change" is then
  -- `kinds_from IS DISTINCT FROM kinds_to` and needs no flag.
  min_severity_from  text NOT NULL,
  min_severity_to    text NOT NULL,
  kinds_from         text[],
  kinds_to           text[],
  enabled_from       boolean NOT NULL,
  enabled_to         boolean NOT NULL,
  description_from   text,
  description_to     text,

  -- Something actually moved. In the trigger too, where the refusal is readable; here
  -- because this is the one that survives somebody rewriting the trigger.
  CONSTRAINT notification_endpoint_change_is_a_change CHECK (
    min_severity_from <> min_severity_to
    OR kinds_from IS DISTINCT FROM kinds_to
    OR enabled_from IS DISTINCT FROM enabled_to
    OR description_from IS DISTINCT FROM description_to
  ),

  CONSTRAINT notification_endpoint_change_endpoint_id_fkey
    FOREIGN KEY (tenant_id, endpoint_id) REFERENCES crm.notification_endpoint (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT notification_endpoint_change_changed_by_fkey
    FOREIGN KEY (tenant_id, changed_by) REFERENCES crm.rep_profile (tenant_id, id)
    ON DELETE RESTRICT
);

-- The read is always one endpoint's history, newest first.
CREATE INDEX idx_notification_endpoint_change_history
  ON crm.notification_endpoint_change (tenant_id, endpoint_id, changed_at DESC);

SELECT crm.apply_tenant_isolation('crm.notification_endpoint_change');

/**
 * Applies an amendment, and stamps what it changed FROM.
 *
 * The `*_from` values are the database's and are never accepted from the caller — 0059's
 * rule, for its reason: a log whose previous value is whatever the writer claimed is not
 * evidence of anything. A client could record "urgent → urgent" and make a real loosening
 * read as a no-op.
 *
 * `FOR UPDATE` serialises two amendments racing, so the second one's `from` is the first
 * one's `to` rather than both recording the same starting point — and it is the same lock the
 * caller takes when it reads the row to merge a partial PATCH, so the merge and the apply see
 * one consistent state.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_change_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur record;
BEGIN
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

CREATE TRIGGER notification_endpoint_change_apply
  BEFORE INSERT ON crm.notification_endpoint_change
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_change_apply();

/**
 * The history is history.
 *
 * Same discipline as the custody ledger (0018), a role grant (0023) and the disposal policy's
 * log (0059): a record of what an endpoint used to receive is worth nothing if it can be
 * edited afterwards. A mistake is corrected by amending the endpoint back, with a reason,
 * which leaves both the error and the correction in the log.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_change_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.notification_endpoint_change is append-only (attempted % on %). Amend the endpoint back, with a reason.',
    TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER notification_endpoint_change_append_only
  BEFORE UPDATE OR DELETE ON crm.notification_endpoint_change
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_change_append_only();

-- ---------------------------------------------------------------------------
-- 3. The endpoint's own guard: attributed on creation, amended only through the log.
-- ---------------------------------------------------------------------------
/**
 * An endpoint is created by somebody, for a stated reason, and tuned only through its log.
 *
 * `pg_trigger_depth() > 1` is 0018's test for "we were reached from the log's trigger rather
 * than from a client statement", and it is the whole mechanism on the UPDATE side.
 *
 * On the INSERT side the rule is about the act, so it needs no backfill and makes no claim
 * about rows that predate it — see the header. The reason is required for the same reason
 * 0059 requires one: "adding a webhook" is not an answer to why a tenant's notifications now
 * leave the building, and a conditional requirement is the kind of evidence that is missing
 * in the one case somebody wanted it missing.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS NULL OR NEW.created_reason IS NULL THEN
      RAISE EXCEPTION
        'a notification endpoint must name the rep who added it and why — it is where this tenant''s signals leave the building'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'crm.notification_endpoint''s severity, kinds, enabled and description are derived from crm.notification_endpoint_change and cannot be updated directly. Insert a change row with an author and a reason.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER notification_endpoint_guard
  BEFORE INSERT OR UPDATE ON crm.notification_endpoint
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_guard();

-- ---------------------------------------------------------------------------
-- 4. The retention decision, which arrives with the table (0051).
--
-- UNDECIDED, and the question is real. The endpoint row itself is `erase` — where a deleted
-- tenant wanted its webhooks pointed serves nobody, and 0051 is right about that. This table
-- is not the configuration though: it is the record that a named employee turned a tenant's
-- signals off, or narrowed what a third party was told. `crm.notification_delivery` is the
-- evidence of what was actually pushed and 0046 and 0048 deliberately made it outlive both
-- its parents for exactly that reason; whether the record of who AUTHORISED those pushes
-- survives the controller's erasure request is the same question, and it has to be answered
-- with the delivery log rather than separately.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('notification_endpoint_change', 'undecided', NULL, NULL, NULL,
  'The record that a named employee changed where a tenant''s notifications are pushed, or stopped them: the authorisation behind every row in crm.notification_delivery, which 0046 and 0048 made outlive both its parents as evidence of a push to a third party. Does that authorisation survive the controller''s erasure request, and must it be answered together with the delivery log it explains?',
  NULL, NULL)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE crm.notification_endpoint_change IS
  'Append-only log of amendments to an endpoint''s tuning. The endpoint''s min_severity, kinds, enabled and description are a projection of this table; its channel, url and secret_env are frozen (0049) and never appear here.';
COMMENT ON COLUMN crm.notification_endpoint.created_by IS
  'The rep who added this destination. NULL only for an endpoint created before 0060, which is the honest record of a row from before the rule rather than an invented author.';
