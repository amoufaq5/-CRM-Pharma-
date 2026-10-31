-- Which mechanism settled a delivery, written down where it can be counted.
--
-- ADR-0001 carried this since the day the read-back probe landed, pinned by the live gate in
-- its own words: "PINNED GAP: a delivered row records no reason, so which mechanism settled it
-- is not readable from the queue — `markDelivered` takes none".
--
-- WHY THAT MATTERS, and it is not tidiness. The row this closes was about an invisible
-- dependency: the CRM's idempotency guarantee used to rest on the ERP leaking a node-postgres
-- message to clients, because `500 {"error":"write_failed","detail":"duplicate key value
-- violates unique constraint …"}` normalises to `unavailable` rather than `conflict`, so only a
-- regex over that sentence settled a redelivery. The fear recorded with it was exact: "if the
-- platform ever stops leaking that string — which it should — this breaks silently and in the
-- expensive direction".
--
-- The probe closed the dependency: on an ambiguous failure the relay reads the target id it
-- minted and settles on the answer. But the regex is still THERE, as the documented fallback for
-- when the probe cannot answer — and nothing anywhere says whether it is still load-bearing. A
-- deployment could be settling every redelivery by that sentence and look identical to one
-- settling none that way.
--
-- So each delivery records WHICH mechanism settled it, and the question becomes a query:
--
--     SELECT settled_by, count(*) FROM crm.outbox WHERE state = 'delivered' GROUP BY 1;
--
-- A non-zero `duplicate_key_text` is the leak dependency being exercised right now, on this
-- deployment, today. Zero means the probe is doing the work and the regex is insurance.
--
-- THE VOCABULARY, and every value is something a reader has to be able to act on:
--
--   accepted            the ERP answered this attempt 2xx. The ordinary case.
--   read_back           the write failed ambiguously, the relay READ the target id it had
--                       minted, and the ERP had it. Evidence, not inference.
--   conflict_status     the ERP answered a real 409 conflict. A statement, not a sentence.
--   duplicate_key_text  settled by the `ALREADY_EXISTS` regex over `detail` — the fallback, and
--                       the one value that means the guarantee is resting on a string.
--   unrecorded          delivered before this column existed. NAMED rather than guessed: the
--                       alternative is a backfill that invents `accepted` for rows whose
--                       mechanism nobody knows, which is the shape of lie this whole column
--                       exists to stop.
--
-- PAIRED WITH THE STATE BY A CHECK, so a delivery cannot be recorded without one and a pending
-- row cannot carry one. That pairing is the same rule 0066's `unverifiable` and 0051's
-- `undecided` follow: a column that is allowed to be silent is a column that will be.

ALTER TABLE crm.outbox
  ADD COLUMN settled_by text;

-- Existing deliveries get the honest value before the CHECK that would refuse them.
UPDATE crm.outbox SET settled_by = 'unrecorded' WHERE state = 'delivered' AND settled_by IS NULL;

ALTER TABLE crm.outbox
  ADD CONSTRAINT outbox_settled_by_vocabulary
    CHECK (settled_by IS NULL
           OR settled_by = ANY (ARRAY['accepted', 'read_back', 'conflict_status',
                                      'duplicate_key_text', 'unrecorded'])),
  ADD CONSTRAINT outbox_delivered_records_its_mechanism
    CHECK ((state = 'delivered') = (settled_by IS NOT NULL));

-- ===========================================================================
-- COUNTED FOR A TENANT, WHICH IS THE SURFACE AN OPERATOR ACTUALLY READS
-- ===========================================================================
--
-- The drain's log line is the one place a running deployment says anything about the queue, and
-- a count there is what turns this column from a forensic field into a signal. The function
-- answers for the CALLER'S tenant only, under its own row security like everything else: the
-- question "is this tenant's idempotency resting on a string" is a per-tenant question, because
-- which writes collide is a property of that tenant's traffic.
--
-- `accepted` is deliberately NOT counted. It is the overwhelming majority of every queue, and a
-- line reporting it would be a number that is always large next to the numbers that matter.
-- What this returns is the exceptions: the settlements that happened because something went
-- wrong and was recovered from.
CREATE OR REPLACE FUNCTION crm.outbox_settlement_exceptions(p_tenant uuid)
RETURNS TABLE (settled_by text, rows bigint)
LANGUAGE sql STABLE AS $$
  SELECT o.settled_by, count(*)::bigint
    FROM crm.outbox o
   WHERE o.tenant_id = p_tenant
     AND o.state = 'delivered'
     AND o.settled_by IS NOT NULL
     AND o.settled_by <> 'accepted'
   GROUP BY o.settled_by
   ORDER BY o.settled_by
$$;
