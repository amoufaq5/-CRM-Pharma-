import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool, TENANT_CHANNEL_COVERAGE as TENANT, fixtureAuthor, wipeEndpoints } from "@crm/db/testing";

import {
  CHANNEL_COVERAGE_VERDICTS,
  assessChannelCoverage,
  checkChannelCoverage,
  endpointChannelUsage,
  type EndpointChannelUsage,
} from "./channel-coverage.js";

/**
 * The boot-time coverage check, against a real Postgres.
 *
 * The half that needs a database is the only half worth a contract test: the whole
 * constraint this module exists under is that `crm.notification_endpoint` is tenant-scoped
 * under FORCED row-level security, so a boot-time read with no tenant context sees nothing
 * — and a test that connected as a superuser, or one that queried inside a context it
 * forgot to assert, would prove the opposite of what it claims.
 *
 * `appPool()`: `checkChannelCoverage` opens its own client, which inherits the pool's role.
 * Under the admin pool it would run as a superuser and RLS would be off for every
 * assertion below.
 */
describe("channel coverage", () => {
  /**
   * A second tenant, derived from this file's reserved block rather than reserved
   * separately — `packages/db/src/testing.ts` hands out one id per test file and this file
   * needs two, because "a gap is named per tenant" is not assertable with one. Nothing
   * references `crm.tenant` from `crm.notification_endpoint`, so an id that exists only
   * here is sufficient and cannot collide with another file's block.
   */
  const OTHER = "df100000-0000-4000-8000-0000000000ff";

  const WEBHOOK_ONLY = [{ channel: "webhook" }] as const;
  const BOTH = [{ channel: "webhook" }, { channel: "email" }] as const;

  describe("the verdict, as a pure function", () => {
    const usage = (over: Partial<EndpointChannelUsage> = {}): EndpointChannelUsage => ({
      tenantId: TENANT,
      channel: "email",
      enabled: 1,
      disabled: 0,
      ...over,
    });

    it("is covered when every configured channel has a sender", () => {
      const c = assessChannelCoverage([usage({ channel: "webhook" })], WEBHOOK_ONLY, 1);
      expect(c.verdict).toBe("covered");
      expect(c.unsendable).toEqual([]);
      expect(c.dormant).toEqual([]);
      expect(c.lines).toEqual([]);
      expect(c.summary).toContain("every configured channel (webhook)");
    });

    /**
     * Said rather than skipped. A deployment with no endpoints at all looks identical to a
     * healthy one in every other log line, and "no endpoints" is the answer to "why was
     * nobody paged".
     */
    it("is covered with no endpoints at all, and says that is what happened", () => {
      const c = assessChannelCoverage([], BOTH, 3);
      expect(c.verdict).toBe("covered");
      expect(c.summary).toContain("no notification endpoint is configured");
      expect(c.summary).toContain("3 tenant(s)");
      expect(c.summary).toContain("email, webhook");
    });

    it("is unsendable when an ENABLED endpoint names a channel with no sender", () => {
      const c = assessChannelCoverage([usage({ enabled: 2 })], WEBHOOK_ONLY, 1);
      expect(c.verdict).toBe("unsendable");
      expect(c.unsendable).toHaveLength(1);
      expect(c.dormant).toEqual([]);
    });

    /**
     * The case that must not brick a deployment: webhooks only, with one disabled email
     * endpoint left in the table. Nothing is late, so nothing is a fault — but silence
     * would be wrong too, because enabling it is one click.
     */
    it("is dormant, not unsendable, when only DISABLED endpoints name the channel", () => {
      const c = assessChannelCoverage([usage({ enabled: 0, disabled: 1 })], WEBHOOK_ONLY, 1);
      expect(c.verdict).toBe("dormant");
      expect(c.unsendable).toEqual([]);
      expect(c.dormant).toHaveLength(1);
      expect(c.lines[0]).toContain("so nothing is late");
      expect(c.lines[0]).toContain("enabling one would be unsendable here");
    });

    it("counts a channel with both enabled and disabled endpoints as unsendable", () => {
      const c = assessChannelCoverage([usage({ enabled: 1, disabled: 4 })], WEBHOOK_ONLY, 1);
      expect(c.verdict).toBe("unsendable");
      expect(c.lines[0]).toContain("1 enabled endpoint(s)");
      expect(c.lines[0]).not.toContain("4 disabled");
    });

    it("reports unsendable ahead of dormant when both exist", () => {
      const c = assessChannelCoverage(
        [usage({ enabled: 0, disabled: 1 }), usage({ tenantId: OTHER, enabled: 1 })],
        WEBHOOK_ONLY,
        2,
      );
      expect(c.verdict).toBe("unsendable");
      expect(c.lines[0]).toContain(OTHER);
      expect(c.lines[0]).toContain("will retry until it dead-letters");
      expect(c.lines[1]).toContain(TENANT);
    });

    /**
     * The sentence has to let an operator tell "wrong binary" from "wrong endpoint", which
     * means naming both the channel in the row and what the process actually has. This is
     * `dispatch.ts`'s retry reason, deliberately in the same voice.
     */
    it("names the channel AND what this process registers", () => {
      const c = assessChannelCoverage([usage()], WEBHOOK_ONLY, 1);
      expect(c.lines[0]).toContain("no sender registered for channel email in this process");
      expect(c.lines[0]).toContain("it registers webhook");
      expect(c.lines[0]).toContain(TENANT);
    });

    it("says `none` when the process registers no sender at all", () => {
      const c = assessChannelCoverage([usage()], [], 1);
      expect(c.registered).toEqual([]);
      expect(c.lines[0]).toContain("it registers none");
      expect(c.verdict).toBe("unsendable");
    });

    it("de-duplicates and sorts the registered channels", () => {
      const c = assessChannelCoverage([], [{ channel: "webhook" }, { channel: "email" }, { channel: "webhook" }], 1);
      expect(c.registered).toEqual(["email", "webhook"]);
    });

    /** Two boots with the same fault must log the same thing, or a log diff is noise. */
    it("orders gaps by channel then tenant, whatever order the rows arrived in", () => {
      const rows = [
        usage({ tenantId: OTHER, channel: "sms" }),
        usage({ tenantId: TENANT, channel: "sms" }),
        usage({ tenantId: OTHER, channel: "email" }),
      ];
      const forward = assessChannelCoverage(rows, WEBHOOK_ONLY, 2);
      const backward = assessChannelCoverage([...rows].reverse(), WEBHOOK_ONLY, 2);
      expect(forward.unsendable.map((u) => `${u.channel}/${u.tenantId}`)).toEqual([
        `email/${OTHER}`,
        `sms/${TENANT}`,
        `sms/${OTHER}`,
      ]);
      expect(backward.lines).toEqual(forward.lines);
    });

    it("counts the tenants it was asked about, not the ones with endpoints", () => {
      const c = assessChannelCoverage([usage({ channel: "webhook" })], WEBHOOK_ONLY, 9);
      expect(c.tenantsChecked).toBe(9);
    });

    it("only ever returns a declared verdict", () => {
      for (const rows of [[], [usage()], [usage({ enabled: 0, disabled: 1 })]]) {
        expect(CHANNEL_COVERAGE_VERDICTS).toContain(assessChannelCoverage(rows, WEBHOOK_ONLY, 1).verdict);
      }
    });

    it("mentions the disabled count in a dormant line and the enabled count in an unsendable one", () => {
      const dormant = assessChannelCoverage([usage({ enabled: 0, disabled: 3 })], WEBHOOK_ONLY, 1);
      expect(dormant.lines[0]).toContain("3 disabled endpoint(s)");
      expect(dormant.summary).toContain("1 channel/tenant pair(s)");
    });
  });

  describe("against the database", () => {
    let pool: Pool;
    let client: PoolClient;

    const inTenant = <T>(tenant: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
      withTenantContext(client, tenant, fn);

    beforeAll(async () => {
      pool = appPool();
      client = await pool.connect();
      await client.query("SET ROLE crm_app");
    });

    afterAll(async () => {
      await wipe();
      await client?.query("RESET ROLE");
      client?.release();
      await pool?.end();
    });

    const wipe = async (): Promise<void> => {
      for (const tenant of [TENANT, OTHER]) {
        await inTenant(tenant, async (tx) => {
          await wipeEndpoints(tx, tenant);
        });
      }
    };

    beforeEach(wipe);

    const add = async (
      tenant: string,
      opts: { channel: "webhook" | "email"; enabled?: boolean; tag?: string },
    ): Promise<string> => {
      const tag = opts.tag ?? Math.random().toString(36).slice(2, 10);
      const url = opts.channel === "email" ? `mailto:${tag}@example.com` : `https://hooks.example.com/${tag}`;
      return await inTenant(tenant, async (tx) => {
        await fixtureAuthor(tx, tenant);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO crm.notification_endpoint
             (tenant_id, channel, url, secret_env, enabled, created_by, created_reason)
           VALUES ($1,$2,$3,'CRM_COVERAGE_SECRET',$4,
                   (SELECT id FROM crm.rep_profile WHERE tenant_id = $1 AND subject = 'fixture-endpoint-author'),
                   'a fixture needs an endpoint, and 0060 refuses one that names nobody')
           RETURNING id`,
          [tenant, opts.channel, url, opts.enabled ?? true],
        );
        return rows[0]!.id;
      });
    };

    it("splits enabled from disabled, per channel", async () => {
      await add(TENANT, { channel: "webhook" });
      await add(TENANT, { channel: "email" });
      await add(TENANT, { channel: "email", enabled: false });
      const usage = await inTenant(TENANT, (tx) => endpointChannelUsage(tx, TENANT));
      expect(usage).toEqual([
        { tenantId: TENANT, channel: "email", enabled: 1, disabled: 1 },
        { tenantId: TENANT, channel: "webhook", enabled: 1, disabled: 0 },
      ]);
    });

    /**
     * The constraint this whole module is shaped by, asserted rather than described: a
     * read with no tenant context returns NOTHING, so a single cross-tenant `SELECT
     * DISTINCT channel` at boot would have reported a clean deployment for every tenant.
     *
     * Connected as `crm_app`, which is what makes it mean anything — the table's owner is
     * exempt from its policy unless FORCED, and a superuser is exempt even then.
     */
    it("sees nothing at all without a tenant context, which is why boot must iterate tenants", async () => {
      await add(TENANT, { channel: "email" });
      const { rows } = await client.query<{ channel: string }>(
        "SELECT channel FROM crm.notification_endpoint_channels()",
      );
      expect(rows).toEqual([]);
    });

    it("sees one tenant's channels and not another's", async () => {
      await add(TENANT, { channel: "webhook" });
      await add(OTHER, { channel: "email" });
      const mine = await inTenant(TENANT, (tx) => endpointChannelUsage(tx, TENANT));
      const theirs = await inTenant(OTHER, (tx) => endpointChannelUsage(tx, OTHER));
      expect(mine.map((u) => u.channel)).toEqual(["webhook"]);
      expect(theirs.map((u) => u.channel)).toEqual(["email"]);
    });

    it("returns nothing for a tenant with no endpoints", async () => {
      expect(await inTenant(TENANT, (tx) => endpointChannelUsage(tx, TENANT))).toEqual([]);
    });

    it("aggregates the gap per tenant across the whole boot check", async () => {
      await add(TENANT, { channel: "email" });
      await add(OTHER, { channel: "email" });
      await add(OTHER, { channel: "webhook" });
      const coverage = await checkChannelCoverage(pool, [TENANT, OTHER], WEBHOOK_ONLY);
      expect(coverage.verdict).toBe("unsendable");
      expect(coverage.tenantsChecked).toBe(2);
      expect(coverage.unsendable.map((u) => u.tenantId).sort()).toEqual([OTHER, TENANT].sort());
      expect(coverage.lines).toHaveLength(2);
      expect(coverage.unreadable).toEqual([]);
    });

    it("is covered once the email sender is registered, with the same rows", async () => {
      await add(TENANT, { channel: "email" });
      await add(TENANT, { channel: "webhook" });
      const coverage = await checkChannelCoverage(pool, [TENANT], BOTH);
      expect(coverage.verdict).toBe("covered");
      expect(coverage.lines).toEqual([]);
      expect(coverage.summary).toContain("email, webhook");
    });

    /** The webhooks-only deployment with a leftover disabled email endpoint. */
    it("does not call a disabled email endpoint a fault in a webhook-only process", async () => {
      await add(TENANT, { channel: "webhook" });
      await add(TENANT, { channel: "email", enabled: false });
      const coverage = await checkChannelCoverage(pool, [TENANT], WEBHOOK_ONLY);
      expect(coverage.verdict).toBe("dormant");
      expect(coverage.unsendable).toEqual([]);
      expect(coverage.lines[0]).toContain("1 disabled endpoint(s)");
    });

    /**
     * "We could not look" and "there is nothing there" are the two answers this must never
     * conflate, and a boot check that threw would stop a scheduler over something
     * unrelated to sending. A malformed tenant id is the reachable version of that: it is
     * refused by `withTenantContext` before any SQL runs.
     */
    it("reports a tenant it could not read rather than counting it as clean", async () => {
      await add(TENANT, { channel: "webhook" });
      const coverage = await checkChannelCoverage(pool, [TENANT, "not-a-uuid"], WEBHOOK_ONLY);
      expect(coverage.verdict).toBe("covered");
      expect(coverage.unreadable).toEqual(["not-a-uuid"]);
      expect(coverage.lines.at(-1)).toContain("could not be read for 1 tenant(s)");
      expect(coverage.lines.at(-1)).toContain("would not appear above");
    });

    it("still finds the gaps it could read when another tenant is unreadable", async () => {
      await add(TENANT, { channel: "email" });
      const coverage = await checkChannelCoverage(pool, [TENANT, "nope"], WEBHOOK_ONLY);
      expect(coverage.verdict).toBe("unsendable");
      expect(coverage.lines).toHaveLength(2);
      expect(coverage.unreadable).toEqual(["nope"]);
    });

    it("returns the client to the pool, so a boot check cannot exhaust it", async () => {
      for (let i = 0; i < 12; i += 1) {
        await checkChannelCoverage(pool, [TENANT], WEBHOOK_ONLY);
      }
      // `appPool()` has max 8; a leaked client per call would have hung above long before
      // this assertion, which is the point — it is a deadlock test, not a count test.
      expect(pool.idleCount).toBeGreaterThan(0);
    });
  });
});
