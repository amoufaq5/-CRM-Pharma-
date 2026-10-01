import { describe, expect, it } from "vitest";

import { MIN_REFRESH_MARGIN_SECONDS, ServiceCredential } from "./credential.js";
import { ServiceRoleUnavailableError, StaticServiceRoleSource, type ServiceRoleSource } from "./role-source.js";
import { generateServiceKeyPair, LocalEd25519Signer } from "./signer.js";
import { decodeUnverified, ServiceTokenError } from "./token.js";

const TENANT = "3f1b7c22-5e2a-4a5f-9f4a-0c1d2e3f4a5b";
const OTHER = "4a2c8d33-6f3b-4b60-8a5b-1d2e3f4a5b6c";

function build(
  overrides: Partial<ConstructorParameters<typeof ServiceCredential>[0]> = {},
  clock: { nowMs: number } = { nowMs: 1_800_000_000_000 },
): ServiceCredential {
  const signer = LocalEd25519Signer.fromPkcs8Pem(generateServiceKeyPair().privateKeyPem);
  return new ServiceCredential({
    signer,
    roles: new StaticServiceRoleSource({ [TENANT]: "controller", [OTHER]: "erp_accountant" }),
    issuer: "https://crm.example.com/",
    audience: "crossengin-erp",
    now: () => clock.nowMs,
    ...overrides,
  });
}

describe("ServiceCredential", () => {
  it("mints a token scoped to the tenant it was asked for", async () => {
    const cred = build();
    const payload = decodeUnverified(await cred.token(TENANT))!.payload;
    expect(payload["tenant_id"]).toBe(TENANT);
    expect(payload["scope"]).toBe("controller");
    expect(payload["sub"]).toBe(`crm-service:${TENANT}`);
  });

  it("gives each tenant its own token and its own role", async () => {
    const cred = build();
    const a = decodeUnverified(await cred.token(TENANT))!.payload;
    const b = decodeUnverified(await cred.token(OTHER))!.payload;
    expect(a["scope"]).toBe("controller");
    expect(b["scope"]).toBe("erp_accountant");
    expect(a["tenant_id"]).not.toBe(b["tenant_id"]);
  });

  it("reuses a cached token rather than signing per request", async () => {
    const cred = build();
    const first = await cred.token(TENANT);
    expect(await cred.token(TENANT)).toBe(first);
  });

  it("treats the tenant id case-insensitively, so one tenant never gets two cache entries", async () => {
    const cred = build();
    const lower = await cred.token(TENANT);
    expect(await cred.token(TENANT.toUpperCase())).toBe(lower);
  });

  it("re-mints once the token is inside the refresh margin", async () => {
    const clock = { nowMs: 1_800_000_000_000 };
    const cred = build({ ttlSeconds: 600, refreshMarginSeconds: 60 }, clock);
    const first = await cred.token(TENANT);

    clock.nowMs += 539_000; // 61s of life left — still outside the margin
    expect(await cred.token(TENANT)).toBe(first);

    clock.nowMs += 2_000; // 59s left — inside it
    const second = await cred.token(TENANT);
    expect(second).not.toBe(first);
    expect(decodeUnverified(second)!.payload["exp"]).toBeGreaterThan(
      decodeUnverified(first)!.payload["exp"] as number,
    );
  });

  /**
   * A burst of ERP calls on a cold cache must mint once, not once per call. Without
   * the in-flight map, the relay draining twenty outbox rows in parallel would sign
   * twenty tokens — and with a remote signer, pay twenty network round trips.
   */
  it("mints once for concurrent callers", async () => {
    let mints = 0;
    const slowRoles: ServiceRoleSource = {
      roleFor: async () => {
        mints += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { role: "controller", subject: null };
      },
    };
    const cred = build({ roles: slowRoles });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => cred.token(TENANT)));
    expect(mints).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it("does not cache a failure, so a fixed configuration works on the next call", async () => {
    let fail = true;
    const flaky: ServiceRoleSource = {
      roleFor: (tenantId) =>
        fail
          ? Promise.reject(new ServiceRoleUnavailableError(tenantId, "not configured yet"))
          : Promise.resolve({ role: "controller", subject: null }),
    };
    const cred = build({ roles: flaky });
    await expect(cred.token(TENANT)).rejects.toThrow(ServiceRoleUnavailableError);
    fail = false;
    expect(decodeUnverified(await cred.token(TENANT))!.payload["scope"]).toBe("controller");
  });

  it("propagates an unconfigured tenant as an error instead of minting a default role", async () => {
    const cred = build();
    await expect(cred.token("00000000-0000-4000-8000-000000000000")).rejects.toThrow(ServiceRoleUnavailableError);
  });

  it("uses the per-tenant subject override when one is configured", async () => {
    const cred = build({
      roles: new StaticServiceRoleSource({ [TENANT]: { role: "controller", subject: "crm-eu-west" } }),
    });
    expect(decodeUnverified(await cred.token(TENANT))!.payload["sub"]).toBe("crm-eu-west");
  });

  it("refuses a refresh margin below the ERP client's request timeout", () => {
    // A margin under the 15s client timeout lets a token expire during the request it
    // was minted for — an expired_token 401 on a token that was valid when issued.
    expect(() => build({ refreshMarginSeconds: MIN_REFRESH_MARGIN_SECONDS - 1 })).toThrow(ServiceTokenError);
  });

  it("refuses a margin at or above the TTL, which would re-mint on every call", () => {
    expect(() => build({ ttlSeconds: 300, refreshMarginSeconds: 300 })).toThrow(/must be less than ttlSeconds/);
  });

  it("forgets a cached token on request, without pretending to revoke it", async () => {
    const cred = build();
    const first = await cred.token(TENANT);
    cred.forget(TENANT);
    expect(await cred.token(TENANT)).not.toBe(first);
    // `first` remains valid at the ERP until it expires. There is no revocation list,
    // which is the trade a 10-minute lifetime buys.
  });

  it("reports what it holds, for the scheduler's status log", async () => {
    const cred = build();
    await cred.token(TENANT);
    const cached = cred.cached();
    expect(cached).toHaveLength(1);
    expect(cached[0]!.tenantId).toBe(TENANT);
    expect(cached[0]!.expiresAtSeconds).toBeGreaterThan(0);
  });

  it("emits a mint event carrying the kid, role and jti but never the token", async () => {
    const events: unknown[] = [];
    const cred = build({ onMint: (e) => events.push(e) });
    await cred.token(TENANT);
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e["role"]).toBe("controller");
    expect(typeof e["kid"]).toBe("string");
    expect(typeof e["jti"]).toBe("string");
    // The token is a bearer credential. It must not reach a log line.
    expect(Object.keys(e)).not.toContain("token");
  });
});
