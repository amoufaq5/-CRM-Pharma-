import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_EXPIRY_SWEEP as TENANT, testPool } from "@crm/db/testing";

import { DEFAULT_GRACE_DAYS, setDisposalPolicy, sweepExpiredStock } from "./expiry-sweep.js";
import {
  disburseSamples,
  ledgerFor,
  openObligations,
  receiveSamples,
  registerLot,
  returnToWarehouse,
  transferOut,
  writeOff,
  type SampleLot,
} from "./store.js";

/**
 * The expiry sweep against a real Postgres.
 *
 * The assertion that matters most is a negative one: an expired DRUG SAMPLE is not
 * written off. The material is still in the rep's bag, and a job that removed it from
 * the balance would be fabricating a disposal — which is the single thing this design
 * exists to prevent. Everything else here is about noticing, dating and attributing.
 */
describe("the expiry sweep", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "cf100000-0000-4000-8000-000000000001";
  const OTHER_REP = "cf200000-0000-4000-8000-000000000002";
  const TERRITORY = "cf300000-0000-4000-8000-000000000003";
  const WAREHOUSE = "SW-WH-1";

  const day = (d: string): Date => new Date(`${d}T09:00:00Z`);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
        await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      }
      try {
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
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [REP, "sweep-rep"],
        [OTHER_REP, "sweep-other"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, n],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'SW-T','T')
         ON CONFLICT DO NOTHING`,
        [TERRITORY, TENANT],
      );
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary','2026-01-01') ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY, REP],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
         VALUES ($1,$2,'SW-ACC','2026-01-01') ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY],
      );
    });
  });

  afterAll(async () => {
    await reset();
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  beforeEach(reset);

  /**
   * Stock that expires WHILE the rep holds it, which is the only way expired stock can
   * legitimately be in a bag: 0020 refuses a receipt of an already-expired lot.
   */
  const heldStock = async (
    tx: PoolClient,
    opts: { expiry: string; kind?: "drug_sample" | "promo_material"; quantity?: number; rep?: string },
  ): Promise<SampleLot> => {
    const lot = await registerLot(tx, TENANT, {
      erpItemId: "SW-ITEM",
      lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: opts.kind ?? "drug_sample",
      expiryDate: opts.expiry,
    });
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: opts.rep ?? REP,
      quantity: opts.quantity ?? 10,
      // Well before the expiry: the stock goes stale in the bag.
      occurredAt: day("2026-01-15"),
      erpWarehouseId: WAREHOUSE,
    });
    return lot;
  };

  const onHand = async (tx: PoolClient, lotId: string, rep = REP): Promise<string> => {
    const { rows } = await tx.query<{ q: string }>(
      "SELECT quantity_on_hand::text AS q FROM crm.sample_holding WHERE rep_profile_id = $1 AND lot_id = $2",
      [rep, lotId],
    );
    return rows[0]?.q ?? "absent";
  };

  describe("receiving expired stock", () => {
    /**
     * The hole 0020 closed. Without this the sweep would raise obligations for material
     * that should never have been accepted — and the right answer to a warehouse sending
     * expired stock is that the rep does not take custody of it.
     */
    it("is refused", async () => {
      await inTenant(async (tx) => {
        const lot = await registerLot(tx, TENANT, {
          erpItemId: "SW-ITEM",
          lotNumber: "LOT-ALREADY-DEAD",
          materialKind: "drug_sample",
          expiryDate: "2026-01-31",
        });
        await expect(
          receiveSamples(tx, TENANT, {
            id: randomUUID(),
            lotId: lot.id,
            repProfileId: REP,
            quantity: 5,
            occurredAt: day("2026-02-01"),
            erpWarehouseId: WAREHOUSE,
          }),
        ).rejects.toThrow(/cannot be received into custody/);
      });
    });

    /**
     * A transfer is NOT refused. Material already in custody has to be somewhere, and
     * refusing the acceptance would strand it in transit with nobody accountable — expired
     * stock can legitimately move between reps on its way to destruction.
     */
    it("does not block accepting a transfer of expired stock", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 4,
          occurredAt: day("2026-04-10"),
          toRepProfileId: OTHER_REP,
        });
        const { acceptTransfer } = await import("./store.js");
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: OTHER_REP,
          occurredAt: day("2026-04-11"),
        });
        expect(await onHand(tx, lot.id, OTHER_REP)).toBe("4.000");
      });
    });
  });

  describe("raising obligations", () => {
    it("opens one per expired holding, with the dates the question needs", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        expect(result.expiredHoldings).toBe(1);
        expect(result.opened).toBe(1);
        expect(result.autoWrittenOff).toBe(0);
        expect(result.policy.grace_days).toBe(DEFAULT_GRACE_DAYS);

        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-10" });
        expect(obligation!.lot_id).toBe(lot.id);
        expect(obligation!.expired_on).toBe("2026-03-31");
        expect(obligation!.discovered_on).toBe("2026-04-10");
        expect(obligation!.due_by).toBe("2026-05-10");
        expect(obligation!.days_overdue).toBe(-30);
        expect(obligation!.status).toBe("open");
        expect(obligation!.quantity_on_hand).toBe("10.000");
      });
    });

    /**
     * THE ASSERTION THIS WHOLE DESIGN IS FOR. The sweep must not post a movement for a
     * drug sample: the carton is in the bag at 3am, and a balance that says otherwise
     * answers "where did it go?" with a fiction.
     */
    it("does not touch the balance of an expired drug sample", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(await onHand(tx, lot.id)).toBe("10.000");
        // One movement: the original receipt. Nothing was written off.
        expect((await ledgerFor(tx, { lotId: lot.id })).map((t) => t.kind)).toEqual(["receipt"]);
      });
    });

    it("is idempotent: a second night does not raise a second obligation", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-03-31" });
        const first = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        const second = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-11") });
        expect(first.opened).toBe(1);
        expect(second.opened).toBe(0);
        // And crucially the deadline did not move: a nightly reset would be the opposite
        // of chasing it.
        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-11" });
        expect(obligation!.due_by).toBe("2026-05-10");
        expect(obligation!.discovered_on).toBe("2026-04-10");
      });
    });

    it("ignores stock that has not expired yet", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-12-31" });
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.expiredHoldings).toBe(0);
        expect(result.opened).toBe(0);
      });
    });

    it("ignores a lot with no expiry at all", async () => {
      await inTenant(async (tx) => {
        const lot = await registerLot(tx, TENANT, {
          erpItemId: "SW-ITEM",
          lotNumber: "LOT-NOEXP",
          materialKind: "promo_material",
          expiryDate: null,
        });
        await receiveSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 100,
          occurredAt: day("2026-01-15"),
          erpWarehouseId: WAREHOUSE,
        });
        expect((await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") })).expiredHoldings).toBe(0);
      });
    });

    it("ignores a lot the rep has already used up", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 2 });
        await disburseSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 2,
          occurredAt: day("2026-03-01"),
          erpAccountId: "SW-ACC",
          recipientName: "Dr Ada",
          signatureSha256: "a".repeat(64),
        });
        expect((await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") })).expiredHoldings).toBe(0);
      });
    });

    it("raises one per rep when two hold the same expired lot", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 4,
          occurredAt: day("2026-02-10"),
          toRepProfileId: OTHER_REP,
        });
        const { acceptTransfer } = await import("./store.js");
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: OTHER_REP,
          occurredAt: day("2026-02-11"),
        });

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.opened).toBe(2);
        expect(await openObligations(tx, REP, { asOf: "2026-04-10" })).toHaveLength(1);
        expect(await openObligations(tx, OTHER_REP, { asOf: "2026-04-10" })).toHaveLength(1);
      });
    });
  });

  describe("deadlines", () => {
    it("marks an obligation overdue once the grace period has passed", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-03-31" });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const onTime = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-05-10") });
        expect(onTime.markedOverdue).toBe(0);

        const late = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-05-11") });
        expect(late.markedOverdue).toBe(1);

        const [obligation] = await openObligations(tx, REP, { asOf: "2026-05-11" });
        expect(obligation!.status).toBe("overdue");
        expect(obligation!.days_overdue).toBe(1);
      });
    });

    it("uses the tenant's grace period, and the one in force when it was discovered", async () => {
      await inTenant(async (tx) => {
        await setDisposalPolicy(tx, TENANT, { graceDays: 7 });
        await heldStock(tx, { expiry: "2026-03-31" });
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.policy.grace_days).toBe(7);
        expect((await openObligations(tx, REP, { asOf: "2026-04-10" }))[0]!.due_by).toBe("2026-04-17");

        // Lengthening the policy must not move a deadline already communicated.
        await setDisposalPolicy(tx, TENANT, { graceDays: 90 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-11") });
        expect((await openObligations(tx, REP, { asOf: "2026-04-11" }))[0]!.due_by).toBe("2026-04-17");
      });
    });
  });

  describe("resolution", () => {
    it("closes an obligation discharged by a destruction, naming the movement", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const destroyed = await writeOff(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: day("2026-04-15"),
          kind: "destruction",
          reason: "destroyed at depot, witnessed by QA per SOP-14",
        });

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-16") });
        expect(result.resolved).toBe(1);
        expect(await openObligations(tx, REP, { asOf: "2026-04-16" })).toHaveLength(0);

        const { rows } = await tx.query<{ status: string; resolution: string; resolving_transaction_id: string }>(
          "SELECT status, resolution, resolving_transaction_id FROM crm.disposal_obligation WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows[0]!.status).toBe("resolved");
        expect(rows[0]!.resolution).toBe("destroyed");
        // Attributed from the ledger rather than declared, so the answer is the ledger's.
        expect(rows[0]!.resolving_transaction_id).toBe(destroyed.id);
      });
    });

    it("records a return to the warehouse as returned, not destroyed", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 6 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await returnToWarehouse(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 6,
          occurredAt: day("2026-04-12"),
          erpWarehouseId: WAREHOUSE,
          reason: "expired, returned for central disposal",
        });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-13") });
        const { rows } = await tx.query<{ resolution: string }>(
          "SELECT resolution FROM crm.disposal_obligation WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows[0]!.resolution).toBe("returned");
      });
    });

    it("stays open while disposal is only partial", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        await writeOff(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 4,
          occurredAt: day("2026-04-15"),
          kind: "destruction",
          reason: "first batch destroyed",
        });
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-16") });
        expect(result.resolved).toBe(0);
        const [obligation] = await openObligations(tx, REP, { asOf: "2026-04-16" });
        // The discovery quantity is unchanged and the live balance has fallen, so progress
        // is readable from the pair.
        expect(obligation!.quantity_on_hand).toBe("6.000");
      });
    });

    /**
     * Stock that vanished with nothing to explain it stays OPEN. Closing it with a guessed
     * reason would put a fabricated disposal in the record — the exact failure the design
     * avoids — so it is counted and left for a human instead.
     */
    it("leaves an unattributable disappearance open, and counts it", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", quantity: 10 });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        // A movement dated BEFORE the obligation was discovered cannot be what discharged
        // it, so the sweep refuses to attribute to it.
        await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
        await tx.query(
          "UPDATE crm.sample_holding SET quantity_on_hand = 0 WHERE rep_profile_id = $1 AND lot_id = $2",
          [REP, lot.id],
        );
        await tx.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-16") });
        expect(result.resolved).toBe(0);
        expect(result.unattributed).toBe(1);
        expect(await openObligations(tx, REP, { asOf: "2026-04-16" })).toHaveLength(1);
      });
    });
  });

  describe("automatic write-off of promotional material", () => {
    it("is off by default, even for a leaflet", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31", kind: "promo_material", quantity: 50 });
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.autoWrittenOff).toBe(0);
        expect(result.opened).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("50.000");
      });
    });

    it("writes off promotional material once the tenant opts in, and closes the obligation", async () => {
      await inTenant(async (tx) => {
        await setDisposalPolicy(tx, TENANT, { autoWriteoffPromo: true });
        const lot = await heldStock(tx, { expiry: "2026-03-31", kind: "promo_material", quantity: 50 });

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.autoWrittenOff).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("0.000");
        expect(await openObligations(tx, REP, { asOf: "2026-04-10" })).toHaveLength(0);

        const ledger = await ledgerFor(tx, { lotId: lot.id });
        expect(ledger[0]!.kind).toBe("expiry_writeoff");
        // The reason says a machine did it and on what authority, so a reader can tell it
        // from a destruction someone witnessed.
        expect(ledger[0]!.reason).toMatch(/automatic expiry write-off \(promotional material, tenant policy\)/);

        const { rows } = await tx.query<{ resolution: string }>(
          "SELECT resolution FROM crm.disposal_obligation WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows[0]!.resolution).toBe("written_off");
      });
    });

    /** Opting in must not reach a drug sample. The flag is named for what it covers. */
    it("never writes off a drug sample, even with the flag on", async () => {
      await inTenant(async (tx) => {
        await setDisposalPolicy(tx, TENANT, { autoWriteoffPromo: true });
        const drug = await heldStock(tx, { expiry: "2026-03-31", kind: "drug_sample", quantity: 10 });
        const promo = await heldStock(tx, { expiry: "2026-03-31", kind: "promo_material", quantity: 20 });

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.autoWrittenOff).toBe(1);
        expect(await onHand(tx, drug.id)).toBe("10.000");
        expect(await onHand(tx, promo.id)).toBe("0.000");
        // The drug sample's obligation remains, for a person to discharge.
        const open = await openObligations(tx, REP, { asOf: "2026-04-10" });
        expect(open).toHaveLength(1);
        expect(open[0]!.lot_id).toBe(drug.id);
      });
    });

    it("is idempotent with the flag on", async () => {
      await inTenant(async (tx) => {
        await setDisposalPolicy(tx, TENANT, { autoWriteoffPromo: true });
        await heldStock(tx, { expiry: "2026-03-31", kind: "promo_material", quantity: 20 });
        expect((await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") })).autoWrittenOff).toBe(1);
        expect((await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-11") })).autoWrittenOff).toBe(0);
      });
    });
  });

  describe("the policy row", () => {
    it("is created on first sweep rather than needing an onboarding step", async () => {
      await inTenant(async (tx) => {
        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.policy).toEqual({ grace_days: DEFAULT_GRACE_DAYS, auto_writeoff_promo: false });
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.disposal_policy WHERE tenant_id = $1",
          [TENANT],
        );
        expect(Number(rows[0]!.n)).toBe(1);
      });
    });

    it("refuses an implausible grace period", async () => {
      await inTenant(async (tx) => {
        await expect(setDisposalPolicy(tx, TENANT, { graceDays: 400 })).rejects.toThrow(/grace_days/);
      });
    });
  });
});
