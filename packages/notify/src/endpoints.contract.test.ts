import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_ENDPOINTS as TENANT, testPool } from "@crm/db/testing";

import {
  ENDPOINT_CHANNELS,
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
      channel: "webhook",
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

  /**
   * The CHECK still decides; what changed is what the caller is told.
   *
   * These two used to assert the raw constraint name, which was honest about what happened
   * and meant an administrator configuring an endpoint got a 500 with a Postgres string
   * in it. The refusal is now an `InvalidEndpointError` — a 422 — and the assertion is on
   * the sentence, because the sentence is the thing that has to be right.
   */
  it("refuses a plaintext URL that is not loopback", async () => {
    await inTenant(async (tx) => {
      const err = await refuses(tx, () => create(tx, { url: "http://hooks.example.test/crm" }));
      expect(err).toBeInstanceOf(InvalidEndpointError);
      expect(err.message).toMatch(/does not travel in the clear/);
    });
  });

  it("refuses an https url on an email endpoint, and a mailbox on a webhook", async () => {
    // The url rule is per-channel (0029), not a flat disjunction: a webhook pointed at a
    // mailbox and an email endpoint pointed at an HTTPS host are both configurations with
    // no sender and no error, which is what the paired CHECK exists to prevent.
    await inTenant(async (tx) => {
      const asEmail = await refuses(tx, () =>
        create(tx, { channel: "email", url: "https://hooks.example.test/crm" }),
      );
      expect(asEmail).toBeInstanceOf(InvalidEndpointError);
      expect(asEmail.message).toMatch(/single mailto: mailbox/);

      const asWebhook = await refuses(tx, () => create(tx, { url: "mailto:ops@example.test" }));
      expect(asWebhook).toBeInstanceOf(InvalidEndpointError);
      expect(asWebhook.message).toMatch(/must be https:\/\//);
    });
  });

  it("stores an email endpoint, which nothing above SQL could name before", async () => {
    await inTenant(async (tx) => {
      const ep = await create(tx, {
        channel: "email",
        url: "mailto:ops@example.test",
        secretEnv: "CRM_SMTP_PASSWORD",
      });
      expect(ep.channel).toBe("email");
      expect(ep.url).toBe("mailto:ops@example.test");
    });
  });

  it("refuses a channel the CHECK does not admit, before the INSERT", async () => {
    // In TypeScript as well as in SQL, and the TypeScript answer first, so the refusal
    // names the legal values instead of surfacing a constraint violation from the bottom
    // of the stack. `ENDPOINT_CHANNELS` is compared to the CHECK below.
    await inTenant(async (tx) => {
      const err = await refuses(tx, () =>
        create(tx, { channel: "carrier_pigeon" as (typeof ENDPOINT_CHANNELS)[number] }),
      );
      expect(err).toBeInstanceOf(InvalidEndpointError);
      expect(err.message).toMatch(/webhook, email/);
    });
  });

  /**
   * The TypeScript list and the CHECK, compared against `pg_constraint`.
   *
   * `ENDPOINT_CHANNELS` is a copy of 0029's `notification_endpoint_channel_check`, and a
   * copy that can drift is worse than no copy: the route would advertise a channel the
   * database refuses, or refuse one it accepts.
   */
  it("keeps ENDPOINT_CHANNELS and the CHECK in agreement", async () => {
    await inTenant(async (tx) => {
      const { rows } = await tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'notification_endpoint_channel_check'`,
      );
      const def = rows[0]!.def;
      const inCheck = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
      expect(inCheck).toEqual([...ENDPOINT_CHANNELS].sort());
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
      expect(err).toBeInstanceOf(InvalidEndpointError);
      expect(err.message).toMatch(/NAME of an environment variable/);
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
