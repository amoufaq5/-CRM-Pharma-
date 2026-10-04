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
 *
 * It also REPORTS THE EFFECTIVE ROLE, in the same round trip, for the privilege check
 * below. `current_user` reflects a `SET ROLE`, so this is the role the queries will
 * actually run under rather than the one the connection was opened with — and it is
 * free: measured against a live cluster it costs nothing over the bare `set_config`,
 * where asking the catalog for the role's attributes in the same statement costs ~82 µs.
 * That is why the attributes are looked up separately and cached.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true) AS tenant, current_user AS effective_role";

/** Asked once per distinct role name per process — see `withTenantContext`. */
export const ROLE_PRIVILEGE_SQL =
  "SELECT rolsuper OR rolbypassrls AS bypasses_rls FROM pg_roles WHERE rolname = $1";

/**
 * Whether a role is exempt from row-level security, by role NAME.
 *
 * Keyed on the name rather than on the client, because a connection's role can change
 * under `SET ROLE` — which the fixtures in this repo rely on — and a cache keyed on the
 * client would answer for whichever role it happened to see first. Role attributes are
 * cluster-wide, so the name is the whole key.
 *
 * The consequence to know: `ALTER ROLE crm_app BYPASSRLS` on a running system is not
 * picked up until the process restarts. That is a superuser action on a role the
 * deployment creates `NOSUPERUSER NOBYPASSRLS`, and paying ~82 µs on every transaction
 * to notice it sooner is the wrong trade.
 */
const bypassesRlsByRole = new Map<string, boolean>();

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
 * The connection's role is exempt from row-level security, so tenant context would be
 * decoration on it.
 *
 * `deploy/README.md` states this as the isolation guarantee — "if an application process
 * connected as the admin, every query would see every tenant's rows and every RLS policy
 * in the schema would be decoration" — and until now nothing enforced it. A superuser
 * bypasses RLS unconditionally, even under `FORCE`; a role with `BYPASSRLS` the same. A
 * `PGUSER=postgres` in a compose file or a CI job therefore turned every policy off, and
 * the symptom was not an error but silently wider results.
 *
 * It is a loud failure for a reason: the alternative is a system that appears to work.
 */
export class PrivilegedConnectionError extends Error {
  constructor(readonly role: string) {
    super(
      `refusing to set tenant context on a connection whose role (${role}) is exempt from ` +
        `row-level security — RLS would not apply and every query would see every tenant. ` +
        `Connect as crm_app (NOSUPERUSER NOBYPASSRLS), or SET ROLE to it first.`,
    );
    this.name = "PrivilegedConnectionError";
  }
}

/**
 * Runs `fn` inside a transaction with the tenant RLS context established, and
 * is the ONLY sanctioned way to reach a `crm.*` table. Rolls back on throw.
 *
 * Fails closed three times over:
 *
 *  1. a malformed tenant id throws before any statement runs;
 *  2. a connection whose role is exempt from RLS is REFUSED, because setting tenant
 *     context on one is theatre — see `PrivilegedConnectionError`;
 *  3. a query issued without this wrapper sees `current_setting(..., true)` return NULL,
 *     making the policy predicate NULL — which returns no rows rather than all of them.
 *
 * All three are verified live in `rls.contract.test.ts`.
 *
 * The order of (1) and (2) is deliberate: the pure check runs first, so a malformed
 * tenant id is reported as one whatever connection it arrives on.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) throw new InvalidTenantIdError(tenantId);
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<{ effective_role: string }>(SET_TENANT_CONTEXT_SQL, [
      tenantId,
    ]);
    // A role the server did not name is not a pass. A missing row here would mean the
    // statement did not run as written, and defaulting to "fine" is how a guard becomes
    // a comment.
    const role = rows[0]?.effective_role;
    if (role === undefined) throw new PrivilegedConnectionError("unknown");

    let bypasses = bypassesRlsByRole.get(role);
    if (bypasses === undefined) {
      const answer = await client.query<{ bypasses_rls: boolean }>(ROLE_PRIVILEGE_SQL, [role]);
      // `!== false` rather than `=== true`: a role the catalog does not know about, or a
      // verdict that arrives in an unexpected shape, is refused rather than admitted.
      bypasses = answer.rows[0]?.bypasses_rls !== false;
      bypassesRlsByRole.set(role, bypasses);
    }
    if (bypasses) throw new PrivilegedConnectionError(role);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
