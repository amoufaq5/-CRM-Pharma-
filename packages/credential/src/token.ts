import { randomUUID } from "node:crypto";

import { base64url } from "./jwk.js";
import type { ServiceKeySigner } from "./signer.js";

export class ServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

/**
 * ADR-0001 item 10 puts the service token's lifetime at 5–15 minutes.
 *
 * The floor is not arbitrary. The ERP's gateway tolerates 30 seconds of clock
 * skew in both directions, so a one-minute token spends a sixth of its life in a
 * window where two honest clocks disagree about whether it is valid. Five minutes
 * makes skew a rounding error.
 */
export const MIN_TTL_SECONDS = 300;
export const MAX_TTL_SECONDS = 900;
export const DEFAULT_TTL_SECONDS = 600;

/**
 * How far in the past `nbf` is set.
 *
 * Covers our clock being ahead of the ERP's by more than its skew tolerance,
 * which would otherwise reject a freshly minted token as `not_yet_valid_token` —
 * a failure that looks like a signing bug and is a clock bug.
 */
export const NOT_BEFORE_SKEW_SECONDS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceTokenRequest {
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  /** EXACTLY ONE ERP role. See the validation below for why this is not a list. */
  readonly role: string;
  readonly subject: string;
  readonly ttlSeconds: number;
  readonly nowSeconds: number;
  readonly jti?: string;
}

export interface MintedServiceToken {
  readonly token: string;
  readonly kid: string;
  readonly expiresAtSeconds: number;
  readonly jti: string;
}

/**
 * Mints a service JWT the ERP's gateway will accept.
 *
 * Every claim below is validated here rather than relying on the ERP to reject a
 * bad one, because THE ERP'S VERIFIER ONLY CHECKS CLAIMS THAT ARE PRESENT:
 *
 *     if (typeof jwt.payload.exp === "number" && …)   // no exp  → never expires
 *     if (typeof jwt.payload.iss === "string" && …)   // no iss  → any issuer
 *     if (aud !== undefined && !audOk)                // no aud  → any audience
 *
 * A token we mint without `exp` is therefore valid forever, and nothing
 * downstream will tell us. That makes emitting all three our responsibility
 * alone, which is why they are required fields and why a test asserts every
 * minted token carries them.
 */
export async function mintServiceToken(
  signer: ServiceKeySigner,
  req: ServiceTokenRequest,
): Promise<MintedServiceToken> {
  if (req.issuer === "") throw new ServiceTokenError("issuer must not be empty");
  if (req.audience === "") throw new ServiceTokenError("audience must not be empty");
  if (req.subject === "") throw new ServiceTokenError("subject must not be empty");

  // A non-UUID tenant does not fail at the ERP — `principalFromJwtClaims` sets the
  // principal's tenant to NULL and the request proceeds without one. Refusing here
  // keeps a malformed tenant id from becoming an unscoped ERP call.
  if (!UUID_RE.test(req.tenantId)) {
    throw new ServiceTokenError(`tenant_id must be a UUID; got ${JSON.stringify(req.tenantId)}`);
  }

  // One role, no whitespace. The ERP splits `scope` on spaces and reads only the
  // first entry as the principal's role, so "sales_rep controller" would grant
  // sales_rep and discard the rest — while reading as though it granted both.
  if (req.role === "") throw new ServiceTokenError("role must not be empty");
  if (/\s/.test(req.role)) {
    throw new ServiceTokenError(
      `role must be a single scope with no whitespace; got ${JSON.stringify(req.role)}. ` +
        `The ERP reads only the first space-separated scope as the role, so the rest would be silently ignored.`,
    );
  }

  if (!Number.isInteger(req.ttlSeconds) || req.ttlSeconds < MIN_TTL_SECONDS || req.ttlSeconds > MAX_TTL_SECONDS) {
    throw new ServiceTokenError(
      `ttlSeconds must be an integer in [${MIN_TTL_SECONDS}, ${MAX_TTL_SECONDS}]; got ${req.ttlSeconds}`,
    );
  }
  if (!Number.isInteger(req.nowSeconds)) {
    throw new ServiceTokenError(`nowSeconds must be an integer; got ${req.nowSeconds}`);
  }

  const jti = req.jti ?? randomUUID();
  const exp = req.nowSeconds + req.ttlSeconds;

  // `typ: "JWT"` is not checked by the ERP, which parses the header for alg, kid
  // and typ and uses only the first two. Sent because it is what every other JWT
  // consumer expects.
  const header = { alg: "EdDSA", typ: "JWT", kid: signer.kid };
  const payload = {
    iss: req.issuer,
    aud: req.audience,
    sub: req.subject,
    // The gateway treats this claim as authoritative and cross-checks it against
    // the `x-tenant-id` header, rejecting a mismatch as `tenant_mismatch`. The
    // header alone is spoofable; this is what makes it not matter.
    tenant_id: req.tenantId,
    scope: req.role,
    iat: req.nowSeconds,
    nbf: req.nowSeconds - NOT_BEFORE_SKEW_SECONDS,
    exp,
    jti,
  };

  const signingInput = `${jsonToBase64url(header)}.${jsonToBase64url(payload)}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  return { token: `${signingInput}.${base64url(signature)}`, kid: signer.kid, expiresAtSeconds: exp, jti };
}

function jsonToBase64url(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decodes a token's claims without verifying it.
 *
 * For logging and for the tests, never for a trust decision — there is no
 * signature check here. Named to make that obvious at the call site.
 */
export function decodeUnverified(token: string): {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    if (typeof header !== "object" || header === null || typeof payload !== "object" || payload === null) {
      return null;
    }
    return { header: header as Record<string, unknown>, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}
