import { describe, expect, it } from "vitest";

import { generateServiceKeyPair, LocalEd25519Signer, type ServiceKeySigner } from "./signer.js";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  NOT_BEFORE_SKEW_SECONDS,
  ServiceTokenError,
  decodeUnverified,
  mintServiceToken,
  type ServiceTokenRequest,
} from "./token.js";

const TENANT = "3f1b7c22-5e2a-4a5f-9f4a-0c1d2e3f4a5b";

function signer(): ServiceKeySigner {
  return LocalEd25519Signer.fromPkcs8Pem(generateServiceKeyPair().privateKeyPem);
}

function req(overrides: Partial<ServiceTokenRequest> = {}): ServiceTokenRequest {
  return {
    issuer: "https://crm.example.com/",
    audience: "crossengin-erp",
    tenantId: TENANT,
    role: "controller",
    subject: `crm-service:${TENANT}`,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    nowSeconds: 1_800_000_000,
    ...overrides,
  };
}

describe("mintServiceToken claims", () => {
  it("emits three dot-separated base64url parts", async () => {
    const { token } = await mintServiceToken(signer(), req());
    expect(token.split(".")).toHaveLength(3);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("sets iat, nbf and exp consistently", async () => {
    const now = 1_800_000_000;
    const { token, expiresAtSeconds } = await mintServiceToken(signer(), req({ nowSeconds: now, ttlSeconds: 600 }));
    const payload = decodeUnverified(token)!.payload;
    expect(payload["iat"]).toBe(now);
    expect(payload["nbf"]).toBe(now - NOT_BEFORE_SKEW_SECONDS);
    expect(payload["exp"]).toBe(now + 600);
    expect(expiresAtSeconds).toBe(now + 600);
  });

  it("gives every token a distinct jti", async () => {
    const s = signer();
    const a = await mintServiceToken(s, req());
    const b = await mintServiceToken(s, req());
    expect(a.jti).not.toBe(b.jti);
    expect(decodeUnverified(a.token)!.payload["jti"]).toBe(a.jti);
  });

  it("reports the kid it signed with", async () => {
    const s = signer();
    const minted = await mintServiceToken(s, req());
    expect(minted.kid).toBe(s.kid);
    expect(decodeUnverified(minted.token)!.header["kid"]).toBe(s.kid);
  });
});

describe("mintServiceToken validation", () => {
  /**
   * The ERP does not reject a non-UUID tenant — `principalFromJwtClaims` sets the
   * principal's tenant to null and the request carries on without one. Refusing here
   * is the only place that is caught.
   */
  it("refuses a tenant id that is not a UUID", async () => {
    await expect(mintServiceToken(signer(), req({ tenantId: "acme" }))).rejects.toThrow(/must be a UUID/);
    await expect(mintServiceToken(signer(), req({ tenantId: "" }))).rejects.toThrow(ServiceTokenError);
  });

  /**
   * A space in the role would read as two scopes, and the ERP takes only the first
   * as the principal's role. 'sales_rep controller' would look like it granted both
   * and would grant sales_rep.
   */
  it("refuses a role containing whitespace, explaining what the ERP would do with it", async () => {
    await expect(mintServiceToken(signer(), req({ role: "sales_rep controller" }))).rejects.toThrow(
      /only the first space-separated scope/,
    );
    await expect(mintServiceToken(signer(), req({ role: "controller\n" }))).rejects.toThrow(ServiceTokenError);
    await expect(mintServiceToken(signer(), req({ role: "" }))).rejects.toThrow(/must not be empty/);
  });

  it("refuses an empty issuer, audience or subject", async () => {
    await expect(mintServiceToken(signer(), req({ issuer: "" }))).rejects.toThrow(/issuer/);
    await expect(mintServiceToken(signer(), req({ audience: "" }))).rejects.toThrow(/audience/);
    await expect(mintServiceToken(signer(), req({ subject: "" }))).rejects.toThrow(/subject/);
  });

  it("holds the TTL inside the 5-to-15-minute band the ADR specifies", async () => {
    await expect(mintServiceToken(signer(), req({ ttlSeconds: MIN_TTL_SECONDS - 1 }))).rejects.toThrow(/ttlSeconds/);
    await expect(mintServiceToken(signer(), req({ ttlSeconds: MAX_TTL_SECONDS + 1 }))).rejects.toThrow(/ttlSeconds/);
    await expect(mintServiceToken(signer(), req({ ttlSeconds: 600.5 }))).rejects.toThrow(/integer/);
    // The floor exists because the ERP tolerates 30s of clock skew; a token shorter
    // than a few minutes spends a meaningful fraction of its life ambiguous.
    expect(MIN_TTL_SECONDS).toBeGreaterThanOrEqual(300);
    expect(MAX_TTL_SECONDS).toBeLessThanOrEqual(900);
  });

  it("refuses a non-integer clock reading, which would produce a fractional exp", async () => {
    await expect(mintServiceToken(signer(), req({ nowSeconds: 1_800_000_000.7 }))).rejects.toThrow(/nowSeconds/);
  });
});

describe("decodeUnverified", () => {
  it("returns null for anything that is not a three-part JWT", () => {
    expect(decodeUnverified("")).toBeNull();
    expect(decodeUnverified("a.b")).toBeNull();
    expect(decodeUnverified("a.b.c.d")).toBeNull();
    expect(decodeUnverified("!!!.!!!.!!!")).toBeNull();
  });

  it("returns null when a part is not JSON, rather than throwing into a log line", () => {
    const notJson = Buffer.from("plain text").toString("base64url");
    expect(decodeUnverified(`${notJson}.${notJson}.x`)).toBeNull();
  });
});
