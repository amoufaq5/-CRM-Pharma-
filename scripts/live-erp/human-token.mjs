// Prints one HUMAN login token on stdout — the token an external IdP would issue
// for a rep signing in to the CRM's API.
//
// THE ONE PLACE IN THIS HARNESS THAT MINTS A TOKEN BY HAND, AND IT HAS TO BE.
// Everything on the CRM→ERP side goes through `mintServiceToken`, because the CRM
// is the ISSUER there and a hand-rolled token would verify a different arrangement
// from the one that deploys. On the human side the CRM is the VERIFIER: Entra,
// Auth0, Cognito and Keycloak issue these, the CRM ships no minter for them, and
// ADR-0001 item 10's two tiers "never mix". So this script stands in for the IdP,
// and it is deliberately signed with a DIFFERENT key, published in a DIFFERENT key
// set, from the Ed25519 service key the ERP trusts.
//
// The signing itself still goes through `LocalEd25519Signer` and `base64url` from
// @crm/credential rather than a second copy of JWS assembly, so the bytes on the
// wire are produced the way the repo produces them everywhere else.
//
// Usage: node human-token.mjs [subject] [--no-tenant-claim]
import { readFileSync } from "node:fs";

import { LocalEd25519Signer, base64url } from "../../packages/credential/dist/index.js";

const PEM = process.env["LIVE_IDP_PEM"];
const ISSUER = process.env["LIVE_OIDC_ISSUER"];
const AUDIENCE = process.env["LIVE_OIDC_AUDIENCE"];
const TENANT = process.env["LIVE_TENANT_ID"];

// `--service-key` signs with the ERP-facing SERVICE key instead. The point of that
// case is the negative control in §10: a token signed by the key the ERP trusts
// must not open the CRM's own API, because the two tiers publish different key
// sets. Nothing in production can produce it.
const useServiceKey = process.argv.includes("--service-key");
const pem = useServiceKey ? process.env["LIVE_KEY_PEM"] : PEM;

const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(pem, "utf8"));
const subject = process.argv[2] !== undefined && !process.argv[2].startsWith("--") ? process.argv[2] : "rep-ada";

const now = Math.floor(Date.now() / 1000);
const enc = (o) => base64url(new TextEncoder().encode(JSON.stringify(o)));
const head = enc({ alg: "EdDSA", typ: "JWT", kid: signer.kid });
const body = enc({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: subject,
  // The IdP may or may not issue a tenant claim; `resolvePrincipal` falls back to
  // the x-tenant-id header when it does not. Omitting it is how that fallback gets
  // exercised rather than assumed.
  ...(process.argv.includes("--no-tenant-claim") ? {} : { tenant: TENANT }),
  iat: now,
  nbf: now - 30,
  exp: now + 600,
});
const sig = await signer.sign(new TextEncoder().encode(`${head}.${body}`));
process.stdout.write(`${head}.${body}.${base64url(sig)}`);
