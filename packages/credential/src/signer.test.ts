import { describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { base64url } from "./jwk.js";
import { generateServiceKeyPair, LocalEd25519Signer, SignerError } from "./signer.js";

describe("generateServiceKeyPair", () => {
  it("returns a PKCS#8 PEM and a matching JWK", () => {
    const g = generateServiceKeyPair();
    expect(g.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(g.jwk.kid).toBe(g.kid);
    const loaded = LocalEd25519Signer.fromPkcs8Pem(g.privateKeyPem);
    expect(loaded.kid).toBe(g.kid);
    expect(base64url(loaded.publicKeyRaw)).toBe(g.jwk.x);
  });

  it("generates a distinct key every time", () => {
    const seen = new Set(Array.from({ length: 5 }, () => generateServiceKeyPair().kid));
    expect(seen.size).toBe(5);
  });
});

describe("LocalEd25519Signer", () => {
  it("signs something Node verifies against the published public key", () => {
    const g = generateServiceKeyPair();
    const signer = LocalEd25519Signer.fromPkcs8Pem(g.privateKeyPem);
    const message = new TextEncoder().encode("a.b");
    return signer.sign(message).then((sig) => {
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: g.jwk.x }, format: "jwk" });
      expect(cryptoVerify(null, Buffer.from(message), pub, Buffer.from(sig))).toBe(true);
      expect(sig.length).toBe(64);
    });
  });

  it("produces a signature that does not verify for a different message", async () => {
    const g = generateServiceKeyPair();
    const signer = LocalEd25519Signer.fromPkcs8Pem(g.privateKeyPem);
    const sig = await signer.sign(new TextEncoder().encode("a.b"));
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: g.jwk.x }, format: "jwk" });
    expect(cryptoVerify(null, Buffer.from("a.c", "utf8"), pub, Buffer.from(sig))).toBe(false);
  });

  /**
   * The failure this prevents: an operator reaches for the RSA key their IdP
   * already uses. Without this check the first symptom is the ERP answering
   * `unsupported alg RS256` on the first ERP call — which looks like an ERP
   * configuration problem and is a key problem.
   */
  it("refuses an RSA key, naming the reason", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => LocalEd25519Signer.fromPkcs8Pem(pem)).toThrow(/is rsa; the ERP accepts EdDSA only/);
  });

  it("refuses an EC key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => LocalEd25519Signer.fromPkcs8Pem(pem)).toThrow(SignerError);
  });

  it("refuses an X25519 key, which is an encryption key that looks like the right one", () => {
    // ed25519 and x25519 differ by one character in every place an operator would
    // look, and only one of them can sign.
    const { privateKey } = generateKeyPairSync("x25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => LocalEd25519Signer.fromPkcs8Pem(pem)).toThrow(/must be ed25519/);
  });

  it("refuses an empty or malformed PEM with a message that says which", () => {
    expect(() => LocalEd25519Signer.fromPkcs8Pem("   ")).toThrow(/is empty/);
    expect(() => LocalEd25519Signer.fromPkcs8Pem("-----BEGIN PRIVATE KEY-----\nnope\n")).toThrow(
      /not a readable PKCS#8 PEM/,
    );
  });

  it("tolerates surrounding whitespace, which a secret manager often adds", () => {
    const g = generateServiceKeyPair();
    expect(LocalEd25519Signer.fromPkcs8Pem(`\n  ${g.privateKeyPem}  \n`).kid).toBe(g.kid);
  });
});
