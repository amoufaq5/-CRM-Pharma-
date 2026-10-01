import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

/**
 * Which ERP role a tenant's CRM service principal holds, and under what subject.
 *
 * An interface because the Postgres implementation is not the only sensible one —
 * a single-tenant deployment can configure it statically — and because the tests
 * for the minter should not need a database.
 */
export interface ServiceRoleSource {
  roleFor(tenantId: string): Promise<ResolvedServiceRole>;
}

export interface ResolvedServiceRole {
  readonly role: string;
  /** Null means "use the minter's default subject for this tenant". */
  readonly subject: string | null;
}

/**
 * No role is configured for this tenant, or it has been disabled.
 *
 * A distinct error type because the relay must treat it as a configuration fault
 * and not as a transient ERP failure: retrying it on a backoff curve forever
 * would hide the fact that someone has to add a row.
 */
export class ServiceRoleUnavailableError extends Error {
  readonly tenantId: string;
  constructor(tenantId: string, reason: string) {
    super(
      `no usable ERP service role for tenant ${tenantId}: ${reason}. ` +
        `Insert a row into crm.erp_service_principal — there is deliberately no default, ` +
        `because defaulting an unconfigured tenant to a privileged role would work.`,
    );
    this.name = "ServiceRoleUnavailableError";
    this.tenantId = tenantId;
  }
}

/** Fixed mapping, for a single-tenant deployment and for tests. */
export class StaticServiceRoleSource implements ServiceRoleSource {
  private readonly byTenant: Map<string, ResolvedServiceRole>;

  constructor(entries: Readonly<Record<string, string | ResolvedServiceRole>>) {
    this.byTenant = new Map(
      Object.entries(entries).map(([tenantId, v]) => [
        tenantId.toLowerCase(),
        typeof v === "string" ? { role: v, subject: null } : v,
      ]),
    );
  }

  roleFor(tenantId: string): Promise<ResolvedServiceRole> {
    const found = this.byTenant.get(tenantId.toLowerCase());
    if (found === undefined) {
      return Promise.reject(new ServiceRoleUnavailableError(tenantId, "not in the static role map"));
    }
    return Promise.resolve(found);
  }
}

export interface PostgresServiceRoleSourceOptions {
  readonly pool: Pool;
  /** How long a resolved role is reused. Default 5 minutes. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Reads `crm.erp_service_principal`.
 *
 * Cached, because a token mint would otherwise cost a round trip per ERP call on
 * the first request of every refresh window. Only SUCCESSES are cached: a missing
 * or disabled row is re-read every time, so enabling a tenant takes effect at once
 * rather than after a TTL — the asymmetry is on purpose, since the cost of a
 * stale "no" is a tenant that stays broken after someone fixed it.
 */
export class PostgresServiceRoleSource implements ServiceRoleSource {
  private readonly opts: PostgresServiceRoleSourceOptions;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { readonly value: ResolvedServiceRole; readonly expiresAt: number }>();

  constructor(opts: PostgresServiceRoleSourceOptions) {
    this.opts = opts;
    this.ttl = opts.cacheTtlMs ?? 300_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async roleFor(tenantId: string): Promise<ResolvedServiceRole> {
    const key = tenantId.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) return hit.value;

    const client = await this.opts.pool.connect();
    let row: { erp_role: string; subject: string | null; enabled: boolean } | undefined;
    try {
      row = await withTenantContext(client, tenantId, async (tx: PoolClient) => {
        const { rows } = await tx.query<{ erp_role: string; subject: string | null; enabled: boolean }>(
          `SELECT erp_role, subject, enabled FROM crm.erp_service_principal WHERE tenant_id = $1`,
          [tenantId],
        );
        return rows[0];
      });
    } finally {
      client.release();
    }

    if (row === undefined) throw new ServiceRoleUnavailableError(tenantId, "no crm.erp_service_principal row");
    if (!row.enabled) throw new ServiceRoleUnavailableError(tenantId, "the row is disabled");

    const value: ResolvedServiceRole = { role: row.erp_role, subject: row.subject };
    this.cache.set(key, { value, expiresAt: this.now() + this.ttl });
    return value;
  }

  /** Drops the cache, so a role change takes effect without a restart. */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId.toLowerCase());
  }
}
