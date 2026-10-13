import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import {
  TENANT_ABANDON_LIVE as LIVE,
  TENANT_ABANDON_STOPPED as STOPPED,
  appPool,
  withRegistryTriggersOff,
} from "@crm/db/testing";

import { abandonStoppedTenantWork, sweepAbandonStoppedWork } from "./tenant-deletion.js";

/**
 * Migration 0068 — stopping a tenant stranded its queued work, and `abandoned` is not `dead`.
 *
 * 0050's mark removes a tenant from `activeTenants`, which is the intent: pushing a deleted
 * tenant's rep names and account ids to a third party after the controller ended the relationship
 * is the disclosure the deletion exists to stop. But its `pending` rows in `crm.outbox` and
 * `crm.notification_delivery` then sat forever — never sent, never dead-lettered, never pruned,
 * because the delivery prune keys on `delivered` and a row that never ran will never reach it.
 *
 * WHAT NEEDS A DATABASE, which is most of it:
 *
 *   * the refusal to settle a LIVE tenant, which is a `RAISE` reading `crm.tenant`;
 *   * the terminality of `abandoned`, which is a trigger — and the reason it is a trigger rather
 *     than an argument is that the relay's own settle predicates would overwrite the state if
 *     ever handed the id;
 *   * that an abandoned delivery does NOT hold its notification back from the prune, which is a
 *     view's allow-list and is the opposite of what the same view does for `dead`;
 *   * and that the sweep reads tenants nothing else in this system reads, because they are
 *     `erp_deleted` and every per-tenant job skips them.
 */
describe("abandoning a stopped tenant's queued work (0068)", () => {
  let pool: Pool;
  let client: PoolClient;

  const TOMB = "tomb_00000000000000000000000000000680";
  const SHA = "c".repeat(64);
  let rep = "";
  let endpoint = "";

  const register = (tenantId: string, name: string): Promise<unknown> =>
    client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, name],
    );

  const stop = (tenantId: string): Promise<unknown> =>
    client.query(
      `UPDATE crm.tenant
          SET status = 'erp_deleted', erp_tombstone_id = $2, erp_tombstone_kind = 'tenant_deletion',
              erp_tombstone_deleted_at = now(), erp_tombstone_proof_sha256 = $3,
              erp_tombstone_observed_at = now()
        WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
      [tenantId, TOMB, SHA],
    );

  /** A queued ERP write, exactly as a rep's receipt leaves one behind. */
  const queueOutbox = (tenantId: string, recordId: string): Promise<unknown> =>
    withTenantContext(client, tenantId, (tx) =>
      tx.query(
        // `source_table` and `source_id` are NOT NULL since 0004: every queued write names the
        // CRM row it mirrors, which is what makes a dead letter traceable back to a rep's receipt.
        // A fixture has to say so rather than discovering it as a not-null violation.
        `INSERT INTO crm.outbox
           (tenant_id, entity, operation, target_record_id, payload, source_table, source_id)
         VALUES ($1, 'StockMovement', 'create', $2, '{"quantity":1}'::jsonb,
                 'crm.sample_transaction', gen_random_uuid())`,
        [tenantId, recordId],
      ),
    );

  /** A queued webhook push, which is the one that is a disclosure to a third party. */
  const queueDelivery = async (tenantId: string): Promise<void> => {
    await withTenantContext(client, tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.notification
           (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key)
         VALUES ($1, $2, 'erp_write_failed', 'warning', 'A subject', 'A body',
                 'abandon-' || gen_random_uuid()::text)
         RETURNING id`,
        [tenantId, rep],
      );
      await tx.query(
        `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
         VALUES ($1, $2, $3)`,
        [tenantId, rows[0]!.id, endpoint],
      );
    });
  };

  const states = async (tenantId: string, table: string): Promise<readonly string[]> => {
    const { rows } = await withTenantContext(client, tenantId, (tx) =>
      tx.query<{ state: string }>(
        `SELECT state FROM crm.${table} WHERE tenant_id = $1 ORDER BY state`,
        [tenantId],
      ),
    );
    return rows.map((r) => r.state);
  };

  const refusalOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (err) {
      return (err as { message?: string }).message ?? "";
    }
    throw new Error("expected a refusal, and the call succeeded");
  };

  const wipe = async (): Promise<void> => {
    for (const tenant of [STOPPED, LIVE]) {
      await withTenantContext(client, tenant, async (tx) => {
        // The terminality trigger governs UPDATE, not DELETE, so a fixture handing back its rows
        // needs nothing turned off — which is the right shape: 0068 freezes a state, it does not
        // make the table append-only.
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await register(STOPPED, "A Stopped Tenant");
    await register(LIVE, "A Live Tenant");
    // The rep and the endpoint live in the STOPPED tenant: a notification needs a recipient and a
    // delivery needs an endpoint, and both outlive the stop — which is the state under test.
    const { rows } = await withTenantContext(client, STOPPED, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1, 'abandon-rep', 'ABANDON-1', 'A Rep Of A Deleted Tenant')
         ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [STOPPED],
      ),
    );
    rep = rows[0]!.id;
    const { rows: eps } = await withTenantContext(client, STOPPED, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO crm.notification_endpoint
           (tenant_id, channel, url, secret_env, created_by, created_reason)
         VALUES ($1, 'webhook', 'https://abandon.example.test/hook', 'CRM_ABANDON_SECRET', $2,
                 'the abandon suite needs somewhere for a push to have been going')
         RETURNING id`,
        [STOPPED, rep],
      ),
    );
    endpoint = eps[0]!.id;
  });

  afterAll(async () => {
    await wipe();
    for (const tenant of [STOPPED, LIVE]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("ALTER TABLE crm.notification_endpoint_change DISABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.notification_endpoint_change WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.notification_endpoint_change ENABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    // 0053 refuses to delete a stopped tenant's registry row, which is the guarantee rather than
    // an obstacle — so a fixture handing back the tenants it borrowed says so.
    await withRegistryTriggersOff(client, async () => {
      for (const tenant of [STOPPED, LIVE]) {
        await client.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [tenant]);
      }
    });
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await wipe();
    await stop(STOPPED);
  });

  describe("the refusal, which is the only guard that matters", () => {
    it("refuses a tenant that is still being served, by name", async () => {
      await queueOutbox(LIVE, "crm-sm-abandon-live-1");
      const message = await refusalOf(() =>
        withTenantContext(client, LIVE, (tx) => abandonStoppedTenantWork(tx, LIVE)),
      );
      // THE POINT OF THE GUARD: this function's job is to make queued work unsendable, so running
      // it against an active tenant would destroy that tenant's pending ERP writes.
      expect(message).toContain("abandon-live-tenant");
      expect(message).toContain("not erp_deleted");
      // And nothing moved, which is the half the message cannot promise.
      expect(await states(LIVE, "outbox")).toEqual(["pending"]);
    });

    it("refuses a tenant the registry does not list, rather than taking a caller's word", async () => {
      const ghost = "f9680000-0000-4000-8000-0000000000ff";
      const message = await refusalOf(() =>
        withTenantContext(client, ghost, (tx) => abandonStoppedTenantWork(tx, ghost)),
      );
      // Checked against `crm.tenant` rather than against an argument, because a caller that could
      // assert "this tenant is deleted" would be a caller that could be wrong about it. This is
      // also the open row "a tenant the registry does not list cannot be stopped at all" showing
      // up from the other side: here it fails CLOSED.
      expect(message).toContain("abandon-unregistered-tenant");
    });
  });

  describe("what it settles", () => {
    it("abandons the queued ERP write and the queued push, with the tombstone in the sentence", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-1");
      await queueDelivery(STOPPED);

      const result = await withTenantContext(client, STOPPED, (tx) =>
        abandonStoppedTenantWork(tx, STOPPED),
      );
      expect(result).toMatchObject({ outboxRows: 1, deliveryRows: 1 });
      expect(await states(STOPPED, "outbox")).toEqual(["abandoned"]);
      expect(await states(STOPPED, "notification_delivery")).toEqual(["abandoned"]);

      const { rows } = await withTenantContext(client, STOPPED, (tx) =>
        tx.query<{ reason: string; at: Date | null; dead_reason: string | null }>(
          `SELECT abandoned_reason AS reason, abandoned_at AS at, dead_reason
             FROM crm.outbox WHERE tenant_id = $1`,
          [STOPPED],
        ),
      );
      // UNDER WHAT AUTHORITY, which is the difference between "somebody abandoned this" and "the
      // ERP deleted the tenant under this tombstone, and here is the consequence".
      expect(rows[0]!.reason).toContain(TOMB);
      expect(rows[0]!.reason).toContain("never will");
      expect(rows[0]!.at).not.toBeNull();
      // And NOT in `dead_reason`, which the dead-letter history and the retry path both read.
      expect(rows[0]!.dead_reason).toBeNull();
    });

    it("leaves a dead row alone, because it has its own account of itself", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-dead");
      await withTenantContext(client, STOPPED, (tx) =>
        tx.query(
          `UPDATE crm.outbox SET state = 'dead', dead_at = now(),
                                 dead_reason = 'the ERP refused it: 403 forbidden'
            WHERE tenant_id = $1`,
          [STOPPED],
        ),
      );
      const result = await withTenantContext(client, STOPPED, (tx) =>
        abandonStoppedTenantWork(tx, STOPPED),
      );
      expect(result.outboxRows).toBe(0);
      expect(await states(STOPPED, "outbox")).toEqual(["dead"]);
      // Overwriting that with "the tenant was deleted" would erase the reason somebody may need —
      // which is the whole argument for a fifth state rather than reusing `dead`.
      const { rows } = await withTenantContext(client, STOPPED, (tx) =>
        tx.query<{ dead_reason: string }>("SELECT dead_reason FROM crm.outbox WHERE tenant_id = $1", [
          STOPPED,
        ]),
      );
      expect(rows[0]!.dead_reason).toContain("403 forbidden");
    });

    it("is idempotent, so the mark and the sweep need not coordinate", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-twice");
      expect((await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED))).outboxRows).toBe(1);
      expect((await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED))).outboxRows).toBe(0);
    });

    it("refuses an abandoned row a state, so the terminality is the database's", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-terminal");
      await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED));
      // The relay's `markDead` guards on `state <> 'delivered'` and its `releaseForRetry` on
      // `state <> 'dead'` — so either would overwrite this if handed the id, and the only thing
      // stopping them is that the tenant is not in `activeTenants`, which is a fact two files
      // away about a different table. The trigger makes it a property of the row.
      for (const target of ["pending", "dead", "delivered"]) {
        const message = await refusalOf(() =>
          withTenantContext(client, STOPPED, (tx) =>
            tx.query("UPDATE crm.outbox SET state = $2 WHERE tenant_id = $1", [STOPPED, target]),
          ),
        );
        expect(message, target).toContain("abandoned-is-terminal");
      }
      // And the same on the delivery table, because the state lives on both.
      await queueDelivery(STOPPED);
      await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED));
      expect(
        await refusalOf(() =>
          withTenantContext(client, STOPPED, (tx) =>
            tx.query("UPDATE crm.notification_delivery SET state = 'pending' WHERE tenant_id = $1", [
              STOPPED,
            ]),
          ),
        ),
      ).toContain("abandoned-is-terminal");
    });

    /**
     * And the refusal QUOTES THE ROW rather than asserting a cause, which 0069 had to change:
     * 0068 wrote "was abandoned because the ERP deleted its tenant", true of every abandoned
     * row then in existence and no longer true of all of them — an orphaned push is abandoned
     * too. The rule did not change; the sentence stopped guessing why.
     */
    it("names the row's own reason in the refusal", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-quotes");
      await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED));
      const message = await refusalOf(() =>
        withTenantContext(client, STOPPED, (tx) =>
          tx.query("UPDATE crm.outbox SET state = 'pending' WHERE tenant_id = $1", [STOPPED]),
        ),
      );
      expect(message).toContain("abandoned-is-terminal");
      expect(message).toContain("tenant-deleted:");
      expect(message).toContain(TOMB);
    });

    it("pairs the state with its evidence in both directions, in two constraints", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-pairing");
      const refuse = (sql: string): Promise<string> =>
        refusalOf(() => withTenantContext(client, STOPPED, (tx) => tx.query(sql, [STOPPED])));

      // THE HOLE THIS TEST FOUND, and the reason there are two constraints rather than one. The
      // single `(state = 'abandoned') = (at IS NOT NULL AND reason IS NOT NULL)` I wrote first
      // ACCEPTED this: both sides are false, so it balances — and the row then carries an
      // explanation for a settlement that never happened.
      expect(
        await refuse(
          `UPDATE crm.outbox SET abandoned_reason = 'a reason on a pending row, which is nonsense'
            WHERE tenant_id = $1`,
        ),
      ).toContain("outbox_abandoned_says_why");

      // An abandoned row with no evidence at all: refused by the OTHER constraint, which is why
      // they are separate — a refusal that names which rule broke beats one that hands back a
      // conjunction to read.
      expect(
        await refuse("UPDATE crm.outbox SET state = 'abandoned' WHERE tenant_id = $1"),
      ).toContain("outbox_abandoned_says_when");

      // And a timestamp with no reason, which is the third corner.
      expect(
        await refuse(
          "UPDATE crm.outbox SET state = 'abandoned', abandoned_at = now() WHERE tenant_id = $1",
        ),
      ).toContain("outbox_abandoned_says_why");
    });
  });

  /**
   * THE THING A LATER READER WILL ASSUME IS AN OVERSIGHT, asserted so it cannot be "fixed".
   *
   * `crm.notification_prune_candidates.delivery_unsettled` is an allow-list —
   * `state IN ('pending', 'in_flight', 'dead')` — so `abandoned` is absent and an abandoned
   * delivery does not pin its notification. That is the OPPOSITE of what the same view does for
   * `dead`, deliberately.
   */
  it("does not hold its notification back from the prune, unlike a dead delivery", async () => {
    await queueDelivery(STOPPED);
    const unsettled = async (): Promise<boolean> => {
      const { rows } = await withTenantContext(client, STOPPED, (tx) =>
        tx.query<{ u: boolean }>(
          `SELECT delivery_unsettled AS u FROM crm.notification_prune_candidates
            WHERE tenant_id = $1 LIMIT 1`,
          [STOPPED],
        ),
      );
      return rows[0]!.u;
    };
    // Pending: held, which is 0024's rule and unchanged.
    expect(await unsettled()).toBe(true);

    await withTenantContext(client, STOPPED, (tx) => abandonStoppedTenantWork(tx, STOPPED));
    // Abandoned: NOT held. A dead delivery is an unresolved disclosure attempt somebody may act
    // on; an abandoned one is resolved, definitively, by the tenant ceasing to exist. Holding its
    // notification back would make a deleted tenant's inbox unprunable forever — which is the
    // unboundedness this migration closes, moved one table over.
    expect(await unsettled()).toBe(false);
  });

  describe("the platform sweep", () => {
    it("settles every stopped tenant and reports what it did", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-sweep-1");
      await queueDelivery(STOPPED);
      // The live tenant's row must survive, which is the assertion that makes the sweep's
      // `WHERE status = 'erp_deleted'` mean something rather than being decoration.
      await queueOutbox(LIVE, "crm-sm-abandon-sweep-live");

      const result = await sweepAbandonStoppedWork(pool);
      expect(result.stoppedTenants).toBeGreaterThanOrEqual(1);
      expect(result.outboxRows).toBeGreaterThanOrEqual(1);
      expect(result.deliveryRows).toBeGreaterThanOrEqual(1);
      expect(result.unreadable).toEqual([]);
      expect(result.summary).toContain("SETTLED=");

      expect(await states(STOPPED, "outbox")).toEqual(["abandoned"]);
      expect(await states(LIVE, "outbox")).toEqual(["pending"]);
    });

    it("reads tenants nothing else in this system reads", async () => {
      // THE STRUCTURAL POINT. `activeTenants` is `status = 'active'`, so every per-tenant job
      // skips this tenant — which is why the settle had to be platform work at all, and why 0067
      // predicted its first instance would not be its last.
      const { rows: active } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM crm.tenant WHERE status = 'active' AND tenant_id = $1",
        [STOPPED],
      );
      expect(rows0(active)).toBe("0");
      const { rows: stopped } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM crm.stopped_tenants() WHERE tenant_id = $1",
        [STOPPED],
      );
      expect(rows0(stopped)).toBe("1");
    });

    it("says what it WOULD settle without settling it", async () => {
      await queueOutbox(STOPPED, "crm-sm-abandon-dry");
      // The dry run an operator wants before letting a nightly job make somebody's queue
      // unsendable for the first time — the same courtesy `prunePreview` extends for the
      // notification prune.
      const result = await sweepAbandonStoppedWork(pool, { settle: false });
      expect(result.outboxRows).toBeGreaterThanOrEqual(1);
      expect(result.summary).toContain("dryRun=true");
      expect(await states(STOPPED, "outbox")).toEqual(["pending"]);
    });

    it("settles nothing on a healthy deployment, and says so", async () => {
      const result = await sweepAbandonStoppedWork(pool);
      expect(result.outboxRows).toBe(0);
      expect(result.deliveryRows).toBe(0);
      // A line of zeroes is how an operator knows the backstop is running at all, so `SETTLED=`
      // is absent rather than zero — the convention every line in this process follows.
      expect(result.summary).not.toContain("SETTLED=");
      expect(result.summary).toContain("stopped=");
    });
  });
});

/** Narrows `rows[0]` without a non-null assertion at every call site. */
function rows0(rows: readonly { readonly n: string }[]): string {
  return rows[0]?.n ?? "";
}
