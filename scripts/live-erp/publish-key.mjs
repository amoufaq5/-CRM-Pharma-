// Publishes an already-generated service key into `crm.service_key` and makes it
// the signing key.
//
// WHY THIS EXISTS AT ALL. `buildServiceCredential` refuses to start a process whose
// signing key is not in that table — a key nobody published is a key no verifier
// has, so every token it signs would be refused with `credential_not_found`, which
// from the far side of an HTTP call is indistinguishable from the ERP being
// misconfigured. The gate's earlier sections generate the keypair with
// `genkey.mjs` and serve it over HTTP; the SCHEDULER additionally needs the
// registry to agree, because its boot check reads the registry and not the socket.
//
// `crm-service-key generate` cannot be used here: it generates its own keypair and
// prints a PEM, and the PEM the JWKS endpoint is already serving is the one the ERP
// has fetched. So the public half of THAT key is published, through
// `PostgresServiceKeyRegistry` — the shipped registry, including its lifecycle
// rules — rather than with an INSERT of our own.
//
// `--propagation-seconds 0` is the override the shipped CLI offers for exactly this
// case: the ERP fetched this key set before the scheduler starts, so the propagation
// wait the registry enforces has already been served.
//
// Usage: node publish-key.mjs <key.jwk.json>
import { readFileSync } from "node:fs";

import pg from "pg";

import { PostgresServiceKeyRegistry } from "../../packages/credential/dist/index.js";

const source = process.argv[2];
if (source === undefined) {
  process.stderr.write("usage: publish-key.mjs <key.jwk.json>\n");
  process.exit(2);
}

const { kid: expectedKid, x } = JSON.parse(readFileSync(source, "utf8"));

const pool = new pg.Pool({
  host: process.env["CRM_PGHOST"] ?? process.env["PGHOST"] ?? "/var/run/postgresql",
  database: process.env["CRM_PGDATABASE"],
  user: process.env["CRM_PGUSER"] ?? "crm_app",
  password: process.env["CRM_PGPASSWORD"] ?? "crm_app",
  max: 2,
});

const registry = new PostgresServiceKeyRegistry({ pool });
const kid = await registry.publish(x, "live-erp gate");
if (kid !== expectedKid) {
  // The registry derives the kid from the key material itself (RFC 7638), so a
  // disagreement here means genkey.mjs and the registry are deriving it
  // differently — which would make every token's `kid` header unresolvable.
  process.stderr.write(`publish derived kid ${kid}, but the JWKS publishes ${expectedKid}\n`);
  process.exit(1);
}
await registry.activate(kid, { propagationSeconds: 0 });

const active = await registry.activeKey();
if (active === null || active.kid !== kid) {
  process.stderr.write(`after activate, the active key is ${active?.kid ?? "none"}\n`);
  process.exit(1);
}
process.stdout.write(`${kid}\n`);
await pool.end();
