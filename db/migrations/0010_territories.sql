-- 0010_territories.sql
--
-- Territories and rep assignment: the CRM's answer to the thing the ERP
-- fundamentally cannot do.
--
-- The ERP has NO row-level scoping. `RbacGrant.abac` is parsed, `rbacCheck`
-- returns `requiresAbac`, and nothing in the workspace consumes it (report R2),
-- so any `sales_rep` token can list every Lead, Account and Invoice in the
-- tenant. "My accounts" is inexpressible there. It is expressed here.
--
-- EVERYTHING IS EFFECTIVE-DATED, and that is the second reason this lives in the
-- CRM. The ERP has no effective dating anywhere — no valid_from/valid_to on
-- Employee, Position or Department — so a reassignment overwrites history and
-- "who owned this account in Q2?" becomes unanswerable. In a pharma field force
-- territories are redrawn constantly and that question decides incentive
-- payments, so the assignment tables keep their history rather than their
-- latest state.

-- btree_gist (for the EXCLUDE constraints below) is created in 0002, the DBA
-- step. An extension needs superuser, and this file runs as crm_app like every
-- other application migration — a difference that matters, because a table
-- created by the DBA role would be owned by it and our whole isolation model
-- rests on crm_app owning crm.* and nothing else.

-- PostGIS is approved (Q7) and still deliberately absent: nothing here needs
-- geometry. Territory ASSIGNMENT — which rep covers which accounts — is a
-- hierarchy and a set of date ranges. Geometry is for map rendering and route
-- optimisation, which arrive with the migration that first needs a geometry
-- column, so that no environment fails on an extension nothing yet uses.

CREATE TABLE crm.territory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,

  code         text NOT NULL,
  name         text NOT NULL,

  -- Self-referencing hierarchy: region -> district -> territory. A manager
  -- assigned to a parent sees everything beneath it, which is what makes
  -- `crm.visible_territory_ids` a recursive walk rather than a flat lookup.
  parent_id    uuid REFERENCES crm.territory (id) ON DELETE RESTRICT,

  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, code),
  -- A territory cannot be its own parent. Deeper cycles need a walk, which the
  -- trigger below does.
  CONSTRAINT territory_not_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX idx_territory_parent ON crm.territory (tenant_id, parent_id);
CREATE INDEX idx_territory_status ON crm.territory (tenant_id, status);

SELECT crm.apply_tenant_isolation('crm.territory');

/**
 * Refuses a parent that would close a cycle.
 *
 * Without this, A->B->A is accepted by the schema and then hangs or errors
 * inside every recursive scoping query — at read time, in production, far from
 * the edit that caused it. Cheaper to refuse the write.
 */
CREATE OR REPLACE FUNCTION crm.territory_reject_cycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cursor_id uuid := NEW.parent_id;
  hops int := 0;
BEGIN
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'territory hierarchy cycle: % cannot be a descendant of itself', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    hops := hops + 1;
    -- A depth bound as well as the identity check: a cycle that predates this
    -- trigger would otherwise spin here forever.
    IF hops > 64 THEN
      RAISE EXCEPTION 'territory hierarchy deeper than 64 levels, or already cyclic'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cursor_id FROM crm.territory WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER territory_reject_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON crm.territory
  FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
  EXECUTE FUNCTION crm.territory_reject_cycle();

-- ---------------------------------------------------------------------------
-- Rep <-> territory, effective-dated.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.territory_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,

  territory_id   uuid NOT NULL REFERENCES crm.territory (id) ON DELETE RESTRICT,
  rep_profile_id uuid NOT NULL REFERENCES crm.rep_profile (id) ON DELETE RESTRICT,

  -- `primary` and `secondary` see the territory itself; `manager` also sees
  -- every territory beneath it. Coverage is a CRM concept — the ERP's
  -- Employee.manager_id is a reporting line, which is related but not the same
  -- thing and is not effective-dated there.
  role           text NOT NULL DEFAULT 'primary'
                   CHECK (role IN ('primary', 'secondary', 'manager')),

  valid_from     date NOT NULL,
  valid_to       date,   -- NULL means open-ended

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT territory_assignment_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX idx_territory_assignment_rep ON crm.territory_assignment (tenant_id, rep_profile_id, valid_from);
CREATE INDEX idx_territory_assignment_terr ON crm.territory_assignment (tenant_id, territory_id, valid_from);

-- One rep holds a given role on a given territory over any one day. Overlapping
-- rows are how the same coverage gets counted twice.
ALTER TABLE crm.territory_assignment ADD CONSTRAINT territory_assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    territory_id WITH =,
    rep_profile_id WITH =,
    role WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

SELECT crm.apply_tenant_isolation('crm.territory_assignment');

-- ---------------------------------------------------------------------------
-- Account <-> territory, effective-dated.
-- ---------------------------------------------------------------------------
CREATE TABLE crm.account_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,

  -- No foreign key: the ERP runs --store pg, so Account lives in a JSONB blob
  -- with no per-entity table to reference (ADR-0001 item 3). Integrity is the
  -- ACL's on write and the nightly orphan check's to detect.
  erp_account_id crm.erp_record_id NOT NULL,
  territory_id   uuid NOT NULL REFERENCES crm.territory (id) ON DELETE RESTRICT,

  valid_from     date NOT NULL,
  valid_to       date,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_assignment_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX idx_account_assignment_terr ON crm.account_assignment (tenant_id, territory_id, valid_from);
CREATE INDEX idx_account_assignment_acct ON crm.account_assignment (tenant_id, erp_account_id, valid_from);

-- THE load-bearing constraint. An account belongs to exactly ONE territory on
-- any given day. Two overlapping rows mean two reps both credibly claim the
-- same customer's sales, and the commission run pays both — a reconciliation
-- nobody wins. The database refuses it rather than a nightly report finding it.
ALTER TABLE crm.account_assignment ADD CONSTRAINT account_assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    erp_account_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

SELECT crm.apply_tenant_isolation('crm.account_assignment');
