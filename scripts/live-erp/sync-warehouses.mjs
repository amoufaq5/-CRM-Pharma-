// Fills the CRM's warehouse snapshot from the LIVE ERP, with the shipped refresher.
//
// WHY THIS IS A STEP OF ITS OWN, before the API binary starts. Migration 0058 made
// `POST /v1/samples/receipts` and `POST /v1/samples/returns` check the warehouse they name
// against `crm.warehouse_snapshot`, and refuse with a 503 when that table has never synced
// for the tenant — deliberately, because accepting any id while the list is empty is
// validation that stops validating exactly when the integration is unhealthy. So the CRM
// has to have learned the ERP's depots before a rep can record receiving stock from one,
// which is also the production ordering: the scheduler fills the snapshot every five
// minutes from boot, and §11 of this gate proves it does.
//
// Nothing here is a fixture. The rows come out of the running operate-server through
// `SnapshotRefresher`, which is the same class the scheduler's `snapshot_full` job calls,
// imported from the shipped dist — so a projection that no longer matches the ERP's
// `Warehouse` entity fails here rather than passing against a hand-written row.
//
// Imported by relative path for the reason `scripts/client/sweep.mjs` gives: the workspace
// `@crm/*` specifiers do not resolve from `scripts/`.
import { readFileSync } from "node:fs";

import pg from "pg";

import { ErpClient } from "../../packages/acl/dist/index.js";
import {
  LocalEd25519Signer,
  PostgresServiceRoleSource,
  ServiceCredential,
} from "../../packages/credential/dist/index.js";
import { withTenantContext } from "../../packages/db/dist/index.js";
import { SnapshotRefresher } from "../../packages/sync/dist/index.js";

const ERP_BASE = process.env["ERP_BASE_URL"] ?? "http://127.0.0.1:8788";
const TENANT = process.env["LIVE_TENANT_ID"] ?? "11111111-1111-4111-8111-111111111111";
const ISSUER = process.env["LIVE_JWT_ISSUER"] ?? "https://crm.test";
const AUDIENCE = process.env["LIVE_JWT_AUDIENCE"] ?? "https://erp.test";
const KEY_PEM = process.env["LIVE_KEY_PEM"];

// The APPLICATION role, not the owner: `withTenantContext` refuses a connection whose role
// bypasses RLS, and the refresher writes through it.
const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "/var/run/postgresql",
  database: process.env["CRM_PGDATABASE"],
  user: process.env["CRM_PGUSER"] ?? "crm_app",
  password: process.env["CRM_PGPASSWORD"] ?? "crm_app",
  max: 4,
});

const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(KEY_PEM, "utf8"));
const credential = new ServiceCredential({
  signer,
  roles: new PostgresServiceRoleSource({ pool }),
  issuer: ISSUER,
  audience: AUDIENCE,
});
const client = new ErpClient({
  baseUrl: ERP_BASE,
  credential,
  fetch: (url, init) => fetch(url, init),
});

const result = await new SnapshotRefresher({ pool, client }).refresh(TENANT, "warehouse", "full");

const rows = await (async () => {
  const conn = await pool.connect();
  try {
    return await withTenantContext(conn, TENANT, async (tx) => {
      const { rows } = await tx.query(
        `SELECT erp_warehouse_id::text AS id, code, status
           FROM crm.warehouse_snapshot WHERE tenant_id = $1 ORDER BY code`,
        [TENANT],
      );
      return rows;
    });
  } finally {
    conn.release();
  }
})();

await pool.end();

if (result.rejected.length > 0) {
  process.stderr.write(
    `the ERP served warehouses this CRM cannot represent: ${JSON.stringify(result.rejected)}\n`,
  );
  process.exit(1);
}
// Three seeded, and all three must land — the closed one too. A snapshot that dropped it
// would make a movement already posted against that depot unnameable, which is why the
// filtering is the reader's job and not the sweep's.
if (rows.length !== 3) {
  process.stderr.write(
    `expected 3 warehouses in crm.warehouse_snapshot, found ${rows.length}: ${JSON.stringify(rows)}\n`,
  );
  process.exit(1);
}
const active = rows.filter((r) => r.status === "active").map((r) => r.code);
if (active.join(",") !== "DEPOT-1,DEPOT-2") {
  process.stderr.write(`expected DEPOT-1 and DEPOT-2 active, got ${active.join(",")}\n`);
  process.exit(1);
}
process.stdout.write(
  `synced ${String(result.upserted)} warehouse(s) from the live ERP: ` +
    `${rows.map((r) => `${r.code}=${r.status}`).join(" ")}\n`,
);
