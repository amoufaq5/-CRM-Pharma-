-- 0046_delivery_retention.sql
--
-- A DELIVERY RECORD COULD NOT OUTLIVE THE MESSAGE IT DESCRIBES.
--
-- WHAT WAS BROKEN. 0021 gave `crm.notification_delivery` an `ON DELETE CASCADE` from
-- `crm.notification`, which was coherent on the day it was written — a delivery was the
-- external half of an inbox entry, and nothing deleted an inbox entry at all. 0024 changed
-- that by adding horizons, and ADR-0001 has carried the consequence as an open item ever
-- since: the retention period for a notification became the retention period for the
-- record of where that signal was pushed. A tenant that keeps unread notifications for a
-- year therefore keeps the proof that it paged an on-call rotation for a year, and not one
-- day longer — although the two are evidence about completely different things. One is a
-- message to an employee; the other is a statement that this system transmitted a rep's
-- name, an account and sometimes a lot number to a third party's endpoint at a given
-- moment, and got a given answer back. The second is the kind of fact somebody asks about
-- eighteen months later, and the inbox horizon is not a judgement about it.
--
-- The ADR's own wording of the fix is that "the delivery rows [must] stop depending on the
-- notification row", and 0036 part 2 has already solved exactly this problem once, for
-- `crm.outbox_dead_letter`: no foreign key to the queue row, the legible facts COPIED
-- rather than joined, so a history row still says what failed after the row it describes
-- is gone. That file names `crm.notification_delivery`'s cascade as "the precedent not to
-- recreate". This migration follows 0036 and then pays the debt 0036 left open in its own
-- header — "nothing prunes this table, and no cascade will ... A horizon of its own is the
-- honest follow-up and is deliberately not invented here."
--
-- ===========================================================================
-- WHAT A DELIVERY ROW COPIES, AND WHY THAT SET AND NOT A LARGER ONE
-- ===========================================================================
--
-- The question a retained delivery row has to answer on its own is "where was this signal
-- pushed, and did it land". The second half it already answers: `state`, `attempts`,
-- `last_status`, `last_error` and `delivered_at` are its own columns and always were. The
-- first half it answered only by joining, so four facts are copied from the notification:
--
--   notification_kind        WHICH signal. Without it a retained row says a push happened
--                            and cannot say what for, which is not an answer.
--   notification_severity    WHY it was pushed at all. `notification_endpoint.min_severity`
--                            is the filter `raiseNotification` applies, so the severity is
--                            the whole justification for this row existing. An auditor
--                            asking "why did this reach PagerDuty" has no other source.
--   notification_created_at  WHEN the signal was raised, as distinct from when the push was
--                            enqueued (`created_at`) and when it was accepted
--                            (`delivered_at`). Lag between raise and delivery is the thing
--                            an endpoint owner disputes.
--   recipient_rep_profile_id WHOSE data left the tenant. A webhook body carries
--                            `recipient.displayName` (`claimDue` builds it), so a delivery
--                            IS a disclosure of a named employee to a third party, and
--                            `crm.notification` was the only place that recorded which
--                            employee. Stored as the id, resolved to a name by LEFT JOIN at
--                            read time — 0036's `revived_by_name` shape, which leaves a
--                            recorded uuid beside a null name rather than nothing.
--
-- WHAT IS DELIBERATELY NOT COPIED, because the exclusions are the design:
--
--   subject / body / payload — the MESSAGE. Copying them would make this table a second,
--     longer-retained copy of the inbox, so the delivery horizon below would silently
--     become the real retention period for notification prose and 0024's two horizons would
--     stop meaning anything. A delivery record is evidence about an endpoint, not an
--     archive of what was said.
--   subject_table / subject_id — the signal's referent. It is a deep link for a client, not
--     a property of the push, and the row it names may itself be gone (0021 made it
--     deliberately unreferenced). `notification_kind` already says what class of thing this
--     was about.
--   endpoint channel / url — because the endpoint is STILL JOINABLE. The question above is
--     "with no notification to join to", and `crm.notification_endpoint` is unaffected by
--     this migration: its reference stays, `updateEndpoint` already refuses to repoint a
--     url in place for precisely this reason, and copying a fact that can be read from a
--     live row is how two sources of one truth start to disagree. The endpoint leg has its
--     own identical cascade and that is recorded as an open item rather than fixed here;
--     the day it is addressed, `channel` and `url` join the set above, and the trigger below
--     is already the place that would copy them.
--
-- ===========================================================================
-- THE FOREIGN KEY GOES. IT DOES NOT BECOME `ON DELETE SET NULL`.
-- ===========================================================================
--
-- Both were available and they are different claims, so this is argued rather than assumed.
--
-- FIRST, SET NULL IS NOT EVEN WRITABLE IN THE OBVIOUS FORM. Every reference in this schema
-- is composite (0035, 0037), and a composite `ON DELETE SET NULL` nulls EVERY referencing
-- column — `tenant_id` included. Verified against this cluster before choosing:
--
--     CREATE TABLE probe.c (tenant_id uuid NOT NULL, pid uuid NOT NULL,
--       FOREIGN KEY (tenant_id, pid) REFERENCES probe.p (tenant_id, id) ON DELETE SET NULL);
--     DELETE FROM probe.p;
--     ERROR:  null value in column "tenant_id" of relation "c" violates not-null constraint
--     CONTEXT: SQL statement "UPDATE ONLY probe.c SET tenant_id = NULL, pid = NULL WHERE …"
--
-- So the naive form does not retain anything: it makes deleting a notification FAIL. The
-- writable form is Postgres 15's column list, `ON DELETE SET NULL (notification_id)`, which
-- does work here (this cluster and `deploy/docker-compose.yml` are both 16) and leaves
-- `tenant_id` intact — verified the same way.
--
-- SECOND, AND THE REAL REASON: THE ID IS ITSELF EVIDENCE. `notification_id` is not merely a
-- join key. It goes out on the wire — `claimDue` puts it in the webhook body as
-- `notificationId`, beside `deliveryId` — so it is the value a receiver quotes back when
-- they ask why they were paged, and the only thing that groups the several endpoints one
-- signal fanned out to. Nulling it destroys the correlation that the record exists to
-- provide, and destroys it at exactly the moment the record becomes the only survivor.
-- A nullable reference would keep the constraint and throw away the fact; keeping the uuid
-- unconstrained keeps the fact and throws away the constraint. For a history table the
-- second trade is the right one, and it is 0036's.
--
-- THIRD, A NULLED REFERENCE GUARDS NOTHING ANYWAY. `MATCH SIMPLE` means a composite key
-- with a NULL column is not checked at all, so the tenant guard a composite key exists to
-- provide (0035's whole argument) is gone from that row the instant the parent is deleted.
-- SET NULL would therefore buy a constraint that stops protecting precisely the rows this
-- migration is about.
--
-- WHAT DROPPING IT COSTS, both halves answered rather than inherited:
--
--   (1) THE TENANT GUARD. A referential check runs with row security disabled, which is why
--       a composite key is a tenant guard (0035, 0037, and the live proof in
--       `composite-fk.contract.test.ts`). Dropping the key removes that, so it is replaced
--       by something stronger rather than by nothing: `crm.notification_delivery_context`
--       below is a BEFORE INSERT trigger that resolves the notification UNDER THE CALLER'S
--       OWN ROW SECURITY and refuses a row it cannot see. That is 0034's
--       `notification_endpoint_probe_guard` idiom, and it is strictly tighter than the key
--       it replaces — a foreign key would have accepted another tenant's notification as
--       existing, where an invisible row reads as absent here. It is also the only place
--       that could copy the four columns above, so the guard and the copy are one statement
--       and cannot drift apart.
--
--   (2) THE ORPHANS. 0036 stated this cost plainly and left it: nothing prunes a table with
--       no cascade. Here it is answered, because an orphan is the POINT — a delivery row
--       whose notification has been pruned is the retained evidence — and so it needs a
--       horizon of its own rather than an exemption. That is Part 2.
--
-- ===========================================================================
-- THE ORDERING HAZARD, BEFORE ANY OF IT IS READABLE
-- ===========================================================================
--
-- `created_at` here is `now()`, the TRANSACTION timestamp, and this table is written in
-- bulk inside one transaction by design: `raiseNotification` fans one signal out to every
-- matching endpoint in the caller's transaction, `raiseForSupervisors` does that once per
-- supervisor, and the expiry sweep runs its whole nightly pass as one transaction so a
-- failure anywhere leaves the night as though it had not run. Two deliveries written
-- together share `created_at` to the microsecond. `next_attempt_at` defaults to `now()`
-- too, so a whole sweep's deliveries are also due at the identical instant — and `claimDue`
-- ordered by `next_attempt_at` and then by `n.created_at`, which is the same clock again.
-- The claim order of a batch was therefore the plan's, not the queue's, and a history read
-- had nothing to order by at all.
--
-- `seq` is the fix, and it is 0027's, 0033's and 0041's verbatim: a sequence value is
-- allocated at INSERT time, so it records the order the INSERTs ran. It carries 0027's
-- warnings unchanged — it HAS GAPS (`raiseNotification`'s `ON CONFLICT … DO NOTHING` burns
-- a value whenever a delivery already exists, and a rolled-back transaction burns a whole
-- batch), so nothing may read it as a count; and ACROSS transactions it is allocation order
-- rather than commit order. What it buys is order WITHIN a transaction, which is where this
-- table had none.
--
-- GENERATED ALWAYS AS IDENTITY, following 0041 rather than 0027: this is now a history
-- table that outlives its parent, a hand-written row is a contemplated path throughout this
-- schema, and a supplied `seq` would corrupt the one ordering a retained record has.
--
-- ===========================================================================
-- RE-APPLICATION, FORCE RLS, AND WHICH OF THE THREE TRAPS APPLIED
-- ===========================================================================
--
-- All three of them, which is why each is named where it bites:
--
--   * BLIND DML (0027's pattern, 0032's defect, 0039's repair). Three statements here are
--     plain DML on RLS-FORCEd tables, run as `crm_app` with no `app.current_tenant_id`: the
--     column backfill, its `max(seq)` read, and Part 2's clamp. Under the policy each would
--     match nothing and report success on a table full of rows. FORCE is lifted around each
--     and restored immediately — and the backfill JOINS `crm.notification`, which is FORCEd
--     too, so BOTH tables have to be lifted or the join contributes zero rows and the
--     `SET NOT NULL` that follows is the only thing that complains.
--   * A VALIDATED CHECK IS SIGHTED (0039's asymmetry). Part 2's
--     `notification_policy_delivery_not_shorter` is added as an ordinary validated CHECK, so
--     its scan sees every row including the ones RLS hides. That is why the clamp must run
--     first and must actually work: a tenant holding `retain_unread_days = 3650` violates a
--     730-day default, and 0032 is what happens when a clamp silently updates nothing and a
--     sighted CHECK then refuses.
--   * A UNIQUE INDEX IS ENFORCED WITH ROW SECURITY DISABLED (0043). `UNIQUE (notification_id,
--     endpoint_id)` was cross-tenant, and until now the composite foreign key beside it
--     covered for that. With the key gone it would be the only remaining tenant-blind
--     structure on the table and an existence oracle of exactly 0043's shape, so it becomes
--     `(tenant_id, notification_id, endpoint_id)`. 0043's ordering discipline applies:
--     the new key is added BEFORE the old one is dropped, so the window between the two
--     statements holds both and the stricter one is the survivor if `psql` in autocommit
--     stops there.
--
-- WHAT IS NOT IDEMPOTENT, said plainly: this file assumes 0045 and no later. The runner
-- hashes and skips an applied file, and `scripts/setup-test-db.sh` builds from empty, so
-- neither replays it. Nothing here is written to survive a second execution and nothing
-- needs to be.

-- ===========================================================================
-- PART 1 — THE DELIVERY ROW STOPS DEPENDING ON THE NOTIFICATION ROW
-- ===========================================================================

-- Both tables, for the duration of the backfill only. See the header: the UPDATE reads one
-- and writes the other, and under FORCE with no tenant context both are empty. The runner
-- wraps the file in one transaction so the lifted state is never committed; through `psql`
-- in autocommit it briefly is, which is acceptable for 0027's reason — that path builds a
-- database from nothing with no application connected to it.
ALTER TABLE crm.notification_delivery NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification NO FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.notification_delivery
  ADD COLUMN notification_kind        text,
  ADD COLUMN notification_severity    text,
  ADD COLUMN notification_created_at  timestamptz,
  ADD COLUMN recipient_rep_profile_id uuid,
  ADD COLUMN seq                      bigint;

-- The copies, for every row that predates them. `crm.notification` is matched on
-- `(tenant_id, id)` rather than on `id` alone — the pair the dropped key used — so the
-- backfill cannot be the one statement in this file that crosses a tenant.
--
-- Every existing row has a notification by construction: the cascade this migration removes
-- is what guaranteed it. If one does not, the UPDATE leaves its copies NULL and the
-- `SET NOT NULL` below FAILS, which is the correct outcome — a delivery row with no
-- notification and no copies is unreadable, and halting a deploy in front of it is better
-- than inventing values for it.
UPDATE crm.notification_delivery d
   SET notification_kind        = n.kind,
       notification_severity    = n.severity,
       notification_created_at  = n.created_at,
       recipient_rep_profile_id = n.recipient_rep_profile_id
  FROM crm.notification n
 WHERE n.tenant_id = d.tenant_id
   AND n.id        = d.notification_id;

/*
 * The write order for rows that predate `seq`.
 *
 * `created_at` first, because it is the only thing the table recorded — and, as the header
 * says, the very thing that does not discriminate, since the rows this column exists for
 * share it to the microsecond. Their insert order was never written down, so it cannot be
 * recovered; it can only be CHOSEN, which is 0027's admission and 0036's twice.
 *
 * Then `notification_created_at`, which is a real signal rather than a preference wherever
 * the batch spans signals raised in different transactions: a push for an older signal
 * sorts first. It ties when the signals were raised together, which is the common case.
 *
 * Then `id`, so the result is a total order that is stable and reproducible instead of
 * depending on the plan — and a uuid is meaningless as an ordering, which is exactly the
 * point: where the data cannot say, the backfill picks once and keeps picking the same way.
 */
UPDATE crm.notification_delivery d
   SET seq = ordered.rn
  FROM (
    SELECT id,
           row_number() OVER (ORDER BY created_at, notification_created_at, id) AS rn
      FROM crm.notification_delivery
  ) AS ordered
 WHERE d.id = ordered.id;

ALTER TABLE crm.notification_delivery
  ALTER COLUMN notification_kind        SET NOT NULL,
  ALTER COLUMN notification_severity    SET NOT NULL,
  ALTER COLUMN notification_created_at  SET NOT NULL,
  ALTER COLUMN recipient_rep_profile_id SET NOT NULL,
  ALTER COLUMN seq                      SET NOT NULL;

ALTER TABLE crm.notification_delivery
  ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;

-- Starts above the backfilled values so a new row never collides with a historical one.
-- `is_called = false` makes the next `nextval` return exactly this number rather than the
-- one after it; COALESCE covers the empty table, which is the normal case on a fresh deploy.
-- This reads `max(seq)`, so it has to run while FORCE is still lifted (0041's note).
SELECT setval(pg_get_serial_sequence('crm.notification_delivery', 'seq'),
              COALESCE((SELECT max(seq) FROM crm.notification_delivery), 0) + 1, false);

ALTER TABLE crm.notification FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_delivery FORCE ROW LEVEL SECURITY;

-- NO CHECK ON `notification_kind` OR `notification_severity`, DELIBERATELY. The obvious move
-- is to restate `crm.notification`'s own two CHECKs here, since the point of a copy is that
-- it outlives the row it was taken from and so cannot be validated against it. It is the
-- wrong move: the kind vocabulary has been widened three times already (0021 wrote six
-- kinds; 0022, 0029 and 0031 added more), and a second copy of that list on this table would
-- have to be widened in lockstep — a migration that forgot would not fail, it would refuse
-- every DELIVERY of the new kind while the notification itself inserted fine, so the signal
-- would reach the inbox and silently never be pushed. The value is not caller input: the
-- trigger below overwrites it from a row that has already satisfied the real CHECK, so the
-- vocabulary is enforced once, where it is declared.

-- ---------------------------------------------------------------------------
-- The episode key, tenant-scoped. 0043's reasoning and 0043's statement order.
-- ---------------------------------------------------------------------------
-- One attempt chain per endpoint per notification is still the rule — fanning one signal to
-- one endpoint twice pages somebody twice for one event — and `tenant_id` joins it because
-- a unique index is enforced with row security disabled and the composite foreign key that
-- used to cover that is being dropped below. Added first, dropped second: both keys are
-- live in the window between, and the OLD one is the stricter, so a crash there leaves
-- today's behaviour rather than no episode key at all.
ALTER TABLE crm.notification_delivery
  ADD CONSTRAINT notification_delivery_tenant_notification_endpoint_key
    UNIQUE (tenant_id, notification_id, endpoint_id);

ALTER TABLE crm.notification_delivery
  DROP CONSTRAINT notification_delivery_notification_id_endpoint_id_key;

-- ---------------------------------------------------------------------------
-- And the reference itself.
-- ---------------------------------------------------------------------------
-- `notification_id` stays a plain uuid, indexed, exactly as `crm.outbox_dead_letter.outbox_id`
-- is. See the header for why not SET NULL, and for the two costs and their answers.
ALTER TABLE crm.notification_delivery
  DROP CONSTRAINT notification_delivery_notification_id_fkey;

-- The write order, tenant-scoped, serving both directions: `ORDER BY seq` for the prune's
-- oldest-first scan and `ORDER BY seq DESC` for "what has been pushed lately".
CREATE INDEX idx_notification_delivery_seq
  ON crm.notification_delivery (tenant_id, seq);

-- Every read of the history is "the pushes for this one signal", and with no foreign key
-- there is no longer an index behind that predicate for free.
CREATE INDEX idx_notification_delivery_notification
  ON crm.notification_delivery (tenant_id, notification_id);

-- ---------------------------------------------------------------------------
-- The copy, and the tenant guard that replaces the key
-- ---------------------------------------------------------------------------

/**
 * Resolves the notification a delivery is for, and copies what the row must keep.
 *
 * SECURITY INVOKER (the default, asserted by `schema.contract.test.ts`), which is the whole
 * mechanism: the lookup runs under the CALLER'S row security, so a notification in another
 * tenant reads as ABSENT and the row is refused. The dropped foreign key could not do that
 * — a referential check runs with row security disabled and would have found the foreign
 * parent perfectly well, which is the asymmetry 0035 and 0037 turn on and 0034 already
 * exploited in `notification_endpoint_probe_guard`. So this is a tighter guard than the one
 * it replaces, not a weaker substitute for it.
 *
 * THE COPIES ARE OVERWRITTEN, NOT DEFAULTED. A caller who could supply `notification_kind`
 * could record a push as having carried a signal it did not — 0034 makes the same choice
 * about `requested_at` for the same reason. The columns are NOT NULL and this trigger is
 * what satisfies them, so a path that bypasses it writes nothing at all rather than writing
 * a row with no context.
 *
 * It fires BEFORE INSERT only. The copies describe the notification as it was when the push
 * was enqueued and must not follow it afterwards: `markRead` moves `read_at`, and a delivery
 * record that changed under a reader would not be evidence of anything.
 */
CREATE OR REPLACE FUNCTION crm.notification_delivery_context()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n record;
BEGIN
  SELECT x.kind, x.severity, x.created_at, x.recipient_rep_profile_id
    INTO n
    FROM crm.notification x
   WHERE x.tenant_id = NEW.tenant_id
     AND x.id        = NEW.notification_id;

  IF n IS NULL THEN
    RAISE EXCEPTION
      'delivery-foreign-notification: notification % is not visible in tenant %',
      NEW.notification_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.notification_kind        := n.kind;
  NEW.notification_severity    := n.severity;
  NEW.notification_created_at  := n.created_at;
  NEW.recipient_rep_profile_id := n.recipient_rep_profile_id;

  RETURN NEW;
END
$$;

CREATE TRIGGER notification_delivery_context
  BEFORE INSERT ON crm.notification_delivery
  FOR EACH ROW EXECUTE FUNCTION crm.notification_delivery_context();

-- ---------------------------------------------------------------------------
-- 0024's candidate view, with one predicate added
-- ---------------------------------------------------------------------------
--
-- REPRODUCED FROM 0024 VERBATIM apart from the `d.tenant_id = n.tenant_id` term, and that
-- discipline is not optional: `CREATE OR REPLACE VIEW` replaces the whole definition, so a
-- replacement rebuilt from memory silently reverts whatever a later migration amended.
-- 0043's header records a function being reverted exactly that way.
--
-- The term is not a behaviour change today — the view runs under the caller's row security
-- and `crm.notification_delivery` is FORCEd, so the subquery was already confined. It is
-- named because the foreign key that made the pairing structural is gone as of this file,
-- and 0043's rule applies: write the tenant match where a reader can see it rather than
-- leaving it to a policy two files away.
--
-- WHAT IS UNCHANGED, and matters more after this migration than before: an unsettled
-- delivery still holds its notification back. It now does so for a second reason. A dead
-- delivery is never pruned at any horizon (Part 2), so pruning its notification would
-- create a permanent orphan rather than a retained record — the hold is what keeps the two
-- tables from disagreeing about whether an unresolved push exists.
CREATE OR REPLACE VIEW crm.notification_prune_candidates AS
  SELECT n.id,
         n.tenant_id,
         n.recipient_rep_profile_id,
         n.kind,
         n.severity,
         n.created_at,
         n.read_at,
         n.subject_table,
         n.subject_id,
         (n.read_at IS NOT NULL)                                       AS was_read,
         crm.notification_subject_open(n.subject_table, n.subject_id)  AS subject_open,
         crm.notification_subject_unknown(n.subject_table)             AS subject_unknown,
         EXISTS (SELECT 1 FROM crm.notification_delivery d
                  WHERE d.tenant_id = n.tenant_id
                    AND d.notification_id = n.id
                    AND d.state IN ('pending', 'in_flight', 'dead'))   AS delivery_unsettled
    FROM crm.notification n;

-- ===========================================================================
-- PART 2 — THE SECOND HORIZON, BESIDE THE OTHER TWO
-- ===========================================================================
--
-- `crm.notification_policy` is where retention is configured and where the volume guard
-- lives, so this goes there rather than into a table of its own. 0036 named that as the
-- open question — "`crm.notification_policy` is where retention is configured, adding a
-- third horizon to it is a decision about what a tenant is promised" — and this is the
-- decision.
--
-- THE DEFAULT IS 730 DAYS, AND IT IS A JUDGEMENT. Two years, against 30 for a read
-- notification and 365 for an unread one:
--
--   * A delivery record is evidence about a third party's endpoint and about a disclosure of
--     an employee's name to it. The horizon that fits is the one a dispute or an audit runs
--     on, not the one an inbox badge runs on. Two years is the shortest period that covers a
--     full annual cycle plus the following one's lookback, so a question asked in the first
--     quarter about last year still has an answer.
--   * It is twice the unread default, so the pair reads at a glance as "the evidence
--     outlives the message" rather than as two numbers somebody has to compare.
--   * It is affordable in a way a longer notification horizon is not, which is the honest
--     reason it can be this generous. A delivery row is fixed-width columns and no prose:
--     this table holds no `subject`, no `body` and no `payload`, by the deliberate exclusion
--     in the header. A tenant pushing a thousand signals a night to three endpoints reaches
--     roughly 2.2 million rows at steady state, a few hundred megabytes with its indexes —
--     where two years of the notifications themselves would be several times that.
--
-- WHAT IT COSTS, stated rather than hidden. This becomes the largest table in the
-- notification stack and the one that most needs its prune to actually run; the copies mean
-- `kind` and `severity` are stored twice for as long as both rows live; and two years is a
-- long time to hold a record naming an employee, which is why it is a per-tenant number
-- with a floor of one day rather than a constant.
--
-- AND IT MAY NOT BE SHORTER THAN THE UNREAD HORIZON. Without that CHECK a tenant could
-- configure `retain_delivery_days = 1` against `retain_unread_days = 365` and recreate, by
-- configuration, exactly the coupling this migration removes — worse, inverted: the proof of
-- the push would be deleted while the message it pushed was still on display. The unread
-- horizon is the longer of the notification's two, so comparing against it is what makes
-- "a delivery record outlives the notification it describes" true for every notification
-- rather than for the read ones only. It is the same shape as
-- `notification_policy_unread_not_shorter` and it has the same consequence, which is worth
-- stating: raising the unread horizon above the delivery horizon is refused, and the fix is
-- to raise the delivery horizon first.

ALTER TABLE crm.notification_policy
  ADD COLUMN retain_delivery_days integer NOT NULL DEFAULT 730
    CHECK (retain_delivery_days BETWEEN 1 AND 3650);

-- The clamp, before the pairing CHECK below can see it. A tenant that has configured
-- `retain_unread_days` above 730 would otherwise violate the new constraint the moment it is
-- validated, and a validated CHECK's scan is NOT an ordinary query — it sees every row,
-- which is how 0032 was caught by the half of the asymmetry that is sighted while its own
-- repair was blinded by the half that is not.
--
-- RAISED TO MATCH, not lowered: the whole point of the pairing is that the evidence outlives
-- the message, so a tenant that has chosen to keep unread notifications for five years has
-- chosen to keep the delivery records at least that long. The alternative — shortening their
-- unread horizon to fit a default they never set — would delete notifications as a side
-- effect of adding a feature.
ALTER TABLE crm.notification_policy NO FORCE ROW LEVEL SECURITY;

UPDATE crm.notification_policy
   SET retain_delivery_days = retain_unread_days, updated_at = now()
 WHERE retain_unread_days > retain_delivery_days;

ALTER TABLE crm.notification_policy FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.notification_policy
  ADD CONSTRAINT notification_policy_delivery_not_shorter
    CHECK (retain_delivery_days >= retain_unread_days);

-- ---------------------------------------------------------------------------
-- What the delivery prune will consider, as a view
-- ---------------------------------------------------------------------------

/**
 * Every delivery row, with the reason it is or is not prunable.
 *
 * A view for 0024's reason: so an operator can ask "what would tonight's pass take" in SQL
 * before anything is deleted, rather than inferring it from a count that came out lower
 * than expected.
 *
 * ONLY A SETTLED DELIVERY IS PRUNABLE, at any horizon. `pending` and `in_flight` are
 * obvious — the push has not finished. `dead` is the interesting one, and it is held back
 * forever: a webhook that permanently failed is an unresolved operational fact and the most
 * valuable row in this table, so deleting it on a schedule would be deleting the evidence
 * of a regulated failure by default. That is 0024's rule for the notification side and
 * 0036's argument for why an unbounded failure-only table is acceptable: it grows only with
 * failure, so unbounded growth here is a paging condition before it is a disk problem. A
 * dead delivery also pins its notification (`delivery_unsettled` above), so the two tables
 * agree about which pushes are still open.
 *
 * `orphaned` is the feature made countable: true once the notification this row describes
 * has been pruned and the row has outlived it. It is not a reason to prune and not a reason
 * to keep — the horizons are independent, so a delivery whose notification is still held
 * back by an open subject still prunes at its own horizon, and an orphan inside its horizon
 * is retained exactly as intended. It is reported so that "delivery history now outlives
 * the inbox" is a number somebody can watch rather than a claim in a migration header.
 */
CREATE OR REPLACE VIEW crm.notification_delivery_prune_candidates AS
  SELECT d.id,
         d.tenant_id,
         d.seq,
         d.notification_id,
         d.endpoint_id,
         d.state,
         d.created_at,
         d.delivered_at,
         d.notification_kind,
         d.notification_severity,
         (d.state <> 'delivered')             AS unsettled,
         NOT EXISTS (SELECT 1 FROM crm.notification n
                      WHERE n.tenant_id = d.tenant_id
                        AND n.id = d.notification_id) AS orphaned
    FROM crm.notification_delivery d;

-- ===========================================================================
-- PART 3 — READING IT
-- ===========================================================================

/**
 * One signal's delivery history, oldest first.
 *
 * In SQL rather than only in `@crm/notify`, for the reason `crm.outbox_dead_letter_history`
 * is: the ordering key is a property of the table, and a caller that reconstructed it would
 * eventually reconstruct it differently. `ORDER BY seq`, which is the write order — see the
 * header for why `created_at` is not one.
 *
 * `seq` is returned, so a reader can see the key it is ordered by and page on it; 0041 made
 * the same choice for the same reason, and deliberately did not build the paging.
 *
 * `recipient_display_name` comes from a LEFT JOIN, so a rep whose profile has been removed
 * reads as a recorded uuid beside a null name — 0036's shape, which is strictly more than
 * either a cascade or a SET NULL would have left.
 *
 * `notification_present` is the one question the join can still answer, and the edge of the
 * whole feature: false means the inbox copy is gone and this row is now the only record
 * that the signal was ever pushed anywhere.
 */
CREATE OR REPLACE FUNCTION crm.notification_delivery_history(p_notification_id uuid)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
  notification_kind        text,
  notification_severity    text,
  notification_created_at  timestamptz,
  recipient_rep_profile_id uuid,
  recipient_display_name   text,
  state                    text,
  attempts                 integer,
  last_status              integer,
  last_error               text,
  delivered_at             timestamptz,
  created_at               timestamptz,
  notification_present     boolean
)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         -- Joined, not copied: see the header. The endpoint is unaffected by this migration
         -- and a url that can be read from a live row must not also be stored here.
         e.channel, e.url,
         d.notification_kind, d.notification_severity, d.notification_created_at,
         d.recipient_rep_profile_id, rp.display_name,
         d.state, d.attempts, d.last_status, d.last_error, d.delivered_at, d.created_at,
         EXISTS (SELECT 1 FROM crm.notification n
                  WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id)
    FROM crm.notification_delivery d
    LEFT JOIN crm.notification_endpoint e
           ON e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
    LEFT JOIN crm.rep_profile rp
           ON rp.tenant_id = d.tenant_id AND rp.id = d.recipient_rep_profile_id
   WHERE d.notification_id = p_notification_id
   ORDER BY d.seq;
$$;

/**
 * What this tenant has pushed lately, newest first.
 *
 * `ORDER BY seq DESC`, not `created_at DESC` — 0041 part 1 is the whole argument: a listing
 * sorted on a transaction timestamp reports a fiction whenever a batch shares one, and ends
 * on a uuid chosen only to make the order total. The index added above is
 * `(tenant_id, seq)`, which serves this scan backwards.
 *
 * Same columns as the history read, so one projection serves both and a reader does not
 * have to learn two shapes for one row. `p_limit` is clamped here rather than trusted, like
 * `crm.notification_inbox`.
 */
CREATE OR REPLACE FUNCTION crm.notification_delivery_recent(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
  notification_kind        text,
  notification_severity    text,
  notification_created_at  timestamptz,
  recipient_rep_profile_id uuid,
  recipient_display_name   text,
  state                    text,
  attempts                 integer,
  last_status              integer,
  last_error               text,
  delivered_at             timestamptz,
  created_at               timestamptz,
  notification_present     boolean
)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         e.channel, e.url,
         d.notification_kind, d.notification_severity, d.notification_created_at,
         d.recipient_rep_profile_id, rp.display_name,
         d.state, d.attempts, d.last_status, d.last_error, d.delivered_at, d.created_at,
         EXISTS (SELECT 1 FROM crm.notification n
                  WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id)
    FROM crm.notification_delivery d
    LEFT JOIN crm.notification_endpoint e
           ON e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
    LEFT JOIN crm.rep_profile rp
           ON rp.tenant_id = d.tenant_id AND rp.id = d.recipient_rep_profile_id
   ORDER BY d.seq DESC
   LIMIT greatest(1, least(p_limit, 500));
$$;
