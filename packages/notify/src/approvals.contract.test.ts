import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_APPROVAL_SWEEP as TENANT,
  TENANT_APPROVAL_SWEEP_OTHER as OTHER,
  testPool,
  wipeProposals,
} from "@crm/db/testing";
import { proposeConfigChange, decideConfigProposal, withTenantContext } from "@crm/db";

import { notifyPendingApprovals } from "./approvals.js";
import { inbox } from "./inbox.js";

/**
 * Migration 0063 — telling whoever can act on a change that takes two people.
 *
 * WHAT IS UNDER TEST IS A MOVING AUDIENCE. `config_change_awaiting_approval` goes out when a
 * proposal is made, to whoever held the grant at that moment, and the two states it cannot
 * cover are the two that matter: a tenant whose only officer asked for something (nobody to
 * tell) and an officer appointed afterwards (eligible for everything pending, told about
 * none of it). 0062's browser gate measured the first as a zero.
 *
 * So every test here changes the ROSTER under a pending proposal and asks what the next pass
 * says. None of it could be asserted against a fake connection: the audience comes from
 * `crm.role_holders` reading live grants under row-level security, and the idempotence is
 * `crm.notification`'s own `(tenant_id, recipient, dedup_key)` uniqueness.
 *
 * `testPool()` with `SET ROLE crm_app`, the pattern the four-eyes suite uses: revoking a grant
 * through 0023's function needs more than the application has, and every read still runs as
 * the application does with row security on.
 */
describe("telling whoever can approve (0063)", () => {
  let pool: Pool;
  let client: PoolClient;

  let ada = "";
  let grace = "";
  let admin = "";
  let outsider = "";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOther = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER, fn);

  const POLICY_ROW = { tenant_id: TENANT };
  const ARM = { auto_writeoff_promo: true };

  const rep = async (tenant: string, subject: string, name: string): Promise<string> => {
    const { rows } = await withTenantContext(client, tenant, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [tenant, subject, name],
      ),
    );
    return rows[0]!.id;
  };

  /** A live grant, idempotent — `ON CONFLICT` cannot cover the EXCLUDE over a daterange. */
  const grant = (tenant: string, holder: string, role: string, grantor: string): Promise<unknown> =>
    withTenantContext(client, tenant, (tx) =>
      tx.query(
        `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
         SELECT $1, $2, $3, $4, CURRENT_DATE - 1, 'the approval-sweep suite needs this grant'
          WHERE NOT EXISTS (
            SELECT 1 FROM crm.rep_role r
             WHERE r.tenant_id = $1 AND r.rep_profile_id = $2 AND r.role = $3
               AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to > CURRENT_DATE))`,
        [tenant, holder, role, grantor],
      ),
    );

  /** Retires every live grant of a role, with the append-only trigger explicitly off. */
  const ungrant = (tenant: string, holder: string, role: string): Promise<unknown> =>
    withTenantContext(client, tenant, async (tx) => {
      await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
      try {
        await tx.query(
          "DELETE FROM crm.rep_role WHERE tenant_id = $1 AND rep_profile_id = $2 AND role = $3",
          [tenant, holder, role],
        );
      } finally {
        await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
      }
    });

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    ada = await rep(TENANT, "sweep-ada", "Ada Lovelace");
    grace = await rep(TENANT, "sweep-grace", "Grace Hopper");
    admin = await rep(TENANT, "sweep-admin", "An Administrator");
    outsider = await rep(OTHER, "sweep-outsider", "Another Tenant's Officer");
    await grant(OTHER, outsider, "compliance", await rep(OTHER, "sweep-other-2", "Their Colleague"));
  });

  afterAll(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await wipeProposals(tx, tenant);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
        try {
          await tx.query("DELETE FROM crm.rep_role WHERE tenant_id = $1", [tenant]);
        } finally {
          await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
        }
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  });

  /**
   * Back to one compliance officer and no administrator every time.
   *
   * The roster is the thing under test, so it is reset rather than accumulated: a suite whose
   * tests each appointed somebody would be asserting against whatever the previous test left,
   * which is the coupling 0062's expense-lifecycle suite was found to have.
   */
  beforeEach(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await wipeProposals(tx, tenant);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [tenant]);
      });
    }
    // EVERY role off every rep, not a hand-picked list. The first version ungranted
    // `grace`'s compliance and `admin`'s administrator and left `admin`'s COMPLIANCE behind,
    // so a test that appointed one officer saw two — and the number it asserted depended on
    // which test had run before it. The roster is what is under test here, so it is reset
    // completely rather than adjusted.
    for (const who of [ada, grace, admin]) {
      for (const role of ["compliance", "administrator"]) {
        await ungrant(TENANT, who, role);
      }
    }
    await grant(TENANT, ada, "compliance", grace);
  });

  /** Ada asks to arm the unattended write-off. Returns the proposal id. */
  const ask = async (reason = "the leaflet volumes have outgrown the manual process"): Promise<string> => {
    const { proposal } = await inTenant((tx) =>
      proposeConfigChange(tx, TENANT, {
        tableName: "disposal_policy",
        rowKey: POLICY_ROW,
        changes: ARM,
        proposedBy: ada,
        reason,
      }),
    );
    return proposal.id;
  };

  const sweep = (): Promise<Awaited<ReturnType<typeof notifyPendingApprovals>>> =>
    inTenant((tx) => notifyPendingApprovals(tx, TENANT));

  /** The approval notices in somebody's inbox, by the reason they were sent. */
  const noticesFor = async (who: string): Promise<readonly string[]> => {
    const items = await inTenant((tx) => inbox(tx, who));
    return items
      .filter((n) => n.kind === "config_change_awaiting_approval")
      .map((n) => (/stuck/.test(n.subject) ? "blocked" : "awaiting"));
  };

  describe("nothing to do", () => {
    it("reports zeroes for a tenant with no proposals", async () => {
      expect(await sweep()).toEqual({
        pending: 0,
        notified: 0,
        alreadyKnown: 0,
        blocked: 0,
        unreportable: 0,
      });
    });

    it("says nothing about a decided proposal, however it was decided", async () => {
      await grant(TENANT, grace, "compliance", ada);
      const first = await ask("asking, then being refused");
      await inTenant((tx) =>
        decideConfigProposal(tx, TENANT, first, "rejected", grace, "not while the audit is open"),
      );
      const second = await ask("asking, then thinking better of it");
      await inTenant((tx) =>
        decideConfigProposal(tx, TENANT, second, "withdrawn", ada, "on reflection, next quarter"),
      );
      // A decided proposal is finished, whichever way it went — and an APPROVED one is
      // finished too, because the change it authorised either landed in the same transaction
      // or was refused by the write.
      expect(await sweep()).toMatchObject({ pending: 0, notified: 0, blocked: 0 });
    });
  });

  describe("the officer appointed afterwards", () => {
    /**
     * THE CASE 0062'S GATE MEASURED AS A ZERO. Ada is the only compliance officer, so the
     * proposal's own notice goes to nobody — and until 0063 nothing told the second officer
     * when one arrived.
     */
    it("tells an officer appointed after the proposal was made", async () => {
      const id = await ask();
      // The propose path's own notice first, scoped to the one proposal, exactly as the route
      // calls it — and it reaches nobody, because at this moment nobody else holds the grant.
      // That is the zero 0062's browser gate measured.
      const atProposalTime = await inTenant((tx) =>
        notifyPendingApprovals(tx, TENANT, { onlyProposalId: id }),
      );
      expect(atProposalTime).toMatchObject({ pending: 1, notified: 0, blocked: 1 });
      expect(await noticesFor(grace)).toEqual([]);

      await grant(TENANT, grace, "compliance", ada);
      const after = await sweep();
      expect(after).toMatchObject({ pending: 1, notified: 1, alreadyKnown: 0, blocked: 0 });
      expect(await noticesFor(grace)).toEqual(["awaiting"]);
      // Never the proposer, who already knows. A notification telling somebody about their
      // own request is how an inbox becomes something to ignore.
      expect(await noticesFor(ada)).toEqual([]);
    });

    it("tells each of several newly-eligible officers, exactly once", async () => {
      await ask();
      await grant(TENANT, grace, "compliance", ada);
      await grant(TENANT, admin, "compliance", ada);
      const first = await sweep();
      expect(first).toMatchObject({ notified: 2, alreadyKnown: 0 });
      expect(await noticesFor(grace)).toEqual(["awaiting"]);
      expect(await noticesFor(admin)).toEqual(["awaiting"]);
      // `crm.notification`'s uniqueness is per RECIPIENT, so two people get two notices from
      // one dedup key — which is the arrangement the whole sweep depends on.
      const { rows } = await inTenant((tx) =>
        tx.query<{ n: string }>(
          `SELECT count(DISTINCT dedup_key)::text AS n FROM crm.notification
            WHERE tenant_id = $1 AND kind = 'config_change_awaiting_approval'`,
          [TENANT],
        ),
      );
      expect(rows[0]!.n).toBe("1");
    });

    /**
     * IDEMPOTENT, which is the only thing that makes a job running every fifteen minutes
     * safe. Nobody is nagged: a proposal that sits for months produces one notice per person,
     * and the second pass is all `alreadyKnown`.
     */
    it("says nothing new on a second pass, and nothing at all on a hundredth", async () => {
      await ask();
      await grant(TENANT, grace, "compliance", ada);
      expect(await sweep()).toMatchObject({ notified: 1, alreadyKnown: 0 });
      expect(await sweep()).toMatchObject({ notified: 0, alreadyKnown: 1 });
      expect(await sweep()).toMatchObject({ notified: 0, alreadyKnown: 1 });
      expect(await noticesFor(grace)).toEqual(["awaiting"]);
    });

    it("stops telling an officer whose grant has been revoked", async () => {
      await grant(TENANT, grace, "compliance", ada);
      await ask();
      expect(await sweep()).toMatchObject({ notified: 1 });
      await ungrant(TENANT, grace, "compliance");
      // Her notice stays — it is a record of something that was true — but she is no longer
      // in the audience, and the proposal is now blocked rather than merely quiet.
      const after = await sweep();
      expect(after).toMatchObject({ pending: 1, notified: 0, alreadyKnown: 0, blocked: 1 });
    });
  });

  describe("the proposal nobody can approve", () => {
    /**
     * THE HALF THAT CLOSES THE LOOP. A proposal with no eligible decider is blocked on an act
     * its author cannot perform: appointing a second holder of the grant is an
     * administrator's job. So the administrators are told what it NEEDS, rather than told to
     * approve something they may not.
     */
    it("tells the administrators, with the sentence that names what it needs", async () => {
      await grant(TENANT, admin, "administrator", ada);
      await ask();
      const after = await sweep();
      expect(after).toMatchObject({ pending: 1, notified: 1, blocked: 1, unreportable: 0 });
      expect(await noticesFor(admin)).toEqual(["blocked"]);
      const items = await inTenant((tx) => inbox(tx, admin));
      const notice = items.find((n) => n.kind === "config_change_awaiting_approval");
      expect(notice?.subject).toMatch(/stuck: nobody can approve it/);
      expect(notice?.body).toMatch(/Granting compliance to a second rep is what unblocks it/);
    });

    it("counts a proposal nobody can approve AND nobody can be told about", async () => {
      // Ada is the only compliance officer and the only administrator: she is both the person
      // waiting and the only person who could appoint somebody. The end of the chain.
      await grant(TENANT, ada, "administrator", admin);
      await ask();
      const after = await sweep();
      expect(after).toMatchObject({ pending: 1, notified: 0, blocked: 1, unreportable: 1 });
      expect(await noticesFor(ada)).toEqual([]);
      expect(await noticesFor(admin)).toEqual([]);
    });

    it("stops calling it blocked the moment a second officer exists", async () => {
      await grant(TENANT, admin, "administrator", ada);
      await ask();
      expect(await sweep()).toMatchObject({ blocked: 1, notified: 1 });
      await grant(TENANT, grace, "compliance", ada);
      const after = await sweep();
      expect(after).toMatchObject({ blocked: 0, notified: 1 });
      // Grace is told she can decide it; the administrator's earlier notice stays, because it
      // was true when it was sent and this log is not rewritten.
      expect(await noticesFor(grace)).toEqual(["awaiting"]);
      expect(await noticesFor(admin)).toEqual(["blocked"]);
    });

    /**
     * An administrator-governed proposal in a tenant with one administrator is blocked and
     * unreportable for the same reason — and the arm that would report it is the same arm
     * that found nobody, so this is not a special case in the code.
     */
    it("treats an administrator's own re-pointing the same way", async () => {
      await grant(TENANT, ada, "administrator", admin);
      await inTenant((tx) =>
        tx.query(
          `INSERT INTO crm.expense_account_map (tenant_id, crm_category, erp_ledger_account_code)
           VALUES ($1, 'congress', '6200')`,
          [TENANT],
        ),
      ).catch(() => undefined);
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "expense_account_map",
          rowKey: { tenant_id: TENANT, crm_category: "congress" },
          changes: { erp_ledger_account_code: "6300", erp_cost_center_code: null },
          proposedBy: ada,
          reason: "Finance split congress into its own account",
        }),
      );
      expect(proposal.role).toBe("administrator");
      expect(await sweep()).toMatchObject({ blocked: 1, notified: 0, unreportable: 1 });
    });
  });

  describe("another tenant", () => {
    it("is never told about this one's proposals", async () => {
      await grant(TENANT, grace, "compliance", ada);
      await ask();
      await sweep();
      expect(await noticesFor(grace)).toEqual(["awaiting"]);
      const theirs = await inOther((tx) => inbox(tx, outsider));
      expect(theirs.filter((n) => n.kind === "config_change_awaiting_approval")).toEqual([]);
      // And a sweep of THEIR tenant finds nothing, because row-level security confines both
      // the proposals and the roster the audience comes from.
      expect(await inOther((tx) => notifyPendingApprovals(tx, OTHER))).toMatchObject({
        pending: 0,
        notified: 0,
      });
    });
  });

  describe("scoped to one proposal", () => {
    /**
     * How the route tells the people who can act on the proposal it just made — the same
     * function the job calls, which is what keeps the immediate notice and the catch-up from
     * drifting into two sentences about one fact.
     */
    it("tells only about the proposal it names", async () => {
      await grant(TENANT, grace, "compliance", ada);
      const first = await ask("the first request");
      await inTenant((tx) => decideConfigProposal(tx, TENANT, first, "withdrawn", ada, "not this one"));
      const second = await ask("the second request");
      const scoped = await inTenant((tx) =>
        notifyPendingApprovals(tx, TENANT, { onlyProposalId: second }),
      );
      expect(scoped).toMatchObject({ pending: 1, notified: 1 });
      const { rows } = await inTenant((tx) =>
        tx.query<{ subject_id: string }>(
          `SELECT subject_id::text AS subject_id FROM crm.notification
            WHERE tenant_id = $1 AND kind = 'config_change_awaiting_approval'`,
          [TENANT],
        ),
      );
      expect(rows.map((r) => r.subject_id)).toEqual([second]);
    });
  });
});
