import type { PoolClient } from "pg";

import {
  InvalidAccountCodeError,
  InvalidCategoryError,
  UnmappedCategoryError,
} from "./errors.js";

/**
 * The category → Sales & Marketing ledger account map (0006).
 *
 * Every function takes a `PoolClient` already inside `withTenantContext`, like the rest
 * of the CRM's stores: RLS confines the queries, and a caller who forgets the wrapper
 * sees no rows rather than everyone's.
 *
 * This table is the Finance-owned half of the expense feature and it is EMPTY until
 * Finance fills it. That is the designed state, not a gap: ADR-0001 item 11 chose a
 * separate S&M account precisely so rep spend does not land in the AP expense account,
 * and nobody but Finance can say which account that is.
 */

export interface AccountMapping {
  readonly crm_category: string;
  /** A `LedgerAccount.account_code` of `account_type` 'expense'. */
  readonly erp_ledger_account_code: string;
  /** A `CostCenter.code`, or null — `JournalLine.cost_center_id` is nullable. */
  readonly erp_cost_center_code: string | null;
  readonly is_active: boolean;
  readonly updated_at: Date;
}

export interface AccountMappingInput {
  readonly crmCategory: string;
  readonly erpLedgerAccountCode: string;
  /** Omit or pass null for "post to the account with no cost-centre dimension". */
  readonly erpCostCenterCode?: string | null;
  readonly isActive?: boolean;
}

const MAPPING_COLUMNS =
  "crm_category, erp_ledger_account_code, erp_cost_center_code, is_active, updated_at";

/**
 * The ERP's own limit on both code fields — see `InvalidAccountCodeError`. Measured, not
 * assumed: `LedgerAccount.account_code` and `CostCenter.code` are both `maxLength: 32` in
 * the captured schema (`packages/acl/schema/baseline.json`).
 *
 * Exported because the API route validated these at 64 and 100 while the store refused
 * anything over 32 and 120 — both ended in a 422, so nothing was corrupted, but the route
 * advertised a contract the layer behind it rejected. One number, named once.
 */
export const ACCOUNT_CODE_MAX = 32;
export const EXPENSE_CATEGORY_MAX = 120;
const CODE_MAX = ACCOUNT_CODE_MAX;
const CATEGORY_MAX = EXPENSE_CATEGORY_MAX;

function checkedCode(field: string, value: string): string {
  if (value.length === 0 || value.length > CODE_MAX || value.trim() !== value) {
    throw new InvalidAccountCodeError(field, value);
  }
  return value;
}

function checkedCategory(value: string): string {
  if (value.trim().length === 0 || value.length > CATEGORY_MAX || value.trim() !== value) {
    throw new InvalidCategoryError(value);
  }
  return value;
}

/**
 * Creates or replaces the mapping for one category.
 *
 * An upsert rather than insert-or-fail because re-pointing a category at a different
 * account is a legitimate Finance act — a chart-of-accounts restructure, a new cost
 * centre — and it is SAFE here only because claims snapshot the codes at submit (0006).
 * Without that snapshot this upsert would silently re-attribute every historical claim
 * in the category, which is the failure ADR-0001 item 11 names explicitly.
 */
export async function upsertAccountMapping(
  tx: PoolClient,
  tenantId: string,
  input: AccountMappingInput,
): Promise<AccountMapping> {
  const category = checkedCategory(input.crmCategory);
  const account = checkedCode("erp_ledger_account_code", input.erpLedgerAccountCode);
  const costCenter =
    input.erpCostCenterCode === undefined || input.erpCostCenterCode === null
      ? null
      : checkedCode("erp_cost_center_code", input.erpCostCenterCode);

  const { rows } = await tx.query<AccountMapping>(
    `INSERT INTO crm.expense_account_map
       (tenant_id, crm_category, erp_ledger_account_code, erp_cost_center_code, is_active)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, crm_category) DO UPDATE
       SET erp_ledger_account_code = EXCLUDED.erp_ledger_account_code,
           erp_cost_center_code    = EXCLUDED.erp_cost_center_code,
           is_active               = EXCLUDED.is_active,
           updated_at              = now()
     RETURNING ${MAPPING_COLUMNS}`,
    [tenantId, category, account, costCenter, input.isActive ?? true],
  );
  return rows[0]!;
}

/**
 * Stops a category posting, without deleting the row.
 *
 * Deleting it would be worse than useless: the row is also the record of what the
 * category USED to post to, and a claim submitted last quarter carries its own snapshot
 * but an auditor asking "what was `conference` mapped to in Q3" has nowhere else to look.
 * Returns false when there was no row to deactivate.
 */
export async function deactivateAccountMapping(
  tx: PoolClient,
  tenantId: string,
  crmCategory: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE crm.expense_account_map
        SET is_active = false, updated_at = now()
      WHERE tenant_id = $1 AND crm_category = $2 AND is_active`,
    [tenantId, crmCategory],
  );
  return (rowCount ?? 0) > 0;
}

/** The ACTIVE mapping for a category, or null. Inactive rows are invisible here by design. */
export async function activeAccountMapping(
  tx: PoolClient,
  tenantId: string,
  crmCategory: string,
): Promise<AccountMapping | null> {
  const { rows } = await tx.query<AccountMapping>(
    `SELECT ${MAPPING_COLUMNS} FROM crm.expense_account_map
      WHERE tenant_id = $1 AND crm_category = $2 AND is_active`,
    [tenantId, crmCategory],
  );
  return rows[0] ?? null;
}

/**
 * The active mapping, or the refusal that names what Finance has to do.
 *
 * The one place the Finance blocker is turned into a sentence. `submitClaim` calls this
 * rather than treating a missing mapping as "no cost centre", which is the mistake the
 * nullable `erp_cost_center_code` makes easy to make: a NULL COST CENTRE is valid, a
 * missing ACCOUNT is not.
 */
export async function requireAccountMapping(
  tx: PoolClient,
  tenantId: string,
  crmCategory: string,
): Promise<AccountMapping> {
  const mapping = await activeAccountMapping(tx, tenantId, crmCategory);
  if (mapping === null) throw new UnmappedCategoryError(crmCategory);
  return mapping;
}

/** Every mapping for the tenant, newest change first. `activeOnly` defaults to false. */
export async function listAccountMappings(
  tx: PoolClient,
  tenantId: string,
  options: { readonly activeOnly?: boolean } = {},
): Promise<readonly AccountMapping[]> {
  const { rows } = await tx.query<AccountMapping>(
    `SELECT ${MAPPING_COLUMNS} FROM crm.expense_account_map
      WHERE tenant_id = $1 AND ($2::boolean IS NOT TRUE OR is_active)
      ORDER BY crm_category`,
    [tenantId, options.activeOnly ?? false],
  );
  return rows;
}

/**
 * Categories that have claims but no active mapping — the Finance to-do list.
 *
 * Draft claims only: anything past draft already carries its snapshot, so re-mapping its
 * category would not change it and listing it here would be noise. This is the query that
 * turns "expense posting is blocked on Finance" from a sentence in an ADR into a number
 * somebody can watch go to zero.
 */
export async function unmappedCategoriesWithClaims(
  tx: PoolClient,
  tenantId: string,
): Promise<readonly { readonly crm_category: string; readonly draft_claims: number }[]> {
  const { rows } = await tx.query<{ crm_category: string; draft_claims: string }>(
    `SELECT c.crm_category, count(*)::text AS draft_claims
       FROM crm.expense_claim c
       LEFT JOIN crm.expense_account_map m
              ON m.tenant_id = c.tenant_id AND m.crm_category = c.crm_category AND m.is_active
      WHERE c.tenant_id = $1 AND c.state = 'draft' AND m.crm_category IS NULL
      GROUP BY c.crm_category
      ORDER BY c.crm_category`,
    [tenantId],
  );
  return rows.map((r) => ({ crm_category: r.crm_category, draft_claims: Number(r.draft_claims) }));
}
