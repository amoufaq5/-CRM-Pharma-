import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { beginLogin, challengeFor, claimsOf, completeLogin, isExpired, randomVerifier, readCallback, type AuthStorage } from "./auth.js";

// Node's own implementation, accepted directly because `challengeFor` asks for a
// digester rather than the whole of SubtleCrypto.
const subtle = webcrypto.subtle;

function memoryStorage(seed: Record<string, string> = {}): AuthStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      data[k] = v;
    },
    remove: (k) => {
      delete data[k];
    },
  };
}

const discovery = {
  issuer: "https://idp.example",
  authorization_endpoint: "https://idp.example/authorize",
  token_endpoint: "https://idp.example/token",
};

function stubFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    const handler = Object.entries(handlers).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

const discoveryFetch = stubFetch({
  "https://idp.example/.well-known/openid-configuration": () => new Response(JSON.stringify(discovery), { status: 200 }),
});

describe("PKCE", () => {
  it("produces the S256 challenge the RFC specifies", async () => {
    // RFC 7636's own test vector. If this drifts, every login fails at the token
    // exchange with a message about the verifier, which is not a thing to debug twice.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await challengeFor(verifier, subtle)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("mints a verifier with 256 bits of entropy, url-safe", () => {
    const v = randomVerifier((b) => webcrypto.getRandomValues(b));
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(v).not.toBe(randomVerifier((b) => webcrypto.getRandomValues(b)));
  });
});

describe("beginLogin", () => {
  const config = { issuer: "https://idp.example", clientId: "crm-field", redirectUri: "https://field.example/", scope: "openid profile" };

  it("builds an authorize URL with S256 and keeps the verifier on the device", async () => {
    const storage = memoryStorage();
    const url = new URL(await beginLogin(config, { storage, fetchImpl: discoveryFetch, subtle, random: (b) => webcrypto.getRandomValues(b) }));

    expect(url.origin + url.pathname).toBe("https://idp.example/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("crm-field");
    expect(url.searchParams.get("redirect_uri")).toBe("https://field.example/");
    // The verifier is never in the URL — only its hash. That is the whole point of PKCE.
    const verifier = storage.data["crm.pkce.verifier"];
    expect(verifier).toBeDefined();
    expect(url.toString()).not.toContain(verifier as string);
    expect(url.searchParams.get("code_challenge")).toBe(await challengeFor(verifier as string, subtle));
  });

  it("sends an audience only when one is configured", async () => {
    const storage = memoryStorage();
    const plain = new URL(await beginLogin(config, { storage, fetchImpl: discoveryFetch, subtle }));
    expect(plain.searchParams.has("audience")).toBe(false);
    const withAud = new URL(await beginLogin({ ...config, audience: "crm-api" }, { storage, fetchImpl: discoveryFetch, subtle }));
    expect(withAud.searchParams.get("audience")).toBe("crm-api");
  });
});

describe("completeLogin", () => {
  const config = { issuer: "https://idp.example", clientId: "crm-field", redirectUri: "https://field.example/", scope: "openid" };
  const tokenFetch = (body: unknown, status = 200): typeof fetch =>
    stubFetch({
      "https://idp.example/.well-known/openid-configuration": () => new Response(JSON.stringify(discovery), { status: 200 }),
      "https://idp.example/token": () => new Response(JSON.stringify(body), { status }),
    });

  it("exchanges the code and shortens the expiry by a minute", async () => {
    // A token used at the moment it expires is a 401 mid-request, and the queue pays
    // for it — so the client treats itself as expired a minute early.
    const storage = memoryStorage({ "crm.pkce.verifier": "v", "crm.pkce.state": "s" });
    const session = await completeLogin(config, { code: "c", state: "s" }, {
      storage,
      fetchImpl: tokenFetch({ access_token: "at", token_type: "Bearer", expires_in: 3600 }),
      now: () => 1_000_000,
    });
    expect(session.accessToken).toBe("at");
    expect(session.expiresAt).toBe(1_000_000 + 3540 * 1000);
    // The verifier and state are consumed, so a replayed callback cannot reuse them.
    expect(storage.data["crm.pkce.verifier"]).toBeUndefined();
    expect(storage.data["crm.pkce.state"]).toBeUndefined();
  });

  it("assumes a SHORT life for a token with no expires_in", async () => {
    const storage = memoryStorage({ "crm.pkce.verifier": "v", "crm.pkce.state": "s" });
    const session = await completeLogin(config, { code: "c", state: "s" }, {
      storage,
      fetchImpl: tokenFetch({ access_token: "at", token_type: "Bearer" }),
      now: () => 0,
    });
    expect(session.expiresAt).toBe(240_000);
  });

  it("REFUSES a callback whose state does not match, which is the CSRF case", async () => {
    const storage = memoryStorage({ "crm.pkce.verifier": "v", "crm.pkce.state": "mine" });
    await expect(
      completeLogin(config, { code: "c", state: "theirs" }, { storage, fetchImpl: tokenFetch({}) }),
    ).rejects.toThrow(/state did not match/);
  });

  it("refuses when there is no verifier for this login", async () => {
    const storage = memoryStorage({ "crm.pkce.state": "s" });
    await expect(completeLogin(config, { code: "c", state: "s" }, { storage, fetchImpl: tokenFetch({}) })).rejects.toThrow(/no PKCE verifier/);
  });

  it("reports the provider's own refusal", async () => {
    const storage = memoryStorage();
    await expect(
      completeLogin(config, { error: "access_denied", errorDescription: "user cancelled" }, { storage, fetchImpl: tokenFetch({}) }),
    ).rejects.toThrow(/user cancelled/);
  });

  it("reports a failed token exchange with the provider's description", async () => {
    const storage = memoryStorage({ "crm.pkce.verifier": "v", "crm.pkce.state": "s" });
    await expect(
      completeLogin(config, { code: "c", state: "s" }, {
        storage,
        fetchImpl: tokenFetch({ error: "invalid_grant", error_description: "code already used" }, 400),
      }),
    ).rejects.toThrow(/code already used/);
  });
});

describe("readCallback", () => {
  it("reads a success and an error callback", () => {
    expect(readCallback("?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
    expect(readCallback("error=access_denied&error_description=no")).toEqual({ error: "access_denied", errorDescription: "no" });
  });

  it("reads nothing out of a plain load", () => {
    expect(readCallback("")).toEqual({});
  });
});

describe("claimsOf", () => {
  const encode = (payload: unknown): string =>
    `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("reads the tenant and subject without verifying anything", () => {
    // Unverified on purpose, and safe for exactly this: choosing a header and a label.
    // The API verifies the signature itself and RLS confines every row, so a forged
    // token read here buys a wrong name on the attacker's own screen and a 401.
    expect(claimsOf(encode({ tenant: "T1", sub: "u1" }))).toEqual({ tenantId: "T1", subject: "u1" });
    expect(claimsOf(encode({ tenant_id: "T2" }))).toEqual({ tenantId: "T2" });
  });

  it("returns nothing for a token it cannot read, rather than throwing mid-boot", () => {
    expect(claimsOf("not-a-jwt")).toEqual({});
    expect(claimsOf("a.!!!.c")).toEqual({});
    expect(claimsOf(encode("a string payload"))).toEqual({});
  });
});

describe("isExpired", () => {
  it("is true at the expiry instant, not after it", () => {
    expect(isExpired({ accessToken: "a", expiresAt: 1000 }, 999)).toBe(false);
    expect(isExpired({ accessToken: "a", expiresAt: 1000 }, 1000)).toBe(true);
  });
});
