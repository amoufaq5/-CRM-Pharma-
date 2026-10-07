-- The CRM's own deletion receipt: what it destroyed for a deleted tenant, and what it kept.
--
-- 0051 built the register and stopped at a PLAN, for a reason it stated as a rule rather than
-- a worry — CrossEngin's ADR-0317: "A proof over a scope assembled from nothing is a correct
-- proof of a false claim." A tombstone composed before anything is erased is that mistake. So
-- this migration adds the place a tombstone goes, and `packages/erasure` adds the executor
-- that earns one.
--
-- THE SHAPE IS THE ERP'S, one level out. ADR-0317's three outcomes, its rule that only some
-- may carry figures, and its refusal to assemble while a subsystem in scope has not attested.
-- Where the ERP attests per SUBSYSTEM (`tenant_schema`, `object_storage`, `backups`, …), this
-- attests per TABLE, because that is the granularity the register decides at: one row per
-- table saying what was done and, when something was kept, under what obligation.
--
-- ADR-0319's property is the other half and the one that makes a receipt worth anything: the
-- deletion and its proof COMMIT TOGETHER. Every DELETE, every attestation and the tombstone
-- itself are one transaction. A deletion that commits without its proof is unprovable; a proof
-- that commits without its deletion is false. There is no ordering of two transactions that
-- avoids both.
--
-- A NOTE ON THE ID PREFIX. The ERP's tombstones are `tomb_…` and this CRM already stores one of
-- them, in `crm.tenant.erp_tombstone_id`. Ours are `crmtomb_…` so that no reader, log line or
-- support ticket can mistake our receipt for theirs — they are different claims by different
-- controllers about different data, and the one thing they must never do is look alike.

-- ---------------------------------------------------------------------------
-- 1. The FK graph, because the executor cannot be written without it.
-- ---------------------------------------------------------------------------
/**
 * Every foreign key between two tenant-scoped `crm` tables, with its `ON DELETE` action.
 *
 * Published as a function because two things the executor must get right are properties of
 * this graph and not of the register, and both were found by looking at it rather than by
 * reasoning about it:
 *
 *   * A TABLE REFERENCING AN ERASED TABLE MUST ITSELF BE ERASED, and the reason is the
 *     `CASCADE` edges rather than the `RESTRICT` ones. A `RESTRICT` edge from a retained child
 *     to an erased parent refuses the DELETE: loud, mid-transaction, and recoverable because
 *     the whole thing rolls back. A `CASCADE` edge DESTROYS the retained child — silently,
 *     with no attestation, inside a transaction that then commits a signed proof saying those
 *     rows were lawfully kept. That is the worst outcome this subsystem can produce, and
 *     `crm.call_plan_product -> crm.call_plan` and `crm.visit_product -> crm.visit` are both
 *     `CASCADE` today. One refusal covers both cases; the asymmetry is why it cannot be
 *     skipped for the cascading ones.
 *   * CHILDREN ARE DELETED FIRST, explicitly, even where a `CASCADE` would remove them. Not
 *     for correctness of the delete — the cascade would work — but for correctness of the
 *     FIGURES. A child removed by its parent's cascade reports zero rows erased while its rows
 *     are gone, and that zero goes into a hash. A proof is only as good as its least careful
 *     number.
 *
 * `rep_profile` is the parent of eleven of these, which is why the order is computed rather
 * than written down.
 */
CREATE OR REPLACE FUNCTION crm.tenant_table_fk_edges()
RETURNS TABLE (child text, parent text, on_delete text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT
         ch.relname::text AS child,
         pa.relname::text AS parent,
         CASE c.confdeltype
           WHEN 'a' THEN 'no_action'
           WHEN 'r' THEN 'restrict'
           WHEN 'c' THEN 'cascade'
           WHEN 'n' THEN 'set_null'
           WHEN 'd' THEN 'set_default'
           ELSE c.confdeltype::text
         END AS on_delete
    FROM pg_constraint c
    JOIN pg_class ch     ON ch.oid = c.conrelid
    JOIN pg_class pa     ON pa.oid = c.confrelid
    JOIN pg_namespace nc ON nc.oid = ch.relnamespace
    JOIN pg_namespace np ON np.oid = pa.relnamespace
   WHERE c.contype = 'f'
     AND nc.nspname = 'crm' AND np.nspname = 'crm'
     AND c.conrelid <> c.confrelid
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                  AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                  AND a.attname = 'tenant_id' AND NOT a.attisdropped)
   ORDER BY child, parent;
$$;

-- ---------------------------------------------------------------------------
-- 2. The receipt.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.tenant_tombstone (
  id          text PRIMARY KEY CHECK (id ~ '^crmtomb_[0-9a-f]{32}$'),
  tenant_id   uuid NOT NULL,

  -- `now()` is the transaction clock and every row of one execution shares it, so nothing may
  -- order by it. The sixth table in this schema to need saying.
  seq         bigint NOT NULL GENERATED ALWAYS AS IDENTITY,

  -- NOT UNIQUE per tenant, deliberately. A first execution may erase what was decided and
  -- retain the rest; a later decision to erase something previously retained is a second,
  -- separate act with its own proof. The ERP's own route answers with a LIST for the same
  -- reason.

  -- The ERP receipt this one is downstream of. REQUIRED: erasing a tenant's data is lawful
  -- here because the controller ended the relationship there, and a CRM tombstone that cannot
  -- name the ERP tombstone it followed is a deletion with no authority behind it.
  erp_tombstone_id text NOT NULL CHECK (erp_tombstone_id ~ '^tomb_[A-Za-z0-9_-]{12,40}$'),

  deleted_at  timestamptz NOT NULL DEFAULT now(),

  content_manifest_sha256 text NOT NULL CHECK (content_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  proof_sha256            text NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),

  -- Four-eyes, structurally, which is this schema's rule for every privileged act and is at
  -- its most load-bearing here: this is the only operation in the CRM that destroys data on
  -- purpose. Enforced in the executor AND by this CHECK, two layers for one rule, as 0044's
  -- expense approvals are.
  executed_by text NOT NULL CHECK (length(executed_by) BETWEEN 1 AND 200),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 200),
  CONSTRAINT tenant_tombstone_four_eyes CHECK (executed_by <> approved_by),

  rows_erased   integer NOT NULL CHECK (rows_erased >= 0),
  rows_retained integer NOT NULL CHECK (rows_retained >= 0),

  -- 0035's rule: a reference into a tenant-scoped table is composite, so the attestations can
  -- carry `(tenant_id, tombstone_id)` and no tenant's attestation can name another's receipt.
  UNIQUE (tenant_id, id)
);

CREATE INDEX idx_tenant_tombstone_recent ON crm.tenant_tombstone (tenant_id, seq DESC);

SELECT crm.apply_tenant_isolation('crm.tenant_tombstone');

-- ---------------------------------------------------------------------------
-- 3. One attestation per table, and the three things it may say.
-- ---------------------------------------------------------------------------
-- ADR-0317's table, with its rule about which outcome may carry figures:
--
--   erased            something was destroyed          rows_erased required, >= 1
--   nothing_to_erase  asked, held nothing              no figures at all
--   retained          lawfully required to keep it     rows_retained required, >= 1,
--                                                      plus an obligation and a reference
--
-- ONE DIVERGENCE FROM THE ERP, stated because a mirrored vocabulary should not drift silently.
-- ADR-0317 forbids SCOPE on a `retained` attestation, and that is right: scope lists what was
-- destroyed, and nothing was. `rows_retained` is a different figure — it answers "what do you
-- still hold about me", which is the question a data subject actually asks — so it is present
-- on `retained` and forbidden elsewhere. The destroyed-figure column stays forbidden there.
--
-- AN EMPTY TABLE WITH A `retain` DISPOSITION ATTESTS `nothing_to_erase`, not `retained`. The
-- outcome describes what was found and done, not what the register decided: "we are lawfully
-- keeping it" about zero rows is a sentence that reads as evidence and is not.
CREATE TABLE crm.tenant_tombstone_attestation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  tombstone_id  text NOT NULL,

  table_name    text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{2,62}$'),
  outcome       text NOT NULL CHECK (outcome IN ('erased', 'nothing_to_erase', 'retained')),

  rows_erased   integer CHECK (rows_erased IS NULL OR rows_erased >= 1),
  rows_retained integer CHECK (rows_retained IS NULL OR rows_retained >= 1),

  obligation         text CHECK (obligation IS NULL OR obligation = ANY (crm.retention_obligations())),
  obligation_note    text CHECK (obligation_note IS NULL OR length(obligation_note) BETWEEN 10 AND 1000),
  retained_reference text CHECK (retained_reference IS NULL OR length(retained_reference) BETWEEN 3 AND 200),

  CONSTRAINT tenant_tombstone_attestation_erased
    CHECK (outcome <> 'erased' OR (rows_erased IS NOT NULL
                                   AND rows_retained IS NULL
                                   AND obligation IS NULL
                                   AND retained_reference IS NULL)),
  CONSTRAINT tenant_tombstone_attestation_nothing
    CHECK (outcome <> 'nothing_to_erase' OR (rows_erased IS NULL
                                             AND rows_retained IS NULL
                                             AND obligation IS NULL
                                             AND retained_reference IS NULL)),
  CONSTRAINT tenant_tombstone_attestation_retained
    CHECK (outcome <> 'retained' OR (rows_retained IS NOT NULL
                                     AND rows_erased IS NULL
                                     AND obligation IS NOT NULL
                                     AND obligation <> 'none'
                                     AND obligation_note IS NOT NULL
                                     AND retained_reference IS NOT NULL)),

  -- One attestation per table per receipt. Two would mean the hash covers a list with a
  -- duplicate, and whichever figure a reader believed would be a coin toss.
  UNIQUE (tenant_id, tombstone_id, table_name),

  CONSTRAINT tenant_tombstone_attestation_tombstone_fkey
    FOREIGN KEY (tenant_id, tombstone_id)
    REFERENCES crm.tenant_tombstone (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_tombstone_attestation_by_tombstone
  ON crm.tenant_tombstone_attestation (tenant_id, tombstone_id, table_name);

SELECT crm.apply_tenant_isolation('crm.tenant_tombstone_attestation');

-- ---------------------------------------------------------------------------
-- 4. A receipt is evidence, so it is append-only and only for a deleted tenant.
-- ---------------------------------------------------------------------------
/**
 * No UPDATE and no DELETE, on either table.
 *
 * 0023's shape for `crm.rep_role`, with none of its exceptions: a role grant may be revoked, so
 * that trigger permits exactly one update. A tombstone has no legitimate second state. Its
 * hashes commit to its own contents, so an UPDATE would either break the proof or — worse,
 * because it looks fine — be accompanied by a recomputed hash and produce a consistent receipt
 * for a claim nobody made.
 *
 * `ON DELETE RESTRICT` on the attestation's reference says the same thing from the other side:
 * a receipt cannot be removed while its attestations exist, and the attestations cannot be
 * removed at all.
 */
CREATE OR REPLACE FUNCTION crm.tenant_tombstone_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'crm.% is append-only: a deletion receipt cannot be removed, because the only thing it is for is being there afterwards (id %)',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION
    'crm.% is append-only: a receipt has no second state, and rewriting one with its hash recomputed would produce a consistent proof of a claim nobody made (id %)',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER tenant_tombstone_append_only
  BEFORE UPDATE OR DELETE ON crm.tenant_tombstone
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_tombstone_append_only();

CREATE TRIGGER tenant_tombstone_attestation_append_only
  BEFORE UPDATE OR DELETE ON crm.tenant_tombstone_attestation
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_tombstone_append_only();

/**
 * A receipt may only exist for a tenant the ERP has deleted.
 *
 * The same pairing 0050 put between `erp_deleted` and its ERP tombstone, one step along: there
 * the status could not be typed without the receipt, and here the receipt cannot be written
 * without the status. Together they mean a CRM tombstone implies a stopped tenant implies an
 * ERP tombstone — a chain of three facts, each refusing to exist without the one behind it.
 *
 * It also checks the ERP tombstone id MATCHES the one on the registry row, which is the guard
 * that actually earns its place: naming some other tenant's receipt, or a typo, would produce a
 * CRM deletion claiming an authority that does not cover it.
 */
CREATE OR REPLACE FUNCTION crm.tenant_tombstone_needs_a_deleted_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  SELECT status, erp_tombstone_id INTO t FROM crm.tenant WHERE tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'tombstone-needs-deleted-tenant: tenant % is not in crm.tenant, so nothing establishes that it was deleted at the ERP',
      NEW.tenant_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF t.status <> 'erp_deleted' THEN
    RAISE EXCEPTION
      'tombstone-needs-deleted-tenant: tenant % is %, not erp_deleted — erasing a live tenant''s data is not a deletion, it is data loss',
      NEW.tenant_id, t.status USING ERRCODE = 'check_violation';
  END IF;

  IF t.erp_tombstone_id IS DISTINCT FROM NEW.erp_tombstone_id THEN
    RAISE EXCEPTION
      'tombstone-wrong-erp-receipt: tenant % was deleted under ERP tombstone %, but this receipt names % — a CRM deletion must cite the authority that actually covers it',
      NEW.tenant_id, COALESCE(t.erp_tombstone_id, 'none'), NEW.erp_tombstone_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_tombstone_needs_a_deleted_tenant
  BEFORE INSERT ON crm.tenant_tombstone
  FOR EACH ROW EXECUTE FUNCTION crm.tenant_tombstone_needs_a_deleted_tenant();

-- ---------------------------------------------------------------------------
-- 5. And the two new tables are themselves in the register.
-- ---------------------------------------------------------------------------
-- 0051's completeness guard refuses the migration otherwise, which is exactly what it is for:
-- a table added to hold deletion evidence that was itself undeclared would be a hole in the
-- subsystem whose whole job is not having holes.
INSERT INTO crm.data_disposition
  (table_name, disposition, obligation, obligation_note, retained_reference, decided_by, decided_at)
VALUES
  ('tenant_tombstone', 'retain', 'deletion_evidence',
   'The CRM''s own deletion receipt: what was destroyed for this tenant, what was kept and under what obligation, hashed and four-eyed. Erasing it would destroy the only proof that the erasure was performed and bounded.',
   'crm.tenant_tombstone, append-only, one row per execution',
   'crm:0052', now()),
  ('tenant_tombstone_attestation', 'retain', 'deletion_evidence',
   'The per-table attestations the receipt''s content hash commits to. Without them the hash covers nothing a reader can check, which is the defect ADR-0317 was written to close.',
   'crm.tenant_tombstone_attestation, append-only, one row per table per receipt',
   'crm:0052', now());

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(t) INTO missing FROM crm.undeclared_tenant_tables() AS t;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'data-disposition-incomplete: these tenant-scoped tables have no disposition: %',
      array_to_string(missing, ', ');
  END IF;
END
$$;
