-- 0038_revive_moment.sql
--
-- AN EPISODE COULD BE RECORDED AS HAVING ENDED BEFORE IT BEGAN.
--
-- 0036's `crm.outbox_dead_letter_record()` closes a dead-letter episode when the outbox
-- row leaves `dead`. It handles the two columns differently, and only one of them
-- correctly:
--
--     SET revived_at = COALESCE(NEW.revived_at, now()),
--         revived_by = CASE WHEN NEW.revive_count > OLD.revive_count THEN NEW.revived_by END
--
-- `revived_by` is guarded on `revive_count` moving, because `crm.outbox.revived_by` still
-- holds the PREVIOUS revive's actor and attributing this episode to them would name
-- somebody who had nothing to do with it. 0036's comment beside it says exactly that, and
-- then says "The moment is known, the person is not."
--
-- The moment is not known. `crm.outbox.revived_at` is just as stale as `revived_by`, and
-- it was copied unguarded — so a second revive that does not set `revived_at` (the
-- hand-written path, a `psql` UPDATE) stamps the new episode with the FIRST revive's
-- timestamp. Measured on a real database before this migration:
--
--     attempt |        died_at         |       revived_at       | revived_before_it_died
--           1 | 2026-10-02 09:00:00+00 | 2026-10-02 08:00:00+00 | t
--
-- An episode that ended an hour before it started. The existing contract test asserted
-- only `revived_at IS NOT NULL`, so it passed straight over this.
--
-- THE RULE. The same guard the actor already has, with `now()` as the fallback rather
-- than NULL: a closing episode always knows THAT it ended, even when the writer did not
-- say when, and the honest answer for "when" is the moment the close was recorded.
--
-- A supplied `revived_at` is trusted only when it could belong to THIS episode — the
-- counter moved AND the timestamp is not older than the death it closes. Everything else
-- gets `now()`:
--
--   - counter moved, timestamp >= died_at → the writer is describing this revive. Trust it.
--   - counter moved, timestamp < died_at  → impossible as a description of this episode,
--                                           so it is a leftover. This is the case a
--                                           counter-only guard lets through, and the one
--                                           the first draft of this migration still got
--                                           wrong: a hand-written revive that bumps
--                                           `revive_count` and forgets `revived_at`.
--   - counter static                      → the writer is not describing a revive at all.
--
-- Never NULL in any branch: `revived_at IS NULL` is what marks an episode still OPEN —
-- this statement's own WHERE depends on it — and the episode is closing.
--
-- WHY NOT make the column nullable-on-doubt instead. Because `revived_at IS NULL` is
-- load-bearing in the trigger's own WHERE clause (`AND d.revived_at IS NULL` is how it
-- finds the open episode) and in every reader that distinguishes "still dead" from
-- "recovered". Writing NULL to express "we are unsure of the minute" would reopen the
-- episode, and the next revive would close the wrong row.
--
-- A NOTE THE READ SIDE ALREADY CARRIES. `summariseAttemptHistory().impossibleRevivals`
-- counts rows where `revived_at < died_at`. It stays after this migration: it cannot
-- happen on the trigger path any more, and it is still reachable by a hand-written INSERT
-- straight into the table, which is precisely the kind of row an operator should be told
-- about rather than shown as fact.
--
-- EXISTING ROWS ARE NOT REPAIRED, and that is deliberate. A row whose `revived_at`
-- predates its `died_at` is a record of something that did not happen that way, and the
-- true moment is not recoverable from anything — `crm.outbox` keeps only the latest
-- revive. Overwriting it with `now()` would replace a visibly wrong timestamp with an
-- invisibly wrong one, which is worse: `impossibleRevivals` can find the first and
-- nothing can find the second.

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

  ELSIF OLD.state = 'dead' AND NEW.state <> 'dead' THEN
    -- The open episode is the highest-numbered one, and `revived_at IS NULL` keeps a
    -- second pass from overwriting a revive already recorded.
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
