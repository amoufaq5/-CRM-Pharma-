import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { SET_TENANT_CONTEXT_SQL, withTenantContext } from "@crm/db";
import {
  TENANT_ENDPOINT_CAP as TENANT,
  TENANT_ENDPOINT_CAP_OTHER as OTHER,
  appPool,
  fixtureAuthor,
  wipeConfigChanges,
  wipeEndpoints,
  withFixtureAttribution,
} from "@crm/db/testing";

import {
  DEFAULT_ENDPOINT_CAP,
  EndpointCapExceededError,
  InvalidEndpointCapError,
  MAX_ENDPOINT_CAP,
  createEndpoint,
  endpointCap,
  listEndpoints,
  setEndpointCap,
  updateEndpoint,
} from "./endpoints.js";

/**
 * The bound on a tenant's destinations (migration 0071).
 *
 * ADR-0001's open row said `crm.notification_endpoint` had "no horizon and no cap while every
 * replacement adds a row", and this is the cap. The horizon is deliberately absent and that
 * absence is asserted here too — there is no DELETE anywhere in this subsystem, because a
 * delivery record outliving its endpoint (0048) is only legible while the endpoint row explains
 * its copied url, and `crm.record_config_change` does not fire on DELETE, so a sweep that removed
 * configuration would be the one write in this schema nobody signed.
 *
 * `appPool()` rather than `testPool()`: the concurrency test below opens two connections of its
 * own and interleaves them, which is the only way to assert the advisory lock actually serialises
 * the count-then-insert — 0045 verified the same failure the same way, after reasoning about it
 * and getting it wrong.
 */
describe("the endpoint cap", () => {
  let pool: Pool;
  let client: PoolClient;

  const AUTHOR = "d3000000-0000-4000-8000-0000000000b1";
  const OTHER_AUTHOR = "d3000000-0000-4000-8000-0000000000b2";

  /**
   * Tenant context AND attribution. `crm.notification_policy` is under
   * `crm.require_config_attribution` (0061), so the cap — which lives on that row — cannot be
   * written without an author and a reason. Wrapped once here rather than at each call site:
   * the signature is a precondition for writing configuration, not the thing under test, and
   * the route does the same through `asChange`.
   */
  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, (tx) => withFixtureAttribution(tx, TENANT, fn));
  const inOther = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER, (tx) => withFixtureAttribution(tx, OTHER, fn));
  /** Without the attribution block, for the teardown and the raw-SQL reads. */
  const plainly = <T>(tenant: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, tenant, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    for (const [tenant, id, subject] of [
      [TENANT, AUTHOR, "cap-author"],
      [OTHER, OTHER_AUTHOR, "cap-author-other"],
    ] as const) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name, status)
           VALUES ($1,$2,$3,$3,'A Cap Administrator','active') ON CONFLICT (id) DO NOTHING`,
          [id, tenant, subject],
        );
        // The author `withFixtureAttribution` signs with, which is a different rep from the one
        // that creates the endpoints — 0061 wants a person, not a constant.
        await fixtureAuthor(tx, tenant);
      });
    }
  });

  const reset = async (): Promise<void> => {
    for (const tenant of [TENANT, OTHER]) {
      await plainly(tenant, async (tx) => {
        await wipeEndpoints(tx, tenant);
        // 0061's log names its author ON DELETE RESTRICT, so the configuration history has to
        // go before the reps that signed it — and every cap written below writes one.
        await wipeConfigChanges(tx, tenant);
        await tx.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  afterAll(async () => {
    await reset();
    await plainly(TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2", [TENANT, AUTHOR]);
    });
    await plainly(OTHER, async (tx) => {
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2", [OTHER, OTHER_AUTHOR]);
    });
    client?.release();
    await pool?.end();
  });

  beforeEach(reset);

  /** One more destination, with a url nothing else uses — the cap counts rows, not urls. */
  let n = 0;
  const add = (tx: PoolClient, tenant: string = TENANT, by: string = AUTHOR) => {
    n += 1;
    return createEndpoint(tx, tenant, {
      channel: "webhook",
      url: `https://hooks.example.test/cap-${String(n)}`,
      secretEnv: "CRM_TEST_WEBHOOK_SECRET",
      createdBy: by,
      reason: "a fixture adding one more destination, with a sentence attached",
    });
  };

  // -------------------------------------------------------------------------
  describe("the number", () => {
    it("defaults for a tenant that has never had a policy row", async () => {
      expect(await inTenant((tx) => endpointCap(tx, TENANT))).toEqual({
        used: 0,
        maxEndpoints: DEFAULT_ENDPOINT_CAP,
      });
      expect(DEFAULT_ENDPOINT_CAP).toBe(50);
    });

    /**
     * THE DEFAULT HAS TO BE THE DEFAULT AND NOT "NO CAP", and the only way to assert that is to
     * reach it: fifty endpoints, no policy row, and the fifty-first refused. A tenant has no
     * policy row until something writes one, which for most tenants is never — so a guard that
     * read the absence as unbounded would be a guard that applied to almost nobody. The same
     * fail-closed reading 0034 gives the cooldown and 0045 gives the probe budget.
     *
     * Fifty inserts rather than a cap set to one, because a test that sets the number is a test
     * of the column and not of the absence. It also pins `DEFAULT_ENDPOINT_CAP` against the
     * database's own DEFAULT, which is the pair that would otherwise drift.
     */
    it("applies at its default to a tenant with no policy row at all", async () => {
      await inTenant(async (tx) => {
        for (let i = 0; i < DEFAULT_ENDPOINT_CAP; i += 1) await add(tx);
      });
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.notification_policy WHERE tenant_id = $1",
        [TENANT],
      );
      expect(rows[0]!.n, "creating endpoints must not have written a policy row").toBe("0");

      const err = await refusal(() => inTenant((tx) => add(tx)));
      expect(err).toBeInstanceOf(EndpointCapExceededError);
      expect(err.message).toContain(`${String(DEFAULT_ENDPOINT_CAP)} of ${String(DEFAULT_ENDPOINT_CAP)}`);
    });

    it("counts what the tenant holds, disabled rows included", async () => {
      const id = await inTenant(async (tx) => {
        const first = await add(tx);
        await add(tx);
        return first.id;
      });
      await inTenant((tx) =>
        updateEndpoint(tx, id, {
          enabled: false,
          changedBy: AUTHOR,
          reason: "switching one off, which does not give the tenant a row back",
        }),
      );
      // THE TABLE IS WHAT IS BOUNDED, so a disabled endpoint still occupies a slot. Counting
      // only the enabled ones would bound the fan-out per signal and leave the growth this cap
      // exists for — "disable the old endpoint, create a new one" — completely unbounded.
      expect(await inTenant((tx) => endpointCap(tx, TENANT))).toEqual({ used: 2, maxEndpoints: 50 });
    });

    it("is settable, and reports the count beside it", async () => {
      await inTenant((tx) => add(tx));
      expect(await inTenant((tx) => setEndpointCap(tx, TENANT, 3))).toEqual({
        used: 1,
        maxEndpoints: 3,
      });
    });

    it("refuses a cap outside the range the column admits, naming the bound", async () => {
      for (const bad of [0, -1, 501, 1.5]) {
        const err = await refusal(() => inTenant((tx) => setEndpointCap(tx, TENANT, bad)));
        expect(err, String(bad)).toBeInstanceOf(InvalidEndpointCapError);
        expect(err.message).toContain(String(MAX_ENDPOINT_CAP));
      }
      // And the sentence says why there is no 0, which is the question somebody reading the
      // range will ask: a cap of zero forbids having any destination at all, which is a thing
      // to decide by disabling what you have.
      const zero = await refusal(() => inTenant((tx) => setEndpointCap(tx, TENANT, 0)));
      expect(zero.message).toContain("There is no 0");
    });
  });

  // -------------------------------------------------------------------------
  describe("the refusal", () => {
    it("refuses the one past the cap, naming the numbers and BOTH ways out", async () => {
      await inTenant(async (tx) => {
        await setEndpointCap(tx, TENANT, 2);
        await add(tx);
        await add(tx);
      });
      const err = await refusal(() => inTenant((tx) => add(tx)));
      expect(err).toBeInstanceOf(EndpointCapExceededError);
      expect(err.message).toContain("2 of 2 permitted notification endpoints");
      // A cap whose refusal has no next step is a cliff rather than a bound, so the sentence
      // carries both: reuse a row that already points where you want, or move the number.
      expect(err.message).toContain("re-enable a disabled endpoint");
      expect(err.message).toContain("max_endpoints");
      // And it is not translated as a typo in the url, which is what an operator would read
      // if the cap arm were below the url arm in `translateEndpointError`.
      expect(err.message).not.toContain("https://");
      expect(await inTenant((tx) => listEndpoints(tx, TENANT))).toHaveLength(2);
    });

    it("lets the tenant through again once the cap is raised", async () => {
      await inTenant(async (tx) => {
        await setEndpointCap(tx, TENANT, 1);
        await add(tx);
      });
      expect(await refusal(() => inTenant((tx) => add(tx)))).toBeInstanceOf(EndpointCapExceededError);
      await inTenant((tx) => setEndpointCap(tx, TENANT, 2));
      expect((await inTenant((tx) => add(tx))).id).toBeTruthy();
    });

    it("is per tenant: one tenant at its ceiling says nothing about another", async () => {
      await inTenant(async (tx) => {
        await setEndpointCap(tx, TENANT, 1);
        await add(tx);
      });
      expect(await refusal(() => inTenant((tx) => add(tx)))).toBeInstanceOf(EndpointCapExceededError);
      expect((await inOther((tx) => add(tx, OTHER, OTHER_AUTHOR))).id).toBeTruthy();
    });

    /**
     * LOWERING THE CAP BELOW WHAT A TENANT HOLDS IS PERMITTED, and the guard is BEFORE INSERT
     * only so that tenant can still tidy up. A guard on UPDATE would freeze the configuration of
     * exactly the tenant trying to comply: it could not disable the endpoints it has decided it
     * no longer wants, because every amendment is an UPDATE of the endpoint row.
     */
    it("does not freeze a tenant that is over a cap it has just lowered", async () => {
      const id = await inTenant(async (tx) => {
        const first = await add(tx);
        await add(tx);
        await add(tx);
        return first.id;
      });
      expect(await inTenant((tx) => setEndpointCap(tx, TENANT, 1))).toEqual({
        used: 3,
        maxEndpoints: 1,
      });
      // The amendment still works, which is the whole point.
      const amended = await inTenant((tx) =>
        updateEndpoint(tx, id, {
          enabled: false,
          changedBy: AUTHOR,
          reason: "complying with a cap this tenant has just lowered",
        }),
      );
      // `updateEndpoint` returns `EndpointRow | null` — null when the id is not this tenant's —
      // so the null is asserted away rather than assumed. `pnpm typecheck` cannot see this,
      // because `tsc --build` excludes `*.test.ts`; `pnpm typecheck:tests` is what does, and
      // skipping it is what sent this file to CI with a type error in it.
      expect(amended?.enabled).toBe(false);
      // But adding is still refused, because the act is what the cap governs.
      expect(await refusal(() => inTenant((tx) => add(tx)))).toBeInstanceOf(EndpointCapExceededError);
    });
  });

  // -------------------------------------------------------------------------
  describe("two administrators at once", () => {
    /**
     * The failure 0045 verified rather than reasoned about, on a second counter.
     *
     * Without the advisory lock both transactions read `used = max - 1`, both pass, and both
     * commit: the ceiling holds at `max + 1` once per concurrent request. The lock is taken
     * BEFORE the count, and is xact-scoped, because the row being inserted becomes visible to
     * the next counter only at COMMIT.
     */
    it("refuses the second of two simultaneous creations against the last slot", async () => {
      await inTenant((tx) => setEndpointCap(tx, TENANT, 1));

      const a = await pool.connect();
      const b = await pool.connect();
      let raced: unknown = null;
      try {
        await a.query("BEGIN");
        await b.query("BEGIN");
        await a.query(SET_TENANT_CONTEXT_SQL, [TENANT]);
        await b.query(SET_TENANT_CONTEXT_SQL, [TENANT]);

        // A takes the only slot and holds its transaction open.
        await add(a);

        // B starts while A is uncommitted. It blocks inside the guard, at the advisory lock,
        // BEFORE it has counted anything.
        const bInsert = add(b).catch((e: unknown) => {
          raced = e;
        });
        await waitUntilBlocked(client, 1);
        await a.query("COMMIT");
        await bInsert;
        await b.query("ROLLBACK");
      } finally {
        a.release();
        b.release();
      }

      expect(raced).toBeInstanceOf(EndpointCapExceededError);
      expect((raced as Error).message).toContain("1 of 1 permitted");
      expect(await inTenant((tx) => listEndpoints(tx, TENANT))).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("the horizon this migration refuses to add", () => {
    /**
     * ASSERTED, because an absence that is a decision looks exactly like an absence that is an
     * oversight — the rule `crm.notification_prune_candidates`'s allow-list is asserted by, for
     * the same reason. Nothing in this subsystem deletes a destination: 0048 and 0070 dropped
     * two cascades so the delivery and probe records outlive it, 0060 made the amendment log
     * the source of truth, and `crm.record_config_change` fires on INSERT OR UPDATE only — so a
     * scheduled deletion of configuration would be unattributable by construction.
     */
    it("has no job, no function and no route that deletes an endpoint", async () => {
      const { rows: jobs } = await client.query<{ job: string }>(`SELECT unnest(crm.scheduled_jobs()) AS job`);
      expect(jobs.map((r) => r.job).filter((j) => /endpoint/.test(j))).toEqual([]);
      const { rows: platform } = await client.query<{ job: string }>(
        `SELECT unnest(crm.platform_jobs()) AS job`,
      );
      expect(platform.map((r) => r.job).filter((j) => /endpoint/.test(j))).toEqual([]);
      const { rows: fns } = await client.query<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'crm' AND p.proname ~ 'endpoint'`,
      );
      expect(fns.map((r) => r.proname).filter((f) => /retire|delete|prune|purge/.test(f))).toEqual([]);
    });

    /**
     * And the one reference that would refuse a hand-written DELETE is still there, which is the
     * obstacle ADR-0001's row now names: 0060's amendment log at `ON DELETE RESTRICT`, the
     * audit-child convention. 0070 removed the last CASCADE, so this is the only key left.
     */
    it("leaves the amendment log refusing a hand-written delete", async () => {
      const { rows } = await client.query<{ conname: string; confdeltype: string }>(
        `SELECT conname, confdeltype FROM pg_constraint
          WHERE confrelid = 'crm.notification_endpoint'::regclass AND contype = 'f'`,
      );
      expect(rows.map((r) => `${r.conname}:${r.confdeltype}`)).toEqual([
        "notification_endpoint_change_endpoint_id_fkey:r",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Helpers that need the describes above them to be readable.
  // -------------------------------------------------------------------------

  const refusal = async (fn: () => Promise<unknown>): Promise<Error> => {
    try {
      await fn();
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected a refusal, got none");
  };

  const waitUntilBlocked = async (via: PoolClient, expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { rows } = await via.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 71 AND NOT granted`,
      );
      if ((rows[0]?.n ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the concurrent creation never blocked on the cap's advisory lock");
  };
});
