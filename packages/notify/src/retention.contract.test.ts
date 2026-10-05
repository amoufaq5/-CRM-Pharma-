import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { appPool, TENANT_PRUNE_GUARD, TENANT_RETENTION as TENANT } from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import {
  grantPruneGuardOverride,
  InvalidRetentionError,
  notificationPolicy,
  notificationPruneGuard,
  prunableNotifications,
  pruneNotifications,
  revokePruneGuardOverride,
  setNotificationPolicy,
  setNotificationPruneGuard,
} from "./retention.js";

/**
 * Notification retention against a real Postgres.
 *
 * The rule that needs proving is not "old rows are deleted" — it is the exemption: a
 * notification about something still unfinished survives its horizon. That exemption is a
 * SQL function with one branch per producing table (migration 0024), so each branch gets
 * a test with both answers, built from real rows in the real tables. A fake connection
 * could not evaluate any of it.
 *
 * `appPool()` because the pool is never handed to production code here, but the fixture
 * writes through `withTenantContext` throughout — these are RLS-protected tables and a
 * seed that inserts without context is a seed only a privileged connection could run.
 */
describe("notification retention", () => {
  let pool: Pool;
  let tx: PoolClient;

  const REP = "e6100000-0000-4000-8000-000000000001";
  const OTHER = "e6200000-0000-4000-8000-000000000002";

  const inTenant = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(tx, TENANT, fn);

  /** 2026-06-01, so every "days ago" below is a fixed date rather than a moving one. */
  const NOW = new Date("2026-06-01T12:00:00Z");
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

  let seq = 0;
  const notify = async (
    c: PoolClient,
    opts: {
      createdDaysAgo: number;
      read?: boolean;
      subjectTable?: string | null;
      subjectId?: string | null;
      kind?: string;
    },
  ): Promise<string> => {
    seq += 1;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO crm.notification
         (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key,
          subject_table, subject_id, created_at, read_at)
       VALUES ($1,$2,$3,'info','s','b',$4,$5,$6,$7,$8) RETURNING id`,
      [
        TENANT,
        REP,
        opts.kind ?? "call_plan_approved",
        `ret-${seq}`,
        opts.subjectTable ?? null,
        opts.subjectId ?? null,
        daysAgo(opts.createdDaysAgo),
        opts.read === true ? daysAgo(opts.createdDaysAgo) : null,
      ],
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    pool = appPool();
    tx = await pool.connect();
    await inTenant(async (c) => {
      for (const [id, n] of [
        [REP, "Recipient"],
        [OTHER, "Someone Else"],
      ] as const) {
        await c.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING`,
          [id, TENANT, `ret-${n.replace(/ /g, "-").toLowerCase()}`, n],
        );
      }
    });
  });

  afterAll(async () => {
    await clear();
    await inTenant(async (c) => {
      await c.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    tx?.release();
    await pool?.end();
  });

  const clear = async (): Promise<void> => {
    await inTenant(async (c) => {
      await c.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [TENANT]);
      await c.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await c.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      await c.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
      await c.query("ALTER TABLE crm.sample_transaction ENABLE TRIGGER USER");
      await c.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");
      await c.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      // An approved plan refuses deletion by design (0016) — it is a record of what was
      // agreed. The fixture disables that guard explicitly, and nowhere else.
      await c.query("ALTER TABLE crm.call_plan DISABLE TRIGGER USER");
      await c.query("DELETE FROM crm.call_plan WHERE tenant_id = $1", [TENANT]);
      await c.query("ALTER TABLE crm.call_plan ENABLE TRIGGER USER");
      await c.query("DELETE FROM crm.cycle WHERE tenant_id = $1", [TENANT]);
      await c.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeEach(clear);

  const prune = (opts: { maxRows?: number } = {}) =>
    inTenant((c) => pruneNotifications(c, TENANT, { asOf: NOW, ...opts }));

  const remaining = (): Promise<number> =>
    inTenant(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.notification WHERE tenant_id = $1",
        [TENANT],
      );
      return Number(rows[0]!.n);
    });

  describe("the policy", () => {
    it("defaults a tenant that has never configured it", async () => {
      expect(await inTenant((c) => notificationPolicy(c, TENANT))).toEqual({
        retain_read_days: 30,
        retain_unread_days: 365,
      });
    });

    it("changes one horizon without disturbing the other", async () => {
      const p = await inTenant((c) => setNotificationPolicy(c, TENANT, { retainReadDays: 7 }));
      expect(p).toEqual({ retain_read_days: 7, retain_unread_days: 365 });
    });

    /**
     * The invariant that makes two numbers coherent. Without it a tenant could set
     * read=90, unread=7 and lose exactly the notifications that still mattered.
     */
    it("refuses an unread horizon shorter than the read one", async () => {
      await expect(
        inTenant((c) => setNotificationPolicy(c, TENANT, { retainUnreadDays: 7 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    it("refuses it on a PARTIAL update too, judged against the row as it would be", async () => {
      await inTenant((c) => setNotificationPolicy(c, TENANT, { retainReadDays: 10, retainUnreadDays: 20 }));
      // Raising only the read horizon above the stored unread one is the same mistake
      // arriving from the other side.
      await expect(
        inTenant((c) => setNotificationPolicy(c, TENANT, { retainReadDays: 30 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    it("refuses a period outside the allowed range", async () => {
      await expect(
        inTenant((c) => setNotificationPolicy(c, TENANT, { retainReadDays: 0 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
      await expect(
        inTenant((c) => setNotificationPolicy(c, TENANT, { retainUnreadDays: 4000 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });
  });

  describe("the two horizons", () => {
    it("deletes a read notification past the read horizon and keeps a recent one", async () => {
      await inTenant(async (c) => {
        await notify(c, { createdDaysAgo: 40, read: true });
        await notify(c, { createdDaysAgo: 5, read: true });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.deletedUnread).toBe(0);
      expect(await remaining()).toBe(1);
    });

    /**
     * The reason there are two numbers. At 40 days a READ notification is gone and an
     * UNREAD one is not: deleting the unread one would delete a message nobody ever saw.
     */
    it("keeps an unread notification the read horizon would have taken", async () => {
      await inTenant(async (c) => {
        await notify(c, { createdDaysAgo: 40, read: true });
        await notify(c, { createdDaysAgo: 40, read: false });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.deletedUnread).toBe(0);
      expect(await remaining()).toBe(1);
    });

    it("deletes an unread notification once its own horizon passes", async () => {
      await inTenant((c) => notify(c, { createdDaysAgo: 400, read: false }));
      const r = await prune();
      expect(r.deletedUnread).toBe(1);
      expect(await remaining()).toBe(0);
    });

    it("honours a shortened horizon immediately", async () => {
      await inTenant(async (c) => {
        await setNotificationPolicy(c, TENANT, { retainReadDays: 3 });
        await notify(c, { createdDaysAgo: 5, read: true });
      });
      expect((await prune()).deletedRead).toBe(1);
    });
  });

  /**
   * The exemption, branch by branch. Each producer table gets both answers, because a
   * predicate that always says "open" and one that always says "closed" both pass a
   * one-sided test.
   */
  describe("an open subject is never pruned", () => {
    const obligation = async (c: PoolClient, status: "open" | "resolved"): Promise<string> => {
      const lot = await c.query<{ id: string }>(
        `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
         VALUES ($1,'item-ret',$2,'2026-01-31','drug_sample') RETURNING id`,
        [TENANT, `LOT-RET-${(seq += 1)}`],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.disposal_obligation
           (tenant_id, rep_profile_id, lot_id, quantity_at_discovery, expired_on, discovered_on,
            due_by, status, resolved_on, resolution)
         VALUES ($1,$2,$3,5,'2026-01-31','2026-02-01','2026-03-03',$4,$5,$6) RETURNING id`,
        [
          TENANT,
          REP,
          lot.rows[0]!.id,
          status,
          status === "resolved" ? "2026-03-01" : null,
          status === "resolved" ? "written_off" : null,
        ],
      );
      return rows[0]!.id;
    };

    it("keeps one about an unresolved disposal obligation, and takes the resolved one", async () => {
      await inTenant(async (c) => {
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.disposal_obligation",
          subjectId: await obligation(c, "open"),
          kind: "disposal_obligation_overdue",
        });
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.disposal_obligation",
          subjectId: await obligation(c, "resolved"),
          kind: "disposal_obligation_overdue",
        });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.keptSubjectOpen).toBe(1);
      expect(await remaining()).toBe(1);
    });

    const outboxRow = async (c: PoolClient, state: "dead" | "delivered"): Promise<string> => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                 source_table, source_id, state)
         VALUES ($1,'Item','create','{}'::jsonb,$2,'crm.visit',gen_random_uuid(),$3) RETURNING id`,
        [TENANT, `crm_ret_${(seq += 1)}`, state],
      );
      return rows[0]!.id;
    };

    it("keeps one about an ERP write still dead, and takes the delivered one", async () => {
      await inTenant(async (c) => {
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.outbox",
          subjectId: await outboxRow(c, "dead"),
          kind: "erp_write_failed",
        });
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.outbox",
          subjectId: await outboxRow(c, "delivered"),
          kind: "erp_write_failed",
        });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.keptSubjectOpen).toBe(1);
    });

    const transfer = async (c: PoolClient, accepted: boolean): Promise<string> => {
      const lot = await c.query<{ id: string }>(
        `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
         VALUES ($1,'item-ret',$2,'2027-01-31','drug_sample') RETURNING id`,
        [TENANT, `LOT-TR-${(seq += 1)}`],
      );
      // The custody trigger (0018) refuses a transfer_out of stock the rep does not hold,
      // correctly — so the fixture receives it first, exactly as the real flow does.
      await c.query(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'receipt',10,'wh-ret','2026-01-09T08:00:00Z')`,
        [TENANT, lot.rows[0]!.id, REP],
      );
      const out = await c.query<{ id: string }>(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, counterparty_rep_profile_id, kind, quantity, occurred_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'transfer_out',3,'2026-01-10T08:00:00Z') RETURNING id`,
        [TENANT, lot.rows[0]!.id, REP, OTHER],
      );
      if (accepted) {
        await c.query(
          `INSERT INTO crm.sample_transaction
             (id, tenant_id, lot_id, rep_profile_id, counterparty_rep_profile_id, kind, quantity,
              occurred_at, transfer_of)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,'transfer_in',3,'2026-01-11T08:00:00Z',$5)`,
          [TENANT, lot.rows[0]!.id, OTHER, REP, out.rows[0]!.id],
        );
      }
      return out.rows[0]!.id;
    };

    it("keeps one about material still in transit, and takes the accepted one", async () => {
      await inTenant(async (c) => {
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.sample_transaction",
          subjectId: await transfer(c, false),
          kind: "sample_transfer_awaiting_acceptance",
        });
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.sample_transaction",
          subjectId: await transfer(c, true),
          kind: "sample_transfer_awaiting_acceptance",
        });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.keptSubjectOpen).toBe(1);
    });

    const plan = async (c: PoolClient, status: "submitted" | "approved"): Promise<string> => {
      const cycle = await c.query<{ id: string }>(
        `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on)
         VALUES ($1,$2,'Cycle','2026-01-01','2026-03-31') RETURNING id`,
        [TENANT, `CY-RET-${(seq += 1)}`],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.call_plan
           (tenant_id, cycle_id, rep_profile_id, status, submitted_by, submitted_at,
            approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$3,'2026-01-05T08:00:00Z',$5,$6) RETURNING id`,
        [
          TENANT,
          cycle.rows[0]!.id,
          REP,
          status,
          status === "approved" ? OTHER : null,
          status === "approved" ? "2026-01-06T08:00:00Z" : null,
        ],
      );
      return rows[0]!.id;
    };

    it("keeps one about a plan still awaiting approval, and takes the approved one", async () => {
      await inTenant(async (c) => {
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.call_plan",
          subjectId: await plan(c, "submitted"),
          kind: "call_plan_submitted",
        });
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.call_plan",
          subjectId: await plan(c, "approved"),
          kind: "call_plan_approved",
        });
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.keptSubjectOpen).toBe(1);
    });

    /**
     * A subject table no branch knows about prunes at the normal horizon and is COUNTED.
     * That is the deliberate opposite of fail-closed: the failure being fixed is
     * unbounded growth, and "keep forever when unsure" would reintroduce it silently.
     * The count is how a missing branch becomes visible instead.
     */
    it("prunes an unrecognised subject table, and says how many", async () => {
      await inTenant((c) =>
        notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.something_new",
          subjectId: "e9000000-0000-4000-8000-00000000000f",
        }),
      );
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.unknownSubjects).toBe(1);
      expect(r.keptSubjectOpen).toBe(0);
    });

    it("treats a subject that no longer exists as closed", async () => {
      // 0021 keeps subject_table/subject_id deliberately un-foreign-keyed so a
      // notification outlives the row it points at. A dangling pointer is not an open
      // obligation.
      await inTenant((c) =>
        notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.disposal_obligation",
          subjectId: "e9000000-0000-4000-8000-0000000000ff",
        }),
      );
      expect((await prune()).deletedRead).toBe(1);
    });
  });

  /**
   * A delivery still pending, in flight or dead is an unresolved operational fact, and
   * `crm.notification_delivery` cascades from the notification — so pruning would erase
   * the evidence that a push failed along with the thing it failed to push.
   */
  describe("an unsettled delivery holds a notification back", () => {
    const endpoint = async (c: PoolClient): Promise<string> => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.notification_endpoint (tenant_id, channel, url, secret_env)
         VALUES ($1,'webhook','https://hooks.example.test/ret','CRM_RET_SECRET') RETURNING id`,
        [TENANT],
      );
      return rows[0]!.id;
    };

    it("keeps one whose webhook is dead, and takes one that was delivered", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c);
        for (const state of ["dead", "delivered"] as const) {
          const id = await notify(c, { createdDaysAgo: 400, read: true });
          await c.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, state)
             VALUES ($1,$2,$3,$4)`,
            [TENANT, id, ep, state],
          );
        }
      });
      const r = await prune();
      expect(r.deletedRead).toBe(1);
      expect(r.keptDeliveryUnsettled).toBe(1);
      expect(await remaining()).toBe(1);
    });

    it("cleans up the delivery rows of what it does take", async () => {
      await inTenant(async (c) => {
        const ep = await endpoint(c);
        const id = await notify(c, { createdDaysAgo: 400, read: true });
        await c.query(
          `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, state, delivered_at)
           VALUES ($1,$2,$3,'delivered',now())`,
          [TENANT, id, ep],
        );
      });
      expect((await prune()).deletedRead).toBe(1);
      const left = await inTenant(async (c) => {
        const { rows } = await c.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        return Number(rows[0]!.n);
      });
      // Via ON DELETE CASCADE (0021). Stated as an assertion because a retention policy
      // that left orphaned delivery rows behind would not actually bound anything.
      expect(left).toBe(0);
    });

    it("does not count a delivery as unsettled when the notification is kept anyway", async () => {
      // subject_open wins; the categories are reported disjointly so the numbers add up.
      await inTenant(async (c) => {
        const ep = await endpoint(c);
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                   source_table, source_id, state)
           VALUES ($1,'Item','create','{}'::jsonb,$2,'crm.visit',gen_random_uuid(),'dead') RETURNING id`,
          [TENANT, `crm_ret_both_${(seq += 1)}`],
        );
        const id = await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.outbox",
          subjectId: rows[0]!.id,
          kind: "erp_write_failed",
        });
        await c.query(
          `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, state)
           VALUES ($1,$2,$3,'dead')`,
          [TENANT, id, ep],
        );
      });
      const r = await prune();
      expect(r.keptSubjectOpen).toBe(1);
      expect(r.keptDeliveryUnsettled).toBe(0);
    });
  });

  describe("a large backlog", () => {
    it("drains in passes and says there is more to do", async () => {
      await inTenant(async (c) => {
        for (let i = 0; i < 5; i += 1) await notify(c, { createdDaysAgo: 400, read: true });
      });
      const first = await prune({ maxRows: 2 });
      expect(first.deletedRead).toBe(2);
      expect(first.moreRemaining).toBe(true);
      expect(await remaining()).toBe(3);

      const second = await prune({ maxRows: 10 });
      expect(second.deletedRead).toBe(3);
      expect(second.moreRemaining).toBe(false);
      expect(await remaining()).toBe(0);
    });

    it("takes the oldest first, so a capped pass is not arbitrary", async () => {
      const ids: string[] = [];
      await inTenant(async (c) => {
        for (const d of [500, 450, 400]) ids.push(await notify(c, { createdDaysAgo: d, read: true }));
      });
      await prune({ maxRows: 1 });
      const left = await inTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          "SELECT id FROM crm.notification WHERE tenant_id = $1 ORDER BY created_at",
          [TENANT],
        );
        return rows.map((r) => r.id);
      });
      expect(left).toEqual([ids[1], ids[2]]);
    });
  });

  describe("the dry run", () => {
    it("reports what a prune would take and what it would hold back, without taking it", async () => {
      await inTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                   source_table, source_id, state)
           VALUES ($1,'Item','create','{}'::jsonb,$2,'crm.visit',gen_random_uuid(),'dead') RETURNING id`,
          [TENANT, `crm_ret_dry_${(seq += 1)}`],
        );
        await notify(c, { createdDaysAgo: 400, read: true });
        await notify(c, {
          createdDaysAgo: 400,
          read: true,
          subjectTable: "crm.outbox",
          subjectId: rows[0]!.id,
          kind: "erp_write_failed",
        });
        await notify(c, { createdDaysAgo: 2, read: true });
      });
      const candidates = await inTenant((c) => prunableNotifications(c, TENANT, { asOf: NOW }));
      // The recent one is not past any horizon, so it is not a candidate at all.
      expect(candidates).toHaveLength(2);
      expect(candidates.filter((x) => x.subject_open)).toHaveLength(1);
      expect(await remaining()).toBe(3);
    });
  });

  it("never reaches another tenant's notifications", async () => {
    // RLS is the mechanism, the explicit tenant_id is the second layer, and the delete
    // goes through a view — so this is worth asserting rather than assuming.
    await inTenant((c) => notify(c, { createdDaysAgo: 400, read: true }));
    const other = "d5000000-0000-4000-8000-00000000000a";
    const r = await withTenantContext(tx, other, (c) => pruneNotifications(c, other, { asOf: NOW }));
    expect(r.deletedRead + r.deletedUnread).toBe(0);
    expect(await remaining()).toBe(1);
  });
});

/**
 * The guard on the prune (migration 0026).
 *
 * The rule that needs proving is not "a big prune is refused" — it is the SHAPE of the
 * decision: a share rather than a row count, so it reads the same at every inbox size; a
 * refusal rather than a trim, because the deletion cannot be undone; measured against
 * what the pass WANTS rather than what tonight's batch would take, which is the one way
 * an inbox could otherwise drain 50,000 rows a night past a ceiling it never approached.
 *
 * Its own tenant, so the counts the guard divides by are not the retention suite's
 * fixtures. A share is a statement about a whole inbox, and a shared one would make every
 * number here depend on a test next door.
 */
describe("the prune guard", () => {
  let pool: Pool;
  let tx: PoolClient;

  const T = TENANT_PRUNE_GUARD;
  const REP = "e6300000-0000-4000-8000-000000000003";

  const inT = <R>(fn: (c: PoolClient) => Promise<R>): Promise<R> => withTenantContext(tx, T, fn);

  const NOW = new Date("2026-06-01T12:00:00Z");
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

  let batch = 0;
  /** Many rows at once: the guard is about counts, and 150 round trips prove nothing extra. */
  const seed = async (
    c: PoolClient,
    opts: { count: number; createdDaysAgo: number; read?: boolean },
  ): Promise<void> => {
    batch += 1;
    await c.query(
      `INSERT INTO crm.notification
         (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key,
          created_at, read_at)
       SELECT $1, $2, 'call_plan_approved', 'info', 's', 'b', $3 || '-' || g,
              $4::timestamptz, CASE WHEN $5::boolean THEN $4::timestamptz END
         FROM generate_series(1, $6::int) g`,
      [T, REP, `pg-${batch}`, daysAgo(opts.createdDaysAgo), opts.read ?? true, opts.count],
    );
  };

  /** 150 past the horizon out of 210 held: 71.4%, well over the default 25% ceiling. */
  const seedOverCeiling = (): Promise<void> =>
    inT(async (c) => {
      await seed(c, { count: 150, createdDaysAgo: 400 });
      await seed(c, { count: 60, createdDaysAgo: 2 });
    });

  const prune = (opts: { maxRows?: number } = {}) =>
    inT((c) => pruneNotifications(c, T, { asOf: NOW, ...opts }));

  const remaining = (): Promise<number> =>
    inT(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.notification WHERE tenant_id = $1",
        [T],
      );
      return Number(rows[0]!.n);
    });

  const clear = async (): Promise<void> => {
    await inT(async (c) => {
      await c.query("DELETE FROM crm.notification WHERE tenant_id = $1", [T]);
      await c.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [T]);
      await c.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [T]);
    });
  };

  beforeAll(async () => {
    pool = appPool();
    tx = await pool.connect();
    await inT(async (c) => {
      await c.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1,$2,'prune-guard-rep','prune-guard-rep','Guard Recipient') ON CONFLICT DO NOTHING`,
        [REP, T],
      );
    });
  });

  afterAll(async () => {
    await clear();
    await inT((c) => c.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [T]));
    tx?.release();
    await pool?.end();
  });

  beforeEach(clear);

  describe("the settings", () => {
    it("defaults to a quarter of the inbox, not bothering under a hundred rows, no override", async () => {
      expect(await inT((c) => notificationPruneGuard(c, T))).toEqual({
        prune_max_share_percent: 25,
        prune_guard_floor_rows: 100,
        prune_guard_override_by: null,
        prune_guard_override_granted_at: null,
        prune_guard_override_until: null,
      });
    });

    it("changes the ceiling without disturbing the floor", async () => {
      const g = await inT((c) => setNotificationPruneGuard(c, T, { maxSharePercent: 40 }));
      expect(g.prune_max_share_percent).toBe(40);
      expect(g.prune_guard_floor_rows).toBe(100);
    });

    /** A ceiling that permits 100% is not a ceiling — and stored, it would not look like
     *  a disabled guard, it would look like a number somebody chose. */
    it("refuses a ceiling of 100, and one of 0", async () => {
      await expect(
        inT((c) => setNotificationPruneGuard(c, T, { maxSharePercent: 100 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
      await expect(
        inT((c) => setNotificationPruneGuard(c, T, { maxSharePercent: 0 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    it("refuses a floor outside the allowed range", async () => {
      await expect(
        inT((c) => setNotificationPruneGuard(c, T, { guardFloorRows: -1 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
      await expect(
        inT((c) => setNotificationPruneGuard(c, T, { guardFloorRows: 1_000_001 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });
  });

  describe("a pass over the ceiling", () => {
    it("deletes nothing at all, and says why", async () => {
      await seedOverCeiling();
      const r = await prune();
      expect(r.refused).toBe(true);
      expect(r.deletedRead).toBe(0);
      expect(r.deletedUnread).toBe(0);
      expect(r.prunableTotal).toBe(150);
      expect(r.inboxTotal).toBe(210);
      expect(r.sharePercent).toBe(71.4);
      expect(r.guard.prune_max_share_percent).toBe(25);
      expect(r.refusalReason).toMatch(/71\.4% of this tenant's inbox of 210, over its 25% ceiling/);
      // The whole point: the rows are still there to look at.
      expect(await remaining()).toBe(210);
      // And the operator is told there is work outstanding, not that there was none.
      expect(r.moreRemaining).toBe(true);
    });

    /**
     * The interaction the batch cap makes easy to get wrong. Five rows is 2.4% of this
     * inbox — under any ceiling — so a guard that judged the BATCH would wave this
     * through, and the next forty passes with it, until the inbox was empty.
     */
    it("judges what the pass wants, not what tonight's batch would take", async () => {
      await seedOverCeiling();
      const r = await prune({ maxRows: 5 });
      expect(r.refused).toBe(true);
      expect(r.prunableTotal).toBe(150);
      expect(await remaining()).toBe(210);
    });

    it("still reports what it would have held back", async () => {
      await inT(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                   source_table, source_id, state)
           VALUES ($1,'Item','create','{}'::jsonb,'crm_pg_1','crm.visit',gen_random_uuid(),'dead')
           RETURNING id`,
          [T],
        );
        await seed(c, { count: 150, createdDaysAgo: 400 });
        await c.query(
          `INSERT INTO crm.notification
             (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key,
              subject_table, subject_id, created_at, read_at)
           VALUES ($1,$2,'erp_write_failed','info','s','b','pg-open','crm.outbox',$3,$4,$4)`,
          [T, REP, rows[0]!.id, daysAgo(400)],
        );
      });
      const r = await prune();
      expect(r.refused).toBe(true);
      // The exemptions are facts about the candidate set, not about whether the delete
      // ran — a refusal that blanked them would hide the shape of the backlog.
      expect(r.keptSubjectOpen).toBe(1);
      expect(r.prunableTotal).toBe(150);
    });
  });

  describe("a pass within it", () => {
    it("runs normally, and is not a refusal", async () => {
      await inT(async (c) => {
        await setNotificationPruneGuard(c, T, { guardFloorRows: 5 });
        await seed(c, { count: 20, createdDaysAgo: 400 });
        await seed(c, { count: 80, createdDaysAgo: 2 });
      });
      const r = await prune();
      expect(r.refused).toBe(false);
      expect(r.refusalReason).toBeNull();
      expect(r.overridden).toBe(false);
      expect(r.deletedRead).toBe(20);
      expect(r.sharePercent).toBe(20);
      expect(await remaining()).toBe(80);
    });

    /** Hitting the batch cap is a throttle doing its job (0024), not a guard tripping. */
    it("reports moreRemaining when it hits the batch cap, and does not call that a refusal", async () => {
      await inT(async (c) => {
        await setNotificationPruneGuard(c, T, { guardFloorRows: 5 });
        await seed(c, { count: 20, createdDaysAgo: 400 });
        await seed(c, { count: 80, createdDaysAgo: 2 });
      });
      const r = await prune({ maxRows: 5 });
      expect(r.refused).toBe(false);
      expect(r.deletedRead).toBe(5);
      expect(r.moreRemaining).toBe(true);
    });

    /**
     * Beneath the floor the share is not consulted at all. Eight notifications of which
     * eight are past their horizon is 100% of an inbox with nothing in it, and refusing
     * that nightly would teach an operator to override the guard by reflex.
     */
    it("does not consult the share beneath the floor", async () => {
      await inT(async (c) => {
        await setNotificationPruneGuard(c, T, { maxSharePercent: 1, guardFloorRows: 10 });
        await seed(c, { count: 8, createdDaysAgo: 400 });
      });
      const r = await prune();
      expect(r.refused).toBe(false);
      expect(r.sharePercent).toBe(100);
      expect(r.deletedRead).toBe(8);
    });
  });

  describe("the override", () => {
    it("lets the refused pass through, and says that it did", async () => {
      await seedOverCeiling();
      expect((await prune()).refused).toBe(true);
      await inT((c) => grantPruneGuardOverride(c, T, { grantedBy: "ops@example.test", hours: 24 }));
      const r = await prune();
      expect(r.refused).toBe(false);
      expect(r.overridden).toBe(true);
      expect(r.deletedRead).toBe(150);
      expect(r.guard.prune_guard_override_by).toBe("ops@example.test");
      expect(await remaining()).toBe(60);
    });

    it("brings the refusal straight back when revoked", async () => {
      await seedOverCeiling();
      await inT((c) => grantPruneGuardOverride(c, T, { grantedBy: "ops@example.test", hours: 24 }));
      await inT((c) => revokePruneGuardOverride(c, T));
      const r = await prune();
      expect(r.refused).toBe(true);
      expect(r.guard.prune_guard_override_until).toBeNull();
      expect(await remaining()).toBe(210);
    });

    /**
     * The property that stops it being an accidental permanent default: it runs out. The
     * window is written directly here because the grant anchors itself to `now()` — a
     * window already behind the prune's clock is precisely what the setter cannot produce.
     */
    it("stops letting passes through once the window has closed", async () => {
      await seedOverCeiling();
      await inT(async (c) => {
        await c.query(
          `UPDATE crm.notification_policy
              SET prune_guard_override_by         = 'ops@example.test',
                  prune_guard_override_granted_at = $2,
                  prune_guard_override_until      = $3
            WHERE tenant_id = $1`,
          [T, daysAgo(3), daysAgo(2)],
        );
      });
      const r = await prune();
      expect(r.refused).toBe(true);
      expect(r.overridden).toBe(false);
      expect(await remaining()).toBe(210);
    });

    it("refuses a window longer than a week, and one of no length at all", async () => {
      await expect(
        inT((c) => grantPruneGuardOverride(c, T, { grantedBy: "ops@example.test", hours: 200 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
      await expect(
        inT((c) => grantPruneGuardOverride(c, T, { grantedBy: "ops@example.test", hours: 0 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    it("refuses one that names nobody", async () => {
      await expect(
        inT((c) => grantPruneGuardOverride(c, T, { grantedBy: "", hours: 24 })),
      ).rejects.toBeInstanceOf(InvalidRetentionError);
    });

    /** `overridden` means the guard was overridden, not that a window happens to be open. */
    it("is not reported as overriding a pass that was within the ceiling anyway", async () => {
      await inT(async (c) => {
        await setNotificationPruneGuard(c, T, { guardFloorRows: 5 });
        await seed(c, { count: 20, createdDaysAgo: 400 });
        await seed(c, { count: 80, createdDaysAgo: 2 });
        await grantPruneGuardOverride(c, T, { grantedBy: "ops@example.test", hours: 24 });
      });
      const r = await prune();
      expect(r.refused).toBe(false);
      expect(r.overridden).toBe(false);
      expect(r.deletedRead).toBe(20);
    });
  });
});
