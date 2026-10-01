import { describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";

import {
  base64url,
  buildJwksDocument,
  ed25519Jwk,
  fromBase64url,
  JwkError,
  JWKS_CACHE_SECONDS,
  jwkThumbprint,
  jwksResponse,
} from "./jwk.js";
import { generateServiceKeyPair } from "./signer.js";

describe("jwkThumbprint", () => {
  it("is deterministic and key-dependent", () => {
    const a = generateServiceKeyPair();
    const b = generateServiceKeyPair();
    expect(jwkThumbprint(a.jwk.x)).toBe(a.kid);
    expect(jwkThumbprint(a.jwk.x)).toBe(jwkThumbprint(a.jwk.x));
    expect(jwkThumbprint(a.jwk.x)).not.toBe(jwkThumbprint(b.jwk.x));
  });

  it("is base64url with no padding, so it is safe in a JWT header and a URL", () => {
    const { kid } = generateServiceKeyPair();
    expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("matches the RFC 7638 canonical form exactly", async () => {
    // The thumbprint is over the REQUIRED members only, lexicographically ordered,
    // with no whitespace. Recomputing it the long way here pins that: a formatting
    // change in the canonical string silently changes every kid, and every kid a
    // verifier has cached stops resolving.
    const { createHash } = await import("node:crypto");
    const x = base64url(new Uint8Array(32).fill(7));
    const expected = createHash("sha256")
      .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }), "utf8")
      .digest("base64url");
    expect(jwkThumbprint(x)).toBe(expected);
  });

  it("refuses an empty key", () => {
    expect(() => jwkThumbprint("")).toThrow(JwkError);
  });
});

describe("ed25519Jwk", () => {
  it("produces a JWK Node itself accepts as a public key", () => {
    // If Node can import it, so can the ERP — its verifier builds the key the same
    // way, from kty/crv/x.
    const { jwk } = generateServiceKeyPair();
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("carries the four members the ERP's parser requires", () => {
    const { jwk } = generateServiceKeyPair();
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(typeof jwk.kid).toBe("string");
    expect(typeof jwk.x).toBe("string");
  });

  it("rejects a key of the wrong length", () => {
    expect(() => ed25519Jwk(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => ed25519Jwk(new Uint8Array(33))).toThrow(/32 bytes/);
  });

  it("round-trips through base64url", () => {
    const raw = new Uint8Array(32).map((_, i) => i * 7 % 256);
    expect([...fromBase64url(base64url(raw))]).toEqual([...raw]);
  });
});

describe("buildJwksDocument", () => {
  it("publishes every key given", () => {
    const a = generateServiceKeyPair();
    const b = generateServiceKeyPair();
    const doc = buildJwksDocument([
      { kid: a.kid, x: a.jwk.x },
      { kid: b.kid, x: b.jwk.x },
    ]);
    expect(doc.keys.map((k) => k.kid)).toEqual([a.kid, b.kid]);
  });

  it("refuses a kid that is not its own key's thumbprint", () => {
    // The registry stores kid and key separately, so a row edited by hand can claim
    // a kid nothing signs under. Published, that is a JWKS which looks correct and
    // rejects every token referencing the key.
    const a = generateServiceKeyPair();
    const b = generateServiceKeyPair();
    expect(() => buildJwksDocument([{ kid: b.kid, x: a.jwk.x }])).toThrow(/not the thumbprint/);
  });

  it("refuses a duplicate kid", () => {
    const a = generateServiceKeyPair();
    expect(() =>
      buildJwksDocument([
        { kid: a.kid, x: a.jwk.x },
        { kid: a.kid, x: a.jwk.x },
      ]),
    ).toThrow(/duplicate kid/);
  });
});

describe("jwksResponse", () => {
  /**
   * The most consequential assertion in this file.
   *
   * The ERP's RemoteJwksProvider keeps its last good key set on a non-200 and
   * REPLACES it with whatever a 200 contains. A 200 carrying `{"keys":[]}`
   * therefore wipes a working verifier and 401s every subsequent request until a
   * later refresh happens to succeed. 503 is the safe answer, which is the whole
   * reason this function exists instead of the route returning the document.
   */
  it("returns 503 — never an empty 200 — when there is nothing to publish", () => {
    const res = jwksResponse([]);
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain('"keys"');
  });

  it("returns the document with a cache window no longer than the ERP's own", () => {
    const a = generateServiceKeyPair();
    const res = jwksResponse([{ kid: a.kid, x: a.jwk.x }]);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/jwk-set+json");
    expect(res.headers["cache-control"]).toBe(`public, max-age=${JWKS_CACHE_SECONDS}`);
    // The ERP's default JWKS cache is 300s; asking for longer would be asking it to
    // hold a retired key past the window the retirement rule assumes.
    expect(JWKS_CACHE_SECONDS).toBeLessThan(300);
  });

  it("propagates a malformed key set as an error rather than serving it", () => {
    const a = generateServiceKeyPair();
    const b = generateServiceKeyPair();
    expect(() => jwksResponse([{ kid: b.kid, x: a.jwk.x }])).toThrow(JwkError);
  });
});
