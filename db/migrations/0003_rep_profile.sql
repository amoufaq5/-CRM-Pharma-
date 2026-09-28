-- 0003_rep_profile.sql
--
-- ADR-0001 Q3: the authoritative mapping from a CRM login to an ERP Employee.
-- Nothing in the ERP links a login to an Employee — meta.users and
-- user_tenant_membership are read only by the notification recipient resolver
-- and take no part in authentication. So the CRM owns this mapping.
--
-- Keyed on employee_number, the only Employee field immutable by intent.
-- work_email is carried as a RECONCILIATION HINT ONLY: it changes on marriage,
-- rebrand and domain migration, and must never be the join key.

CREATE TABLE crm.rep_profile (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,

  -- CRM-side identity: the `sub` of the OIDC token that logs this person in.
  -- Not an ERP concept. Unique per tenant.
  subject              text NOT NULL,

  -- ERP-side identity. employee_number is the join key; erp_employee_id is the
  -- record id we actually address the API with, refreshed when the mapping is
  -- reconciled. Both are unenforced by FK on purpose (ADR-0001 item 3).
  employee_number      text NOT NULL,
  erp_employee_id      crm.erp_record_id,

  work_email_hint      text,

  -- CRM-owned attributes the ERP has no concept of.
  display_name         text NOT NULL,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended', 'departed')),

  -- Reconciliation bookkeeping: when the ACL last confirmed erp_employee_id
  -- still resolves, and what it saw. A null erp_employee_id with a non-null
  -- last_reconciled_at means the Employee could not be found — an orphan.
  last_reconciled_at   timestamptz,
  reconcile_note       text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, subject),
  UNIQUE (tenant_id, employee_number)
);

CREATE INDEX idx_rep_profile_tenant_status ON crm.rep_profile (tenant_id, status);
CREATE INDEX idx_rep_profile_erp_employee  ON crm.rep_profile (tenant_id, erp_employee_id);

SELECT crm.apply_tenant_isolation('crm.rep_profile');
