import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_SUPERVISION as TENANT, testPool } from "@crm/db/testing";

import { canSupervise, managedRepIds, teamRoster } from "./supervision.js";

/**
 * Supervision against a real Postgres.
 *
 * This is an authorisation boundary, so the tests that matter most are the negative
 * ones: a peer manager must see nothing, and a manager's reach must follow the
 * hierarchy and the calendar rather than the fact of sharing a tenant. RLS cannot help
 * here — everyone below is in the same tenant, so the policy admits every row and
 * `crm.rep_can_supervise` is the only thing between a manager and a peer's data.
 */
describe("supervision", () => {
  let pool: Pool;
  let client: PoolClient;

  const REGION = "db100000-0000-4000-8000-000000000001";
  const TERR_A = "db200000-0000-4000-8000-000000000002";
  const TERR_B = "db300000-0000-4000-8000-000000000003";
  const ELSEWHERE = "db400000-0000-4000-8000-000000000004";

  const REP_A = "dc100000-0000-4000-8000-000000000001";
  const REP_B = "dc200000-0000-4000-8000-000000000002";
  const DISTRICT = "dc300000-0000-4000-8000-000000000003";
  const REGIONAL = "dc400000-0000-4000-8000-000000000004";
  const PEER = "dc500000-0000-4000-8000-000000000005";
  const COLOCATED = "dc600000-0000-4000-8000-000000000006";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [REP_A, "A"],
        [REP_B, "B"],
        [DISTRICT, "District"],
        [REGIONAL, "Regional"],
        [PEER, "Peer"],
        [COLOCATED, "Colocated"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, `sup-${n}`],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES
           ($1,$5,'SUP-REGION','Region'), ($2,$5,'SUP-A','A'), ($3,$5,'SUP-B','B'), ($4,$5,'SUP-ELSE','Elsewhere')
         ON CONFLICT DO NOTHING`,
        [REGION, TERR_A, TERR_B, ELSEWHERE, TENANT],
      );
      await tx.query(`UPDATE crm.territory SET parent_id = $1 WHERE id IN ($2, $3)`, [REGION, TERR_A, TERR_B]);
    });
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  const assign = (
    tx: PoolClient,
    territoryId: string,
    repProfileId: string,
    role: "primary" | "secondary" | "manager",
    from = "2026-01-01",
    to: string | null = null,
  ): Promise<unknown> =>
    tx.query(
      `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from, valid_to)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [TENANT, territoryId, repProfileId, role, from, to],
    );

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      // The standing shape: two reps in two territories under one region, a district
      // manager over territory A only, a regional manager over the whole region, a peer
      // manager over somewhere else entirely, and a rep co-located with A who manages
      // nothing.
      await assign(tx, TERR_A, REP_A, "primary");
      await assign(tx, TERR_B, REP_B, "primary");
      await assign(tx, TERR_A, DISTRICT, "manager");
      await assign(tx, REGION, REGIONAL, "manager");
      await assign(tx, ELSEWHERE, PEER, "manager");
      await assign(tx, TERR_A, COLOCATED, "primary");
    });
  });

  describe("managedRepIds", () => {
    it("reaches down the hierarchy from a regional manager", async () => {
      await inTenant(async (tx) => {
        const ids = await managedRepIds(tx, REGIONAL);
        expect([...ids].sort()).toEqual([REP_A, REP_B, DISTRICT, COLOCATED].sort());
      });
    });

    it("gives a district manager their own territory only", async () => {
      await inTenant(async (tx) => {
        const ids = await managedRepIds(tx, DISTRICT);
        expect([...ids].sort()).toEqual([REP_A, COLOCATED].sort());
        expect(ids).not.toContain(REP_B);
      });
    });

    /**
     * Supervision follows the hierarchy, not co-location. A rep assigned `primary` to the
     * same territory as another is a colleague, not a supervisor — and if sharing a
     * territory were enough, every rep would be able to read every neighbour's numbers.
     */
    it("gives a co-located rep with no manager assignment nobody", async () => {
      await inTenant(async (tx) => {
        expect(await managedRepIds(tx, COLOCATED)).toEqual([]);
        expect(await managedRepIds(tx, REP_A)).toEqual([]);
      });
    });

    it("gives a peer manager in another region nobody", async () => {
      await inTenant(async (tx) => {
        expect(await managedRepIds(tx, PEER)).toEqual([]);
      });
    });

    /**
     * "My team" excludes me. A manager in their own roster makes every count off by one
     * and every per-rep average wrong — while `rep_can_supervise` deliberately says yes
     * for self, because "may I read this" is a different question.
     */
    it("excludes the manager themselves", async () => {
      await inTenant(async (tx) => {
        expect(await managedRepIds(tx, REGIONAL)).not.toContain(REGIONAL);
        expect(await managedRepIds(tx, DISTRICT)).not.toContain(DISTRICT);
      });
    });
  });

  describe("dating", () => {
    it("drops a rep whose assignment has ended", async () => {
      await inTenant(async (tx) => {
        await tx.query("UPDATE crm.territory_assignment SET valid_to = '2026-06-01' WHERE rep_profile_id = $1", [
          REP_A,
        ]);
        expect(await managedRepIds(tx, DISTRICT, "2026-05-31")).toContain(REP_A);
        expect(await managedRepIds(tx, DISTRICT, "2026-06-01")).not.toContain(REP_A);
      });
    });

    /**
     * The question a quarterly review actually asks. A manager who took over in October
     * must be able to see who held the territories in Q3 — otherwise last quarter's
     * numbers are unreadable the moment anyone changes job.
     */
    it("answers for the manager who held the territory at the time", async () => {
      await inTenant(async (tx) => {
        await tx.query("DELETE FROM crm.territory_assignment WHERE rep_profile_id = $1", [REGIONAL]);
        await assign(tx, REGION, REGIONAL, "manager", "2026-01-01", "2026-10-01");
        await assign(tx, REGION, PEER, "manager", "2026-10-01");

        expect(await managedRepIds(tx, REGIONAL, "2026-09-30")).toContain(REP_A);
        expect(await managedRepIds(tx, REGIONAL, "2026-10-02")).toEqual([]);
        expect(await managedRepIds(tx, PEER, "2026-10-02")).toContain(REP_A);
        expect(await managedRepIds(tx, PEER, "2026-09-30")).toEqual([]);
      });
    });

    it("rejects a malformed date before it reaches the database", async () => {
      await inTenant(async (tx) => {
        await expect(managedRepIds(tx, REGIONAL, "31/12/2026")).rejects.toThrow(/must be YYYY-MM-DD/);
      });
    });
  });

  describe("canSupervise", () => {
    it("is true for oneself, always", async () => {
      await inTenant(async (tx) => {
        expect(await canSupervise(tx, REP_A, REP_A)).toBe(true);
        expect(await canSupervise(tx, PEER, PEER)).toBe(true);
      });
    });

    it("is true down the hierarchy and false across it", async () => {
      await inTenant(async (tx) => {
        expect(await canSupervise(tx, REGIONAL, REP_B)).toBe(true);
        expect(await canSupervise(tx, DISTRICT, REP_A)).toBe(true);
        expect(await canSupervise(tx, DISTRICT, REP_B)).toBe(false);
        expect(await canSupervise(tx, PEER, REP_A)).toBe(false);
      });
    });

    /** Never upward: a rep cannot read their manager's records. */
    it("is false upward", async () => {
      await inTenant(async (tx) => {
        expect(await canSupervise(tx, REP_A, DISTRICT)).toBe(false);
        expect(await canSupervise(tx, DISTRICT, REGIONAL)).toBe(false);
      });
    });

    it("is false sideways between co-located reps", async () => {
      await inTenant(async (tx) => {
        expect(await canSupervise(tx, REP_A, COLOCATED)).toBe(false);
      });
    });
  });

  describe("teamRoster", () => {
    it("lists each rep once, with the territories they cover", async () => {
      await inTenant(async (tx) => {
        await assign(tx, TERR_B, REP_A, "secondary");
        const roster = await teamRoster(tx, REGIONAL);
        const a = roster.find((r) => r.rep_profile_id === REP_A)!;
        // Two territories, one person.
        expect([...a.territory_codes].sort()).toEqual(["SUP-A", "SUP-B"]);
        expect(roster.filter((r) => r.rep_profile_id === REP_A)).toHaveLength(1);
      });
    });

    it("is empty for someone who manages nobody, rather than an error", async () => {
      await inTenant(async (tx) => {
        // "You supervise nobody" is a fact about the hierarchy, not a refusal.
        expect(await teamRoster(tx, REP_A)).toEqual([]);
      });
    });

    it("carries the rep's status, so a suspended rep is visible as one", async () => {
      await inTenant(async (tx) => {
        await tx.query("UPDATE crm.rep_profile SET status = 'suspended' WHERE id = $1", [REP_A]);
        const roster = await teamRoster(tx, DISTRICT);
        expect(roster.find((r) => r.rep_profile_id === REP_A)!.status).toBe("suspended");
        await tx.query("UPDATE crm.rep_profile SET status = 'active' WHERE id = $1", [REP_A]);
      });
    });
  });
});
