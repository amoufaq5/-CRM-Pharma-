-- The endpoint leg: a delivery record no longer dies with the endpoint it was pushed to.
--
-- 0046 did this for the notification and said the endpoint was "the identical defect, still
-- open". It is. `notification_delivery_endpoint_id_fkey` is `ON DELETE CASCADE`, so deleting
-- an endpoint erases the record of everything ever sent to it — which is the problem
-- ADR-0001 named, on the other parent, with the same consequence: the evidence of a
-- disclosure to a third party disappears when somebody tidies up the destination.
--
-- Latent rather than live, and worth being exact about why: there is no DELETE route for an
-- endpoint, and `routes.ts` documents its absence citing this cascade. So nothing in the
-- product can trip it today, and a `psql` prompt can — which is the same standard every
-- other guard in this schema is held to.
--
-- THE SHAPE IS 0046's, DELIBERATELY. Drop the key, copy what the row needs to stay legible,
-- and let the trigger that makes the copies be the tenant guard the key used to provide.
-- Inventing a second answer for the second leg of one table would be the drift these
-- migrations keep closing.
--
-- WHAT IS COPIED: `endpoint_channel` and `endpoint_url` — the DESTINATION. 0046 copied
-- neither, and said why: "the endpoint is still joinable, and copying a fact readable from a
-- live row is how two sources of one truth start to disagree." That argument expires the
-- moment the row can outlive the endpoint, which is what this file does. So the two columns
-- move from JOINED-and-nullable to COPIED-and-NOT-NULL, and 0046's own header names the
-- trigger as where they would go when the day came.
--
-- It closes a second thing on the way. `updateEndpoint` refuses to repoint a url, arguing
-- that "removing one would carry its delivery history onto a different destination" — and
-- nothing in the schema said so, so a hand-written UPDATE silently re-attributed every
-- delivery record that endpoint ever had. A copy taken at enqueue time cannot be
-- re-attributed by anything: the history now says where the push actually went, whatever
-- the endpoint says later. The TypeScript rule is still worth keeping for rows not yet sent.
--
-- WHAT IS NOT COPIED: `secret_env`. It is the NAME of an environment variable, not a value,
-- and rotating which variable an endpoint reads is a legitimate configuration change —
-- freezing it per delivery would make a rotation invisible to the rows that have to use it.
-- Which is also why `claimDue` must still JOIN the live endpoint to send: the copies are for
-- the record, not for the work.
--
-- AND THAT IS THE HAZARD THIS FILE HAS TO ANSWER. With the cascade gone, deleting an
-- endpoint leaves its PENDING deliveries behind with nothing to join — and `claimDue`'s
-- endpoint join is inner, so those rows would be claimed, have their attempt count
-- incremented, and then be dropped by the join: consumed silently, forever. 0046 met exactly
-- this for the notification and answered it in two separate pieces, which is the pattern
-- followed here: the `due` CTE now requires the ENDPOINT to exist too, so an orphan is never
-- claimed-and-lost, and `settleOrphanedDeliveries` gives it an outcome. A claim must not be
-- the thing that dead-letters.
--
-- RETENTION needs nothing new: `retain_delivery_days` (0046) already bounds an orphan, and
-- an orphan is the point rather than an accident. The one unbounded path 0046 recorded —
-- an orphan settled `dead` is held back forever, because a permanent failure is the evidence
-- — is unchanged and still only reachable by a hand-written delete.
--
-- FORCE ROW LEVEL SECURITY. The backfill joins two FORCEd tables, so BOTH are lifted around
-- it (0046's lesson: lifting only the target leaves the join contributing zero rows and the
-- `SET NOT NULL` as the only thing that complains). The columns are added nullable, filled,
-- then tightened — a `NOT NULL DEFAULT` would have to invent a destination.
--
-- No pre-flight scan: this governs an act, and `0039`'s asymmetry says a validated CHECK's
-- scan IS sighted, so phrasing it that way would refuse a correct database.

ALTER TABLE crm.notification_delivery ADD COLUMN endpoint_channel text;
ALTER TABLE crm.notification_delivery ADD COLUMN endpoint_url     text;

ALTER TABLE crm.notification_delivery    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_endpoint    NO FORCE ROW LEVEL SECURITY;

UPDATE crm.notification_delivery d
   SET endpoint_channel = e.channel,
       endpoint_url     = e.url
  FROM crm.notification_endpoint e
 WHERE e.tenant_id = d.tenant_id
   AND e.id        = d.endpoint_id;

ALTER TABLE crm.notification_endpoint    FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.notification_delivery    FORCE ROW LEVEL SECURITY;

-- Any row the backfill could not reach had no endpoint to begin with, which the cascade made
-- impossible — so this is zero rows on every real database and a refusal rather than an
-- invention if it ever is not.
ALTER TABLE crm.notification_delivery ALTER COLUMN endpoint_channel SET NOT NULL;
ALTER TABLE crm.notification_delivery ALTER COLUMN endpoint_url     SET NOT NULL;

-- The key goes LAST, after the copies exist, so a half-applied run through psql without
-- `-1` never leaves a window in which neither the key nor the copy is protecting the row.
ALTER TABLE crm.notification_delivery
  DROP CONSTRAINT notification_delivery_endpoint_id_fkey;

-- The context trigger, REPRODUCED FROM 0046 VERBATIM apart from the endpoint lookup and the
-- two assignments. `CREATE OR REPLACE FUNCTION` replaces a whole body, so a replacement
-- rebuilt from memory undoes every migration that amended it since — which is how 0041
-- silently reverted 0038's guard, caught only by 0038's own test.
CREATE OR REPLACE FUNCTION crm.notification_delivery_context()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n  record;
  ep record;
BEGIN
  SELECT x.kind, x.severity, x.created_at, x.recipient_rep_profile_id
    INTO n
    FROM crm.notification x
   WHERE x.tenant_id = NEW.tenant_id
     AND x.id        = NEW.notification_id;

  IF n IS NULL THEN
    RAISE EXCEPTION
      'delivery-foreign-notification: notification % is not visible in tenant %',
      NEW.notification_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0048: the same lookup, for the other parent. Resolved under the caller's own row
  -- security, so an endpoint this tenant cannot see reads as ABSENT — where the composite
  -- foreign key it replaces would have found it and accepted the row, because a referential
  -- check runs with row security disabled.
  SELECT y.channel, y.url
    INTO ep
    FROM crm.notification_endpoint y
   WHERE y.tenant_id = NEW.tenant_id
     AND y.id        = NEW.endpoint_id;

  IF ep IS NULL THEN
    RAISE EXCEPTION
      'delivery-foreign-endpoint: notification endpoint % is not visible in tenant %',
      NEW.endpoint_id, NEW.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.notification_kind        := n.kind;
  NEW.notification_severity    := n.severity;
  NEW.notification_created_at  := n.created_at;
  NEW.recipient_rep_profile_id := n.recipient_rep_profile_id;
  NEW.endpoint_channel         := ep.channel;
  NEW.endpoint_url             := ep.url;

  RETURN NEW;
END
$$;
-- The two read functions, serving the copies.
--
-- DROP then CREATE, because `RETURNS TABLE` cannot be widened by `CREATE OR REPLACE` —
-- 0046 had to do the same thing for the same reason. `endpoint_present` is appended rather
-- than inserted, so a reader positioned on the existing columns is unaffected.
--
-- REPRODUCED FROM 0046 VERBATIM apart from the two `e.channel, e.url` becoming copies, the
-- removed endpoint LEFT JOIN, and the new flag.
DROP FUNCTION IF EXISTS crm.notification_delivery_history(uuid);
DROP FUNCTION IF EXISTS crm.notification_delivery_recent(integer);

CREATE OR REPLACE FUNCTION crm.notification_delivery_history(p_notification_id uuid)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
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
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         -- 0048: COPIED, not joined. 0046's reason for joining was that the endpoint is
         -- still readable from a live row — which stopped being true the moment this row
         -- could outlive it.
         d.endpoint_channel, d.endpoint_url,
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

CREATE OR REPLACE FUNCTION crm.notification_delivery_recent(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id                       uuid,
  seq                      bigint,
  notification_id          uuid,
  endpoint_id              uuid,
  endpoint_channel         text,
  endpoint_url             text,
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
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.seq, d.notification_id, d.endpoint_id,
         d.endpoint_channel, d.endpoint_url,
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
