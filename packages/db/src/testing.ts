import { Pool } from "pg";

/**
 * The FIXTURE connection. Connects as the admin role.
 *
 * Contract tests need a REAL Postgres: RLS, ownership and type coercion cannot be
 * asserted against a fake, and every finding these tests encode was found by running
 * SQL rather than by reading it. CI provides a service container; locally, point PG* at
 * any throwaway cluster.
 *
 * A test takes ONE client from here and immediately `SET ROLE crm_app`, which is what
 * makes RLS apply to it — a superuser bypasses the policy even under `FORCE`. Use this
 * for setting up and tearing down rows, and for the few assertions that need to look at
 * the catalog or prove the bypass itself.
 *
 * Do NOT hand this pool to code under test that connects its own clients: it would take
 * fresh superuser connections with no `SET ROLE`, and nothing it does would be subject
 * to a policy. Use `appPool()` for that. See the comment there — this distinction cost
 * a real cross-tenant write before it was drawn.
 */
export function testPool(): Pool {
  return new Pool({ ...connection(), max: 4 });
}

/**
 * The APPLICATION connection. Connects as `crm_app`, exactly as the deployed API and
 * scheduler do (`deploy/README.md`, "Two database identities").
 *
 * This is the pool to hand to anything under test that connects clients of its own —
 * `startApi`, `Scheduler`, `OutboxRelay`, `SnapshotRefresher`. Those open their own
 * connections and set only the tenant GUC, so the ROLE they inherit from the pool is
 * the one their queries run under.
 *
 * It exists because the API contract suite used to hand them the admin pool. Every
 * route in it therefore ran as a superuser, so row-level security was switched off for
 * the entire suite and no test could have caught a missing tenant predicate. One was
 * missing: `crm.revoke_rep_role` matched on a grant id alone, and a rep of one tenant
 * ended a grant in another. The suite passed. Connecting as `crm_app` is what makes a
 * tenant-isolation assertion mean anything here.
 *
 * `PGAPPUSER` overrides the role for a cluster that names it differently; the password
 * is whatever the migration runner set, supplied as `PGAPPPASSWORD`. Over a unix socket
 * with local trust, neither is needed.
 */
export function appPool(): Pool {
  return new Pool({
    ...connection(),
    user: process.env["PGAPPUSER"] ?? "crm_app",
    ...(process.env["PGAPPPASSWORD"] !== undefined ? { password: process.env["PGAPPPASSWORD"] } : {}),
    max: 8,
  });
}

function connection(): {
  host: string;
  database: string;
  user: string;
  password?: string;
  port?: number;
} {
  return {
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
  };
}

/**
 * Reserved tenant ids, ONE BLOCK PER TEST FILE.
 *
 * Test files share a database and run sequentially (`fileParallelism: false`),
 * so two files using the same tenant id see each other's rows — and the failure
 * is maddening, because each file passes on its own. That has bitten three
 * times now, so the ids are handed out here rather than chosen per file:
 * a collision is visible in one place instead of being discovered at runtime.
 *
 * Adding a test file means adding a block here, not inventing a UUID.
 */
/** packages/db — rls.contract. Read-only against its own fixture table. */
export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";

/** packages/db — schema.contract. */
export const TENANT_DB_SCHEMA_A = "1a111111-1111-4111-8111-111111111111";
export const TENANT_DB_SCHEMA_B = "1b222222-2222-4222-8222-222222222222";

/** packages/db — expense.contract. */
export const TENANT_DB_EXPENSE = "1c333333-3333-4333-8333-333333333333";

/** packages/relay. */
export const TENANT_RELAY = "88888888-8888-4888-8888-888888888888";

/** packages/scheduler. */
export const TENANT_SCHEDULER_A = "99999999-9999-4999-8999-999999999991";
export const TENANT_SCHEDULER_B = "99999999-9999-4999-8999-999999999992";

/** packages/scheduler — the loop and recordResult suites. */
export const TENANT_SCHEDULER_LOOP = "33333333-3333-4333-8333-333333333333";
export const TENANT_SCHEDULER_RESULT = "44444444-4444-4444-8444-444444444444";

/** packages/territory. */
export const TENANT_TERRITORY_A = "55555555-5555-4555-8555-555555555555";
export const TENANT_TERRITORY_B = "66666666-6666-4666-8666-666666666666";

/** packages/api. */
export const TENANT_API = "8a111111-1111-4111-8111-111111111111";
export const TENANT_API_OTHER = "8b222222-2222-4222-8222-222222222222";

/** packages/visit. */
export const TENANT_VISIT = "7a111111-1111-4111-8111-111111111111";

/** packages/sync — snapshot refresh. */
export const TENANT_SYNC = "77777777-7777-4777-8777-777777777777";

/** packages/credential — role-source.contract. */
export const TENANT_CREDENTIAL_A = "9a111111-1111-4111-8111-111111111111";
export const TENANT_CREDENTIAL_B = "9b222222-2222-4222-8222-222222222222";

/** packages/credential — boot.contract. */
export const TENANT_CREDENTIAL_BOOT = "9c333333-3333-4333-8333-333333333333";

/** packages/callplan. */
export const TENANT_CALLPLAN = "ca000000-0000-4000-8000-000000000001";

/** packages/sample — custody contract. */
export const TENANT_SAMPLE = "cb000000-0000-4000-8000-000000000002";

/** packages/sample — the ERP mirror contract. */
export const TENANT_SAMPLE_MIRROR = "cc000000-0000-4000-8000-000000000003";

/** packages/territory — supervision.contract. */
export const TENANT_SUPERVISION = "da000000-0000-4000-8000-000000000001";

/** packages/sample — expiry-sweep.contract. */
export const TENANT_EXPIRY_SWEEP = "ce000000-0000-4000-8000-000000000004";

/** packages/notify — raise.contract and dispatch.contract. */
export const TENANT_NOTIFY = "cf000000-0000-4000-8000-000000000005";

/** packages/relay — dead-letters.contract. */
export const TENANT_DEAD_LETTERS = "d1000000-0000-4000-8000-000000000006";

/** packages/role — roles.contract. */
export const TENANT_ROLE = "d2000000-0000-4000-8000-000000000007";

/** packages/notify — endpoints.contract. Separate from TENANT_NOTIFY: the endpoint
 *  suite creates and disables endpoints, which the dispatch suite reads. */
export const TENANT_ENDPOINTS = "d3000000-0000-4000-8000-000000000008";

/** packages/notify — retention.contract. */
export const TENANT_RETENTION = "d4000000-0000-4000-8000-000000000009";

/** packages/sample — recall.contract. */
export const TENANT_RECALL = "d6000000-0000-4000-8000-00000000000a";

/** packages/notify — prune-guard.contract. */
export const TENANT_PRUNE_GUARD = "d7000000-0000-4000-8000-00000000000b";

/** packages/relay — sequence.contract. */
export const TENANT_OUTBOX_SEQ = "d8000000-0000-4000-8000-00000000000c";

/** packages/expense — accounts.contract. */
export const TENANT_EXPENSE_MAP = "d9000000-0000-4000-8000-00000000000d";

/** packages/expense — store.contract. */
export const TENANT_EXPENSE_STORE = "da100000-0000-4000-8000-00000000000e";

/** packages/sample — disposal-reopen.contract. */
export const TENANT_DISPOSAL_REOPEN = "db100000-0000-4000-8000-00000000000f";

/** packages/expense — sweeper.contract. */
export const TENANT_EXPENSE_SWEEP = "dc100000-0000-4000-8000-000000000010";

/** packages/storage — attachment.contract. */
export const TENANT_STORAGE = "dd100000-0000-4000-8000-000000000011";

/** packages/storage — a second tenant, for the cross-tenant blob-reach test. */
export const TENANT_STORAGE_OTHER = "de100000-0000-4000-8000-000000000012";

/** packages/notify — channel-coverage.contract and probe.contract. */
export const TENANT_CHANNEL_COVERAGE = "df100000-0000-4000-8000-000000000013";

/** db/migrations — composite-fk.contract, the tenant that must NOT be reachable. */
export const TENANT_FK_A = "e0100000-0000-4000-8000-000000000014";
export const TENANT_FK_B = "e1100000-0000-4000-8000-000000000015";

/** packages/sample — disposal ordering under one transaction. */
export const TENANT_DISPOSAL_SEQ = "e2100000-0000-4000-8000-000000000016";

/** scripts/live-erp — the live handshake against a running operate-server. */
export const TENANT_LIVE_ERP = "e3100000-0000-4000-8000-000000000017";

/** packages/relay — the dead-letter attempt history. */
export const TENANT_ATTEMPT_HISTORY = "e4100000-0000-4000-8000-000000000018";

/** packages/relay — the outbox store's settle guards. */
export const TENANT_RELAY_STORE = "e5100000-0000-4000-8000-000000000019";

/**
 * packages/expense — lifecycle.contract (migration 0044).
 *
 * The id is derived from the migration number rather than continued from the sequence
 * above: four agents were adding files at once, and "the next one" is not a safe guess for
 * any of them.
 */
export const TENANT_EXPENSE_LIFECYCLE = "e6440000-0000-4000-8000-00000000001a";

/** packages/notify — delivery retention, and the tenant it must not reach (0046). */
export const TENANT_DELIVERY_RETENTION = "e7100000-0000-4000-8000-00000000001a";
export const TENANT_DELIVERY_RETENTION_OTHER = "e8100000-0000-4000-8000-00000000001b";

/**
 * packages/notify — endpoint-rules.contract (migration 0049).
 *
 * Derived from the migration number, as 0044's is, and separate from `TENANT_ENDPOINTS`
 * because this suite's whole subject is UPDATEs that must be refused: a failed statement
 * aborts the transaction, and sharing a tenant with a suite that reads endpoints back
 * would make one file's refusals the other file's missing rows.
 */
export const TENANT_ENDPOINT_RULES = "e9490000-0000-4000-8000-00000000001c";
