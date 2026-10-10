import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@crm/db";
import { TENANT_DISPOSAL_POLICY as TENANT, appPool, withFourEyes } from "@crm/db/testing";

import {
  DEFAULT_GRACE_DAYS,
  disposalPolicy,
  disposalPolicyDetail,
  disposalPolicyHistory,
  setDisposalPolicy,
} from "./expiry-sweep.js";

/**
 * The SOP parameters, and the record of who changed them.
 *
 * WHAT THIS FILE IS REALLY ABOUT. 0023 built the role model so that `crm.disposal_policy`
 * stopped being settable by anyone holding the application password; it left the second
 * half of its own sentence — "with no record of who changed what" — exactly where it found
 * it. The write was `UPDATE … SET grace_days = 7`, which moved `updated_at` and nothing
 * else, so a deadline loosened last Tuesday by somebody who has since lost the role looked
 * identical to one that had stood for a year.
 *
 * 0059 makes the policy row a PROJECTION of an append-only log, the same relationship a
 * holding has to the custody ledger. The three properties that matter cannot be checked
 * against a fake connection, because all three are the database refusing something:
 *
 *   1. a direct UPDATE of the policy is refused — otherwise the log is advisory;
 *   2. the `from` values are the database's, not the caller's — otherwise the log can lie;
 *   3. the history cannot be edited — otherwise it is not a history.
 */
describe("the disposal policy and its history", () => {
  let pool: Pool;
  let client: PoolClient;

  const OFFICER = "f0591000-0000-4000-8000-000000000001";
  const SECOND = "f0592000-0000-4000-8000-000000000002";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      // Children before parents, and the log's own trigger refuses a DELETE — which is the
      // point of it, so the fixture turns the guarantee off explicitly rather than hunting
      // for a statement that happens to work.
      await tx.query("ALTER TABLE crm.disposal_policy_change DISABLE TRIGGER USER");
      try {
        await tx.query("DELETE FROM crm.disposal_policy_change WHERE tenant_id = $1", [TENANT]);
      } finally {
        await tx.query("ALTER TABLE crm.disposal_policy_change ENABLE TRIGGER USER");
      }
      await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, name] of [
        [OFFICER, "pol-officer", "The Compliance Officer"],
        [SECOND, "pol-second", "A Second Officer"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name, status)
           VALUES ($1,$2,$3,$3,$4,'active') ON CONFLICT (id) DO NOTHING`,
          [id, TENANT, subject, name],
        );
      }
    });
  });

  beforeEach(reset);

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it("starts at the shipped default, set by nobody", async () => {
    const detail = await inTenant((tx) => disposalPolicyDetail(tx, TENANT));
    expect(detail.grace_days).toBe(DEFAULT_GRACE_DAYS);
    expect(detail.auto_writeoff_promo).toBe(false);
    // NULL rather than a placeholder: nobody set this, and a screen saying "set by —"
    // would imply somebody had.
    expect(detail.changed_at).toBeNull();
    expect(detail.changed_by).toBeNull();
    expect(detail.reason).toBeNull();
    expect(await inTenant((tx) => disposalPolicyHistory(tx, TENANT))).toEqual([]);
  });

  it("records who changed it, from what, to what, and why", async () => {
    const after = await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, {
        graceDays: 7,
        changedBy: OFFICER,
        reason: "tightened to seven days after the Q3 inspection finding",
      }),
    );
    expect(after).toEqual({ grace_days: 7, auto_writeoff_promo: false });

    const [change] = await inTenant((tx) => disposalPolicyHistory(tx, TENANT));
    expect(change).toMatchObject({
      changed_by: OFFICER,
      changed_by_name: "The Compliance Officer",
      grace_days_from: DEFAULT_GRACE_DAYS,
      grace_days_to: 7,
      // The knob that was not named keeps its value, so the row still reads as a complete
      // statement of the policy before and after rather than a diff with holes in it.
      auto_writeoff_promo_from: false,
      auto_writeoff_promo_to: false,
    });
    expect(change?.reason).toContain("Q3 inspection");

    const detail = await inTenant((tx) => disposalPolicyDetail(tx, TENANT));
    expect(detail.grace_days).toBe(7);
    expect(detail.changed_by_name).toBe("The Compliance Officer");
    expect(detail.changed_at).toBeInstanceOf(Date);
  });

  it("chains each change onto the last, so the log reads as a sequence", async () => {
    await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, { graceDays: 14, changedBy: OFFICER, reason: "first change, down to a fortnight" }),
    );
    await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, { graceDays: 60, changedBy: SECOND, reason: "second change, back out to sixty days" }),
    );
    const history = await inTenant((tx) => disposalPolicyHistory(tx, TENANT));
    // Newest first, and deterministically so: `changed_at` is `clock_timestamp()` rather
    // than `now()`, because `now()` is the transaction clock and two changes written in one
    // transaction would tie — which is how the first hand-test of this table read back the
    // wrong row.
    expect(history.map((c) => [c.grace_days_from, c.grace_days_to])).toEqual([
      [14, 60],
      [DEFAULT_GRACE_DAYS, 14],
    ]);
    expect(history[0]?.changed_by_name).toBe("A Second Officer");
  });

  it("stamps the previous value itself, so the log cannot be made to lie", async () => {
    await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, { graceDays: 7, changedBy: OFFICER, reason: "down to seven days for the audit" }),
    );
    // A caller claiming the policy used to be 365 — which would make a real tightening read
    // as a loosening. The trigger reads the live row and discards whatever arrived.
    await inTenant((tx) =>
      tx.query(
        `INSERT INTO crm.disposal_policy_change
           (tenant_id, changed_by, reason, grace_days_from, grace_days_to)
         VALUES ($1, $2, 'claiming it used to be a year', 365, 21)`,
        [TENANT, OFFICER],
      ),
    );
    const [latest] = await inTenant((tx) => disposalPolicyHistory(tx, TENANT));
    expect(latest?.grace_days_from).toBe(7);
    expect(latest?.grace_days_to).toBe(21);
  });

  it("refuses a direct UPDATE of the policy, which is what makes the log the record", async () => {
    // The row has to EXIST first, and that is not fixture housekeeping: a FOR EACH ROW
    // trigger cannot refuse an UPDATE that matches nothing, so a test written against a
    // tenant with no policy row passes while proving the opposite. It did, once.
    await inTenant((tx) => disposalPolicy(tx, TENANT));
    await expect(
      inTenant((tx) =>
        tx.query("UPDATE crm.disposal_policy SET grace_days = 1 WHERE tenant_id = $1", [TENANT]),
      ),
    ).rejects.toThrow(/cannot be updated directly/);
    expect((await inTenant((tx) => disposalPolicy(tx, TENANT))).grace_days).toBe(DEFAULT_GRACE_DAYS);
  });

  it("refuses an upsert that smuggles the change into its DO UPDATE clause", async () => {
    // The obvious way around the guard, and measured rather than assumed. The INSERT itself
    // is the permitted bare default row, so the creation rule has nothing to say — it is the
    // BEFORE UPDATE trigger that answers, because `ON CONFLICT DO UPDATE` fires it like any
    // other update.
    await inTenant((tx) => disposalPolicy(tx, TENANT));
    await expect(
      inTenant((tx) =>
        tx.query(
          `INSERT INTO crm.disposal_policy (tenant_id) VALUES ($1)
           ON CONFLICT (tenant_id) DO UPDATE SET grace_days = 3`,
          [TENANT],
        ),
      ),
    ).rejects.toThrow(/cannot be updated directly/);
    expect((await inTenant((tx) => disposalPolicy(tx, TENANT))).grace_days).toBe(DEFAULT_GRACE_DAYS);
  });

  it("creates the policy at the defaults and refuses a policy created at a value nobody set", async () => {
    // The bare INSERT must be ACCEPTED — the lazy default row is 0020's own design. This
    // assertion is also the drift detector for the literals in the guard: change either
    // column default without changing the guard and this goes red immediately.
    await inTenant((tx) =>
      tx.query("INSERT INTO crm.disposal_policy (tenant_id) VALUES ($1)", [TENANT]),
    );
    await inTenant((tx) => tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]));
    await expect(
      inTenant((tx) =>
        tx.query("INSERT INTO crm.disposal_policy (tenant_id, grace_days) VALUES ($1, 3)", [TENANT]),
      ),
    ).rejects.toThrow(/created at the defaults/);
  });

  it("still allows the policy row to be deleted, because a tenant erasure must", async () => {
    // `crm.data_disposition` says `erase` for this table and `executeTenantErasure` deletes
    // it with a plain statement at trigger depth 1. A guard that refused would break the
    // erasure, which is a far worse outcome than the one it would prevent.
    await inTenant((tx) => disposalPolicy(tx, TENANT));
    await expect(
      inTenant((tx) => tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT])),
    ).resolves.toBeTruthy();
  });

  it("refuses a change that changes nothing rather than recording it", async () => {
    await expect(
      inTenant((tx) =>
        setDisposalPolicy(tx, TENANT, {
          graceDays: DEFAULT_GRACE_DAYS,
          changedBy: OFFICER,
          reason: "writing down the value that is already in force",
        }),
      ),
    ).rejects.toMatchObject({ name: "DisposalPolicyError", message: expect.stringContaining("changes nothing") });
    expect(await inTenant((tx) => disposalPolicyHistory(tx, TENANT))).toEqual([]);
  });

  it("refuses a change with no reason worth reading", async () => {
    await expect(
      inTenant((tx) =>
        tx.query(
          `INSERT INTO crm.disposal_policy_change (tenant_id, changed_by, reason, grace_days_to)
           VALUES ($1, $2, '.', 7)`,
          [TENANT, OFFICER],
        ),
      ),
    ).rejects.toThrow(/reason/);
  });

  it("is append-only: a change cannot be edited or deleted afterwards", async () => {
    await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, { graceDays: 7, changedBy: OFFICER, reason: "down to seven for the inspection" }),
    );
    await expect(
      inTenant((tx) => tx.query("UPDATE crm.disposal_policy_change SET reason = 'something else'")),
    ).rejects.toThrow(/append-only/);
    await expect(
      inTenant((tx) => tx.query("DELETE FROM crm.disposal_policy_change")),
    ).rejects.toThrow(/append-only/);
    expect(await inTenant((tx) => disposalPolicyHistory(tx, TENANT))).toHaveLength(1);
  });

  /**
   * Both knobs in one record — and since 0062 that record needs two people, because one of
   * the two knobs is the switch that arms the unattended write-off job.
   *
   * The four-eyes rule is per COLUMN, so a change carrying a four-eyed column and an ordinary
   * one needs the approval; the grace period does not become free because it travelled with
   * something dangerous, and the switch does not become free because it travelled with
   * something routine. The proposal names both values and the log row points at it.
   */
  it("changes both knobs in one record when both move, which takes two people", async () => {
    const after = await inTenant((tx) =>
      withFourEyes(
        tx,
        TENANT,
        {
          tableName: "disposal_policy",
          rowKey: { tenant_id: TENANT },
          changes: { grace_days: 0, auto_writeoff_promo: true },
          role: "compliance",
        },
        (c) =>
          setDisposalPolicy(c, TENANT, {
            graceDays: 0,
            autoWriteoffPromo: true,
            changedBy: OFFICER,
            reason: "same-day disposal, and leaflets go centrally from now on",
          }),
      ),
    );
    expect(after).toEqual({ grace_days: 0, auto_writeoff_promo: true });
    const [change] = await inTenant((tx) => disposalPolicyHistory(tx, TENANT));
    expect(change).toMatchObject({
      grace_days_from: DEFAULT_GRACE_DAYS,
      grace_days_to: 0,
      auto_writeoff_promo_from: false,
      auto_writeoff_promo_to: true,
    });
    // The authority the change rests on, linked structurally rather than mentioned in prose.
    const { rows } = await inTenant((tx) =>
      tx.query<{ linked: boolean }>(
        "SELECT proposal_id IS NOT NULL AS linked FROM crm.disposal_policy_change WHERE tenant_id = $1",
        [TENANT],
      ),
    );
    expect(rows.map((r) => r.linked)).toEqual([true]);
  });

  /**
   * And a grace-period change on its own still takes one signature, with nothing to point at.
   *
   * The control for the test above, and the assertion 0059's reasoning turns on: "a tenant
   * with one compliance officer cannot set its own grace period at all" was the stated reason
   * not to four-eye this table, and 0062 had to leave that true.
   */
  it("still takes one person to move the grace period, and records no proposal", async () => {
    await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, {
        graceDays: 14,
        changedBy: OFFICER,
        reason: "a fortnight, after the regional audit",
      }),
    );
    const { rows } = await inTenant((tx) =>
      tx.query<{ linked: boolean }>(
        "SELECT proposal_id IS NOT NULL AS linked FROM crm.disposal_policy_change WHERE tenant_id = $1",
        [TENANT],
      ),
    );
    expect(rows.map((r) => r.linked)).toEqual([false]);
  });

  /**
   * Disarming it takes one person too, which is the asymmetry the rule is made of.
   *
   * Turning the switch OFF only ever means a person must record each write-off, so it fails
   * safe and needs nobody's agreement. A rule that covered both directions would mean a
   * tenant that armed the job could not stop it without finding a second officer, which is
   * the opposite of what the rule is for.
   */
  it("takes one person to turn it back off", async () => {
    await inTenant((tx) =>
      withFourEyes(
        tx,
        TENANT,
        {
          tableName: "disposal_policy",
          rowKey: { tenant_id: TENANT },
          changes: { auto_writeoff_promo: true },
          role: "compliance",
        },
        (c) =>
          setDisposalPolicy(c, TENANT, {
            autoWriteoffPromo: true,
            changedBy: OFFICER,
            reason: "arming it, which took two people",
          }),
      ),
    );
    const off = await inTenant((tx) =>
      setDisposalPolicy(tx, TENANT, {
        autoWriteoffPromo: false,
        changedBy: OFFICER,
        reason: "and one person stopping it again",
      }),
    );
    expect(off).toMatchObject({ auto_writeoff_promo: false });
  });

  it("caps the history and takes the newest, which is what a screen shows", async () => {
    for (const days of [1, 2, 3, 4]) {
      await inTenant((tx) =>
        setDisposalPolicy(tx, TENANT, { graceDays: days, changedBy: OFFICER, reason: `moving it to ${days} day(s)` }),
      );
    }
    const two = await inTenant((tx) => disposalPolicyHistory(tx, TENANT, { limit: 2 }));
    expect(two.map((c) => c.grace_days_to)).toEqual([4, 3]);
  });
});
