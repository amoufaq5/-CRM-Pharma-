import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, sign as edSign } from "node:crypto";
import { JwksCache, JwtError, parseJwks, verifyJwt, type JwksKey } from "./jwt.js";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed = generateKeyPairSync("ed25519");
const rsa2 = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function makeToken(
  claims: Record<string, unknown>,
  opts: { alg?: string; kid?: string; key?: "rsa" | "ed" | "rsa2"; signature?: string } = {},
): string {
  const alg = opts.alg ?? "RS256";
  const header = b64({ alg, kid: opts.kid ?? "k1", typ: "JWT" });
  const payload = b64(claims);
  const input = Buffer.from(`${header}.${payload}`);
  if (opts.signature !== undefined) return `${header}.${payload}.${opts.signature}`;
  const which = opts.key ?? (alg === "EdDSA" ? "ed" : "rsa");
  const sig =
    which === "ed"
      ? edSign(null, input, ed.privateKey)
      : createSign("RSA-SHA256").update(input).sign(which === "rsa2" ? rsa2.privateKey : rsa.privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

const KEYS: readonly JwksKey[] = [
  { kid: "k1", alg: "RS256", key: rsa.publicKey },
  { kid: "e1", alg: "EdDSA", key: ed.publicKey },
];

const NOW = 1_800_000_000_000;
const base = {
  sub: "auth0|abc",
  iss: "https://idp.test/",
  aud: "crm-pharma",
  exp: Math.floor(NOW / 1000) + 3600,
};
const opts = { issuer: "https://idp.test/", audience: "crm-pharma", keys: KEYS, now: () => NOW };

describe("verifyJwt — the happy paths", () => {
  it("verifies RS256, which is what a normal OIDC IdP issues", () => {
    // Deliberately supported: the ERP's verifier is Ed25519-only, but that
    // constrains the credential the CRM MINTS, not the IdP that logs people in.
    expect(verifyJwt(makeToken(base), opts).sub).toBe("auth0|abc");
  });

  it("verifies EdDSA too", () => {
    expect(verifyJwt(makeToken(base, { alg: "EdDSA", kid: "e1" }), opts).sub).toBe("auth0|abc");
  });

  it("accepts an aud array containing the audience", () => {
    expect(verifyJwt(makeToken({ ...base, aud: ["other", "crm-pharma"] }), opts).sub).toBe("auth0|abc");
  });

  it("passes through a tenant claim", () => {
    const t = "11111111-1111-4111-8111-111111111111";
    expect(verifyJwt(makeToken({ ...base, tenant: t }), opts).tenant).toBe(t);
  });
});

describe("verifyJwt — the refusals that matter", () => {
  it('refuses alg "none"', () => {
    // The original JWT catastrophe. An explicit allow-list refuses it by
    // construction rather than by remembering to check.
    expect(() => verifyJwt(makeToken(base, { alg: "none", signature: "" }), opts)).toThrow(
      /unsupported_algorithm/,
    );
  });

  it("refuses HS256, so a signature cannot be forged with the public key", () => {
    // The classic confusion attack: sign with HMAC using the RSA public key as
    // the secret, and a naive verifier accepts it.
    expect(() => verifyJwt(makeToken(base, { alg: "HS256", signature: "x" }), opts)).toThrow(
      /unsupported_algorithm/,
    );
  });

  it("refuses a token signed by the WRONG key", () => {
    expect(() => verifyJwt(makeToken(base, { key: "rsa2" }), opts)).toThrow(/bad_signature/);
  });

  it("refuses a tampered payload", () => {
    const token = makeToken(base);
    const [h, , s] = token.split(".") as [string, string, string];
    const forged = `${h}.${b64({ ...base, sub: "attacker" })}.${s}`;
    expect(() => verifyJwt(forged, opts)).toThrow(/bad_signature/);
  });

  it("refuses an unknown kid rather than trying every key", () => {
    // Trying each key in turn would turn a rotation mistake into a silent
    // success against the wrong key.
    expect(() => verifyJwt(makeToken(base, { kid: "nope" }), opts)).toThrow(/unknown_key/);
  });

  it("refuses a token with no kid at all", () => {
    const header = b64({ alg: "RS256", typ: "JWT" });
    const payload = b64(base);
    const sig = createSign("RSA-SHA256").update(Buffer.from(`${header}.${payload}`)).sign(rsa.privateKey);
    expect(() => verifyJwt(`${header}.${payload}.${sig.toString("base64url")}`, opts)).toThrow(
      /unknown_key/,
    );
  });

  it("refuses an alg/key mismatch — an RS256 header against the Ed25519 kid", () => {
    expect(() => verifyJwt(makeToken(base, { kid: "e1", alg: "RS256" }), opts)).toThrow(/unknown_key/);
  });

  it("refuses an expired token, and an unexpired one just outside the skew", () => {
    const expired = { ...base, exp: Math.floor(NOW / 1000) - 120 };
    expect(() => verifyJwt(makeToken(expired), opts)).toThrow(/expired/);
    // Inside the 60s tolerance it is still accepted, which is the point of skew.
    const justExpired = { ...base, exp: Math.floor(NOW / 1000) - 30 };
    expect(verifyJwt(makeToken(justExpired), opts).sub).toBe("auth0|abc");
  });

  it("refuses a token that is not valid yet", () => {
    expect(() =>
      verifyJwt(makeToken({ ...base, nbf: Math.floor(NOW / 1000) + 600 }), opts),
    ).toThrow(/not_yet_valid/);
  });

  it("refuses the wrong issuer and the wrong audience", () => {
    expect(() => verifyJwt(makeToken({ ...base, iss: "https://evil.test/" }), opts)).toThrow(
      /wrong_issuer/,
    );
    expect(() => verifyJwt(makeToken({ ...base, aud: "someone-else" }), opts)).toThrow(
      /wrong_audience/,
    );
  });

  it("refuses a token with no subject", () => {
    const { sub: _sub, ...noSub } = base;
    expect(() => verifyJwt(makeToken(noSub), opts)).toThrow(/no_subject/);
  });

  it.each(["", "a", "a.b", "a.b.c.d", "not-a-token"])("refuses the malformed token %s", (bad) => {
    expect(() => verifyJwt(bad, opts)).toThrow(JwtError);
  });

  it("checks the signature BEFORE trusting any claim", () => {
    // A forged token with a wrong issuer must fail on the signature, not the
    // issuer: rejecting on a claim first leaks whether a guess was close.
    const forged = makeToken({ ...base, iss: "https://evil.test/" }, { key: "rsa2" });
    expect(() => verifyJwt(forged, opts)).toThrow(/bad_signature/);
  });
});

describe("parseJwks", () => {
  const rsaJwk = rsa.publicKey.export({ format: "jwk" });
  const edJwk = ed.publicKey.export({ format: "jwk" });

  it("reads RSA and Ed25519 keys", () => {
    const keys = parseJwks({ keys: [{ ...rsaJwk, kid: "k1" }, { ...edJwk, kid: "e1" }] });
    expect(keys.map((k) => [k.kid, k.alg])).toEqual([["k1", "RS256"], ["e1", "EdDSA"]]);
  });

  it("drops a key with no kid, since it could never be selected", () => {
    expect(parseJwks({ keys: [rsaJwk] })).toHaveLength(0);
  });

  it("skips an entry Node refuses to parse, instead of failing the whole document", () => {
    // One bad key in an IdP's JWKS must not lock every user out.
    const keys = parseJwks({
      keys: [{ kty: "OKP", crv: "Ed25519", kid: "bad", x: "!!!" }, { ...rsaJwk, kid: "k1" }],
    });
    expect(keys.map((k) => k.kid)).toEqual(["k1"]);
  });

  it("ADMITS an RSA key with a garbage modulus — which is safe, and worth knowing", () => {
    // Measured, not assumed: node's createPublicKey accepts { kty:"RSA",
    // n:"!!!" } without complaint, so parseJwks cannot filter it. That is
    // harmless — a key that constructs but is not the IdP's simply fails
    // verification, and the token is rejected — but a reader of parseJwks
    // should not believe it validates key MATERIAL. It validates key SHAPE.
    const keys = parseJwks({ keys: [{ kty: "RSA", kid: "garbage", n: "!!!", e: "AQAB" }] });
    expect(keys.map((k) => k.kid)).toEqual(["garbage"]);

    // And the token still does not verify against it, which is the property
    // that actually matters.
    expect(() =>
      verifyJwt(makeToken(base, { kid: "garbage" }), { ...opts, keys }),
    ).toThrow(/bad_signature/);
  });

  it("returns nothing for a non-document", () => {
    expect(parseJwks(null)).toHaveLength(0);
    expect(parseJwks({ keys: "nope" })).toHaveLength(0);
  });
});

describe("JwksCache", () => {
  const rsaJwk = rsa.publicKey.export({ format: "jwk" });
  const doc = { keys: [{ ...rsaJwk, kid: "k1" }] };

  it("fetches once and serves from cache", async () => {
    let calls = 0;
    const cache = new JwksCache("https://idp.test/jwks", async () => {
      calls += 1;
      return doc;
    }, { now: () => NOW });
    await cache.get();
    await cache.get();
    expect(calls).toBe(1);
  });

  it("refetches on an unknown kid, so a rotation needs no restart", async () => {
    let calls = 0;
    let now = NOW;
    const cache = new JwksCache("https://idp.test/jwks", async () => {
      calls += 1;
      return doc;
    }, { now: () => now, minRefetchMs: 10_000 });
    await cache.get("k1");
    now += 20_000;
    await cache.get("unknown");
    expect(calls).toBe(2);
  });

  it("rate-limits the refetch, so a junk kid cannot cause a fetch per request", async () => {
    let calls = 0;
    const cache = new JwksCache("https://idp.test/jwks", async () => {
      calls += 1;
      return doc;
    }, { now: () => NOW, minRefetchMs: 10_000 });
    await cache.get("k1");
    for (let i = 0; i < 20; i += 1) await cache.get("junk");
    expect(calls).toBe(1);
  });

  it("keeps the last good set when a refetch fails", async () => {
    let calls = 0;
    let now = NOW;
    const cache = new JwksCache("https://idp.test/jwks", async () => {
      calls += 1;
      if (calls > 1) throw new Error("IdP down");
      return doc;
    }, { now: () => now, ttlMs: 1000 });
    expect(await cache.get()).toHaveLength(1);
    now += 60_000;
    // Resilient rather than fail-closed here on purpose: locking every user out
    // because the IdP blipped is worse than serving the keys we already trusted.
    expect(await cache.get()).toHaveLength(1);
  });

  it("treats an EMPTY parse as a failure, not as 'the IdP has no keys'", async () => {
    let first = true;
    let now = NOW;
    const cache = new JwksCache("https://idp.test/jwks", async () => {
      if (first) {
        first = false;
        return doc;
      }
      return { keys: [] };
    }, { now: () => now, ttlMs: 1000 });
    await cache.get();
    now += 60_000;
    expect(await cache.get()).toHaveLength(1);
  });
});
