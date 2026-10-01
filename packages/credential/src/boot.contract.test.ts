import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { Pool } from "pg";
import { TENANT_CREDENTIAL_BOOT as TENANT, testPool } from "@crm/db/testing";

import { buildServiceCredential } from "./boot.js";
import { jwksResponse, type JwksDocument } from "./jwk.js";
import { DEFAULT_PROPAGATION_SECONDS, PostgresServiceKeyRegistry } from "./key-registry.js";
import { generateServiceKeyPair } from "./signer.js";
import { decodeUnverified } from "./token.js";

/**
 * The whole chain, against a real database: a published key, a configured tenant,
 * a minted token, and a verification against the document the API would serve.
 *
 * Each piece has its own tests; this one asserts they are wired to each other. The
 * failure it exists to catch is a token that is individually valid and references a
 * key the JWKS does not carry — which is only observable by doing both halves.
 */
describe("the service credential, end to end", () => {
  let pool: Pool;

  const published = async (): Promise<{ kid: string; pem: string; x: string }> => {
    const g = generateServiceKeyPair();
    const registry = new PostgresServiceKeyRegistry({
      pool,
      // Published far enough in the past to be activatable now.
      now: () => new Date(Date.now() - (DEFAULT_PROPAGATION_SECONDS + 60) * 1000),
    });
    await registry.publish(g.jwk.x);
    await new PostgresServiceKeyRegistry({ pool }).activate(g.kid);
    return { kid: g.kid, pem: g.privateKeyPem, x: g.jwk.x };
  };

  const env = (pem: string): Record<string, string> => ({
    CRM_SIGNING_KEY_PEM: pem,
    CRM_TOKEN_ISSUER: "https://crm.example.com/",
    ERP_TOKEN_AUDIENCE: "crossengin-erp",
  });

  beforeAll(() => {
    pool = testPool();
  });

  afterAll(async () => {
    await pool?.query("DELETE FROM crm.service_key");
    await pool?.query("DELETE FROM crm.erp_service_principal WHERE tenant_id = $1", [TENANT]);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM crm.service_key");
    await pool.query("DELETE FROM crm.erp_service_principal WHERE tenant_id = $1", [TENANT]);
  });

  it("mints a token that verifies against the JWKS the API publishes", async () => {
    const key = await published();
    await pool.query(
      "INSERT INTO crm.erp_service_principal (tenant_id, erp_role) VALUES ($1, 'controller')",
      [TENANT],
    );

    const built = await buildServiceCredential({ pool, env: env(key.pem) });
    expect(built.kind).toBe("signing");
    expect(built.kid).toBe(key.kid);
    expect(built.warning).toBeNull();

    const token = await built.credential.token(TENANT);
    const [h, p, s] = token.split(".") as [string, string, string];

    // Resolve the key the way a verifier does: from the published document, by kid.
    const doc = jwksResponse(await new PostgresServiceKeyRegistry({ pool }).verifiableKeys()).body as JwksDocument;
    const jwk = doc.keys.find((k) => k.kid === decodeUnverified(token)!.header["kid"]);
    expect(jwk).toBeDefined();

    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk!.x }, format: "jwk" });
    expect(cryptoVerify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect(decodeUnverified(token)!.payload["scope"]).toBe("controller");
  });

  /**
   * The boot check. A signer holding a key that is not published mints tokens every
   * verifier rejects — and from the far side of an HTTP call that is
   * indistinguishable from the ERP being misconfigured.
   */
  it("refuses to build a credential for an unpublished key", async () => {
    const orphan = generateServiceKeyPair();
    await expect(buildServiceCredential({ pool, env: env(orphan.privateKeyPem) })).rejects.toThrow(
      /not in crm.service_key/,
    );
  });

  it("refuses a retired key", async () => {
    const g = generateServiceKeyPair();
    const registry = new PostgresServiceKeyRegistry({ pool });
    await registry.publish(g.jwk.x);
    await registry.retire(g.kid);
    await expect(buildServiceCredential({ pool, env: env(g.privateKeyPem) })).rejects.toThrow(/retired/);
  });

  it("builds with a warning for a key that is published but not yet active", async () => {
    // The ordinary state of a process still running from before a rotation: its
    // tokens verify, so starting is right — saying nothing would not be.
    const g = generateServiceKeyPair();
    await new PostgresServiceKeyRegistry({ pool }).publish(g.jwk.x);
    const built = await buildServiceCredential({ pool, env: env(g.privateKeyPem) });
    expect(built.warning).toMatch(/published but not active/);
  });

  it("refuses to mint for a tenant with no service principal row", async () => {
    const key = await published();
    const built = await buildServiceCredential({ pool, env: env(key.pem) });
    await expect(built.credential.token(TENANT)).rejects.toThrow(/no usable ERP service role/);
  });

  it("stops minting as soon as a tenant's row is disabled", async () => {
    // Revocation without deleting the record. Note what it does NOT do: a token
    // already issued stays valid at the ERP until it expires.
    const key = await published();
    await pool.query(
      "INSERT INTO crm.erp_service_principal (tenant_id, erp_role) VALUES ($1, 'controller')",
      [TENANT],
    );
    const built = await buildServiceCredential({ pool, env: env(key.pem) });
    await built.credential.token(TENANT);

    await pool.query("UPDATE crm.erp_service_principal SET enabled = false WHERE tenant_id = $1", [TENANT]);
    const fresh = await buildServiceCredential({ pool, env: env(key.pem) });
    await expect(fresh.credential.token(TENANT)).rejects.toThrow(/disabled/);
  });

  it("carries the static development credential through with a warning", async () => {
    const built = await buildServiceCredential({ pool, env: { ERP_TOKEN: "dev-token" } });
    expect(built.kind).toBe("static");
    expect(built.kid).toBeNull();
    expect(built.warning).toMatch(/Development only/);
    expect(await built.credential.token(TENANT)).toBe("dev-token");
  });
});
