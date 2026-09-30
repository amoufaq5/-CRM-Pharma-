import { createPublicKey, createVerify, verify as edVerify, type KeyObject } from "node:crypto";

/**
 * JWT verification for the HUMAN login token.
 *
 * Deliberately supports RS256 as well as Ed25519. The ERP's verifier accepts
 * `kty=OKP, crv=Ed25519` only, which constrains the credential the CRM mints for
 * ERP calls — but it must not constrain the IdP that authenticates people into
 * the CRM. Entra ID, Auth0, Cognito and Keycloak all sign RS256 by default, and
 * that token never reaches the ERP (ADR-0001 item 10, the two-tier design).
 *
 * Written over `node:crypto` rather than taking a dependency, matching how the
 * ERP hand-rolled its own. Verification is the part that must be right, so the
 * unsafe shortcuts are named where they are refused.
 */
export class JwtError extends Error {
  constructor(
    readonly reason:
      | "malformed"
      | "unsupported_algorithm"
      | "unknown_key"
      | "bad_signature"
      | "expired"
      | "not_yet_valid"
      | "wrong_issuer"
      | "wrong_audience"
      | "no_subject",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "JwtError";
  }
}

export interface JwtClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  /** Tenant claim, if the IdP issues one. Otherwise resolved from the subject. */
  readonly tenant?: string;
  readonly [key: string]: unknown;
}

export interface JwksKey {
  readonly kid: string;
  readonly key: KeyObject;
  readonly alg: "RS256" | "EdDSA";
}

const SUPPORTED = new Set(["RS256", "EdDSA"]);

function b64urlToBuffer(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/**
 * Parses a JWKS document into verifiable keys.
 *
 * Only RSA and Ed25519 entries with a `kid` survive. A key without a `kid`
 * cannot be selected by a token's header, so accepting one would mean trying
 * every key in turn — which turns a key-rotation mistake into a silent success
 * against the wrong key.
 *
 * This validates key SHAPE, not key MATERIAL. Measured: node's
 * `createPublicKey` accepts `{ kty: "RSA", n: "!!!", e: "AQAB" }` without
 * complaint, so a garbage modulus is admitted here. That is safe — a key that
 * is not the IdP's simply fails verification and the token is rejected — but do
 * not read this function as a guarantee that every key it returns is usable.
 */
export function parseJwks(doc: unknown): readonly JwksKey[] {
  const keys = (doc as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return [];
  const out: JwksKey[] = [];
  for (const entry of keys) {
    const k = entry as Record<string, unknown>;
    if (typeof k["kid"] !== "string") continue;
    try {
      if (k["kty"] === "RSA" && typeof k["n"] === "string" && typeof k["e"] === "string") {
        out.push({
          kid: k["kid"],
          alg: "RS256",
          key: createPublicKey({ key: k as never, format: "jwk" }),
        });
      } else if (k["kty"] === "OKP" && k["crv"] === "Ed25519" && typeof k["x"] === "string") {
        out.push({
          kid: k["kid"],
          alg: "EdDSA",
          key: createPublicKey({ key: k as never, format: "jwk" }),
        });
      }
    } catch {
      // A malformed entry is skipped rather than failing the whole document: one
      // bad key in an IdP's JWKS must not lock every user out.
      continue;
    }
  }
  return out;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: readonly JwksKey[];
  readonly now?: () => number;
  /** Tolerance for clock skew between us and the IdP. Default 60s. */
  readonly clockToleranceSeconds?: number;
}

/**
 * Verifies a compact JWS and returns its claims.
 *
 * Order matters: the signature is checked BEFORE any claim is trusted. Reading
 * `iss` or `exp` from an unverified token and acting on it — even to reject —
 * leaks whether a guess was close.
 */
export function verifyJwt(token: string, options: VerifyOptions): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed", "expected three dot-separated segments");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8"));
  } catch {
    throw new JwtError("malformed", "header is not JSON");
  }

  const alg = header.alg;
  if (typeof alg !== "string" || !SUPPORTED.has(alg)) {
    // `alg: "none"` and HMAC-when-RSA-was-expected are the classic JWT
    // confusions. An explicit allow-list refuses both by construction.
    throw new JwtError("unsupported_algorithm", `alg ${String(alg)} is not accepted (RS256, EdDSA)`);
  }
  if (typeof header.kid !== "string") {
    throw new JwtError("unknown_key", "token header carries no kid");
  }

  const candidate = options.keys.find((k) => k.kid === header.kid && k.alg === alg);
  if (candidate === undefined) {
    throw new JwtError("unknown_key", `no key ${String(header.kid)} for alg ${alg}`);
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = b64urlToBuffer(signatureB64);

  const ok =
    alg === "RS256"
      ? createVerify("RSA-SHA256").update(signingInput).verify(candidate.key, signature)
      : edVerify(null, signingInput, candidate.key, signature);
  if (!ok) throw new JwtError("bad_signature", "signature does not verify");

  let claims: JwtClaims;
  try {
    claims = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8")) as JwtClaims;
  } catch {
    throw new JwtError("malformed", "payload is not JSON");
  }

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const skew = options.clockToleranceSeconds ?? 60;

  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new JwtError("expired", "token has expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new JwtError("not_yet_valid", "token is not valid yet");
  }
  if (claims.iss !== options.issuer) {
    throw new JwtError("wrong_issuer", `iss ${String(claims.iss)} is not ${options.issuer}`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new JwtError("wrong_audience", `aud does not include ${options.audience}`);
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new JwtError("no_subject", "token has no sub");
  }
  return claims;
}

export interface JwksFetch {
  (url: string): Promise<unknown>;
}

/**
 * A JWKS cache over the IdP's endpoint.
 *
 * Refetches on an unknown `kid` so a rotation is picked up without a restart,
 * rate-limited so a token bearing a junk kid cannot turn into a fetch per
 * request. A failed refetch keeps the last good set — resilient — and only an
 * empty set fails closed.
 */
export class JwksCache {
  private keys: readonly JwksKey[] = [];
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: JwksFetch,
    private readonly options: {
      readonly ttlMs?: number;
      readonly minRefetchMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async get(kid?: string): Promise<readonly JwksKey[]> {
    const ttl = this.options.ttlMs ?? 5 * 60_000;
    const stale = this.now - this.fetchedAt > ttl;
    const missing = kid !== undefined && !this.keys.some((k) => k.kid === kid);
    const minRefetch = this.options.minRefetchMs ?? 10_000;
    const mayRefetch = this.now - this.fetchedAt > minRefetch;

    if (this.keys.length === 0 || stale || (missing && mayRefetch)) await this.refresh();
    return this.keys;
  }

  private async refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const parsed = parseJwks(await this.fetchImpl(this.url));
        // An empty parse is treated as a failure, not as "the IdP has no keys":
        // replacing a good set with nothing would lock every user out over a
        // transient bad response.
        if (parsed.length > 0) {
          this.keys = parsed;
          this.fetchedAt = this.now;
        }
      } catch {
        // Keep the last good set; `get` fails closed only when nothing is cached.
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
