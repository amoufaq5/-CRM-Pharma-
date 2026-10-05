-- 0024_notification_retention.sql
--
-- "How long does an inbox keep things?"
--
-- WHAT WAS BROKEN. Nothing pruned `crm.notification`. Every signal the CRM has ever
-- raised — every expiring lot, every submitted plan, every failed ERP write — stayed in
-- the table forever, and the inbox query reads it with an index that grows with it. That
-- was recorded as an open item in ADR-0001 twice, both times with the same blocker: a
-- retention period is a tenant's decision and there was no principal the API could
-- restrict the setting to. Migration 0023 answered that half; this is the other.
--
-- THE RULE. A notification is a COPY of a signal, not the signal itself: the obligation,
-- the dead letter, the transfer and the plan all live in their own tables and are
-- untouched by this. Pruning loses the inbox entry, never the fact. That is what makes
-- it safe at all — and it is also what decides the two things below.
--
-- READ AND UNREAD ARE NOT THE SAME. A read notification has done its job. An unread one
-- has NOT, and deleting it deletes a message nobody ever saw. So there are two horizons,
-- with a CHECK forbidding the unread one from being the shorter.
--
-- AND AN OPEN SUBJECT IS NEVER PRUNED, at either horizon. A notification about a
-- disposal obligation that is still overdue, an ERP write still dead, material still in
-- transit, a plan still waiting on an approver — each is the thing telling somebody that
-- an unfinished obligation exists. A retention period is a statement about old news; it
-- must not quietly delete current news that happens to be old.

-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification_policy (
  tenant_id           uuid PRIMARY KEY,

  -- Deliberately two numbers, not one. See the header.
  retain_read_days    integer NOT NULL DEFAULT 30  CHECK (retain_read_days   BETWEEN 1 AND 3650),
  retain_unread_days  integer NOT NULL DEFAULT 365 CHECK (retain_unread_days BETWEEN 1 AND 3650),

  -- The invariant that makes the pair coherent: a message nobody read must never be
  -- deleted sooner than one that was read. Without this a tenant could set read=90 and
  -- unread=7 and silently lose exactly the notifications that still mattered.
  CONSTRAINT notification_policy_unread_not_shorter
    CHECK (retain_unread_days >= retain_read_days),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Two knobs and an id, like crm.disposal_policy (0020) — and RLS-protected for the same
-- reason: the tenant_id here scopes a real decision rather than naming a registry row.
SELECT crm.apply_tenant_isolation('crm.notification_policy');

-- ---------------------------------------------------------------------------
-- The one place "is the thing this notification is about still open" is decided.
-- ---------------------------------------------------------------------------

/**
 * Is a notification's subject still unfinished?
 *
 * Enumerated per table, exactly like `crm.outbox_recipient` (0022) and for the same
 * reason: `subject_table`/`subject_id` is deliberately not a foreign key (0021 — a
 * notification must outlive the row it points at), so there is nothing to join
 * generically and a `CASE` is the honest shape. Adding a producer means adding a branch,
 * which is a visible act in a diff rather than an inference.
 *
 * AN UNKNOWN TABLE READS AS NOT OPEN, so its notifications prune at the normal horizon.
 * That is the opposite of fail-closed and it is the right way round here: the failure
 * being fixed IS unbounded growth, and defaulting to "keep forever" would reintroduce it
 * silently for any kind whose producer forgot a branch. The prune counts these
 * separately instead, so a missing branch is visible in the job's own summary — the same
 * trade `crm.outbox_recipient` makes with its unattributed rows.
 *
 * A NULL subject is not open either: a notification about nothing in particular is just
 * news, and news is what a retention period is for.
 */
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
    ELSE false
  END;
$$;

/**
 * A subject table no branch above knows about.
 *
 * Separate from the predicate so the prune can REPORT it rather than infer it from a
 * count that came out lower than expected. NULL is not unknown — it is "no subject".
 */
CREATE OR REPLACE FUNCTION crm.notification_subject_unknown(p_subject_table text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject_table IS NOT NULL
     AND p_subject_table NOT IN ('crm.disposal_obligation', 'crm.outbox',
                                 'crm.sample_transaction', 'crm.call_plan');
$$;

-- ---------------------------------------------------------------------------
-- What the prune will consider, as a view, so the decision is inspectable in SQL
-- before anything is deleted.
-- ---------------------------------------------------------------------------

/**
 * Every notification past its horizon, with the reason it is or is not prunable.
 *
 * A view rather than a function so an operator can ask "what would tonight's prune take"
 * without running it — the question anybody sensibly asks before turning retention on
 * for the first time.
 *
 * A DEAD OR UNSENT DELIVERY also holds a notification back. A webhook that never got
 * through is an unresolved operational fact, and `crm.notification_delivery` cascades
 * from this row — so pruning would erase the evidence that a push failed along with the
 * thing it failed to push.
 */
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
                  WHERE d.notification_id = n.id
                    AND d.state IN ('pending', 'in_flight', 'dead'))   AS delivery_unsettled
    FROM crm.notification n;

ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full', 'expiry_sweep',
                 'notify_dispatch', 'notify_prune'));
