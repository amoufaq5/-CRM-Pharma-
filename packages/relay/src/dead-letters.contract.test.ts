import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_DEAD_LETTERS as TENANT, testPool } from "@crm/db/testing";
import { inbox } from "@crm/notify";

import {
  deadLetter,
  deadLetters,
  outboxLetterOwner,
  raiseDeadLetterAlarm,
  reviveDeadLetter,
  teamDeadLetters,
} from "./dead-letters.js";
import { enqueueOutbox, markDead } from "./store.js";

/**
 * Dead letters against a real Postgres.
 *
 * The gap being closed: a write the ERP refuses permanently used to go to `dead` and stop
 * there. The rep's app had already shown it as recorded — because in the CRM it IS — so the
 * only half that failed is the half they cannot see.
 */
describe("dead letters", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "d1100000-0000-4000-8000-000000000001";
  const MANAGER = "d1200000-0000-4000-8000-000000000002";
  const PEER = "d1300000-0000-4000-8000-000000000003";
  const REGION = "d1400000-0000-4000-8000-000000000004";
  const TERRITORY = "d1500000-0000-4000-8000-000000000005";
  const ELSEWHERE = "d1600000-0000-4000-8000-000000000006";
  /** A tenant this suite never writes as — only reads from, to prove RLS is the predicate. */
  const FOREIGN_TENANT = "d1000000-0000-4000-8000-0000000000b9";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [REP, "dl-rep"],
        [MANAGER, "dl-mgr"],
        [PEER, "dl-peer"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, n],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES
           ($1,$4,'DL-REGION','Region'), ($2,$4,'DL-T','Territory'), ($3,$4,'DL-ELSE','Elsewhere')
         ON CONFLICT DO NOTHING`,
        [REGION, TERRITORY, ELSEWHERE, TENANT],
      );
      await tx.query("UPDATE crm.territory SET parent_id = $1 WHERE id = $2", [REGION, TERRITORY]);
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary','2026-01-01'), ($1,$4,$5,'manager','2026-01-01'),
                ($1,$6,$7,'manager','2026-01-01')
         ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY, REP, REGION, MANAGER, ELSEWHERE, PEER],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
         VALUES ($1,$2,'DL-ACC','2026-01-01') ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY],
      );
    });
  });

  afterAll(async () => {
    await reset();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      try {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
        // `crm.outbox_dead_letter` has NO foreign key to `crm.outbox` on purpose (0036) —
        // a death has to outlive its queue row — so deleting the queue leaves every
        // previous run's episodes in this tenant. Nothing here counts them today, which is
        // the only reason it has not flaked; one count-based assertion away from doing so.
        await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      } finally {
        await tx.query("ALTER TABLE crm.sample_transaction ENABLE TRIGGER USER");
        await tx.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");
      }
    });
  };

  beforeEach(reset);

  /** A real producer: a sample movement, with the outbox row the mirror would enqueue. */
  const aFailedWrite = async (
    tx: PoolClient,
    opts: { rep?: string; sourceTable?: string } = {},
  ): Promise<{ outboxId: string; sourceId: string }> => {
    const rep = opts.rep ?? REP;
    const lot = await tx.query<{ id: string }>(
      `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
       VALUES ($1,'DL-ITEM',$2,'2027-12-31','drug_sample') RETURNING id`,
      [TENANT, `LOT-${randomUUID().slice(0, 8)}`],
    );
    const movementId = randomUUID();
    await tx.query(
      `INSERT INTO crm.sample_transaction
         (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
       VALUES ($1,$2,$3,$4,'receipt',10,'DL-WH','2026-10-01T08:00:00Z')`,
      [movementId, TENANT, lot.rows[0]!.id, rep],
    );
    const { id } = (
      await enqueueOutbox(tx, TENANT, {
        entity: "StockMovement",
        operation: "create",
        payload: { item_id: "DL-ITEM" },
        targetRecordId: `crm-sm-${movementId}`,
        sourceTable: opts.sourceTable ?? "crm.sample_transaction",
        sourceId: movementId,
      })
    );
    return { outboxId: id, sourceId: movementId };
  };

  describe("attribution", () => {
    it("resolves the rep behind a sample movement", async () => {
      await inTenant(async (tx) => {
        const { sourceId } = await aFailedWrite(tx);
        const { rows } = await tx.query<{ rep: string | null }>(
          "SELECT crm.outbox_recipient('crm.sample_transaction', $1) AS rep",
          [sourceId],
        );
        expect(rows[0]!.rep).toBe(REP);
      });
    });

    it("resolves a visit and an expense claim too", async () => {
      await inTenant(async (tx) => {
        const visitId = randomUUID();
        await tx.query(
          `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
           VALUES ($1,$2,$3,'DL-ACC','completed','2026-10-05T09:00:00Z')`,
          [visitId, TENANT, REP],
        );
        const claim = await tx.query<{ id: string }>(
          `INSERT INTO crm.expense_claim (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
           VALUES ($1,$2,'detailing',12.50,'AED','2026-10-05') RETURNING id`,
          [TENANT, REP],
        );
        const { rows } = await tx.query<{ v: string | null; e: string | null }>(
          `SELECT crm.outbox_recipient('crm.visit', $1) AS v,
                  crm.outbox_recipient('crm.expense_claim', $2) AS e`,
          [visitId, claim.rows[0]!.id],
        );
        expect(rows[0]!.v).toBe(REP);
        expect(rows[0]!.e).toBe(REP);
        await tx.query("ALTER TABLE crm.visit DISABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.visit WHERE id = $1", [visitId]);
        await tx.query("ALTER TABLE crm.visit ENABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
      });
    });

    /**
     * An unmapped producer returns NULL rather than guessing. Adding a producer means adding
     * a branch, which is visible in a diff; inferring one would be invisible when wrong.
     */
    it("returns null for a source table it does not know", async () => {
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ rep: string | null }>(
          "SELECT crm.outbox_recipient('crm.something_new', $1) AS rep",
          [randomUUID()],
        );
        expect(rows[0]!.rep).toBeNull();
      });
    });
  });

  describe("raising the alarm", () => {
    it("tells the rep urgently and their manager as a warning", async () => {
      await inTenant(async (tx) => {
        const { outboxId, sourceId } = await aFailedWrite(tx);
        await markDead(tx, outboxId, new Date(), "ERP refused: ledger account 6200 does not exist");

        const alarm = await raiseDeadLetterAlarm(
          tx,
          TENANT,
          {
            id: outboxId,
            entity: "StockMovement",
            operation: "create",
            source_table: "crm.sample_transaction",
            source_id: sourceId,
          },
          "ERP refused: ledger account 6200 does not exist",
        );
        expect(alarm.repProfileId).toBe(REP);
        expect(alarm.notified).toBe(2);

        const repItems = await inbox(tx, REP);
        expect(repItems).toHaveLength(1);
        expect(repItems[0]!.kind).toBe("erp_write_failed");
        // Urgent for the rep: they are the one who believes this already happened.
        expect(repItems[0]!.severity).toBe("urgent");
        expect(repItems[0]!.body).toMatch(/saved here, so nothing is lost/);
        expect(repItems[0]!.body).toMatch(/ledger account 6200/);
        expect(repItems[0]!.subject_id).toBe(outboxId);

        const mgrItems = await inbox(tx, MANAGER);
        expect(mgrItems).toHaveLength(1);
        expect(mgrItems[0]!.severity).toBe("warning");
        // Most causes are configuration on the ERP side, which is what the escalation says.
        expect(mgrItems[0]!.body).toMatch(/configuration on the ERP side/);

        expect(await inbox(tx, PEER)).toHaveLength(0);
      });
    });

    /**
     * The honest case. A producer that cannot be mapped to a rep is counted, not silently
     * dropped — and it still appears in the listing, precisely because nobody was told.
     */
    it("reports that it could not attribute an unmapped producer", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx, { sourceTable: "crm.something_new" });
        await markDead(tx, outboxId, new Date(), "ERP refused");
        const alarm = await raiseDeadLetterAlarm(
          tx,
          TENANT,
          {
            id: outboxId,
            entity: "StockMovement",
            operation: "create",
            source_table: "crm.something_new",
            source_id: randomUUID(),
          },
          "ERP refused",
        );
        expect(alarm.repProfileId).toBeNull();
        expect(alarm.notified).toBe(0);

        // Visible anyway, with a null rep — hiding it would hide the one case nobody heard
        // about.
        const letters = await deadLetters(tx);
        expect(letters).toHaveLength(1);
        expect(letters[0]!.rep_profile_id).toBeNull();
      });
    });
  });

  describe("the listing", () => {
    it("shows the caller's failed writes with the reason and the context", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        await markDead(tx, outboxId, new Date(), "ERP refused: 403 forbidden");
        const [letter] = await deadLetters(tx, { repProfileId: REP });
        expect(letter!.id).toBe(outboxId);
        expect(letter!.entity).toBe("StockMovement");
        expect(letter!.operation).toBe("create");
        expect(letter!.dead_reason).toMatch(/403 forbidden/);
        expect(letter!.display_name).toBe("dl-rep");
        expect(letter!.revive_count).toBe(0);
      });
    });

    it("does not show a live row", async () => {
      await inTenant(async (tx) => {
        await aFailedWrite(tx);
        expect(await deadLetters(tx)).toHaveLength(0);
      });
    });

    it("scopes a manager to their team and a peer to nothing", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        await markDead(tx, outboxId, new Date(), "ERP refused");
        expect(await teamDeadLetters(tx, MANAGER)).toHaveLength(1);
        expect(await teamDeadLetters(tx, PEER)).toHaveLength(0);
      });
    });

    it("finds one by id, and only while it is dead", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        expect(await deadLetter(tx, outboxId)).toBeNull();
        await markDead(tx, outboxId, new Date(), "ERP refused");
        const found = await deadLetter(tx, outboxId);
        expect(found?.id).toBe(outboxId);
        expect(found?.rep_profile_id).toBe(REP);
      });
    });
  });

  describe("reviving", () => {
    it("queues it again with the attempts reset", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        await tx.query("UPDATE crm.outbox SET attempts = 6 WHERE id = $1", [outboxId]);
        await markDead(tx, outboxId, new Date(), "ERP refused: 404 on transition");

        expect(await reviveDeadLetter(tx, outboxId, MANAGER)).toBe(true);

        const { rows } = await tx.query<{
          state: string;
          attempts: number;
          revive_count: number;
          revived_by: string;
          dead_at: Date | null;
          dead_reason: string | null;
        }>(
          `SELECT state, attempts, revive_count, revived_by, dead_at, dead_reason
             FROM crm.outbox WHERE id = $1`,
          [outboxId],
        );
        expect(rows[0]!.state).toBe("pending");
        // Reset to zero: the point of a revive is that the cause was fixed, so carrying the
        // old count would dead-letter it again after one or two tries.
        expect(rows[0]!.attempts).toBe(0);
        expect(rows[0]!.revive_count).toBe(1);
        expect(rows[0]!.revived_by).toBe(MANAGER);
        expect(rows[0]!.dead_at).toBeNull();
        // Kept: "died, tried again" reads differently from a fresh failure.
        expect(rows[0]!.dead_reason).toMatch(/404 on transition/);
      });
    });

    it("refuses to revive a row that is not dead", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        // Reviving a live row would reset its attempts and could duplicate an in-flight call.
        expect(await reviveDeadLetter(tx, outboxId, MANAGER)).toBe(false);
      });
    });

    /**
     * A second death IS news — so the dedup key carries the revive count. Without it the
     * second alarm would be deduped against the first and the retry would fail in silence.
     */
    it("alarms again when a revived write dies a second time", async () => {
      await inTenant(async (tx) => {
        const { outboxId, sourceId } = await aFailedWrite(tx);
        const row = {
          id: outboxId,
          entity: "StockMovement",
          operation: "create",
          source_table: "crm.sample_transaction",
          source_id: sourceId,
        };

        await markDead(tx, outboxId, new Date(), "first failure");
        await raiseDeadLetterAlarm(tx, TENANT, row, "first failure");
        expect((await inbox(tx, REP)).filter((i) => i.kind === "erp_write_failed")).toHaveLength(1);

        // A repeat of the SAME death does not notify again.
        await raiseDeadLetterAlarm(tx, TENANT, row, "first failure");
        expect((await inbox(tx, REP)).filter((i) => i.kind === "erp_write_failed")).toHaveLength(1);

        await reviveDeadLetter(tx, outboxId, MANAGER);
        await markDead(tx, outboxId, new Date(), "second failure, same reason");
        await raiseDeadLetterAlarm(tx, TENANT, row, "second failure, same reason");
        expect((await inbox(tx, REP)).filter((i) => i.kind === "erp_write_failed")).toHaveLength(2);
      });
    });

    it("counts repeated revivals, so a row that keeps dying reads as one", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);
        for (let i = 1; i <= 3; i += 1) {
          await markDead(tx, outboxId, new Date(), `failure ${i}`);
          expect(await reviveDeadLetter(tx, outboxId, MANAGER)).toBe(true);
        }
        const { rows } = await tx.query<{ revive_count: number }>(
          "SELECT revive_count FROM crm.outbox WHERE id = $1",
          [outboxId],
        );
        expect(rows[0]!.revive_count).toBe(3);
      });
    });
  });

  /**
   * `deadLetter` carries `state = 'dead'`; this does not, and the difference is the whole
   * point. A route that authorises reading a death HISTORY cannot use the dead-only lookup,
   * because the history becomes unreadable the moment a revive succeeds — which is the
   * moment "why did this take four attempts" is worth asking.
   */
  describe("attributing a queue row in any state", () => {
    it("answers for a row that is pending, dead, revived and delivered alike", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx);

        expect(await outboxLetterOwner(tx, outboxId)).toMatchObject({
          id: outboxId,
          state: "pending",
          rep_profile_id: REP,
          revive_count: 0,
        });
        // Dead-only lookup says nothing yet.
        expect(await deadLetter(tx, outboxId)).toBeNull();

        await markDead(tx, outboxId, new Date(), "ERP refused");
        expect(await outboxLetterOwner(tx, outboxId)).toMatchObject({ state: "dead", rep_profile_id: REP });
        expect(await deadLetter(tx, outboxId)).not.toBeNull();

        expect(await reviveDeadLetter(tx, outboxId, MANAGER)).toBe(true);
        expect(await outboxLetterOwner(tx, outboxId)).toMatchObject({
          state: "pending",
          rep_profile_id: REP,
          revive_count: 1,
        });
        // And here is the divergence that matters.
        expect(await deadLetter(tx, outboxId)).toBeNull();

        await tx.query("UPDATE crm.outbox SET state = 'delivered' WHERE id = $1", [outboxId]);
        expect(await outboxLetterOwner(tx, outboxId)).toMatchObject({ state: "delivered", rep_profile_id: REP });
      });
    });

    it("reports no rep for a producing table nothing maps", async () => {
      await inTenant(async (tx) => {
        const { outboxId } = await aFailedWrite(tx, { sourceTable: "crm.not_a_producer" });
        expect(await outboxLetterOwner(tx, outboxId)).toMatchObject({ rep_profile_id: null });
      });
    });

    it("is null for an id that does not exist", async () => {
      await inTenant(async (tx) => {
        expect(await outboxLetterOwner(tx, randomUUID())).toBeNull();
      });
    });

    /**
     * The query has no tenant predicate of its own, exactly as `deadLetter` has none: RLS
     * is the predicate. Pinned here because this function is an AUTHORISATION gate — a
     * route uses its answer to decide whether a caller may read a history — so "another
     * tenant's id is indistinguishable from a missing one" has to be a property, not a
     * coincidence of how the test happens to connect.
     */
    it("cannot attribute another tenant's row", async () => {
      // Committed before the foreign read, so an absence means the policy hid it rather
      // than that it was not there yet.
      const outboxId = await inTenant(async (tx) => (await aFailedWrite(tx)).outboxId);
      await withTenantContext(client, FOREIGN_TENANT, async (other) => {
        expect(await outboxLetterOwner(other, outboxId)).toBeNull();
      });
    });
  });
});
