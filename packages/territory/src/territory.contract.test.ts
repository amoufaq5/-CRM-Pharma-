import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import {
  accountOwnersOn,
  assignAccount,
  assignRep,
  canSeeAccount,
  createTerritory,
  endRepAssignment,
  reassignAccount,
  setTerritoryParent,
  visibleAccountIds,
  visibleTerritoryIds,
} from "./store.js";
import { InvalidDateRangeError, OverlappingAssignmentError, TerritoryCycleError } from "./errors.js";

// Ids come from @crm/db/testing, which reserves a block per test file — files
// share a database, so picking your own is how two suites end up seeing each
// other's rows.
import { TENANT_TERRITORY_A as TENANT, TENANT_TERRITORY_B as OTHER } from "@crm/db/testing";

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

describe("territories and rep assignment", () => {
  let p: Pool;
  let c: PoolClient;
  let rep1 = "";
  let rep2 = "";
  let manager = "";
  let gulf = "";
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
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(c, t, async (tx) => {
        await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [t]);
      });
    }
    await withTenantContext(c, TENANT, async (tx) => {
      const reps = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1,'rep1','E1','Rep One'), ($1,'rep2','E2','Rep Two'), ($1,'mgr','E3','Manager')
         RETURNING id`,
        [TENANT],
      );
      [rep1, rep2, manager] = reps.rows.map((r) => r.id) as [string, string, string];

      gulf = (await createTerritory(tx, TENANT, { code: "GULF", name: "Gulf District" })).id;
      auh = (await createTerritory(tx, TENANT, { code: "AUH", name: "Abu Dhabi", parentId: gulf })).id;
      dxb = (await createTerritory(tx, TENANT, { code: "DXB", name: "Dubai", parentId: gulf })).id;

      await assignRep(tx, TENANT, { territoryId: auh, repProfileId: rep1, validFrom: "2026-01-01" });
      await assignRep(tx, TENANT, { territoryId: dxb, repProfileId: rep2, validFrom: "2026-01-01" });
      await assignRep(tx, TENANT, { territoryId: gulf, repProfileId: manager, role: "manager", validFrom: "2026-01-01" });

      await assignAccount(tx, TENANT, { erpAccountId: "acct_auh", territoryId: auh, validFrom: "2026-01-01" });
      await assignAccount(tx, TENANT, { erpAccountId: "acct_dxb", territoryId: dxb, validFrom: "2026-01-01" });
    });
  });

  describe("scoping — what the ERP cannot do at all", () => {
    it("a rep sees only their own territory's accounts", async () => {
      // The ERP's equivalent query returns every account in the tenant, because
      // `requiresAbac` is computed and discarded (report R2).
      const seen = await withTenantContext(c, TENANT, (tx) => visibleAccountIds(tx, rep1, "2026-06-01"));
      expect(seen).toEqual(["acct_auh"]);
    });

    it("a manager sees the whole subtree beneath their territory", async () => {
      const seen = await withTenantContext(c, TENANT, (tx) => visibleAccountIds(tx, manager, "2026-06-01"));
      expect(seen).toEqual(["acct_auh", "acct_dxb"]);
    });

    it("a PRIMARY rep does NOT inherit child territories", async () => {
      // Only a manager assignment descends. A primary rep on a parent covers the
      // parent, not everything under it — otherwise every hierarchy edit would
      // silently widen someone's access.
      await withTenantContext(c, TENANT, (tx) =>
        assignRep(tx, TENANT, { territoryId: gulf, repProfileId: rep1, role: "secondary", validFrom: "2026-01-01" }),
      );
      const seen = await withTenantContext(c, TENANT, (tx) => visibleTerritoryIds(tx, rep1, "2026-06-01"));
      expect(new Set(seen)).toEqual(new Set([auh, gulf]));
      expect(seen).not.toContain(dxb);
    });

    it("answers the single-account authorisation question", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        expect(await canSeeAccount(tx, rep1, "acct_auh", "2026-06-01")).toBe(true);
        expect(await canSeeAccount(tx, rep1, "acct_dxb", "2026-06-01")).toBe(false);
        expect(await canSeeAccount(tx, rep1, "acct_unknown", "2026-06-01")).toBe(false);
      });
    });

    it("a rep with no assignment sees nothing — it fails closed", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await tx.query("DELETE FROM crm.territory_assignment WHERE rep_profile_id = $1", [rep1]);
        expect(await visibleAccountIds(tx, rep1, "2026-06-01")).toEqual([]);
      });
    });
  });

  describe("effective dating — the question the ERP overwrites", () => {
    it("sees nothing before the assignment starts", async () => {
      const seen = await withTenantContext(c, TENANT, (tx) => visibleAccountIds(tx, rep1, "2025-12-31"));
      expect(seen).toEqual([]);
    });

    it("stops seeing the account after coverage ends", async () => {
      await withTenantContext(c, TENANT, (tx) =>
        endRepAssignment(tx, TENANT, { territoryId: auh, repProfileId: rep1, endDate: "2026-07-01" }),
      );
      await withTenantContext(c, TENANT, async (tx) => {
        // valid_to is exclusive: the 30th was the last covered day.
        expect(await visibleAccountIds(tx, rep1, "2026-06-30")).toEqual(["acct_auh"]);
        expect(await visibleAccountIds(tx, rep1, "2026-07-01")).toEqual([]);
      });
    });

    it("reassigns an account atomically and KEEPS the history", async () => {
      await withTenantContext(c, TENANT, (tx) =>
        reassignAccount(tx, TENANT, { erpAccountId: "acct_auh", toTerritoryId: dxb, effectiveFrom: "2026-07-01" }),
      );
      await withTenantContext(c, TENANT, async (tx) => {
        // After the move it is rep2's.
        expect(await visibleAccountIds(tx, rep2, "2026-07-01")).toEqual(["acct_auh", "acct_dxb"]);
        expect(await visibleAccountIds(tx, rep1, "2026-07-01")).toEqual([]);
        // And BEFORE the move it is still rep1's — which is the whole point.
        expect(await visibleAccountIds(tx, rep1, "2026-06-30")).toEqual(["acct_auh"]);
      });
    });

    it("answers who owned an account on a past date", async () => {
      // The incentive run's question. The ERP cannot answer it at all: it keeps
      // no assignment history, so a reassignment erases who held the customer
      // when the order landed.
      await withTenantContext(c, TENANT, (tx) =>
        reassignAccount(tx, TENANT, { erpAccountId: "acct_auh", toTerritoryId: dxb, effectiveFrom: "2026-07-01" }),
      );
      await withTenantContext(c, TENANT, async (tx) => {
        const q2 = await accountOwnersOn(tx, "acct_auh", "2026-05-15");
        const q3 = await accountOwnersOn(tx, "acct_auh", "2026-08-15");
        expect(q2.map((o) => o.rep_profile_id)).toContain(rep1);
        expect(q2.map((o) => o.rep_profile_id)).not.toContain(rep2);
        expect(q3.map((o) => o.rep_profile_id)).toContain(rep2);
      });
    });

    it("leaves an already-bounded assignment alone when ending coverage", async () => {
      // A row that was deliberately bounded is not ours to move.
      await withTenantContext(c, TENANT, async (tx) => {
        await tx.query("DELETE FROM crm.territory_assignment WHERE rep_profile_id = $1", [rep1]);
        await assignRep(tx, TENANT, {
          territoryId: auh, repProfileId: rep1, validFrom: "2026-01-01", validTo: "2026-03-01",
        });
        const closed = await endRepAssignment(tx, TENANT, {
          territoryId: auh, repProfileId: rep1, endDate: "2026-09-01",
        });
        expect(closed).toBe(0);
      });
    });
  });

  describe("constraints the database enforces", () => {
    it("REFUSES an account in two territories on the same day", async () => {
      // Two overlapping rows mean two reps both credibly claim the same
      // customer's sales and the commission run pays both.
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          assignAccount(tx, TENANT, { erpAccountId: "acct_auh", territoryId: dxb, validFrom: "2026-03-01" }),
        ),
      ).rejects.toBeInstanceOf(OverlappingAssignmentError);
    });

    it("ALLOWS a non-overlapping later assignment", async () => {
      await withTenantContext(c, TENANT, async (tx) => {
        await tx.query("UPDATE crm.account_assignment SET valid_to = '2026-07-01' WHERE erp_account_id = 'acct_auh'");
        await expect(
          assignAccount(tx, TENANT, { erpAccountId: "acct_auh", territoryId: dxb, validFrom: "2026-07-01" }),
        ).resolves.toBeDefined();
      });
    });

    it("refuses the same rep holding the same role on a territory twice over", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          assignRep(tx, TENANT, { territoryId: auh, repProfileId: rep1, validFrom: "2026-06-01" }),
        ),
      ).rejects.toBeInstanceOf(OverlappingAssignmentError);
    });

    it("ALLOWS two different reps on one territory — co-coverage is legitimate", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          assignRep(tx, TENANT, { territoryId: auh, repProfileId: rep2, role: "secondary", validFrom: "2026-01-01" }),
        ),
      ).resolves.toBeDefined();
    });

    it("refuses a hierarchy cycle rather than hanging every scoping query later", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) => setTerritoryParent(tx, TENANT, gulf, auh)),
      ).rejects.toBeInstanceOf(TerritoryCycleError);
    });

    it("refuses a territory as its own parent", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) => setTerritoryParent(tx, TENANT, gulf, gulf)),
      ).rejects.toThrow();
    });

    it("refuses a malformed date before touching the database", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) =>
          assignAccount(tx, TENANT, { erpAccountId: "acct_x", territoryId: auh, validFrom: "01/01/2026" }),
        ),
      ).rejects.toBeInstanceOf(InvalidDateRangeError);
    });

    it("refuses deleting a territory that still has assignments", async () => {
      await expect(
        withTenantContext(c, TENANT, (tx) => tx.query("DELETE FROM crm.territory WHERE id = $1", [auh])),
      ).rejects.toThrow(/violates foreign key/);
    });
  });

  describe("tenant isolation", () => {
    it("scoping cannot reach across tenants", async () => {
      await withTenantContext(c, OTHER, async (tx) => {
        const t = await createTerritory(tx, OTHER, { code: "GULF", name: "Other Gulf" });
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
           VALUES ($1,'o','E9','Other Rep') RETURNING id`,
          [OTHER],
        );
        const otherRep = rows[0]!.id;
        await assignRep(tx, OTHER, { territoryId: t.id, repProfileId: otherRep, validFrom: "2026-01-01" });
        await assignAccount(tx, OTHER, { erpAccountId: "acct_auh", territoryId: t.id, validFrom: "2026-01-01" });

        // Same account id as tenant A's, deliberately: the ids are only unique
        // within a tenant, and the other tenant's rows must be invisible.
        expect(await visibleAccountIds(tx, otherRep, "2026-06-01")).toEqual(["acct_auh"]);
        expect(await visibleAccountIds(tx, rep1, "2026-06-01")).toEqual([]);
      });
    });

    it("the same territory CODE may exist in two tenants", async () => {
      const codes = await withTenantContext(c, OTHER, async (tx) => {
        await createTerritory(tx, OTHER, { code: "GULF", name: "Other Gulf" });
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.territory WHERE code = 'GULF'",
        );
        return Number(rows[0]?.n);
      });
      // Uniqueness is per tenant, so each tenant keeps its own naming.
      expect(codes).toBe(1);
    });
  });
});
