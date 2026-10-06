import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_DELIVERY_RETENTION as TENANT,
  TENANT_DELIVERY_RETENTION_OTHER as OTHER_TENANT,
  appPool,
} from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import { claimDue, settleOrphanedDeliveries } from "./dispatch.js";
import { deliveryHistory, recentDeliveries } from "./delivery-history.js";
import {
  DEFAULT_RETAIN_DELIVERY_DAYS,
  InvalidRetentionError,
  grantPruneGuardOverride,
  notificationDeliveryRetention,
  pruneNotifications,
  prunePreview,
  setNotificationDeliveryRetention,
  setNotificationPolicy,
  setNotificationPruneGuard,
} from "./retention.js";

/**
 * Delivery history outliving the notification it describes (migration 0046).
 *
 * The claim being tested is not "old rows are deleted" — 0024's suite covers that shape —
 * it is that a delivery record STOPS DEPENDING on the notification row and gets a horizon
 * of its own. So the centre of this file is one test: delete the notification, and the
 * delivery record is still there and still says where the signal went. Everything else is
 * the cost of that: the tenant guard that replaces the dropped foreign key, the write order
 * that replaces a transaction timestamp, and the prune that stops the orphans growing
 * without bound.
 *
 * Against a real Postgres, as `crm_app`, through `withTenantContext` throughout. None of it
 * could be asserted against a fake connection: the guard IS row-level security, the copies
 * are made by a trigger, and `seq` is a sequence.
 */

describe("delivery retention", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "e7100000-0000-4000-8000-000000000101";
  const OTHER_REP = "e8100000-0000-4000-8000-000000000102";

  const inTenant = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOther = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER_TENANT, fn);

  /** 2026-06-01, so every "days ago" is a fixed date rather than a moving one. */
  const NOW = new Date("2026-06-01T12:00:00Z");
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

  let seq = 0;

  const notify = async (
    c: PoolClient,
    tenant: string,
    rep: string,
    opts: { createdDaysAgo?: number; read?: boolean; kind?: string; severity?: string } = {},
  ): Promise<string> => {
    seq += 1;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO crm.notification
         (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key, created_at, read_at)
       VALUES ($1,$2,$3,$4,'a subject','a body',$5,$6,$7) RETURNING id`,
      [
        tenant,
        rep,
        opts.kind ?? "disposal_obligation_overdue",
        opts.severity ?? "urgent",
        `dr-${seq}`,
        daysAgo(opts.createdDaysAgo ?? 0),
        opts.read === true ? daysAgo(opts.createdDaysAgo ?? 0) : null,
      ],
    );
    return rows[0]!.id;
  };

  const endpoint = async (c: PoolClient, tenant: string): Promise<string> => {
    seq += 1;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO crm.notification_endpoint (tenant_id, channel, url, secret_env)
       VALUES ($1,'webhook',$2,'CRM_DR_SECRET') RETURNING id`,
      [tenant, `https://hooks.example.test/dr-${seq}`],
    );
    return rows[0]!.id;
  };

  const deliver = async (
    c: PoolClient,
    tenant: string,
    notificationId: string,
    endpointId: string,
    opts: { state?: string; createdDaysAgo?: number } = {},
  ): Promise<string> => {
    const { rows } = await c.query<{ id: string }>(
      // `next_attempt_at` is supplied rather than defaulted: its default is `now()`, the
      // REAL clock, where every horizon here is measured against the fixed `NOW` below —
      // so a defaulted row is never due and `claimDue` would silently find nothing.
      `INSERT INTO crm.notification_delivery
         (tenant_id, notification_id, endpoint_id, state, created_at, delivered_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING id`,
      [
        tenant,
        notificationId,
        endpointId,
        opts.state ?? "delivered",
        daysAgo(opts.createdDaysAgo ?? 0),
        (opts.state ?? "delivered") === "delivered" ? daysAgo(opts.createdDaysAgo ?? 0) : null,
      ],
    );
    return rows[0]!.id;
  };

  const clear = async (): Promise<void> => {
    for (const [fn, tenant] of [
      [inTenant, TENANT],
      [inOther, OTHER_TENANT],
    ] as const) {
      await fn(async (c) => {
        await c.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await c.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await c.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [tenant]);
        await c.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await clear();
    for (const [fn, tenant, rep, name] of [
      [inTenant, TENANT, REP, "Delivery Recipient"],
      [inOther, OTHER_TENANT, OTHER_REP, "Other Tenant Rep"],
    ] as const) {
      await fn((c) =>
        c.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING`,
          [rep, tenant, `dr-${rep}`, name],
        ),
      );
    }
  });

  afterAll(async () => {
    await clear();
    await inTenant((c) => c.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]));
    await inOther((c) => c.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [OTHER_TENANT]));
    client?.release();
    await pool?.end();
  });

  beforeEach(clear);

  const prune = (opts: { maxRows?: number } = {}) =>
    inTenant((c) => pruneNotifications(c, TENANT, { asOf: NOW, ...opts }));

  const countDeliveries = (): Promise<number> =>
    inTenant(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.notification_delivery WHERE tenant_id = $1",
        [TENANT],
      );
      return Number(rows[0]!.n);
    });

  // =========================================================================
  // THE RULE
  // =========================================================================

  describe("a delivery record outlives the notification it describes", () => {
    /**
     * The one test this whole change exists for.
     *
     * Before 0046 this was impossible by construction: `ON DELETE CASCADE` took the
     * delivery row with the notification, so the retention period for an inbox entry was
     * also the retention period for the record that the signal had been pushed to a third
     * party. The notification is deleted directly here rather than through the prune,
     * because the claim is about the SCHEMA — no cascade, no veto — and the prune is only
     * one of the things that deletes.
     */
    it("survives the notification's deletion and still says where the signal went", async () => {
      const { nid, did, url } = await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { kind: "call_plan_submitted", severity: "warning" });
        const d = await deliver(c, TENANT, n, ep);
        const { rows } = await c.query<{ url: string }>(
          "SELECT url FROM crm.notification_endpoint WHERE id = $1",
          [ep],
        );
        return { nid: n, did: d, url: rows[0]!.url };
      });

      await inTenant((c) => c.query("DELETE FROM crm.notification WHERE id = $1", [nid]));

      const history = await inTenant((c) => deliveryHistory(c, nid));
      expect(history).toHaveLength(1);
      const row = history[0]!;
      expect(row.id).toBe(did);
      // Where it went: the endpoint is still joinable, so the url is read rather than copied.
      expect(row.endpoint_url).toBe(url);
      expect(row.endpoint_channel).toBe("webhook");
      // Whether it landed.
      expect(row.state).toBe("delivered");
      // Which signal, and for whom — the four copies, read with nothing to join to.
      expect(row.notification_kind).toBe("call_plan_submitted");
      expect(row.notification_severity).toBe("warning");
      expect(row.recipient_rep_profile_id).toBe(REP);
      expect(row.recipient_display_name).toBe("Delivery Recipient");
      expect(row.notification_created_at).toBeInstanceOf(Date);
      // And the edge of the feature, stated on the row rather than inferred.
      expect(row.notification_present).toBe(false);
    });

    /**
     * The negative half, so the assertion above is about retention and not about a join
     * that never worked.
     */
    it("says the notification is present while it is", async () => {
      const nid = await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP);
        await deliver(c, TENANT, n, ep);
        return n;
      });
      const [row] = await inTenant((c) => deliveryHistory(c, nid));
      expect(row?.notification_present).toBe(true);
    });

    /**
     * `recipient_display_name` is a LEFT JOIN, not a copy — 0036's `revived_by_name` shape.
     * A removed profile leaves a recorded uuid beside a null name, which is strictly more
     * than a cascade or a SET NULL would have left.
     */
    it("keeps the recipient's id when the profile itself is gone", async () => {
      const gone = "e7100000-0000-4000-8000-0000000001ff";
      const nid = await inTenant(async (c) => {
        await c.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,'dr-ghost','dr-ghost','Ghost')`,
          [gone, TENANT],
        );
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, gone);
        await deliver(c, TENANT, n, ep);
        await c.query("DELETE FROM crm.notification WHERE id = $1", [n]);
        await c.query("DELETE FROM crm.rep_profile WHERE id = $1", [gone]);
        return n;
      });
      const [row] = await inTenant((c) => deliveryHistory(c, nid));
      expect(row?.recipient_rep_profile_id).toBe(gone);
      expect(row?.recipient_display_name).toBeNull();
    });

    it("declares no foreign key from the delivery row to the notification", async () => {
      // The structural claim behind every test above, asserted from the catalog rather than
      // from the migration text: what matters is the constraint the database enforces.
      const { rows } = await client.query<{ conname: string }>(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class child ON child.oid = con.conrelid
           JOIN pg_class parent ON parent.oid = con.confrelid
          WHERE con.contype = 'f' AND child.relname = 'notification_delivery'
          ORDER BY con.conname`,
      );
      // The endpoint reference survives 0046 untouched; the notification one does not exist.
      expect(rows.map((r) => r.conname)).toEqual(["notification_delivery_endpoint_id_fkey"]);
    });
  });

  // =========================================================================
  // WHAT REPLACES THE DROPPED KEY
  // =========================================================================

  describe("the tenant guard that replaces the foreign key", () => {
    /**
     * WITH NOTHING DISABLED — no trigger off, RLS live, as `crm_app` under FORCE.
     *
     * Dropping a composite foreign key drops a tenant guard, because a referential check
     * runs with row security disabled and so answers "same tenant?" at the same moment as
     * "does it exist?" (0035, 0037). `crm.notification_delivery_context` is what replaces
     * it, and it is tighter: the lookup runs under the CALLER'S row security, so another
     * tenant's notification reads as ABSENT where a foreign key would have found it.
     */
    it("refuses a delivery naming another tenant's notification", async () => {
      const foreign = await inTenant((c) => notify(c, TENANT, REP));
      const ep = await inOther((c) => endpoint(c, OTHER_TENANT));

      await expect(
        inOther((c) =>
          c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
             VALUES ($1,$2,$3)`,
            [OTHER_TENANT, foreign, ep],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("accepts the same statement against its own notification, or the refusal means nothing", async () => {
      const mine = await inOther((c) => notify(c, OTHER_TENANT, OTHER_REP));
      const ep = await inOther((c) => endpoint(c, OTHER_TENANT));
      await expect(
        inOther((c) =>
          c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
             VALUES ($1,$2,$3)`,
            [OTHER_TENANT, mine, ep],
          ),
        ),
      ).resolves.toBeDefined();
    });

    it("names the notification and the tenant in the refusal", async () => {
      const foreign = await inTenant((c) => notify(c, TENANT, REP));
      const ep = await inOther((c) => endpoint(c, OTHER_TENANT));
      await expect(
        inOther((c) =>
          c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
             VALUES ($1,$2,$3)`,
            [OTHER_TENANT, foreign, ep],
          ),
        ),
      ).rejects.toThrow(/delivery-foreign-notification/);
    });

    /**
     * The copies are facts about the notification, not caller input.
     *
     * 0034 makes the same choice about `requested_at` for the same reason: a caller who
     * could supply the value could record a push as having carried a signal it did not.
     */
    it("overwrites supplied copies with the notification's own values", async () => {
      const nid = await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { kind: "erp_write_failed", severity: "warning" });
        await c.query(
          `INSERT INTO crm.notification_delivery
             (tenant_id, notification_id, endpoint_id,
              notification_kind, notification_severity, notification_created_at,
              recipient_rep_profile_id)
           VALUES ($1,$2,$3,'call_plan_approved','info',now(),$4)`,
          [TENANT, n, ep, OTHER_REP],
        );
        return n;
      });
      const [row] = await inTenant((c) => deliveryHistory(c, nid));
      expect(row?.notification_kind).toBe("erp_write_failed");
      expect(row?.notification_severity).toBe("warning");
      expect(row?.recipient_rep_profile_id).toBe(REP);
    });

    /**
     * The episode key is tenant-scoped (0043's rule): a unique index is enforced with row
     * security disabled, and the composite foreign key that used to cover for that is gone.
     */
    it("keys the episode on the tenant as well as the pair", async () => {
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.notification_delivery'::regclass AND contype = 'u'`,
      );
      expect(rows.map((r) => r.def)).toEqual(["UNIQUE (tenant_id, notification_id, endpoint_id)"]);
    });

    it("still refuses a second delivery of one signal to one endpoint", async () => {
      // The rule the key exists for, unchanged: fanning one signal to one endpoint twice
      // pages somebody twice for one event.
      await expect(
        inTenant(async (c) => {
          const ep = await endpoint(c, TENANT);
          const n = await notify(c, TENANT, REP);
          await deliver(c, TENANT, n, ep);
          await deliver(c, TENANT, n, ep);
        }),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  // =========================================================================
  // THE ORDERING HAZARD
  // =========================================================================

  describe("the write order", () => {
    /**
     * The hazard, pinned the way 0041 pinned its own: assert that the timestamp TIES, so
     * the reason `seq` exists is evidence in the suite rather than a claim in a header.
     */
    it("gives two deliveries written in one transaction one created_at and two seqs", async () => {
      const rows = await inTenant(async (c) => {
        const e1 = await endpoint(c, TENANT);
        const e2 = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP);
        // No explicit created_at: this is the default, which is `now()` — the TRANSACTION
        // timestamp, shared by everything written inside one transaction.
        for (const ep of [e1, e2]) {
          await c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
             VALUES ($1,$2,$3)`,
            [TENANT, n, ep],
          );
        }
        const { rows } = await c.query<{ created_at: Date; seq: string }>(
          `SELECT created_at, seq::text AS seq FROM crm.notification_delivery
            WHERE tenant_id = $1 ORDER BY seq`,
          [TENANT],
        );
        return rows;
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.created_at.getTime())).size).toBe(1);
      expect(Number(rows[1]!.seq)).toBeGreaterThan(Number(rows[0]!.seq));
    });

    /**
     * GENERATED ALWAYS, following 0041 rather than 0027. This is now a history table that
     * outlives its parent, and a supplied `seq` would corrupt the one ordering a retained
     * record has.
     */
    it("refuses a hand-written seq", async () => {
      await expect(
        inTenant(async (c) => {
          const ep = await endpoint(c, TENANT);
          const n = await notify(c, TENANT, REP);
          await c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, seq)
             VALUES ($1,$2,$3,999)`,
            [TENANT, n, ep],
          );
        }),
      ).rejects.toThrow(/non-DEFAULT value into column "seq"/);
    });

    it("lists recent pushes newest-first by write order, not by a tied timestamp", async () => {
      const ids = await inTenant(async (c) => {
        const n = await notify(c, TENANT, REP);
        const out: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const ep = await endpoint(c, TENANT);
          out.push(await deliver(c, TENANT, n, ep));
        }
        return out;
      });
      const recent = await inTenant((c) => recentDeliveries(c, { limit: 10 }));
      expect(recent.map((r) => r.id)).toEqual([...ids].reverse());
    });

    /**
     * `claimDue` ordered by `next_attempt_at` and then by the notification's `created_at` —
     * the same transaction clock twice, so a fan-out's claim order was the plan's.
     */
    it("claims a fan-out in write order", async () => {
      const ids = await inTenant(async (c) => {
        const n = await notify(c, TENANT, REP);
        const out: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const ep = await endpoint(c, TENANT);
          out.push(await deliver(c, TENANT, n, ep, { state: "pending" }));
        }
        return out;
      });
      const claimed = await inTenant((c) => claimDue(c, TENANT, NOW, 10, () => 0.5));
      expect(claimed.map((d) => d.id)).toEqual(ids);
      expect(claimed.map((d) => Number(d.seq))).toEqual(
        [...claimed].map((d) => Number(d.seq)).sort((a, b) => a - b),
      );
    });
  });

  // =========================================================================
  // THE ORPHAN A DROPPED CASCADE CREATES, IN THE DISPATCHER
  // =========================================================================

  describe("an unsettled delivery whose notification is gone", () => {
    /**
     * The hazard dropping the cascade introduced, and the reason it had to be handled
     * rather than discovered: `claimDue`'s first CTE would have claimed the row — attempts
     * incremented, next attempt advanced — and the inner join that builds the payload would
     * then have dropped it, every tick, forever, with nothing counting it.
     */
    it("is never claimed", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP);
        await deliver(c, TENANT, n, ep, { state: "pending" });
        await c.query("DELETE FROM crm.notification WHERE id = $1", [n]);
      });
      expect(await inTenant((c) => claimDue(c, TENANT, NOW, 10, () => 0.5))).toEqual([]);
      // And the claim did not touch it on the way past.
      const { attempts, state } = await inTenant(async (c) => {
        const { rows } = await c.query<{ attempts: number; state: string }>(
          "SELECT attempts, state FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        return rows[0]!;
      });
      expect({ attempts, state }).toEqual({ attempts: 0, state: "pending" });
    });

    it("is recorded as undeliverable, with a reason that names why", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP);
        await deliver(c, TENANT, n, ep, { state: "pending" });
        await c.query("DELETE FROM crm.notification WHERE id = $1", [n]);
      });
      expect(await inTenant((c) => settleOrphanedDeliveries(c, TENANT))).toBe(1);
      const row = await inTenant(async (c) => {
        const { rows } = await c.query<{ state: string; last_error: string }>(
          "SELECT state, last_error FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        return rows[0]!;
      });
      expect(row.state).toBe("dead");
      expect(row.last_error).toContain("no longer exists");
    });

    it("leaves a settled delivery alone", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP);
        await deliver(c, TENANT, n, ep, { state: "delivered" });
        await c.query("DELETE FROM crm.notification WHERE id = $1", [n]);
      });
      expect(await inTenant((c) => settleOrphanedDeliveries(c, TENANT))).toBe(0);
    });
  });

  // =========================================================================
  // THE SECOND HORIZON
  // =========================================================================

  describe("the horizon", () => {
    it("defaults to two years for a tenant that has never configured it", async () => {
      expect(await inTenant((c) => notificationDeliveryRetention(c, TENANT))).toEqual({
        retain_delivery_days: DEFAULT_RETAIN_DELIVERY_DAYS,
      });
      expect(DEFAULT_RETAIN_DELIVERY_DAYS).toBe(730);
    });

    it("is settable", async () => {
      expect(
        await inTenant((c) => setNotificationDeliveryRetention(c, TENANT, { retainDeliveryDays: 1000 })),
      ).toEqual({ retain_delivery_days: 1000 });
    });

    /**
     * The invariant that makes three numbers coherent. Without it a tenant could set
     * `retainDeliveryDays = 1` against `retainUnreadDays = 365` and recreate the coupling
     * 0046 removes — inverted, and worse: the proof of the push deleted while the message it
     * pushed is still on display.
     */
    it("refuses a delivery horizon shorter than the unread one", async () => {
      await expect(
        inTenant((c) => setNotificationDeliveryRetention(c, TENANT, { retainDeliveryDays: 30 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    it("refuses it from the other side too, and says which number to raise", async () => {
      await inTenant((c) => setNotificationDeliveryRetention(c, TENANT, { retainDeliveryDays: 400 }));
      const err = await inTenant((c) =>
        setNotificationPolicy(c, TENANT, { retainUnreadDays: 500 }).then(
          () => null,
          (e: unknown) => e,
        ),
      );
      expect(err).toBeInstanceOf(InvalidRetentionError);
      expect((err as Error).message).toContain("raise retainDeliveryDays first");
    });

    it("refuses a period outside the allowed range", async () => {
      await expect(
        inTenant((c) => setNotificationDeliveryRetention(c, TENANT, { retainDeliveryDays: 4000 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });
  });

  // =========================================================================
  // THE PRUNE
  // =========================================================================

  describe("the prune's second phase", () => {
    it("takes a settled push past its horizon and leaves one inside it", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        for (const days of [800, 400]) {
          const n = await notify(c, TENANT, REP, { createdDaysAgo: days, read: true });
          await deliver(c, TENANT, n, ep, { createdDaysAgo: days });
        }
      });
      const r = await prune();
      expect(r.delivery.retainDeliveryDays).toBe(730);
      expect(r.delivery.deleted).toBe(1);
      expect(await countDeliveries()).toBe(1);
    });

    /**
     * A dead push is the most valuable row in the table, so it is held back at every
     * horizon — 0024's rule for the notification side, and 0036's argument for why an
     * unbounded failure-only table is acceptable: it grows only with failure, so unbounded
     * growth is a paging condition before it is a disk problem.
     */
    it("never takes an unsettled push, however old", async () => {
      await inTenant(async (c) => {
        const ep1 = await endpoint(c, TENANT);
        const ep2 = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 2000, read: true });
        await deliver(c, TENANT, n, ep1, { state: "dead", createdDaysAgo: 2000 });
        await deliver(c, TENANT, n, ep2, { state: "pending", createdDaysAgo: 2000 });
      });
      const r = await prune();
      expect(r.delivery.deleted).toBe(0);
      expect(r.delivery.keptUnsettled).toBe(2);
      expect(await countDeliveries()).toBe(2);
    });

    /**
     * The whole point, end to end through the job rather than through a hand-written
     * DELETE: the notification goes at its horizon and the delivery record stays, because
     * the two horizons are independent.
     */
    it("keeps the delivery record of a notification it has just pruned", async () => {
      const nid = await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 400, read: true });
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 400 });
        return n;
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.delivery.deleted).toBe(0);
      expect(await countDeliveries()).toBe(1);

      const [row] = await inTenant((c) => deliveryHistory(c, nid));
      expect(row?.notification_present).toBe(false);
      expect(row?.notification_kind).toBe("disposal_obligation_overdue");
    });

    /**
     * And the orphan is counted, so "delivery history now outlives the inbox" is a number
     * somebody can watch rather than a claim in a migration header. Counted at the moment
     * phase two ran, which is AFTER phase one — so it includes what tonight orphaned.
     */
    it("counts the rows that have outlived their notification", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 400, read: true });
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 400 });
      });
      expect((await prune()).delivery.orphaned).toBe(1);
    });

    /**
     * Phase ORDER, which is load-bearing: a delivery past BOTH horizons has to go in the
     * same pass that prunes its notification, or every orphan waits a night.
     */
    it("takes both in one pass when both are past their horizons", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900, read: true });
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
      });
      const r = await prune();
      expect({ notifications: r.deletedRead, deliveries: r.delivery.deleted }).toEqual({
        notifications: 1,
        deliveries: 1,
      });
      expect(await countDeliveries()).toBe(0);
    });

    it("drains a backlog in passes and says there is more to do", async () => {
      await inTenant(async (c) => {
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900, read: true });
        for (let i = 0; i < 4; i += 1) {
          const ep = await endpoint(c, TENANT);
          await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
        }
      });
      const first = await prune({ maxRows: 2 });
      expect(first.delivery.deleted).toBe(2);
      expect(first.delivery.moreRemaining).toBe(true);
      const second = await prune({ maxRows: 10 });
      expect(second.delivery.deleted).toBe(2);
      expect(second.delivery.moreRemaining).toBe(false);
      expect(await countDeliveries()).toBe(0);
    });
  });

  // =========================================================================
  // THE GUARD, ON THE PHASE'S OWN NUMBERS
  // =========================================================================

  describe("the volume guard", () => {
    /**
     * `prune_guard_floor_rows` has to come down for any of this to be reachable in a test:
     * the floor is the left operand of the guard's AND, so under 100 rows the share is
     * never consulted (0026, and 0032/0039 on why the floor is capped).
     */
    const lowFloor = (): Promise<unknown> =>
      inTenant((c) => setNotificationPruneGuard(c, TENANT, { guardFloorRows: 2, maxSharePercent: 25 }));

    /** 8 old settled pushes and 2 recent ones: 80% of the table, well over 25%. */
    const overCeiling = async (): Promise<void> => {
      await inTenant(async (c) => {
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900 });
        for (let i = 0; i < 8; i += 1) {
          const ep = await endpoint(c, TENANT);
          await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
        }
        const fresh = await notify(c, TENANT, REP, { createdDaysAgo: 1 });
        for (let i = 0; i < 2; i += 1) {
          const ep = await endpoint(c, TENANT);
          await deliver(c, TENANT, fresh, ep, { createdDaysAgo: 1 });
        }
      });
    };

    it("refuses the phase outright and deletes nothing", async () => {
      await overCeiling();
      await lowFloor();
      const r = await prune();
      expect(r.delivery.refused).toBe(true);
      expect(r.delivery.deleted).toBe(0);
      expect(r.delivery.prunableTotal).toBe(8);
      expect(r.delivery.deliveryTotal).toBe(10);
      expect(r.delivery.sharePercent).toBe(80);
      expect(await countDeliveries()).toBe(10);
    });

    it("says why, in the delivery phase's own words", async () => {
      await overCeiling();
      await lowFloor();
      const r = await prune();
      expect(r.delivery.refusalReason).toContain("8 delivery record(s)");
      expect(r.delivery.refusalReason).toContain("recorded pushes");
      expect(r.delivery.refusalReason).toContain("retainDeliveryDays");
      // Not the inbox's sentence: the two phases must not describe each other's numbers.
      expect(r.delivery.refusalReason).not.toContain("inbox");
    });

    /**
     * ONE break-glass window for the job, not one per table. An operator who has looked at
     * the numbers and said "drain it" has said it about tonight's pass; making them grant
     * two windows is how the second one starts getting granted by reflex.
     */
    it("is passed by the same override the inbox phase uses", async () => {
      await overCeiling();
      await lowFloor();
      await inTenant((c) => grantPruneGuardOverride(c, TENANT, { grantedBy: "ops@example.test", hours: 1 }));
      const r = await prune();
      expect(r.delivery.refused).toBe(false);
      expect(r.delivery.overridden).toBe(true);
      expect(r.delivery.deleted).toBe(8);
    });

    /**
     * A phase the FLOOR let through over the ceiling must say so, for 0032's reason: it
     * otherwise reads exactly like a phase that was within its ceiling, because `overridden`
     * is only ever true where the guard actually tripped and the floor stops it tripping.
     */
    it("says when the row floor let it through over the ceiling", async () => {
      await overCeiling();
      // The default floor of 100 is above this table's 10 rows, so the share is not consulted.
      const r = await prune();
      expect(r.delivery.refused).toBe(false);
      expect(r.delivery.floorWaived).toBe(true);
      expect(r.delivery.floorWaivedReason).toContain("over the 25% ceiling");
      expect(r.delivery.deleted).toBe(8);
    });

    /**
     * The two phases are two judgements. A mistyped INBOX horizon must not suspend the
     * delivery table's retention indefinitely with nothing in the summary saying so.
     */
    it("still runs when the inbox phase is refused", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        // One inbox row past its horizon out of one: 100% of the inbox, which refuses.
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900, read: true });
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
        await setNotificationPruneGuard(c, TENANT, { guardFloorRows: 0, maxSharePercent: 25 });
      });
      const r = await prune();
      expect(r.refused).toBe(true);
      expect(r.deletedRead).toBe(0);
      // Its own numbers: one prunable delivery out of one is also 100%, so this phase is
      // refused too — on its OWN measurement, which is the point.
      expect(r.delivery.refused).toBe(true);
      expect(r.delivery.prunableTotal).toBe(1);
      expect(r.delivery.deliveryTotal).toBe(1);
    });

    it("prunes deliveries while the inbox phase is refused, when its own share is fine", async () => {
      await inTenant(async (c) => {
        // One old notification (100% of a one-row inbox → refused), and a delivery table
        // where the old pushes are a small minority.
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900, read: true });
        const ep = await endpoint(c, TENANT);
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
        for (let i = 0; i < 20; i += 1) {
          const fresh = await endpoint(c, TENANT);
          await deliver(c, TENANT, n, fresh, { createdDaysAgo: 1 });
        }
        await setNotificationPruneGuard(c, TENANT, { guardFloorRows: 0, maxSharePercent: 25 });
      });
      const r = await prune();
      expect(r.refused).toBe(true);
      expect(r.delivery.refused).toBe(false);
      expect(r.delivery.deleted).toBe(1);
      expect(await countDeliveries()).toBe(20);
    });
  });

  // =========================================================================
  // THE PREVIEW
  // =========================================================================

  describe("the preview", () => {
    it("answers for both phases without deleting anything", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c, TENANT);
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900, read: true });
        await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
      });
      const p = await inTenant((c) => prunePreview(c, TENANT, { asOf: NOW }));
      expect(p.prunableTotal).toBe(1);
      expect(p.delivery.prunableTotal).toBe(1);
      expect(p.delivery.deliveryTotal).toBe(1);
      expect(p.delivery.retainDeliveryDays).toBe(730);
      expect(await countDeliveries()).toBe(1);
    });

    it("agrees with the verdict about whether the delivery phase would be refused", async () => {
      await inTenant(async (c) => {
        const n = await notify(c, TENANT, REP, { createdDaysAgo: 900 });
        for (let i = 0; i < 8; i += 1) {
          const ep = await endpoint(c, TENANT);
          await deliver(c, TENANT, n, ep, { createdDaysAgo: 900 });
        }
        const fresh = await notify(c, TENANT, REP, { createdDaysAgo: 1 });
        for (let i = 0; i < 2; i += 1) {
          const ep = await endpoint(c, TENANT);
          await deliver(c, TENANT, fresh, ep, { createdDaysAgo: 1 });
        }
        await setNotificationPruneGuard(c, TENANT, { guardFloorRows: 2, maxSharePercent: 25 });
      });
      const p = await inTenant((c) => prunePreview(c, TENANT, { asOf: NOW }));
      const r = await prune();
      expect(p.delivery.wouldRefuse).toBe(true);
      expect(r.delivery.refused).toBe(true);
      expect(p.delivery.refusalReason).toBe(r.delivery.refusalReason);
    });
  });

  // =========================================================================
  // TENANT ISOLATION OF THE READS
  // =========================================================================

  describe("the reads are tenant-scoped", () => {
    it("does not show one tenant another's delivery history", async () => {
      const foreign = await inOther(async (c) => {
        const ep = await endpoint(c, OTHER_TENANT);
        const n = await notify(c, OTHER_TENANT, OTHER_REP);
        await deliver(c, OTHER_TENANT, n, ep);
        return n;
      });
      // By notification id, which is the one value a caller could plausibly hold: the view
      // and the function both run under the caller's row security, so it reads as absent.
      expect(await inTenant((c) => deliveryHistory(c, foreign))).toEqual([]);
      expect(await inTenant((c) => recentDeliveries(c))).toEqual([]);
    });

    it("does not let one tenant's prune reach another's rows", async () => {
      await inOther(async (c) => {
        const ep = await endpoint(c, OTHER_TENANT);
        const n = await notify(c, OTHER_TENANT, OTHER_REP, { createdDaysAgo: 2000, read: true });
        await deliver(c, OTHER_TENANT, n, ep, { createdDaysAgo: 2000 });
      });
      const r = await prune();
      expect(r.delivery.deleted).toBe(0);
      expect(r.delivery.deliveryTotal).toBe(0);
      const left = await inOther(async (c) => {
        const { rows } = await c.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.notification_delivery WHERE tenant_id = $1",
          [OTHER_TENANT],
        );
        return Number(rows[0]!.n);
      });
      expect(left).toBe(1);
    });
  });
});
