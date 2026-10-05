-- 0027_outbox_sequence.sql
--
-- A deterministic order for two outbox rows enqueued in ONE transaction.
--
-- WHAT WAS BROKEN. `crm.outbox.created_at` defaults to `now()`, which is the TRANSACTION
-- timestamp, not the statement's. A producer that commits a create and a transition on the
-- same record in one transaction — which is the normal shape here, since the whole point of
-- the outbox is that the CRM write and its ERP intent commit together — writes two rows
-- carrying the same `created_at` to the microsecond. The relay's claim then ordered by
-- `next_attempt_at, created_at`, so the tie was broken by whatever the planner felt like:
-- roughly half the time the transition was dispatched before the create it acts on. The ERP
-- answered 404, the classifier read that as `retry_ordering`, and the row waited out a
-- backoff curve for a sibling that was sitting in the same batch. Recorded in ADR-0001 as a
-- latent inefficiency rather than a defect, and found by a test that assumed a sequence the
-- table did not have.
--
-- THE RULE. A sequence value is allocated at INSERT time, so it records the order the
-- INSERTs ran. The relay claims by `(next_attempt_at, seq)`, and two rows enqueued one
-- after the other inside one transaction are now dispatched in that order.
--
-- WHAT THIS DOES NOT GUARANTEE, because the distinction is the whole value of the change.
-- `nextval` is deliberately outside transaction control: it does not roll back, it is not
-- serialised against other transactions, and a cached or abandoned value is simply gone.
-- So:
--
--   * `seq` has GAPS. A rolled-back enqueue consumes a value permanently. A claimer never
--     sees a contiguous run and must never infer "I am missing row N" from one.
--   * ACROSS transactions, `seq` is allocation order, not commit order. Transaction A can
--     take seq 10, transaction B take seq 11 and commit first, and the relay can claim and
--     dispatch 11 while 10 is still uncommitted and therefore invisible. A later drain then
--     claims 10 — a lower sequence value processed after a higher one.
--
-- So the total order this buys is WITHIN a transaction, which is exactly where the bug was:
-- related rows are enqueued together by one producer. It buys nothing across concurrent
-- enqueues, and nothing here pretends otherwise. The relay's `retry_ordering`
-- classification stays, untouched, as the backstop for that case: a transition that reaches
-- the ERP before its create still gets a 404 and still waits. Trading a tested safety net
-- for an assumption about commit order would be a worse system than the one being fixed.

-- The backfill below is a DML statement on an RLS-FORCEd table, and this migration runs as
-- `crm_app` with no `app.current_tenant_id` set — so the policy would match nothing and the
-- UPDATE would quietly touch zero rows, leaving every existing row NULL and the NOT NULL
-- below as the only hint that anything went wrong. Verified empirically: without the line
-- below, the UPDATE reports `UPDATE 0` on a table holding rows. A backfill has to see the
-- whole table by definition, so FORCE is lifted and restored at the bottom of this file.
--
-- The runner wraps each migration in one transaction and no migration here opens its own,
-- so under a deploy the lifted state is never committed. `scripts/setup-test-db.sh` pipes
-- the file through psql in autocommit, where it briefly is — acceptable only because that
-- path builds an empty database from nothing, with no application connected to it.
ALTER TABLE crm.outbox NO FORCE ROW LEVEL SECURITY;

ALTER TABLE crm.outbox ADD COLUMN seq bigint;

/*
 * The backfill order for rows that predate the column.
 *
 * `created_at` is the obvious key and it is used first, but it is also the very thing that
 * does not discriminate: the pairs this migration exists for share it to the microsecond.
 * Their enqueue order was never recorded anywhere in the table, so it cannot be recovered —
 * only CHOSEN. Two deliberate choices, in order:
 *
 *   1. a `create` sorts before anything else at the same timestamp. This is the one tie
 *      that has a right answer rather than a preference: nothing can transition or update a
 *      record that was never created, so a create can never legitimately come second.
 *   2. `id` last, so the result is a total order that is stable and reproducible instead of
 *      depending on the plan. A uuid is meaningless as an ordering, which is the point —
 *      where the data cannot say, the backfill picks once and keeps picking the same way.
 *
 * Choice 1 can still be wrong for a pair it cannot reason about (two transitions on one
 * record enqueued together, say), and that is survivable for the same reason the whole
 * design is: the relay retries an out-of-order transition. It is not survivable to leave
 * the column NULL.
 */
UPDATE crm.outbox o
   SET seq = ordered.rn
  FROM (
    SELECT id,
           row_number() OVER (
             ORDER BY created_at, (operation <> 'create'), id
           ) AS rn
      FROM crm.outbox
  ) AS ordered
 WHERE o.id = ordered.id;

CREATE SEQUENCE crm.outbox_seq_seq AS bigint OWNED BY crm.outbox.seq;

-- Starts above the backfilled values so a new row never collides with a historical one.
-- `is_called = false` makes the next `nextval` return exactly this number rather than the
-- one after it. COALESCE covers the empty table, which is the normal case on a fresh deploy.
SELECT setval('crm.outbox_seq_seq', COALESCE((SELECT max(seq) FROM crm.outbox), 0) + 1, false);

ALTER TABLE crm.outbox ALTER COLUMN seq SET DEFAULT nextval('crm.outbox_seq_seq');
ALTER TABLE crm.outbox ALTER COLUMN seq SET NOT NULL;

-- No UNIQUE on `seq`: the sequence is the uniqueness guarantee, and the only way to defeat
-- it is to write the column explicitly, which `enqueueOutbox` — the single writer of this
-- table, deliberately — does not do. An extra unique index on a hot queue table would cost
-- every insert for a case that cannot arise without a second writer, and a second writer is
-- the thing already ruled out.

ALTER TABLE crm.outbox FORCE ROW LEVEL SECURITY;

-- The claim index, extended to cover the new tie-breaker so the ORDER BY is served by the
-- index rather than by a sort of every due row. `idx_outbox_due` (0004) is a strict prefix
-- of this one and is therefore dead weight on a table whose pending rows are written on
-- every claim, retry and settle — so it goes rather than being maintained alongside.
CREATE INDEX idx_outbox_due_seq ON crm.outbox (tenant_id, next_attempt_at, seq)
  WHERE state IN ('pending', 'in_flight');
DROP INDEX crm.idx_outbox_due;
