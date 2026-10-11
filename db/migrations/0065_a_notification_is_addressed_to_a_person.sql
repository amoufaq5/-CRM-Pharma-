-- A notification is addressed to a PERSON. An email was not.
--
-- WHAT IS BROKEN, and the first thing to say is that 0064's closing note was WRONG about it:
--
--     The escalation is in-app and webhook only. There is still no email or SMS sender in
--     this repository.
--
-- There is. `SmtpSender` is a real SMTP client over `node:net`/`node:tls` (0029's lineage),
-- exercised against a real server in `smtp.contract.test.ts`, and the scheduler binary has
-- constructed it since the day the relay options landed. The sentence was written from memory
-- rather than from the code, which is the one failure this repository keeps a whole file of
-- lessons about. The real gap is narrower and sharper, and nothing above SQL can close it:
--
--   * `crm.notification` is addressed to a person — `recipient_rep_profile_id`, NOT NULL.
--   * `crm.notification_delivery` pairs that notification with an ENDPOINT, and endpoints are
--     per TENANT: `raiseNotification` fans out to every enabled row in the tenant.
--   * For `channel = 'email'` the destination is the endpoint's own `url`, a single `mailto:`
--     fixed by 0029 and frozen for the life of the row by 0049.
--
-- So every rep's signals go to the same mailbox. For the case email exists to serve — 0064's
-- `urgent` escalation reaching "somebody who has not opened the app in a week" — a shared ops
-- mailbox is the wrong destination: nobody is personally addressed, so nobody is personally
-- responsible, and the one person who must act may never see it.
--
-- AND `work_email_hint` HAS SAT IN THE SCHEMA SINCE 0003 WITH NO CONSUMER. Not one line of
-- TypeScript reads it. 0003 is explicit about why it must not become one:
--
--     work_email is carried as a RECONCILIATION HINT ONLY: it changes on marriage, rebrand
--     and domain migration, and must never be the join key.
--
-- That rule is kept here rather than broken. The hint becomes a SUGGESTION an administrator
-- confirms, and the thing a notification is actually sent to is a separate, deliberately-set,
-- attributed fact. Delivering a rep's name and a lot number to an address nobody confirmed is
-- the "fixture kinder than reality" failure wearing a mail header.
--
-- WHY ITS OWN TABLE AND NOT A COLUMN ON `crm.rep_profile`. A destination for a person's
-- signals is exactly the class 0060 and 0061 exist to attribute — adding one opens a route out
-- of the tenant for records carrying a rep's name — so it wants an author and a reason. But
-- `crm.rep_profile` is written by the ERP reconciler from the scheduler, with no human
-- anywhere near it, and `crm.require_config_attribution` would refuse every one of those
-- background writes. A column would therefore have to be either unattributed (the gap 0060
-- closed, reopened) or attributed at the cost of breaking reconciliation. Its own table is
-- neither: the reconciler is untouched and the destination carries its own audit trail.
--
-- A THIRD CHANNEL, because the policy and the destination are different facts. An endpoint row
-- holds the POLICY — which kinds, which minimum severity, enabled or not — and for
-- `email_recipient` the destination comes from whoever the notification names. Its `url` is
-- therefore not a destination at all, and is pinned to the literal `mailto:*`: a marker that
-- reads as "whichever mailbox this is addressed to", which is honest, satisfies a shape CHECK,
-- and cannot be mistaken for a mailbox by a reader of the row.
--
-- The fixed `email` channel stays. A tenant that wants `urgent` signals in a shared ops
-- mailbox is asking for something reasonable, and the two channels are two policies: one
-- answers "tell the team", the other "tell the person".
--
-- `to_address` ON THE DELIVERY, which is 0049's argument applied to a destination that varies
-- per row. 0046 made a delivery record outlive the notification it describes so that it still
-- says where the signal went, and 0049 froze the endpoint's url so that record stays true. For
-- `email_recipient` the endpoint's url says nothing, so the row carries the mailbox it was
-- actually addressed to — resolved and copied when the delivery is created, like
-- `endpoint_channel` and `endpoint_url` beside it.
--
-- A RECIPIENT WITH NO ADDRESS PRODUCES NO DELIVERY, and is counted. The alternative was a
-- `dead` row saying "this rep has no notification address", which is better evidence and worse
-- behaviour: it would be re-created and re-killed on every raise, forever, filling the one
-- table 0046 exists to keep honest with rows that describe a configuration gap rather than a
-- push. So the raise counts it, the dispatcher's line carries it, and
-- `GET /v1/admin/notify-addresses` is the to-do list an administrator acts on — the same shape
-- as `unmappedCategoriesWithClaims`, which is Finance's.

-- ---------------------------------------------------------------------------
-- 1. Where a person's signals go.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.rep_notify_address (
  tenant_id      uuid NOT NULL,
  rep_profile_id uuid NOT NULL,

  -- ONE MAILBOX, and the shape is 0029's own, deliberately character-for-character: a send
  -- returns one verdict, and two recipients can earn two different ones with nowhere to
  -- record the difference. Stated here as well as there because the two are different
  -- columns and a reader of either should not have to find the other to know what is legal.
  --
  -- NULLABLE, WHICH IS HOW A DESTINATION IS WITHDRAWN. The obvious shape is NOT NULL and a
  -- DELETE, and it is wrong here for a reason that is worth stating because it constrains
  -- every table that joins 0061: `crm.record_config_change` fires `AFTER INSERT OR UPDATE`
  -- and reads `NEW`, so a DELETE is neither attributed nor recorded. Removing somebody's
  -- mailbox by DELETE would therefore be the one change to this table that nobody signed
  -- and nothing logged — the exact hole 0060 and 0061 exist to close, reopened at the one
  -- end that matters, since "stop telling this person" is as consequential as "start".
  -- Setting it to NULL is an ordinary amendment: attributed, reasoned, and in
  -- `crm.config_change` with its before-image, so the row that remains is itself the record
  -- that somebody deliberately stopped the mail. Teaching 0061 about DELETE is a change to
  -- the mechanism (a third `action`, a `before`-only image, `NEW` unavailable) and belongs
  -- to its own migration, not to this one.
  address        text
                   CHECK (address IS NULL
                          OR address ~ '^[^[:space:],;@]+@[^[:space:],;@]+\.[^[:space:],;@]+$'),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One destination per rep. A second address would be a second verdict per signal with
  -- nowhere to record which bounced, which is 0029's reason for one mailbox per endpoint.
  -- It is also what makes a withdrawal expressible as an amendment rather than a deletion:
  -- there is exactly one row per rep to amend.
  PRIMARY KEY (tenant_id, rep_profile_id),

  -- Composite, like every reference inside `crm` since 0035: a referential check runs with
  -- row security disabled, so a single-column key would let one tenant's row name a rep in
  -- another. CASCADE, and it is the first `*_fkey` here that is not RESTRICT — this is not an
  -- audit record. It is a current setting about a person, the record of who set it lives in
  -- `crm.config_change`, and a tenant erasure that had to delete addresses before profiles
  -- would be a third ordering constraint for no gain.
  CONSTRAINT rep_notify_address_rep_fkey
    FOREIGN KEY (tenant_id, rep_profile_id) REFERENCES crm.rep_profile (tenant_id, id) ON DELETE CASCADE
);

SELECT crm.apply_tenant_isolation('crm.rep_notify_address');

-- Under attribution (0061), which is the whole reason this is a table rather than a column:
-- setting where a person's signals go is a decision with an author and a sentence.
SELECT crm.require_config_attribution('crm.rep_notify_address');

COMMENT ON TABLE crm.rep_notify_address IS
  'Where one rep''s notifications are emailed, for an endpoint on the email_recipient channel. Deliberately set and attributed (0061) — never crm.rep_profile.work_email_hint, which 0003 declares a reconciliation hint that must not be load-bearing. A null address is a withdrawn one: 0061 records amendments and not deletions, so the row stays and says so.';

-- ---------------------------------------------------------------------------
-- 2. The third channel.
-- ---------------------------------------------------------------------------
-- 0029's two CHECKs, extended. Replaced whole rather than patched, for the reason that
-- migration gives for writing one arm per channel instead of a flat disjunction: a flat
-- version "would have accepted a webhook endpoint whose url was a mailbox and an email
-- endpoint pointed at an HTTPS host — two configurations with no sender and no error".
ALTER TABLE crm.notification_endpoint DROP CONSTRAINT notification_endpoint_channel_check;
ALTER TABLE crm.notification_endpoint ADD CONSTRAINT notification_endpoint_channel_check
  CHECK (channel IN ('webhook', 'email', 'email_recipient'));

ALTER TABLE crm.notification_endpoint DROP CONSTRAINT notification_endpoint_url_check;
ALTER TABLE crm.notification_endpoint ADD CONSTRAINT notification_endpoint_url_check
  CHECK (
    (channel = 'webhook' AND (
       url ~ '^https://[^[:space:]]+$'
       OR url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[^[:space:]]*)?$'))
    OR
    -- One mailbox, not a list: a send returns ONE verdict, and two recipients can earn
    -- two different ones with nowhere to record the difference.
    (channel = 'email' AND url ~ '^mailto:[^[:space:],;@]+@[^[:space:],;@]+\.[^[:space:],;@]+$')
    OR
    -- NOT A DESTINATION. The literal marker, and only it: the mailbox comes from whoever the
    -- notification names, so a reader of this row must not be able to mistake its url for
    -- somewhere mail was sent. An address here would be a lie that `to_address` then
    -- contradicts on every delivery.
    (channel = 'email_recipient' AND url = 'mailto:*')
  );

-- ---------------------------------------------------------------------------
-- 3. What a delivery was actually addressed to.
-- ---------------------------------------------------------------------------
-- 0049's argument for freezing the endpoint's url, applied to a destination that varies per
-- row. NULL for a webhook and for the fixed `email` channel, where `endpoint_url` already says
-- where it went; the mailbox for `email_recipient`, copied when the delivery is created.
--
-- NOT NULL cannot be the rule and a CHECK pairing it with the channel almost can: the
-- delivery carries `endpoint_channel`, so "email_recipient implies an address" is expressible
-- and is enforced below. The reverse — an address on a channel that has no use for one — is
-- refused too, because a column that is sometimes meaningful is a column every reader has to
-- think about.
ALTER TABLE crm.notification_delivery
  ADD COLUMN to_address text
    CHECK (to_address IS NULL
           OR to_address ~ '^[^[:space:],;@]+@[^[:space:],;@]+\.[^[:space:],;@]+$'),
  ADD CONSTRAINT notification_delivery_to_address_pairs_with_channel
    CHECK ((endpoint_channel = 'email_recipient') = (to_address IS NOT NULL));

COMMENT ON COLUMN crm.notification_delivery.to_address IS
  'The mailbox this delivery was addressed to, for the email_recipient channel — copied when the row is created, for 0049''s reason: a delivery record outlives its notification and must still say where the signal went. Null on every other channel, where endpoint_url says it.';

-- ---------------------------------------------------------------------------
-- 4. The retention decision, which arrives with the table (0051).
--
-- ERASE, and this one is not a hard question. The address is a current setting about a person
-- in a tenant — it is not a record of anything that happened, and the record of who set it and
-- why lives in `crm.config_change`, which has its own undecided disposition. Keeping a
-- departed tenant's mailboxes would be keeping personal data whose only purpose was to send
-- mail nobody will send again.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, question, decided_by, decided_at)
VALUES ('rep_notify_address', 'erase', NULL, NULL, NULL, NULL, 'crm:0065', now())
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The read side, or the column above is unreadable.
-- ---------------------------------------------------------------------------
-- 0048 copies `endpoint_channel` and `endpoint_url` onto a delivery so the row still says
-- where a signal went after the endpoint is gone, and both history functions return them. For
-- `email_recipient` the url is the marker, so a reader of those functions would see
-- `mailto:*` and learn nothing — which would make `to_address` a column whose entire
-- justification (0049's: the record outlives its parents and must stay true) is invisible to
-- the only two queries that read this table for a human.
--
-- DROP and CREATE, not CREATE OR REPLACE: the return type changes, and Postgres refuses to
-- replace a function whose OUT parameters differ. The bodies are otherwise the live ones
-- character for character, read out of `pg_proc` rather than copied from 0048 — the newest
-- definition of a function several migrations have touched is not in the file that created it,
-- which this repository has now learned twice.
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
         d.state, d.attempts, d.last_status, d.last_error, d.delivered_at, d.created_at,
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
         d.state, d.attempts, d.last_status, d.last_error, d.delivered_at, d.created_at,
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
