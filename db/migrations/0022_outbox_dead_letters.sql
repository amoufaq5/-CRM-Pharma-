-- 0022_outbox_dead_letters.sql
--
-- A write that will never reach the ERP, and the two things missing around it: telling
-- the person who made it, and a way back.
--
-- THE GAP. A rep records something, it commits to crm.* and appends to crm.outbox in one
-- transaction, and the relay drives it to the ERP. When the ERP refuses permanently — a
-- 403, a 404 on a transition, an unbalanced journal entry — the row goes to `dead` and
-- that is the end of it. Nobody is told. The rep's app showed the write as recorded,
-- because in the CRM it IS recorded; what failed is the half they cannot see. They find
-- out when someone eventually reconciles, which in a pharma field force means at month
-- end, about an expense claim from three weeks ago.
--
-- Two additions, both small, both overdue:
--
--   1. a dead letter raises a notification — to the rep, and up the hierarchy, because a
--      permanently failed write is usually not something the rep can fix alone;
--   2. a dead letter can be REVIVED. Several of the classifier's dead outcomes are
--      conditions someone fixes on the ERP side — a missing ledger account, a permission
--      not yet granted, a parent record that did not exist when the transition arrived.
--      Once fixed, the queued intent is still valid and should go again.

-- Revive bookkeeping. Kept on the row rather than in a separate log: what matters
-- operationally is "has this been tried again, how often, and who said so", and a row that
-- has died twice reads differently from one that has died once.
ALTER TABLE crm.outbox ADD COLUMN revive_count integer NOT NULL DEFAULT 0
  CHECK (revive_count >= 0);
ALTER TABLE crm.outbox ADD COLUMN revived_at timestamptz;
ALTER TABLE crm.outbox ADD COLUMN revived_by uuid REFERENCES crm.rep_profile (id) ON DELETE RESTRICT;

-- Note what is NOT kept: a per-attempt history of why it died each time. `dead_reason`
-- holds the latest, and `revive_count` says it is not the first — enough to decide whether
-- to try again or escalate, and short of a full audit trail. If one is ever needed it
-- belongs in its own table rather than in more columns here.

ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full', 'expiry_sweep',
                 'notify_dispatch'));

-- ---------------------------------------------------------------------------

/**
 * Whose write was it?
 *
 * An outbox row records the CRM aggregate that produced it as `source_table` +
 * `source_id`, which was enough for support and is not enough to tell someone. This maps
 * that pair back to a rep.
 *
 * Enumerated rather than clever: every table listed here has been checked to carry a
 * `rep_profile_id` meaning "the rep this belongs to". A source table that is not listed
 * returns NULL, and the caller treats that as "cannot attribute" rather than guessing —
 * the same discipline as the disposal sweep's unattributed count. Adding a producer means
 * adding a branch, which is a visible act in a diff.
 */
CREATE OR REPLACE FUNCTION crm.outbox_recipient(p_source_table text, p_source_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  found uuid;
BEGIN
  CASE p_source_table
    WHEN 'crm.sample_transaction' THEN
      SELECT rep_profile_id INTO found FROM crm.sample_transaction WHERE id = p_source_id;
    WHEN 'crm.visit' THEN
      SELECT rep_profile_id INTO found FROM crm.visit WHERE id = p_source_id;
    WHEN 'crm.expense_claim' THEN
      SELECT rep_profile_id INTO found FROM crm.expense_claim WHERE id = p_source_id;
    ELSE
      RETURN NULL;
  END CASE;
  RETURN found;
END
$$;

/**
 * Dead letters, with enough context to act on without a join by hand.
 *
 * `rep_profile_id` is resolved through the function above, so a row whose producer is not
 * mapped still appears — with a null rep. Leaving it out would hide exactly the case that
 * needs attention, since nobody was notified about it either.
 */
CREATE OR REPLACE FUNCTION crm.dead_outbox_letters(
  p_rep_profile_id uuid DEFAULT NULL,
  p_limit          integer DEFAULT 100
)
RETURNS TABLE (
  id              uuid,
  entity          text,
  operation       text,
  target_record_id text,
  source_table    text,
  source_id       uuid,
  rep_profile_id  uuid,
  display_name    text,
  attempts        integer,
  revive_count    integer,
  dead_at         timestamptz,
  dead_reason     text,
  created_at      timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.entity, o.operation, o.target_record_id::text, o.source_table, o.source_id,
         r.rep_profile_id, rp.display_name,
         o.attempts, o.revive_count, o.dead_at, o.dead_reason, o.created_at
    FROM crm.outbox o
    CROSS JOIN LATERAL (SELECT crm.outbox_recipient(o.source_table, o.source_id) AS rep_profile_id) r
    LEFT JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
   WHERE o.state = 'dead'
     AND (p_rep_profile_id IS NULL OR r.rep_profile_id = p_rep_profile_id)
   ORDER BY o.dead_at DESC NULLS LAST
   LIMIT greatest(1, least(p_limit, 500));
$$;

/**
 * Puts a dead letter back in the queue.
 *
 * Attempts reset to zero and `next_attempt_at` to now, because the point of a revive is
 * that the condition which killed it has been fixed — carrying the old attempt count would
 * dead-letter it again after one or two tries.
 *
 * `dead_reason` is deliberately NOT cleared: it is why this row is interesting, and a
 * revive that fails again should read as "died, tried again, died again" rather than as a
 * fresh failure. `revive_count` is what the notification's dedup key uses to decide that a
 * second death is news.
 *
 * Returns false when the row is not dead — reviving a live row would reset its attempts and
 * could duplicate an in-flight ERP call.
 */
CREATE OR REPLACE FUNCTION crm.revive_outbox_letter(
  p_id         uuid,
  p_revived_by uuid,
  p_now        timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql AS $$
  WITH updated AS (
    UPDATE crm.outbox
       SET state = 'pending',
           attempts = 0,
           next_attempt_at = p_now,
           dead_at = NULL,
           claimed_at = NULL,
           claimed_by = NULL,
           revive_count = revive_count + 1,
           revived_at = p_now,
           revived_by = p_revived_by
     WHERE id = p_id AND state = 'dead'
     RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

-- ---------------------------------------------------------------------------
-- The new signal. 0021 enumerates the kinds in a CHECK, so it is replaced rather than
-- extended — the closed list is the point, since it makes a typo'd kind a refusal instead
-- of a notification nobody receives.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE crm.notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN (
    'disposal_obligation_raised',
    'disposal_obligation_overdue',
    'call_plan_submitted',
    'call_plan_approved',
    'call_plan_returned',
    'sample_transfer_awaiting_acceptance',
    'erp_write_failed'
  ));
