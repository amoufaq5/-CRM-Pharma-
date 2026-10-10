import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_ENDPOINTS as TENANT, testPool, wipeEndpoints } from "@crm/db/testing";

import {
  ENDPOINT_CHANNELS,
  InvalidEndpointError,
  createEndpoint,
  endpointHistory,
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

  const AUTHOR = "d3000000-0000-4000-8000-0000000000a1";
  const SECOND = "d3000000-0000-4000-8000-0000000000a2";

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    // Two administrators, because since 0060 every write here names one — and because the
    // history has to be able to show two different people turning the same endpoint's knobs.
    await inTenant(async (tx) => {
      for (const [id, subject, name] of [
        [AUTHOR, "ep-author", "The Administrator"],
        [SECOND, "ep-second", "A Second Administrator"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name, status)
           VALUES ($1,$2,$3,$3,$4,'active') ON CONFLICT (id) DO NOTHING`,
          [id, TENANT, subject, name],
        );
      }
    });
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      await wipeEndpoints(tx, TENANT);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await wipeEndpoints(tx, TENANT);
    });
  });

  const create = (tx: PoolClient, over: Partial<Parameters<typeof createEndpoint>[2]> = {}) =>
    createEndpoint(tx, TENANT, {
      channel: "webhook",
      url: "https://hooks.example.test/crm",
      secretEnv: "CRM_TEST_WEBHOOK_SECRET",
      createdBy: AUTHOR,
      reason: "ops asked for disposal signals in their on-call channel",
      ...over,
    });

  const amend = (
    tx: PoolClient,
    id: string,
    over: Partial<Parameters<typeof updateEndpoint>[2]> = {},
  ) =>
    updateEndpoint(tx, id, {
      changedBy: AUTHOR,
      reason: "a fixture turning a knob, with a sentence attached",
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
        const updated = await amend(tx, ep.id, { minSeverity: "urgent" });
        expect(updated?.min_severity).toBe("urgent");
        expect(updated?.description).toBe("the ops channel");
        expect(updated?.url).toBe(ep.url);
      });
    });

    it("can clear an allow-list back to every kind", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx, { kinds: ["erp_write_failed"] });
        expect((await amend(tx, ep.id, { kinds: null }))?.kinds).toBeNull();
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
        expect((await amend(tx, ep.id, { enabled: false }))?.enabled).toBe(false);
        expect((await getEndpoint(tx, ep.id))?.id).toBe(ep.id);
      });
    });

    it("returns null for an endpoint that is not there", async () => {
      await inTenant(async (tx) => {
        expect(await amend(tx, "e8000000-0000-4000-8000-00000000000f", { enabled: false })).toBeNull();
      });
    });

    it("refuses an unknown kind on update too", async () => {
      await inTenant(async (tx) => {
        const ep = await create(tx);
        await expect(amend(tx, ep.id, { kinds: ["nope"] })).rejects.toBeInstanceOf(InvalidEndpointError);
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

  /**
   * Who opened the route, and who changed what it receives (0060).
   *
   * 0023's header named this table and `crm.disposal_policy` as the two that were "settable
   * by anyone with the application password, with no record of who changed what"; 0059
   * answered the policy and this answers the endpoint. The asymmetry between the two halves
   * is the design: what an endpoint IS was already frozen for the life of the row (0049), so
   * its author is a frozen column beside it, while how it is TUNED changes over time and gets
   * a log the tunable columns are a projection of.
   */
  describe("attribution", () => {
    it("records who opened the route and why, and hands both back", async () => {
      const ep = await inTenant((tx) => create(tx));
      expect(ep.created_by).toBe(AUTHOR);
      expect(ep.created_by_name).toBe("The Administrator");
      expect(ep.created_reason).toContain("on-call channel");
      // And through the list, which is where an administrator actually reads it.
      const [listed] = await inTenant((tx) => listEndpoints(tx, TENANT));
      expect(listed).toMatchObject({ created_by: AUTHOR, created_by_name: "The Administrator" });
    });

    it("refuses an endpoint that names nobody, from raw SQL", async () => {
      // The route cannot produce this — the author comes from the token — so the guard is
      // measured where it matters: a statement typed at a psql prompt, which is the access
      // 0023's header was written about.
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.notification_endpoint (tenant_id, channel, url, secret_env)
             VALUES ($1,'webhook','https://hooks.example.test/anon','CRM_TEST_WEBHOOK_SECRET')`,
            [TENANT],
          ),
        );
        expect(err.message).toMatch(/must name the rep who added it/);
      });
    });

    it("refuses to let the creation record be rewritten, in its own words", async () => {
      // 0049's freeze now covers `created_by` and `created_reason` — and gives them a
      // different sentence, because its original one ("has delivery records naming url = …")
      // would send an operator hunting a problem that is not there.
      const ep = await inTenant((tx) => create(tx));
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.notification_endpoint SET created_by = $2 WHERE id = $1", [ep.id, SECOND]),
        );
        expect(err.message).toMatch(/endpoint-creation-frozen/);
        expect(err.message).toMatch(/not editable/);
      });
    });

    it("records an amendment with both halves of every knob", async () => {
      const ep = await inTenant((tx) => create(tx, { minSeverity: "info", kinds: ["erp_write_failed"] }));
      await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          minSeverity: "urgent",
          enabled: false,
          changedBy: SECOND,
          reason: "too noisy for the on-call channel, and off until the receiver is rebuilt",
        }),
      );
      const [change] = await inTenant((tx) => endpointHistory(tx, ep.id));
      expect(change).toMatchObject({
        changed_by: SECOND,
        changed_by_name: "A Second Administrator",
        min_severity_from: "info",
        min_severity_to: "urgent",
        enabled_from: true,
        enabled_to: false,
      });
      // THE KNOB THAT WAS NOT NAMED keeps its value on both sides, so the row reads as a
      // complete statement of the tuning before and after rather than a diff with holes in
      // it — which is what makes "did the allow-list change" answerable without a flag.
      expect(change?.kinds_from).toEqual(["erp_write_failed"]);
      expect(change?.kinds_to).toEqual(["erp_write_failed"]);
    });

    it("tells a cleared allow-list apart from one nobody mentioned", async () => {
      // The reason the caller sends the complete desired state rather than a patch: `kinds`
      // NULL means every kind, so in a partial record "not specified" and "set to null" are
      // the same thing and a COALESCE would read "clear it" as "leave it alone".
      const ep = await inTenant((tx) => create(tx, { kinds: ["erp_write_failed"] }));
      await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          kinds: null,
          changedBy: AUTHOR,
          reason: "subscribing it to everything, now that the receiver can take it",
        }),
      );
      const [cleared] = await inTenant((tx) => endpointHistory(tx, ep.id));
      expect(cleared?.kinds_from).toEqual(["erp_write_failed"]);
      expect(cleared?.kinds_to).toBeNull();

      await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          minSeverity: "urgent",
          changedBy: AUTHOR,
          reason: "raising the threshold and leaving the allow-list alone",
        }),
      );
      const [untouched] = await inTenant((tx) => endpointHistory(tx, ep.id));
      expect(untouched?.kinds_from).toBeNull();
      expect(untouched?.kinds_to).toBeNull();
      expect((await inTenant((tx) => getEndpoint(tx, ep.id)))?.kinds).toBeNull();
    });

    it("refuses a direct amendment, which is what makes the log the record", async () => {
      const ep = await inTenant((tx) => create(tx));
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.notification_endpoint SET enabled = false WHERE id = $1", [ep.id]),
        );
        expect(err.message).toMatch(/cannot be updated directly/);
      });
      expect((await inTenant((tx) => getEndpoint(tx, ep.id)))?.enabled).toBe(true);
    });

    it("refuses an amendment that changes nothing rather than recording it", async () => {
      const ep = await inTenant((tx) => create(tx));
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          updateEndpoint(tx, ep.id, {
            enabled: true,
            changedBy: AUTHOR,
            reason: "writing down the state that is already in force",
          }),
        );
        expect(err.name).toBe("EndpointAmendmentError");
        expect(err.message).toMatch(/changes nothing/);
      });
      expect(await inTenant((tx) => endpointHistory(tx, ep.id))).toEqual([]);
    });

    it("is append-only: an amendment cannot be edited or deleted afterwards", async () => {
      const ep = await inTenant((tx) => create(tx));
      await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          enabled: false,
          changedBy: AUTHOR,
          reason: "off while the receiver is rebuilt, and this row stays either way",
        }),
      );
      await inTenant(async (tx) => {
        const edited = await refuses(tx, () =>
          tx.query("UPDATE crm.notification_endpoint_change SET reason = 'something else'"),
        );
        expect(edited.message).toMatch(/append-only/);
        const removed = await refuses(tx, () => tx.query("DELETE FROM crm.notification_endpoint_change"));
        expect(removed.message).toMatch(/append-only/);
      });
      expect(await inTenant((tx) => endpointHistory(tx, ep.id))).toHaveLength(1);
    });

    it("keeps each endpoint's history to itself", async () => {
      const a = await inTenant((tx) => create(tx, { url: "https://hooks.example.test/a" }));
      const b = await inTenant((tx) => create(tx, { url: "https://hooks.example.test/b" }));
      await inTenant((tx) =>
        updateEndpoint(tx, a.id, {
          enabled: false,
          changedBy: AUTHOR,
          reason: "turning off the first one and not the second",
        }),
      );
      expect(await inTenant((tx) => endpointHistory(tx, a.id))).toHaveLength(1);
      expect(await inTenant((tx) => endpointHistory(tx, b.id))).toEqual([]);
    });

    it("reads newest first, and caps what it returns", async () => {
      const ep = await inTenant((tx) => create(tx));
      for (const severity of ["info", "warning", "urgent"] as const) {
        await inTenant((tx) =>
          updateEndpoint(tx, ep.id, {
            minSeverity: severity,
            changedBy: AUTHOR,
            reason: `moving the threshold to ${severity}`,
          }),
        );
      }
      const all = await inTenant((tx) => endpointHistory(tx, ep.id));
      expect(all.map((c) => c.min_severity_to)).toEqual(["urgent", "warning", "info"]);
      // Deterministic because `changed_at` is `clock_timestamp()` rather than `now()`: the
      // transaction clock would tie for two amendments written in one transaction.
      expect((await inTenant((tx) => endpointHistory(tx, ep.id, { limit: 2 }))).map((c) => c.min_severity_to))
        .toEqual(["urgent", "warning"]);
    });
  });
});
