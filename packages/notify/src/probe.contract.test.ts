import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool, PoolClient } from "pg";
import { SET_TENANT_CONTEXT_SQL, withTenantContext } from "@crm/db";
import { appPool, TENANT_CHANNEL_COVERAGE as TENANT } from "@crm/db/testing";

import { NOTIFICATION_KINDS } from "./kinds.js";
import { verifyWebhook, type FetchLike } from "./sender.js";
import { InvalidSmtpRelayError, SmtpSender, type SmtpRelayConfig, type SmtpTransport } from "./smtp.js";
import { selfSignedCert, startSmtpSink, type SmtpSink, type SmtpSinkOptions } from "./testing-smtp.js";
import {
  DEFAULT_PROBE_BUDGET_MAX_PROBES,
  DEFAULT_PROBE_BUDGET_WINDOW_SECONDS,
  DEFAULT_PROBE_COOLDOWN_SECONDS,
  EndpointNotFoundError,
  ProbeRequesterNotFoundError,
  EndpointProbeRunner,
  InvalidProbeBudgetError,
  InvalidProbeCooldownError,
  MAX_PROBE_ATTEMPTS,
  MAX_PROBE_BUDGET_MAX_PROBES,
  MAX_PROBE_BUDGET_WINDOW_SECONDS,
  MAX_PROBE_COOLDOWN_SECONDS,
  MIN_PROBE_BUDGET_MAX_PROBES,
  MIN_PROBE_BUDGET_WINDOW_SECONDS,
  PROBE_EVENT,
  PROBE_STATES,
  PROBE_VERDICTS,
  ProbeBudgetExceededError,
  ProbeCooldownError,
  ProbeInFlightError,
  SmtpProber,
  WebhookProber,
  claimDueProbes,
  latestProbe,
  listProbes,
  probeBody,
  probeBudget,
  probeById,
  probeCooldownSeconds,
  recordProbeVerdict,
  requestProbe,
  setProbeBudget,
  setProbeCooldownSeconds,
  type ChannelProber,
  type ProbeBudgetState,
  type ProbeOutcome,
  type ProbeRow,
  type ProbeTarget,
} from "./probe.js";

/**
 * The endpoint probe, against a real Postgres, a real HTTP server and a real SMTP server.
 *
 * Nothing here is mocked at the seam that matters. The store is exercised through
 * `crm_app` so RLS and 0034's three triggers are live; the webhook prober POSTs to
 * `node:http` on loopback and the handler VERIFIES the signature over the bytes that
 * arrived; the email prober holds a conversation with the sink in `testing-smtp.ts` and the
 * test then asserts the sink received NO message, which is the one claim `reachable` makes
 * that a mock could have let through wrong.
 */
describe("the endpoint probe", () => {
  /** See channel-coverage.contract.test.ts: a second tenant out of this file's own block. */
  const OTHER_TENANT = "df100000-0000-4000-8000-0000000000fe";
  const ADMIN = "df100000-0000-4000-8000-0000000000a1";
  const OTHER_ADMIN = "df100000-0000-4000-8000-0000000000a2";
  const SECRET = "probe-secret-value";
  const SECRET_ENV = "CRM_PROBE_SECRET";

  let pool: Pool;
  let client: PoolClient;

  const inTenant = <T>(tenant: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, tenant, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    for (const [tenant, admin, subject] of [
      [TENANT, ADMIN, "probe-admin"],
      [OTHER_TENANT, OTHER_ADMIN, "probe-admin-other"],
    ] as const) {
      await inTenant(tenant, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [admin, tenant, subject],
        );
      });
    }
  });

  afterAll(async () => {
    await wipe();
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await inTenant(tenant, async (tx) => {
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  const wipe = async (): Promise<void> => {
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await inTenant(tenant, async (tx) => {
        // The probes go with the endpoints by the cascade 0034 declares; deleting them
        // explicitly first would hide a broken cascade rather than exercise it.
        await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  beforeEach(wipe);

  const addEndpoint = async (
    opts: {
      tenant?: string;
      channel?: "webhook" | "email";
      url?: string;
      enabled?: boolean;
      secretEnv?: string;
    } = {},
  ): Promise<string> => {
    const tenant = opts.tenant ?? TENANT;
    const channel = opts.channel ?? "webhook";
    const url =
      opts.url ??
      (channel === "email"
        ? `mailto:ops-${Math.random().toString(36).slice(2, 8)}@example.com`
        : `https://hooks.example.com/${Math.random().toString(36).slice(2, 10)}`);
    return await inTenant(tenant, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.notification_endpoint (tenant_id, channel, url, secret_env, enabled)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenant, channel, url, opts.secretEnv ?? SECRET_ENV, opts.enabled ?? true],
      );
      return rows[0]!.id;
    });
  };

  /** Settles a probe the way the runner does, so a second request is legal. */
  const settle = async (probeId: string, outcome: ProbeOutcome, tenant = TENANT): Promise<boolean> =>
    await inTenant(tenant, async (tx) => {
      await claimDueProbes(tx, tenant, new Date(), "test-worker");
      return await recordProbeVerdict(tx, probeId, outcome, new Date());
    });

  const noCooldown = (tenant = TENANT): Promise<number> =>
    inTenant(tenant, (tx) => setProbeCooldownSeconds(tx, tenant, 0));

  /**
   * Waits until `expected` backends are WAITING on 0045's advisory lock.
   *
   * Polled from `pg_locks` rather than slept for, because the assertion the concurrency test
   * makes is about an interleaving and a fixed sleep would assert a duration instead. A
   * blocked `ungranted` advisory lock in classid 45 is the proof that the second transaction
   * reached the guard and stopped there — i.e. that it has NOT yet counted anything — which
   * is the only interleaving in which a lock-free check gives the wrong answer.
   */
  const waitUntilBlocked = async (via: PoolClient, expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { rows } = await via.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 45 AND NOT granted`,
      );
      if ((rows[0]?.n ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the concurrent request never blocked on the probe budget's advisory lock");
  };

  /**
   * Twenty settled probes on one endpoint, two hours old — the only fixture the retention
   * ring's trimming half can be observed against, since 0045 forbids it to delete a row
   * inside the budget window.
   *
   * It has to stand the REQUEST guard down, and that is the fixture admitting what 0034 built
   * on purpose: `requested_at` is overwritten on insert and frozen on update precisely so
   * that no caller can backdate a probe and defeat the cooldown — and now the budget. There
   * is therefore no in-band way to produce an aged row, and pretending otherwise would mean
   * the guard had a hole. The TRIM trigger stays armed throughout, because it is the thing
   * under test. Twenty rather than twenty-one, so the ring has nothing to trim on the way in
   * and the test starts from a state it asserts rather than one it hopes for.
   */
  const ageTwentyProbes = async (endpoint: string): Promise<readonly string[]> => {
    await client.query(
      "ALTER TABLE crm.notification_endpoint_probe DISABLE TRIGGER notification_endpoint_probe_guard",
    );
    try {
      return await inTenant(TENANT, async (tx) => {
        const ids: string[] = [];
        for (let i = 0; i < 20; i += 1) {
          // Ages descend as `seq` ascends, so the newest 20 by `seq` are the newest by clock.
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO crm.notification_endpoint_probe
               (tenant_id, endpoint_id, requested_by, requested_at,
                state, verdict, detail, completed_at)
             VALUES ($1, $2, $3, now() - make_interval(secs => 7200 - $4::int),
                     'complete', 'refused', 'aged fixture', now() - interval '2 hours')
             RETURNING id`,
            [TENANT, endpoint, ADMIN, i],
          );
          ids.push(rows[0]!.id);
        }
        return ids;
      });
    } finally {
      await client.query(
        "ALTER TABLE crm.notification_endpoint_probe ENABLE TRIGGER notification_endpoint_probe_guard",
      );
    }
  };

  // -------------------------------------------------------------------------
  describe("the store, and the rules the database holds", () => {
    it("queues a probe that is requested, unclaimed and unanswered", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(probe.state).toBe("requested");
      expect(probe.attempts).toBe(0);
      expect(probe.verdict).toBeNull();
      expect(probe.detail).toBeNull();
      expect(probe.completed_at).toBeNull();
      // Joined in, because a verdict is unreadable without knowing which channel could
      // even have earned it.
      expect(probe.channel).toBe("webhook");
      expect(probe.requested_by).toBe(ADMIN);
    });

    /**
     * The cooldown's whole guarantee. A caller who could supply `requested_at` could
     * backdate one probe and make the next one legal immediately, so 0034's trigger
     * OVERWRITES it rather than merely defaulting it — asserted through raw SQL, because
     * the store deliberately offers no way to try.
     */
    it("refuses to take the clock from the caller", async () => {
      const endpoint = await addEndpoint();
      const stored = await inTenant(TENANT, async (tx) => {
        const { rows } = await tx.query<{ requested_at: string; age: number }>(
          `INSERT INTO crm.notification_endpoint_probe (tenant_id, endpoint_id, requested_by, requested_at)
           VALUES ($1,$2,$3,'2000-01-01T00:00:00Z')
           RETURNING requested_at::text, extract(epoch FROM now() - requested_at)::float8 AS age`,
          [TENANT, endpoint, ADMIN],
        );
        return rows[0]!;
      });
      expect(stored.requested_at).not.toContain("2000");
      expect(Math.abs(stored.age)).toBeLessThan(5);
    });

    it("refuses a second request while the first is still unanswered", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      await expect(
        inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN })),
      ).rejects.toThrow(ProbeInFlightError);
      const all = await inTenant(TENANT, (tx) => listProbes(tx, endpoint));
      expect(all).toHaveLength(1);
    });

    it("refuses a second request inside the cooldown, and says when it may be retried", async () => {
      const endpoint = await addEndpoint();
      const first = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(await settle(first.id, { verdict: "delivered", detail: "ok" })).toBe(true);

      const err = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProbeCooldownError);
      expect((err as Error).message).toContain("may be probed again after");
      expect((err as Error).message).toContain("probe_cooldown_seconds");
      // The outstanding refusal must not be what fired: the first probe is settled, and
      // the two sentences tell an administrator to do different things.
      expect((err as Error).message).not.toContain("waiting for an answer");
    });

    it("permits a second request once the tenant's cooldown is zero", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      const first = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      await settle(first.id, { verdict: "refused", detail: "no" });
      const second = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(second.id).not.toBe(first.id);
      expect(BigInt(second.seq)).toBeGreaterThan(BigInt(first.seq));
    });

    /** Zero cooldown must still not let a queue form: that is the index's job, not the clock's. */
    it("still refuses an outstanding duplicate with the cooldown disabled", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      await expect(
        inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN })),
      ).rejects.toThrow(ProbeInFlightError);
    });

    it("defaults the cooldown for a tenant that has never had a policy row", async () => {
      expect(await inTenant(TENANT, (tx) => probeCooldownSeconds(tx, TENANT))).toBe(
        DEFAULT_PROBE_COOLDOWN_SECONDS,
      );
    });

    it("refuses a cooldown that is not a whole number of seconds in range", async () => {
      for (const bad of [-1, 1.5, MAX_PROBE_COOLDOWN_SECONDS + 1, Number.NaN]) {
        await expect(inTenant(TENANT, (tx) => setProbeCooldownSeconds(tx, TENANT, bad))).rejects.toThrow(
          InvalidProbeCooldownError,
        );
      }
      expect(await inTenant(TENANT, (tx) => probeCooldownSeconds(tx, TENANT))).toBe(
        DEFAULT_PROBE_COOLDOWN_SECONDS,
      );
    });

    it("stores a cooldown an administrator sets", async () => {
      expect(await inTenant(TENANT, (tx) => setProbeCooldownSeconds(tx, TENANT, 600))).toBe(600);
      expect(await inTenant(TENANT, (tx) => probeCooldownSeconds(tx, TENANT))).toBe(600);
    });
  });

  // -------------------------------------------------------------------------
  /**
   * The tenant's TOTAL probe budget (0045), which is the bound the cooldown deliberately
   * cannot be.
   *
   * ADR-0001 recorded the gap in its own words: the cooldown is per endpoint, which is the
   * right scope, "but endpoints per tenant are uncapped, so three endpoints means three
   * probes back to back inside one cooldown window". So every test below that proves the
   * budget binds does it across DIFFERENT endpoints — the only dimension in which the
   * cooldown has nothing to say, and therefore the only place a new bound can be observed
   * to be new.
   */
  describe("the tenant's total probe budget", () => {
    const setBudget = (maxProbes: number, windowSeconds: number, tenant = TENANT): Promise<ProbeBudgetState> =>
      inTenant(tenant, (tx) => setProbeBudget(tx, tenant, maxProbes, windowSeconds));

    const budget = (tenant = TENANT): Promise<ProbeBudgetState> =>
      inTenant(tenant, (tx) => probeBudget(tx, tenant));

    const probe = (endpoint: string, tenant = TENANT, admin = ADMIN): Promise<ProbeRow> =>
      inTenant(tenant, (tx) => requestProbe(tx, tenant, { endpointId: endpoint, requestedBy: admin }));

    it("defaults the budget for a tenant that has never had a policy row", async () => {
      // The absence of a policy row must read as the defaults rather than as "no budget" —
      // the same fail-closed reading 0034 gives the cooldown. The SQL function LEFT JOINs
      // its configuration off a one-row source precisely so this answers at all.
      expect(await budget()).toEqual({
        used: 0,
        maxProbes: DEFAULT_PROBE_BUDGET_MAX_PROBES,
        windowSeconds: DEFAULT_PROBE_BUDGET_WINDOW_SECONDS,
        nextSlotAt: null,
      });
    });

    it("stores a budget an administrator sets", async () => {
      expect(await setBudget(40, 900)).toMatchObject({ used: 0, maxProbes: 40, windowSeconds: 900 });
      expect(await budget()).toMatchObject({ maxProbes: 40, windowSeconds: 900 });
    });

    /**
     * There is no 0, and that is the deliberate divergence from the cooldown. 0034 lets a
     * tenant disable the cooldown because a cooldown protects a third party and a loopback
     * sink has none; a tenant that has done so has given up its only per-destination bound,
     * so this is the only one left — and a guard disabled by a value does not look like a
     * disabled guard (0026's argument for stopping its share ceiling at 99).
     */
    it("refuses a budget out of range, and refuses 0 in particular", async () => {
      for (const bad of [0, -1, 1.5, MAX_PROBE_BUDGET_MAX_PROBES + 1, Number.NaN]) {
        await expect(
          inTenant(TENANT, (tx) => setProbeBudget(tx, TENANT, bad, DEFAULT_PROBE_BUDGET_WINDOW_SECONDS)),
        ).rejects.toThrow(InvalidProbeBudgetError);
      }
      for (const bad of [0, 59, 1.5, MAX_PROBE_BUDGET_WINDOW_SECONDS + 1, Number.NaN]) {
        await expect(
          inTenant(TENANT, (tx) => setProbeBudget(tx, TENANT, DEFAULT_PROBE_BUDGET_MAX_PROBES, bad)),
        ).rejects.toThrow(InvalidProbeBudgetError);
      }
      expect(await budget()).toMatchObject({
        maxProbes: DEFAULT_PROBE_BUDGET_MAX_PROBES,
        windowSeconds: DEFAULT_PROBE_BUDGET_WINDOW_SECONDS,
      });
    });

    /** The CHECK constraints say the same thing, so a psql prompt gets the same answer. */
    it("declares the same bounds in the database as in the TypeScript", async () => {
      const { rows } = await client.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.notification_policy'::regclass
            AND conname LIKE 'notification_policy_probe_budget%'
          ORDER BY conname`,
      );
      expect(rows.map((r) => r.conname)).toEqual([
        "notification_policy_probe_budget_max",
        "notification_policy_probe_budget_window",
      ]);
      expect(rows[0]!.def).toContain(String(MIN_PROBE_BUDGET_MAX_PROBES));
      expect(rows[0]!.def).toContain(String(MAX_PROBE_BUDGET_MAX_PROBES));
      expect(rows[1]!.def).toContain(String(MIN_PROBE_BUDGET_WINDOW_SECONDS));
      expect(rows[1]!.def).toContain(String(MAX_PROBE_BUDGET_WINDOW_SECONDS));
    });

    it("counts every endpoint's probes against one tenant total", async () => {
      await noCooldown();
      await setBudget(3, 3600);
      const endpoints = [await addEndpoint(), await addEndpoint(), await addEndpoint()];
      for (const endpoint of endpoints) await probe(endpoint);
      expect(await budget()).toMatchObject({ used: 3, maxProbes: 3 });
      // `used` is not a per-endpoint number anywhere: three endpoints, one probe each, and
      // the ceiling is reached. This is the sentence from ADR-0001's open row, as a test.
      const fourth = await addEndpoint();
      await expect(probe(fourth)).rejects.toThrow(ProbeBudgetExceededError);
    });

    it("names the count, the window and the moment a retry becomes legal", async () => {
      await noCooldown();
      await setBudget(1, 3600);
      const first = await probe(await addEndpoint());
      const err = (await probe(await addEndpoint()).catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(ProbeBudgetExceededError);
      // Attributable: the refusal names the tenant it is about, as the cooldown's names the
      // endpoint. And it carries the actionable half.
      expect(err.message).toContain(TENANT);
      expect(err.message).toContain("1 of 1 permitted probes");
      expect(err.message).toContain("3600 seconds");
      expect(err.message).toContain("may probe again after");
      expect(err.message).toContain("probe_budget_max_probes");
      // The sentence names a real moment, not a word: one window after the probe that spent
      // the budget. Rendered by Postgres, so compared by instant rather than by spelling.
      const state = await budget();
      expect(state.nextSlotAt).not.toBeNull();
      expect(Date.parse(state.nextSlotAt!)).toBe(Date.parse(first.requested_at) + 3600 * 1000);
      // And it is NOT the cooldown's refusal wearing a different message: the two endpoints
      // are different, so the cooldown has nothing to say about either.
      expect(err).not.toBeInstanceOf(ProbeCooldownError);
      expect(err.message).not.toContain("probe-cooldown");
    });

    /**
     * The ordering 0045 argues for: per-endpoint beats per-tenant for aim. An administrator
     * repeating ONE endpoint is told to wait for that endpoint, which is what they can act
     * on; the budget's sentence would hide that from them for the whole window. So a caller
     * who is over both limits gets the cooldown, and the budget becomes reachable exactly
     * where the gap was — across endpoints.
     */
    it("lets the cooldown's better-aimed refusal win when both apply", async () => {
      await inTenant(TENANT, (tx) => setProbeCooldownSeconds(tx, TENANT, 120));
      await setBudget(1, 3600);
      const one = await addEndpoint();
      const other = await addEndpoint();
      const first = await probe(one);
      await settle(first.id, { verdict: "delivered", detail: "ok" });

      // Same endpoint, over both limits: the cooldown answers.
      const sameEndpoint = (await probe(one).catch((e: unknown) => e)) as Error;
      expect(sameEndpoint).toBeInstanceOf(ProbeCooldownError);
      expect(sameEndpoint).not.toBeInstanceOf(ProbeBudgetExceededError);

      // A different endpoint, over the budget only: the budget answers.
      const otherEndpoint = (await probe(other).catch((e: unknown) => e)) as Error;
      expect(otherEndpoint).toBeInstanceOf(ProbeBudgetExceededError);
    });

    it("bounds a tenant that has switched its per-endpoint cooldown off", async () => {
      // The configuration with no other bound at all. 0034 permits a 0 cooldown and argues
      // for it; without 0045 a tenant in that state could probe without limit.
      await noCooldown();
      await setBudget(2, 3600);
      const one = await addEndpoint();
      const first = await probe(one);
      await settle(first.id, { verdict: "refused", detail: "no" });
      const second = await probe(one);
      await settle(second.id, { verdict: "refused", detail: "no" });
      await expect(probe(one)).rejects.toThrow(ProbeBudgetExceededError);
      await expect(probe(await addEndpoint())).rejects.toThrow(ProbeBudgetExceededError);
    });

    it("keeps one tenant's spending out of another's budget", async () => {
      await noCooldown();
      await noCooldown(OTHER_TENANT);
      await setBudget(1, 3600);
      await setBudget(1, 3600, OTHER_TENANT);
      await probe(await addEndpoint());
      await expect(probe(await addEndpoint())).rejects.toThrow(ProbeBudgetExceededError);
      // Theirs is untouched: the count is tenant-scoped by the predicate AND by RLS.
      const theirs = await addEndpoint({ tenant: OTHER_TENANT });
      await probe(theirs, OTHER_TENANT, OTHER_ADMIN);
      expect(await budget(OTHER_TENANT)).toMatchObject({ used: 1 });
      expect(await budget()).toMatchObject({ used: 1 });
    });

    /**
     * The case that makes `next_slot_at` an offset rather than a `min()`. A ceiling lowered
     * under a tenant already above it leaves `used > max`, and the oldest row aging out does
     * NOT free a slot — the row that has to go is the one at offset `used - max`. Naming the
     * oldest would promise a retry that still fails, which is the one thing a rate-limit
     * message must not do.
     */
    it("names a moment that actually frees a slot after a ceiling is lowered", async () => {
      await noCooldown();
      await setBudget(3, 3600);
      const endpoint = await addEndpoint();
      for (let i = 0; i < 3; i += 1) {
        const p = await probe(endpoint);
        await settle(p.id, { verdict: "unknown", detail: "n" });
      }

      /**
       * Compared in SQL at full timestamp precision. `ProbeRow.requested_at` is rendered to
       * the millisecond, and three probes in quick succession can share a millisecond while
       * being ordered microseconds apart — which is the very distinction this test turns on.
       * `spread` is asserted too, so the test cannot pass vacuously on a cluster fast enough
       * to give all three the same clock.
       */
      const ask = async (): Promise<{
        matches_newest: boolean;
        matches_oldest: boolean;
        spread: boolean;
      }> =>
        await inTenant(TENANT, async (tx) => {
          const { rows } = await tx.query<{
            matches_newest: boolean;
            matches_oldest: boolean;
            spread: boolean;
          }>(
            `WITH b AS (SELECT * FROM crm.notification_probe_budget($1)),
                  r AS (SELECT min(requested_at) AS oldest, max(requested_at) AS newest
                          FROM crm.notification_endpoint_probe WHERE tenant_id = $1)
             SELECT b.next_slot_at = r.newest + make_interval(secs => b.window_seconds) AS matches_newest,
                    b.next_slot_at = r.oldest + make_interval(secs => b.window_seconds) AS matches_oldest,
                    r.newest > r.oldest AS spread
               FROM b, r`,
            [TENANT],
          );
          return rows[0]!;
        });

      // At the ceiling: the oldest row is the one whose expiry frees a slot.
      expect(await ask()).toEqual({ matches_newest: false, matches_oldest: true, spread: true });

      // Ceiling lowered to 1 with three spent: only the NEWEST aging out gets the count under
      // the ceiling, so `min()` would have promised a retry that still fails.
      await setBudget(1, 3600);
      expect(await ask()).toEqual({ matches_newest: true, matches_oldest: false, spread: true });
      expect(await budget()).toMatchObject({ used: 3, maxProbes: 1 });
    });

    it("reports no next slot while the tenant is under its ceiling", async () => {
      await noCooldown();
      await setBudget(5, 3600);
      await probe(await addEndpoint());
      const state = await budget();
      expect(state).toMatchObject({ used: 1, maxProbes: 5 });
      // Null rather than a moment: a slot is free NOW, and naming a future one would read as
      // a refusal that has not happened.
      expect(state.nextSlotAt).toBeNull();
    });

    /**
     * TWO ADMINISTRATORS PRESSING TEST AT THE SAME MOMENT, with two real overlapping
     * transactions rather than an argument about them.
     *
     * 0034's own header says why a trigger alone is not enough: "a trigger reads rows another
     * transaction has not committed yet". A count has no partial unique index available to it
     * — an index enforces one row per key, not N rows in a moving span — so 0045 serialises
     * the count-then-insert with `pg_advisory_xact_lock` keyed on the tenant.
     *
     * The interleaving below is the one that breaks a lock-free check: B's INSERT STATEMENT
     * BEGINS while A is still uncommitted, so B's own statement snapshot predates A's row. B
     * must nonetheless see it — which it does, because the lock is xact-scoped (so A holds it
     * until the row is visible) and a statement inside a volatile plpgsql function takes a
     * fresh snapshot in READ COMMITTED (so B counts after the wait, not before it).
     *
     * Two endpoints, necessarily: the per-endpoint cooldown and the outstanding index already
     * settle a race on one, and the budget is the first rule here that has to survive a race
     * across two.
     */
    it("refuses the second of two simultaneous requests on different endpoints", async () => {
      await noCooldown();
      await setBudget(1, 3600);
      const mine = await addEndpoint();
      const theirs = await addEndpoint();

      const a = await pool.connect();
      const b = await pool.connect();
      let raced: unknown = null;
      try {
        await a.query("SET ROLE crm_app");
        await b.query("SET ROLE crm_app");
        await a.query("BEGIN");
        await b.query("BEGIN");
        await a.query(SET_TENANT_CONTEXT_SQL, [TENANT]);
        await b.query(SET_TENANT_CONTEXT_SQL, [TENANT]);

        // A spends the only slot and holds its transaction open.
        await requestProbe(a, TENANT, { endpointId: mine, requestedBy: ADMIN });

        // B starts its INSERT while A is uncommitted. It blocks inside the guard, at the
        // advisory lock, BEFORE it has counted anything.
        const bInsert = requestProbe(b, TENANT, { endpointId: theirs, requestedBy: ADMIN }).catch(
          (e: unknown) => {
            raced = e;
          },
        );
        await waitUntilBlocked(a, 1);
        await a.query("COMMIT");
        await bInsert;
        await b.query("ROLLBACK");
      } finally {
        a.release();
        b.release();
      }

      expect(raced).toBeInstanceOf(ProbeBudgetExceededError);
      expect((raced as Error).message).toContain("1 of 1 permitted probes");
      // One probe exists, not two. Without the lock both commit and the tenant sits at 2
      // against a ceiling of 1 — which is the shape of this bug, verified by removing the
      // lock from the guard and re-running this interleaving.
      expect(await budget()).toMatchObject({ used: 1, maxProbes: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("the rest of the store", () => {

    /**
     * A foreign-key check runs with row security DISABLED, so `tenant_id` = mine with
     * `endpoint_id` = yours satisfies both the FK and the RLS policy, which only ever
     * inspects `tenant_id`. 0034's trigger asks `crm.notification_endpoint` under the
     * caller's own RLS and refuses the pair. Without it this INSERT would succeed.
     */
    it("refuses a probe pointed at another tenant's endpoint", async () => {
      const theirs = await addEndpoint({ tenant: OTHER_TENANT });
      await expect(
        inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: theirs, requestedBy: ADMIN })),
      ).rejects.toThrow(EndpointNotFoundError);
      const smuggled = await inTenant(OTHER_TENANT, (tx) => listProbes(tx, theirs));
      expect(smuggled).toEqual([]);
    });

    it("refuses a probe for an endpoint that does not exist", async () => {
      await expect(
        inTenant(TENANT, (tx) =>
          requestProbe(tx, TENANT, {
            endpointId: "df100000-0000-4000-8000-0000000000cc",
            requestedBy: ADMIN,
          }),
        ),
      ).rejects.toThrow(EndpointNotFoundError);
    });

    /**
     * The refusal names the REP, not the endpoint.
     *
     * Reachable only since 0037 made `requested_by` a composite `(tenant_id, id)`
     * reference: before that a rep in another tenant satisfied the foreign key, because a
     * referential check runs with row security disabled. Both of this table's references
     * now raise `23503`, so a translator keyed on the code alone reported a bad requester
     * as a missing ENDPOINT — sending an administrator to look at the endpoint they had
     * just successfully selected.
     */
    it("names the rep, not the endpoint, when the requester is not in this tenant", async () => {
      const endpoint = await addEndpoint();
      const err = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: OTHER_ADMIN }).then(
          () => null,
          (e: unknown) => e as Error,
        ),
      );
      expect(err).toBeInstanceOf(ProbeRequesterNotFoundError);
      expect(err).not.toBeInstanceOf(EndpointNotFoundError);
      expect(err?.message).toMatch(/rep profile asking for this probe/);
      // And the endpoint it names is NOT blamed: the message must not send the reader to it.
      expect(err?.message).not.toContain(endpoint);
    });

    it("hides a probe from every other tenant", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(await inTenant(OTHER_TENANT, (tx) => probeById(tx, probe.id))).toBeNull();
    });

    it("declares exactly the verdicts the database admits", async () => {
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.notification_endpoint_probe'::regclass
            AND conname LIKE '%verdict%'`,
      );
      expect(rows).toHaveLength(1);
      for (const verdict of PROBE_VERDICTS) expect(rows[0]!.def).toContain(`'${verdict}'`);
      // And nothing the TypeScript does not know about, which is the direction that would
      // otherwise let a migration widen the column and leave a reader with a verdict it
      // cannot render.
      const quoted = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect([...new Set(quoted)].sort()).toEqual([...PROBE_VERDICTS].sort());
    });

    it("declares exactly the states the database admits", async () => {
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.notification_endpoint_probe'::regclass
            AND conname LIKE '%_state_%'`,
      );
      expect(rows).toHaveLength(1);
      const quoted = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect([...new Set(quoted)].sort()).toEqual([...PROBE_STATES].sort());
    });

    /**
     * The 0021 trap, closed structurally. `crm.notification_delivery` cascades from
     * `crm.notification`, which is why ADR-0001 records that delivery history cannot
     * outlive the notification it describes. A probe has no notification and must never
     * acquire one.
     */
    it("depends on the endpoint and on no notification at all", async () => {
      const { rows } = await client.query<{ target: string; action: string }>(
        `SELECT confrelid::regclass::text AS target, confdeltype AS action
           FROM pg_constraint
          WHERE conrelid = 'crm.notification_endpoint_probe'::regclass AND contype = 'f'
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.target).sort()).toEqual(["crm.notification_endpoint", "crm.rep_profile"]);
      expect(rows.find((r) => r.target === "crm.notification_endpoint")!.action).toBe("c");
      expect(rows.map((r) => r.target)).not.toContain("crm.notification");
    });

    it("takes its probes with the endpoint when the endpoint is deleted", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      await inTenant(TENANT, async (tx) => {
        await tx.query("DELETE FROM crm.notification_endpoint WHERE id = $1", [endpoint]);
      });
      expect(await inTenant(TENANT, (tx) => probeById(tx, probe.id))).toBeNull();
    });

    it("claims a probe, counts the claim, and names the worker holding it", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      const claimed = await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, new Date(), "worker-7"));
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attempts).toBe(1);
      expect(claimed[0]!.channel).toBe("webhook");
      expect(claimed[0]!.secret_env).toBe(SECRET_ENV);
      expect(claimed[0]!.enabled).toBe(true);
      // Read back inside the tenant context: the bare client sees nothing, which is RLS
      // working and not a missing row.
      const held = await inTenant(TENANT, async (tx) => {
        const { rows } = await tx.query<{ claimed_by: string; state: string }>(
          "SELECT claimed_by, state FROM crm.notification_endpoint_probe WHERE id = $1",
          [claimed[0]!.id],
        );
        return rows[0];
      });
      expect(held).toEqual({ claimed_by: "worker-7", state: "in_flight" });
    });

    it("does not claim a probe another pass is still holding", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      const now = new Date();
      expect(await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, now, "a"))).toHaveLength(1);
      expect(await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, now, "b"))).toHaveLength(0);
    });

    /** The only reason an `in_flight` row exists is a process that died holding it. */
    it("re-claims a probe whose lease has run out, and abandons it at the ceiling", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      const start = Date.now();
      for (let i = 1; i <= MAX_PROBE_ATTEMPTS + 1; i += 1) {
        const at = new Date(start + i * 120_000);
        const claimed = await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, at, `w${String(i)}`));
        expect(claimed, `claim ${String(i)}`).toHaveLength(1);
        expect(claimed[0]!.attempts).toBe(i);
      }
    });

    it("never claims an answered probe", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      await settle(probe.id, { verdict: "delivered", detail: "ok", status: 200 });
      expect(
        await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, new Date(Date.now() + 86_400_000), "later")),
      ).toHaveLength(0);
    });

    it("does not claim another tenant's probes", async () => {
      const theirs = await addEndpoint({ tenant: OTHER_TENANT });
      await inTenant(OTHER_TENANT, (tx) =>
        requestProbe(tx, OTHER_TENANT, { endpointId: theirs, requestedBy: OTHER_ADMIN }),
      );
      expect(await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, new Date(), "w"))).toHaveLength(0);
      expect(await inTenant(OTHER_TENANT, (tx) => claimDueProbes(tx, OTHER_TENANT, new Date(), "w"))).toHaveLength(1);
    });

    it("answers once, and reports a second settlement as somebody else's", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(await settle(probe.id, { verdict: "refused", detail: "secret missing", status: 401 })).toBe(true);
      const second = await inTenant(TENANT, (tx) =>
        recordProbeVerdict(tx, probe.id, { verdict: "delivered", detail: "actually fine" }, new Date()),
      );
      expect(second).toBe(false);
      const stored = await inTenant(TENANT, (tx) => probeById(tx, probe.id));
      expect(stored!.verdict).toBe("refused");
      expect(stored!.status).toBe(401);
    });

    /** Even a hand-written UPDATE cannot rewrite an answer an administrator has read. */
    it("refuses a direct UPDATE of a settled probe", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      await settle(probe.id, { verdict: "refused", detail: "no" });
      await expect(
        inTenant(TENANT, async (tx) => {
          await tx.query("UPDATE crm.notification_endpoint_probe SET verdict = 'delivered' WHERE id = $1", [
            probe.id,
          ]);
        }),
      ).rejects.toThrow(/probe-settled/);
    });

    it("refuses an UPDATE that repoints a probe at a different endpoint", async () => {
      const a = await addEndpoint();
      const b = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: a, requestedBy: ADMIN }));
      await expect(
        inTenant(TENANT, async (tx) => {
          await tx.query("UPDATE crm.notification_endpoint_probe SET endpoint_id = $2 WHERE id = $1", [probe.id, b]);
        }),
      ).rejects.toThrow(/probe-immutable/);
    });

    /** `detail` is NOT NULL-ish by CHECK; an empty one would abort the settlement. */
    it("still records a sentence when a verdict arrives with nothing to say", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      expect(await settle(probe.id, { verdict: "unknown", detail: "   " })).toBe(true);
      const stored = await inTenant(TENANT, (tx) => probeById(tx, probe.id));
      expect(stored!.detail).toBe("unknown, with no detail reported");
    });

    /**
     * `now()` is the TRANSACTION timestamp: these two probes share `requested_at` to the
     * microsecond, so an ordering by it would return whichever the planner liked. This is
     * the tie 0027 proved on `crm.outbox` and the reason 0034 was born with a `seq`.
     */
    it("orders two probes written in one transaction by seq, not by their identical clock", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      const { first, second } = await inTenant(TENANT, async (tx) => {
        const a = await requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN });
        await claimDueProbes(tx, TENANT, new Date(), "w");
        await recordProbeVerdict(tx, a.id, { verdict: "refused", detail: "first" }, new Date());
        const b = await requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN });
        return { first: a, second: b };
      });
      expect(second.requested_at).toBe(first.requested_at);
      const newest = await inTenant(TENANT, (tx) => latestProbe(tx, endpoint));
      expect(newest!.id).toBe(second.id);
      const history = await inTenant(TENANT, (tx) => listProbes(tx, endpoint));
      expect(history.map((p) => p.id)).toEqual([second.id, first.id]);
    });

    /**
     * 0045 CHANGED THIS GUARANTEE, from "exactly the newest 20" to "AT LEAST the newest 20".
     *
     * The budget counts rows in this table inside a window, and 0034's ring deleted rows in
     * that window — so the ring was handing budget back: a 21st probe on one endpoint
     * deleted the 1st, the count stalled at 21, and with the cooldown at 0 (which 0034
     * permits) a single endpoint could emit unbounded probes an hour while never retaining
     * more than 21 rows. A bound computed from rows cannot also be the reason those rows are
     * deleted, and retention is the half with no safety argument behind its exact number.
     *
     * So the ring keeps the newest 20 complete AND anything inside the budget window. That
     * is strictly MORE retention than 0034 promised and never less, so nothing anybody read
     * has disappeared. The next test is the one that proves it still trims.
     */
    it("keeps everything inside the budget window, because the budget is counting it", async () => {
      const endpoint = await addEndpoint();
      const other = await addEndpoint();
      await noCooldown();
      const ids: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        const probe = await inTenant(TENANT, (tx) =>
          requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
        );
        ids.push(probe.id);
        await settle(probe.id, { verdict: "refused", detail: `attempt ${String(i)}` });
      }
      const keepers = await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100));
      expect(keepers).toHaveLength(24);
      expect(keepers.map((p) => p.id)).toEqual([...ids].reverse());
      // And the budget agrees it is counting all 24, which is the reason they are still here.
      expect(await inTenant(TENANT, (tx) => probeBudget(tx, TENANT))).toMatchObject({ used: 24 });

      // Per endpoint: a debugging session on one endpoint must not evict another's history.
      const kept = await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: other, requestedBy: ADMIN }));
      expect(await inTenant(TENANT, (tx) => listProbes(tx, other))).toHaveLength(1);
      expect(kept.endpoint_id).toBe(other);
    });

    /**
     * The ring, on rows the budget has stopped counting — which is the only state in which
     * it may now delete anything.
     *
     * The fixture has to be AGED, and 0034 made that deliberately impossible for a caller:
     * `requested_at` is overwritten by the request guard and frozen by the settle guard,
     * precisely so nobody can backdate a probe and defeat the cooldown (and now the budget).
     * The only honest way to build an aged row is therefore to stand the guard down for the
     * length of the fixture, as the table's owner, and say so — which is what this does. The
     * trim trigger is left ARMED throughout, because it is the thing under test.
     */
    it("trims past the newest 20 once the budget has stopped counting them", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      const aged = await ageTwentyProbes(endpoint);
      // Two hours old against the default one-hour window: the budget is counting none of
      // them, so the ring's window clause protects none of them.
      expect(await inTenant(TENANT, (tx) => probeBudget(tx, TENANT))).toMatchObject({ used: 0 });
      expect(await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100))).toHaveLength(20);

      const live = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      const after = await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100));
      expect(after).toHaveLength(20);
      expect(after.map((p) => p.id)).toEqual([live.id, ...[...aged].reverse().slice(0, 19)]);
      // The one that fell out is the oldest, which is the ring doing exactly what 0034 said.
      expect(after.map((p) => p.id)).not.toContain(aged[0]);
    });

    /**
     * The other half, and the reason 0045 touches the ring at all: the same insert, with the
     * window widened so the budget IS counting the aged rows, trims nothing. Without the
     * window clause the row the budget is counting would be deleted and the slot refunded.
     */
    it("will not trim a row the budget is still counting", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      const aged = await ageTwentyProbes(endpoint);
      await inTenant(TENANT, (tx) => setProbeBudget(tx, TENANT, 120, MAX_PROBE_BUDGET_WINDOW_SECONDS));
      expect(await inTenant(TENANT, (tx) => probeBudget(tx, TENANT))).toMatchObject({ used: 20 });

      const live = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      const after = await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100));
      expect(after).toHaveLength(21);
      expect(after.map((p) => p.id)).toEqual([live.id, ...[...aged].reverse()]);
      expect(await inTenant(TENANT, (tx) => probeBudget(tx, TENANT))).toMatchObject({ used: 21 });
    });

    /**
     * The count here is 21 rather than 0034's 20 for the reason the window test above gives:
     * all 21 are inside the budget window, so the ring may delete none of them. What the
     * test is actually for is unchanged — an outstanding probe has no answer to keep and
     * deleting it would silently cancel a request somebody is waiting on — and both of its
     * load-bearing assertions are untouched.
     *
     * Worth recording while changing it: this test could never have caught the
     * `state = 'complete'` clause going missing, before 0045 or after. An outstanding probe
     * is always the NEWEST row for its endpoint (the partial unique index admits only one),
     * so it is always inside the newest-20 keep set and never a trim candidate by `seq`
     * either way. The clause is right and nothing here would notice if it were deleted.
     */
    it("never trims a probe that is still waiting for an answer", async () => {
      const endpoint = await addEndpoint();
      await noCooldown();
      for (let i = 0; i < 21; i += 1) {
        const probe = await inTenant(TENANT, (tx) =>
          requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
        );
        if (i < 20) await settle(probe.id, { verdict: "unknown", detail: "n" });
      }
      const history = await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100));
      expect(history).toHaveLength(21);
      expect(history[0]!.state).toBe("requested");
      expect(history.filter((p) => p.state !== "complete")).toHaveLength(1);
    });

    it("caps the history a caller may ask for", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      expect(await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 100_000))).toHaveLength(1);
      expect(await inTenant(TENANT, (tx) => listProbes(tx, endpoint, 0))).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("the webhook prober, against a real HTTP server", () => {
    interface Received {
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
      readonly body: string;
    }

    const withServer = async <T>(
      handler: (received: Received) => { status: number; body?: string },
      fn: (url: string, received: readonly Received[]) => Promise<T>,
    ): Promise<T> => {
      const received: Received[] = [];
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const entry = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
          received.push(entry);
          const out = handler(entry);
          res.writeHead(out.status, { "content-type": "text/plain" });
          res.end(out.body ?? "");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        return await fn(`http://127.0.0.1:${String(port)}/hook`, received);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };

    const prober = (env: Readonly<Record<string, string | undefined>> = { [SECRET_ENV]: SECRET }): WebhookProber =>
      new WebhookProber({
        fetch: globalThis.fetch as unknown as FetchLike,
        env,
        timeoutMs: 5_000,
      });

    const target = (url: string): ProbeTarget => ({
      probeId: "df100000-0000-4000-8000-0000000000d1",
      tenantId: TENANT,
      endpointId: "df100000-0000-4000-8000-0000000000d2",
      channel: "webhook",
      url,
      secretEnv: SECRET_ENV,
      requestedAt: "2027-01-15T09:00:00.000Z",
    });

    /**
     * The strongest verdict in the table, and it has to be earned: the handler VERIFIES
     * the signature over the bytes that arrived, using the same `verifyWebhook` a receiver
     * would, so a 2xx here means the secret, the HMAC and the path all worked.
     */
    it("earns `delivered` from a receiver that verified the signature", async () => {
      const outcome = await withServer(
        (req) => {
          const signature = req.headers["x-crm-signature"];
          const timestamp = req.headers["x-crm-timestamp"];
          const ok =
            typeof signature === "string" &&
            typeof timestamp === "string" &&
            verifyWebhook(SECRET, Number(timestamp), req.body, signature);
          return { status: ok ? 204 : 401, body: ok ? "" : "bad signature" };
        },
        async (url, received) => {
          const result = await prober().probe(target(url));
          expect(received).toHaveLength(1);
          expect(received[0]!.headers["x-crm-event"]).toBe(PROBE_EVENT);
          expect(received[0]!.headers["x-crm-delivery"]).toBe("df100000-0000-4000-8000-0000000000d1");
          return result;
        },
      );
      expect(outcome.verdict).toBe("delivered");
      expect(outcome.status).toBe(204);
      expect(outcome.detail).toContain("the secret in CRM_PROBE_SECRET signed it");
    });

    /**
     * A probe goes to a URL that may be wrong, so the envelope must carry nobody's name.
     * And it must not read as a notification: a receiver switching on the event finds a
     * value that is not a `NotificationKind`, and one parsing the body finds no `kind`,
     * `subject` or `recipient` to misinterpret.
     */
    it("sends an envelope that says what it is and names no person, account or lot", async () => {
      const body = probeBody(target("https://x.example.com/h"));
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed["event"]).toBe(PROBE_EVENT);
      expect(NOTIFICATION_KINDS as readonly string[]).not.toContain(PROBE_EVENT);
      expect(Object.keys(parsed).sort()).toEqual(
        ["endpointId", "event", "note", "probeId", "requestedAt", "tenantId"].sort(),
      );
      expect(String(parsed["note"])).toContain("not a notification");
      for (const leak of ["recipient", "subject", "kind", "severity", "displayName", "lot"]) {
        expect(body).not.toContain(leak);
      }
    });

    it("refuses before sending anything when the named variable is unset", async () => {
      const outcome = await withServer(
        () => ({ status: 200 }),
        async (url, received) => {
          const result = await prober({}).probe(target(url));
          // The point: nothing crossed the network. A probe that connected first and then
          // noticed would have told a receiver about a misconfiguration of ours.
          expect(received).toEqual([]);
          return result;
        },
      );
      expect(outcome.verdict).toBe("refused");
      expect(outcome.detail).toContain("CRM_PROBE_SECRET is not set in this process");
      expect(outcome.detail).toContain("Nothing was sent");
    });

    it("refuses on an empty-string variable, which is a secret nobody set", async () => {
      const outcome = await withServer(
        () => ({ status: 200 }),
        (url) => prober({ [SECRET_ENV]: "" }).probe(target(url)),
      );
      expect(outcome.verdict).toBe("refused");
    });

    it("earns `refused` from a 4xx, which will say the same thing next time", async () => {
      const outcome = await withServer(
        () => ({ status: 403, body: "nope" }),
        (url) => prober().probe(target(url)),
      );
      expect(outcome.verdict).toBe("refused");
      expect(outcome.status).toBe(403);
      expect(outcome.detail).toContain("403");
    });

    /** Fail closed: a 503 is not evidence of anything about the configuration. */
    it("earns `unknown` from a 5xx and from a 429, never `refused`", async () => {
      for (const status of [503, 429]) {
        const outcome = await withServer(
          () => ({ status, body: "later" }),
          (url) => prober().probe(target(url)),
        );
        expect(outcome.verdict, `status ${String(status)}`).toBe("unknown");
        expect(outcome.status).toBe(status);
      }
    });

    it("earns `unknown` when nothing is listening", async () => {
      const dead = await withServer(
        () => ({ status: 200 }),
        (url) => Promise.resolve(url),
      );
      const outcome = await prober().probe(target(dead));
      expect(outcome.verdict).toBe("unknown");
      expect(outcome.detail).toContain("did not complete");
      expect(outcome.detail).toContain("Nothing was proven either way");
    });
  });

  // -------------------------------------------------------------------------
  describe("the email prober, against a real SMTP server", () => {
    const CERT = selfSignedCert();
    const TLS = CERT === null ? {} : { tls: CERT };
    let sink: SmtpSink | null = null;

    afterEach(async () => {
      await sink?.close();
      sink = null;
    });

    const open = async (opts: SmtpSinkOptions = {}): Promise<SmtpSink> => {
      sink = await startSmtpSink(opts);
      return sink;
    };

    const probeVia = async (
      live: SmtpSink,
      over: {
        readonly relay?: Partial<SmtpRelayConfig>;
        readonly transport?: SmtpTransport;
        readonly env?: Readonly<Record<string, string | undefined>>;
        readonly url?: string;
      } = {},
    ): Promise<ProbeOutcome> => {
      const p = new SmtpProber({
        relay: {
          host: "127.0.0.1",
          port: live.port,
          from: "crm@crm.example",
          transport: over.transport ?? "plaintext",
          ...over.relay,
        },
        env: over.env ?? {},
        timeoutMs: 5_000,
        // Self-signed, so trusted as a CA rather than by switching verification off: a
        // test that disabled it would prove nothing about the handshake.
        ...(CERT === null ? {} : { tlsOptions: { ca: [CERT.cert] } }),
      });
      return await p.probe({
        probeId: "df100000-0000-4000-8000-0000000000d3",
        tenantId: TENANT,
        endpointId: "df100000-0000-4000-8000-0000000000d4",
        channel: "email",
        url: over.url ?? "mailto:ops@example.com",
        secretEnv: SECRET_ENV,
        requestedAt: "2027-01-15T09:00:00.000Z",
      });
    };

    /**
     * The claim `reachable` makes, and the one thing a mock could not have checked: the
     * envelope was accepted and NO MESSAGE EXISTS. The sink records every message it
     * received, so an empty list is the proof.
     */
    it("earns `reachable` by accepting the envelope and then throwing it away", async () => {
      const live = await open({ advertiseAuth: ["PLAIN"], requireAuth: true, credentials: { username: "u", password: SECRET } });
      const outcome = await probeVia(live, { relay: { username: "u" }, env: { [SECRET_ENV]: SECRET } });

      expect(outcome.verdict).toBe("reachable");
      expect(outcome.status).toBe(250);
      expect(outcome.detail).toContain("NO message was delivered");
      expect(outcome.detail).toContain("AUTH PLAIN succeeded as u");

      expect(live.messages).toEqual([]);
      expect(live.transcript.filter((l) => l.toUpperCase().startsWith("DATA"))).toEqual([]);
      expect(live.transcript).toContain("MAIL FROM:<crm@crm.example>");
      expect(live.transcript).toContain("RCPT TO:<ops@example.com>");
      // RSET before QUIT, so the relay's own log says the transaction was abandoned
      // deliberately rather than merely stopping.
      expect(live.transcript).toContain("RSET");
      expect(live.transcript.at(-1)).toBe("QUIT");
    });

    it("earns `reachable` with no AUTH at all when the relay wants none", async () => {
      const live = await open();
      const outcome = await probeVia(live);
      expect(outcome.verdict).toBe("reachable");
      expect(outcome.detail).toContain("no AUTH was attempted");
      expect(live.transcript.filter((l) => l.startsWith("AUTH"))).toEqual([]);
      expect(live.messages).toEqual([]);
    });

    it("earns `refused` when the relay rejects the credentials", async () => {
      const live = await open({
        advertiseAuth: ["PLAIN"],
        credentials: { username: "u", password: "right" },
        failAt: { stage: "auth", code: 535, text: "5.7.8 Authentication credentials invalid" },
      });
      const outcome = await probeVia(live, { relay: { username: "u" }, env: { [SECRET_ENV]: "wrong" } });
      expect(outcome.verdict).toBe("refused");
      expect(outcome.status).toBe(535);
      expect(outcome.detail).toContain("at auth");
    });

    it("earns `refused` from a 5xx on the mailbox, which is the answer an administrator wanted", async () => {
      const live = await open({ failAt: { stage: "rcpt_to", code: 550, text: "5.1.1 No such user" } });
      const outcome = await probeVia(live);
      expect(outcome.verdict).toBe("refused");
      expect(outcome.status).toBe(550);
      expect(outcome.detail).toContain("rcpt_to");
    });

    /** A 4xx is transient in SMTP — a greylist, most often — and proves nothing. */
    it("earns `unknown` from a 4xx, not `refused`", async () => {
      const live = await open({ failAt: { stage: "rcpt_to", code: 451, text: "4.7.1 Greylisted" } });
      const outcome = await probeVia(live);
      expect(outcome.verdict).toBe("unknown");
      expect(outcome.status).toBe(451);
    });

    it("refuses without opening a socket when the password variable is unset", async () => {
      const live = await open({ advertiseAuth: ["PLAIN"], credentials: { username: "u", password: SECRET } });
      const outcome = await probeVia(live, { relay: { username: "u" }, env: {} });
      expect(outcome.verdict).toBe("refused");
      expect(outcome.detail).toContain("CRM_PROBE_SECRET is not set in this process");
      expect(outcome.detail).toContain("Nothing was connected to");
      expect(live.transcript).toEqual([]);
    });

    it("earns `refused` from a relay that will not offer STARTTLS", async () => {
      const live = await open({ advertiseStartTls: false });
      const outcome = await probeVia(live, { transport: "starttls" });
      expect(outcome.verdict).toBe("refused");
      expect(outcome.detail).toContain("does not offer STARTTLS");
      expect(live.messages).toEqual([]);
    });

    it.skipIf(CERT === null)("holds the conversation over a verified STARTTLS upgrade", async () => {
      const live = await open({ advertiseStartTls: true, advertiseAuth: ["LOGIN"], ...TLS });
      const outcome = await probeVia(live, {
        transport: "starttls",
        relay: { username: "u" },
        env: { [SECRET_ENV]: SECRET },
      });
      expect(outcome.verdict).toBe("reachable");
      expect(outcome.detail).toContain("AUTH LOGIN succeeded as u");
      expect(live.transcript).toContain("STARTTLS");
      // Two EHLOs: RFC 3207 discards everything learned in the clear.
      expect(live.transcript.filter((l) => l.startsWith("EHLO"))).toHaveLength(2);
      expect(live.messages).toEqual([]);
    });

    it("earns `unknown` when the relay is not there", async () => {
      const live = await open();
      const port = live.port;
      await live.close();
      sink = null;
      const p = new SmtpProber({
        relay: { host: "127.0.0.1", port, from: "crm@crm.example", transport: "plaintext" },
        env: {},
        timeoutMs: 2_000,
      });
      const outcome = await p.probe({
        probeId: "p",
        tenantId: TENANT,
        endpointId: "e",
        channel: "email",
        url: "mailto:ops@example.com",
        requestedAt: "2027-01-15T09:00:00.000Z",
        secretEnv: SECRET_ENV,
      });
      expect(outcome.verdict).toBe("unknown");
      expect(outcome.detail).toContain("Nothing was proven either way");
    });

    it("earns `refused` from a url that is not one mailbox", async () => {
      const live = await open();
      const outcome = await probeVia(live, { url: "mailto:a@example.com,b@example.com" });
      expect(outcome.verdict).toBe("refused");
      expect(outcome.detail).toContain("more than one mailbox");
      expect(live.transcript).toEqual([]);
    });

    /**
     * The same refusal `SmtpSender`'s constructor makes, and it matters more here: a probe
     * AUTHENTICATES, so a plaintext relay to a remote host would carry the password across
     * the network in clear text to find out whether it was right.
     */
    it("refuses at construction to probe a remote relay in clear text", () => {
      expect(
        () =>
          new SmtpProber({
            relay: { host: "mail.example.com", port: 25, from: "crm@crm.example", transport: "plaintext" },
          }),
      ).toThrow(InvalidSmtpRelayError);
      expect(
        () => new SmtpProber({ relay: { host: "127.0.0.1", port: 0, from: "crm@crm.example" } }),
      ).toThrow(InvalidSmtpRelayError);
      expect(
        () => new SmtpProber({ relay: { host: "127.0.0.1", port: 25, from: "not-a-mailbox" } }),
      ).toThrow(InvalidSmtpRelayError);
    });

    /**
     * The refusals are ONE function (`assertUsableRelay`), asserted from both sides.
     *
     * They were two copies, and the plaintext one is the copy that mattered: a send over
     * plaintext to a remote host puts a rep's name and an account id on the wire, and a
     * probe AUTHENTICATES, so it puts the password there too — in clear text, purely to
     * find out whether it was right. A prober that had kept the weaker of two drifting
     * copies would have been the more dangerous half. The last row is the control: a
     * relay both must ACCEPT, so the loop could fail rather than passing on a refusal of
     * everything.
     */
    it("refuses exactly what the sender refuses, because it is the same function", () => {
      const cases: readonly (readonly [string, SmtpRelayConfig, boolean])[] = [
        ["plaintext to a remote host", { host: "mail.example.com", port: 25, from: "crm@crm.example", transport: "plaintext" }, false],
        ["a From that is not a mailbox", { host: "127.0.0.1", port: 25, from: "not-a-mailbox" }, false],
        ["a port that is not a port", { host: "127.0.0.1", port: 0, from: "crm@crm.example" }, false],
        ["a port above the range", { host: "127.0.0.1", port: 70_000, from: "crm@crm.example" }, false],
        ["starttls to a remote host", { host: "mail.example.com", port: 587, from: "crm@crm.example" }, true],
      ];
      for (const [name, relay, acceptable] of cases) {
        const sender = ((): unknown => {
          try {
            return new SmtpSender({ relay });
          } catch (err) {
            return err;
          }
        })();
        const prober = ((): unknown => {
          try {
            return new SmtpProber({ relay });
          } catch (err) {
            return err;
          }
        })();
        expect(sender instanceof InvalidSmtpRelayError, `sender: ${name}`).toBe(!acceptable);
        expect(prober instanceof InvalidSmtpRelayError, `prober: ${name}`).toBe(!acceptable);
        if (!acceptable) {
          expect((prober as Error).message, name).toBe((sender as Error).message);
        }
      }
    });

    /**
     * The probe opens its socket through the sender's own `connect`, so it cannot miss the
     * fix the sender got: `open()` raced a timer against `connect` and on a timeout
     * rejected WITHOUT destroying the socket, leaking one descriptor per attempt in a
     * scheduler that retries a down relay every tick, and keeping the event loop alive.
     * That mattered more for the prober than for the sender, because a probe is triggered
     * by an administrator clicking a button.
     *
     * Measured the same way `smtp.contract.test.ts` measures it — `destroyed !== true`,
     * because a destroyed socket lingers in `_getActiveHandles()` until its close is
     * processed and does not hold the loop — and asserted as "does not GROW", which is the
     * shape of the leak.
     */
    it("tears its socket down on a connect that never completes, and does not leak one per attempt", async () => {
      const liveSockets = (): number =>
        (
          process as unknown as {
            _getActiveHandles: () => readonly { constructor: { name: string }; destroyed?: boolean }[];
          }
        )
          ._getActiveHandles()
          .filter((h) => /Socket$/.test(h.constructor.name) && h.destroyed !== true).length;

      // Routable-looking and unreachable, so the connect HANGS rather than being refused:
      // a refused connect closes its own socket and would prove nothing.
      const p = new SmtpProber({
        relay: { host: "10.255.255.1", port: 25, from: "crm@crm.example" },
        env: {},
        timeoutMs: 200,
      });
      const before = liveSockets();
      for (let i = 0; i < 3; i += 1) {
        const outcome = await p.probe({
          probeId: "df100000-0000-4000-8000-0000000000d5",
          tenantId: TENANT,
          endpointId: "df100000-0000-4000-8000-0000000000d6",
          channel: "email",
          url: "mailto:ops@example.com",
          secretEnv: SECRET_ENV,
          requestedAt: "2027-01-15T09:00:00.000Z",
        });
        expect(outcome.verdict, `attempt ${String(i + 1)}`).toBe("unknown");
        expect(outcome.detail).toContain("could not connect to 10.255.255.1:25 within 200ms");
        expect(liveSockets(), `attempt ${String(i + 1)}`).toBe(before);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("the runner, which is the scheduler's half", () => {
    const fakeProber = (channel: string, outcome: ProbeOutcome): ChannelProber => ({
      channel,
      probe: (): Promise<ProbeOutcome> => Promise.resolve(outcome),
    });

    const runner = (probers: readonly ChannelProber[]): EndpointProbeRunner =>
      new EndpointProbeRunner({ pool, probers, workerId: "runner-test" });

    it("claims, probes and settles in one pass", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      const result = await runner([
        fakeProber("webhook", { verdict: "delivered", detail: "accepted with 204", status: 204 }),
      ]).runTenant(TENANT);

      expect(result).toEqual({
        claimed: 1,
        abandoned: 0,
        byVerdict: { delivered: 1, reachable: 0, refused: 0, unknown: 0 },
      });
      const stored = await inTenant(TENANT, (tx) => probeById(tx, probe.id));
      expect(stored!.state).toBe("complete");
      expect(stored!.verdict).toBe("delivered");
      expect(stored!.status).toBe(204);
    });

    /**
     * The gap this whole increment exists for, from the other side: a process with no
     * prober for the channel says so in `dispatch.ts`'s voice, so an operator meeting both
     * messages meets one fault — and can tell "wrong binary" from "wrong endpoint".
     */
    it("answers `unknown` for a channel it has no prober for, naming what it does probe", async () => {
      const endpoint = await addEndpoint({ channel: "email" });
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      const result = await runner([fakeProber("webhook", { verdict: "delivered", detail: "x" })]).runTenant(TENANT);
      expect(result.byVerdict.unknown).toBe(1);
      const stored = await inTenant(TENANT, (tx) => probeById(tx, probe.id));
      expect(stored!.verdict).toBe("unknown");
      expect(stored!.detail).toContain("no prober registered for channel email in this process");
      expect(stored!.detail).toContain("it probes webhook");
    });

    it("says `none` when it registers no prober at all", async () => {
      const endpoint = await addEndpoint();
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      await runner([]).runTenant(TENANT);
      const stored = await inTenant(TENANT, (tx) => latestProbe(tx, endpoint));
      expect(stored!.detail).toContain("it probes none");
    });

    /** A `delivered` verdict on a disabled endpoint is true and misleading on its own. */
    it("says so when the endpoint it just proved is disabled", async () => {
      const endpoint = await addEndpoint({ enabled: false });
      await inTenant(TENANT, (tx) => requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }));
      await runner([fakeProber("webhook", { verdict: "delivered", detail: "accepted with 200" })]).runTenant(TENANT);
      const stored = await inTenant(TENANT, (tx) => latestProbe(tx, endpoint));
      expect(stored!.verdict).toBe("delivered");
      expect(stored!.detail).toContain("this endpoint is disabled, so no notification is routed to it");
    });

    it("abandons a probe nothing ever settled, as `unknown` and never as fine", async () => {
      const endpoint = await addEndpoint();
      const probe = await inTenant(TENANT, (tx) =>
        requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
      );
      // Claim it MAX_PROBE_ATTEMPTS times and never settle, as a process dying would.
      const start = Date.now();
      for (let i = 1; i <= MAX_PROBE_ATTEMPTS; i += 1) {
        await inTenant(TENANT, (tx) => claimDueProbes(tx, TENANT, new Date(start + i * 120_000), `dead-${String(i)}`));
      }
      const result = await new EndpointProbeRunner({
        pool,
        probers: [fakeProber("webhook", { verdict: "delivered", detail: "would have been fine" })],
        workerId: "runner-test",
        now: () => new Date(start + 600_000),
      }).runTenant(TENANT);

      expect(result.abandoned).toBe(1);
      expect(result.byVerdict.unknown).toBe(1);
      const stored = await inTenant(TENANT, (tx) => probeById(tx, probe.id));
      expect(stored!.verdict).toBe("unknown");
      expect(stored!.detail).toContain("never answered");
      expect(stored!.detail).toContain("nothing is known");
    });

    it("does nothing, cheaply, when no probe is queued", async () => {
      await addEndpoint();
      expect(await runner([fakeProber("webhook", { verdict: "delivered", detail: "x" })]).runTenant(TENANT)).toEqual({
        claimed: 0,
        abandoned: 0,
        byVerdict: { delivered: 0, reachable: 0, refused: 0, unknown: 0 },
      });
    });

    it("leaves another tenant's queue alone", async () => {
      const theirs = await addEndpoint({ tenant: OTHER_TENANT });
      const probe = await inTenant(OTHER_TENANT, (tx) =>
        requestProbe(tx, OTHER_TENANT, { endpointId: theirs, requestedBy: OTHER_ADMIN }),
      );
      await runner([fakeProber("webhook", { verdict: "delivered", detail: "x" })]).runTenant(TENANT);
      expect((await inTenant(OTHER_TENANT, (tx) => probeById(tx, probe.id)))!.state).toBe("requested");
    });

    it("returns its client to the pool on every pass", async () => {
      for (let i = 0; i < 12; i += 1) {
        await runner([]).runTenant(TENANT);
      }
      expect(pool.idleCount).toBeGreaterThan(0);
    });

    /**
     * The whole path, once, with nothing faked: an administrator's request in the
     * database, the runner the scheduler will call, the real `WebhookProber`, a real HTTP
     * receiver that VERIFIES the signature, and the verdict read back the way the API will
     * read it.
     *
     * Every other test here exercises one joint. This one exists because the joints are
     * where a feature that passes its own tests still does not work — the endpoint's
     * `secret_env`, read from the scheduler's environment and used to sign bytes a third
     * party checks, crosses three of them.
     */
    it("carries a request through the real prober to a verdict the API can read", async () => {
      const received: string[] = [];
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const signature = req.headers["x-crm-signature"];
          const timestamp = req.headers["x-crm-timestamp"];
          const ok =
            typeof signature === "string" &&
            typeof timestamp === "string" &&
            verifyWebhook(SECRET, Number(timestamp), body, signature);
          if (ok) received.push(body);
          res.writeHead(ok ? 202 : 401).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      try {
        const endpoint = await addEndpoint({ url: `http://127.0.0.1:${String(port)}/hook` });
        const probe = await inTenant(TENANT, (tx) =>
          requestProbe(tx, TENANT, { endpointId: endpoint, requestedBy: ADMIN }),
        );

        const result = await new EndpointProbeRunner({
          pool,
          probers: [
            new WebhookProber({
              fetch: globalThis.fetch as unknown as FetchLike,
              // The scheduler's environment, which is the whole reason the API cannot
              // answer this question itself.
              env: { [SECRET_ENV]: SECRET },
              timeoutMs: 5_000,
            }),
          ],
          workerId: "e2e",
        }).runTenant(TENANT);

        expect(result.byVerdict.delivered).toBe(1);
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0]!)).toMatchObject({ event: PROBE_EVENT, probeId: probe.id });

        const read = await inTenant(TENANT, (tx) => latestProbe(tx, endpoint));
        expect(read!.state).toBe("complete");
        expect(read!.verdict).toBe("delivered");
        expect(read!.status).toBe(202);
        expect(read!.channel).toBe("webhook");
        expect(read!.detail).toContain(SECRET_ENV);
        // And the secret itself never reaches the row an administrator reads.
        expect(read!.detail).not.toContain(SECRET);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
