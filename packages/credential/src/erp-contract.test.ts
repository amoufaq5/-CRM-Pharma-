import { describe, expect, it } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { buildJwksDocument } from "./jwk.js";
import { generateServiceKeyPair, LocalEd25519Signer } from "./signer.js";
import { decodeUnverified, mintServiceToken, NOT_BEFORE_SKEW_SECONDS } from "./token.js";

/**
 * Does the ERP accept what we mint?
 *
 * The functions below are a TRANSCRIPTION of the ERP's own verification path,
 * copied deliberately rather than imported — the CRM must not depend on the ERP's
 * source (ADR-0001), and a reimplementation that drifts is still worth more than
 * no check at all, because the alternative is discovering a mismatch as a 401 in
 * production.
 *
 * Transcribed from CrossEngin at commit b2de883:
 *   packages/api-gateway-runtime/src/auth.ts   verifyBearerJwt, parseJwt
 *   packages/crypto/src/signing.ts             verifyEd25519, publicKeyFromRaw
 *   apps/operate-server/src/jwks.ts            parseJwksDocument, base64UrlToBase64
 *
 * If any of those change, this file has to be re-read against them. What it pins
 * is not our behaviour but the INTERFACE: the alg string, the mandatory kid, the
 * two separate base64 conversions the ERP does, and which claims it checks.
 */

const ERP_ISSUER = "https://crm.example.com/";
const ERP_AUDIENCE = "crossengin-erp";
const ERP_CLOCK_SKEW_SECONDS = 30; // the gateway's default
const TENANT = "3f1b7c22-5e2a-4a5f-9f4a-0c1d2e3f4a5b";

/** apps/operate-server/src/jwks.ts — base64url `x` to the standard base64 the gateway uses. */
function base64UrlToBase64(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const padNeeded = b.length % 4 === 0 ? 0 : 4 - (b.length % 4);
  return b + "=".repeat(padNeeded);
}

/** apps/operate-server/src/jwks.ts — only OKP/Ed25519 entries with a kid and x survive. */
function parseJwksDocument(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return out;
  for (const entry of keys) {
    const k = entry as Record<string, unknown>;
    if (k["kty"] === "OKP" && k["crv"] === "Ed25519" && typeof k["kid"] === "string" && typeof k["x"] === "string") {
      out.set(k["kid"], base64UrlToBase64(k["x"]));
    }
  }
  return out;
}

/** packages/crypto/src/signing.ts — note the STANDARD-base64-only regexes. */
function decodeBase64Strict(value: string, expectedLength: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("not valid base64");
  const buf = Buffer.from(value, "base64");
  if (buf.length !== expectedLength) throw new Error(`must decode to ${expectedLength} bytes, got ${buf.length}`);
  return new Uint8Array(buf);
}

function verifyEd25519(publicKeyBase64: string, signatureBase64: string, message: Uint8Array): boolean {
  let pub: Uint8Array;
  try {
    pub = decodeBase64Strict(publicKeyBase64, 32);
  } catch {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) return false;
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") },
    format: "jwk",
  });
  return cryptoVerify(null, Buffer.from(message), key, signature);
}

type Outcome =
  | "authenticated"
  | "credential_malformed"
  | "credential_not_found"
  | "invalid_signature"
  | "expired_token"
  | "not_yet_valid_token"
  | "issuer_mismatch"
  | "audience_mismatch";

/** packages/api-gateway-runtime/src/auth.ts — verifyBearerJwt, claim checks and all. */
function erpVerify(
  token: string,
  jwks: Map<string, string>,
  nowSeconds: number,
  opts: { issuer?: string; audience?: string } = {},
): { outcome: Outcome; reason?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { outcome: "credential_malformed", reason: "not 3 parts" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;

  if (header["alg"] !== "EdDSA") return { outcome: "credential_malformed", reason: "alg" };
  if (typeof header["kid"] !== "string") return { outcome: "credential_malformed", reason: "kid" };
  const publicKey = jwks.get(header["kid"]);
  if (publicKey === undefined) return { outcome: "credential_not_found" };

  const signedPayload = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBase64 = Buffer.from(signatureB64, "base64url").toString("base64");
  if (!verifyEd25519(publicKey, signatureBase64, signedPayload)) return { outcome: "invalid_signature" };

  // Each of these is conditional on the claim being PRESENT, exactly as the ERP has
  // it. That is the asymmetry the minter compensates for.
  const exp = payload["exp"];
  if (typeof exp === "number" && exp + ERP_CLOCK_SKEW_SECONDS < nowSeconds) return { outcome: "expired_token" };
  const nbf = payload["nbf"];
  if (typeof nbf === "number" && nbf - ERP_CLOCK_SKEW_SECONDS > nowSeconds) return { outcome: "not_yet_valid_token" };
  const iss = payload["iss"];
  if (typeof iss === "string" && iss !== (opts.issuer ?? ERP_ISSUER)) return { outcome: "issuer_mismatch" };
  const aud = payload["aud"];
  const expectedAud = opts.audience ?? ERP_AUDIENCE;
  const audOk = typeof aud === "string" ? aud === expectedAud : Array.isArray(aud) && aud.includes(expectedAud);
  if (aud !== undefined && !audOk) return { outcome: "audience_mismatch" };

  return { outcome: "authenticated" };
}

/** apps/operate-server/src/principals.ts — only the FIRST scope becomes the role. */
function erpPrimaryRole(scopeClaim: unknown): string {
  const scopes = typeof scopeClaim === "string" ? scopeClaim.split(" ").filter((s) => s.length > 0) : [];
  return scopes[0] ?? "anonymous";
}

async function mint(overrides: Partial<Parameters<typeof mintServiceToken>[1]> = {}) {
  const generated = generateServiceKeyPair();
  const signer = LocalEd25519Signer.fromPkcs8Pem(generated.privateKeyPem);
  const nowSeconds = 1_800_000_000;
  const minted = await mintServiceToken(signer, {
    issuer: ERP_ISSUER,
    audience: ERP_AUDIENCE,
    tenantId: TENANT,
    role: "controller",
    subject: `crm-service:${TENANT}`,
    ttlSeconds: 600,
    nowSeconds,
    ...overrides,
  });
  const jwks = parseJwksDocument(buildJwksDocument([{ kid: generated.kid, x: generated.jwk.x }]));
  return { minted, jwks, nowSeconds, generated };
}

describe("a minted token against the ERP's verifier", () => {
  it("authenticates", async () => {
    const { minted, jwks, nowSeconds } = await mint();
    expect(erpVerify(minted.token, jwks, nowSeconds).outcome).toBe("authenticated");
  });

  it("survives the round trip through the JWKS the API publishes", async () => {
    // Two base64 conversions happen between our key and the verify call: base64url
    // in the JWK, standard base64 in the crypto layer, and the signature takes the
    // same journey. Either one off by a pad character fails everything.
    const { minted, jwks, generated } = await mint();
    expect(jwks.size).toBe(1);
    expect(jwks.has(generated.kid)).toBe(true);
    expect(decodeUnverified(minted.token)?.header["kid"]).toBe(generated.kid);
  });

  it("carries exp, iss and aud — the three claims the ERP only checks when present", async () => {
    // The ERP's checks are `if (claim present && mismatched) reject`. A token minted
    // without exp never expires there, and nothing downstream would report it. This
    // asserts the minter does not rely on the verifier to catch an omission.
    const { minted } = await mint();
    const payload = decodeUnverified(minted.token)?.payload ?? {};
    expect(typeof payload["exp"]).toBe("number");
    expect(payload["iss"]).toBe(ERP_ISSUER);
    expect(payload["aud"]).toBe(ERP_AUDIENCE);
  });

  it("resolves to the single role we asked for", async () => {
    const { minted } = await mint();
    expect(erpPrimaryRole(decodeUnverified(minted.token)?.payload["scope"])).toBe("controller");
  });

  it("asserts the tenant in the claim the gateway treats as authoritative", async () => {
    // `x-tenant-id` is a header anyone could send; the gateway rejects a request
    // whose header contradicts this claim as tenant_mismatch. The claim is what makes
    // the header safe.
    const { minted } = await mint();
    expect(decodeUnverified(minted.token)?.payload["tenant_id"]).toBe(TENANT);
  });

  it("is rejected by a verifier that does not have the key", async () => {
    const { minted, nowSeconds } = await mint();
    const other = generateServiceKeyPair();
    const foreign = parseJwksDocument(buildJwksDocument([{ kid: other.kid, x: other.jwk.x }]));
    expect(erpVerify(minted.token, foreign, nowSeconds).outcome).toBe("credential_not_found");
  });

  it("is rejected once past its lifetime plus the skew allowance", async () => {
    const { minted, jwks, nowSeconds } = await mint();
    expect(erpVerify(minted.token, jwks, nowSeconds + 600 + ERP_CLOCK_SKEW_SECONDS - 1).outcome).toBe(
      "authenticated",
    );
    expect(erpVerify(minted.token, jwks, nowSeconds + 600 + ERP_CLOCK_SKEW_SECONDS + 1).outcome).toBe(
      "expired_token",
    );
  });

  it("is accepted by a verifier whose clock is behind ours, which is why nbf is backdated", async () => {
    const { minted, jwks, nowSeconds } = await mint();
    // The ERP tolerates 30s of skew on its own; nbf is backdated another 30, so a
    // verifier up to a minute behind still accepts a token we just minted.
    const behind = nowSeconds - ERP_CLOCK_SKEW_SECONDS - NOT_BEFORE_SKEW_SECONDS;
    expect(erpVerify(minted.token, jwks, behind).outcome).toBe("authenticated");
  });

  it("is rejected if a single byte of the payload is altered", async () => {
    const { minted, jwks, nowSeconds } = await mint();
    const [h, p, s] = minted.token.split(".") as [string, string, string];
    const tampered = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    tampered["scope"] = "erp_admin"; // the obvious attack: escalate the role
    const forged = `${h}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${s}`;
    expect(erpVerify(forged, jwks, nowSeconds).outcome).toBe("invalid_signature");
  });

  it("is rejected when the issuer or audience does not match the ERP's configuration", async () => {
    const { minted, jwks, nowSeconds } = await mint();
    expect(erpVerify(minted.token, jwks, nowSeconds, { issuer: "https://elsewhere/" }).outcome).toBe(
      "issuer_mismatch",
    );
    expect(erpVerify(minted.token, jwks, nowSeconds, { audience: "other-erp" }).outcome).toBe(
      "audience_mismatch",
    );
  });

  it("uses alg EdDSA, the only one the ERP accepts", async () => {
    const { minted } = await mint();
    expect(decodeUnverified(minted.token)?.header["alg"]).toBe("EdDSA");
  });

  it("always sets kid, which the ERP requires before it will look for a key", async () => {
    const { minted } = await mint();
    expect(typeof decodeUnverified(minted.token)?.header["kid"]).toBe("string");
  });
});
