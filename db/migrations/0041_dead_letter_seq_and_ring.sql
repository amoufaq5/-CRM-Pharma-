-- 0041_dead_letter_seq_and_ring.sql
--
-- The death history could not be ordered, and could not stop growing.
--
-- ===========================================================================
-- PART 1 — crm.outbox_dead_letter HAD NO WRITE ORDER, ONLY A DECLARED ONE
-- ===========================================================================
--
-- WHAT WAS BROKEN. 0036 part 2 argued that this table needed no `seq` because
-- `(outbox_id, attempt)` is declared rather than temporal, so it orders correctly however
-- many rows share a transaction. That argument is right about ONE outbox row and says
-- nothing about the listing across all of them, which is the read an operator actually
-- opens. `recentDeaths` sorted `died_at DESC, outbox_id, attempt DESC` and its own header
-- recorded why that is not a write order:
--
--   * `died_at` TIES. It is not `now()` — the trigger below copies `crm.outbox.dead_at`,
--     which `markDead` receives as a caller-supplied `Date` with millisecond resolution —
--     and the one path that dead-letters without an ERP round trip in between
--     (`UnknownOperationError`, refused by `parseOperation` before any HTTP call) settles a
--     whole batch inside one millisecond. Pinned by a test that counts
--     `DISTINCT died_at` over two deaths and gets 1.
--   * `attempt` is no tie-break at all ACROSS outbox rows, because for two rows dying for
--     the first time both are 1.
--   * So the sort ended on `outbox_id`, a uuid, chosen purely to make the order TOTAL so a
--     page boundary could not drop or duplicate a row. It bought a stable page and it
--     reported a fiction: the listing's leading row was whichever uuid sorted smallest, not
--     the row that died last.
--
-- That file's own closing line named the fix — "recovering the real write order needs a
-- `seq` on this table" — and this is it, following `crm.outbox.seq` (0027) and
-- `crm.attachment_access.seq` (0033). Both exist for the identical reason and it is worth
-- stating once more, because this is the fourth table to need it: a timestamp defaulted
-- from `now()` is the TRANSACTION timestamp and a timestamp handed in by a caller is that
-- caller's clock, and neither discriminates between two rows written together. A sequence
-- value is allocated at INSERT time, so it records the order the INSERTs ran.
--
-- WHAT IT DOES NOT GUARANTEE, the same list 0027 wrote and 0033 and 0036 repeated, because
-- the column invites the wrong reading every time. Identity allocation is outside
-- transaction control: it does not roll back and it is not serialised against other
-- transactions. So `seq` HAS GAPS and must never be read as a count — `deathsEverRecorded`
-- is read off `attempt` and nothing else, and Part 2 below makes gaps the normal case
-- rather than the exceptional one. And ACROSS transactions `seq` is allocation order rather
-- than commit order, so a lower value can become visible after a higher one. The order it
-- buys is WITHIN a transaction, which is exactly where this table had nothing.
--
-- GENERATED ALWAYS AS IDENTITY, NOT 0027'S SEQUENCE AND DEFAULT. 0033 made the same choice
-- for `crm.attachment.seq` and this file makes it for the stronger of its two reasons:
-- `GENERATED ALWAYS` REFUSES an explicit value outright, where a `DEFAULT nextval` column
-- merely fails to fill one in. Verified against this cluster:
--
--     INSERT INTO crm.outbox_dead_letter (..., seq) VALUES (..., 999);
--     ERROR: cannot insert a non-DEFAULT value into column "seq"
--     DETAIL: Column "seq" is an identity column defined as GENERATED ALWAYS.
--
-- That is why NO UNIQUE INDEX is added here, where 0036 part 1 added
-- `uq_disposal_obligation_seq` and argued for it at length. That argument was about
-- DETECTING a hand-written value on a column whose only protection was a default; here a
-- hand-written value is rejected before it reaches the heap, and an index that could only
-- catch what the column type already forbids would be an index maintained for an
-- impossible row — on a table that Part 2 now DELETEs from on every death.
--
-- The backfill below is still a plain UPDATE and still has to see the whole table, so the
-- FORCE RLS hazard is unchanged and 0032's lesson applies; see the note above it.

-- ---------------------------------------------------------------------------
-- 1.1 The column, and the order history gets to keep.
-- ---------------------------------------------------------------------------

-- The backfill is a DML statement on an RLS-FORCEd table and this migration runs as
-- `crm_app` with no `app.current_tenant_id` set, so the policy matches nothing and the
-- UPDATE reports zero rows over a table holding rows — leaving every historical row NULL
-- and the NOT NULL below as the only hint that anything went wrong. That is precisely how
-- 0032 shipped broken and what 0039 had to repair. Re-verified on this table before this
-- file was written, so it is evidence and not inheritance:
--
--     SET ROLE crm_app; DELETE FROM crm.outbox_dead_letter;        -- DELETE 0
--     -- and inside a tenant context, over the same committed row:
--     SELECT count(*) FROM crm.outbox_dead_letter;                 -- 1
--     DELETE FROM crm.outbox_dead_letter;                          -- DELETE 1
--
-- A backfill has to see the whole table by definition, so FORCE is lifted and restored at
-- the bottom of this part — 0027's pattern, for 0027's reason. The runner wraps each
-- migration in one transaction and this file opens none, so under a deploy the lifted state
-- is never committed. `scripts/setup-test-db.sh` pipes the file through psql in autocommit,
-- where it briefly is, which is acceptable only because that path builds an empty database
-- from nothing with no application connected to it.
ALTER TABLE crm.outbox_dead_letter NO FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.outbox_dead_letter ADD COLUMN seq bigint;

/*
 * The backfill order for rows that predate the column.
 *
 * Not heap order. Adding the column with its identity in one statement would have filled
 * it from the rewrite's physical scan, which for a table this append-only is PROBABLY the
 * real insert order and is promised by nothing — a revive stamps `revived_at` on an
 * existing row, and a non-HOT update moves that row, so the one write path that is not an
 * insert is also the one that perturbs the scan. Two databases holding the same logical
 * history could then disagree about `seq`, which is the opposite of what the column is for.
 *
 * So the order is CHOSEN, and it is `recentDeaths`'s own former sort key: `died_at`, then
 * `outbox_id`, then `attempt`. Choosing it reproduces for the historical prefix exactly the
 * order the listing has been serving all along, so this migration does not silently
 * reshuffle what an operator has already read.
 *
 * And it degenerates, for the tied rows this part exists for, to uuid order — the very
 * ordering `seq` is being added to replace. That is not a flaw in the choice; it is the
 * fact. Their write order was never recorded anywhere in the table, so it cannot be
 * recovered, only CHOSEN (0027's admission, 0036's twice). What `seq` buys is a true write
 * order from this migration FORWARD; the prefix is a stable fiction, and it is better than
 * a NULL in a NOT NULL column or a value that depends on the plan.
 */
UPDATE crm.outbox_dead_letter d
   SET seq = ordered.rn
  FROM (
    SELECT id,
           row_number() OVER (ORDER BY died_at, outbox_id, attempt) AS rn
      FROM crm.outbox_dead_letter
  ) AS ordered
 WHERE d.id = ordered.id;

ALTER TABLE crm.outbox_dead_letter ALTER COLUMN seq SET NOT NULL;
ALTER TABLE crm.outbox_dead_letter ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;

-- Starts above the backfilled values so a new row never collides with a historical one.
-- `is_called = false` makes the next allocation return exactly this number rather than the
-- one after it. COALESCE covers the empty table, the normal case on a fresh deploy. This
-- reads `max(seq)` and therefore has to run while FORCE is still lifted — under the policy
-- it would see no rows, return 1, and hand the first new row a value a historical row
-- already holds.
SELECT setval(pg_get_serial_sequence('crm.outbox_dead_letter', 'seq'),
              COALESCE((SELECT max(seq) FROM crm.outbox_dead_letter), 0) + 1, false);

ALTER TABLE crm.outbox_dead_letter FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1.2 The indexes the new ordering needs, and the one it retires.
-- ---------------------------------------------------------------------------

-- `recentDeaths` is `ORDER BY seq DESC LIMIT n` under a policy that adds
-- `tenant_id = <this tenant>`, so the leading column is the tenant and the sort is served
-- by a backwards walk of the index rather than by sorting every death the tenant has ever
-- had. DESC is written out rather than left to the planner's ability to scan backwards
-- because it costs nothing and says what the index is for.
CREATE INDEX idx_outbox_dead_letter_seq
  ON crm.outbox_dead_letter (tenant_id, seq DESC);

-- And the one it replaces goes, rather than being maintained beside it.
-- `idx_outbox_dead_letter_tenant (tenant_id, died_at DESC)` was created by 0036 for exactly
-- one query — the listing's `ORDER BY died_at DESC` — and that query no longer exists.
-- Nothing else filters or orders on `died_at`: the per-row history is reached by
-- `outbox_id` through `uq_outbox_dead_letter_attempt`, and every other consumer reads
-- `died_at` as a value off a row it has already fetched (`impossibleRevivals` compares it
-- in TypeScript). Keeping it for the date-range listing nobody has asked for would be an
-- index paid for on every write — and Part 2 makes every death two writes, an INSERT and a
-- DELETE, not one. It is one `CREATE INDEX` to get back if that read is ever built; the
-- column is untouched.
DROP INDEX crm.idx_outbox_dead_letter_tenant;

-- `uq_outbox_dead_letter_attempt (outbox_id, attempt)` STAYS, and is now load-bearing three
-- times over: it refuses a second row claiming to be the same episode (0036's reason), it
-- serves the trigger's `max(attempt)` lookup on both branches, and it serves the ring's
-- ordered scan in Part 2. `idx_outbox_dead_letter_revived_by` stays untouched — "who has
-- been reviving, over a period" is a real read and `seq` is no substitute for it, since the
-- question is about `revived_at` and not about when anything died.

-- ---------------------------------------------------------------------------
-- 1.3 `seq` is returned, so a reader can see the ordering key.
-- ---------------------------------------------------------------------------

/**
 * One outbox row's death history, oldest first — 0036's read, with `seq` on the row.
 *
 * A reader that cannot see the ordering key cannot page by it, so `seq` is selected — in
 * BOTH reads, here and in `recentDeaths`, because a column that appears on one of a table's
 * two reads is a column somebody will discover is missing from the other. 0036 part 1
 * returned `seq` from `crm.disposal_obligation_chain` for the same reason, in the same
 * breath as adding it. That makes keyset paging POSSIBLE (`WHERE seq < <last seen>
 * ORDER BY seq DESC`) and deliberately does not build it — nothing asks for a second page
 * today, and a paging API nobody calls is a surface to maintain for a reader that does not
 * exist. The column being available is the whole change.
 *
 * ORDER BY `attempt`, UNCHANGED, and the burden was on changing it. `attempt` is UNIQUE per
 * `outbox_id` so it cannot tie, it is declared rather than temporal so it orders correctly
 * however many rows share a transaction, and it is the number every answer in
 * `summariseAttemptHistory` is computed from. For every row this schema writes `seq` would
 * give the identical order anyway — the trigger allocates `attempt` as one past the highest
 * recorded, inside the transaction that killed the row, so a higher `attempt` always
 * carries a later `seq`. What switching WOULD change is the one case where they disagree: a
 * history row inserted by hand with an out-of-order `attempt` would then be ORDERED by
 * `seq` while still being NUMBERED by `attempt`, so `lag(reason) OVER (ORDER BY attempt)`
 * would compare against a different row than the one printed above it and
 * `is_repeat_of_previous` would describe a neighbour the reader cannot see. A change that
 * buys nothing and can only desynchronise the flag from the list is not a change.
 *
 * A DROP and a CREATE rather than a replace, because `CREATE OR REPLACE FUNCTION` cannot
 * widen a `RETURNS TABLE` — 0036 part 1 did the same to `crm.disposal_obligation_chain` for
 * the same reason. `seq` is `bigint` and is read as text by `attemptHistory`, the convention
 * `crm.notification_endpoint_probe` (0034) and `crm.disposal_obligation_chain` already
 * follow: a bigint that arrives as a JavaScript number is a bigint that silently rounds.
 */
DROP FUNCTION crm.outbox_dead_letter_history(uuid);

CREATE FUNCTION crm.outbox_dead_letter_history(p_outbox_id uuid)
RETURNS TABLE (
  id                    uuid,
  seq                   bigint,
  outbox_id             uuid,
  attempt               integer,
  revive_count_at_death integer,
  dispatch_attempts     integer,
  died_at               timestamptz,
  reason                text,
  entity                text,
  operation             text,
  target_record_id      text,
  source_table          text,
  source_id             uuid,
  revived_at            timestamptz,
  revived_by            uuid,
  revived_by_name       text,
  is_repeat_of_previous boolean
)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.seq, d.outbox_id, d.attempt, d.revive_count_at_death, d.dispatch_attempts,
         d.died_at, d.reason, d.entity, d.operation, d.target_record_id::text,
         d.source_table, d.source_id,
         d.revived_at, d.revived_by, rp.display_name,
         -- 0036's comparison, verbatim. Byte-identical reasons, not "the same kind of
         -- failure": the kind is `classify`'s verdict, which lives in the relay and is
         -- thrown away once it has chosen a state. And after a trim (Part 2) the oldest
         -- SURVIVING episode has no predecessor to lag onto, so it reads as a first
         -- occurrence — see Part 2's header for why that is sound and where it is declared.
         d.reason IS NOT NULL
           AND d.reason IS NOT DISTINCT FROM
               lag(d.reason) OVER (PARTITION BY d.outbox_id ORDER BY d.attempt)
    FROM crm.outbox_dead_letter d
    LEFT JOIN crm.rep_profile rp ON rp.id = d.revived_by
   WHERE d.outbox_id = p_outbox_id
   ORDER BY d.attempt;
$$;

-- ===========================================================================
-- PART 2 — NOTHING BOUNDED THE HISTORY
-- ===========================================================================
--
-- WHAT WAS BROKEN. 0036 stated this against itself in as many words — "nothing prunes this
-- table, and no cascade will" — and argued that what bounds it is the thing being counted:
-- a row appears only when a write is permanently refused, which ADR-0001 says should alert
-- at any value above zero. That is true of the TABLE and false of a ROW. One outbox row
-- whose ERP-side cause is never fixed, with an operator or a script pressing revive, dies
-- and is recorded again every time, forever, and the growth is unbounded in the one
-- dimension nothing alerts on: not "how many writes are failing" but "how many times has
-- this one failed". The revive loop is not hypothetical — `unaccountedRevivals` exists
-- precisely because this repo contemplates a row being put back in the queue by hand, which
-- is the cheapest action an operator can take and therefore the one that gets repeated.
--
-- THE RULE. A death keeps the newest 50 episodes of its own outbox row and discards the
-- rest, enforced by the trigger that records it. The number is stated once, in
-- `crm.outbox_dead_letter_ring_size()`, so the trigger, a test and a future reader all read
-- the same definition rather than three copies of 50.
--
-- IN THE TRIGGER, NOT IN A SCHEDULED JOB, and that is the decision rather than the
-- convenience. The alternative was the shape `crm.notification_prune` already has: a
-- horizon on `crm.notification_policy` and a nightly pass. It was rejected on two grounds.
-- A ring that depends on a scheduler is unbounded for as long as the scheduler is down, and
-- the failure mode that fills this table — a write refused over and over — is correlated
-- with exactly the kind of outage that stops the scheduler. And a configured horizon is a
-- promise to a tenant about how long a record of a regulated failure is kept, which is the
-- decision 0036 refused to invent and this file is not entitled to make either. A ring is
-- not retention policy: it is a structural bound on one row's history, it deletes nothing
-- unless that one row has died fifty times, and it needs no configuration to be correct.
--
-- WHY FIFTY. Low enough to bound the table at a size nobody has to think about — fifty
-- episodes per outbox row, on a table that only gains rows when a write is permanently
-- refused — and far above any history a human reads. The two conversations 0036 exists to
-- distinguish ("the cause is being fixed" versus "the button is being pressed") are settled
-- by the first handful of episodes; by the fiftieth the answer is not in doubt, and what
-- the operator needs is the count, which survives. It is deliberately not 10, which a
-- genuinely flapping integration could reach in an afternoon of legitimate work, and not
-- 1000, which bounds nothing an operator would notice.
--
-- WHAT IS LOST, stated rather than hidden, because a ring is only acceptable while the
-- thing it discards is named:
--
--   * THE OLDEST EPISODES' REASONS. Their `reason`, `died_at`, `dispatch_attempts`,
--     `revived_at` and `revived_by` are gone and are not recoverable. For a history longer
--     than fifty episodes, "what killed it the FIRST time" becomes unanswerable.
--   * NOT THE COUNT. `attempt` is allocated by the trigger as one past the highest already
--     recorded, so the newest surviving row carries the true number of deaths however many
--     older ones are gone. That is the property that makes a ring acceptable where a
--     cascade is not, and it is why 0036's summary could already report
--     `deathsEverRecorded` and `episodesMissing` from a pruned history before anything
--     pruned it. A trim moves `episodesMissing` off zero; it never makes the summary lie.
--     Pinned by a test that kills one row sixty times and asserts fifty rows,
--     `deathsEverRecorded = 60` and `episodesMissing = 10`.
--   * AND THEREFORE WHAT `alwaysTheSameReason` / `neverTheSameReason` DESCRIBE. Both compare
--     consecutive entries IN HAND, so once a history is longer than the ring they describe
--     the NEWEST FIFTY episodes and not the history. Nothing in them changes; what changes
--     is the scope of the claim, and the reader is told which they are getting by
--     `episodesMissing` being non-zero. The same goes for the oldest surviving row's
--     `is_repeat_of_previous`: its predecessor is gone, `lag` returns NULL and the flag
--     reads false, so an episode that did repeat a trimmed one looks like a first
--     occurrence. That flag is already dropped by the summary — it compares from the second
--     entry onward, because episode 1 of a complete history has no predecessor either — so
--     the under-claim is contained to a reader looking at the raw row, and it is the
--     conservative direction: it reports less repetition than there was, never more.
--
-- THIS MIGRATION TRIMS NOTHING ON APPLICATION, and that is a separate decision from the
-- ring. The ring is a bound going forward; a one-off DELETE over existing history would be
-- a retention decision applied retroactively to records of regulated failures, taken by a
-- migration, with no operator in front of it and no undo — which is the exact shape 0026's
-- prune guard exists to prevent. Any database arriving here with a history longer than
-- fifty keeps all of it until that row dies again, at which point the trim runs and says so
-- through `episodesMissing`. If the oldest episodes should go on application, that is worth
-- asking for explicitly rather than inferring from this file.
--
-- NO FOREIGN KEY IS ADDED, and the trim is not a substitute for one. 0036's header is the
-- reason and it has not changed: a history row must survive its queue row's deletion, which
-- is what makes it worth keeping at all. `outbox_id` stays a plain uuid, and a row whose
-- outbox row is gone simply never dies again and so is never trimmed again — its history
-- freezes at whatever length it reached, which is the correct behaviour for a record that
-- nothing will ever add to.

-- ---------------------------------------------------------------------------
-- 2.1 The constant, once.
-- ---------------------------------------------------------------------------

/**
 * How many episodes of one outbox row's death history are kept.
 *
 * A function and not a literal in the trigger, so there is one definition to read and one
 * to change — and so a test can assert the ring's behaviour against the ring's own number
 * instead of hardcoding a second copy of it that would keep passing after the first moved.
 *
 * IMMUTABLE, so it folds into the trigger's plan rather than being called per row, and
 * SECURITY INVOKER like everything else in `crm` — it reads no table, so there is nothing
 * for a definer's rights to reach, and `schema.contract.test.ts` forbids one globally.
 */
CREATE OR REPLACE FUNCTION crm.outbox_dead_letter_ring_size()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 50 $$;

-- ---------------------------------------------------------------------------
-- 2.2 The trim, in the writer.
-- ---------------------------------------------------------------------------

/**
 * Records a death, trims the ring, and closes the episode when the row is revived.
 *
 * ONE STATEMENT ADDED TO 0038'S FUNCTION, NOT TO 0036'S, and the distinction is written
 * here because this file got it wrong first. `CREATE OR REPLACE FUNCTION` replaces the
 * WHOLE body, so a replacement built from the migration that CREATED the function silently
 * reverts every migration that amended it in between. The first draft of this part pasted
 * 0036's body and undid 0038's guard — the one that stops an episode being recorded as
 * having ended before it began — and the only thing that caught it was 0038's own contract
 * test, which this file did not write and could easily not have existed. The revive branch
 * below is 0038's, comments included, verbatim.
 *
 * STILL SECURITY INVOKER (the default, asserted globally by `schema.contract.test.ts` and
 * specifically by `attempt-history.contract.test.ts`), and the choice matters more now than
 * it did when this function only inserted. The argument, both ways round:
 *
 *   FOR DEFINER, there is one and it is weak. `crm_app` owns this table and
 *   `crm.apply_tenant_isolation` puts it under FORCE ROW LEVEL SECURITY, so the owner is
 *   subject to its own policy; a definer's rights would therefore change NOTHING about what
 *   the trim can see today, because the policy keys off `app.current_tenant_id` — a session
 *   setting — and not off the role. It would buy no capability. The only thing it could buy
 *   is robustness against a future state in which FORCE is lifted or the table is owned by
 *   somebody else, and "works even once isolation has been removed" is not a property worth
 *   having.
 *
 *   AGAINST DEFINER, decisively: in exactly that future state the trim becomes a DELETE
 *   that is not confined to one tenant, driven by a `NEW` row a caller supplied. A SELECT
 *   written that way leaks; a DELETE written that way destroys. Where the two options are
 *   "identical today, and one of them fails as a cross-tenant delete", there is nothing to
 *   weigh. 0011 refused a definer on a read for the weaker version of this reason, and
 *   `schema.contract.test.ts` makes adding one a test failure somebody has to argue past.
 *
 * SO THE TRIM RUNS UNDER THE POLICY, AND IT CAN. The established hazard in this repo is DML
 * as `crm_app` under FORCE RLS with NO tenant context, which matches zero rows and reports
 * success — how 0032 shipped broken, re-verified on this very table above. A trigger does
 * not have that problem, and the proof is structural rather than hopeful, in two layers:
 * the UPDATE on `crm.outbox` that fires this trigger is itself subject to that table's
 * policy, so with no tenant context it matches no row and the trigger never runs at all;
 * and if it somehow did, the INSERT immediately above the trim is subject to this table's
 * WITH CHECK, so a death recorded with no `app.current_tenant_id` set is REFUSED and takes
 * the UPDATE down with it (0036's header says so, and a test pins it). The trim is
 * therefore only ever reached on a path where the tenant context is set AND equals
 * `NEW.tenant_id`, because that is what the INSERT just demonstrated. `markDead` runs
 * inside `withTenantContext`, so the application path has it; a psql prompt without it
 * cannot kill the row to begin with.
 *
 * The DELETE still names `tenant_id` explicitly, so its correctness rests on the predicate
 * and not only on the policy. That also makes the one degenerate case fail closed: a
 * history row somehow carrying a different `tenant_id` under the same `outbox_id` is
 * invisible to the trim and survives it, leaving the ring over-full rather than deleting
 * across a tenant boundary.
 *
 * ORDER AND OFFSET RATHER THAN `attempt <= max - 50`, which is one statement shorter and
 * wrong in the case this repo contemplates. `attempt` is gap-free only while nothing edits
 * this table by hand, and 0036 built the whole numbering around hand edits being a real
 * path — so arithmetic on it would, after one deleted row, discard an episode the ring had
 * promised to keep. Ordering keeps exactly `min(ring size, rows present)`, and it is served
 * by `uq_outbox_dead_letter_attempt`: a backwards index scan of one outbox row's episodes,
 * skipping the ring, over at most fifty-one rows.
 */
CREATE OR REPLACE FUNCTION crm.outbox_dead_letter_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'dead' AND OLD.state <> 'dead' THEN
    INSERT INTO crm.outbox_dead_letter
      (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
       died_at, reason, entity, operation, target_record_id, source_table, source_id)
    VALUES (
      NEW.tenant_id, NEW.id,
      1 + COALESCE((SELECT max(attempt) FROM crm.outbox_dead_letter WHERE outbox_id = NEW.id), 0),
      NEW.revive_count,
      NEW.attempts,
      -- `dead_at` is the relay's own clock and is what every other read of a death uses.
      -- `now()` only covers a death written without one, where the transaction clock is
      -- the best fact available and still better than a null in a NOT NULL column.
      COALESCE(NEW.dead_at, now()),
      NEW.dead_reason,
      NEW.entity, NEW.operation, NEW.target_record_id, NEW.source_table, NEW.source_id
    );

    -- THE RING. The newest `crm.outbox_dead_letter_ring_size()` episodes of THIS outbox row
    -- survive; older ones go, reasons and all. `attempt` keeps counting past them, so the
    -- summary can still say how many episodes it is not showing. See the header for what
    -- that costs, why this runs here rather than in the scheduler, and why the DELETE names
    -- its tenant.
    DELETE FROM crm.outbox_dead_letter d
     WHERE d.id IN (
       SELECT o.id
         FROM crm.outbox_dead_letter o
        WHERE o.tenant_id = NEW.tenant_id
          AND o.outbox_id = NEW.id
        ORDER BY o.attempt DESC
        OFFSET crm.outbox_dead_letter_ring_size()
     );

  ELSIF OLD.state = 'dead' AND NEW.state <> 'dead' THEN
    -- 0038'S BRANCH, UNCHANGED. The open episode is the highest-numbered one, and
    -- `revived_at IS NULL` keeps a second pass from overwriting a revive already recorded.
    -- The ring never takes it: the highest-numbered episode is the one row the trim above
    -- always keeps, which is what leaves this statement something to find.
    --
    -- `revived_by` is taken only when `revive_count` actually moved. On the hand-written
    -- path that puts a row back in the queue without `crm.revive_outbox_letter`,
    -- `NEW.revived_by` still holds the PREVIOUS revive's actor, and copying it would
    -- attribute this one to somebody who had nothing to do with it.
    --
    -- 0038: `revived_at` now asks the SAME question, because it is just as stale. This
    -- comment used to end "The moment is known, the person is not" — and the moment was
    -- not known: an unguarded COALESCE copied the PREVIOUS revive's timestamp, so a second
    -- hand-written revive recorded an episode as having ended before it began. `now()` is
    -- the fallback rather than NULL, because `revived_at IS NULL` is what marks an episode
    -- still OPEN (this statement's own WHERE depends on it) and the episode is closing.
    UPDATE crm.outbox_dead_letter d
       SET revived_at = CASE
                          -- A supplied moment is trusted only when it could belong to THIS
                          -- episode. `crm.outbox` keeps one `revived_at`, overwritten each
                          -- time, so a value that predates the death being closed is
                          -- necessarily a leftover from an earlier episode — whether or not
                          -- `revive_count` moved. Guarding on the counter alone is not
                          -- enough: a hand-written revive that bumps the counter and
                          -- forgets the timestamp passes that guard and still records an
                          -- episode as ending before it began.
                          WHEN NEW.revive_count > OLD.revive_count
                               AND NEW.revived_at IS NOT NULL
                               AND NEW.revived_at >= d.died_at
                          THEN NEW.revived_at
                          ELSE now()
                        END,
           revived_by = CASE WHEN NEW.revive_count > OLD.revive_count THEN NEW.revived_by END
     WHERE d.outbox_id = NEW.id
       AND d.revived_at IS NULL
       AND d.attempt = (SELECT max(attempt) FROM crm.outbox_dead_letter WHERE outbox_id = NEW.id);
  END IF;

  RETURN NULL;
END
$$;
