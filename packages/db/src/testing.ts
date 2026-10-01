import { Pool } from "pg";

/**
 * Connection for the contract tests. They need a REAL Postgres: the whole point
 * is that RLS, ownership and type coercion cannot be asserted against a fake —
 * every finding these tests encode was found by running SQL, not by reading it.
 *
 * CI provides a service container; locally, point PG* at any throwaway cluster.
 */
export function testPool(): Pool {
  return new Pool({
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 4,
  });
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
