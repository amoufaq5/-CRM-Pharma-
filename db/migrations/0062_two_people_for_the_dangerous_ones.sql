-- Some configuration changes should take two people. Not all of them, and the difference
-- is the whole design.
--
-- WHAT IS BROKEN. 0059, 0060 and 0061 answered "who changed this, and why" for every
-- tenant-wide setting in this schema. None of them answered "and was anybody else asked".
-- Two of those settings can be changed by one person and cause harm that no later record
-- undoes:
--
--   * `crm.disposal_policy.auto_writeoff_promo` TURNING ON. 0059's own header names it:
--     "the one setting that lets a scheduled job remove material from a balance with no
--     person involved, which 0020's entire header exists to argue against for drug
--     samples". One compliance officer arms an unattended destruction job. Turning it off
--     afterwards does not bring the material back.
--   * `crm.expense_account_map.erp_ledger_account_code` CHANGING on a mapping that already
--     exists. One administrator re-points where a tenant's field spend lands in the ERP's
--     general ledger, and every claim posted afterwards goes to the account they named.
--     Pointing it back does not move the postings.
--
-- Both are irreversible in effect while being perfectly reversible on paper, which is the
-- combination a log cannot help with: the record says who did it, and the stock is still
-- gone.
--
-- WHY NOT FOUR EYES ON EVERYTHING, which is the question 0059 answered and this migration
-- must not reopen. Its header:
--
--     NO FOUR EYES, and the reason is operational rather than principled. […] requiring a
--     second compliance officer to approve every change would mean a tenant with one
--     compliance officer cannot set its own grace period at all — with the only workaround
--     being the psql prompt this whole lineage exists to get away from. […] if a deployment
--     wants four eyes it is a rule to add here, over a log that already exists.
--
-- Still true, so the rule is PER COLUMN AND DIRECTIONAL rather than per table. The grace
-- period keeps one signature. Deactivating a mapping keeps one signature, because it
-- fails SAFE — nothing posts wrongly, every claim in that category simply stops being
-- postable, which is loud, recoverable and already recorded. Changing the cost-centre code
-- keeps one signature: it misattributes a dimension on a posting that still lands in the
-- right account. Creating a mapping keeps one signature, because a category that posts
-- nowhere cannot post wrongly, and requiring two people to bootstrap would mean a tenant
-- cannot start claiming at all.
--
-- The asymmetry is the content of the rule, not an exception to it: four eyes to ARM the
-- unattended job and one signature to disarm it; four eyes to MOVE the money and one
-- signature to stop it moving.
--
-- THE RULE IS DATA, NOT BRANCHES. `crm.four_eyes_rule` is a table, so "which changes need
-- two people" is a query rather than a reading of two triggers. That is 0049's reason for
-- publishing the frozen-column list as a function, one step further: a list inside a
-- plpgsql body cannot be queried, and a rule nobody can enumerate is a rule that drifts
-- from whatever a route believes it is. It also means a deployment that wants four eyes on
-- the grace period adds a row rather than a migration.
--
-- A PROPOSAL IS A RECORD, like everything else in this lineage. `crm.config_proposal` holds
-- what was asked for, by whom and why; then a decision by somebody else, with their own
-- reason. The four-eyes CHECK is this schema's existing one, written the same way it is
-- written on `crm.tenant_tombstone` (0052), `crm.expense_claim` (0006) and `crm.call_plan`
-- (0015): `decided_by <> proposed_by`.
--
-- APPROVING IS WHAT APPLIES IT. The alternative was for approval to mark the row and leave
-- the proposer to re-issue the write, and it is worse in a way worth naming: it opens a
-- window in which an approved proposal exists and the setting has not changed, so the
-- tenant's configuration and its approved intent disagree and nothing says which is
-- current. Here the decision IS the act — one transaction, approve and apply — and
-- `applied_at` is stamped by the same trigger that lets the write through, so the two
-- cannot come apart.
--
-- A PROPOSAL IS SINGLE USE, which is what `applied_at` is for beyond bookkeeping. An
-- approved proposal that could be replayed would let one person re-arm the write-off switch
-- every time somebody else turned it off, using an approval given once, months ago, for a
-- different occasion.
--
-- THE AUTHOR OF RECORD IS THE APPROVER, and the proposal carries the proposer. Every other
-- `*_by` column in this schema names the principal whose action changed the state, and here
-- that is whoever approved: before they acted, nothing had changed. So `changed_by` on the
-- resulting log row is the approver and `proposal_id` points at the row holding the other
-- half — both names, both reasons, both timestamps, and no column that has to mean two
-- things.
--
-- THE DATABASE CHECKS THE ROLES, not just the route. `crm.four_eyes_rule.role` names the
-- grant both actors must hold, and it is verified at proposal, at decision AND at apply,
-- through `crm.rep_has_role` (0023). The last of those is the one that matters: a proposal
-- approved by somebody who has since lost the role is not a proposal two qualified people
-- agreed on, and it must not apply merely because the approval was valid when it was given.
--
-- A TENANT WITH ONE OFFICER CANNOT ARM THE JOB, and that is the correct answer rather than
-- a limitation — it is the entire point of the rule for that switch. But it must not be a
-- silent one: the proposal is accepted and waits, the read says how many people could
-- approve it, and when the answer is zero the screen says so. A refusal at proposal time
-- would be worse, because the second officer may be appointed tomorrow and a pending
-- request is exactly the right thing to find waiting.
--
-- WHOEVER CAN APPROVE IS TOLD. A proposal nobody is notified about is a proposal that waits
-- for somebody to go looking, which is how an approval queue becomes a reason to go back to
-- the psql prompt. `config_change_awaiting_approval` joins the kind vocabulary and goes to
-- every OTHER holder of the governing role — the same shape as `call_plan_submitted`, whose
-- own comment reads "a rep submitted a call plan; whoever can approve it is told".

-- ---------------------------------------------------------------------------
-- 1. Which changes need two people.
-- ---------------------------------------------------------------------------
/**
 * The directions a rule can be written in.
 *
 * `to_true` and `to_false` are for a boolean switch whose two directions are not equally
 * dangerous — the case `auto_writeoff_promo` is. `any_change` is for a value whose every
 * movement is the hazard, which is what re-pointing a ledger account is.
 *
 * THERE IS NO `on_create`, and the reason is not that the case cannot be expressed — it is
 * that a rule here is about a CHANGE, and a creation changes nothing. `crm.require_four_eyes`
 * is told which it is and exempts a creation before it reads this table at all.
 *
 * An earlier version of this comment claimed the vocabulary had no way to express creation
 * "on purpose", and the first live run refused the INSERT that maps a tenant's first expense
 * category — the exact bootstrap the header says stays single-signature. `any_change` matched
 * the INSERT because an INSERT does set the column. The missing distinction was not a
 * direction; it was the question of whether anything had a previous value.
 */
CREATE OR REPLACE FUNCTION crm.four_eyes_directions()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['any_change', 'to_true', 'to_false'];
$$;

CREATE TABLE crm.four_eyes_rule (
  -- The bare table name within `crm`, as `crm.data_disposition` and `crm.config_change`
  -- both spell it, so the three registers read side by side.
  table_name  text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{2,62}$'),
  column_name text NOT NULL CHECK (column_name ~ '^[a-z][a-z0-9_]{2,62}$'),
  direction   text NOT NULL CHECK (direction = ANY (crm.four_eyes_directions())),

  -- The grant BOTH actors must hold. Named here rather than left to the route, because a
  -- rule the database cannot check is a rule one forgotten `requireRole` walks around.
  role        text NOT NULL CHECK (role IN ('administrator', 'compliance')),

  -- Why this change and not its neighbours. Required, and long enough to be a sentence:
  -- the next person to add a row here needs to see what standard the existing rows met,
  -- and "because it is dangerous" is how a selective rule becomes a blanket one.
  note        text NOT NULL CHECK (length(note) BETWEEN 20 AND 1000),

  -- PLATFORM-WIDE, not per tenant, and therefore no RLS — the same reading
  -- `crm.data_disposition` carries. Which changes need two people is a property of what
  -- the CRM does with them, not of who is using it, and a tenant that could edit its own
  -- four-eyes rules would be a tenant with no four-eyes rules.
  PRIMARY KEY (table_name, column_name, direction)
);

INSERT INTO crm.four_eyes_rule (table_name, column_name, direction, role, note) VALUES
  ('disposal_policy', 'auto_writeoff_promo', 'to_true', 'compliance',
   'Arming the nightly job to write off promotional material with no person involved. 0020 argues at length that material leaves a balance only when somebody records it; this switch is the one exception, and one officer should not be able to turn it on alone. Turning it OFF needs one signature: it only ever means a person must record each write-off.'),
  ('expense_account_map', 'erp_ledger_account_code', 'any_change', 'administrator',
   'Re-pointing which ERP ledger account a category of field spend posts to. Every claim posted afterwards lands in the new account and pointing it back does not move them. Creating a mapping needs one signature — a category that posts nowhere cannot post wrongly — and deactivating one needs one signature, because it fails safe.');

COMMENT ON TABLE crm.four_eyes_rule IS
  'Which configuration changes require two different people. Read by crm.four_eyes_required() and enforced by crm.require_four_eyes(); platform-wide, so a tenant cannot relax its own.';

-- ---------------------------------------------------------------------------
-- 2. The proposal.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.config_proposal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,

  table_name      text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{2,62}$'),
  -- The row this is about, as its PRIMARY KEY columns — the same shape
  -- `crm.config_change.row_key` carries, and derived the same way, from the catalog.
  row_key         jsonb NOT NULL,
  -- Column name to proposed value. The value, not a description of it: the apply-time check
  -- compares this against what is actually being written, so a proposal to set 6200 cannot
  -- be spent on 9999.
  changes         jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb),
  -- Which of those columns are the reason this needs two people, stamped at proposal time
  -- from `crm.four_eyes_rule`. Kept rather than recomputed so the record says what the rule
  -- WAS when two people agreed, which is what an inspector is asking about.
  four_eyes_columns text[] NOT NULL CHECK (cardinality(four_eyes_columns) > 0),
  role            text NOT NULL CHECK (role IN ('administrator', 'compliance')),

  proposed_by     uuid NOT NULL,
  -- `clock_timestamp()` for 0059's reason: `now()` is the transaction clock, so two rows
  -- written in one transaction tie and "newest first" picks between them arbitrarily.
  proposed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  proposed_reason text NOT NULL CHECK (length(proposed_reason) BETWEEN 10 AND 1000),

  -- The decision. All four together or none of them.
  decision        text CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  decided_by      uuid,
  decided_at      timestamptz,
  decided_reason  text CHECK (decided_reason IS NULL OR length(decided_reason) BETWEEN 10 AND 1000),

  -- Stamped by `crm.require_four_eyes` as the write it authorises goes through, so an
  -- approval and the change it let through cannot come apart.
  applied_at      timestamptz,

  CONSTRAINT config_proposal_decision_paired CHECK (
    (decision IS NULL) = (decided_by IS NULL)
    AND (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL) = (decided_reason IS NULL)
  ),

  -- FOUR EYES. The rule, written the way this schema has written it since 0015.
  CONSTRAINT config_proposal_four_eyes CHECK (
    decision IS DISTINCT FROM 'approved' OR decided_by <> proposed_by
  ),
  -- A rejection is somebody ELSE saying no; a proposer who changes their mind WITHDRAWS.
  -- The distinction is not pedantry: without it "rejected" would cover both, and a reader
  -- counting refused proposals could not tell a disagreement from a second thought.
  CONSTRAINT config_proposal_rejected_by_another CHECK (
    decision IS DISTINCT FROM 'rejected' OR decided_by <> proposed_by
  ),
  CONSTRAINT config_proposal_withdrawn_by_proposer CHECK (
    decision IS DISTINCT FROM 'withdrawn' OR decided_by = proposed_by
  ),
  -- Only an approval can have been applied.
  CONSTRAINT config_proposal_applied_was_approved CHECK (
    applied_at IS NULL OR decision = 'approved'
  ),

  -- Composite, like every reference inside `crm` since 0035: a referential check runs with
  -- row security disabled, so a single-column key would let one tenant's proposal name a
  -- rep in another. RESTRICT because this row is the authority a change rests on.
  CONSTRAINT config_proposal_proposed_by_fkey
    FOREIGN KEY (tenant_id, proposed_by) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT config_proposal_decided_by_fkey
    FOREIGN KEY (tenant_id, decided_by) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE RESTRICT
);

-- The three reads this serves: what is waiting, one tenant's history, and one row's.
CREATE INDEX idx_config_proposal_pending
  ON crm.config_proposal (tenant_id, proposed_at DESC) WHERE decision IS NULL;
CREATE INDEX idx_config_proposal_recent
  ON crm.config_proposal (tenant_id, proposed_at DESC);
CREATE INDEX idx_config_proposal_row
  ON crm.config_proposal (tenant_id, table_name, proposed_at DESC);

SELECT crm.apply_tenant_isolation('crm.config_proposal');

-- Referenceable, which is all this is: 0035's note applies word for word — "Postgres will
-- only let a foreign key reference columns covered by a unique index, so a referenceable
-- target has to be created before it can be referenced", and `(tenant_id, id)` on a table
-- whose `id` is already the primary key is not a uniqueness claim at all. The two logs below
-- reference it compositely because every reference inside `crm` does.
ALTER TABLE crm.config_proposal
  ADD CONSTRAINT config_proposal_tenant_id_id_key UNIQUE (tenant_id, id);

/**
 * A proposal is decided once, and never edited.
 *
 * Not plain append-only, because the decision IS an update — the same shape as a role grant
 * (0023), whose revocation columns are filled by `crm.revoke_rep_role` and which refuses
 * every other UPDATE. What a reader needs is that the asked-for change cannot be rewritten
 * after somebody agreed to it, and that an agreement cannot be re-given.
 *
 * DELETE is allowed at trigger depth 1, for 0059's and 0061's reason: this table's
 * disposition is decided below, `executeTenantErasure` removes a tenant's rows with plain
 * statements, and a guard that refused would break an erasure — far worse than what it would
 * prevent.
 */
CREATE OR REPLACE FUNCTION crm.config_proposal_decided_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.tenant_id, OLD.table_name, OLD.row_key, OLD.changes, OLD.four_eyes_columns,
      OLD.role, OLD.proposed_by, OLD.proposed_at, OLD.proposed_reason)
     IS DISTINCT FROM
     (NEW.tenant_id, NEW.table_name, NEW.row_key, NEW.changes, NEW.four_eyes_columns,
      NEW.role, NEW.proposed_by, NEW.proposed_at, NEW.proposed_reason) THEN
    RAISE EXCEPTION
      'config-proposal-frozen: what proposal % asked for cannot be changed after it was made. Withdraw it and propose the new change.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decision IS NOT NULL
     AND (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.decided_reason)
         IS DISTINCT FROM (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.decided_reason) THEN
    RAISE EXCEPTION
      'config-proposal-decided: proposal % was already % by somebody; a decision cannot be retaken.',
      OLD.id, OLD.decision
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION
      'config-proposal-spent: proposal % has already been applied, and an approval is good for one change.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER config_proposal_decided_once
  BEFORE UPDATE ON crm.config_proposal
  FOR EACH ROW EXECUTE FUNCTION crm.config_proposal_decided_once();

-- ---------------------------------------------------------------------------
-- 3. Asking the rule.
-- ---------------------------------------------------------------------------
/**
 * Which of a proposed set of column values need a second person.
 *
 * Takes the columns and the values being WRITTEN, because the rule is directional: setting
 * `auto_writeoff_promo` to false is not the change the rule is about. A `to_true` rule
 * matches only a jsonb `true`, a `to_false` rule only a jsonb `false`, and `any_change`
 * matches whatever the column is being set to — including null, which for a nullable
 * dimension is as much a decision as a value.
 *
 * STABLE and reads only the rule table, so a route can ask it before deciding whether to
 * write or to propose. The route's answer is not the authority — `crm.require_four_eyes`
 * below is, and it asks the same question again as the write lands — but the two agreeing
 * is what makes the route able to say "this needs two people" instead of attempting the
 * write and translating a refusal.
 */
CREATE OR REPLACE FUNCTION crm.four_eyes_required(p_table text, p_changes jsonb)
RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT r.column_name ORDER BY r.column_name), ARRAY[]::text[])
    FROM crm.four_eyes_rule r
   WHERE r.table_name = p_table
     AND p_changes ? r.column_name
     AND CASE r.direction
           WHEN 'any_change' THEN true
           WHEN 'to_true'    THEN (p_changes -> r.column_name) = 'true'::jsonb
           WHEN 'to_false'   THEN (p_changes -> r.column_name) = 'false'::jsonb
         END;
$$;

/**
 * The role a table's four-eyes rules name, or null if it has none.
 *
 * One role per table today and the schema does not forbid two, so this takes the role of
 * the rules that actually matched rather than the table's rules in general — a table whose
 * columns answered to different grants would otherwise silently get whichever row sorted
 * first.
 */
CREATE OR REPLACE FUNCTION crm.four_eyes_role(p_table text, p_columns text[])
RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  roles text[];
BEGIN
  SELECT array_agg(DISTINCT r.role) INTO roles
    FROM crm.four_eyes_rule r
   WHERE r.table_name = p_table AND r.column_name = ANY (p_columns);
  IF roles IS NULL THEN RETURN NULL; END IF;
  IF cardinality(roles) > 1 THEN
    RAISE EXCEPTION
      'crm.four_eyes_rule names % different roles for % columns % — a change needing two people must say which grant they hold',
      cardinality(roles), p_table, p_columns
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN roles[1];
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Enforcing it.
-- ---------------------------------------------------------------------------
/**
 * Lets a four-eyed change through, or refuses it — and spends the proposal that authorised it.
 *
 * Called from the point where each table's write actually lands: 0061's
 * `crm.record_config_change` for the observed tables, and 0059's
 * `crm.disposal_policy_change_apply` for the projected one. Two call sites rather than one
 * trigger, because those two tables are written by two different arrangements and the
 * honest place for the check is where the change becomes true.
 *
 * `p_changes` is what is being written, as jsonb, keyed by column. The proposal must agree
 * on EVERY four-eyes column — same column, same value — and may say nothing about the rest:
 * a request that also moved the grace period is still authorised for the switch, because the
 * grace period needs no authorisation. What is refused is a four-eyed column landing at a
 * value nobody approved.
 *
 * The proposal id travels in `app.change_proposal`, the same transaction-local mechanism
 * 0061 uses for the author and 0003 for the tenant. Nothing else could carry it: the write
 * happens inside a store function that has no argument for it and should not grow one.
 *
 * `p_is_creation` EXEMPTS A ROW THAT DID NOT EXIST, and it is not a convenience. A rule here
 * governs a change, and nothing about a row being created is a change: an expense category
 * that has never been mapped posts nowhere, so it cannot post wrongly, and requiring two
 * people to write the first mapping would mean a tenant cannot start claiming at all. The
 * first live run of this migration refused exactly that INSERT, which is how the argument
 * came to exist.
 *
 * It is not a way around the rule either, because the only path that could use it is one
 * that does not exist. `upsertAccountMapping`'s `ON CONFLICT DO UPDATE` fires the UPDATE
 * trigger (measured in 0059's lineage), so reactivating a deactivated mapping at a different
 * account is an amendment and needs two people; there is no DELETE route for a mapping — the
 * route deactivates — so there is no delete-and-recreate to launder a change through. What
 * remains is somebody at a psql prompt with the application password deleting the row by
 * hand, which is the thing this whole lineage records rather than prevents.
 */
CREATE OR REPLACE FUNCTION crm.require_four_eyes(
  p_table       text,
  p_row_key     jsonb,
  p_changes     jsonb,
  p_is_creation boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  needed       text[];
  proposal_txt text   := NULLIF(current_setting('app.change_proposal', true), '');
  prop         record;
  col          text;
BEGIN
  IF p_is_creation THEN
    RETURN NULL;
  END IF;
  needed := crm.four_eyes_required(p_table, p_changes);
  IF cardinality(needed) = 0 THEN
    RETURN NULL;
  END IF;

  IF proposal_txt IS NULL THEN
    RAISE EXCEPTION
      'four-eyes-required: changing % of crm.% takes two different people. Propose the change, and somebody else with the % grant approves it.',
      array_to_string(needed, ', '), p_table, crm.four_eyes_role(p_table, needed)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO prop FROM crm.config_proposal
   WHERE id = proposal_txt::uuid FOR UPDATE;
  -- `NOT FOUND` rather than `prop IS NULL`: a record whose SELECT matched nothing has
  -- all-null fields, so the second test happens to work and is answering a different
  -- question — one a real row could also answer yes to.
  IF NOT FOUND THEN
    -- Row-level security confines the lookup to the caller's tenant, so "not found" and
    -- "another tenant's" are the same answer here, deliberately: a proposal id is not a
    -- capability and probing one must not tell its holder whether it exists.
    RAISE EXCEPTION 'four-eyes-unknown-proposal: no proposal % in this tenant', proposal_txt
      USING ERRCODE = 'check_violation';
  END IF;

  IF prop.decision IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'four-eyes-not-approved: proposal % is %', prop.id,
      COALESCE(prop.decision, 'still waiting for somebody to approve it')
      USING ERRCODE = 'check_violation';
  END IF;
  IF prop.applied_at IS NOT NULL THEN
    RAISE EXCEPTION
      'four-eyes-spent: proposal % was applied at % — an approval authorises one change.',
      prop.id, prop.applied_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF prop.table_name <> p_table OR prop.row_key <> p_row_key THEN
    RAISE EXCEPTION
      'four-eyes-wrong-row: proposal % is about crm.% %, not crm.% %',
      prop.id, prop.table_name, prop.row_key, p_table, p_row_key
      USING ERRCODE = 'check_violation';
  END IF;

  -- The value check, which is the one that makes an approval mean something. Without it an
  -- approval to point a category at 6200 would authorise pointing it at any account at all.
  FOREACH col IN ARRAY needed LOOP
    IF NOT (prop.changes ? col) OR (prop.changes -> col) IS DISTINCT FROM (p_changes -> col) THEN
      RAISE EXCEPTION
        'four-eyes-not-what-was-approved: proposal % approved %=%, and this write sets it to %',
        prop.id, col, COALESCE((prop.changes -> col)::text, 'nothing'), COALESCE((p_changes -> col)::text, 'null')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- RE-CHECKED NOW, not only when the approval was given. A proposal two people agreed on
  -- while both held the grant is not an agreement between two qualified people if one of
  -- them has since lost it — and the gap between an approval and the write it authorises is
  -- exactly where a revocation lands.
  IF NOT crm.rep_has_role(prop.proposed_by, prop.role) THEN
    RAISE EXCEPTION
      'four-eyes-proposer-unqualified: the rep who proposed % no longer holds the % grant',
      prop.id, prop.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT crm.rep_has_role(prop.decided_by, prop.role) THEN
    RAISE EXCEPTION
      'four-eyes-approver-unqualified: the rep who approved % no longer holds the % grant',
      prop.id, prop.role
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE crm.config_proposal SET applied_at = clock_timestamp() WHERE id = prop.id;
  RETURN prop.id;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Deciding one.
-- ---------------------------------------------------------------------------
/**
 * Records a decision on a pending proposal, and says nothing about applying it.
 *
 * A FUNCTION rather than an UPDATE from the application, for `crm.revoke_rep_role`'s reason
 * (0023): the rules that make a decision valid — it is still pending, the decider is not the
 * proposer, the decider holds the grant — are the kind that must not be restatable by a
 * second caller. The trigger above refuses a retaken decision; this is what refuses an
 * invalid first one, with a sentence naming which rule.
 *
 * It does NOT apply the change. The caller approves and then performs the write with
 * `app.change_proposal` set, so the apply goes through the same `crm.require_four_eyes` as
 * any other path and `applied_at` is stamped by the write rather than by a promise to make
 * one. A function that did both would be the only place in this schema where a configuration
 * change happens somewhere other than the table it changes.
 */
CREATE OR REPLACE FUNCTION crm.decide_config_proposal(
  p_proposal_id uuid,
  p_decision    text,
  p_decided_by  uuid,
  p_reason      text
)
RETURNS crm.config_proposal
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  prop crm.config_proposal;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'unknown proposal decision %', p_decision USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO prop FROM crm.config_proposal WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'four-eyes-unknown-proposal: no proposal % in this tenant', p_proposal_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF prop.decision IS NOT NULL THEN
    RAISE EXCEPTION 'four-eyes-decided: proposal % was already % ', prop.id, prop.decision
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_decision = 'withdrawn' THEN
    IF p_decided_by <> prop.proposed_by THEN
      RAISE EXCEPTION
        'four-eyes-not-yours: only the rep who proposed % may withdraw it; somebody else rejects it instead',
        prop.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_decided_by = prop.proposed_by THEN
      RAISE EXCEPTION
        'four-eyes-same-person: proposal % was made by this rep, so they cannot % it. That is what two people means.',
        prop.id, p_decision
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT crm.rep_has_role(p_decided_by, prop.role) THEN
      RAISE EXCEPTION
        'four-eyes-unqualified: deciding proposal % needs the % grant',
        prop.id, prop.role
        USING ERRCODE = 'check_violation';
    END IF;
    -- AN APPROVAL THAT COULD ONLY FAIL IS REFUSED HERE INSTEAD. `crm.require_four_eyes`
    -- re-checks both actors as the write lands, so approving a proposal whose author has
    -- since lost the grant would succeed and then be refused one statement later — which
    -- reads as a bug in the approval rather than as what it is. Refused only for an
    -- APPROVAL: rejecting a departed officer's proposal is exactly the right outcome and
    -- has to stay possible, which it would not if this guard covered every decision.
    IF p_decision = 'approved' AND NOT crm.rep_has_role(prop.proposed_by, prop.role) THEN
      RAISE EXCEPTION
        'four-eyes-proposer-unqualified: the rep who proposed % no longer holds the % grant, so approving it would be agreeing with nobody. Reject it, and propose the change again if it is still wanted.',
        prop.id, prop.role
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE crm.config_proposal
     SET decision = p_decision, decided_by = p_decided_by,
         decided_at = clock_timestamp(), decided_reason = p_reason
   WHERE id = prop.id
   RETURNING * INTO prop;
  RETURN prop;
END
$$;

/**
 * How many OTHER reps could decide this proposal — zero being a real and reportable answer.
 *
 * The number a tenant with one compliance officer needs to see: the proposal is accepted and
 * waiting, and nobody can approve it until a second officer is appointed. Reported rather
 * than refused, because the second officer may be appointed tomorrow and a pending request
 * is the right thing for them to find.
 */
CREATE OR REPLACE FUNCTION crm.config_proposal_eligible_deciders(p_proposal_id uuid)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer
    FROM crm.config_proposal p
    JOIN crm.rep_role r ON r.tenant_id = p.tenant_id AND r.role = p.role
    JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
   WHERE p.id = p_proposal_id
     AND r.rep_profile_id <> p.proposed_by
     AND rp.status = 'active'
     AND r.valid_from <= CURRENT_DATE
     AND (r.valid_to IS NULL OR r.valid_to > CURRENT_DATE);
$$;

-- ---------------------------------------------------------------------------
-- 6. Wiring it into the two logs.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.config_change
  ADD COLUMN proposal_id uuid,
  ADD CONSTRAINT config_change_proposal_fkey
    FOREIGN KEY (tenant_id, proposal_id) REFERENCES crm.config_proposal (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE crm.disposal_policy_change
  ADD COLUMN proposal_id uuid,
  ADD CONSTRAINT disposal_policy_change_proposal_fkey
    FOREIGN KEY (tenant_id, proposal_id) REFERENCES crm.config_proposal (tenant_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN crm.config_change.proposal_id IS
  'The proposal that authorised this change, where the change needed two people (0062). Null for the single-signature majority. changed_by is the APPROVER; the proposal names who asked.';
COMMENT ON COLUMN crm.disposal_policy_change.proposal_id IS
  'The proposal that authorised this change, where the change needed two people (0062). Null for the single-signature majority.';

/**
 * 0061's recorder, now asking the four-eyes rule as well.
 *
 * Replaced whole rather than patched, because `CREATE OR REPLACE FUNCTION` is how this
 * schema changes a trigger body and a reader needs the version the database is running to
 * be the version they can read. Everything down to the `moved` computation is 0061's and
 * unchanged; the new part is one call and one column.
 *
 * The check happens AFTER `moved` is known and BEFORE the attribution check, which is the
 * only order that reads correctly: a write that moves nothing needs no authority, and a
 * write that needs two people should be told so rather than first being told it is
 * unattributed when it is both.
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
  row_key     jsonb;
  proposal    uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
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
    IF moved IS NULL OR cardinality(moved) = 0 THEN
      RETURN NULL;
    END IF;
  END IF;

  row_key := (SELECT jsonb_object_agg(k, after_row -> k) FROM unnest(key_cols) AS k);

  -- 0062. Only the columns that MOVED are offered to the rule: a row whose account code is
  -- already 6200 and whose cost centre changed is not a re-pointing, and asking about the
  -- whole after-image would make it look like one.
  proposal := crm.require_four_eyes(
    TG_TABLE_NAME, row_key,
    (SELECT jsonb_object_agg(k, after_row -> k) FROM unnest(moved) AS k),
    TG_OP = 'INSERT');

  IF actor_text IS NULL OR reason_text IS NULL THEN
    RAISE EXCEPTION
      'config-change-unattributed: a change to crm.% must name who is making it and why — open an attribution block (withAttribution) before writing a tenant''s configuration',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO crm.config_change
    (tenant_id, table_name, row_key, action, changed_by, reason, changed_columns, before, after, proposal_id)
  VALUES
    (NEW.tenant_id, TG_TABLE_NAME, row_key,
     CASE TG_OP WHEN 'INSERT' THEN 'created' ELSE 'amended' END,
     actor_text::uuid, reason_text, moved, prior_row, after_row, proposal);

  RETURN NULL;
END
$$;

/**
 * 0059's applier, now asking the four-eyes rule as well.
 *
 * Same treatment and the same ordering argument: the check goes after the no-op refusal,
 * because a change that changes nothing needs no second person, and before the UPDATE, so a
 * refusal leaves the policy alone.
 *
 * Only the knobs that actually MOVED are offered to the rule, which is what makes the
 * directional rule work here: a change that leaves `auto_writeoff_promo` true while
 * shortening the grace period is not an arming, and passing the whole after-state would make
 * every subsequent grace-period change need two people.
 */
CREATE OR REPLACE FUNCTION crm.disposal_policy_change_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur    record;
  moved  jsonb := '{}'::jsonb;
BEGIN
  INSERT INTO crm.disposal_policy (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT grace_days, auto_writeoff_promo INTO cur
    FROM crm.disposal_policy WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  NEW.grace_days_from := cur.grace_days;
  NEW.auto_writeoff_promo_from := cur.auto_writeoff_promo;

  NEW.grace_days_to := COALESCE(NEW.grace_days_to, cur.grace_days);
  NEW.auto_writeoff_promo_to := COALESCE(NEW.auto_writeoff_promo_to, cur.auto_writeoff_promo);

  IF NEW.grace_days_to = NEW.grace_days_from
     AND NEW.auto_writeoff_promo_to IS NOT DISTINCT FROM NEW.auto_writeoff_promo_from THEN
    RAISE EXCEPTION
      'that disposal policy change changes nothing (grace_days % and auto_writeoff_promo % are already in force)',
      cur.grace_days, cur.auto_writeoff_promo
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.grace_days_to <> NEW.grace_days_from THEN
    moved := moved || jsonb_build_object('grace_days', NEW.grace_days_to);
  END IF;
  IF NEW.auto_writeoff_promo_to IS DISTINCT FROM NEW.auto_writeoff_promo_from THEN
    moved := moved || jsonb_build_object('auto_writeoff_promo', NEW.auto_writeoff_promo_to);
  END IF;

  -- The policy keys on the tenant alone, which is the whole of its primary key and so the
  -- whole of its row_key — the same shape `crm.config_change` records for it.
  --
  -- Never a creation, and that is a property of the table rather than a simplification: the
  -- policy row is provisioned at its declared defaults above, so a change row always
  -- describes a transition from a value that was already in force. Turning the switch on for
  -- the first time is a change FROM false, not a creation.
  NEW.proposal_id := crm.require_four_eyes(
    'disposal_policy', jsonb_build_object('tenant_id', NEW.tenant_id), moved, false);

  UPDATE crm.disposal_policy
     SET grace_days = NEW.grace_days_to,
         auto_writeoff_promo = NEW.auto_writeoff_promo_to,
         updated_at = now()
   WHERE tenant_id = NEW.tenant_id;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Telling whoever can approve.
-- ---------------------------------------------------------------------------
-- 0049's closed list, extended. Replaced rather than added to, because the whole point of
-- the function is that the vocabulary is stated once; a test asserts the nine existing
-- members survive, since a rewrite of a list is the one place a member quietly disappears.
CREATE OR REPLACE FUNCTION crm.notification_kinds()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['disposal_obligation_raised',
               'disposal_obligation_overdue',
               'call_plan_submitted',
               'call_plan_approved',
               'call_plan_returned',
               'sample_transfer_awaiting_acceptance',
               'sample_transfer_recalled',
               'erp_write_failed',
               'expense_post_blocked',
               'config_change_awaiting_approval'];
$$;

-- 0024's retention exemption, extended: a notification about a proposal nobody has decided
-- must outlive its horizon, for the reason every other branch here exists — the signal is
-- how the only people who can act on it know there is something to act on.
--
-- REPLACED FROM THE VERSION THE DATABASE IS RUNNING, which is 0031's and not 0024's. The
-- first draft of this migration copied 0024's text, which has four branches, and silently
-- dropped the `crm.expense_claim` branch 0031 added — so every notification about a claim
-- the sweeper could not hand over would have pruned at the normal horizon while a rep was
-- still owed money. `subject-coverage.contract.test.ts` caught it on the first run, which is
-- exactly what it exists for: it reads the branches out of `pg_proc` rather than out of a
-- file, and compares them against every `subjectTable:` in the repository.
--
-- The lesson is about `CREATE OR REPLACE` on a function several migrations have touched: the
-- newest definition is not in the file that created it, and there is no way to extend one
-- except to write it whole. So the whole of it is here, with its comments, taken from the
-- catalog.
CREATE OR REPLACE FUNCTION crm.notification_subject_open(
  p_subject_table text,
  p_subject_id    uuid
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE p_subject_table
    -- A regulated disposal nobody has completed. The notification is how the rep knows.
    WHEN 'crm.disposal_obligation' THEN EXISTS (
      SELECT 1 FROM crm.disposal_obligation o
       WHERE o.id = p_subject_id AND o.status IN ('open', 'overdue'))
    -- A write the rep believes landed and never did. 0022 raises this; until the row is
    -- revived or abandoned, it is the only thing saying so.
    WHEN 'crm.outbox' THEN EXISTS (
      SELECT 1 FROM crm.outbox b
       WHERE b.id = p_subject_id AND b.state = 'dead')
    -- Material in transit: a transfer_out with no acceptance recorded against it. The
    -- same predicate `outstandingTransfers` uses, so the two cannot disagree.
    WHEN 'crm.sample_transaction' THEN EXISTS (
      SELECT 1 FROM crm.sample_transaction t
       WHERE t.id = p_subject_id AND t.kind = 'transfer_out'
         AND NOT EXISTS (SELECT 1 FROM crm.sample_transaction a WHERE a.transfer_of = t.id))
    -- A plan still waiting on an approver. `draft` is not open in this sense: nobody is
    -- waiting on a draft, and its author can see it in their own list.
    WHEN 'crm.call_plan' THEN EXISTS (
      SELECT 1 FROM crm.call_plan p
       WHERE p.id = p_subject_id AND p.status = 'submitted')
    -- A claim the sweeper could not hand over (0031). `approved` is the one open state: a
    -- rep is owed money and the ERP has not been told. Every other state is settled —
    -- `posted` and `reimbursed` succeeded, `rejected` and `draft` are not owed.
    WHEN 'crm.expense_claim' THEN EXISTS (
      SELECT 1 FROM crm.expense_claim c
       WHERE c.id = p_subject_id AND c.state = 'approved')
    -- 0062. Undecided means somebody still has to look at it. A withdrawn or rejected
    -- proposal is finished, and an APPROVED one is finished too — the change it authorised
    -- either landed in the same transaction or was refused by the write.
    WHEN 'crm.config_proposal' THEN EXISTS (
      SELECT 1 FROM crm.config_proposal cp
       WHERE cp.id = p_subject_id AND cp.decision IS NULL)
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION crm.notification_subject_unknown(p_subject_table text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject_table IS NOT NULL
     AND p_subject_table NOT IN ('crm.disposal_obligation', 'crm.outbox',
                                 'crm.sample_transaction', 'crm.call_plan',
                                 'crm.expense_claim', 'crm.config_proposal');
$$;

-- ---------------------------------------------------------------------------
-- 8. The retention decision, which arrives with the table (0051).
--
-- UNDECIDED, and the question follows `config_change`'s rather than repeating it. A proposal
-- is the authority a configuration change rests on, so whatever is decided for
-- `crm.config_change` governs this too — and the pair has to be decided together, because a
-- retained change whose proposal was erased names an approver nobody can find, and a
-- retained proposal whose change was erased is an agreement about nothing.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('config_proposal', 'undecided', NULL, NULL, NULL,
  'The record that two named employees agreed on a configuration change one of them could not make alone: arming the unattended write-off job, or re-pointing which ERP ledger account a category of field spend posts to. It is the authority the change in crm.config_change rests on, so it follows whatever is decided for that table — and must be decided WITH it, because a retained change whose proposal was erased names an approver nobody can find.',
  NULL, NULL)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE crm.config_proposal IS
  'A configuration change one person asked for and another agreed to. Created pending, decided by crm.decide_config_proposal(), and spent by crm.require_four_eyes() as the write it authorises goes through.';
COMMENT ON FUNCTION crm.require_four_eyes(text, jsonb, jsonb, boolean) IS
  'Refuses a change crm.four_eyes_rule says needs two people unless app.change_proposal names an approved, unapplied proposal for exactly that row and those values, both of whose actors still hold the governing grant. Returns the proposal id and marks it applied.';
