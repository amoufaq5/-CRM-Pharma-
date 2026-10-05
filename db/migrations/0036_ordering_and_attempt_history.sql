-- 0036_ordering_and_attempt_history.sql
--
-- Two records that could not be ordered or explained: a disposal obligation with no
-- tiebreaker, and a dead letter that remembers only its latest cause of death.
--
-- ===========================================================================
-- PART 1 — crm.disposal_obligation HAD NOTHING TO ORDER BY
-- ===========================================================================
--
-- WHAT WAS BROKEN. The same defect 0027 fixed on `crm.outbox`, in the one other table
-- that is written in bulk by a machine. `created_at` defaults to `now()`, which is the
-- TRANSACTION timestamp: the expiry sweep runs its whole pass in one transaction by
-- design (see `sweepExpiredStock`'s header — a failure anywhere must leave the night as
-- though it had not run), so a pass that opens obligations for three expired lots writes
-- three rows carrying the same `created_at` to the microsecond. Verified against the real
-- database before this migration was written: two inserts in one transaction, one
-- distinct `created_at`, same `xmin`.
--
-- The consequence was not a wrong answer but an absent one. Nothing in this table could
-- be ordered by write order at all, and the two places that had to:
--
--   * `crm.disposal_obligation_chain` (0030) sidestepped it by walking
--     `continues_obligation_id` recursively from the root — correct, and the reason the
--     audit read works today — but its fallback for a row reachable from no root was
--     `ORDER BY o.created_at, o.id`, which is `ORDER BY id` the moment two rows tie. A
--     uuid is not an ordering.
--   * `crm.open_disposal_obligations` (0020) orders by `due_by, display_name` and
--     stopped there. One rep with two lots expired on the same pass gets the same
--     `due_by` (both `discovered_on + grace_days`) and the same name, so the chase list
--     a rep is asked to clear came back in whatever order the plan produced — a
--     different order on two identical requests.
--
-- THE RULE, and it is 0027's verbatim: a sequence value is allocated at INSERT time, so
-- it records the order the INSERTs ran. `seq` is that order, and it is now the last term
-- of every ordering over this table.
--
-- WHAT THIS DOES NOT GUARANTEE is the same list 0027 wrote and worth repeating here
-- because the column invites the wrong reading. `nextval` is outside transaction control:
-- `seq` has GAPS (the sweep's `ON CONFLICT ... DO NOTHING` burns a value on every night
-- that re-sees a carton it already raised, which is most nights — so a gap here is the
-- NORMAL case and nothing may read `seq` as a count), and ACROSS transactions it is
-- allocation order rather than commit order. The order it buys is WITHIN a transaction,
-- which is exactly where this table had nothing.
--
-- WHY A UNIQUE INDEX HERE WHEN 0027 ARGUED AGAINST ONE. 0027 refused one on `crm.outbox`
-- for two reasons that both invert here. The outbox is a hot queue whose pending rows are
-- rewritten on every claim, retry and settle, so an extra index costs every insert; this
-- table takes one row per expired (rep, lot) and is read far more often than written.
-- And the outbox has exactly one writer, deliberately, so the only way to collide is to
-- write the column by hand — whereas this table is a regulated audit trail whose own
-- functions already reason about rows "written by hand" (0030's header, twice: a
-- hand-edited cycle, a row reachable from no root). Where a hand-edit is a contemplated
-- failure mode, making the guarantee structural is worth an index.
--
-- WHAT IS NOT CLOSED, and is a choice rather than an oversight: nothing asserts that a
-- continuation's `seq` exceeds that of the row it continues. For every row this schema
-- writes it holds for free — the predecessor must already exist to be referenced, so its
-- value was allocated first — and the backfill below cannot promise it for rows that
-- predate the column, so a CHECK would either be a lie about history or a migration
-- failure. `disposal_obligation_chain` does not depend on it: it walks the links and uses
-- `seq` only to order what the links cannot reach.

-- The backfill is a DML statement on an RLS-FORCEd table and this migration runs as
-- `crm_app` with no `app.current_tenant_id` set, so the policy would match nothing and
-- the UPDATE would report `UPDATE 0` on a table holding rows — leaving every historical
-- row NULL and the NOT NULL below as the only hint. 0027 verified this empirically and
-- the reasoning is unchanged: a backfill has to see the whole table by definition, so
-- FORCE is lifted and restored at the bottom of this part.
--
-- The runner wraps each migration in one transaction and this file opens none, so under a
-- deploy the lifted state is never committed. `scripts/setup-test-db.sh` pipes the file
-- through psql in autocommit, where it briefly is — acceptable only because that path
-- builds an empty database from nothing with no application connected to it.
ALTER TABLE crm.disposal_obligation NO FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.disposal_obligation ADD COLUMN seq bigint;

/*
 * The backfill order for rows that predate the column.
 *
 * `created_at` first, because it is the only thing the table recorded — and also the very
 * thing that does not discriminate, since the rows this migration exists for share it to
 * the microsecond. Their insert order was never written down anywhere, so it cannot be
 * recovered; it can only be CHOSEN. Two deliberate choices, in order:
 *
 *   1. a row that continues another sorts AFTER one that does not, at the same timestamp.
 *      This is the one tie with a right answer rather than a preference, and it is the
 *      analogue of 0027's "a create sorts before anything else": a continuation cannot
 *      legitimately precede the obligation it continues, because the row it names had to
 *      exist to be named.
 *   2. `id` last, so the result is a total order that is stable and reproducible instead
 *      of depending on the plan — the same reason 0027 ends on `id`, and with the same
 *      admission: a uuid is meaningless as an ordering, which is the point. Where the
 *      data cannot say, the backfill picks once and keeps picking the same way.
 *
 * Choice 1 is not a full topological sort of a chain written entirely within one
 * transaction, which this schema cannot produce (a continuation requires its predecessor
 * to be `resolved`, and resolution requires the holding at zero while a continuation
 * requires it above zero — the same (rep, lot) cannot be both in one pass). For a chain
 * assembled by hand inside one transaction the backfill may order a link wrongly, and
 * that is survivable for the reason 0030 built the chain the way it did: the walk reads
 * the links, not the clock, and `seq` is consulted only where no link exists.
 */
UPDATE crm.disposal_obligation o
   SET seq = ordered.rn
  FROM (
    SELECT id,
           row_number() OVER (
             ORDER BY created_at, (continues_obligation_id IS NOT NULL), id
           ) AS rn
      FROM crm.disposal_obligation
  ) AS ordered
 WHERE o.id = ordered.id;

CREATE SEQUENCE crm.disposal_obligation_seq_seq AS bigint
  OWNED BY crm.disposal_obligation.seq;

-- Starts above the backfilled values so a new row never collides with a historical one.
-- `is_called = false` makes the next `nextval` return exactly this number rather than the
-- one after it. COALESCE covers the empty table, the normal case on a fresh deploy.
SELECT setval('crm.disposal_obligation_seq_seq',
              COALESCE((SELECT max(seq) FROM crm.disposal_obligation), 0) + 1, false);

ALTER TABLE crm.disposal_obligation
  ALTER COLUMN seq SET DEFAULT nextval('crm.disposal_obligation_seq_seq');
ALTER TABLE crm.disposal_obligation ALTER COLUMN seq SET NOT NULL;

-- See the header for why this index exists where 0027 refused the same one.
CREATE UNIQUE INDEX uq_disposal_obligation_seq ON crm.disposal_obligation (seq);

ALTER TABLE crm.disposal_obligation FORCE ROW LEVEL SECURITY;

/**
 * Open obligations, oldest deadline first — 0020's chase list, now with a total order.
 *
 * Replaced for the ORDER BY alone; the signature and every column are 0020's, because
 * callers select them by name (`openObligations`, `teamObligations`).
 *
 * No index is added for the new term and none would help: `display_name` comes from a
 * join, so it sits in the middle of a sort key no single index can serve and the planner
 * sorts the result set either way. The tie-break is a comparison on a column the row has
 * already been fetched for.
 */
CREATE OR REPLACE FUNCTION crm.open_disposal_obligations(
  p_rep_profile_id uuid DEFAULT NULL,
  p_as_of          date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id                uuid,
  rep_profile_id    uuid,
  display_name      text,
  lot_id            uuid,
  erp_item_id       text,
  lot_number        text,
  material_kind     text,
  expired_on        date,
  discovered_on     date,
  due_by            date,
  days_overdue      integer,
  status            text,
  quantity_on_hand  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.rep_profile_id, rp.display_name, o.lot_id, l.erp_item_id::text, l.lot_number,
         l.material_kind, o.expired_on, o.discovered_on, o.due_by,
         (p_as_of - o.due_by)::integer, o.status,
         COALESCE(h.quantity_on_hand, 0)
    FROM crm.disposal_obligation o
    JOIN crm.rep_profile rp ON rp.id = o.rep_profile_id
    JOIN crm.sample_lot l ON l.id = o.lot_id
    LEFT JOIN crm.sample_holding h
           ON h.rep_profile_id = o.rep_profile_id AND h.lot_id = o.lot_id
   WHERE o.status IN ('open', 'overdue')
     AND (p_rep_profile_id IS NULL OR o.rep_profile_id = p_rep_profile_id)
   ORDER BY o.due_by, rp.display_name, o.seq;
$$;

/**
 * One (rep, lot)'s disposal history, oldest first — 0030's audit read, with `seq`.
 *
 * Two changes, both about the same thing. The walk still orders the chain, because the
 * links are what know which obligation came first and 0030's reasoning there is
 * unchanged. What changes is the fallback for a row the walk cannot reach — only possible
 * by hand, given `continues_obligation_id` is the sole way in — which was
 * `created_at, id` and is now `seq`: the insert order, where the old form degenerated to
 * uuid order the moment two rows shared a transaction.
 *
 * And `seq` is returned, so a reader can see the write order rather than infer it. That
 * is why this is a DROP and a CREATE: `CREATE OR REPLACE FUNCTION` cannot widen a
 * RETURNS TABLE. `disposalHistory` is the only caller and is updated with it.
 */
DROP FUNCTION crm.disposal_obligation_chain(uuid, uuid);

CREATE FUNCTION crm.disposal_obligation_chain(
  p_rep_profile_id uuid,
  p_lot_id         uuid
)
RETURNS TABLE (
  id                         uuid,
  seq                        bigint,
  sequence_number            integer,
  continues_obligation_id    uuid,
  quantity_at_discovery      numeric,
  expired_on                 date,
  discovered_on              date,
  due_by                     date,
  status                     text,
  resolved_on                date,
  resolution                 text,
  resolving_transaction_id   uuid,
  resolving_transaction_kind text,
  created_at                 timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk AS (
    SELECT r.id, 1 AS depth
      FROM crm.disposal_obligation r
     WHERE r.rep_profile_id = p_rep_profile_id
       AND r.lot_id = p_lot_id
       AND r.continues_obligation_id IS NULL
    UNION ALL
    SELECT n.id, w.depth + 1
      FROM crm.disposal_obligation n
      JOIN walk w ON n.continues_obligation_id = w.id
     WHERE n.rep_profile_id = p_rep_profile_id
       AND n.lot_id = p_lot_id
       AND w.depth < 10000
  )
  SELECT o.id,
         o.seq,
         COALESCE(w.depth, 0)::integer,
         o.continues_obligation_id,
         o.quantity_at_discovery,
         o.expired_on, o.discovered_on, o.due_by,
         o.status, o.resolved_on, o.resolution,
         o.resolving_transaction_id,
         -- The ledger's own word for what discharged it. `resolution` is 0020's
         -- vocabulary ('transferred'); this is the movement kind ('transfer_out'), which
         -- is what the custody log shows and therefore what an auditor matches against.
         t.kind::text,
         o.created_at
    FROM crm.disposal_obligation o
    LEFT JOIN walk w ON w.id = o.id
    LEFT JOIN crm.sample_transaction t ON t.id = o.resolving_transaction_id
   WHERE o.rep_profile_id = p_rep_profile_id
     AND o.lot_id = p_lot_id
   ORDER BY (w.depth IS NULL), w.depth, o.seq;
$$;

-- ===========================================================================
-- PART 2 — A DEAD LETTER KEPT ONLY ITS LATEST REASON
-- ===========================================================================
--
-- WHAT WAS BROKEN. 0022 gave `crm.outbox` a way back: an operator fixes the ERP-side
-- cause of a permanent refusal and revives the row, which re-sends the same payload with
-- `attempts` reset and `revive_count` incremented. `dead_reason` holds the latest cause
-- and is overwritten by the next death. So "died because the ledger account was missing,
-- somebody created it, died again because the period was locked" is indistinguishable
-- from "died twice because the ledger account is still missing" — and those are two
-- different conversations. The first says progress is being made and a third attempt is
-- worth having; the second says the revive button is being pressed instead of the cause
-- being fixed. 0022 recorded this against itself in so many words, and named where the
-- answer belongs: "a per-attempt history ... belongs in its own table rather than in more
-- columns here."
--
-- WHAT A ROW IS. One row per time this outbox row BECAME A DEAD LETTER — not per dispatch
-- attempt, which `crm.outbox.attempts` already counts and which would be a row per
-- transient 503. A death is the event that needs a reason, and the episode it closes (one
-- enqueue or revive, N dispatch attempts, one permanent refusal) is the unit an operator
-- reasons about. `attempt` numbers those episodes from 1; `dispatch_attempts` records how
-- many tries that episode consumed. Two different counts, deliberately two columns.
--
-- THE WRITER IS A TRIGGER, NOT THE RELAY. The alternative was a call in `markDead`, and
-- the trigger is better for the reason the sample balance is a trigger (ADR-0001 Q4):
-- there is then no path that records a death without recording its history. `markDead` is
-- the only writer today, and in this repo an operator fixing a row in psql is a
-- contemplated path (0023's first administrator is an INSERT by hand) — a death applied
-- that way is exactly the one somebody will later need explained. The trigger also means
-- the relay package needs no change to start keeping history, which matters while the
-- relay is being worked on for other reasons.
--
-- THE LINK TO crm.outbox CARRIES NO FOREIGN KEY, AND THAT IS THE WHOLE RETENTION ANSWER.
-- The precedent not to recreate is `crm.notification_delivery`, which 0021 gave
-- `ON DELETE CASCADE` from `crm.notification` — coherent at the time and now an open item
-- in ADR-0001, because it means the record of where a signal was pushed cannot be
-- retained for one day longer than the inbox copy of the signal. The ADR's own phrasing
-- of the fix is "the delivery rows [must] stop depending on the notification row", so this
-- table does not start by depending on one. `outbox_id` is a plain uuid with an index, and
-- the entity, operation, target id and producing row are COPIED here rather than joined,
-- so a history row still says what failed and what it was for after the outbox row it
-- describes is gone. A row that explains a deleted row is the only kind worth keeping.
--
-- The cost of that choice, stated rather than hidden: nothing prunes this table, and no
-- cascade will. What bounds it is the thing being counted — a row appears only when a
-- write is permanently refused, which ADR-0001 already says should alert at any value
-- above zero. An inbox grows with ordinary use and needed 0024's horizons; this grows only
-- with failure, so unbounded growth here is a paging condition before it is a disk
-- problem. A horizon of its own is the honest follow-up and is deliberately not invented
-- here: `crm.notification_policy` is where retention is configured, adding a third horizon
-- to it is a decision about what a tenant is promised, and a prune nobody asked for is how
-- a record of a regulated failure gets deleted by a default.
--
-- NEITHER REFERENCE IS ENFORCED, AND THE SECOND ONE IS THE INTERESTING CASE. `revived_by`
-- was first written as the usual `REFERENCES crm.rep_profile (id) ON DELETE RESTRICT` that
-- every rep reference in this schema is, on the reasoning that RESTRICT does the opposite
-- of a cascade — it refuses the deletion rather than following it. That reasoning is
-- wrong, and an existing suite proved it: `dead-letters.contract.test.ts` tears down by
-- deleting the rep profiles it created, and a history row naming one of them turned that
-- into `violates foreign key constraint`. The history had been handed a VETO over an
-- unrelated deletion. A record of what happened must not block an operation it has no
-- stake in, any more than it should be erased by one — so the same rule applies to both
-- columns of this table, for the same reason, and the id is stored without a constraint
-- behind it.
--
-- What that costs is small and what it keeps is not. `revived_by_name` is resolved by a
-- LEFT JOIN, so a reviver whose profile is gone reads as a recorded uuid beside a null
-- name — strictly more than `ON DELETE SET NULL` would have left, and strictly more than a
-- cascade. A rep profile is suspended rather than deleted in normal operation anyway
-- (README, "Roles"), so this governs the exceptional case only.

CREATE TABLE crm.outbox_dead_letter (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,

  -- Deliberately NOT a foreign key; see the header. Indexed below, because every read of
  -- this table is "the history of this one row".
  outbox_id         uuid NOT NULL,

  -- Which death this was for that outbox row, from 1. Allocated by the trigger as one
  -- past the highest already recorded, which is safe without any lock of its own: the
  -- trigger runs inside the UPDATE that killed the row, so that transaction holds the
  -- outbox row and no concurrent transaction can kill it a second time.
  attempt           integer NOT NULL CHECK (attempt >= 1),

  -- `crm.outbox.revive_count` as it stood when this death happened, so `attempt > 1`
  -- answers "did this follow a revive" and the PAIR answers something better. The two
  -- agree (`attempt = revive_count_at_death + 1`) for every death reached through
  -- `crm.revive_outbox_letter`. They disagree when a row was put back in the queue
  -- without it — a hand-written UPDATE — and a reader who needs to know whether the
  -- bookkeeping was done can see it rather than assume it. Recorded, not enforced: a
  -- CHECK tying them would make the history refuse to record the very event it is the
  -- only evidence of.
  revive_count_at_death integer NOT NULL CHECK (revive_count_at_death >= 0),

  -- How many dispatch attempts this episode consumed before it was given up on. Distinct
  -- from `attempt`; see the header.
  dispatch_attempts integer NOT NULL CHECK (dispatch_attempts >= 0),

  died_at           timestamptz NOT NULL,

  -- Nullable, because `crm.outbox.dead_reason` is. Every death the relay records carries
  -- one; a death applied by hand may not, and the 0030 discipline applies — an actor or a
  -- reason nobody wrote down is left honestly null rather than reconstructed.
  reason            text CHECK (reason IS NULL OR length(reason) <= 2000),

  -- Copied, not joined. The reason is in the header: this row has to stay legible after
  -- the outbox row is deleted, and `entity`/`operation`/`target_record_id` are what make
  -- "a create Expense for ERP record X" readable at all.
  entity            text NOT NULL,
  operation         text NOT NULL,
  target_record_id  crm.erp_record_id NOT NULL,
  source_table      text NOT NULL,
  source_id         uuid NOT NULL,

  -- How the episode ENDED, stamped when the row leaves `dead`. Recorded at the revive
  -- rather than inferred at the next death, because a revive that WORKS is the outcome
  -- worth seeing and it produces no next death to infer from.
  revived_at        timestamptz,
  -- Unenforced, like `outbox_id` and for the same reason; see the header.
  revived_by        uuid,

  -- An actor implies a time, a time does not imply an actor. Not phrased as an
  -- equivalence: a row can leave `dead` without the revive bookkeeping, and then the
  -- moment is known and the person is not.
  CONSTRAINT outbox_dead_letter_revive_pair
    CHECK (revived_by IS NULL OR revived_at IS NOT NULL)
);

-- The ordering key, and the reason this table needs no `seq` of its own despite Part 1.
-- `(outbox_id, attempt)` is declared rather than temporal, so it orders correctly however
-- many rows share a transaction — which is the general lesson of Part 1 rather than an
-- exception to it. It is UNIQUE because a second row claiming to be the same episode is a
-- corrupted history, and refusing it is better than serving it.
CREATE UNIQUE INDEX uq_outbox_dead_letter_attempt
  ON crm.outbox_dead_letter (outbox_id, attempt);

-- Tenant-scoped reads: "what has died for this tenant lately", ordered by when.
CREATE INDEX idx_outbox_dead_letter_tenant
  ON crm.outbox_dead_letter (tenant_id, died_at DESC);

-- Who has been reviving, over a period — the review the header's two-conversations
-- distinction exists to support.
CREATE INDEX idx_outbox_dead_letter_revived_by
  ON crm.outbox_dead_letter (tenant_id, revived_by, revived_at)
  WHERE revived_by IS NOT NULL;

SELECT crm.apply_tenant_isolation('crm.outbox_dead_letter');

/**
 * Records a death, and closes the episode when the row is revived.
 *
 * SECURITY INVOKER (the default, asserted by `schema.contract.test.ts`), so the INSERT is
 * subject to the same policy as the UPDATE that fired it. That is the fail-closed
 * reading and it has a consequence worth knowing: a death applied with no
 * `app.current_tenant_id` set is REFUSED by RLS and takes the UPDATE down with it, rather
 * than silently recording nothing. `markDead` runs inside `withTenantContext`, so the
 * only way to meet that is to bypass the application's own wrapper.
 *
 * Fires `AFTER UPDATE OF state`, so it is reached by exactly the four writers that touch
 * the column and matched by neither for the three that are not a death or a revive: a
 * claim (pending -> in_flight), a retry (in_flight -> pending) and a delivery
 * (in_flight -> delivered) all fall through both branches.
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

  ELSIF OLD.state = 'dead' AND NEW.state <> 'dead' THEN
    -- The open episode is the highest-numbered one, and `revived_at IS NULL` keeps a
    -- second pass from overwriting a revive already recorded.
    --
    -- `revived_by` is taken only when `revive_count` actually moved. On the hand-written
    -- path that puts a row back in the queue without `crm.revive_outbox_letter`,
    -- `NEW.revived_by` still holds the PREVIOUS revive's actor, and copying it would
    -- attribute this one to somebody who had nothing to do with it. The moment is known,
    -- the person is not, and the column says so.
    UPDATE crm.outbox_dead_letter d
       SET revived_at = COALESCE(NEW.revived_at, now()),
           revived_by = CASE WHEN NEW.revive_count > OLD.revive_count THEN NEW.revived_by END
     WHERE d.outbox_id = NEW.id
       AND d.revived_at IS NULL
       AND d.attempt = (SELECT max(attempt) FROM crm.outbox_dead_letter WHERE outbox_id = NEW.id);
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER trg_outbox_dead_letter
  AFTER UPDATE OF state ON crm.outbox
  FOR EACH ROW EXECUTE FUNCTION crm.outbox_dead_letter_record();

/**
 * One outbox row's death history, oldest first.
 *
 * In SQL rather than only in the relay for the reason `crm.dead_outbox_letters` is: the
 * ordering key is a property of the table, and a caller that reconstructed it would
 * eventually reconstruct it differently.
 *
 * `is_repeat_of_previous` is the question the whole table exists to answer, computed where
 * the rows are: true when this death's reason is byte-identical to the previous episode's.
 * Byte-identical and not "the same kind of failure", because the kind is not stored —
 * `classify`'s verdict (`permanent_refusal`, `retry_ordering`, …) lives in the relay and
 * is thrown away once it has chosen a state. So a reason that embeds a differing record id
 * reads as a different cause when an operator would call it the same one. That is a
 * conservative direction to be wrong in — it under-claims repetition rather than
 * asserting it — and closing it means persisting the classification, which is a change to
 * the relay's writer and not to this table.
 */
CREATE OR REPLACE FUNCTION crm.outbox_dead_letter_history(p_outbox_id uuid)
RETURNS TABLE (
  id                    uuid,
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
  SELECT d.id, d.outbox_id, d.attempt, d.revive_count_at_death, d.dispatch_attempts,
         d.died_at, d.reason, d.entity, d.operation, d.target_record_id::text,
         d.source_table, d.source_id,
         d.revived_at, d.revived_by, rp.display_name,
         d.reason IS NOT NULL
           AND d.reason IS NOT DISTINCT FROM
               lag(d.reason) OVER (PARTITION BY d.outbox_id ORDER BY d.attempt)
    FROM crm.outbox_dead_letter d
    LEFT JOIN crm.rep_profile rp ON rp.id = d.revived_by
   WHERE d.outbox_id = p_outbox_id
   ORDER BY d.attempt;
$$;
