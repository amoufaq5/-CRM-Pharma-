import { withTenantContext } from "@crm/db";
import { rolesNow, type Role } from "@crm/role";
import type { PoolClient } from "pg";
import { forbidden, unauthenticated } from "./problems.js";
import type { JwtClaims } from "./jwt.js";

export interface Principal {
  readonly tenantId: string;
  readonly repProfileId: string;
  readonly subject: string;
  readonly displayName: string;
  /** The rep's own ERP Employee id, when the mapping has been reconciled. */
  readonly erpEmployeeId: string | null;
  /**
   * The administrative roles this rep holds RIGHT NOW (0023). Sorted; usually empty.
   *
   * Resolved once per request, with the principal, under the same tenant context — so
   * an administrative route costs no extra round trip and cannot read a role from a
   * connection whose tenant GUC was set by something else.
   *
   * As-of today, never as-of a query parameter. `?on=` scopes what a READ returns and
   * several routes honour it; letting it reach an authorisation decision would let a
   * caller pick the date on which they were an administrator.
   */
  readonly roles: readonly Role[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a verified token into a CRM principal.
 *
 * The mapping is `crm.rep_profile.subject`, the table ADR-0001 Q3 exists for:
 * nothing in the ERP links a login to an Employee, so the CRM owns that link.
 *
 * The tenant comes from the token's `tenant` claim when the IdP issues one, and
 * otherwise must be supplied by the caller (a header) — but EITHER WAY the
 * (tenant, subject) pair must resolve to a rep_profile row. A subject that does
 * not is refused, so a valid token from the right IdP for a person who is not a
 * rep in that tenant gets nothing. That is the whole point of authorising here
 * rather than at the ERP, which cannot scope a read at all (report R2).
 *
 * A suspended or departed rep is refused too. Their token stays cryptographically
 * valid until it expires, so "still has a token" must not mean "still has access".
 */
export async function resolvePrincipal(
  client: PoolClient,
  claims: JwtClaims,
  tenantHint: string | null,
): Promise<Principal> {
  const tenantId = typeof claims.tenant === "string" ? claims.tenant : tenantHint;
  if (tenantId === null || !UUID_RE.test(tenantId)) {
    throw unauthenticated(
      "no tenant could be determined — the token carries no `tenant` claim and no valid x-tenant-id header was sent",
    );
  }

  const resolved = await withTenantContext(client, tenantId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      display_name: string;
      status: string;
      erp_employee_id: string | null;
    }>(
      `SELECT id, display_name, status, erp_employee_id
         FROM crm.rep_profile WHERE tenant_id = $1 AND subject = $2`,
      [tenantId, claims.sub],
    );
    const found = rows[0];
    if (found === undefined) return null;
    // In the same tenant context as the profile lookup, deliberately: a role read on a
    // connection whose GUC had drifted would be answered by RLS for another tenant.
    return { row: found, roles: await rolesNow(tx, found.id) };
  });

  if (resolved === null) {
    // Deliberately the same shape as a wrong tenant: distinguishing "no such rep
    // here" from "wrong tenant" would let a caller enumerate which tenants a
    // subject belongs to.
    throw forbidden("this identity is not a rep in that tenant");
  }
  const { row, roles } = resolved;
  if (row.status !== "active") {
    throw forbidden(`this rep profile is ${row.status}`);
  }

  return {
    tenantId,
    repProfileId: row.id,
    subject: claims.sub,
    displayName: row.display_name,
    erpEmployeeId: row.erp_employee_id,
    roles,
  };
}

/**
 * Refuses a caller who does not hold the role an administrative route requires.
 *
 * 403, NOT the 404 the supervision helpers return. The two refusals protect different
 * things: `requireSupervision` hides whether a rep exists, because the id itself is
 * information a rep should not be able to probe for. An administrative route guards
 * the tenant's OWN configuration, whose existence is no secret to a member of that
 * tenant — several of these resources are already readable by every rep. A 404 there
 * would only mislead an administrator who had lost their grant into hunting for a
 * typo in the URL.
 */
export function requireRole(p: Principal, role: Role): void {
  if (!p.roles.includes(role)) {
    throw forbidden(`this action requires the ${role} role`);
  }
}
