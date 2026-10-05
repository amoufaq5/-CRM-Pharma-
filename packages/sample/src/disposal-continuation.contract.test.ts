import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_DISPOSAL_REOPEN as TENANT, appPool } from "@crm/db/testing";

import { inbox } from "@crm/notify";

import { disposalHistory, setDisposalPolicy, sweepExpiredStock } from "./expiry-sweep.js";
import { recallTransfer } from "./recall.js";
import {
  acceptTransfer,
  ledgerFor,
  openObligations,
  receiveSamples,
  registerLot,
  transferOut,
  writeOff,
  type SampleLot,
} from "./store.js";

/**
 * A disposal deadline that survives the material leaving custody and coming back (0030).
 *
 * WHAT WAS BROKEN. 0020 keys `due_by` to discovery and resolves an obligation when the
 * holding reaches zero — including by `transfer_out`, attributed as `transferred`. So
 * sending the expired carton away and taking it back produced a NEW obligation with a
 * fresh deadline, and 0025's recall made that a thing the sender could do alone. The
 * deadline in an SOP about destroying expired drug samples was resettable at will.
 *
 * Every assertion here is a variation on one sentence: material that comes back is the
 * same disposal, not a new one. The deadline is inherited verbatim, the resolved row is
 * left exactly as it was, and both rows stay readable — so the record says the stock was
 * transferred away and came back rather than presenting an obligation with no history.
 *
 * `TENANT_DISPOSAL_REOPEN` is this file's own reserved tenant.
 */
describe("a disposal deadline across a round trip", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "f1100000-0000-4000-8000-000000000001";
  const OTHER_REP = "f1200000-0000-4000-8000-000000000002";
  const WAREHOUSE = "DR-WH-1";

  const day = (d: string): Date => new Date(`${d}T09:00:00Z`);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
        await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      }
      try {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        // One statement for the whole chain: `continues_obligation_id` is ON DELETE
        // RESTRICT, and deleting a continuation before the row it continues in two
        // statements would be refused.
        await tx.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
      } finally {
        for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
        }
      }
    });
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [REP, "roundtrip-rep"],
        [OTHER_REP, "roundtrip-other"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, n],
        );
      }
    });
  });

  afterAll(async () => {
    await reset();
    client?.release();
    await pool?.end();
  });

  beforeEach(reset);

  /** Stock that expires while the rep holds it — the only legitimate way in (0020). */
  const heldStock = async (
    tx: PoolClient,
    opts: { expiry: string; quantity?: number; rep?: string },
  ): Promise<SampleLot> => {
    const lot = await registerLot(tx, TENANT, {
      erpItemId: "DR-ITEM",
      lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: "drug_sample",
      expiryDate: opts.expiry,
    });
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: opts.rep ?? REP,
      quantity: opts.quantity ?? 10,
      occurredAt: day("2026-01-15"),
      erpWarehouseId: WAREHOUSE,
    });
    return lot;
  };

  /**
   * The unilateral path, end to end: expired stock sent to a colleague who never touches
   * it, a sweep that runs while it is in transit and so resolves the obligation as
   * `transferred`, then a recall by the sender alone.
   *
   * The sweep in the middle is not incidental — it is the whole mechanism. While the
   * material sits in `quantity_in_transit` neither rep has an on-hand holding, so the
   * sender's obligation reaches zero and closes. A recall between two sweeps resolves
   * nothing and resets nothing, which is why the resolution is asserted here: a test
   * whose dates drifted would otherwise stop exercising the bug and still pass.
   */
  const sendSweepRecall = async (
    tx: PoolClient,
    lot: SampleLot,
    opts: { quantity: number; sentOn: string; sweptOn: string; recalledOn: string },
  ): Promise<{ transferOutId: string }> => {
    const sent = await transferOut(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: REP,
      quantity: opts.quantity,
      occurredAt: day(opts.sentOn),
      toRepProfileId: OTHER_REP,
    });
    const closing = await sweepExpiredStock(tx, TENANT, { asOf: day(opts.sweptOn) });
    expect(closing.resolved).toBe(1);
    await recallTransfer(tx, TENANT, {
      id: randomUUID(),
      transferOf: sent.id,
      repProfileId: REP,
      occurredAt: day(opts.recalledOn),
      reason: "collection never happened",
    });
    return { transferOutId: sent.id };
  };

  describe("the deadline", () => {
    it("does not move when a recall brings the material back", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        const first = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(first.opened).toBe(1);
        expect(first.continued).toBe(0);
        expect((await openObligations(tx, REP, { asOf: "2026-04-10" }))[0]!.due_by).toBe("2026-05-10");

        // Out of custody, so the sweep closes the obligation and attributes it.
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: day("2026-04-20"),
          toRepProfileId: OTHER_REP,
        });
        const closing = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-21") });
        expect(closing.resolved).toBe(1);
        expect(await openObligations(tx, REP, { asOf: "2026-04-21" })).toHaveLength(0);

        // …and back again, by the sender alone.
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: REP,
          occurredAt: day("2026-04-22"),
        });
        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-23") });
        expect(after.opened).toBe(1);
        expect(after.continued).toBe(1);

        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-23" });
        // THE ASSERTION THE WHOLE FILE IS FOR. Before 0030 this read 2026-05-23.
        expect(obligation!.due_by).toBe("2026-05-10");
        expect(obligation!.discovered_on).toBe("2026-04-10");
      });
    });

    it("does not move when two reps bounce the material between them", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const out = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: day("2026-04-20"),
          toRepProfileId: OTHER_REP,
        });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: out.id,
          repProfileId: OTHER_REP,
          occurredAt: day("2026-04-21"),
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-22") });

        const back = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: OTHER_REP,
          quantity: 10,
          occurredAt: day("2026-04-23"),
          toRepProfileId: REP,
        });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: back.id,
          repProfileId: REP,
          occurredAt: day("2026-04-24"),
        });

        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-25") });
        expect(after.continued).toBe(1);
        expect((await openObligations(tx, REP, { asOf: "2026-04-25" }))[0]!.due_by).toBe("2026-05-10");
      });
    });

    it("survives three round trips rather than drifting one hop at a time", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        for (const [sentOn, sweptOn, recalledOn, resweptOn] of [
          ["2026-04-12", "2026-04-13", "2026-04-14", "2026-04-15"],
          ["2026-04-17", "2026-04-18", "2026-04-19", "2026-04-20"],
          ["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25"],
        ] as const) {
          await sendSweepRecall(tx, lot, { quantity: 10, sentOn, sweptOn, recalledOn });
          const pass = await sweepExpiredStock(tx, TENANT, { asOf: day(resweptOn) });
          expect(pass.continued).toBe(1);
        }

        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-25" });
        expect(obligation!.due_by).toBe("2026-05-10");
        expect(obligation!.discovered_on).toBe("2026-04-10");
      });
    });

    /**
     * The reason the carried deadline is inherited VERBATIM rather than as
     * `LEAST(carried, today + grace)`. Taking the earlier of the two would let a
     * shortened policy pull in a deadline a rep had already been given, which is the
     * same wrong as letting a recall push it out.
     */
    it("is neither lengthened by a longer policy nor shortened by a shorter one", async () => {
      await inTenant(async (tx) => {
        await setDisposalPolicy(tx, TENANT, { graceDays: 30 });
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        await setDisposalPolicy(tx, TENANT, { graceDays: 365 });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-12", sweptOn: "2026-04-13", recalledOn: "2026-04-14",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-15") });
        expect((await openObligations(tx, REP, { asOf: "2026-04-15" }))[0]!.due_by).toBe("2026-05-10");

        await setDisposalPolicy(tx, TENANT, { graceDays: 0 });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-17", sweptOn: "2026-04-18", recalledOn: "2026-04-19",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-20") });
        expect((await openObligations(tx, REP, { asOf: "2026-04-20" }))[0]!.due_by).toBe("2026-05-10");
      });
    });

    /**
     * Taking back material you had already let run late tells your manager in the same
     * pass, rather than buying another grace period. Step 4 of the sweep does this with
     * no special case: a continuation born with a past deadline is just an obligation
     * past its deadline.
     */
    it("is already overdue when the carried deadline has passed, in the same sweep", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-20", sweptOn: "2026-04-21", recalledOn: "2026-05-19",
        });

        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-05-20") });
        expect(after.continued).toBe(1);
        expect(after.markedOverdue).toBe(1);

        const [obligation] = await openObligations(tx, REP, { asOf: "2026-05-20" });
        expect(obligation!.status).toBe("overdue");
        expect(obligation!.days_overdue).toBe(10);
      });
    });
  });

  describe("a genuinely new expiry", () => {
    it("gets its own dates on a different lot", async () => {
      await inTenant(async (tx) => {
        const old = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await sendSweepRecall(tx, old, {
          quantity: 10, sentOn: "2026-04-12", sweptOn: "2026-04-13", recalledOn: "2026-04-14",
        });

        // A second carton, a different lot, expiring later.
        const fresh = await heldStock(tx, { expiry: "2026-04-30", quantity: 4 });

        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-05-02") });
        expect(after.opened).toBe(2);
        // The old lot's row inherits; the new lot's does not.
        expect(after.continued).toBe(1);

        const open = await openObligations(tx, REP, { asOf: "2026-05-02" });
        const carried = open.find((o) => o.lot_id === old.id)!;
        const own = open.find((o) => o.lot_id === fresh.id)!;
        expect(carried.discovered_on).toBe("2026-04-10");
        expect(carried.due_by).toBe("2026-05-10");
        expect(own.discovered_on).toBe("2026-05-02");
        expect(own.due_by).toBe("2026-06-01");

        const { rows } = await tx.query<{ continues_obligation_id: string | null }>(
          "SELECT continues_obligation_id FROM crm.disposal_obligation WHERE id = $1",
          [own.id],
        );
        expect(rows[0]!.continues_obligation_id).toBeNull();
      });
    });

    /**
     * A lot fully destroyed and a second obligation are not the same shape as a round
     * trip, and the distinction has to survive: the new lot's deadline is its own.
     */
    it("is unaffected by an earlier lot's obligation having been discharged", async () => {
      await inTenant(async (tx) => {
        const first = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await writeOff(tx, TENANT, {
          id: randomUUID(),
          lotId: first.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: day("2026-04-15"),
          kind: "destruction",
          reason: "destroyed at depot, witnessed by QA per SOP-14",
        });
        expect((await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-16") })).resolved).toBe(1);

        const second = await heldStock(tx, { expiry: "2026-04-30", quantity: 5 });
        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-05-02") });
        expect(after.opened).toBe(1);
        expect(after.continued).toBe(0);
        const [obligation] = await openObligations(tx, REP, { asOf: "2026-05-02" });
        expect(obligation!.lot_id).toBe(second.id);
        expect(obligation!.due_by).toBe("2026-06-01");
      });
    });

    /**
     * The deliberate boundary (0030's closing note). The deadline is carried per
     * (rep, lot), so a rep who has never held this lot starts their own grace period —
     * holding someone to a deadline they were never given is the mirror image of the bug
     * being fixed. Pinned so it reads as a decision rather than an oversight.
     */
    it("is what a rep receiving the lot for the first time gets", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const out = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: day("2026-04-20"),
          toRepProfileId: OTHER_REP,
        });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: out.id,
          repProfileId: OTHER_REP,
          occurredAt: day("2026-04-21"),
        });

        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-22") });
        expect(after.continued).toBe(0);
        const [obligation] = await openObligations(tx, OTHER_REP, { asOf: "2026-04-22" });
        expect(obligation!.discovered_on).toBe("2026-04-22");
        expect(obligation!.due_by).toBe("2026-05-22");
      });
    });
  });

  describe("the record of what happened", () => {
    it("keeps the resolved obligation exactly as it was resolved", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        const { transferOutId } = await sendSweepRecall(tx, lot, {
          quantity: 10,
          sentOn: "2026-04-20",
          sweptOn: "2026-04-21",
          recalledOn: "2026-04-22",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-23") });

        const chain = await disposalHistory(tx, REP, lot.id);
        expect(chain).toHaveLength(2);

        const [resolvedRow, continuation] = chain;
        expect(resolvedRow!.status).toBe("resolved");
        expect(resolvedRow!.resolution).toBe("transferred");
        expect(resolvedRow!.resolved_on).not.toBeNull();
        // The attributed ledger fact is untouched: this material left this rep's custody
        // by THIS transaction, and re-opening the row would have had to erase that.
        expect(resolvedRow!.resolving_transaction_id).toBe(transferOutId);
        expect(resolvedRow!.resolving_transaction_kind).toBe("transfer_out");
        expect(resolvedRow!.continues_obligation_id).toBeNull();

        expect(continuation!.status).toBe("open");
        expect(continuation!.continues_obligation_id).toBe(resolvedRow!.id);
        expect(continuation!.due_by).toBe(resolvedRow!.due_by);
        expect(continuation!.discovered_on).toBe(resolvedRow!.discovered_on);
        expect(continuation!.resolution).toBeNull();
        expect(continuation!.sequence_number).toBe(2);
      });
    });

    it("reads as a round trip in the custody ledger alongside it", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-20", sweptOn: "2026-04-21", recalledOn: "2026-04-22",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-23") });

        // The two halves of the trip, append-only, with the obligation chain naming the
        // first of them. "An obligation exists" and "the stock went away and came back"
        // are different facts and both are present. `ledgerFor` reads newest first.
        expect((await ledgerFor(tx, { lotId: lot.id })).map((t) => t.kind)).toEqual([
          "transfer_recall",
          "transfer_out",
          "receipt",
        ]);
        const chain = await disposalHistory(tx, REP, lot.id);
        expect(chain.map((c) => c.status)).toEqual(["resolved", "open"]);
      });
    });

    it("has nothing to show for a lot that never had an obligation", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-12-31", quantity: 10 });
        expect(await disposalHistory(tx, REP, lot.id)).toHaveLength(0);
      });
    });

    it("does not let an obligation continue itself", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-10" });
        await expect(
          tx.query("UPDATE crm.disposal_obligation SET continues_obligation_id = id WHERE id = $1", [
            obligation!.id,
          ]),
        ).rejects.toThrow(/disposal_continuation_not_self/);
      });
    });
  });

  describe("telling the rep", () => {
    it("says the deadline has not moved, rather than deduplicating into silence", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-20", sweptOn: "2026-04-21", recalledOn: "2026-04-22",
        });

        const after = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-23") });
        expect(after.continued).toBe(1);
        expect(after.notified).toBe(1);

        const items = await inbox(tx, REP);
        expect(items).toHaveLength(2);
        const resumed = items.find((i) => i.subject.includes("back in your custody"))!;
        expect(resumed.kind).toBe("disposal_obligation_raised");
        // The fact a fresh grace period would have hidden.
        expect(resumed.body).toContain("the deadline has not moved");
        expect(resumed.body).toContain("2026-05-10");
      });
    });

    it("does not repeat itself on the next night", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await sendSweepRecall(tx, lot, {
          quantity: 10, sentOn: "2026-04-20", sweptOn: "2026-04-21", recalledOn: "2026-04-22",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-23") });

        const second = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-24") });
        expect(second.opened).toBe(0);
        expect(second.continued).toBe(0);
        expect(second.notified).toBe(0);
        expect(await inbox(tx, REP)).toHaveLength(2);
      });
    });

    /**
     * Retention keeps a notification whose subject is unfinished, and
     * `crm.notification_subject_open` matches on the id — so a notice about a live
     * regulated disposal needs one or it prunes at the ordinary horizon. The sweep's
     * raise had `subject_table` and no `subject_id`, which made the predicate
     * unanswerable for exactly the deadline this file preserves.
     */
    it("names the obligation, so retention can see it is unfinished", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-10" });

        const { rows } = await tx.query<{ subject_id: string | null; open: boolean }>(
          `SELECT subject_id,
                  crm.notification_subject_open(subject_table, subject_id) AS open
             FROM crm.notification
            WHERE tenant_id = $1 AND kind = 'disposal_obligation_raised'`,
          [TENANT],
        );
        expect(rows[0]!.subject_id).toBe(obligation!.id);
        expect(rows[0]!.open).toBe(true);
      });
    });
  });
});
