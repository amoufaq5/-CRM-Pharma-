import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { TENANT_ENDPOINT_RULES as TENANT, appPool, fixtureAuthor, wipeEndpoints } from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import { InvalidEndpointError, createEndpoint, getEndpoint, updateEndpoint } from "./endpoints.js";
import { NOTIFICATION_KINDS } from "./kinds.js";

/**
 * The two endpoint rules migration 0049 moved out of TypeScript.
 *
 * Both of them were real rules with real reasons, stated in `endpoints.ts` and enforced by
 * a function a `psql` prompt walks past: the destination is fixed for the life of the
 * endpoint, and the kind allow-list is drawn from a closed vocabulary. This file asserts
 * them against a real Postgres through RAW SQL, because the whole claim is about the writer
 * that does not go through `endpoints.ts` — a test that only called `updateEndpoint` would
 * pass identically before and after the migration.
 *
 * The third thing it pins is the arrangement that made the second rule addable at all:
 * `crm.notification_kinds()` is the single declaration, and both the producing CHECK and
 * the consuming one read it. 0046 refused to make a second copy of this list and gave the
 * reason; the test below is what stops a third from appearing.
 */
describe("endpoint rules (0049)", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "e9490000-0000-4000-8000-000000000101";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const create = (tx: PoolClient, over: Partial<Parameters<typeof createEndpoint>[2]> = {}) =>
    createEndpoint(tx, TENANT, {
      channel: "webhook",
      url: "https://hooks.example.test/crm",
      secretEnv: "CRM_TEST_WEBHOOK_SECRET",
      // Required since 0060: an endpoint names the rep who opened the route and why.
      createdBy: REP,
      reason: "this suite needs an endpoint whose other rules can be probed",
      ...over,
    });

  /** The error a raw statement came back with, as `{ code, constraint, message }`. */
  const refusal = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ code: string | undefined; constraint: string | undefined; message: string }> => {
    try {
      await inTenant((tx) => tx.query(sql, [...params]));
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message ?? String(err) };
    }
    throw new Error(`expected a refusal, but the statement succeeded: ${sql}`);
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1,$2,'er-rep','er-rep','Endpoint Rules') ON CONFLICT DO NOTHING`,
        [REP, TENANT],
      );
      // 0060 refuses an endpoint that names nobody, and the raw-SQL probes below create one
      // to be refused for OTHER reasons — so they need an author, or the attribution guard
      // answers first and the constraint under test never runs.
      await fixtureAuthor(tx, TENANT);
    });
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await wipeEndpoints(tx, TENANT);
    });
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await wipeEndpoints(tx, TENANT);
    });
  });

  // -------------------------------------------------------------------------
  // The vocabulary, declared once.
  // -------------------------------------------------------------------------
  describe("crm.notification_kinds()", () => {
    /**
     * The migration rewrote a nine-string literal into a function. A rewrite is the one
     * place a vocabulary can quietly lose a member — and losing one would not fail, it
     * would refuse a signal the code still raises. Both directions, so neither an omission
     * nor an invention passes.
     */
    it("is exactly NOTIFICATION_KINDS", async () => {
      const { rows } = await inTenant((tx) =>
        tx.query<{ kinds: string[] }>("SELECT crm.notification_kinds() AS kinds"),
      );
      expect([...rows[0]!.kinds].sort()).toEqual([...NOTIFICATION_KINDS].sort());
    });

    /**
     * And that both CHECKs READ it rather than restating it. This is the assertion that
     * keeps a future widening to one edit: if either constraint is ever rewritten back to a
     * literal `IN (...)` list, 0046's lockstep problem returns silently and this fails.
     */
    it("is what both CHECKs are written against", async () => {
      const { rows } = await inTenant((tx) =>
        tx.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE conname IN ('notification_kind_check', 'notification_endpoint_kinds_known')
            ORDER BY conname`,
        ),
      );
      expect(rows.map((r) => r.conname)).toEqual([
        "notification_endpoint_kinds_known",
        "notification_kind_check",
      ]);
      for (const row of rows) {
        expect(row.def).toContain("notification_kinds()");
      }
    });
  });

  // -------------------------------------------------------------------------
  // The producing side still enforces what it enforced before.
  // -------------------------------------------------------------------------
  describe("crm.notification.kind", () => {
    const insertKind = (tx: PoolClient, kind: string, dedup: string) =>
      tx.query(
        `INSERT INTO crm.notification
           (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key)
         VALUES ($1,$2,$3,'info','s','b',$4)`,
        [TENANT, REP, kind, dedup],
      );

    it("accepts every kind the code can raise", async () => {
      await inTenant(async (tx) => {
        for (const [i, kind] of NOTIFICATION_KINDS.entries()) {
          await insertKind(tx, kind, `er-ok-${String(i)}`);
        }
      });
      const { rows } = await inTenant((tx) =>
        tx.query<{ n: string }>("SELECT count(*)::text AS n FROM crm.notification WHERE tenant_id = $1", [
          TENANT,
        ]),
      );
      expect(Number(rows[0]!.n)).toBe(NOTIFICATION_KINDS.length);
    });

    it("still refuses one that does not exist", async () => {
      const r = await refusal(
        `INSERT INTO crm.notification
           (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key)
         VALUES ($1,$2,'call_plan_submited','info','s','b','er-typo')`,
        [TENANT, REP],
      );
      expect(r.constraint).toBe("notification_kind_check");
    });
  });

  // -------------------------------------------------------------------------
  // The consuming side, which until now had no opinion at all.
  // -------------------------------------------------------------------------
  describe("crm.notification_endpoint.kinds", () => {
    it("accepts an allow-list drawn from the vocabulary", async () => {
      const ep = await inTenant((tx) => create(tx, { kinds: ["call_plan_submitted", "erp_write_failed"] }));
      expect(ep.kinds).toEqual(["call_plan_submitted", "erp_write_failed"]);
    });

    it("accepts null, which means every kind", async () => {
      const ep = await inTenant((tx) => create(tx));
      expect(ep.kinds).toBeNull();
    });

    /**
     * The point of the migration. `normaliseKinds` is not in this path, so what refuses it
     * is the constraint — and before 0049 this statement succeeded and left an endpoint
     * that was `enabled`, probe-able, and subscribed to nothing.
     */
    it("refuses a kind that does not exist, from raw SQL", async () => {
      const r = await refusal(
        `INSERT INTO crm.notification_endpoint
           (tenant_id, channel, url, secret_env, kinds, created_by, created_reason)
         VALUES ($1,'webhook','https://hooks.example.test/x','CRM_TEST_WEBHOOK_SECRET',
                 ARRAY['call_plan_submited'],
                 (SELECT id FROM crm.rep_profile WHERE tenant_id = $1 AND subject = 'fixture-endpoint-author'),
                 'probing the kind allow-list, which answers after 0060 attribution guard')`,
        [TENANT],
      );
      expect(r.constraint).toBe("notification_endpoint_kinds_known");
      expect(r.code).toBe("23514");
    });

    /**
     * THROUGH THE AMENDMENT LOG, because since 0060 that is the only way an endpoint's
     * allow-list changes at all — a direct UPDATE is refused before any CHECK is reached.
     * Which is the stronger version of this test: the constraint now answers on the real
     * write path rather than on one nothing uses.
     */
    it("refuses one arriving by amendment too", async () => {
      const ep = await inTenant((tx) => create(tx, { kinds: ["call_plan_approved"] }));
      const r = await refusal(
        `INSERT INTO crm.notification_endpoint_change
           (tenant_id, endpoint_id, changed_by, reason, min_severity_to, kinds_to, enabled_to)
         VALUES ($1, $2, $3, 'subscribing to a kind that does not exist', 'warning',
                 ARRAY['not_a_kind'], true)`,
        [TENANT, ep.id, REP],
      );
      expect(r.constraint).toBe("notification_endpoint_kinds_known");
    });

    /**
     * Two constraints, two sentences. An empty array is `<@` anything, so the containment
     * check passes it and `kinds_not_empty` is what names it — which is the arrangement
     * 0049 intended, so `translateEndpointError` can tell a caller which rule they broke.
     */
    it("leaves emptiness to the constraint that was already asking", async () => {
      const r = await refusal(
        `INSERT INTO crm.notification_endpoint
           (tenant_id, channel, url, secret_env, kinds, created_by, created_reason)
         VALUES ($1,'webhook','https://hooks.example.test/y','CRM_TEST_WEBHOOK_SECRET',
                 ARRAY[]::text[],
                 (SELECT id FROM crm.rep_profile WHERE tenant_id = $1 AND subject = 'fixture-endpoint-author'),
                 'probing the empty allow-list, which answers after 0060 attribution guard')`,
        [TENANT],
      );
      expect(r.constraint).toBe("notification_endpoint_kinds_not_empty");
    });

    /** The TypeScript guard still runs first, and still names the kind. */
    it("is named by normaliseKinds before the database is asked", async () => {
      await expect(inTenant((tx) => create(tx, { kinds: ["call_plan_submited"] }))).rejects.toThrow(
        InvalidEndpointError,
      );
      await expect(inTenant((tx) => create(tx, { kinds: ["call_plan_submited"] }))).rejects.toThrow(
        /call_plan_submited/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // The destination is fixed for the life of the endpoint.
  // -------------------------------------------------------------------------
  describe("destination freeze", () => {
    /**
     * The list is published so this test can exist at all — and the second assertion is the
     * one that matters: a frozen column whose name is misspelled freezes nothing, silently,
     * because `to_jsonb(NEW) ->> 'ulr'` is NULL on both sides and never differs.
     */
    it("names columns that exist", async () => {
      const { rows } = await inTenant((tx) =>
        tx.query<{ frozen: string[] }>("SELECT crm.notification_endpoint_frozen_columns() AS frozen"),
      );
      const frozen = rows[0]!.frozen;
      // Five since 0060: the destination trio, plus who opened the route and why. The
      // trigger gives those two their own sentence, because 0049's — "has delivery records
      // naming url = …" — would send an operator hunting the wrong thing.
      expect(frozen).toEqual(["channel", "url", "secret_env", "created_by", "created_reason"]);

      const { rows: cols } = await inTenant((tx) =>
        tx.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'crm' AND table_name = 'notification_endpoint'`,
        ),
      );
      const names = cols.map((c) => c.column_name);
      for (const col of frozen) expect(names).toContain(col);
    });

    /** And that the knobs are not among them — the freeze must not eat `updateEndpoint`. */
    it("does not name anything updateEndpoint turns", async () => {
      const { rows } = await inTenant((tx) =>
        tx.query<{ frozen: string[] }>("SELECT crm.notification_endpoint_frozen_columns() AS frozen"),
      );
      for (const knob of ["min_severity", "kinds", "description", "enabled", "updated_at"]) {
        expect(rows[0]!.frozen).not.toContain(knob);
      }
    });

    it("refuses a repointed url", async () => {
      const ep = await inTenant((tx) => create(tx));
      const r = await refusal("UPDATE crm.notification_endpoint SET url = $2 WHERE id = $1", [
        ep.id,
        "https://somewhere.else.test/crm",
      ]);
      expect(r.message).toMatch(/^endpoint-destination-frozen: /);
      expect(r.message).toContain("url");
      expect(r.message).toContain("https://somewhere.else.test/crm");
      expect(r.code).toBe("23514");

      const still = await inTenant((tx) => getEndpoint(tx, ep.id));
      expect(still!.url).toBe("https://hooks.example.test/crm");
    });

    it("refuses a swapped secret", async () => {
      const ep = await inTenant((tx) => create(tx));
      const r = await refusal(
        "UPDATE crm.notification_endpoint SET secret_env = 'OTHER_SECRET' WHERE id = $1",
        [ep.id],
      );
      expect(r.message).toMatch(/^endpoint-destination-frozen: /);
      expect(r.message).toContain("secret_env");
    });

    /**
     * `channel` is frozen for the same reason as `url`, not as a consequence of it. The
     * url CHECK would refuse this statement too — `mailto:` and `https://` are disjoint
     * since 0029 — so the assertion is specifically that the TRIGGER answers, because a
     * BEFORE trigger runs before the row constraint and the better-aimed sentence is the
     * one about the destination.
     */
    it("refuses a changed channel, in the trigger's words", async () => {
      const ep = await inTenant((tx) => create(tx));
      const r = await refusal("UPDATE crm.notification_endpoint SET channel = 'email' WHERE id = $1", [
        ep.id,
      ]);
      expect(r.message).toMatch(/^endpoint-destination-frozen: /);
      expect(r.message).toContain("channel");
      expect(r.constraint).toBeUndefined();
    });

    it("leaves every knob turnable", async () => {
      const ep = await inTenant((tx) => create(tx, { kinds: ["call_plan_approved"] }));
      const after = await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          minSeverity: "urgent",
          kinds: ["erp_write_failed"],
          description: "now it is for failures",
          enabled: false,
          changedBy: REP,
          reason: "turning every knob at once, to show that every knob still turns",
        }),
      );
      expect(after).toMatchObject({
        min_severity: "urgent",
        kinds: ["erp_write_failed"],
        description: "now it is for failures",
        enabled: false,
        url: "https://hooks.example.test/crm",
      });
    });

    /**
     * A no-op write of the same value is not a change. `IS DISTINCT FROM` is what makes
     * that true, and an idempotent re-apply of a config is the shape that would otherwise
     * start failing for no reason.
     */
    /**
     * The freeze compares values, not whether a column appeared in the statement — so a
     * statement that writes the url it already had is not a repointing and is not refused.
     *
     * Routed through the amendment log since 0060, because a direct UPDATE is refused by the
     * guard beside it whatever the url says. What is being measured is unchanged: the freeze
     * has no opinion about an unchanged value, which is why the amendment's own UPDATE — one
     * that does not mention the url at all — passes it on every amendment.
     */
    it("has no opinion about an unchanged destination", async () => {
      const ep = await inTenant((tx) => create(tx));
      await inTenant((tx) =>
        updateEndpoint(tx, ep.id, {
          enabled: false,
          changedBy: REP,
          reason: "turning it off, with the destination left exactly as it was",
        }),
      );
      const after = await inTenant((tx) => getEndpoint(tx, ep.id));
      expect(after!.enabled).toBe(false);
      expect(after!.url).toBe("https://hooks.example.test/crm");
    });

    /** The freeze is on UPDATE only: creating an endpoint sets all three for the first time. */
    it("has no opinion about an insert", async () => {
      const ep = await inTenant((tx) =>
        create(tx, { url: "https://hooks.example.test/fresh", secretEnv: "ANOTHER_SECRET" }),
      );
      expect(ep.url).toBe("https://hooks.example.test/fresh");
    });
  });
});
