// Generates an Ed25519 service keypair with @crm/credential's own generator and
// writes the two halves the harness needs: the PKCS#8 PEM the signer loads, and
// the {kid, x} the JWKS server publishes.
//
// Through `generateServiceKeyPair` rather than `openssl` so the kid is the RFC
// 7638 thumbprint the shipped code derives — a hand-chosen kid would verify a
// different arrangement from the one that deploys.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateServiceKeyPair } from "../../packages/credential/dist/index.js";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: genkey.mjs <dir> [basename]\n");
  process.exit(2);
}
const base = process.argv[3] ?? "key";
mkdirSync(dir, { recursive: true });

const k = generateServiceKeyPair();
writeFileSync(join(dir, `${base}.pem`), k.privateKeyPem, { mode: 0o600 });
writeFileSync(join(dir, `${base}.jwk.json`), `${JSON.stringify({ kid: k.kid, x: k.jwk.x }, null, 2)}\n`);
process.stdout.write(`${k.kid}\n`);
