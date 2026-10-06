-- The two endpoint rules that only TypeScript was holding, moved to where they hold.
--
-- `packages/notify/src/endpoints.ts` states both of them in prose and enforces both in a
-- function a `psql` prompt walks straight past:
--
--   1. `updateEndpoint`: "`url` and `secret_env` are deliberately not updatable. Repointing
--      an endpoint in place would carry its delivery history onto a different destination,
--      so the honest record of 'these notifications went there' would start describing
--      somewhere else." The UPDATE simply omits the columns. Nothing refuses a different
--      UPDATE.
--   2. `normaliseKinds`: checks the allow-list against `NOTIFICATION_KINDS` and says why —
--      "an endpoint filtered to a kind that does not exist receives nothing" — and ends
--      with "this is the guard until the array has one of its own". This is that one.
--
-- Rule 1 is the sharper of the two, because its failure is silent and retroactive. 0048 was
-- written so that a delivery record survives the endpoint being deleted, carrying the
-- channel and url it was actually pushed to. An UPDATE that repoints the url defeats every
-- delivery written BEFORE 0048 (which read their destination through the foreign key) and
-- nothing at all after it — so the schema would contain two populations of delivery rows,
-- indistinguishable, one of which names the wrong host. Freezing the column is what makes
-- 0048's copy and the pre-0048 join agree for all time.
--
-- Rule 2's failure is loud for the admin and silent for the tenant: a webhook filtered to
-- `'call_plan_submited'` is accepted, matches nothing, and the operator believes they are
-- subscribed. It is exactly the `enabled`-but-dead endpoint that 0034's probe exists to
-- expose, with no probe failure to expose it — the probe would succeed, because the
-- transport is fine.

-- ---------------------------------------------------------------------------
-- The kind vocabulary, declared ONCE.
-- ---------------------------------------------------------------------------
-- 0046 refused to restate this list on `crm.notification_delivery` and gave the reason:
-- "the kind vocabulary has been widened three times already (0021 wrote six kinds; 0022,
-- 0029 and 0031 added more), and a second copy of that list on this table would have to be
-- widened in lockstep — a migration that forgot would not fail". It closed by saying the
-- vocabulary is "enforced once, where it is declared".
--
-- That was true of the delivery copy and is NOT true of `kinds`, and the difference is the
-- one 0046 itself drew: a delivery's `notification_kind` is overwritten by a trigger from a
-- row that has already satisfied the real CHECK, so it is not caller input and needs no
-- opinion of its own. `crm.notification_endpoint.kinds` IS caller input — it is typed by an
-- administrator, validated against nothing, and never compared to a notification until a
-- signal fires and silently fails to match. So it does need the check.
--
-- Which leaves 0046's objection standing: adding it as a literal list makes a FOURTH copy to
-- widen in lockstep, and a forgotten one would refuse an administrator the ability to
-- subscribe to a kind the system is already raising. So the list moves into a function and
-- both CHECKs call it. Widening a vocabulary becomes one `CREATE OR REPLACE FUNCTION` and
-- the lockstep problem stops existing, rather than being paid once more.
--
-- TWO THINGS THIS MAKES TRUE THAT ARE WORTH SAYING OUT LOUD.
--
--   * `CREATE OR REPLACE FUNCTION` does not revalidate the constraints that call it. For
--     WIDENING that is exactly right and is the whole point — every existing row already
--     satisfies a superset. For NARROWING it is unsound: rows holding the removed kind
--     survive, and the constraint reads as enforced while it never scanned. A kind is
--     therefore removed by `DROP CONSTRAINT` + `ADD CONSTRAINT` as 0022, 0029 and 0031 all
--     did, so the scan runs and names the rows. Nothing has ever narrowed it; this is the
--     instruction for the first time something does.
--   * `pg_dump` orders the function before the constraint, because `ADD CONSTRAINT` records
--     a dependency on every function its expression calls. The constraint is restored and
--     validated against a function that already exists.
--
-- The function is marked IMMUTABLE and is, within one definition of itself — it reads no
-- table, no setting and no clock. Replacing it is a schema change, not a value change, which
-- is the same contract `crm.expense_claim_frozen_columns()` (0047) is held to.
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
               'expense_post_blocked'];
$$;

-- The producing side, re-expressed against the single declaration. Same nine strings as
-- 0031 left behind — a test asserts the set is unchanged by this migration, because a
-- rewrite of a CHECK is the one place a vocabulary could quietly lose a member.
ALTER TABLE crm.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE crm.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind = ANY (crm.notification_kinds()));

-- And the consuming side, which has never had one.
--
-- `<@` is containment, so NULL (every kind) and the empty array both pass it; emptiness is
-- `notification_endpoint_kinds_not_empty`'s question and stays there. Two constraints, two
-- sentences, and `translateEndpointError` can tell the caller which rule they broke.
--
-- THIS ONE SCANS, unlike 0047's freeze, and the difference is the one 0040 drew: a freeze
-- governs an act, so no existing row can be wrong; this governs a resting state, so an
-- endpoint already carrying a typo'd kind is wrong right now and the ADD should refuse. A
-- CHECK's validation scan is sighted under FORCE row-level security (0039's asymmetry), so
-- it sees every tenant's rows and not an empty table — which is what makes the refusal
-- mean anything. If it fires on a real database the endpoint it names is one that has been
-- receiving nothing, and the repair is to fix the array or drop the endpoint.
ALTER TABLE crm.notification_endpoint
  ADD CONSTRAINT notification_endpoint_kinds_known
    CHECK (kinds IS NULL OR kinds <@ crm.notification_kinds());

-- ---------------------------------------------------------------------------
-- The destination is fixed for the life of the endpoint.
-- ---------------------------------------------------------------------------
/**
 * What an endpoint IS, as opposed to how it is tuned.
 *
 * Published as a function for 0047's reason: a list inside a plpgsql body cannot be
 * queried, so nothing but a comment could claim what is frozen and what is not.
 *
 * `channel` is in the list and the honest note is that it is nearly unreachable — the url
 * CHECK has been channel-dependent since 0029 (`https://` for a webhook, `mailto:` for
 * email), the two patterns are disjoint, and `url` is frozen beside it, so no surviving
 * `channel` change exists. It is named anyway because it is frozen for the SAME reason url
 * is, not as a consequence of url being frozen: a delivery record says which channel it
 * went out on, and a channel rewritten afterwards makes that record wrong. If the url rule
 * is ever relaxed per channel, this line is already correct instead of newly missing.
 *
 * NOT frozen, deliberately: `min_severity`, `kinds`, `enabled`, `description`,
 * `updated_at` — every one of them is a knob `updateEndpoint` exists to turn, and turning
 * them changes what WILL be sent, never what WAS. `tenant_id` and `id` are left out for
 * 0047's reason: the row-security policy's `WITH CHECK` refuses the first before this
 * trigger's opinion would matter, and the second is a primary key.
 */
CREATE OR REPLACE FUNCTION crm.notification_endpoint_frozen_columns()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['channel', 'url', 'secret_env'];
$$;

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

-- NO `OLD.state`-style exemption, and no write-once arm. Unlike 0047's claim there is no
-- draft here: an endpoint is live from the INSERT that creates it — `createEndpoint` returns
-- it enabled by default and the dispatcher's `due` CTE will pick it up on the next pass. So
-- the freeze starts immediately, and `createEndpoint` is unaffected because a BEFORE UPDATE
-- trigger has no opinion about an INSERT.
--
-- `CREATE OR REPLACE TRIGGER` rather than drop-then-create, for 0040's reason: the test
-- database is applied through psql without `-1`, so a drop that commits on its own leaves an
-- instant with no guard inside the file whose purpose is that there always is one.
CREATE OR REPLACE TRIGGER notification_endpoint_freeze_destination
  BEFORE UPDATE ON crm.notification_endpoint
  FOR EACH ROW EXECUTE FUNCTION crm.notification_endpoint_freeze_destination();
