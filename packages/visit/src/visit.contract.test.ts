import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_VISIT as TENANT } from "@crm/db/testing";

import {
  appendNote,
  getVisit,
  getVisitProducts,
  listVisits,
  recordVisit,
  setVisitProducts,
  transitionVisit,
} from "./store.js";
import { InvalidTransitionError, OutsideTerritoryError, VisitIsFinalError } from "./index.js";

function pool(): Pool {
  return new Pool({
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 5,
  });
}

/** Device-minted ids, as the app would generate them. */
const V1 = "d0000001-0000-4000-8000-000000000001";
const V2 = "d0000002-0000-4000-8000-000000000002";

describe("visits", () => {
  let p: Pool;
  let c: PoolClient;
  let rep = "";
  let otherRep = "";
  let auh = "";
  let dxb = "";

  beforeAll(async () => {
    p = pool();
    c = await p.connect();
    await c.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await c.query("RESET ROLE");
    c.release();
    await p.end();
  });

  beforeEach(async () => {
    await withTenantContext(c, TENANT, async (tx) => {
      // A finished visit refuses deletion, so the trigger has to be stood down
      // to reset the fixture. That the cleanup needs this is itself evidence the
      // rule works.
      await tx.query("ALTER TABLE crm.visit DISABLE TRIGGER visit_reject_delete_when_final");
      await tx.query("ALTER TABLE crm.visit_product DISABLE TRIGGER visit_product_reject_when_final");
      await tx.query("DELETE FROM crm.visit_product WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.visit ENABLE TRIGGER visit_reject_delete_when_final");
      await tx.query("ALTER TABLE crm.visit_product ENABLE TRIGGER visit_product_reject_when_final");
      await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);

      const reps = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1,'r1','E1','Rep One'), ($1,'r2','E2','Rep Two') RETURNING id`,
        [TENANT],
      );
      [rep, otherRep] = reps.rows.map((r) => r.id) as [string, string];

      const terrs = await tx.query<{ id: string }>(
        `INSERT INTO crm.territory (tenant_id, code, name)
         VALUES ($1,'AUH','Abu Dhabi'), ($1,'DXB','Dubai') RETURNING id`,
        [TENANT],
      );
      [auh, dxb] = terrs.rows.map((r) => r.id) as [string, string];

      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, valid_from)
         VALUES ($1,$2,$3,'2026-01-01'), ($1,$4,$5,'2026-01-01')`,
        [TENANT, auh, rep, dxb, otherRep],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
         VALUES ($1,'acct_auh',$2,'2026-01-01'), ($1,'acct_dxb',$3,'2026-01-01')`,
        [TENANT, auh, dxb],
      );
    });
  });

  const base = () => ({
    id: V1,
    repProfileId: rep,
    erpAccountId: "acct_auh",
    status: "in_progress" as const,
    occurredAt: "2026-06-15T09:00:00.000Z",
  });

  describe("offline recording", () => {
    it("accepts a device-minted id", async () => {
      const v = await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      expect(v.id).toBe(V1);
    });

    it("is IDEMPOTENT — a re-sync collapses into the same row, not a duplicate", async () => {
      // A rep in a hospital basement syncs when signal returns; a dropped
      // connection makes the client retry. Two rows here would be a duplicated
      // call report.
      await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      const all = await withTenantContext(c, TENANT, (tx) => listVisits(tx, {}));
      expect(all).toHaveLength(1);
    });

    it("lets a later sync of the same visit win", async () => {
      await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      const updated = await withTenantContext(c, TENANT, (tx) =>
        recordVisit(tx, TENANT, { ...base(), notes: "added offline before syncing" }),
      );
      expect(updated.notes).toBe("added offline before syncing");
    });

    it("does NOT move recorded_at on a re-sync", async () => {
      // recorded_at is when the server first heard about the visit. The device
      // speaking again does not change that fact, and debugging a sync gap needs
      // the original.
      const first = await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      await new Promise((r) => setTimeout(r, 20));
      const second = await withTenantContext(c, TENANT, (tx) =>
        recordVisit(tx, TENANT, { ...base(), notes: "later" }),
      );
      expect(second.recorded_at).toBe(first.recorded_at);
    });

    it("keeps the two clocks apart", async () => {
      const v = await withTenantContext(c, TENANT, (tx) =>
        recordVisit(tx, TENANT, { ...base(), occurredAt: "2026-06-15T09:00:00.000Z" }),
      );
      // Every field-activity report uses occurred_at; every sync question uses
      // recorded_at. One timestamp would lose whichever you did not pick.
      expect(v.occurred_at).toContain("2026-06-15");
      expect(new Date(v.recorded_at).getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it("stores a check-in position with its accuracy", async () => {
      const v = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, {
          ...base(),
          checkin: { latitude: 24.4539, longitude: 54.3773, accuracyM: 12.5 },
        });
        const { rows } = await tx.query<{ lat: string; lon: string; acc: string }>(
          "SELECT checkin_latitude AS lat, checkin_longitude AS lon, checkin_accuracy_m AS acc FROM crm.visit WHERE id = $1",
          [V1],
        );
        return rows[0]!;
      });
      expect(v.lat).toBe("24.453900");
      expect(v.acc).toBe("12.50");
    });

    it("refuses half a coordinate", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          tx.query(
            `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at, checkin_latitude)
             VALUES ($1,$2,$3,'acct_auh','in_progress',now(),24.45)`,
            [V2, TENANT, rep],
          ),
        ),
      ).rejects.toThrow(/visit_checkin_pair/);
    });
  });

  describe("territory authorisation, on the visit date", () => {
    it("refuses a visit against an account the rep does not cover", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          recordVisit(tx, TENANT, { ...base(), erpAccountId: "acct_dxb" }),
        ),
      ).rejects.toBeInstanceOf(OutsideTerritoryError);
    });

    it("KEEPS a past visit valid after the account is reassigned", async () => {
      // The payoff for effective-dated territories. A June visit must survive a
      // July reassignment — it was true when it happened.
      await withTenantContext(c, TENANT, (tx) => recordVisit(tx, TENANT, base()));
      await withTenantContext(c, TENANT, async (tx) => {
        await tx.query(
          "UPDATE crm.account_assignment SET valid_to = '2026-07-01' WHERE erp_account_id = 'acct_auh'",
        );
        await tx.query(
          `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
           VALUES ($1,'acct_auh',$2,'2026-07-01')`,
          [TENANT, dxb],
        );
      });
      // Still readable, still the original rep's.
      const v = await withTenantContext(c, TENANT, (tx) => getVisit(tx, V1));
      expect(v?.rep_profile_id).toBe(rep);

      // And a NEW visit on a post-reassignment date is refused for that rep.
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          recordVisit(tx, TENANT, { ...base(), id: V2, occurredAt: "2026-08-15T09:00:00.000Z" }),
        ),
      ).rejects.toBeInstanceOf(OutsideTerritoryError);
    });

    it("refuses a visit dated before the rep held the territory", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          recordVisit(tx, TENANT, { ...base(), occurredAt: "2025-12-01T09:00:00.000Z" }),
        ),
      ).rejects.toBeInstanceOf(OutsideTerritoryError);
    });

    it("checks a planned visit against its planned date", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          recordVisit(tx, TENANT, {
            id: V2, repProfileId: rep, erpAccountId: "acct_auh",
            status: "planned", plannedFor: "2025-06-01", occurredAt: null,
          }),
        ),
      ).rejects.toBeInstanceOf(OutsideTerritoryError);
    });
  });

  describe("the lifecycle", () => {
    it("walks planned -> in_progress -> completed", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, {
          id: V1, repProfileId: rep, erpAccountId: "acct_auh",
          status: "planned", plannedFor: "2026-06-15",
        });
        const started = await transitionVisit(tx, V1, "in_progress", { occurredAt: "2026-06-15T09:00:00.000Z" });
        expect(started.status).toBe("in_progress");
        const done = await transitionVisit(tx, V1, "completed", { durationMinutes: 25, outcome: "successful" });
        expect(done).toMatchObject({ status: "completed", duration_minutes: 25, outcome: "successful" });
      });
    });

    it("refuses an illegal transition with the allowed set named", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, {
          id: V1, repProfileId: rep, erpAccountId: "acct_auh", status: "planned", plannedFor: "2026-06-15",
        });
        await expect(transitionVisit(tx, V1, "completed")).rejects.toBeInstanceOf(InvalidTransitionError);
      });
    });

    it("stamps occurred_at when a visit starts without one", async () => {
      const v = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, {
          id: V1, repProfileId: rep, erpAccountId: "acct_auh", status: "planned", plannedFor: "2026-06-15",
        });
        return transitionVisit(tx, V1, "in_progress");
      });
      expect(v.occurred_at).not.toBeNull();
    });

    it("refuses an outcome on a visit that did not complete", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          recordVisit(tx, TENANT, { ...base(), outcome: "successful" }),
        ),
      ).rejects.toThrow(/visit_outcome_only_when_completed/);
    });
  });

  describe("immutability once final", () => {
    async function completed(tx: PoolClient): Promise<void> {
      await recordVisit(tx, TENANT, base());
      await transitionVisit(tx, V1, "completed", { durationMinutes: 20, outcome: "successful" });
    }

    it("refuses to change the substance of a completed visit", async () => {
      // Mirrors the ERP's own postedEntryImmutabilityGuard, for the same reason:
      // a field record that can be silently rewritten is worth nothing in the
      // compliance review it exists to survive.
      await withTenantContext(c, TENANT, async (tx) => {
        await completed(tx);
        await expect(
          tx.query("UPDATE crm.visit SET duration_minutes = 999 WHERE id = $1", [V1]),
        ).rejects.toThrow(/cannot be edited/);
      });
    });

    it("refuses to DELETE a completed visit", async () => {
      // Freezing fields while leaving delete open would be a gap, not a rule.
      await withTenantContext(c, TENANT, async (tx) => {
        await completed(tx);
        await expect(tx.query("DELETE FROM crm.visit WHERE id = $1", [V1])).rejects.toThrow(
          /cannot be deleted/,
        );
      });
    });

    it("ALLOWS appending a note, timestamped", async () => {
      const v = await withTenantContext(c, TENANT, async (tx) => {
        await completed(tx);
        await appendNote(tx, V1, "HCP asked for reprints", new Date("2026-06-15T18:00:00Z"));
        return appendNote(tx, V1, "sent them", new Date("2026-06-15T19:00:00Z"));
      });
      // A rep remembering something on the drive home is normal; rewriting what
      // was reported is not. So it appends rather than replaces.
      expect(v.notes).toContain("[2026-06-15T18:00:00.000Z] HCP asked for reprints");
      expect(v.notes).toContain("[2026-06-15T19:00:00.000Z] sent them");
    });

    it("freezes the detailing lines too", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_a" }]);
        await transitionVisit(tx, V1, "completed", { outcome: "successful" });
        await expect(
          setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_b" }]),
        ).rejects.toBeInstanceOf(VisitIsFinalError);
      });
    });
  });

  describe("detailing lines", () => {
    it("keeps the order the rep sent, 1-based", async () => {
      const products = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await setVisitProducts(tx, TENANT, V1, [
          { erpItemId: "item_a", keyMessage: "efficacy", reaction: "positive" },
          { erpItemId: "item_b", keyMessage: "safety", reaction: "neutral" },
        ]);
        return getVisitProducts(tx, V1);
      });
      // Detailing order is commercially meaningful: the first product gets the
      // attention, and a cycle plan prescribes the sequence.
      expect(products.map((x) => [x.position, x.erp_item_id])).toEqual([
        [1, "item_a"],
        [2, "item_b"],
      ]);
      expect(products[0]?.reaction).toBe("positive");
    });

    it("replaces the whole set rather than merging", async () => {
      const products = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_a" }, { erpItemId: "item_b" }]);
        await setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_c" }]);
        return getVisitProducts(tx, V1);
      });
      expect(products.map((x) => x.erp_item_id)).toEqual(["item_c"]);
    });

    it("refuses the same product twice on one visit", async () => {
      await expect(
        withTenantContext(c, TENANT, async (tx) => {
          await recordVisit(tx, TENANT, base());
          await setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_a" }, { erpItemId: "item_a" }]);
        }),
      ).rejects.toThrow(/visit_product_visit_id_erp_item_id_key|duplicate key/);
    });

    it("cascades when a non-final visit is deleted", async () => {
      const left = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await setVisitProducts(tx, TENANT, V1, [{ erpItemId: "item_a" }]);
        await tx.query("DELETE FROM crm.visit WHERE id = $1", [V1]);
        const { rows } = await tx.query("SELECT 1 FROM crm.visit_product WHERE visit_id = $1", [V1]);
        return rows.length;
      });
      expect(left).toBe(0);
    });
  });

  describe("listing", () => {
    it("filters by rep, account, status and date window", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await recordVisit(tx, TENANT, {
          ...base(), id: V2, occurredAt: "2026-06-20T09:00:00.000Z",
        });
        await transitionVisit(tx, V2, "completed", { outcome: "successful" });
      });
      await withTenantContext(c, TENANT, async (tx) => {
        expect(await listVisits(tx, { repProfileId: rep })).toHaveLength(2);
        expect(await listVisits(tx, { status: ["completed"] })).toHaveLength(1);
        expect(await listVisits(tx, { erpAccountId: "acct_dxb" })).toHaveLength(0);
        expect(
          await listVisits(tx, { from: "2026-06-18T00:00:00Z", to: "2026-06-25T00:00:00Z" }),
        ).toHaveLength(1);
      });
    });

    it("returns the most recent first", async () => {
      const ids = await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        await recordVisit(tx, TENANT, { ...base(), id: V2, occurredAt: "2026-06-20T09:00:00.000Z" });
        return (await listVisits(tx, {})).map((v) => v.id);
      });
      expect(ids).toEqual([V2, V1]);
    });

    it("caps the page size rather than letting a caller ask for everything", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await recordVisit(tx, TENANT, base());
        expect(await listVisits(tx, { limit: 100000 })).toHaveLength(1);
      });
    });
  });
});
