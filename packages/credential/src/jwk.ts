import { createHash } from "node:crypto";

/**
 * The JWKS half of the service credential: turning a raw Ed25519 public key into
 * the exact document shape the ERP's parser accepts, and deciding what to serve
 * when there are no keys to serve.
 */

export const ED25519_PUBLIC_KEY_BYTES = 32;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/**
 * A JWK as the ERP will read it.
 *
 * Its parser (apps/operate-server/src/jwks.ts) keeps an entry only when
 * `kty === "OKP"`, `crv === "Ed25519"`, and both `kid` and `x` are strings;
 * everything else in the document is ignored. `use` and `alg` are therefore
 * decoration for that reader — included because any other JWKS consumer expects
 * them, and because a key published without them invites the question.
 */
export interface Ed25519Jwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly kid: string;
  readonly x: string;
  readonly use: "sig";
  readonly alg: "EdDSA";
}

export interface JwksDocument {
  readonly keys: readonly Ed25519Jwk[];
}

export class JwkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwkError";
  }
}

/**
 * RFC 7638 thumbprint of an Ed25519 public key, used as the `kid`.
 *
 * Derived rather than chosen, so a kid can never name a different key than the
 * one it travels with: the two cannot drift apart because one is a function of
 * the other. A hand-picked kid ("crm-2026-10") can be copied onto a rotated key
 * by mistake, and the failure is a signature that does not verify against the
 * key the verifier looked up — reported as `invalid_signature`, which reads like
 * a corrupted token rather than a mislabelled key.
 *
 * The canonical form is the REQUIRED members only, lexicographically ordered,
 * with no whitespace. For OKP that is crv, kty, x — written out literally here
 * because `JSON.stringify` of an object would depend on insertion order.
 */
export function jwkThumbprint(x: string): string {
  if (x === "") throw new JwkError("cannot compute a thumbprint for an empty key");
  return createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, "utf8").digest("base64url");
}

/** Builds the JWK for a raw 32-byte public key, with its thumbprint as the kid. */
export function ed25519Jwk(publicKeyRaw: Uint8Array): Ed25519Jwk {
  if (publicKeyRaw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new JwkError(
      `an Ed25519 public key is ${ED25519_PUBLIC_KEY_BYTES} bytes; got ${publicKeyRaw.length}`,
    );
  }
  const x = base64url(publicKeyRaw);
  return { kty: "OKP", crv: "Ed25519", kid: jwkThumbprint(x), x, use: "sig", alg: "EdDSA" };
}

export interface PublishedKey {
  readonly kid: string;
  readonly x: string;
}

/**
 * Assembles the JWKS document.
 *
 * Rejects a key whose kid is not its own thumbprint. The registry stores both,
 * so a row edited by hand could publish a key under a kid nothing signs with —
 * every token referencing it would 401 with `credential_not_found` while the
 * document looked perfectly well-formed.
 */
export function buildJwksDocument(keys: readonly PublishedKey[]): JwksDocument {
  const seen = new Set<string>();
  const out: Ed25519Jwk[] = [];
  for (const k of keys) {
    const expected = jwkThumbprint(k.x);
    if (k.kid !== expected) {
      throw new JwkError(`kid ${k.kid} is not the thumbprint of its own key (expected ${expected})`);
    }
    if (seen.has(k.kid)) throw new JwkError(`duplicate kid ${k.kid}`);
    seen.add(k.kid);
    out.push({ kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig", alg: "EdDSA" });
  }
  return { keys: out };
}

export interface JwksHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * How long a verifier may cache the document. Shorter than the ERP's own default
 * JWKS cache (5 minutes), so the `Cache-Control` we send never asks anyone to
 * hold a key set for longer than the ERP would anyway.
 */
export const JWKS_CACHE_SECONDS = 120;

/**
 * Renders the JWKS endpoint's response.
 *
 * AN EMPTY DOCUMENT MUST NEVER BE SERVED WITH A 200, and this is the whole reason
 * this function exists rather than the route returning `{ keys }` directly.
 *
 * The ERP's RemoteJwksProvider.refresh() does:
 *
 *     if (!res.ok) return;            // keeps the last good key set
 *     this.keys = parseJwksDocument(await res.json());
 *
 * So a 200 carrying `{"keys":[]}` REPLACES a working key set with an empty one,
 * and every subsequent request 401s with `credential_not_found` until a later
 * refresh happens to succeed. A non-200 is strictly safer: the ERP keeps serving
 * with the keys it already has. When we have nothing to publish — no key
 * configured yet, or a failed database read — the honest answer is 503, not an
 * empty document that looks authoritative.
 */
export function jwksResponse(keys: readonly PublishedKey[]): JwksHttpResponse {
  if (keys.length === 0) {
    return {
      status: 503,
      body: {
        type: "https://crm.example.com/problems/jwks-unavailable",
        title: "No signing key is published",
        status: 503,
        detail:
          "The CRM has no published Ed25519 service key. Returning 503 rather than an empty " +
          "key set, because a verifier that caches an empty document stops accepting every token.",
      },
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    };
  }
  return {
    status: 200,
    body: buildJwksDocument(keys),
    headers: {
      "content-type": "application/jwk-set+json",
      "cache-control": `public, max-age=${JWKS_CACHE_SECONDS}`,
    },
  };
}
