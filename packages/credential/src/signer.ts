import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { ED25519_PUBLIC_KEY_BYTES, ed25519Jwk, fromBase64url, type Ed25519Jwk } from "./jwk.js";

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerError";
  }
}

/**
 * The signing seam.
 *
 * `sign` is ASYNCHRONOUS even though the local implementation is synchronous, and
 * the private key is not part of this interface at all. Both are deliberate: a
 * hardware or hosted signer never hands the key out, it signs on request over the
 * network. Modelling the seam as "give me the key and I will sign" would make
 * moving to one a redesign instead of a swap.
 *
 * Worth checking before committing to a particular service: Ed25519 signing is
 * not universally offered by managed key services, and the ERP accepts EdDSA
 * only — so "put it in a KMS" is not automatically available. HashiCorp Vault's
 * transit engine signs ed25519; several cloud KMS offerings have historically
 * exposed only ECDSA and RSA. Confirm against current documentation rather than
 * assuming, because the answer decides whether the key can stay out of process
 * memory at all.
 */
export interface ServiceKeySigner {
  /** RFC 7638 thumbprint of the public key. Travels in the JWT header. */
  readonly kid: string;
  /** The raw 32-byte public key, for publishing in the JWKS. */
  readonly publicKeyRaw: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface GeneratedServiceKey {
  readonly kid: string;
  readonly jwk: Ed25519Jwk;
  /** PKCS#8 PEM. The only copy — it is never written anywhere by this function. */
  readonly privateKeyPem: string;
}

/**
 * Generates a fresh service keypair.
 *
 * Returns the private key rather than storing it: where a secret belongs is the
 * operator's decision and the registry deliberately has no column for one.
 */
export function generateServiceKeyPair(): GeneratedServiceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = ed25519Jwk(rawPublicKey(publicKey));
  return {
    kid: jwk.kid,
    jwk,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * Extracts the raw 32-byte public key.
 *
 * Via the JWK export rather than slicing the DER: the raw key sits at a fixed
 * offset in an Ed25519 SubjectPublicKeyInfo today, but hard-coding that offset is
 * the kind of thing that works until an encoder pads differently.
 */
function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new SignerError(`not an Ed25519 key (kty=${String(jwk.kty)}, crv=${String(jwk.crv)})`);
  }
  const raw = fromBase64url(jwk.x);
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new SignerError(`expected a ${ED25519_PUBLIC_KEY_BYTES}-byte public key, got ${raw.length}`);
  }
  return raw;
}

/**
 * Signs in this process with a key held in memory.
 *
 * What ships now, and what a single-VM deployment will keep using. The key is
 * loaded from a secret at boot and never written to disk by the CRM; that is
 * weaker than a signer that never surrenders the key, which is why the interface
 * above is shaped for one.
 */
export class LocalEd25519Signer implements ServiceKeySigner {
  readonly kid: string;
  readonly publicKeyRaw: Uint8Array;
  private readonly privateKey: KeyObject;

  private constructor(privateKey: KeyObject, publicKeyRaw: Uint8Array, kid: string) {
    this.privateKey = privateKey;
    this.publicKeyRaw = publicKeyRaw;
    this.kid = kid;
  }

  /**
   * Loads a PKCS#8 PEM.
   *
   * Rejects any key type but Ed25519 up front. The alternative is a signature the
   * ERP refuses with `unsupported alg`, discovered on the first ERP call rather
   * than at boot — and an RS256 key is exactly what an operator reaching for an
   * existing IdP key would try.
   */
  static fromPkcs8Pem(pem: string): LocalEd25519Signer {
    const trimmed = pem.trim();
    if (trimmed === "") throw new SignerError("the signing key is empty");
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(trimmed);
    } catch (err) {
      throw new SignerError(
        `the signing key is not a readable PKCS#8 PEM: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new SignerError(
        `the signing key is ${String(privateKey.asymmetricKeyType)}; the ERP accepts EdDSA only, ` +
          `so it must be ed25519`,
      );
    }
    const publicKeyRaw = rawPublicKey(createPublicKey(privateKey));
    return new LocalEd25519Signer(privateKey, publicKeyRaw, ed25519Jwk(publicKeyRaw).kid);
  }

  sign(message: Uint8Array): Promise<Uint8Array> {
    // Ed25519 takes no separate digest — the algorithm hashes internally, which is
    // what the `null` is.
    return Promise.resolve(new Uint8Array(cryptoSign(null, message, this.privateKey)));
  }
}
