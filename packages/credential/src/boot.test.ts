import { describe, expect, it } from "vitest";

import { CredentialConfigError, resolveCredentialConfig, type EnvLike } from "./boot.js";
import { generateServiceKeyPair } from "./signer.js";
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "./token.js";

const PEM = generateServiceKeyPair().privateKeyPem;

const signingEnv = (extra: EnvLike = {}): EnvLike => ({
  CRM_SIGNING_KEY_PEM: PEM,
  CRM_TOKEN_ISSUER: "https://crm.example.com/",
  ERP_TOKEN_AUDIENCE: "crossengin-erp",
  ...extra,
});

describe("resolveCredentialConfig", () => {
  it("chooses the signing credential when a key is configured", () => {
    const config = resolveCredentialConfig(signingEnv());
    expect(config.kind).toBe("signing");
    if (config.kind !== "signing") throw new Error("unreachable");
    expect(config.issuer).toBe("https://crm.example.com/");
    expect(config.audience).toBe("crossengin-erp");
    expect(config.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
  });

  /**
   * An environment that still carries a leftover ERP_TOKEN must not keep using it
   * once a real key is available. Precedence, not a merge, and not an error: the
   * migration path is "add the key, then delete the token", and the middle state
   * has to do the right thing.
   */
  it("prefers the signing key over a leftover static token", () => {
    expect(resolveCredentialConfig(signingEnv({ ERP_TOKEN: "stale" })).kind).toBe("signing");
  });

  it("reads the key from a file when asked", () => {
    const config = resolveCredentialConfig(
      { ...signingEnv(), CRM_SIGNING_KEY_PEM: undefined, CRM_SIGNING_KEY_FILE: "/secrets/key.pem" },
      (path) => (path === "/secrets/key.pem" ? PEM : (() => { throw new Error("ENOENT"); })()),
    );
    expect(config.kind).toBe("signing");
  });

  it("reports an unreadable key file by path instead of falling back", () => {
    expect(() =>
      resolveCredentialConfig({ ...signingEnv(), CRM_SIGNING_KEY_PEM: undefined, CRM_SIGNING_KEY_FILE: "/nope" }, () => {
        throw new Error("ENOENT: no such file");
      }),
    ).toThrow(/CRM_SIGNING_KEY_FILE \/nope could not be read/);
  });

  it("refuses both key sources at once rather than picking one", () => {
    // Which one is live decides which key signs, and the only symptom of choosing
    // wrong is a 401.
    expect(() => resolveCredentialConfig(signingEnv({ CRM_SIGNING_KEY_FILE: "/secrets/key.pem" }))).toThrow(
      /both set/,
    );
  });

  it("requires the issuer and audience, naming the ERP flag each must match", () => {
    expect(() => resolveCredentialConfig(signingEnv({ CRM_TOKEN_ISSUER: undefined }))).toThrow(/--jwt-issuer/);
    expect(() => resolveCredentialConfig(signingEnv({ ERP_TOKEN_AUDIENCE: "" }))).toThrow(/--jwt-audience/);
  });

  it("holds a configured TTL inside the band the minter accepts", () => {
    expect(resolveCredentialConfig(signingEnv({ ERP_TOKEN_TTL_SECONDS: "300" }))).toMatchObject({ ttlSeconds: 300 });
    for (const bad of [String(MIN_TTL_SECONDS - 1), String(MAX_TTL_SECONDS + 1), "abc", "600.5"]) {
      expect(() => resolveCredentialConfig(signingEnv({ ERP_TOKEN_TTL_SECONDS: bad }))).toThrow(
        /ERP_TOKEN_TTL_SECONDS/,
      );
    }
  });

  describe("the static development token", () => {
    it("is accepted outside production", () => {
      expect(resolveCredentialConfig({ ERP_TOKEN: "dev-token" })).toEqual({ kind: "static", token: "dev-token" });
      expect(resolveCredentialConfig({ ERP_TOKEN: "dev-token", NODE_ENV: "development" }).kind).toBe("static");
    });

    /**
     * The refusal that was already in the scheduler and is now enforced here, where
     * it can be tested. A single static bearer token is shared across tenants,
     * carries whatever role the ERP bound it to, and cannot be rotated without a
     * restart — acceptable against a throwaway ERP, not against real tenants.
     */
    it("is refused in production, pointing at what to set instead", () => {
      expect(() => resolveCredentialConfig({ ERP_TOKEN: "dev-token", NODE_ENV: "production" })).toThrow(
        /CRM_SIGNING_KEY_PEM/,
      );
    });

    it("does not count an empty ERP_TOKEN as a credential", () => {
      expect(() => resolveCredentialConfig({ ERP_TOKEN: "" })).toThrow(/no ERP credential is configured/);
    });
  });

  it("refuses to start with no credential at all", () => {
    // A process that starts credential-less just accumulates failures on the first
    // ERP call, which reads as an ERP outage rather than a missing variable.
    expect(() => resolveCredentialConfig({})).toThrow(CredentialConfigError);
    expect(() => resolveCredentialConfig({ NODE_ENV: "production" })).toThrow(/no ERP credential is configured/);
  });
});
