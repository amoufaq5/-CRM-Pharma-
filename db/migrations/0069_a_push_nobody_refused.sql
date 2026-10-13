-- A push nobody refused is not dead, and the retention policy has to be able to reach it.
--
-- ADR-0001's open row, in its own words: "`crm.notification_delivery`'s prune keys on
-- `unsettled = (state <> 'delivered')`, which is true of the terminal `dead`, so a delivery
-- settled `dead` is never pruned at any horizon and pins its notification too. For a real failed
-- push that is arguably correct — it is evidence of a disclosure that did not happen — but
-- `settleOrphanedDeliveries` mints them deliberately, so the set grows without bound and the
-- retention policy quietly does not apply to it."
--
-- The row is right and 0068 already wrote the answer for the other table. `dead` means A
-- DESTINATION REFUSED US: it is the state `last_error` and `last_status` account for, the state a
-- dead-delivery listing would offer somebody, and the state 0046 holds back forever because it is
-- the evidence of a disclosure that did not happen. An ORPHANED delivery was refused by nobody.
-- Its notification has been deleted, so the payload cannot be rebuilt, or its endpoint has, so
-- the secret it names cannot be read; either way nothing was attempted and nothing can be. That
-- is 0068's `abandoned` exactly — "settled, definitively, by the thing it was for ceasing to
-- exist" — and 0068 built the state on this very table.
--
-- WHAT FOLLOWS FROM USING IT, which is the whole of the fix:
--
--   * `crm.notification_prune_candidates.delivery_unsettled` is already an allow-list that omits
--     `abandoned` (0068 §5), so an abandoned delivery stops pinning its notification the moment
--     the state changes — no edit needed here, which is what a state earning its keep looks like.
--   * `crm.notification_delivery_prune_candidates.unsettled` is NOT an allow-list; it is
--     `state <> 'delivered'`, so it swept `abandoned` up with the unsettled. Part 2 makes it the
--     same allow-list, and `retain_delivery_days` then applies to these rows like any other.
--   * A real refusal is untouched. `dead` is still held back at every horizon, which is the part
--     the open row called "arguably correct" and this migration deliberately does not change.
--
-- WHY THE SETTLE MOVES INTO SQL. It was one UPDATE inside `settleOrphanedDeliveries` in
-- `@crm/notify`, and `abandoned` cannot be written by one assignment: the state, `abandoned_at`
-- and `abandoned_reason` are bound together by two CHECKs (0068), and the reason has a length
-- floor. 0068 put `crm.abandon_stopped_tenant_work` in the database for that reason and this is
-- the second instance of it — the predicate that defines an orphan is already written in SQL
-- twice (`claimDue`'s two EXISTS terms and the prune view's `orphaned`), so a third copy in
-- TypeScript was the drift waiting to happen. The TypeScript function stays as the caller, so
-- `DispatchResult.orphaned` still counts them and the dispatcher's ordering is unchanged.
--
-- WHY NOT A TRIGGER THAT REFUSES `dead` FOR AN ORPHAN, which is where this repository's instinct
-- points and would be wrong here. A row can become an orphan AFTER a genuine refusal: a push is
-- claimed, the destination answers 4xx, and an endpoint deleted by hand in the meantime would
-- make `markDead` refuse — losing the one thing worth keeping, the destination's own answer, and
-- leaving the row to be abandoned on the next tick as though nobody had ever replied. The guard
-- would protect a rule by destroying the evidence the rule exists for. So the invariant is
-- carried by there being exactly ONE statement that settles an orphan, in the database, beside
-- the constraints that define the state.

-- ---------------------------------------------------------------------------
-- 1. The settle.
-- ---------------------------------------------------------------------------
/**
 * Abandons every unsendable delivery for one tenant: the ones whose notification or whose
 * endpoint no longer exists.
 *
 * SECURITY INVOKER, called inside `withTenantContext`, with the tenant predicate written out as
 * well as enforced by RLS — 0043's rule, and 0068's shape.
 *
 * THE TWO ORPHAN KINDS KEEP THEIR OWN SENTENCES, as they did when this was `dead` with a
 * `last_error`: a missing notification means the payload cannot be rebuilt (0046 deliberately
 * copies no `subject`, `body` or `payload`), where a missing endpoint means `secret_env` cannot be
 * read (0048 deliberately does not copy it, because rotating which variable an endpoint reads is a
 * legitimate change that must not be frozen per delivery). Both carry a prefix, so one query
 * groups a deployment's abandonments by cause across both tables — `tenant-deleted:` from 0068,
 * `orphaned-notification:` and `orphaned-endpoint:` from here.
 *
 * IDEMPOTENT: it touches only `pending` and `in_flight`. A `dead` row is left alone on purpose —
 * it has its own account of itself, written when a destination refused it, and relabelling that
 * as an orphan would erase the reason somebody may need. A `delivered` row is left alone because
 * the disclosure already happened; the parent going away afterwards does not unsend it.
 *
 * `last_error` IS NOT WRITTEN AND NOT CLEARED. It means "what the destination said", and this
 * function has not spoken to a destination; a row that retried twice before its parent vanished
 * keeps that history beside its abandonment.
 */
CREATE OR REPLACE FUNCTION crm.abandon_orphaned_deliveries(p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := 0;
BEGIN
  WITH settled AS (
    UPDATE crm.notification_delivery d
       SET state = 'abandoned',
           abandoned_at = now(),
           abandoned_reason =
             CASE
               WHEN NOT EXISTS (SELECT 1 FROM crm.notification x
                                 WHERE x.tenant_id = d.tenant_id AND x.id = d.notification_id)
               THEN 'orphaned-notification: the notification this push describes no longer '
                    || 'exists, so its payload cannot be rebuilt. Nobody refused this push and '
                    || 'nobody can make it. Settled by crm.abandon_orphaned_deliveries.'
               ELSE 'orphaned-endpoint: the endpoint this push was addressed to no longer '
                    || 'exists, so the secret it names cannot be read. Nobody refused this push '
                    || 'and nobody can make it. Settled by crm.abandon_orphaned_deliveries.'
             END
     WHERE d.tenant_id = p_tenant_id
       AND d.state IN ('pending', 'in_flight')
       AND (NOT EXISTS (SELECT 1 FROM crm.notification x
                         WHERE x.tenant_id = d.tenant_id AND x.id = d.notification_id)
            OR NOT EXISTS (SELECT 1 FROM crm.notification_endpoint e
                            WHERE e.tenant_id = d.tenant_id AND e.id = d.endpoint_id))
    RETURNING 1
  ) SELECT count(*) INTO n FROM settled;

  RETURN n;
END
$$;

COMMENT ON FUNCTION crm.abandon_orphaned_deliveries(uuid) IS
  'Abandons deliveries whose notification or endpoint is gone. `abandoned` and not `dead`: `dead` means a destination refused us, and nothing refused these.';

-- ---------------------------------------------------------------------------
-- 2. The prune's allow-list, so retention reaches an abandoned row.
-- ---------------------------------------------------------------------------
--
-- REPRODUCED FROM 0046 VERBATIM apart from the `unsettled` expression, and that discipline is not
-- optional: `CREATE OR REPLACE VIEW` replaces the whole definition, so a replacement rebuilt from
-- memory silently reverts whatever a later migration amended. 0043's header records a function
-- reverted exactly that way. Nothing has amended this view since 0046 — checked, not assumed.
--
-- `(state <> 'delivered')` BECOMES A THREE-STATE LIST, which is a widening of what prunes rather
-- than a narrowing of what is kept:
--
--   * `pending` and `in_flight` — the push has not finished. Unchanged.
--   * `dead` — held back forever. Unchanged, and the reason is 0046's: a permanently failed push
--     is an unresolved operational fact and the most valuable row in this table.
--   * `abandoned` — SETTLED, and now prunable at `retain_delivery_days` like a delivered push.
--     Nobody is waiting for it and nobody can act on it, so holding it back forever would be
--     holding back a row that will never become interesting. This is the unboundedness the open
--     row named: the orphan settle minted these deliberately, so the one state the retention
--     policy could not reach was the one the system produced on its own schedule.
--   * `delivered` — prunable. Unchanged.
--
-- The column keeps its name. `unsettled` is still exactly what it says — these four states split
-- into settled and not — and renaming it would be a rename of a column every caller in
-- `retention.ts` reads, to say the same thing.
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
         (d.state IN ('pending', 'in_flight', 'dead')) AS unsettled,
         NOT EXISTS (SELECT 1 FROM crm.notification n
                      WHERE n.tenant_id = d.tenant_id
                        AND n.id = d.notification_id) AS orphaned
    FROM crm.notification_delivery d;

-- ---------------------------------------------------------------------------
-- 3. The terminal trigger's message, which asserted the only cause there was.
-- ---------------------------------------------------------------------------
--
-- 0068 wrote "was abandoned because the ERP deleted its tenant … there is no retry for a write to
-- a schema that no longer exists", which was true of every abandoned row in existence when it was
-- written and is now true of some of them. The rule it enforces has not changed — there is no
-- transition out of `abandoned` — so the message stops asserting a cause and QUOTES THE ROW'S
-- OWN, which is the column 0068 added for exactly this and made NOT NULL for an abandoned row.
--
-- REPRODUCED IN FULL rather than amended in place, for the `CREATE OR REPLACE FUNCTION` reason
-- above. The trigger definitions are unchanged and are not re-created.
CREATE OR REPLACE FUNCTION crm.abandoned_is_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'abandoned' AND NEW.state <> 'abandoned' THEN
    RAISE EXCEPTION
      'abandoned-is-terminal: %.% cannot become % — it was abandoned, which means the thing it was for has ceased to exist and there is nothing left to retry: %',
      TG_TABLE_NAME, OLD.id, NEW.state, left(OLD.abandoned_reason, 200)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION crm.abandoned_is_terminal() IS
  'Refuses any transition out of `abandoned`, on either table, quoting the row''s own reason rather than asserting a cause — there are two of them now (a deleted tenant, 0068; an orphaned push, 0069).';

COMMENT ON COLUMN crm.notification_delivery.abandoned_reason IS
  'Why nobody will ever send this: a deleted tenant (`tenant-deleted:`, 0068) or a vanished parent (`orphaned-notification:`/`orphaned-endpoint:`, 0069). Its own column rather than `last_error`, which means what a DESTINATION said — and none of these reached one.';

-- ---------------------------------------------------------------------------
-- 4. The rows the old code already mislabelled.
-- ---------------------------------------------------------------------------
--
-- EXPECTED TO MOVE NOTHING, and written anyway because "expected" is not "checked". The orphan
-- path needs a hand-written DELETE of a live parent to reach — the prune itself cannot, since an
-- unsettled delivery holds its notification back — so a deployed database should hold none of
-- these. If one does, it is a `dead` row that the retention policy can never reach, which is the
-- defect this file closes, and leaving it would close the defect for future rows only.
--
-- MATCHED ON THE EXACT SENTENCES the old statement wrote, both of them, because they came from
-- one `CASE` in one statement and nothing else in the schema produces them. Matching on a message
-- is fragile in general; matching on a message THIS CODEBASE WROTE, in full, is deterministic.
--
-- `abandoned_at` IS `now()` AND SAYS SO. The old rows carry no settle timestamp — `delivered_at`
-- is for a delivery that happened — so the honest options are "when the migration ran" with the
-- fact recorded in the reason, or an invented time. `last_error` is deliberately LEFT IN PLACE:
-- it is the original account of the row, and this migration is relabelling a state, not rewriting
-- a history.
--
-- FORCE IS LIFTED AROUND IT. This runs as `crm_app`, which OWNS the table — and the table is
-- FORCE ROW LEVEL SECURITY, so the owner is subject to its policy like anybody else. With no
-- tenant context the policy yields nothing, the UPDATE would touch zero rows, and it would report
-- success: 0032's exact failure, which is also why this is a bare UPDATE and not a validated
-- CHECK (0039's asymmetry — a CHECK's scan is sighted and would refuse a correct database).
ALTER TABLE crm.notification_delivery NO FORCE ROW LEVEL SECURITY;

UPDATE crm.notification_delivery d
   SET state = 'abandoned',
       abandoned_at = now(),
       abandoned_reason =
         CASE
           WHEN d.last_error LIKE 'the notification this push describes%'
           THEN 'orphaned-notification: the notification this push describes no longer exists, '
                || 'so its payload cannot be rebuilt. Relabelled from `dead` by migration 0069, '
                || 'which is why this timestamp is the migration''s and not the settle''s; '
                || '`last_error` holds the original account.'
           ELSE 'orphaned-endpoint: the endpoint this push was addressed to no longer exists, '
                || 'so the secret it names cannot be read. Relabelled from `dead` by migration '
                || '0069, which is why this timestamp is the migration''s and not the settle''s; '
                || '`last_error` holds the original account.'
         END
 WHERE d.state = 'dead'
   AND d.last_error IN (
     'the notification this push describes no longer exists, so its payload cannot be rebuilt — recorded as undeliverable',
     'the endpoint this push was addressed to no longer exists, so the secret it names cannot be read — recorded as undeliverable'
   );

ALTER TABLE crm.notification_delivery FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. The read side, or the state above says less than the row knows.
-- ---------------------------------------------------------------------------
--
-- `abandoned` lands with a null `last_error` and a null `last_status`, deliberately — nothing
-- spoke to a destination — and both history functions return exactly those two columns as the
-- account of a push that did not arrive. So a reader would see `abandoned` beside two blanks and
-- learn nothing, which is the shape of defect this migration's own increment exists to stop: a
-- report that says less than the row knows. `abandoned_reason` is where the account went, so the
-- functions return it.
--
-- `abandoned_at` COMES TOO. It is not derivable from anything else on the row — `created_at` is
-- the enqueue, `delivered_at` is null by definition here — so without it the history can say a
-- push was abandoned and not when, which is the one question an operator reading a settled row
-- asks next.
--
-- DROP and CREATE, not CREATE OR REPLACE: the return type changes and Postgres refuses to replace
-- a function whose OUT parameters differ. The bodies are the LIVE ones, read out of `pg_proc`
-- rather than copied from the file that last wrote them (0048 for the copies, 0065 for
-- `to_address`) — the newest definition of a function several migrations have touched is not in
-- the file that created it, which this repository has now learned three times.
DROP FUNCTION crm.notification_delivery_history(uuid);
CREATE FUNCTION crm.notification_delivery_history(p_notification_id uuid)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
  to_address               text,
  notification_kind        text,
  notification_severity    text,
  notification_created_at  timestamptz,
  recipient_rep_profile_id uuid,
  recipient_display_name   text,
  state                    text,
  attempts                 integer,
  last_status              integer,
  last_error               text,
  abandoned_at             timestamptz,
  abandoned_reason         text,
  delivered_at             timestamptz,
  created_at               timestamptz,
  notification_present     boolean,
  endpoint_present         boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         -- 0048: COPIED, not joined. 0046's reason for joining was that the endpoint is
         -- still readable from a live row — which stopped being true the moment this row
         -- could outlive it.
         d.endpoint_channel, d.endpoint_url,
         -- 0065: and the mailbox, for the channel whose url is not a destination.
         d.to_address,
         d.notification_kind, d.notification_severity, d.notification_created_at,
         d.recipient_rep_profile_id, rp.display_name,
         d.state, d.attempts, d.last_status, d.last_error,
         -- 0069: and the account of a push nobody refused, which `last_error` is not for.
         d.abandoned_at, d.abandoned_reason,
         d.delivered_at, d.created_at,
         EXISTS (SELECT 1 FROM crm.notification n
                  WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id),
         EXISTS (SELECT 1 FROM crm.notification_endpoint e
                  WHERE e.tenant_id = d.tenant_id AND e.id = d.endpoint_id)
    FROM crm.notification_delivery d
    LEFT JOIN crm.rep_profile rp
           ON rp.tenant_id = d.tenant_id AND rp.id = d.recipient_rep_profile_id
   WHERE d.notification_id = p_notification_id
   ORDER BY d.seq;
$$;

DROP FUNCTION crm.notification_delivery_recent(integer);
CREATE FUNCTION crm.notification_delivery_recent(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
  to_address               text,
  notification_kind        text,
  notification_severity    text,
  notification_created_at  timestamptz,
  recipient_rep_profile_id uuid,
  recipient_display_name   text,
  state                    text,
  attempts                 integer,
  last_status              integer,
  last_error               text,
  abandoned_at             timestamptz,
  abandoned_reason         text,
  delivered_at             timestamptz,
  created_at               timestamptz,
  notification_present     boolean,
  endpoint_present         boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         d.endpoint_channel, d.endpoint_url, d.to_address,
         d.notification_kind, d.notification_severity, d.notification_created_at,
         d.recipient_rep_profile_id, rp.display_name,
         d.state, d.attempts, d.last_status, d.last_error,
         d.abandoned_at, d.abandoned_reason,
         d.delivered_at, d.created_at,
         EXISTS (SELECT 1 FROM crm.notification n
                  WHERE n.tenant_id = d.tenant_id AND n.id = d.notification_id),
         EXISTS (SELECT 1 FROM crm.notification_endpoint e
                  WHERE e.tenant_id = d.tenant_id AND e.id = d.endpoint_id)
    FROM crm.notification_delivery d
    LEFT JOIN crm.rep_profile rp
           ON rp.tenant_id = d.tenant_id AND rp.id = d.recipient_rep_profile_id
   ORDER BY d.seq DESC
   LIMIT greatest(1, least(p_limit, 500));
$$;
