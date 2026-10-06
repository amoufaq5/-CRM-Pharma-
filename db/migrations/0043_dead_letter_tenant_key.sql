-- Tenant-scopes the dead-letter episode key, and the trigger that allocates it.
--
-- THE ASYMMETRY, again, in its third form. This schema already records two halves of it:
-- a FOREIGN KEY's referential check runs with row security disabled, which is what makes a
-- composite `(tenant_id, …)` key a tenant guard (0035, 0037); a CHECK's validation scan is
-- not an ordinary query either and sees every row (0032, 0039). A UNIQUE INDEX is the same
-- kind of thing: it is enforced with row security disabled.
--
-- `uq_outbox_dead_letter_attempt (outbox_id, attempt)` was therefore cross-tenant, while the
-- trigger that allocates `attempt` — `1 + max(attempt) WHERE outbox_id = NEW.id` — was
-- confined by RLS. Demonstrated against a real database, as `crm_app` under FORCE:
--
--   -- tenant A, one hand-written episode for outbox id X
--   -- tenant B, its own context, same id:
--   SELECT count(*) … WHERE outbox_id = X;   -- 0 rows. The policy hides A's episode.
--   INSERT … (tenant_id = B, outbox_id = X, attempt = 1);
--   ERROR:  duplicate key value violates unique constraint "uq_outbox_dead_letter_attempt"
--
-- Two things wrong with that. The index is an EXISTENCE ORACLE: tenant B learns that some
-- other tenant holds history under an id B cannot read, which is the leak 0035 spent a whole
-- migration closing for references. And the refusal takes the `UPDATE crm.outbox` that fired
-- the trigger down with it, so a death cannot be recorded at all — in the one table whose
-- entire purpose is to be the record of a death.
--
-- Latent rather than live: `crm.outbox.id` is `gen_random_uuid()`, so two tenants do not
-- share one by accident. It is reachable by hand, which is not hypothetical here — 0036
-- deliberately gave this table no foreign key to `crm.outbox` and reasons throughout about
-- hand-written rows, and 0038 exists because one of those rows recorded an episode as having
-- ended before it began.
--
-- THE INDEX IS CREATED BEFORE THE OLD ONE IS DROPPED, not after and not in one statement.
-- The runner applies each file in its own transaction, but `scripts/setup-test-db.sh` applies
-- through psql in autocommit, and that is 0039's documented half-applied failure mode. In this
-- order the window between the two statements holds BOTH keys, and the old one is the stricter
-- of the pair — so a crash in that window leaves today's behaviour rather than no episode key
-- at all. The reverse order, or a DROP that commits alone, is how a uniqueness invariant
-- disappears quietly.
--
-- The name changes with the columns. `uq_outbox_dead_letter_attempt` is referenced in 0036's
-- and 0041's headers as the episode key; it is now
-- `uq_outbox_dead_letter_tenant_attempt (tenant_id, outbox_id, attempt)` and still serves all
-- three of the jobs 0041 names — episode uniqueness, the trigger's `max(attempt)`, and the
-- ring's ordered scan, which it serves better: the trim's predicate is
-- `(tenant_id, outbox_id)` and now matches the index's leading columns exactly.

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_dead_letter_tenant_attempt
  ON crm.outbox_dead_letter (tenant_id, outbox_id, attempt);

DROP INDEX IF EXISTS crm.uq_outbox_dead_letter_attempt;

-- The trigger, with the two `max(attempt)` lookups and the revive branch's WHERE made
-- tenant-scoped so they agree with the index above.
--
-- REPRODUCED FROM 0041 VERBATIM apart from those three predicates, and that discipline is
-- not optional: `CREATE OR REPLACE FUNCTION` replaces the whole body, so a replacement
-- rebuilt from the migration that CREATED the function silently reverts every migration
-- that amended it since. 0038's guard — the one stopping an episode being stamped as ending
-- before it began — was reverted exactly that way during 0041's own authoring, and 0038's
-- contract test is what caught it.
CREATE OR REPLACE FUNCTION crm.outbox_dead_letter_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'dead' AND OLD.state <> 'dead' THEN
    INSERT INTO crm.outbox_dead_letter
      (tenant_id, outbox_id, attempt, revive_count_at_death, dispatch_attempts,
       died_at, reason, entity, operation, target_record_id, source_table, source_id)
    VALUES (
      NEW.tenant_id, NEW.id,
      -- 0043: tenant-scoped, to agree with the index. This lookup was always confined by
      -- RLS and the index was not, which is the whole of the defect: the subquery answered
      -- 1 for a tenant that could not see another tenant's episodes, and the index then
      -- refused the row. Named explicitly rather than left to the policy so the two can be
      -- read together.
      1 + COALESCE((SELECT max(attempt) FROM crm.outbox_dead_letter
                     WHERE tenant_id = NEW.tenant_id AND outbox_id = NEW.id), 0),
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
     WHERE d.tenant_id = NEW.tenant_id
       AND d.outbox_id = NEW.id
       AND d.revived_at IS NULL
       AND d.attempt = (SELECT max(attempt) FROM crm.outbox_dead_letter
                         WHERE tenant_id = NEW.tenant_id AND outbox_id = NEW.id);
  END IF;

  RETURN NULL;
END
$$;
