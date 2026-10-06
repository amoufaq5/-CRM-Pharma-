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
 * The connection is already inside a transaction, so this wrapper would commit it.
 *
 * FOUND BY A TEST THAT PASSED. Migration 0051's contract suite wrapped its mutations in an
 * explicit transaction for isolation and rolled back in a `finally`. Postgres makes a `BEGIN`
 * inside an open transaction a no-op with `WARNING 25001: there is already a transaction in
 * progress`, so the `COMMIT` below ended the CALLER'S transaction and the rollback had nothing
 * left to undo: the mutation was committed, nineteen retention dispositions were silently
 * redecided for every test that ran afterwards, and the suite stayed green because the tests
 * that would have noticed ran earlier.
 *
 * WHY THIS REFUSES RATHER THAN NESTING WITH A SAVEPOINT, which is the obvious alternative and
 * is wrong for two reasons:
 *
 *   * `SET_TENANT_CONTEXT_SQL` sets the GUC with `is_local = true`, so it lives for the
 *     TRANSACTION. Nested in a caller's transaction it would still be set after this block
 *     returned, and every later statement the caller believes is unscoped would be silently
 *     confined to that tenant — or, on a write, attributed to it. That is a worse version of
 *     the bug being fixed: wrong rows instead of a wrong commit.
 *   * The guarantee would change meaning. Every caller reads this function as "my work
 *     committed under this tenant's RLS". Nested, it can only promise "staged in somebody
 *     else's transaction, which may yet roll it back". Silently weakening that for one call
 *     shape is the same class of trap.
 *
 * So the remedy is the caller's: hand this wrapper a client that is not mid-transaction, or do
 * the surrounding work inside `fn`. No production caller does either today — every one takes a
 * pool client and hands it straight over — which is why this never bit outside a test.
 *
 * THE MECHANISM WAS ALREADY WRITTEN DOWN IN THIS REPOSITORY, which is the uncomfortable part.
 * `ClientAlreadyInTenantContextError` in `@crm/expense`'s sweeper says it exactly — "Postgres
 * answers a nested `BEGIN` with a warning and the first `COMMIT` would end the caller's
 * transaction, committing whatever it had done so far and leaving the rest of its work
 * unwrapped" — and has since the sweep was built. It guarded ONE caller. The function that
 * issues the `BEGIN` and the `COMMIT` had no guard at all.
 *
 * Both stay. They ask different questions and the sweeper's is the better-aimed one for its
 * caller: it asks whether `app.current_tenant_id` is set, which is a proxy for "you are inside
 * a `withTenantContext` transaction", and it answers before any work with a sentence naming the
 * sweep and the tenant. This asks the backend whether the connection is in ANY transaction,
 * which is strictly more general — it catches a caller's own `BEGIN`, which no GUC reveals —
 * but it can only fire on the first wrapped call, which for a per-claim loop is later and less
 * useful. A layered rule, in the shape this schema's four-eyes checks already use.
 */
export class TransactionAlreadyOpenError extends Error {
  constructor(readonly status: "T" | "E") {
    super(
      status === "E"
        ? `refusing to set tenant context on a connection whose transaction has already failed ` +
          `(status E) — every statement on it will be rejected until it is rolled back. ROLLBACK first.`
        : `refusing to set tenant context on a connection that is already inside a transaction ` +
          `(status T) — this wrapper issues BEGIN and COMMIT, and Postgres treats a nested BEGIN ` +
          `as a no-op, so the COMMIT would end YOUR transaction and a later ROLLBACK would undo ` +
          `nothing. Pass a client that is not mid-transaction, or move the surrounding work into ` +
          `the callback.`,
    );
    this.name = "TransactionAlreadyOpenError";
  }
}

/**
 * What the backend last said about this connection's transaction, or null when we cannot ask.
 *
 * `getTransactionStatus()` is a public method on node-postgres's `Client` (pg 8.23,
 * `lib/client.js`) returning the status byte from the last `ReadyForQuery` message: `I` idle,
 * `T` in a transaction, `E` in a failed one. It is not in `@types/pg`, which is the only reason
 * this needs a cast — measured rather than assumed, with every value above observed against a
 * real connection.
 *
 * ABSENT MEANS PROCEED, which is a fail-OPEN branch in a file whose argument is fail-closed, so
 * it needs its reason: a client without this method is not a node-postgres `Client` — it is a
 * hand-written fake, and a fake has no backend and therefore no transaction to clobber.
 * Refusing instead would turn every unit test in this package into a failure without making one
 * real deployment safer. The fakes in `tenant-context.test.ts` answer it anyway, so the guard
 * below is exercised by the unit tests and not only by the live suite.
 */
function transactionStatus(client: PoolClient): "I" | "T" | "E" | null {
  const ask = (client as unknown as { getTransactionStatus?: () => unknown }).getTransactionStatus;
  if (typeof ask !== "function") return null;
  const status = ask.call(client);
  return status === "T" || status === "E" || status === "I" ? status : null;
}

/**
 * Runs `fn` inside a transaction with the tenant RLS context established, and
 * is the ONLY sanctioned way to reach a `crm.*` table. Rolls back on throw.
 *
 * Fails closed four times over:
 *
 *  1. a malformed tenant id throws before any statement runs;
 *  2. a connection ALREADY inside a transaction is REFUSED, because the COMMIT below would
 *     end the caller's — see `TransactionAlreadyOpenError`;
 *  3. a connection whose role is exempt from RLS is REFUSED, because setting tenant
 *     context on one is theatre — see `PrivilegedConnectionError`;
 *  4. a query issued without this wrapper sees `current_setting(..., true)` return NULL,
 *     making the policy predicate NULL — which returns no rows rather than all of them.
 *
 * All four are verified live in `rls.contract.test.ts`.
 *
 * The order is deliberate throughout. (1) is pure, so a malformed tenant id is reported as one
 * whatever connection it arrives on. (2) comes before (3) because asking the catalog for the
 * role's privileges is itself a query, and issuing one on a connection whose transaction has
 * already failed would be answered by the failure rather than by the catalog — so the
 * better-aimed sentence would be lost to a confusing one.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) throw new InvalidTenantIdError(tenantId);

  // Before any statement, including the catalog read below: see the order argument above.
  const status = transactionStatus(client);
  if (status === "T" || status === "E") throw new TransactionAlreadyOpenError(status);

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
