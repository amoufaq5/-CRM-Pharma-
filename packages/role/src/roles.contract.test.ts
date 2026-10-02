import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_ROLE as TENANT, testPool } from "@crm/db/testing";

import {
  GrantAlreadyRevokedError,
  GrantImmutableError,
  LastAdministratorError,
  RoleAlreadyHeldError,
  SelfGrantError,
  UnknownRoleError,
  translateRoleError,
} from "./errors.js";
import { grantRole, revokeRole } from "./grants.js";
import { hasRole, listGrants, repRoles, roleHolders } from "./roles.js";

/**
 * The role model against a real Postgres.
 *
 * Every rule here is enforced in migration 0023, not in TypeScript, so a fake
 * connection would prove nothing: these tests exist to show that the DATABASE refuses
 * a self-grant, an overlap, an edit, and — the one that matters most operationally — a
 * revocation that would leave a tenant with no administrator and no way to appoint one.
 */
describe("roles", () => {
  let pool: Pool;
  let client: PoolClient;

  const ADMIN_1 = "e1100000-0000-4000-8000-000000000001";
  const ADMIN_2 = "e1200000-0000-4000-8000-000000000002";
  const OFFICER = "e1300000-0000-4000-8000-000000000003";
  const PLAIN = "e1400000-0000-4000-8000-000000000004";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  /**
   * Runs an expectation inside a SAVEPOINT.
   *
   * Postgres aborts the whole transaction on any error, so two refusals asserted in a
   * row would see "current transaction is aborted" for the second one. Each refusal
   * gets its own savepoint, and the caught error is routed through
   * `translateRoleError` so the tests assert on the typed error a caller would get.
   */
  const refuses = async (
    tx: PoolClient,
    fn: () => Promise<unknown>,
  ): Promise<Error> => {
    await tx.query("SAVEPOINT probe");
    try {
      await fn();
      await tx.query("RELEASE SAVEPOINT probe");
      throw new Error("expected a refusal, got none");
    } catch (err) {
      await tx.query("ROLLBACK TO SAVEPOINT probe");
      return translateRoleError(err);
    }
  };

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [ADMIN_1, "Admin One"],
        [ADMIN_2, "Admin Two"],
        [OFFICER, "Officer"],
        [PLAIN, "Plain Rep"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING`,
          [id, TENANT, `role-${n.replace(/ /g, "-").toLowerCase()}`, n],
        );
      }
    });
  });

  afterAll(async () => {
    await clearGrants();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  /**
   * crm.rep_role refuses DELETE by design, so the fixture disables USER triggers to
   * reset between tests. Stated explicitly rather than hidden in a helper: a test that
   * can delete history is a test that could hide a bug in the trigger that forbids it,
   * so this is the only place in the suite where that happens.
   */
  const clearGrants = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.rep_role WHERE tenant_id = $1", [TENANT]);
      await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
      await tx.query("UPDATE crm.rep_profile SET status = 'active' WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeEach(clearGrants);

  const seedAdmin = (tx: PoolClient, who: string, from = "2026-01-01"): Promise<unknown> =>
    grantRole(tx, TENANT, {
      repProfileId: who,
      role: "administrator",
      grantedBy: who === ADMIN_1 ? ADMIN_2 : ADMIN_1,
      validFrom: from,
    });

  describe("granting", () => {
    it("records who gave what to whom, and when", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-03-01",
          reason: "took over SOP ownership",
        });
        expect(grant.role).toBe("compliance");
        expect(grant.rep_display_name).toBe("Officer");
        expect(grant.granted_by_name).toBe("Admin One");
        expect(grant.valid_from).toBe("2026-03-01");
        expect(grant.valid_to).toBeNull();
        expect(grant.grant_reason).toBe("took over SOP ownership");
        expect(grant.revoked_at).toBeNull();
      });
    });

    it("refuses a self-grant — four eyes, in the database", async () => {
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          grantRole(tx, TENANT, { repProfileId: OFFICER, role: "compliance", grantedBy: OFFICER }),
        );
        expect(err).toBeInstanceOf(SelfGrantError);
      });
    });

    it("refuses a second overlapping grant of the same role", async () => {
      await inTenant(async (tx) => {
        await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const err = await refuses(tx, () =>
          grantRole(tx, TENANT, {
            repProfileId: OFFICER,
            role: "compliance",
            grantedBy: ADMIN_1,
            validFrom: "2026-06-01",
          }),
        );
        expect(err).toBeInstanceOf(RoleAlreadyHeldError);
      });
    });

    it("allows the same rep to hold both roles at once", async () => {
      await inTenant(async (tx) => {
        await seedAdmin(tx, ADMIN_1);
        await grantRole(tx, TENANT, {
          repProfileId: ADMIN_1,
          role: "compliance",
          grantedBy: ADMIN_2,
          validFrom: "2026-01-01",
        });
        expect([...(await repRoles(tx, ADMIN_1, "2026-05-01"))]).toEqual(["administrator", "compliance"]);
      });
    });

    it("refuses a role that does not exist, without reaching the database", async () => {
      await inTenant(async (tx) => {
        await expect(
          grantRole(tx, TENANT, { repProfileId: OFFICER, role: "superuser", grantedBy: ADMIN_1 }),
        ).rejects.toBeInstanceOf(UnknownRoleError);
      });
    });
  });

  describe("the predicate", () => {
    it("is dated: a role held from March is not held in February", async () => {
      await inTenant(async (tx) => {
        await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-03-01",
        });
        expect(await hasRole(tx, OFFICER, "compliance", "2026-02-28")).toBe(false);
        expect(await hasRole(tx, OFFICER, "compliance", "2026-03-01")).toBe(true);
      });
    });

    it("does not confer the other role", async () => {
      await inTenant(async (tx) => {
        await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        expect(await hasRole(tx, OFFICER, "administrator", "2026-05-01")).toBe(false);
      });
    });

    it("answers no for a rep who holds nothing", async () => {
      await inTenant(async (tx) => {
        expect(await hasRole(tx, PLAIN, "administrator")).toBe(false);
        expect([...(await repRoles(tx, PLAIN))]).toEqual([]);
      });
    });

    /**
     * The rule that makes the predicate safe to call from anywhere: a grant is not a
     * role if the profile holding it is not active. Without this, a suspended rep's
     * token would be refused at the API edge but their grant would still read as live
     * to a job or a view.
     */
    it("ignores a grant held by a suspended profile", async () => {
      await inTenant(async (tx) => {
        await seedAdmin(tx, ADMIN_1);
        await seedAdmin(tx, ADMIN_2);
        await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        expect(await hasRole(tx, OFFICER, "compliance", "2026-05-01")).toBe(true);
        await tx.query("UPDATE crm.rep_profile SET status = 'suspended' WHERE id = $1", [OFFICER]);
        expect(await hasRole(tx, OFFICER, "compliance", "2026-05-01")).toBe(false);
        expect([...(await repRoles(tx, OFFICER, "2026-05-01"))]).toEqual([]);
      });
    });
  });

  describe("revoking", () => {
    it("ends the grant and keeps it, with both parties named", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const ended = await revokeRole(tx, TENANT, grant.id, {
          revokedBy: ADMIN_2,
          on: "2026-05-01",
          reason: "changed duties",
        });
        expect(ended?.valid_to).toBe("2026-05-01");
        expect(ended?.revoked_by_name).toBe("Admin Two");
        expect(ended?.revoke_reason).toBe("changed duties");
        expect(await hasRole(tx, OFFICER, "compliance", "2026-04-30")).toBe(true);
        expect(await hasRole(tx, OFFICER, "compliance", "2026-05-01")).toBe(false);
      });
    });

    it("refuses a self-revoke", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const err = await refuses(tx, () => revokeRole(tx, TENANT, grant.id, { revokedBy: OFFICER }));
        expect(err).toBeInstanceOf(SelfGrantError);
      });
    });

    it("returns null for a grant that does not exist, rather than raising", async () => {
      await inTenant(async (tx) => {
        expect(await revokeRole(tx, TENANT, "e9000000-0000-4000-8000-00000000000f", { revokedBy: ADMIN_1 })).toBeNull();
      });
    });

    it("refuses revoking twice — that caller has lost track, not retried", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        await revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_1, on: "2026-05-01" });
        const err = await refuses(tx, () => revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_1 }));
        expect(err).toBeInstanceOf(GrantAlreadyRevokedError);
      });
    });

    /**
     * Correcting a mistake within the hour. valid_to = valid_from is an EMPTY range, so
     * the grant was never in force — and, because an empty daterange overlaps nothing,
     * it does not block a fresh grant on the same day. Both halves matter: the first
     * keeps the mistake visible, the second keeps the fix possible.
     */
    it("lets a same-day mistake be undone, and re-granted the same day", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-02-01",
        });
        const ended = await revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_2, on: "2026-01-05" });
        expect(ended?.valid_to).toBe("2026-02-01");
        expect(await hasRole(tx, OFFICER, "compliance", "2026-02-01")).toBe(false);

        const again = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-02-01",
        });
        expect(again.id).not.toBe(grant.id);
        expect(await hasRole(tx, OFFICER, "compliance", "2026-02-01")).toBe(true);
      });
    });

    /**
     * Written the obvious way — valid_to = GREATEST(on, valid_from) — this would hand a
     * lapsed interim appointment its months back.
     */
    it("records a late revocation without extending a lapsed grant", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
          validTo: "2026-03-01",
        });
        const ended = await revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_1, on: "2026-09-01" });
        expect(ended?.valid_to).toBe("2026-03-01");
        expect(ended?.revoked_at).not.toBeNull();
      });
    });
  });

  /**
   * The lockout rules. A tenant with no administrator cannot be given one through the
   * API — a grant cannot name its own holder as grantor — so the last one leaving is a
   * one-way door, and both ways through it are closed in the database.
   */
  describe("lockout", () => {
    it("refuses to revoke the only administrator", async () => {
      await inTenant(async (tx) => {
        const grant = (await seedAdmin(tx, ADMIN_1)) as { id: string };
        const err = await refuses(tx, () => revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_2, on: "2026-05-01" }));
        expect(err).toBeInstanceOf(LastAdministratorError);
        expect(err.message).toContain("grant the role to their successor first");
      });
    });

    it("refuses to suspend the only administrator", async () => {
      await inTenant(async (tx) => {
        await seedAdmin(tx, ADMIN_1);
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.rep_profile SET status = 'suspended' WHERE id = $1", [ADMIN_1]),
        );
        expect(err).toBeInstanceOf(LastAdministratorError);
      });
    });

    it("permits both once a successor holds the role", async () => {
      await inTenant(async (tx) => {
        const first = (await seedAdmin(tx, ADMIN_1)) as { id: string };
        await seedAdmin(tx, ADMIN_2, "2026-04-01");
        const ended = await revokeRole(tx, TENANT, first.id, { revokedBy: ADMIN_2, on: "2026-05-01" });
        expect(ended?.valid_to).toBe("2026-05-01");
        await tx.query("UPDATE crm.rep_profile SET status = 'departed' WHERE id = $1", [ADMIN_1]);
        expect(await hasRole(tx, ADMIN_2, "administrator", "2026-05-01")).toBe(true);
      });
    });

    /** A day without an administrator is a locked-out day; the successor must start sooner. */
    it("refuses a gap, not just a void", async () => {
      await inTenant(async (tx) => {
        const first = (await seedAdmin(tx, ADMIN_1)) as { id: string };
        await seedAdmin(tx, ADMIN_2, "2026-06-01");
        const err = await refuses(tx, () => revokeRole(tx, TENANT, first.id, { revokedBy: ADMIN_2, on: "2026-05-01" }));
        expect(err).toBeInstanceOf(LastAdministratorError);
      });
    });

    it("does not consult the guard for a non-administrator role", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        expect((await revokeRole(tx, TENANT, grant.id, { revokedBy: ADMIN_1, on: "2026-05-01" }))?.valid_to).toBe(
          "2026-05-01",
        );
      });
    });

    it("lets a suspended rep be reactivated — that cannot lock anyone out", async () => {
      await inTenant(async (tx) => {
        await tx.query("UPDATE crm.rep_profile SET status = 'suspended' WHERE id = $1", [PLAIN]);
        await tx.query("UPDATE crm.rep_profile SET status = 'active' WHERE id = $1", [PLAIN]);
        expect(await hasRole(tx, PLAIN, "administrator")).toBe(false);
      });
    });
  });

  describe("the grant is history", () => {
    it("refuses a DELETE", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const err = await refuses(tx, () => tx.query("DELETE FROM crm.rep_role WHERE id = $1", [grant.id]));
        expect(err).toBeInstanceOf(GrantImmutableError);
        expect(err.message).toContain("append-only");
      });
    });

    it("refuses an edit to the role itself", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.rep_role SET role = 'administrator' WHERE id = $1", [grant.id]),
        );
        expect(err).toBeInstanceOf(GrantImmutableError);
      });
    });

    it("refuses an unattributed end date", async () => {
      await inTenant(async (tx) => {
        const grant = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.rep_role SET valid_to = '2026-07-01' WHERE id = $1", [grant.id]),
        );
        expect(err).toBeInstanceOf(GrantImmutableError);
      });
    });
  });

  describe("reading", () => {
    it("lists live grants by default and ended ones on request", async () => {
      await inTenant(async (tx) => {
        const kept = await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        await seedAdmin(tx, ADMIN_1);
        await seedAdmin(tx, ADMIN_2, "2026-01-01");
        const gone = (await seedAdmin(tx, PLAIN, "2026-01-01")) as { id: string };
        await revokeRole(tx, TENANT, gone.id, { revokedBy: ADMIN_1, on: "2026-02-01" });

        const live = await listGrants(tx, TENANT, { asOf: "2026-05-01" });
        expect(live.map((g) => g.id)).toContain(kept.id);
        expect(live.map((g) => g.id)).not.toContain(gone.id);
        expect(live.every((g) => g.in_force)).toBe(true);

        const all = await listGrants(tx, TENANT, { asOf: "2026-05-01", includeEnded: true });
        expect(all.map((g) => g.id)).toContain(gone.id);
        expect(all.find((g) => g.id === gone.id)?.in_force).toBe(false);
      });
    });

    it("filters by role", async () => {
      await inTenant(async (tx) => {
        await seedAdmin(tx, ADMIN_1);
        await seedAdmin(tx, ADMIN_2);
        await grantRole(tx, TENANT, {
          repProfileId: OFFICER,
          role: "compliance",
          grantedBy: ADMIN_1,
          validFrom: "2026-01-01",
        });
        const admins = await listGrants(tx, TENANT, { role: "administrator", asOf: "2026-05-01" });
        expect(admins).toHaveLength(2);
        expect(admins.every((g) => g.role === "administrator")).toBe(true);
      });
    });

    it("names the administrators a tenant actually has", async () => {
      await inTenant(async (tx) => {
        await seedAdmin(tx, ADMIN_1);
        await seedAdmin(tx, ADMIN_2, "2026-04-01");
        const holders = await roleHolders(tx, "administrator", "2026-05-01");
        expect(holders.map((h) => h.display_name)).toEqual(["Admin One", "Admin Two"]);
        // ... and none of them in March, before the second was appointed.
        expect(await roleHolders(tx, "administrator", "2026-03-01")).toHaveLength(1);
      });
    });
  });
});
