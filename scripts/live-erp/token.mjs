// Prints one service token on stdout, for the shell steps that use curl.
//
// Through `mintServiceToken` so even the shell's own probes carry a token the
// shipped minter produced — a hand-rolled JWT here could pass while the real one
// failed, which is the mistake this whole script exists to rule out.
import { readFileSync } from "node:fs";

import { LocalEd25519Signer, mintServiceToken } from "../../packages/credential/dist/index.js";

const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(process.env["LIVE_KEY_PEM"], "utf8"));
const tenantId = process.env["LIVE_TENANT_ID"];
const { token } = await mintServiceToken(signer, {
  issuer: process.env["LIVE_JWT_ISSUER"],
  audience: process.env["LIVE_JWT_AUDIENCE"],
  tenantId,
  role: process.argv[2] ?? "erp_admin",
  subject: `crm-service:${tenantId}`,
  ttlSeconds: 900,
  nowSeconds: Math.floor(Date.now() / 1000),
});
process.stdout.write(token);
