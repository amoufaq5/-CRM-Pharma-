import { withTenantContext } from "@crm/db";
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

  const row = await withTenantContext(client, tenantId, async (tx) => {
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
    return rows[0] ?? null;
  });

  if (row === null) {
    // Deliberately the same shape as a wrong tenant: distinguishing "no such rep
    // here" from "wrong tenant" would let a caller enumerate which tenants a
    // subject belongs to.
    throw forbidden("this identity is not a rep in that tenant");
  }
  if (row.status !== "active") {
    throw forbidden(`this rep profile is ${row.status}`);
  }

  return {
    tenantId,
    repProfileId: row.id,
    subject: claims.sub,
    displayName: row.display_name,
    erpEmployeeId: row.erp_employee_id,
  };
}
