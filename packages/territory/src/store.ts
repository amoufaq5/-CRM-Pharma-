import type { PoolClient } from "pg";
import { assertDate, assertRange, translatePgError } from "./errors.js";

export interface Territory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly status: string;
}

export interface TerritoryAssignment {
  readonly id: string;
  readonly territory_id: string;
  readonly rep_profile_id: string;
  readonly role: "primary" | "secondary" | "manager";
  readonly valid_from: string;
  readonly valid_to: string | null;
}

export interface AccountAssignment {
  readonly id: string;
  readonly erp_account_id: string;
  readonly territory_id: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
}

export async function createTerritory(
  tx: PoolClient,
  tenantId: string,
  input: { code: string; name: string; parentId?: string | null },
): Promise<Territory> {
  try {
    const { rows } = await tx.query<Territory>(
      `INSERT INTO crm.territory (tenant_id, code, name, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, parent_id, status`,
      [tenantId, input.code, input.name, input.parentId ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw translatePgError(err, `territory ${input.code}`, "");
  }
}

export async function setTerritoryParent(
  tx: PoolClient,
  tenantId: string,
  territoryId: string,
  parentId: string | null,
): Promise<void> {
  try {
    await tx.query("UPDATE crm.territory SET parent_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      territoryId,
      parentId,
    ]);
  } catch (err) {
    throw translatePgError(err, `territory ${territoryId}`, "");
  }
}

export async function assignRep(
  tx: PoolClient,
  tenantId: string,
  input: {
    territoryId: string;
    repProfileId: string;
    role?: "primary" | "secondary" | "manager";
    validFrom: string;
    validTo?: string | null;
  },
): Promise<TerritoryAssignment> {
  assertRange(input.validFrom, input.validTo ?? null);
  try {
    const { rows } = await tx.query<TerritoryAssignment>(
      `INSERT INTO crm.territory_assignment
         (tenant_id, territory_id, rep_profile_id, role, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, territory_id, rep_profile_id, role, valid_from::text, valid_to::text`,
      [tenantId, input.territoryId, input.repProfileId, input.role ?? "primary", input.validFrom, input.validTo ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw translatePgError(err, `rep ${input.repProfileId} on territory ${input.territoryId}`, input.validFrom);
  }
}

/**
 * Ends a rep's coverage of a territory on `endDate`.
 *
 * `valid_to` is EXCLUSIVE, so passing the first day they no longer cover it is
 * the natural reading: "ended on the 1st" means the 31st was their last day.
 * Only open-ended rows are closed — an assignment that already has an end date
 * was deliberately bounded and is not ours to move.
 */
export async function endRepAssignment(
  tx: PoolClient,
  tenantId: string,
  input: { territoryId: string; repProfileId: string; endDate: string },
): Promise<number> {
  assertDate("endDate", input.endDate);
  const { rowCount } = await tx.query(
    `UPDATE crm.territory_assignment SET valid_to = $4
      WHERE tenant_id = $1 AND territory_id = $2 AND rep_profile_id = $3
        AND valid_to IS NULL AND valid_from < $4`,
    [tenantId, input.territoryId, input.repProfileId, input.endDate],
  );
  return rowCount ?? 0;
}

export async function assignAccount(
  tx: PoolClient,
  tenantId: string,
  input: { erpAccountId: string; territoryId: string; validFrom: string; validTo?: string | null },
): Promise<AccountAssignment> {
  assertRange(input.validFrom, input.validTo ?? null);
  try {
    const { rows } = await tx.query<AccountAssignment>(
      `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, erp_account_id, territory_id, valid_from::text, valid_to::text`,
      [tenantId, input.erpAccountId, input.territoryId, input.validFrom, input.validTo ?? null],
    );
    return rows[0]!;
  } catch (err) {
    throw translatePgError(err, `account ${input.erpAccountId}`, input.validFrom);
  }
}

/**
 * Moves an account to a different territory from `effectiveFrom`.
 *
 * THE operation this table exists for, and the one that must be atomic: it
 * closes the current assignment and opens the new one in a single statement
 * pair. Doing it in two calls leaves a window where the account belongs to
 * nobody (if the close lands first) or to two territories (if the open does) —
 * and the second is refused by the exclusion constraint, so a careless caller
 * gets a confusing error instead of a moved account.
 *
 * Returns the new assignment. History is preserved: the old row keeps its dates,
 * so `crm.account_owners_on` still answers correctly for last quarter.
 */
export async function reassignAccount(
  tx: PoolClient,
  tenantId: string,
  input: { erpAccountId: string; toTerritoryId: string; effectiveFrom: string },
): Promise<AccountAssignment> {
  assertDate("effectiveFrom", input.effectiveFrom);
  try {
    await tx.query(
      `UPDATE crm.account_assignment SET valid_to = $3
        WHERE tenant_id = $1 AND erp_account_id = $2
          AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $3)`,
      [tenantId, input.erpAccountId, input.effectiveFrom],
    );
    const { rows } = await tx.query<AccountAssignment>(
      `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
       VALUES ($1, $2, $3, $4)
       RETURNING id, erp_account_id, territory_id, valid_from::text, valid_to::text`,
      [tenantId, input.erpAccountId, input.toTerritoryId, input.effectiveFrom],
    );
    return rows[0]!;
  } catch (err) {
    throw translatePgError(err, `account ${input.erpAccountId}`, input.effectiveFrom);
  }
}

// ---------------------------------------------------------------------------
// Visibility. Thin wrappers over the SQL functions — the definition lives in
// the database so every caller gets the same answer (migration 0011).
// ---------------------------------------------------------------------------

export async function visibleAccountIds(
  tx: PoolClient,
  repProfileId: string,
  onDate?: string,
): Promise<readonly string[]> {
  if (onDate !== undefined) assertDate("onDate", onDate);
  const { rows } = await tx.query<{ erp_account_id: string }>(
    "SELECT erp_account_id FROM crm.visible_account_ids($1, COALESCE($2::date, CURRENT_DATE)) ORDER BY 1",
    [repProfileId, onDate ?? null],
  );
  return rows.map((r) => r.erp_account_id);
}

export async function visibleTerritoryIds(
  tx: PoolClient,
  repProfileId: string,
  onDate?: string,
): Promise<readonly string[]> {
  if (onDate !== undefined) assertDate("onDate", onDate);
  const { rows } = await tx.query<{ territory_id: string }>(
    "SELECT territory_id FROM crm.visible_territory_ids($1, COALESCE($2::date, CURRENT_DATE))",
    [repProfileId, onDate ?? null],
  );
  return rows.map((r) => r.territory_id);
}

export async function canSeeAccount(
  tx: PoolClient,
  repProfileId: string,
  erpAccountId: string,
  onDate?: string,
): Promise<boolean> {
  if (onDate !== undefined) assertDate("onDate", onDate);
  const { rows } = await tx.query<{ ok: boolean }>(
    "SELECT crm.rep_can_see_account($1, $2, COALESCE($3::date, CURRENT_DATE)) AS ok",
    [repProfileId, erpAccountId, onDate ?? null],
  );
  return rows[0]?.ok ?? false;
}

export interface AccountOwner {
  readonly rep_profile_id: string;
  readonly territory_id: string;
  readonly role: string;
}

/**
 * Who covered an account on a date.
 *
 * The question an incentive run asks, and the reason these tables keep history
 * rather than current state — the ERP overwrites an assignment and cannot answer
 * it at all.
 */
export async function accountOwnersOn(
  tx: PoolClient,
  erpAccountId: string,
  onDate?: string,
): Promise<readonly AccountOwner[]> {
  if (onDate !== undefined) assertDate("onDate", onDate);
  const { rows } = await tx.query<AccountOwner>(
    "SELECT rep_profile_id, territory_id, role FROM crm.account_owners_on($1, COALESCE($2::date, CURRENT_DATE))",
    [erpAccountId, onDate ?? null],
  );
  return rows;
}
