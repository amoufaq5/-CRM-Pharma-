import type { PoolClient } from "pg";

/**
 * Sets `app.current_tenant_id` for the CURRENT TRANSACTION only
 * (`set_config(..., is_local => true)`), which is what the row-level-security
 * policy on every `crm.*` table reads:
 *
 *   USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
 *
 * Deliberately identical to the ERP's own `withTenantContext`
 * (`operate-runtime-pg/src/tenant-context.ts`) so one mental model covers both
 * schemas. A `SELECT set_config(...)` is used rather than `SET LOCAL` so the
 * tenant id rides as a bound `$1` parameter instead of being interpolated into
 * SQL text.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * A stricter shape than the ERP's `/^[0-9a-fA-F-]{1,64}$/`, which accepts `-`,
 * `--`, and a 64-character run of hyphens. Tenant ids are UUIDs; anything else
 * is a bug or an attack, and widening RLS scope is the failure mode.
 */
const TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`invalid tenantId for RLS context: ${JSON.stringify(value)}`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Runs `fn` inside a transaction with the tenant RLS context established, and
 * is the ONLY sanctioned way to reach a `crm.*` table. Rolls back on throw.
 *
 * Fails closed twice over: a malformed tenant id throws before any statement
 * runs, and a query issued without this wrapper sees `current_setting(...,
 * true)` return NULL, making the policy predicate NULL — which returns no rows
 * rather than all of them. Verified live in `rls.contract.test.ts`.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) throw new InvalidTenantIdError(tenantId);
  await client.query("BEGIN");
  try {
    await client.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
