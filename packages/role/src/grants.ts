/**
 * Granting and revoking. Both writes go through here; both are audited by the row
 * they leave behind rather than by a separate log.
 */
import type { PoolClient } from "pg";
import { UnknownRoleError, translateRoleError } from "./errors.js";
import { getGrant, isRole, type Role, type RoleGrant } from "./roles.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface GrantRoleInput {
  readonly repProfileId: string;
  readonly role: string;
  readonly grantedBy: string;
  /** Defaults to today. A future date appoints a successor in advance. */
  readonly validFrom?: string;
  /** A time-boxed role: an interim appointment that lapses on its own. */
  readonly validTo?: string | null;
  readonly reason?: string | null;
}

/**
 * Grant a role.
 *
 * The four-eyes rule, the overlap rule and the role vocabulary are all the database's
 * — this function supplies the row and translates the refusal. It does NOT check that
 * `grantedBy` is an administrator: that is the caller's authorisation decision and it
 * belongs at the route, where the principal is, not here where any job could pass any
 * uuid and look authorised.
 */
export async function grantRole(
  tx: PoolClient,
  tenantId: string,
  input: GrantRoleInput,
): Promise<RoleGrant> {
  if (!isRole(input.role)) throw new UnknownRoleError(input.role);
  assertOptionalDate("validFrom", input.validFrom);
  assertOptionalDate("validTo", input.validTo ?? undefined);

  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO crm.rep_role
         (tenant_id, rep_profile_id, role, granted_by, grant_reason, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7::date)
       RETURNING id`,
      [
        tenantId,
        input.repProfileId,
        input.role,
        input.grantedBy,
        input.reason ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
      ],
    );
    // Re-read so the caller gets the same shape listGrants returns, names included.
    return (await getGrant(tx, tenantId, rows[0]!.id))!;
  } catch (err) {
    throw translateRoleError(err, { role: input.role, from: input.validFrom ?? "today" });
  }
}

export interface RevokeRoleInput {
  readonly revokedBy: string;
  /** Defaults to today; clamped into the grant's own window by crm.revoke_rep_role. */
  readonly on?: string;
  readonly reason?: string | null;
}

/**
 * End a grant.
 *
 * Returns null when no such grant exists in the caller's tenant — the tenant is matched
 * explicitly rather than left to RLS, so a connection whose role bypasses the policy
 * still cannot reach across. A
 * grant that exists and is already ended raises instead: a retried revoke is a
 * no-change, but revoking something already revoked is a caller who has lost track.
 */
export async function revokeRole(
  tx: PoolClient,
  tenantId: string,
  grantId: string,
  input: RevokeRoleInput,
): Promise<RoleGrant | null> {
  assertOptionalDate("on", input.on);
  try {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT crm.revoke_rep_role($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5) AS ok`,
      [grantId, tenantId, input.revokedBy, input.on ?? null, input.reason ?? null],
    );
    if (rows[0]?.ok !== true) return null;
    return await getGrant(tx, tenantId, grantId);
  } catch (err) {
    throw translateRoleError(err);
  }
}

function assertOptionalDate(label: string, value: string | undefined): void {
  if (value === undefined) return;
  if (!DATE_RE.test(value)) {
    throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    throw new RangeError(`${label} is not a real calendar date: ${value}`);
  }
}
