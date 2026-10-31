-- The bytes that are not a table.
--
-- ADR-0001 carries this row, written when 0052 shipped the erasure receipt: "The CRM's own
-- object storage is not in scope, and the register cannot see it. `crm.attachment_blob` holds
-- the bytes TODAY -- an HCP's signature, a photographed receipt -- so erasing that table
-- really does destroy them and the attestation is honest. But the table's own header names
-- external object storage as where those bytes belong, and the moment they move there the
-- register's completeness guard stops being complete: `crm.undeclared_tenant_tables()`
-- enumerates Postgres, and a bucket is not a table."
--
-- WHAT THE ROW ASKED FOR, verbatim: "Whoever moves the bytes owes a subsystem attestation
-- beside the per-table ones, AND THE GUARD THAT REFUSES A TOMBSTONE WHILE IT IS MISSING --
-- otherwise the first deployment with real object storage gets a signed receipt that is
-- silent about the most sensitive data in the system."
--
-- This migration builds the guard and NOT the attestation, deliberately. An attestation shape
-- with no producer would be the fifth built-and-unreachable thing in this repository, and the
-- field that matters in it -- what the object store destroyed -- can only be written by
-- something that can destroy objects. The guard is what makes adding the format unavoidable at
-- the moment it becomes possible, which is the whole point of refusing rather than warning.
--
-- THE PRINCIPLE IS 0051's, FOR THE THIRD TIME: a completeness claim derived from a LIST is a
-- claim about the list. So the question "is any of this tenant's attachment data somewhere a
-- per-table attestation cannot speak for" is answered from the DATA -- the backends its own
-- attachment rows name -- and not from a constant in TypeScript.
--
-- AND THE EXCEPTIONS ARE DECLARED WITH THEIR REASONS, which is `RLS_EXEMPT`,
-- `UNREFERENCED_TARGETS` and `CONFINED_BY_CONSTRUCTION` in a fourth place. A backend is either
-- covered by a table whose attestation destroys its bytes, or it is a SUBSYSTEM that must
-- attest for itself. Exactly one, never neither, never both -- a CHECK, because "which of these
-- two is it" answered by a convention is answered by nobody.

-- ===========================================================================
-- THE REGISTRY
-- ===========================================================================
--
-- PLATFORM-WIDE, and the argument is `data_disposition`'s and `erp_reference_register`'s: which
-- store holds a kind of byte is a property of the DEPLOYMENT, identical for every tenant by
-- construction. A per-tenant copy would be one row multiplied by every tenant, and the first
-- time two disagreed one tenant's receipt would be silent about data the other's accounted for.
-- It holds no tenant's data -- a backend name, a table name, a sentence -- so there is nothing
-- here for a policy to confine. `schema.contract.test.ts` enumerates these deliberately, so
-- this table has to be argued for there before it exists here.

CREATE TABLE crm.attachment_storage_backend (
  backend                  text PRIMARY KEY
                             CHECK (backend ~ '^[a-z][a-z0-9_]{2,31}$'),

  -- EXACTLY ONE OF THESE TWO. A backend is covered when some tenant-scoped table's own
  -- attestation destroys its bytes -- `postgres` is covered by `crm.attachment_blob`, whose
  -- `DELETE` is the destruction -- or it is a subsystem, meaning nothing in Postgres destroys
  -- its objects and it owes a statement of its own. Neither is a gap nobody noticed; both is a
  -- claim that two different things destroyed the same bytes.
  erasure_covered_by_table text,
  subsystem                text,

  note                     text NOT NULL CHECK (length(note) BETWEEN 20 AND 1000),
  declared_by              text NOT NULL CHECK (length(declared_by) BETWEEN 1 AND 200),
  declared_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attachment_storage_backend_covered_xor_subsystem
    CHECK ((erasure_covered_by_table IS NULL) <> (subsystem IS NULL)),
  CONSTRAINT attachment_storage_backend_table_shape
    CHECK (erasure_covered_by_table IS NULL
           OR erasure_covered_by_table ~ '^[a-z][a-z0-9_]{2,62}$'),
  -- ADR-0317's six subsystems MINUS the two that are Postgres (`tenant_schema`,
  -- `shared_tables`): a backend whose bytes are in Postgres is covered by a TABLE, so naming
  -- either of those as a subsystem would be declaring a gap where a per-table attestation
  -- already speaks. The remaining four are the places a byte can be that this schema cannot
  -- enumerate.
  CONSTRAINT attachment_storage_backend_subsystem_shape
    CHECK (subsystem IS NULL
           OR subsystem = ANY (ARRAY['object_storage', 'backups', 'search_indexes', 'caches']))
);

-- The same trigger `crm.data_disposition` carries, for the same reason: a register row naming
-- a table that does not exist, or one no tenant owns rows in, would make the register look
-- complete while governing nothing.
CREATE OR REPLACE FUNCTION crm.attachment_storage_backend_names_a_real_table()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.erasure_covered_by_table IS NULL THEN RETURN NEW; END IF;

  IF to_regclass('crm.' || quote_ident(NEW.erasure_covered_by_table)) IS NULL THEN
    RAISE EXCEPTION
      'storage-backend-unknown-table: there is no table crm.% -- a backend claiming to be covered by a table that does not exist is a gap wearing a declaration',
      NEW.erasure_covered_by_table
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = to_regclass('crm.' || quote_ident(NEW.erasure_covered_by_table))
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION
      'storage-backend-not-tenant-scoped: crm.% has no tenant_id, so erasing a tenant does not erase anything in it and it cannot cover a backend',
      NEW.erasure_covered_by_table
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attachment_storage_backend_names_a_real_table
  BEFORE INSERT OR UPDATE ON crm.attachment_storage_backend
  FOR EACH ROW EXECUTE FUNCTION crm.attachment_storage_backend_names_a_real_table();

INSERT INTO crm.attachment_storage_backend
  (backend, erasure_covered_by_table, subsystem, note, declared_by)
VALUES (
  'postgres', 'attachment_blob', NULL,
  'crm.attachment_blob holds the bytes in a tenant-scoped table under FORCE row-level '
  || 'security, so the per-table attestation for attachment_blob IS the statement about these '
  || 'bytes: its DELETE destroys them, in the same transaction that signs the receipt. That is '
  || 'why 0052''s attestation was honest and why this registry starts with one row rather than '
  || 'with a gap.',
  'migration 0074'
);

-- ===========================================================================
-- THE COLUMN STOPS BEING A LIST AND BECOMES A REFERENCE
-- ===========================================================================
--
-- `CHECK (storage_backend IN ('postgres'))` was the right thing to write in 0033 and is the
-- wrong thing to keep: it is a list, and a list is what 0051 says a completeness claim must not
-- rest on. Worse, widening it is a one-word edit that nothing would make anybody think about,
-- which is exactly how a byte ends up outside the receipt. A reference makes adding a backend
-- an INSERT into a table whose CHECK demands the answer to "and who destroys its bytes".
--
-- SINGLE-COLUMN, AND THAT IS CORRECT HERE: the parent is platform-wide, so there is no second
-- column to carry and no tenant to confuse. `composite-fk.contract.test.ts` governs references
-- into TENANT-SCOPED tables, and this is not one -- which is why it passes rather than being
-- excepted.
--
-- VALIDATED UNDER FORCE RLS, which is a thing to say out loud rather than discover. This runs
-- as `crm_app`, which owns `crm.attachment`, and 0027 established that a foreign key's bulk
-- validation scan IS confined by row security -- so with no tenant context the scan sees
-- nothing and the constraint is accepted on a vacuous pass. It is safe here for a reason that
-- will not hold next time: the CHECK being dropped allowed exactly one value, so there is no
-- row that could fail. ENFORCEMENT is a different matter and is not confined, which is what the
-- guard test proves rather than assumes.
ALTER TABLE crm.attachment DROP CONSTRAINT attachment_storage_backend_check;
ALTER TABLE crm.attachment
  ADD CONSTRAINT attachment_storage_backend_fkey
  FOREIGN KEY (storage_backend) REFERENCES crm.attachment_storage_backend (backend)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ===========================================================================
-- THE GAP, DERIVED FROM THE TENANT'S OWN ROWS
-- ===========================================================================
--
-- Two reasons a backend is uncovered, and they want different sentences:
--
--   no_covering_table           the registry says it is a subsystem. Nothing in Postgres
--                               destroys its objects, and no per-table attestation can speak
--                               for it.
--   covering_table_not_in_scope it names a table, and that table is not in the receipt's
--                               scope -- absent from `crm.data_disposition`, or marked
--                               `is_receipt_store`, which 0054 excludes from every receipt.
--                               A covered backend whose coverer cannot attest is uncovered,
--                               and nothing else would have noticed.
--
-- COUNTED FROM `crm.attachment`, under the caller's own row security, which is the only honest
-- place to count from: the question is about THIS tenant's bytes, and the rows that name a
-- backend are the only record of where they are.
--
-- AND IT REFUSES RATHER THAN ANSWERING ZERO. 0072's rule and 0073's: under FORCE RLS a caller
-- with no tenant context reads nothing, so without this check the function's answer to "is
-- anything uncovered" would be "no" for the one caller that cannot see -- the most dangerous
-- wrong answer available here, because it is the answer that lets the receipt be signed.
CREATE OR REPLACE FUNCTION crm.uncovered_storage_backends(p_tenant uuid)
RETURNS TABLE (backend text, reason text, subsystem text, objects bigint, note text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  ctx text := current_setting('app.current_tenant_id', true);
BEGIN
  IF ctx IS NULL OR ctx = '' OR ctx::uuid <> p_tenant THEN
    RAISE EXCEPTION
      'storage-backend-scan-unscoped: asked about tenant % while app.current_tenant_id is %. Every row this counts is under FORCE row-level security, so the answer without the context is ZERO uncovered backends -- which is not an error, it is a signed receipt that is silent about the bytes.',
      p_tenant, COALESCE(NULLIF(ctx, ''), 'unset')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT b.backend,
           CASE WHEN b.erasure_covered_by_table IS NULL
                THEN 'no_covering_table' ELSE 'covering_table_not_in_scope' END,
           b.subsystem,
           count(*)::bigint,
           b.note
      FROM crm.attachment a
      JOIN crm.attachment_storage_backend b ON b.backend = a.storage_backend
     WHERE a.tenant_id = p_tenant
       AND (b.erasure_covered_by_table IS NULL
            OR NOT EXISTS (SELECT 1 FROM crm.data_disposition d
                            WHERE d.table_name = b.erasure_covered_by_table
                              AND NOT d.is_receipt_store))
     GROUP BY b.backend, b.erasure_covered_by_table, b.subsystem, b.note
     ORDER BY b.backend;
END
$$;

-- ===========================================================================
-- WHAT THIS DOES NOT DO, and why that is a decision rather than an omission
-- ===========================================================================
--
-- NO SUBSYSTEM ATTESTATION FORMAT, and no manifest `v3`. The row asked for one beside the
-- guard, and it cannot be built honestly today: the field that would matter in it -- what the
-- object store destroyed, and how many objects -- can only be written by something that can
-- destroy objects, and nothing here can. A record shape with no producer is the fifth
-- built-and-unreachable thing this repository has had to admit to, and a `v3` whose only
-- possible content is "postgres, covered by attachment_blob" would be a version bump carrying
-- a fact the attestation list already implies.
--
-- The guard is what makes the format unavoidable at the moment it becomes possible: the first
-- deployment that registers an object store cannot sign a receipt until somebody writes the
-- attestation, because the plan refuses and `assembleTombstone` refuses again. That is the
-- difference between this and a warning nobody reads.
--
-- AND ONE LIMIT WORTH STATING. The gap is derived from `crm.attachment.storage_backend`, so it
-- sees backends that this tenant's SURVIVING rows name. An object left in a bucket with no
-- attachment row -- the orphan 0033's header already predicts an S3 store will produce, since
-- its object lands before the row and an aborted transaction leaves it behind -- is invisible
-- to this and to everything else in Postgres. That is the sweeper 0033 said a future S3 store
-- needs, named again here because this guard is the thing somebody will mistake for covering
-- it.
