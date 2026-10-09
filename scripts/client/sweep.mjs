// Runs the REAL expiry sweep against a tenant, for the field-client gate.
//
// Not a fixture that inserts obligations: `sweepExpiredStock` is the function the scheduler
// calls nightly, and an obligation the gate wrote itself would prove nothing about the one a
// rep actually sees. `asOf` is a parameter of the sweep rather than a trick played on the
// clock, which is what makes it possible to ask the question this gate exists for — what
// does the record say when the sweep runs DAYS after the disposal?
//
// Usage: node sweep.mjs <tenant-id> [asOf]   (env: PG* as the application role)
// Imported from the built dist by path, the way scripts/live-erp does: this file is not a
// workspace package, so `@crm/*` does not resolve from here.
import pg from "pg";

import { withTenantContext } from "../../packages/db/dist/index.js";
import { sweepExpiredStock } from "../../packages/sample/dist/index.js";

const [tenant, asOf] = process.argv.slice(2);
if (tenant === undefined) throw new Error("sweep.mjs needs a tenant id");

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "/var/run/postgresql",
  database: process.env["PGDATABASE"],
  user: process.env["PGUSER"],
  ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
  max: 2,
});
const client = await pool.connect();
try {
  const result = await withTenantContext(client, tenant, (tx) =>
    sweepExpiredStock(tx, tenant, asOf === undefined ? {} : { asOf: new Date(asOf) }),
  );
  console.log(JSON.stringify(result));
} finally {
  client.release();
  await pool.end();
}
