-- Three bespoke logs would have been the mistake. One mechanism, attachable to any table.
--
-- 0059 gave `crm.disposal_policy` an append-only log and made the row a projection of it.
-- 0060 did the same for `crm.notification_endpoint`. Both were right and both were hand-built:
-- a table of typed `*_from`/`*_to` columns, a trigger that applies them, a guard that refuses a
-- direct UPDATE, a store function rewritten to INSERT instead, and a fixture tax across every
-- suite that touched the table. Roughly 200 lines of SQL each, and the next tenant-wide
-- parameter would have wanted the same again.
--
-- 0060's own closing note said where the line was: "three bespoke logs is the point at which
-- this should become one mechanism rather than a fourth copy". The third instance is here, and
-- it is two tables rather than one — `crm.notification_policy` (inbox retention horizons, the
-- delivery-evidence horizon, the prune guard and its override window) and
-- `crm.expense_account_map` (which ledger account a category posts to). Both are settable
-- through administrator routes today and neither records who set them.
--
-- WHAT IS DIFFERENT ABOUT THIS ONE, and it is the design rather than a shortcut.
--
-- 0059 and 0060 use PROJECTION: the log is the only write path, the row is derived, and a
-- direct UPDATE is refused outright. This uses OBSERVATION: the row is written normally and an
-- AFTER trigger records what moved, refusing the write when nobody has said who is making it
-- and why. The guarantee is the same — there is no path that changes the row without a record,
-- because the trigger is unconditional and raises rather than skipping — but observation costs
-- one trigger for every table instead of one apparatus per table, and it needs NO change to any
-- store function's signature, because the author travels in a transaction-local setting rather
-- than in an argument every caller has to thread.
--
-- The price is that `before`/`after` are `jsonb` rather than typed columns. That is the right
-- trade HERE and would have been the wrong one there, and the rule is worth stating because a
-- future table has to choose: a history that a SCREEN renders gets typed columns (the field
-- client draws "30 → 7 day(s)" out of 0059's log, and a jsonb dig would be a worse contract for
-- a device to depend on); a history that exists to be AUDITABLE gets this. 0059 and 0060 are
-- deliberately not converted — their shapes are already served over HTTP and one of them is on
-- a screen, so converting would change two shipped contracts for no gain in guarantee.
--
-- THE ACTOR TRAVELS IN A SETTING, the way the tenant already does. `withTenantContext` has set
-- `app.current_tenant_id` with `is_local = true` since 0003 and every RLS policy in the schema
-- reads it; `app.change_actor` and `app.change_reason` are the same mechanism for the same
-- reason — a value that belongs to the whole transaction rather than to one function call.
-- `withAttribution` in `@crm/db` sets both for a block and restores them afterwards.
--
-- SCOPED, NOT ONE-SHOT. The alternative was for the trigger to CONSUME the reason, so that a
-- second write in the same transaction had to state its own. It is more precise and it is
-- worse: a route that legitimately writes twice would fail on its second write, and the honest
-- unit here is the administrative action rather than the statement — one action, one author, one
-- sentence, however many rows it touches. A block that really is two unrelated changes is a
-- route doing two things, which is a different problem.
--
-- AN INSERT IS EXEMPT ONLY IF EVERY ATTRIBUTABLE COLUMN HOLDS ITS DECLARED DEFAULT, and this
-- is the part that makes one rule do the work of 0059's hand-written special case. Both of
-- these tables are provisioned lazily — `policyRow` does
-- `INSERT (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING` on every read, from the scheduler,
-- with no human anywhere near it — and a row that exists at the values a migration declared is
-- not a decision anybody made. But a row created at values somebody CHOSE is exactly a
-- decision, so the exemption is tested against the column defaults read from `pg_attrdef`
-- rather than against a literal restated in a trigger. 0059 hardcoded `(30, false)` and needed
-- a test to catch the day those defaults move; this reads them.
--
-- A column with NO default is never exempt when it holds a value, which is what makes
-- `crm.expense_account_map` work: its `erp_ledger_account_code` is NOT NULL with no default, so
-- every mapping that exists at all was decided by somebody and is recorded as such, while the
-- policy's bare default row is not recorded at all.
--
-- DELETE IS NOT COVERED, for 0059's and 0060's reason: `crm.data_disposition` says `erase` for
-- both of these tables and `executeTenantErasure` removes them with a plain statement at
-- trigger depth 1, so a guard that refused would break a tenant erasure — far worse than what
-- it would prevent. Nothing else deletes either row: the expense map is DEACTIVATED rather than
-- deleted (0006, so a submitted claim's snapshot still has something to point at), and the
-- policy is one row per tenant that nothing removes.

-- ---------------------------------------------------------------------------
-- 1. The log.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.config_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,

  -- The bare table name within `crm`, as `crm.data_disposition` spells it, so the two
  -- registers can be read side by side. Shaped rather than referenced: a change record has to
  -- outlive a table being renamed, and a foreign key into the catalog is not a thing.
  table_name  text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{2,62}$'),

  -- The row this change was to, as its PRIMARY KEY columns. jsonb because the mechanism is
  -- generic and these tables key differently — `crm.notification_policy` on `tenant_id` alone,
  -- `crm.expense_account_map` on `(tenant_id, crm_category)` — and derived from the catalog
  -- inside the trigger rather than declared at the attachment site, so it cannot drift from
  -- the real key.
  row_key     jsonb NOT NULL,

  action      text NOT NULL CHECK (action IN ('created', 'amended')),

  changed_by  uuid NOT NULL,
  -- `clock_timestamp()`, not `now()`, for 0059's reason: `now()` is the transaction clock, so
  -- two changes written in one transaction would tie and "newest first" would pick between
  -- them arbitrarily.
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),

  -- WHAT MOVED, as column names, so the question a reader actually asks — "who changed the
  -- unread horizon" — is an indexed array containment rather than a dig through two documents.
  changed_columns text[] NOT NULL CHECK (cardinality(changed_columns) > 0),

  -- The whole row, before and after. NULL `before` on a creation, which `action` also says —
  -- stated twice because the CHECK below is what keeps them agreeing.
  before      jsonb,
  after       jsonb NOT NULL,

  CONSTRAINT config_change_created_has_no_before CHECK ((action = 'created') = (before IS NULL)),

  -- Composite, like every reference inside `crm` since 0035: a referential check runs with row
  -- security disabled, so a single-column key would let one tenant's record name a rep in
  -- another. RESTRICT because the log is the audit trail and outlives nothing.
  CONSTRAINT config_change_changed_by_fkey
    FOREIGN KEY (tenant_id, changed_by) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE RESTRICT
);

-- The two reads this serves: one table's history, and one tenant's whole configuration history.
CREATE INDEX idx_config_change_table ON crm.config_change (tenant_id, table_name, changed_at DESC);
CREATE INDEX idx_config_change_recent ON crm.config_change (tenant_id, changed_at DESC);
-- GIN, because "which changes touched this column" is containment over an array.
CREATE INDEX idx_config_change_columns ON crm.config_change USING gin (changed_columns);

SELECT crm.apply_tenant_isolation('crm.config_change');

/**
 * The history is history.
 *
 * Same discipline as the custody ledger (0018), a role grant (0023), the disposal policy's log
 * (0059) and an endpoint's (0060).
 */
CREATE OR REPLACE FUNCTION crm.config_change_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'crm.config_change is append-only (attempted % on %). Change the configuration back, with a reason.',
    TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER config_change_append_only
  BEFORE UPDATE OR DELETE ON crm.config_change
  FOR EACH ROW EXECUTE FUNCTION crm.config_change_append_only();

-- ---------------------------------------------------------------------------
-- 2. What the mechanism knows about a table it is attached to.
-- ---------------------------------------------------------------------------
/**
 * Columns whose movement is not a change.
 *
 * Published as a function for 0049's reason: a list inside a plpgsql body cannot be queried, so
 * nothing but a comment could claim what is ignored. `updated_at` moves on every write by
 * definition, and `created_at` is a fact about the row's existence rather than its contents —
 * recording either as "what changed" would make every record read as though two things moved.
 */
CREATE OR REPLACE FUNCTION crm.config_change_ignored_columns()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['created_at', 'updated_at'];
$$;

/**
 * A table's primary-key columns, in key order.
 *
 * From the catalog rather than from an argument at the attachment site: an argument can be
 * wrong, and a key that is wrong produces a record pointing at nothing. Raises for a table with
 * no primary key, because a row with no identity has no history worth keeping — and that
 * refusal fires when the trigger is ATTACHED (section 4 calls this), not on the first write.
 */
CREATE OR REPLACE FUNCTION crm.config_change_key_columns(p_table regclass)
RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cols text[];
BEGIN
  SELECT array_agg(a.attname ORDER BY k.ord) INTO cols
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = p_table AND c.contype = 'p';
  IF cols IS NULL THEN
    RAISE EXCEPTION '% has no primary key, so a change to one of its rows cannot be attributed to a row', p_table
      USING ERRCODE = 'invalid_table_definition';
  END IF;
  RETURN cols;
END
$$;

/**
 * Which of a row's values somebody CHOSE, as opposed to inherited from the schema.
 *
 * One function doing two jobs, because they are the same question asked twice. An INSERT is
 * exempt from attribution when this is empty — a lazily-provisioned row holding nothing but
 * what a migration declared is not a decision anybody made — and when it is not empty, this IS
 * the `changed_columns` of the record: the columns the creator actually decided, rather than
 * every column the table happens to have.
 *
 * Every column that is neither part of the key nor ignored is compared against its DECLARED
 * DEFAULT, read from `pg_attrdef` and cast to the column's own type so the comparison is
 * type-exact rather than jsonb-numeric-approximate. A column with no default counts as chosen
 * only while it holds a value: nothing defaults it, so a value in it is a choice.
 *
 * VOLATILE because it evaluates those defaults, which may be `now()` — and a volatile default
 * on a NON-KEY column (say `gen_random_uuid()`) reads as chosen on every insert and so demands
 * an author. That is the safe direction, and the reason this is not a correctness hazard: the
 * failure mode is a refusal asking who, never a silent exemption.
 */
CREATE OR REPLACE FUNCTION crm.config_change_chosen_columns(p_table regclass, p_row jsonb)
RETURNS text[]
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  col           record;
  default_value jsonb;
  chosen        text[] := ARRAY[]::text[];
BEGIN
  FOR col IN
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS coltype,
           pg_get_expr(d.adbin, d.adrelid) AS declared_default
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = p_table AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> ALL (crm.config_change_key_columns(p_table))
       AND a.attname <> ALL (crm.config_change_ignored_columns())
     ORDER BY a.attname
  LOOP
    IF col.declared_default IS NULL THEN
      IF jsonb_typeof(p_row -> col.attname) NOT IN ('null') AND (p_row -> col.attname) IS NOT NULL THEN
        chosen := chosen || col.attname;
      END IF;
    ELSE
      EXECUTE format('SELECT to_jsonb((%s)::%s)', col.declared_default, col.coltype)
         INTO default_value;
      IF (p_row -> col.attname) IS DISTINCT FROM default_value THEN
        chosen := chosen || col.attname;
      END IF;
    END IF;
  END LOOP;
  RETURN chosen;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The trigger.
-- ---------------------------------------------------------------------------
/**
 * Records a configuration change, or refuses the write.
 *
 * AFTER rather than BEFORE, so the record is of what actually LANDED: a BEFORE trigger beside
 * this one may normalise a value, and a log written before it ran would describe what was asked
 * for rather than what is now true. The transaction is the same either way, so a refusal here
 * still leaves nothing behind.
 *
 * Three refusals, each of which is the mechanism working rather than an obstacle:
 *
 *   * NO ACTOR — the code forgot to open an attribution block. It cannot be the caller's
 *     mistake, because a missing `reason` in a request body is refused by the route's own
 *     schema long before this; so it reaches a client as a 500, which is the honest answer to
 *     "this deployment has a bug".
 *   * NO REASON, same thing, with the same answer.
 * A WRITE THAT MOVES NOTHING IS NOT RECORDED, AND NOT REFUSED, which is where this
 * deliberately parts from 0059 and 0060. Those two refuse a no-op, and for their routes that is
 * the better answer: each is an explicit "set this knob", so a request naming the value already
 * in force is worth a 409 saying so. This mechanism serves tables whose routes do not all mean
 * that — `PUT /v1/admin/expense-accounts/:category` is an upsert with ENSURE semantics, and
 * refusing "make sure this category maps to 6200" because it already does would make an
 * idempotent route non-idempotent. So the universal half is kept here (an empty change is never
 * recorded, because the one log a reader relies on to be short must not fill with rows that say
 * nothing) and the opinionated half is left to the route, which is the only layer that knows
 * what its verb promised.
 *
 * An unattributed no-op is therefore allowed too, and that is not a hole: there is nothing to
 * attribute, because nothing changed.
 */
CREATE OR REPLACE FUNCTION crm.record_config_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_text  text := NULLIF(current_setting('app.change_actor', true), '');
  reason_text text := NULLIF(current_setting('app.change_reason', true), '');
  key_cols    text[] := crm.config_change_key_columns(TG_RELID::regclass);
  after_row   jsonb  := to_jsonb(NEW);
  prior_row   jsonb;
  moved       text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row that holds nothing but what a migration declared is not a decision anybody made;
    -- and what is left when something was chosen is exactly what the record should name.
    moved := crm.config_change_chosen_columns(TG_RELID::regclass, after_row);
    IF cardinality(moved) = 0 THEN
      RETURN NULL;
    END IF;
  ELSE
    prior_row := to_jsonb(OLD);
    SELECT array_agg(k ORDER BY k) INTO moved
      FROM jsonb_object_keys(after_row) AS k
     WHERE (after_row -> k) IS DISTINCT FROM (prior_row -> k)
       AND k <> ALL (key_cols) AND k <> ALL (crm.config_change_ignored_columns());
    -- Nothing attributable moved. Not recorded and not refused — see the header.
    IF moved IS NULL OR cardinality(moved) = 0 THEN
      RETURN NULL;
    END IF;
  END IF;

  IF actor_text IS NULL OR reason_text IS NULL THEN
    RAISE EXCEPTION
      'config-change-unattributed: a change to crm.% must name who is making it and why — open an attribution block (withAttribution) before writing a tenant''s configuration',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO crm.config_change
    (tenant_id, table_name, row_key, action, changed_by, reason, changed_columns, before, after)
  VALUES
    (NEW.tenant_id, TG_TABLE_NAME,
     -- Only the key columns, which `jsonb_object_keys` cannot select for us.
     (SELECT jsonb_object_agg(k, after_row -> k) FROM unnest(key_cols) AS k),
     CASE TG_OP WHEN 'INSERT' THEN 'created' ELSE 'amended' END,
     actor_text::uuid, reason_text, moved, prior_row, after_row);

  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Attaching it.
-- ---------------------------------------------------------------------------
/**
 * Puts a table's configuration under attribution.
 *
 * One statement per table, deliberately shaped like `crm.apply_tenant_isolation` (0002) —
 * which exists so "the policy text cannot drift table to table" — for the same reason: a
 * mechanism that is attached by hand five times is a mechanism that is attached four ways.
 *
 * `crm.config_change_key_columns` is called here as well as in the trigger, so a table with no
 * primary key is refused when it is ATTACHED rather than on somebody's first write months
 * later.
 */
CREATE OR REPLACE FUNCTION crm.require_config_attribution(tbl regclass)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  trigger_name text := replace(tbl::text, 'crm.', '') || '_config_attribution';
BEGIN
  PERFORM crm.config_change_key_columns(tbl);
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER %I AFTER INSERT OR UPDATE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION crm.record_config_change()',
    trigger_name, tbl::text);
END
$$;

-- The two tables 0060's closing note named. Both are settable through administrator routes and
-- neither recorded who: the inbox retention horizons and the prune guard that stops a typo'd
-- horizon deleting a tenant's whole inbox, and the category-to-account map that decides which
-- ledger account a rep's spend posts to.
SELECT crm.require_config_attribution('crm.notification_policy');
SELECT crm.require_config_attribution('crm.expense_account_map');

-- ---------------------------------------------------------------------------
-- 5. The retention decision, which arrives with the table (0051).
--
-- UNDECIDED, with the question that follows from what it holds. The two tables it records are
-- `erase`, and a log of changes to configuration that is itself erasable looks like it should
-- follow — except that one of the things it records is which LEDGER ACCOUNT a category posted
-- to, and `crm.expense_claim` is RETAINED under `financial_transactions_7y` with its account
-- snapshot. A retained claim whose mapping history was erased is a posting nobody can explain.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('config_change', 'undecided', NULL, NULL, NULL,
  'The record that a named employee changed a tenant''s configuration: inbox retention horizons, the prune guard, and which ERP ledger account an expense category posts to. The last of those explains postings on claims that crm.expense_claim retains for seven years under financial_transactions_7y — so does this log inherit that obligation for the rows that touch expense_account_map, or is it erasable in full with the configuration it describes?',
  NULL, NULL)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE crm.config_change IS
  'Append-only log of attributed changes to tenant configuration, written by crm.record_config_change() for every table put under crm.require_config_attribution(). The author and reason travel in app.change_actor and app.change_reason, set for a block by withAttribution in @crm/db.';
COMMENT ON FUNCTION crm.require_config_attribution(regclass) IS
  'Puts a configuration table under attribution: every INSERT that is not the declared default row, and every UPDATE, must name an author and a reason or be refused.';
