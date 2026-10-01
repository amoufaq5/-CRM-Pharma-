-- 0021_notifications.sql
--
-- Telling someone. Until now every signal the system produced ended in a log line: the
-- expiry sweep raised a disposal obligation at 3am and the rep found out when they next
-- opened the app, a submitted call plan sat in a queue nobody was told about, and a
-- transfer of material waited for an acceptance the receiving rep had no reason to expect.
--
-- WHAT THIS IS NOT. It is not the ERP's notification stack reimplemented. That package
-- has 6 channels × 18 providers, templates with typed variables, audiences, on-call
-- rotations, quiet hours and digests — and, by its own CLAUDE.md, no real sender for any
-- of them: "only in_app has an implementation". Building the same shape here and claiming
-- more would be the same mistake with our name on it.
--
-- So two channels, both real:
--
--   in_app   — the notification row IS the delivery. Written in the same transaction as
--              the thing it is about, so an obligation cannot exist with nobody told.
--   webhook  — an HMAC-signed POST to a URL, drained by the scheduler with the same
--              claim/retry/dead-letter discipline as the ERP outbox. One of these feeds
--              Slack, Teams or PagerDuty, which is how a pharma field force actually gets
--              paged today.
--
-- Email and SMS are a seam (`ChannelSender` in @crm/notify) and nothing more, stated as
-- such rather than half-built.

ALTER TABLE crm.scheduled_job DROP CONSTRAINT scheduled_job_job_check;
ALTER TABLE crm.scheduled_job ADD CONSTRAINT scheduled_job_job_check
  CHECK (job IN ('relay_drain', 'snapshot_incremental', 'snapshot_full', 'expiry_sweep', 'notify_dispatch'));

-- ---------------------------------------------------------------------------

/**
 * Who supervises this rep, on a date — the inverse of crm.managed_rep_ids (0019).
 *
 * Needed because a notification has to go UP: a submitted call plan notifies whoever can
 * approve it, and an overdue regulated disposal notifies whoever is accountable for it.
 * The walk goes from the rep's territories to every ancestor, then collects `manager`
 * assignments anywhere on that chain.
 *
 * The two functions must agree: managed_rep_ids(M) contains R exactly when
 * supervisors_of(R) contains M. A test asserts that symmetry in both directions, because
 * two hierarchy walks written separately are two chances to disagree about who is
 * accountable for whom.
 */
CREATE OR REPLACE FUNCTION crm.supervisors_of(
  p_rep_profile_id uuid,
  p_on_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (rep_profile_id uuid)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE mine AS (
    SELECT ta.territory_id
      FROM crm.territory_assignment ta
     WHERE ta.rep_profile_id = p_rep_profile_id
       AND ta.valid_from <= p_on_date
       AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
  ),
  chain AS (
    SELECT territory_id FROM mine
    UNION
    SELECT t.parent_id
      FROM crm.territory t
      JOIN chain c ON c.territory_id = t.id
     WHERE t.parent_id IS NOT NULL
  )
  SELECT DISTINCT ta.rep_profile_id
    FROM crm.territory_assignment ta
    JOIN chain c ON c.territory_id = ta.territory_id
   WHERE ta.role = 'manager'
     AND ta.valid_from <= p_on_date
     AND (ta.valid_to IS NULL OR ta.valid_to > p_on_date)
     -- A manager who is also assigned as a rep below themselves does not supervise
     -- themselves; the roster function excludes self for the same reason.
     AND ta.rep_profile_id <> p_rep_profile_id;
$$;

-- ---------------------------------------------------------------------------
-- The notification itself. Its existence IS the in-app delivery.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,

  recipient_rep_profile_id  uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  kind                      text NOT NULL CHECK (kind IN (
                              'disposal_obligation_raised',
                              'disposal_obligation_overdue',
                              'call_plan_submitted',
                              'call_plan_approved',
                              'call_plan_returned',
                              'sample_transfer_awaiting_acceptance'
                            )),
  severity                  text NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),

  subject                   text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body                      text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),

  -- What it is about, so a client can deep-link without parsing prose. Not a foreign key:
  -- it points at several different tables, and a notification must outlive a row that is
  -- later deleted rather than vanishing with it.
  subject_table             text,
  subject_id                uuid,

  payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Idempotency, and the reason the nightly sweep can raise unconditionally. The ERP has
  -- a `dedup_sha256` column its own ADRs record as unused; this one carries the whole
  -- weight of "do not tell them the same thing every night".
  dedup_key                 text NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),

  created_at                timestamptz NOT NULL DEFAULT now(),
  -- REAL per-recipient read state. The ERP approximates "unread" by recency because it
  -- has nowhere to put this (its ADR-0273/0278); a nullable timestamp is all it took.
  read_at                   timestamptz,

  UNIQUE (tenant_id, recipient_rep_profile_id, dedup_key)
);

CREATE INDEX idx_notification_inbox
  ON crm.notification (tenant_id, recipient_rep_profile_id, created_at DESC);
CREATE INDEX idx_notification_unread
  ON crm.notification (tenant_id, recipient_rep_profile_id) WHERE read_at IS NULL;

SELECT crm.apply_tenant_isolation('crm.notification');

-- ---------------------------------------------------------------------------
-- Where a tenant wants signals pushed.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification_endpoint (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,

  channel       text NOT NULL CHECK (channel IN ('webhook')),

  -- HTTPS only, with a loopback exception for development. A notification carries a rep's
  -- name, an account id and sometimes a lot number; none of that goes over plaintext to
  -- another host. Loopback traffic never leaves the machine, so the exception is narrow
  -- enough to be worth the convenience of a local receiver in a test.
  url           text NOT NULL CHECK (
                  url ~ '^https://[^[:space:]]+$'
                  OR url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[^[:space:]]*)?$'
                ),

  -- The NAME of an environment variable holding the HMAC secret — never the secret.
  -- Consistent with the service signing key (ADR-0001 item 10): secrets live where the
  -- process can read them and the database cannot. A missing variable at send time fails
  -- the delivery rather than sending unsigned.
  secret_env    text NOT NULL CHECK (secret_env ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  -- Only signals at least this severe are pushed. `info` would page someone about every
  -- approved call plan, so the default is `warning`.
  min_severity  text NOT NULL DEFAULT 'warning'
                  CHECK (min_severity IN ('info', 'warning', 'urgent')),
  -- NULL means every kind. A non-null array is an allow-list.
  kinds         text[],

  enabled       boolean NOT NULL DEFAULT true,
  description   text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_endpoint_kinds_not_empty
    CHECK (kinds IS NULL OR cardinality(kinds) > 0)
);

CREATE INDEX idx_notification_endpoint_live
  ON crm.notification_endpoint (tenant_id) WHERE enabled;

SELECT crm.apply_tenant_isolation('crm.notification_endpoint');

-- ---------------------------------------------------------------------------
-- One row per (notification, endpoint): the external call that still has to happen.
--
-- Deliberately the same shape as crm.outbox, and deliberately NOT crm.outbox: that table
-- addresses the ERP's entity API with a deterministic record id, and its unique
-- constraint is what makes redelivery safe there. A webhook has an arbitrary URL and no
-- such guarantee from the far end, so the retry story is the same pattern with different
-- reasoning — at-least-once, with the delivery id in a header so a receiver can dedup.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.notification_delivery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,

  notification_id  uuid NOT NULL REFERENCES crm.notification (id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES crm.notification_endpoint (id) ON DELETE CASCADE,

  state            text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  last_status      integer,
  delivered_at     timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- One attempt chain per endpoint per notification. Fanning the same signal to one
  -- endpoint twice would page someone twice for one event.
  UNIQUE (notification_id, endpoint_id)
);

CREATE INDEX idx_notification_delivery_due
  ON crm.notification_delivery (tenant_id, next_attempt_at)
  WHERE state IN ('pending', 'in_flight');
CREATE INDEX idx_notification_delivery_dead
  ON crm.notification_delivery (tenant_id) WHERE state = 'dead';

SELECT crm.apply_tenant_isolation('crm.notification_delivery');

-- ---------------------------------------------------------------------------

/**
 * A rep's inbox, newest first, with the unread ones identifiable.
 *
 * `read_at IS NULL` is the actual question, answered from an actual column — so an inbox
 * badge is a count rather than "things since you last looked".
 */
CREATE OR REPLACE FUNCTION crm.notification_inbox(
  p_rep_profile_id uuid,
  p_unread_only    boolean DEFAULT false,
  p_limit          integer DEFAULT 50
)
RETURNS TABLE (
  id             uuid,
  kind           text,
  severity       text,
  subject        text,
  body           text,
  subject_table  text,
  subject_id     uuid,
  payload        jsonb,
  created_at     timestamptz,
  read_at        timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT n.id, n.kind, n.severity, n.subject, n.body, n.subject_table, n.subject_id,
         n.payload, n.created_at, n.read_at
    FROM crm.notification n
   WHERE n.recipient_rep_profile_id = p_rep_profile_id
     AND (NOT p_unread_only OR n.read_at IS NULL)
   ORDER BY n.created_at DESC, n.id
   LIMIT greatest(1, least(p_limit, 200));
$$;
