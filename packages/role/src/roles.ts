/**
 * The administrative roles, and the one predicate that decides who holds them.
 *
 * Every function here is a thin wrapper over SQL from migration 0023. That is the
 * point: the rule lives in the database so the API, a job and a psql prompt cannot
 * reach three different conclusions about who may configure a tenant.
 */
import type { PoolClient } from "pg";

/**
 * The closed set. Not a lookup table, because a role nothing checks is worse than no
 * role at all — adding one means adding the route that honours it, which means a
 * migration either way.
 */
export const ROLES = ["administrator", "compliance"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export interface RoleGrant {
  readonly id: string;
  readonly rep_profile_id: string;
  readonly rep_display_name: string;
  readonly role: Role;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly granted_by: string;
  readonly granted_by_name: string;
  readonly granted_at: string;
  readonly grant_reason: string | null;
  readonly revoked_by: string | null;
  readonly revoked_by_name: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  /** Whether the grant is in force on the date the query asked about. */
  readonly in_force: boolean;
}

export interface RoleHolder {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
  readonly valid_from: string;
  readonly granted_by: string;
}

/**
 * Every role this rep holds, as of a date.
 *
 * `asOf` exists for the audit question ("who was the compliance officer in March")
 * and must NOT be used to authorise a write — see requireRole in @crm/api, and
 * `rolesNow` below, which is the function a write path should reach for.
 */
export async function repRoles(tx: PoolClient, repProfileId: string, asOf?: string): Promise<readonly Role[]> {
  const { rows } = await tx.query<{ roles: string[] }>(
    `SELECT crm.rep_roles($1, COALESCE($2::date, CURRENT_DATE)) AS roles`,
    [repProfileId, asOf ?? null],
  );
  return (rows[0]?.roles ?? []).filter(isRole);
}

/**
 * The roles a rep holds right now.
 *
 * Separate from `repRoles` with no date parameter at all, because authorisation is
 * always a question about the present and a date parameter on the path that answers
 * it is a date parameter somebody will eventually pass from a query string.
 */
export async function rolesNow(tx: PoolClient, repProfileId: string): Promise<readonly Role[]> {
  return repRoles(tx, repProfileId);
}

export async function hasRole(tx: PoolClient, repProfileId: string, role: Role, asOf?: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT crm.rep_has_role($1, $2, COALESCE($3::date, CURRENT_DATE)) AS ok`,
    [repProfileId, role, asOf ?? null],
  );
  return rows[0]?.ok === true;
}

/** Who holds a role, as of a date. */
export async function roleHolders(tx: PoolClient, role: Role, asOf?: string): Promise<readonly RoleHolder[]> {
  const { rows } = await tx.query<RoleHolder>(
    `SELECT rep_profile_id, display_name, employee_number, valid_from::text AS valid_from, granted_by
       FROM crm.role_holders($1, COALESCE($2::date, CURRENT_DATE))`,
    [role, asOf ?? null],
  );
  return rows;
}

export interface ListGrantsOptions {
  readonly repProfileId?: string;
  readonly role?: Role;
  /** Default false — the live picture. True also returns ended and never-effective grants. */
  readonly includeEnded?: boolean;
  readonly asOf?: string;
}

/**
 * The grant log, newest first, with both parties named.
 *
 * Names are joined in rather than left to the caller because the only reason to read
 * this table is to answer "who gave whom what", and a list of UUIDs answers neither
 * half of that.
 */
export async function listGrants(
  tx: PoolClient,
  tenantId: string,
  options: ListGrantsOptions = {},
): Promise<readonly RoleGrant[]> {
  const { rows } = await tx.query<RoleGrant>(
    `SELECT r.id,
            r.rep_profile_id,
            rp.display_name                                   AS rep_display_name,
            r.role,
            r.valid_from::text                                AS valid_from,
            r.valid_to::text                                  AS valid_to,
            r.granted_by,
            gb.display_name                                   AS granted_by_name,
            r.granted_at::text                                AS granted_at,
            r.grant_reason,
            r.revoked_by,
            rb.display_name                                   AS revoked_by_name,
            r.revoked_at::text                                AS revoked_at,
            r.revoke_reason,
            (r.valid_from <= COALESCE($4::date, CURRENT_DATE)
              AND (r.valid_to IS NULL
                   OR r.valid_to > COALESCE($4::date, CURRENT_DATE)))  AS in_force
       FROM crm.rep_role r
       JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
       JOIN crm.rep_profile gb ON gb.id = r.granted_by
       LEFT JOIN crm.rep_profile rb ON rb.id = r.revoked_by
      WHERE r.tenant_id = $1
        AND ($2::uuid IS NULL OR r.rep_profile_id = $2::uuid)
        AND ($3::text IS NULL OR r.role = $3::text)
        -- COALESCE, not a bare $4: an omitted asOf made every date comparison NULL and
        -- the live listing came back empty, which looks exactly like "nobody holds a
        -- role". The default is today, as it is in every function in 0023.
        AND ($5::boolean
             OR (r.valid_from <= COALESCE($4::date, CURRENT_DATE)
                 AND (r.valid_to IS NULL OR r.valid_to > COALESCE($4::date, CURRENT_DATE))))
      ORDER BY r.granted_at DESC, r.id`,
    [
      tenantId,
      options.repProfileId ?? null,
      options.role ?? null,
      options.asOf ?? null,
      options.includeEnded ?? false,
    ],
  );
  return rows;
}

/** Scoped by tenant explicitly, for the reason crm.revoke_rep_role is (0023). */
export async function getGrant(tx: PoolClient, tenantId: string, id: string): Promise<RoleGrant | null> {
  const { rows } = await tx.query<RoleGrant>(
    `SELECT r.id, r.rep_profile_id, rp.display_name AS rep_display_name, r.role,
            r.valid_from::text AS valid_from, r.valid_to::text AS valid_to,
            r.granted_by, gb.display_name AS granted_by_name, r.granted_at::text AS granted_at,
            r.grant_reason, r.revoked_by, rb.display_name AS revoked_by_name,
            r.revoked_at::text AS revoked_at, r.revoke_reason,
            (r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to > CURRENT_DATE)) AS in_force
       FROM crm.rep_role r
       JOIN crm.rep_profile rp ON rp.id = r.rep_profile_id
       JOIN crm.rep_profile gb ON gb.id = r.granted_by
       LEFT JOIN crm.rep_profile rb ON rb.id = r.revoked_by
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}
