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

export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";
