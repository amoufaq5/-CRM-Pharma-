import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_ENDPOINTS as TENANT, testPool } from "@crm/db/testing";

import {
  InvalidEndpointError,
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
} from "./endpoints.js";

/**
 * Endpoint configuration against a real Postgres.
 *
 * The constraints being exercised are the ones migration 0021 wrote for a reason: a
 * plaintext URL is refused because a notification carries a rep's name and a lot
 * number, and `secret_env` holds the NAME of an environment variable so the database
 * never has the secret to leak. The store adds one rule of its own — a kind allow-list
 * is checked against the vocabulary, because `kinds` is a bare text[] with no CHECK and
 * an endpoint filtered to a kind that does not exist receives nothing at all.
 */
describe("notification endpoints", () => {
  let pool: Pool;
  let client: PoolClient;

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [TENANT]);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [TENANT]);
    });
  });

  const create = (tx: PoolClient, over: Partial<Parameters<typeof createEndpoint>[2]> = {}) =>
    createEndpoint(tx, TENANT, {
      url: "https://hooks.example.test/crm",
      secretEnv: "CRM_TEST_WEBHOOK_SECRET",
      ...over,
    });

  const refuses = async (tx: PoolClient, fn: () => Promise<unknown>): Promise<Error> => {
    await tx.query("SAVEPOINT probe");
    try {
      await fn();
      await tx.query("RELEASE SAVEPOINT probe");
      throw new Error("expected a refusal, got none");
    } catch (err) {
      await tx.query("ROLLBACK TO SAVEPOINT probe");
      return err as Error;
    }
  };

  it("creates an endpoint with the documented defaults", async () => {
    await inTenant(async (tx) => {
      const ep = await create(tx);
      expect(ep.channel).toBe("webhook");
      expect(ep.min_severity).toBe("warning");
      expect(ep.kinds).toBeNull();
      expect(ep.enabled).toBe(true);
      expect(ep.secret_env).toBe("CRM_TEST_WEBHOOK_SECRET");
    });
  });

  it("never returns a secret, because it never holds one", async () => {
    await inTenant(async (tx) => {
      const ep = await create(tx);
      // The row's only secret-shaped field is the NAME of an environment variable.
      expect(Object.keys(ep)).not.toContain("secret");
      expect(ep.secret_env).toMatch(/^[A-Z][A-Z0-9_]+$/);
    });
  });

  it("refuses a plaintext URL that is not loopback", async () => {
    await inTenant(async (tx) => {
      const err = await refuses(tx, () => create(tx, { url: "http://hooks.example.test/crm" }));
      expect(err.message).toMatch(/notification_endpoint_url_check|check constraint/);
    });
  });

  it("allows loopback over plaintext, for a receiver in a test", async () => {
    await inTenant(async (tx) => {
      const ep = await create(tx, { url: "http://127.0.0.1:8099/hook" });
      expect(ep.url).toBe("http://127.0.0.1:8099/hook");
    });
  });

  it("refuses a secret_env that is not an environment variable name", async () => {
    await inTenant(async (tx) => {
      const err = await refuses(tx, () => create(tx, { secretEnv: "s3cr3t-value" }));
      expect(err.message).toMatch(/notification_endpoint_secret_env_check|check constraint/);
    });
  });

  it("refuses a kind that does not exist, rather than accepting a dead endpoint", async () => {
    await inTenant(async (tx) => {
      await expect(create(tx, { kinds: ["disposal_obligation_raised", "world_ending"] })).rejects.toBeInstanceOf(
        InvalidEndpointError,
      );
    });
  });

  it("refuses an empty allow-list, which would mean nothing rather than everything", async () => {
    await inTenant(async (tx) => {
      await expect(create(tx, { kinds: [] })).rejects.toBeInstanceOf(InvalidEndpointError);
    });
  });

  it("deduplicates and sorts a kind allow-list", async () => {
    await inTenant(async (tx) => {
      const ep = await create(tx, {
        kinds: ["erp_write_failed", "call_plan_approved", "erp_write_failed"],
      });
      expect(ep.kinds).toEqual(["call_plan_approved", "erp_write_failed"]);
    });
  });

  describe("updating", () => {
    it("changes the thresholds and leaves the rest alone", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx, { description: "the ops channel" });
        const updated = await updateEndpoint(tx, ep.id, { minSeverity: "urgent" });
        expect(updated?.min_severity).toBe("urgent");
        expect(updated?.description).toBe("the ops channel");
        expect(updated?.url).toBe(ep.url);
      });
    });

    it("can clear an allow-list back to every kind", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx, { kinds: ["erp_write_failed"] });
        expect((await updateEndpoint(tx, ep.id, { kinds: null }))?.kinds).toBeNull();
      });
    });

    /**
     * `enabled: false` is how an endpoint stops. There is no delete, because
     * `crm.notification_delivery` cascades from this row — removing an endpoint would
     * erase the record of everything ever sent to it.
     */
    it("disables an endpoint without removing its history", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx);
        expect((await updateEndpoint(tx, ep.id, { enabled: false }))?.enabled).toBe(false);
        expect((await getEndpoint(tx, ep.id))?.id).toBe(ep.id);
      });
    });

    it("returns null for an endpoint that is not there", async () => {
      await inTenant(async (tx) => {
        expect(await updateEndpoint(tx, "e8000000-0000-4000-8000-00000000000f", { enabled: false })).toBeNull();
      });
    });

    it("refuses an unknown kind on update too", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx);
        await expect(updateEndpoint(tx, ep.id, { kinds: ["nope"] })).rejects.toBeInstanceOf(InvalidEndpointError);
      });
    });
  });

  /**
   * Ordered, but not by insertion. `now()` is the TRANSACTION timestamp, so these two
   * share `created_at` to the microsecond and the listing cannot know which INSERT ran
   * first — it broke by id, at random, and this test passed alone and failed in the
   * suite until the tie-break became the URL. The same trap caught the outbox earlier.
   */
  it("lists a tenant's endpoints in a stable order", async () => {
    await inTenant(async (tx) => {
      await create(tx, { url: "https://hooks.example.test/b", description: "bee" });
      await create(tx, { url: "https://hooks.example.test/a", description: "ay" });
      const all = await listEndpoints(tx, TENANT);
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.description)).toEqual(["ay", "bee"]);
    });
  });
});
