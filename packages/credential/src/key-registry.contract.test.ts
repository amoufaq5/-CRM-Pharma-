import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { appPool } from "@crm/db/testing";

import {
  DEFAULT_PROPAGATION_SECONDS,
  KeyNotPropagatedError,
  KeyRegistryError,
  KeyStillTrustedError,
  PostgresServiceKeyRegistry,
} from "./key-registry.js";
import { generateServiceKeyPair } from "./signer.js";
import { MAX_TTL_SECONDS } from "./token.js";

/**
 * The key lifecycle against a real Postgres.
 *
 * Every rule here is a time-gate, and a time-gate is exactly the kind of thing an
 * offline fake asserts the shape of and not the behaviour of. The clock is injected
 * so the test can stand where an operator would be six minutes later.
 *
 * `crm.service_key` is platform-wide — no tenant_id, no RLS — so there is no tenant
 * to isolate on. This is the only test file that writes it, which is why it can
 * clear the table between cases.
 */
/**
 * `appPool()`: this pool is handed to production code that opens its own connections,
 * which inherit its role. Under the admin pool they would run as a superuser, and RLS —
 * including the per-tenant assertions below — would not apply at all.
 */
describe("the service key registry", () => {
  let pool: Pool;
  let clock = { t: new Date("2026-10-01T12:00:00.000Z") };

  const registry = (): PostgresServiceKeyRegistry =>
    new PostgresServiceKeyRegistry({ pool, now: () => clock.t });

  const advance = (seconds: number): void => {
    clock = { t: new Date(clock.t.getTime() + seconds * 1000) };
  };

  beforeAll(() => {
    pool = appPool();
  });

  afterAll(async () => {
    await pool?.query("DELETE FROM crm.service_key");
    await pool?.end();
  });

  beforeEach(async () => {
    clock = { t: new Date("2026-10-01T12:00:00.000Z") };
    await pool.query("DELETE FROM crm.service_key");
  });

  it("publishes a key under its own thumbprint", async () => {
    const g = generateServiceKeyPair();
    const kid = await registry().publish(g.jwk.x, "first key");
    expect(kid).toBe(g.kid);

    const rows = await registry().list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("published");
    expect(rows[0]!.publicJwkX).toBe(g.jwk.x);
    expect(rows[0]!.note).toBe("first key");
    expect(rows[0]!.activatedAt).toBeNull();
  });

  it("is idempotent on publish, so a repeated rotation step is harmless", async () => {
    const g = generateServiceKeyPair();
    await registry().publish(g.jwk.x);
    await registry().publish(g.jwk.x, "a different note");
    const rows = await registry().list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBeNull(); // the first write wins; publish does not overwrite
  });

  /**
   * The gate that prevents a rotation from becoming an outage. A key the verifier
   * has not fetched yet produces `credential_not_found` for every request until its
   * next successful refresh — and a failed refresh keeps the stale set, so it does
   * not necessarily self-heal.
   */
  it("refuses to activate a key the JWKS has not had time to propagate", async () => {
    const g = generateServiceKeyPair();
    await registry().publish(g.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS - 1);
    await expect(registry().activate(g.kid)).rejects.toThrow(KeyNotPropagatedError);

    advance(2);
    await registry().activate(g.kid);
    expect((await registry().activeKey())?.kid).toBe(g.kid);
  });

  it("allows a shorter wait only when the caller asks for one explicitly", async () => {
    const g = generateServiceKeyPair();
    await registry().publish(g.jwk.x);
    advance(10);
    await registry().activate(g.kid, { propagationSeconds: 5 });
    expect((await registry().activeKey())?.kid).toBe(g.kid);
  });

  it("demotes the incumbent to published, keeping it in the JWKS", async () => {
    // The old key must keep verifying: tokens signed with it are still in flight, and
    // a scheduler that has not restarted yet is still signing with it.
    const old = generateServiceKeyPair();
    const next = generateServiceKeyPair();
    const r = registry();
    await r.publish(old.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(old.kid);

    await r.publish(next.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(next.kid);

    const rows = await r.list();
    const byKid = new Map(rows.map((row) => [row.kid, row]));
    expect(byKid.get(next.kid)!.status).toBe("active");
    expect(byKid.get(old.kid)!.status).toBe("published");
    expect(byKid.get(old.kid)!.demotedAt).not.toBeNull();

    const published = await r.verifiableKeys();
    expect(published.map((k) => k.kid).sort()).toEqual([old.kid, next.kid].sort());
  });

  it("never leaves two keys active", async () => {
    const a = generateServiceKeyPair();
    const b = generateServiceKeyPair();
    const r = registry();
    await r.publish(a.jwk.x);
    await r.publish(b.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(a.kid);
    await r.activate(b.kid);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM crm.service_key WHERE status = 'active'",
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("treats activating the current key as a no-op", async () => {
    const g = generateServiceKeyPair();
    const r = registry();
    await r.publish(g.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(g.kid);
    const activatedAt = (await r.activeKey())!.activatedAt;
    advance(60);
    await r.activate(g.kid);
    expect((await r.activeKey())!.activatedAt).toEqual(activatedAt);
  });

  it("refuses to activate an unknown or retired key", async () => {
    await expect(registry().activate("not-a-kid")).rejects.toThrow(/no key/);

    const g = generateServiceKeyPair();
    const r = registry();
    await r.publish(g.jwk.x);
    await r.retire(g.kid); // never signed, so nothing is in flight
    await expect(r.activate(g.kid)).rejects.toThrow(/retirement is terminal/);
  });

  /**
   * The other gate. Retiring removes the key from the JWKS, which invalidates tokens
   * it signed that have not expired yet — requests that were authorised a minute ago
   * start failing.
   */
  it("refuses to retire a key whose tokens may still be in flight", async () => {
    const old = generateServiceKeyPair();
    const next = generateServiceKeyPair();
    const r = registry();
    await r.publish(old.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(old.kid);
    await r.publish(next.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(next.kid); // old is demoted here; the clock starts now

    advance(MAX_TTL_SECONDS - 1);
    await expect(r.retire(old.kid)).rejects.toThrow(KeyStillTrustedError);

    advance(2);
    await r.retire(old.kid);
    expect((await r.verifiableKeys()).map((k) => k.kid)).toEqual([next.kid]);
  });

  it("retires a never-activated key immediately, since it signed nothing", async () => {
    const g = generateServiceKeyPair();
    const r = registry();
    await r.publish(g.jwk.x);
    await r.retire(g.kid);
    expect((await r.list())[0]!.status).toBe("retired");
    expect(await r.verifiableKeys()).toHaveLength(0);
  });

  it("refuses to retire the signing key, naming the consequence", async () => {
    const g = generateServiceKeyPair();
    const r = registry();
    await r.publish(g.jwk.x);
    advance(DEFAULT_PROPAGATION_SECONDS + 1);
    await r.activate(g.kid);
    await expect(r.retire(g.kid)).rejects.toThrow(/stops every ERP call/);
  });

  it("treats retiring an already-retired key as a no-op", async () => {
    const g = generateServiceKeyPair();
    const r = registry();
    await r.publish(g.jwk.x);
    await r.retire(g.kid);
    await r.retire(g.kid);
    expect((await r.list())[0]!.status).toBe("retired");
  });

  describe("checkSignerKey — the scheduler's boot check", () => {
    it("passes with no warning for the active key", async () => {
      const g = generateServiceKeyPair();
      const r = registry();
      await r.publish(g.jwk.x);
      advance(DEFAULT_PROPAGATION_SECONDS + 1);
      await r.activate(g.kid);
      expect(await r.checkSignerKey(g.kid)).toEqual({ ok: true, warning: null });
    });

    it("passes with a warning for a published key, the normal state mid-rotation", async () => {
      const g = generateServiceKeyPair();
      const r = registry();
      await r.publish(g.jwk.x);
      const result = await r.checkSignerKey(g.kid);
      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/published but not active/);
    });

    /**
     * Refusing to start beats a hundred 401s. A signer whose key is not in the JWKS
     * fails identically to the ERP being misconfigured, from the far side of an HTTP
     * call — so it is worth catching at boot, where the cause is still obvious.
     */
    it("refuses an unpublished key", async () => {
      const g = generateServiceKeyPair();
      await expect(registry().checkSignerKey(g.kid)).rejects.toThrow(/not in crm.service_key/);
    });

    it("refuses a retired key", async () => {
      const g = generateServiceKeyPair();
      const r = registry();
      await r.publish(g.jwk.x);
      await r.retire(g.kid);
      await expect(r.checkSignerKey(g.kid)).rejects.toThrow(KeyRegistryError);
      await expect(r.checkSignerKey(g.kid)).rejects.toThrow(/retired/);
    });
  });
});
