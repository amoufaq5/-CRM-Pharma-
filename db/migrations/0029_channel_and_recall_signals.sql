-- 0029_channel_and_recall_signals.sql
--
-- Three gaps that only a migration can close, each found by building the thing above it.
--
-- 1. AN EMAIL ENDPOINT COULD NOT BE STORED. `crm.notification_endpoint` has carried
--    `CHECK (channel IN ('webhook'))` since 0021, when a webhook was the only sender. A
--    real SMTP sender now exists and the dispatcher can drive it unchanged, but no row
--    could name it — the channel it implements was not a legal value. The ERP ships 18
--    notification providers and one implementation; this repo was one CHECK away from
--    shipping one implementation and no way to address it.
--
--    The url shape becomes CHANNEL-DEPENDENT rather than a flat disjunction. 0021's rule
--    (HTTPS only, with a narrow loopback exception, because a notification carries a
--    rep's name and a lot number) is unchanged for a webhook; an email endpoint must be a
--    `mailto:`. Written as one CHECK per channel instead of adding `mailto:` to the
--    existing OR, because the flat version would have accepted a webhook endpoint whose
--    url was a mailbox and an email endpoint pointed at an HTTPS host — two
--    configurations with no sender and no error.
--
--    `secret_env` stays NOT NULL. A relay that needs no AUTH leaves it meaningless, which
--    was an argument for making it nullable; the sender simply never reads it when no
--    username is configured, and a nullable column would add a state every reader has to
--    think about to describe a relay nobody should deploy.
--
-- 2. A RECALLED TRANSFER LEFT A LIE IN AN INBOX. `transferOut` tells the receiver material
--    is waiting for them. 0025 lets the sender take it back, and after that the
--    notification is false — it names material that is in somebody else's bag. No existing
--    kind fits, and reusing a near-enough one would be worse than none, so
--    `sample_transfer_recalled` is added to the closed list.
--
-- 3. `transfer_of` WAS ONLY CONSTRAINED ON THE KINDS THAT USE IT. Nothing stopped a
--    `receipt` or an `adjustment_in` carrying one. That is not cosmetic: the unique index
--    that enforces "one terminal event per transfer" admits exactly one row per
--    `transfer_of`, so an unrelated movement could occupy the slot and leave the transfer
--    permanently unsettleable — neither acceptable nor recallable, with the material stuck
--    in transit and no route out. Found while building the recall, which is the feature
--    that would have had to explain it.

-- ---------------------------------------------------------------------------
-- 1. The email channel.
-- ---------------------------------------------------------------------------
ALTER TABLE crm.notification_endpoint DROP CONSTRAINT notification_endpoint_channel_check;
ALTER TABLE crm.notification_endpoint ADD CONSTRAINT notification_endpoint_channel_check
  CHECK (channel IN ('webhook', 'email'));

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
  );

-- ---------------------------------------------------------------------------
-- 2. The recall signal.
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
    'sample_transfer_recalled',
    'erp_write_failed'
  ));

-- ---------------------------------------------------------------------------
-- 3. `transfer_of` belongs only to the kinds that settle a transfer.
-- ---------------------------------------------------------------------------
-- NOT VALID would have been the cautious choice, but these rows are few and young and a
-- constraint that is never validated is a constraint that does not hold. Validated here;
-- if a pre-existing row violates it the migration fails, which is the correct outcome
-- because such a row is a stuck transfer somebody needs to look at.
ALTER TABLE crm.sample_transaction ADD CONSTRAINT sample_tx_transfer_of_only_settles
  CHECK (transfer_of IS NULL OR kind IN ('transfer_in', 'transfer_recall'));
