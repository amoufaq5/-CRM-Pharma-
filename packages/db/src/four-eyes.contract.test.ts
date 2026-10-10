import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_FOUR_EYES as TENANT,
  TENANT_FOUR_EYES_LONE as LONE,
  testPool,
  wipeProposals,
} from "./testing.js";
import { withTenantContext } from "./tenant-context.js";
import { ConfigProposalError, ConfigFourEyesError, withAttribution } from "./attribution.js";
import {
  NoFourEyesRuleError,
  configProposal,
  configProposals,
  decideConfigProposal,
  fourEyesRequired,
  fourEyesRules,
  proposalDeciders,
  proposeConfigChange,
} from "./four-eyes.js";

/**
 * Migration 0062 — the few configuration changes that take two people.
 *
 * WHY THIS IS A CONTRACT TEST. Every rule here is a trigger or a database function. The
 * refusal is a `RAISE` from `crm.require_four_eyes` reading a transaction-local setting; the
 * directionality is a `CASE` over a table of rules; "an approval is good for one change" is a
 * timestamp stamped by the same statement that lets the write through; and "both actors still
 * hold the grant" is `crm.rep_has_role` evaluated at apply time rather than at approval. Not
 * one of those can be observed against a fake connection, and three of them are the ones that
 * make an approval mean something rather than decorate one.
 *
 * THE WRITES ARE RAW SQL, deliberately. The policy's store function lives in `@crm/sample` and
 * the account map's in `@crm/expense`, and `@crm/db` depends on `pg` and nothing else — but
 * more than that, what is under test is the guard on the TABLE, and a writer that is not one of
 * those packages is exactly the case 0059's header says the guard exists for: "a psql prompt, a
 * future offline-sync flush, a data import". The suites that drive the stores are next door.
 *
 * `testPool()` with `SET ROLE crm_app`, the pattern `expense.contract.test.ts` established:
 * revoking a grant mid-test needs more than the application has, and every write still runs as
 * the application does with row-level security on.
 */
describe("two people for the dangerous ones (0062)", () => {
  let pool: Pool;
  let client: PoolClient;

  /** Both hold the grant in TENANT. `lone` is the only holder in LONE. */
  let ada = "";
  let grace = "";
  let lone = "";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inLone = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, LONE, fn);

  const POLICY_ROW = { tenant_id: TENANT };
  const ARM = { auto_writeoff_promo: true };

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");

    const rep = async (
      tenant: string,
      subject: string,
      name: string,
    ): Promise<string> => {
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
    ada = await rep(TENANT, "4e-ada", "Ada Lovelace");
    grace = await rep(TENANT, "4e-grace", "Grace Hopper");
    lone = await rep(LONE, "4e-lone", "The Only Officer");

    // Each granted BY THE OTHER, which is 0023's own rule and the shape a real tenant
    // bootstraps into. `compliance` for both, because the policy is the four-eyed table this
    // suite drives; the account-map rule answers to `administrator` and gets its grants where
    // it is used.
    await grant(TENANT, ada, "compliance", grace);
    await grant(TENANT, grace, "compliance", ada);
    await grant(TENANT, ada, "administrator", grace);
    await grant(TENANT, grace, "administrator", ada);
    // LONE has exactly one officer, on purpose: a tenant that cannot make a four-eyed change
    // at all is a state the product has to report rather than hide, and the grantor is this
    // tenant's own second profile, which holds nothing.
    const bystander = await rep(LONE, "4e-bystander", "A Bystander");
    await grant(LONE, lone, "compliance", bystander);
  });

  const grant = (
    tenant: string,
    holder: string,
    role: string,
    grantor: string,
  ): Promise<unknown> =>
    withTenantContext(client, tenant, (tx) =>
      tx.query(
        `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
         SELECT $1, $2, $3, $4, CURRENT_DATE - 1, 'the four-eyes suite needs two qualified people'
          WHERE NOT EXISTS (
            SELECT 1 FROM crm.rep_role r
             WHERE r.tenant_id = $1 AND r.rep_profile_id = $2 AND r.role = $3
               AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to > CURRENT_DATE))`,
        [tenant, holder, role, grantor],
      ),
    );

  afterAll(async () => {
    for (const tenant of [TENANT, LONE]) {
      await withTenantContext(client, tenant, async (tx) => {
        await wipeProposals(tx, tenant);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [tenant]);
        // Append-only, so the grants come out with the trigger off — a fixture handing back a
        // tenant it borrowed, said explicitly rather than worked around.
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

  beforeEach(async () => {
    for (const tenant of [TENANT, LONE]) {
      await withTenantContext(client, tenant, async (tx) => {
        await wipeProposals(tx, tenant);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [tenant]);
      });
    }
  });

  /**
   * The error a call refused with — and a failure if it did not refuse at all.
   *
   * `.catch((e) => e as Error)` was the first shape and it is quietly wrong twice: it types
   * the result as a union so every assertion needs a cast, and it PASSES when nothing throws,
   * because the resolved value simply flows through and `expect(x.message).toMatch(...)` on
   * `undefined` is the one assertion vitest reports as a type error rather than a failure.
   * This one fails loudly on a call that succeeded, which is the whole point of a refusal test.
   */
  const refusalOf = async (call: Promise<unknown>): Promise<Error> => {
    try {
      await call;
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected this to be refused, and it was not");
  };

  /** A policy change, as any writer that is not `@crm/sample` would make one. */
  const changePolicy = (
    tx: PoolClient,
    by: string,
    opts: { readonly graceDays?: number; readonly arm?: boolean },
  ): Promise<unknown> =>
    tx.query(
      `INSERT INTO crm.disposal_policy_change
         (tenant_id, changed_by, reason, grace_days_to, auto_writeoff_promo_to)
       VALUES ($1, $2, 'the four-eyes suite changing the policy', $3, $4)`,
      [TENANT, by, opts.graceDays ?? null, opts.arm ?? null],
    );

  /** Proposed by Ada and approved by Grace, which is the happy path in one line. */
  const agreed = async (
    changes: Readonly<Record<string, unknown>>,
    rowKey: Readonly<Record<string, unknown>> = POLICY_ROW,
    tableName = "disposal_policy",
  ): Promise<string> => {
    const id = await inTenant(async (tx) => {
      const { proposal } = await proposeConfigChange(tx, TENANT, {
        tableName,
        rowKey,
        changes,
        proposedBy: ada,
        reason: "the volumes justify arming it",
      });
      return proposal.id;
    });
    await inTenant((tx) =>
      decideConfigProposal(tx, TENANT, id, "approved", grace, "agreed, I checked the volumes"),
    );
    return id;
  };

  describe("the register", () => {
    it("says which changes take two people, as a query rather than a comment", async () => {
      const rules = await inTenant((tx) => fourEyesRules(tx));
      expect(
        rules.map((r) => `${r.table_name}.${r.column_name}:${r.direction}:${r.role}`),
      ).toEqual([
        "disposal_policy.auto_writeoff_promo:to_true:compliance",
        "expense_account_map.erp_ledger_account_code:any_change:administrator",
      ]);
      // Every rule says WHY, at length. A selective rule becomes a blanket one the moment
      // somebody adds a row without having to justify it.
      for (const rule of rules) expect(rule.note.length).toBeGreaterThanOrEqual(20);
    });

    /**
     * THE ASYMMETRY IS THE CONTENT OF THE RULE, not an exception to it: four eyes to ARM the
     * unattended job and one signature to disarm it, four eyes to MOVE the money and one
     * signature to stop it moving.
     */
    it("is directional, so turning the dangerous switch OFF needs nobody", async () => {
      const ask = (table: string, changes: Record<string, unknown>): Promise<readonly string[]> =>
        inTenant((tx) => fourEyesRequired(tx, table, changes));
      expect(await ask("disposal_policy", { auto_writeoff_promo: true })).toEqual([
        "auto_writeoff_promo",
      ]);
      expect(await ask("disposal_policy", { auto_writeoff_promo: false })).toEqual([]);
      expect(await ask("disposal_policy", { grace_days: 7 })).toEqual([]);
      // `any_change` means what it says, in both directions and to any value.
      expect(await ask("expense_account_map", { erp_ledger_account_code: "6300" })).toEqual([
        "erp_ledger_account_code",
      ]);
      expect(await ask("expense_account_map", { is_active: false })).toEqual([]);
      expect(await ask("expense_account_map", { erp_cost_center_code: "CC-X" })).toEqual([]);
      // A table with no rules, and a column with none.
      expect(await ask("notification_policy", { retain_read_days: 7 })).toEqual([]);
      expect(await ask("disposal_policy", {})).toEqual([]);
    });
  });

  describe("the refusal", () => {
    it("refuses an arming nobody has agreed to, naming the grant and what to do", async () => {
      const err = await refusalOf(inTenant((tx) => changePolicy(tx, ada, { arm: true })));
      expect(err.message).toMatch(/four-eyes-required/);
      expect(err.message).toMatch(/two different people/);
      expect(err.message).toMatch(/compliance grant/);
      expect(await armed()).toBe(false);
    });

    /**
     * And the grace period still moves on one signature, which is the assertion 0059's
     * reasoning turns on — "a tenant with one compliance officer cannot set its own grace
     * period at all" was the stated reason not to four-eye this table, and 0062 had to leave
     * that true.
     */
    it("leaves every other change on one signature", async () => {
      await inTenant((tx) => changePolicy(tx, ada, { graceDays: 7 }));
      const { rows } = await inTenant((tx) =>
        tx.query<{ grace: number; linked: boolean }>(
          `SELECT grace_days AS grace,
                  (SELECT proposal_id IS NOT NULL FROM crm.disposal_policy_change
                    WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT 1) AS linked
             FROM crm.disposal_policy WHERE tenant_id = $1`,
          [TENANT],
        ),
      );
      expect(rows[0]).toMatchObject({ grace: 7, linked: false });
    });

    /**
     * A CREATION IS NOT A CHANGE, and this is the case the first live run of the migration got
     * wrong: `any_change` matched the INSERT that maps a tenant's first expense category, and
     * refused the one write the header promised would stay on a single signature. A category
     * that has never been mapped posts nowhere, so it cannot post wrongly.
     */
    it("lets a first mapping be written by one person, and refuses the re-point", async () => {
      await inTenant((tx) =>
        withAttribution(tx, { repProfileId: ada, reason: "mapping congress for the first time" }, (c) =>
          c.query(
            `INSERT INTO crm.expense_account_map (tenant_id, crm_category, erp_ledger_account_code)
             VALUES ($1, 'congress', '6200')`,
            [TENANT],
          ),
        ),
      );
      expect(await accountCode()).toBe("6200");

      const err = await refusalOf(
        inTenant((tx) =>
          withAttribution(tx, { repProfileId: ada, reason: "re-pointing it alone" }, (c) =>
            c.query(
              "UPDATE crm.expense_account_map SET erp_ledger_account_code = '9999' WHERE tenant_id = $1",
              [TENANT],
            ),
          ),
        ),
      );
      expect(err).toBeInstanceOf(ConfigFourEyesError);
      expect(await accountCode()).toBe("6200");
    });

    it("lets a mapping be deactivated by one person, because that fails safe", async () => {
      await inTenant((tx) =>
        withAttribution(tx, { repProfileId: ada, reason: "mapping congress for the first time" }, (c) =>
          c.query(
            `INSERT INTO crm.expense_account_map (tenant_id, crm_category, erp_ledger_account_code)
             VALUES ($1, 'congress', '6200')`,
            [TENANT],
          ),
        ),
      );
      // Deactivating fails safe — nothing posts wrongly, every claim in the category simply
      // stops being postable — so it is one signature and goes through.
      await inTenant((tx) =>
        withAttribution(tx, { repProfileId: ada, reason: "stopping congress claims for now" }, (c) =>
          c.query(
            "UPDATE crm.expense_account_map SET is_active = false WHERE tenant_id = $1",
            [TENANT],
          ),
        ),
      );
      const { rows } = await inTenant((tx) =>
        tx.query<{ is_active: boolean }>(
          "SELECT is_active FROM crm.expense_account_map WHERE tenant_id = $1",
          [TENANT],
        ),
      );
      expect(rows[0]!.is_active).toBe(false);
    });
  });

  describe("a proposal", () => {
    it("is stamped from the register rather than from the caller", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: { ...ARM, grace_days: 7 },
          proposedBy: ada,
          reason: "arming it, and shortening the deadline while we are here",
        }),
      );
      // Only the column under the rule, and the grant the rule names — neither of which the
      // caller supplied. A proposal whose claim about why it needed two people came from the
      // caller is not evidence of anything.
      expect(proposal.four_eyes_columns).toEqual(["auto_writeoff_promo"]);
      expect(proposal.role).toBe("compliance");
      expect(proposal.decision).toBeNull();
      expect(proposal.applied_at).toBeNull();
      expect(proposal.proposed_by_name).toBe("Ada Lovelace");
      // And it carries the WHOLE intended change, not just the four-eyed part, because the
      // write it authorises will set both.
      expect(proposal.changes).toEqual({ auto_writeoff_promo: true, grace_days: 7 });
    });

    /**
     * The deadline, stamped and then frozen (0064).
     *
     * STAMPED FROM THE COLUMN DEFAULT, not from a caller: a deadline the asker chose would be
     * a deadline the asker could set to a century. FROZEN afterwards for 0020's reason —
     * "a changed policy never rewrites a deadline that has already been communicated" — which
     * here also means there is no extension: the exit for a proposal that needs longer is to
     * reject it with a reason and ask again, which resets the clock and leaves both in the
     * record.
     */
    it("is given a deadline it did not choose, and cannot have it moved", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it after the volume review",
        }),
      );
      // Seven days out, which the column declares and nothing in the request mentioned.
      const days = (proposal.decide_by.getTime() - proposal.proposed_at.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
      // Not overdue yet, and a fresh proposal never is.
      expect(proposal.overdue).toBe(false);

      const err = await refusalOf(
        inTenant((tx) =>
          tx.query("UPDATE crm.config_proposal SET decide_by = now() + interval '90 days' WHERE id = $1", [
            proposal.id,
          ]),
        ),
      );
      expect(err.message).toMatch(/config-proposal-frozen/);
      expect(err.message).toMatch(/when it is due/);
    });

    /**
     * AND THE WRITER DOES NOT GET TO CHOOSE IT, which is 0059's rule for the `from` columns of
     * a policy change applied to a deadline: "the caller does not get to say what the policy
     * used to be". A psql prompt naming `decide_by` a century out is not a four-eyes bypass,
     * but it silently disables the escalation — the same idea in a quieter coat.
     *
     * This also pins the TWO COPIES of seven days — the column default and the trigger's
     * literal — against each other: a bare insert goes through the trigger and this asserts
     * where it landed, so changing one without the other is red here rather than a deadline
     * that depends on which path wrote the row.
     */
    it("overwrites a deadline a raw insert tried to choose", async () => {
      const { rows } = await inTenant((tx) =>
        tx.query<{ days: string }>(
          `INSERT INTO crm.config_proposal
             (tenant_id, table_name, row_key, changes, four_eyes_columns, role,
              proposed_by, proposed_reason, decide_by)
           VALUES ($1, 'disposal_policy', jsonb_build_object('tenant_id', $1::uuid),
                   '{"auto_writeoff_promo": true}'::jsonb, ARRAY['auto_writeoff_promo'],
                   'compliance', $2, 'asking with a deadline of my own choosing',
                   now() + interval '100 years')
           RETURNING (EXTRACT(EPOCH FROM (decide_by - clock_timestamp())) / 86400)::text AS days`,
          [TENANT, ada],
        ),
      );
      expect(Number(rows[0]!.days)).toBeGreaterThan(6.9);
      expect(Number(rows[0]!.days)).toBeLessThan(7.1);
    });

    it("stops being overdue the moment it is decided, however late", async () => {
      const id = await agreed(ARM);
      const after = await inTenant((tx) => configProposal(tx, TENANT, id));
      // The deadline was for DECIDING, so a decided proposal is never overdue — and `overdue`
      // is the server's answer against the server's clock, never a device's arithmetic.
      expect(after?.decision).toBe("approved");
      expect(after?.overdue).toBe(false);
    });

    it("is refused outright when nothing about it needs a second person", async () => {
      await expect(
        inTenant((tx) =>
          proposeConfigChange(tx, TENANT, {
            tableName: "disposal_policy",
            rowKey: POLICY_ROW,
            changes: { grace_days: 7 },
            proposedBy: ada,
            reason: "asking permission for something that needs none",
          }),
        ),
      ).rejects.toBeInstanceOf(NoFourEyesRuleError);
      expect(await inTenant((tx) => configProposals(tx, TENANT))).toEqual([]);
    });

    it("names who could decide it, and never the person who asked", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it after the volume review",
        }),
      );
      // A READ, not something the propose path hands back. 0063 removed that seam: who gets
      // TOLD is `notifyPendingApprovals`'s question, asked from the live roster every tick,
      // and this is just the answer to "who could decide this" for anybody who wants it.
      const deciders = await inTenant((tx) => proposalDeciders(tx, TENANT, proposal.id));
      expect(deciders.map((d) => d.display_name)).toEqual(["Grace Hopper"]);
      expect(proposal.eligible_deciders).toBe(1);
    });

    /**
     * ZERO IS A REAL ANSWER AND HAS TO BE REPORTABLE. A tenant with one compliance officer
     * cannot arm the unattended write-off job, which is the entire point of the rule for that
     * switch — but it must not be a silent refusal: the proposal is accepted and waits, and
     * the count is what the screen uses to say nobody can approve it yet.
     */
    it("is accepted in a tenant with nobody to approve it, and says so", async () => {
      const { proposal } = await inLone((tx) =>
        proposeConfigChange(tx, LONE, {
          tableName: "disposal_policy",
          rowKey: { tenant_id: LONE },
          changes: ARM,
          proposedBy: lone,
          reason: "the only officer here asking for it",
        }),
      );
      expect(await inLone((tx) => proposalDeciders(tx, LONE, proposal.id))).toEqual([]);
      expect(proposal.eligible_deciders).toBe(0);
      expect(proposal.decision).toBeNull();
    });

    it("cannot be approved by the rep who asked for it", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it after the volume review",
        }),
      );
      const err = await refusalOf(
        inTenant((tx) =>
        decideConfigProposal(tx, TENANT, proposal.id, "approved", ada, "approving my own request"),
        ),
      );
      expect(err.message).toMatch(/four-eyes-same-person/);
      expect(err.message).toMatch(/That is what two people means/);
      // Nor rejected by them: a proposer who changes their mind WITHDRAWS, and the two words
      // mean different things to whoever reads the register later.
      await expect(
        inTenant((tx) =>
          decideConfigProposal(tx, TENANT, proposal.id, "rejected", ada, "actually, never mind"),
        ),
      ).rejects.toThrow(/four-eyes-same-person/);
      await inTenant((tx) =>
        decideConfigProposal(tx, TENANT, proposal.id, "withdrawn", ada, "on reflection, not yet"),
      );
      expect((await inTenant((tx) => configProposal(tx, TENANT, proposal.id)))?.decision).toBe(
        "withdrawn",
      );
    });

    it("cannot be withdrawn by anybody else", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it after the volume review",
        }),
      );
      await expect(
        inTenant((tx) =>
          decideConfigProposal(tx, TENANT, proposal.id, "withdrawn", grace, "taking back her request"),
        ),
      ).rejects.toThrow(/four-eyes-not-yours/);
    });

    it("cannot be decided twice, which is a race as often as a mistake", async () => {
      const id = await agreed(ARM);
      const err = await refusalOf(
        inTenant((tx) =>
        decideConfigProposal(tx, TENANT, id, "rejected", grace, "changing my mind afterwards"),
        ),
      );
      expect(err.message).toMatch(/four-eyes-decided/);
    });

    it("cannot have what it asked for rewritten after somebody agreed", async () => {
      const id = await agreed(ARM);
      const err = await refusalOf(
        inTenant((tx) =>
        tx.query(
          `UPDATE crm.config_proposal SET changes = '{"auto_writeoff_promo": false}'::jsonb WHERE id = $1`,
          [id],
        ),
        ),
      );
      expect(err.message).toMatch(/config-proposal-frozen/);
    });

    it("keeps the refused and the withdrawn in the register, because a refusal is a fact", async () => {
      const made = async (reason: string): Promise<string> => {
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
      const first = await made("asking the first time");
      await inTenant((tx) =>
        decideConfigProposal(tx, TENANT, first, "rejected", grace, "not while the audit is open"),
      );
      const second = await made("asking again after the audit");
      expect((await inTenant((tx) => configProposals(tx, TENANT))).length).toBe(2);
      // Pending-only is the approver's queue, and the rejected one is not in it.
      const waiting = await inTenant((tx) => configProposals(tx, TENANT, { pendingOnly: true }));
      expect(waiting.map((p) => p.id)).toEqual([second]);
    });
  });

  describe("spending it", () => {
    it("lets the change through once both people are on the record", async () => {
      const id = await agreed(ARM);
      await inTenant((tx) =>
        withAttribution(
          tx,
          { repProfileId: grace, reason: "applying what we agreed", proposalId: id },
          (c) => changePolicy(c, grace, { arm: true }),
        ),
      );
      expect(await armed()).toBe(true);
      const { rows } = await inTenant((tx) =>
        tx.query<{ changed_by: string; proposal_id: string | null }>(
          `SELECT changed_by::text AS changed_by, proposal_id::text AS proposal_id
             FROM crm.disposal_policy_change WHERE tenant_id = $1`,
          [TENANT],
        ),
      );
      // THE AUTHOR OF RECORD IS THE APPROVER, and the proposal names who asked. Before Grace
      // acted, nothing had changed — which is what every other `*_by` column in this schema
      // means by the principal whose action changed the state.
      expect(rows[0]).toMatchObject({ changed_by: grace, proposal_id: id });
      expect((await inTenant((tx) => configProposal(tx, TENANT, id)))?.applied_at).not.toBeNull();
    });

    /**
     * AN APPROVAL IS GOOD FOR ONE CHANGE. Without this, one person could re-arm the switch
     * every time somebody else turned it off, using an approval given once, months ago, for a
     * different occasion.
     */
    it("cannot be spent twice, so a disarm cannot be undone on the old approval", async () => {
      const id = await agreed(ARM);
      const spend = (arm: boolean): Promise<unknown> =>
        inTenant((tx) =>
          withAttribution(
            tx,
            { repProfileId: grace, reason: "applying what we agreed", proposalId: id },
            (c) => changePolicy(c, grace, { arm }),
          ),
        );
      await spend(true);
      // Turning it off needs nobody, so this goes through and leaves the proposal alone.
      await spend(false);
      expect(await armed()).toBe(false);
      const err = await refusalOf(spend(true));
      expect(err.message).toMatch(/four-eyes-spent/);
      expect(await armed()).toBe(false);
    });

    it("refuses an approval given for another value", async () => {
      await inTenant((tx) =>
        withAttribution(tx, { repProfileId: ada, reason: "mapping congress for the first time" }, (c) =>
          c.query(
            `INSERT INTO crm.expense_account_map (tenant_id, crm_category, erp_ledger_account_code)
             VALUES ($1, 'congress', '6200')`,
            [TENANT],
          ),
        ),
      );
      const id = await agreed(
        { erp_ledger_account_code: "6300" },
        { tenant_id: TENANT, crm_category: "congress" },
        "expense_account_map",
      );
      const err = await refusalOf(
        inTenant((tx) =>
        withAttribution(
          tx,
          { repProfileId: grace, reason: "applying something else entirely", proposalId: id },
          (c) =>
            c.query(
              "UPDATE crm.expense_account_map SET erp_ledger_account_code = '9999' WHERE tenant_id = $1",
              [TENANT],
            ),
        ),
        ),
      );
      expect(err.message).toMatch(/four-eyes-not-what-was-approved/);
      expect(err.message).toMatch(/6300/);
      expect(await accountCode()).toBe("6200");
      // And the right value still goes through on the same approval, so the refusal above was
      // about the value rather than about the proposal being unusable.
      await inTenant((tx) =>
        withAttribution(
          tx,
          { repProfileId: grace, reason: "applying what we agreed", proposalId: id },
          (c) =>
            c.query(
              "UPDATE crm.expense_account_map SET erp_ledger_account_code = '6300' WHERE tenant_id = $1",
              [TENANT],
            ),
        ),
      );
      expect(await accountCode()).toBe("6300");
    });

    it("refuses an approval about another row", async () => {
      for (const [category, code] of [
        ["congress", "6200"],
        ["hospitality", "6210"],
      ] as const) {
        await inTenant((tx) =>
          withAttribution(tx, { repProfileId: ada, reason: `mapping ${category} first time` }, (c) =>
            c.query(
              `INSERT INTO crm.expense_account_map (tenant_id, crm_category, erp_ledger_account_code)
               VALUES ($1, $2, $3)`,
              [TENANT, category, code],
            ),
          ),
        );
      }
      const id = await agreed(
        { erp_ledger_account_code: "6400" },
        { tenant_id: TENANT, crm_category: "congress" },
        "expense_account_map",
      );
      const err = await refusalOf(
        inTenant((tx) =>
        withAttribution(
          tx,
          { repProfileId: grace, reason: "applying it to the wrong category", proposalId: id },
          (c) =>
            c.query(
              `UPDATE crm.expense_account_map SET erp_ledger_account_code = '6400'
                WHERE tenant_id = $1 AND crm_category = 'hospitality'`,
              [TENANT],
            ),
        ),
        ),
      );
      expect(err.message).toMatch(/four-eyes-wrong-row/);
    });

    it("refuses a change naming a proposal nobody has approved yet", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it after the volume review",
        }),
      );
      const err = await refusalOf(
        inTenant((tx) =>
        withAttribution(
          tx,
          { repProfileId: ada, reason: "jumping ahead of the approval", proposalId: proposal.id },
          (c) => changePolicy(c, ada, { arm: true }),
        ),
        ),
      );
      expect(err.message).toMatch(/four-eyes-not-approved/);
      expect(err.message).toMatch(/still waiting/);
      expect(await armed()).toBe(false);
    });

    /**
     * THE GRANTS ARE RE-CHECKED AS THE WRITE LANDS, not only when the approval was given.
     *
     * The gap between an approval and the write it authorises is exactly where a revocation
     * lands, and a proposal two people agreed on while both held the grant is not an agreement
     * between two qualified people if one of them has since lost it.
     */
    it("refuses a change whose approver has since lost the grant", async () => {
      const id = await agreed(ARM);
      await revokeCompliance(grace);
      try {
        const err = await refusalOf(
          inTenant((tx) =>
          withAttribution(
            tx,
            { repProfileId: ada, reason: "applying what we agreed", proposalId: id },
            (c) => changePolicy(c, ada, { arm: true }),
          ),
          ),
        );
        expect(err.message).toMatch(/four-eyes-approver-unqualified/);
        expect(await armed()).toBe(false);
      } finally {
        await restoreCompliance(grace);
      }
    });
  });

  describe("the approval itself", () => {
    /**
     * AN APPROVAL THAT COULD ONLY FAIL IS REFUSED AT THE APPROVAL, with the remedy.
     *
     * `crm.require_four_eyes` re-checks both actors as the write lands, so approving a
     * proposal whose author has since lost the grant would succeed and then be refused one
     * statement later — which reads as a bug in the approval rather than as what it is.
     *
     * REJECTING one is still allowed, and that is the half that makes this safe to enforce:
     * without it a departed officer's proposals could only sit in the queue forever.
     */
    it("cannot be approved once the proposer has lost the grant, but can be rejected", async () => {
      const { proposal } = await inTenant((tx) =>
        proposeConfigChange(tx, TENANT, {
          tableName: "disposal_policy",
          rowKey: POLICY_ROW,
          changes: ARM,
          proposedBy: ada,
          reason: "arming it before she moved on",
        }),
      );
      await revokeCompliance(ada);
      try {
        const err = await refusalOf(
          inTenant((tx) =>
          decideConfigProposal(tx, TENANT, proposal.id, "approved", grace, "agreeing with nobody"),
          ),
        );
        expect(err.message).toMatch(/four-eyes-proposer-unqualified/);
        expect(err.message).toMatch(/Reject it/);
        // And the rejection goes through, which is the point of not covering every decision.
        await inTenant((tx) =>
          decideConfigProposal(
            tx,
            TENANT,
            proposal.id,
            "rejected",
            grace,
            "she has left, so this needs asking again",
          ),
        );
        expect((await inTenant((tx) => configProposal(tx, TENANT, proposal.id)))?.decision).toBe(
          "rejected",
        );
      } finally {
        await restoreCompliance(ada);
      }
    });
  });

  describe("another tenant", () => {
    /**
     * A PROPOSAL ID IS NOT A CAPABILITY. Row-level security confines the lookup, so "no such
     * proposal" and "another tenant's proposal" are the same answer — which is deliberate:
     * probing an id must not tell its holder whether it exists.
     */
    it("cannot see, decide or spend a proposal of this one", async () => {
      const id = await agreed(ARM);
      expect(await inLone((tx) => configProposal(tx, LONE, id))).toBeNull();
      await expect(
        inLone((tx) => decideConfigProposal(tx, LONE, id, "rejected", lone, "refusing a stranger's")),
      ).rejects.toThrow(/four-eyes-unknown-proposal/);
      const err = await refusalOf(
        inLone((tx) =>
        withAttribution(
          tx,
          { repProfileId: lone, reason: "spending somebody else's approval", proposalId: id },
          (c) =>
            c.query(
              `INSERT INTO crm.disposal_policy_change
                 (tenant_id, changed_by, reason, auto_writeoff_promo_to)
               VALUES ($1, $2, 'spending somebody else''s approval', true)`,
              [LONE, lone],
            ),
        ),
        ),
      );
      expect(err.message).toMatch(/four-eyes-unknown-proposal/);
    });
  });

  /**
   * Ends a compliance grant through 0023's own function.
   *
   * Through `crm.revoke_rep_role` rather than an UPDATE, so the revocation meets that
   * migration's four-eyes and lockout rules — a fixture that wrote the columns directly would
   * be ending a grant in a way no route can, and the premise of the two tests that use this is
   * that a REAL revocation landed at an awkward moment.
   */
  const revokeCompliance = (holder: string): Promise<void> =>
    inTenant(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM crm.rep_role
          WHERE tenant_id = $1 AND rep_profile_id = $2 AND role = 'compliance' AND valid_to IS NULL`,
        [TENANT, holder],
      );
      await tx.query("SELECT crm.revoke_rep_role($1, $2, $3, CURRENT_DATE, $4)", [
        rows[0]!.id,
        TENANT,
        holder === ada ? grace : ada,
        "the four-eyes suite needs this grant gone for one test",
      ]);
    });

  /**
   * And puts it back, which needs the append-only trigger off.
   *
   * A revoked grant cannot be un-revoked — that is 0023's guarantee and the right one — and
   * the exclusion constraint refuses a second live grant overlapping the first, so the retired
   * row has to go before a fresh one can exist. Said explicitly here rather than worked around,
   * because a fixture undoing a guarantee should look like one.
   */
  const restoreCompliance = async (holder: string): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
      try {
        await tx.query(
          `DELETE FROM crm.rep_role WHERE tenant_id = $1 AND rep_profile_id = $2 AND role = 'compliance'`,
          [TENANT, holder],
        );
      } finally {
        await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
      }
    });
    await grant(TENANT, holder, "compliance", holder === ada ? grace : ada);
  };

  /** Whether the unattended write-off job is armed for TENANT right now. */
  const armed = async (): Promise<boolean> => {
    const { rows } = await inTenant((tx) =>
      tx.query<{ on: boolean }>(
        "SELECT auto_writeoff_promo AS on FROM crm.disposal_policy WHERE tenant_id = $1",
        [TENANT],
      ),
    );
    return rows[0]?.on ?? false;
  };

  /** Where `congress` posts for TENANT right now. */
  const accountCode = async (): Promise<string | null> => {
    const { rows } = await inTenant((tx) =>
      tx.query<{ code: string }>(
        `SELECT erp_ledger_account_code AS code FROM crm.expense_account_map
          WHERE tenant_id = $1 AND crm_category = 'congress'`,
        [TENANT],
      ),
    );
    return rows[0]?.code ?? null;
  };
});
