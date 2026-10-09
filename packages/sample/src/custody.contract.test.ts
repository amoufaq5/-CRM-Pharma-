import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_SAMPLE as TENANT, testPool } from "@crm/db/testing";

import {
  IncompleteRecordError,
  InsufficientHoldingError,
  LedgerImmutableError,
  LotExpiredError,
  LotNotReleasedError,
  OutsideTerritoryError,
  TransferMismatchError,
  translateSampleError,
} from "./errors.js";
import { inbox } from "@crm/notify";

import {
  acceptTransfer,
  adjust,
  cancelCount,
  commitCount,
  countLines,
  disburseSamples,
  expiringHoldings,
  getCount,
  holdingsFor,
  ledgerFor,
  openCount,
  outstandingTransfers,
  receiveSamples,
  recordCountLine,
  registerLot,
  returnToWarehouse,
  setLotStatus,
  transferOut,
  writeOff,
  type SampleLot,
} from "./store.js";

/**
 * Sample custody against a real Postgres.
 *
 * This file is the evidence for the claim in ADR-0001 Q4 — that the CRM can
 * discharge sample accountability the ERP cannot. Every assertion is a question a
 * sample audit asks, and the answer is enforced by the database rather than by the
 * store, so the offline-sync path cannot answer differently.
 */
describe("sample custody", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "cb100000-0000-4000-8000-000000000001";
  const OTHER_REP = "cb200000-0000-4000-8000-000000000002";
  const THIRD_REP = "cb300000-0000-4000-8000-000000000003";
  const TERRITORY = "cb400000-0000-4000-8000-000000000004";
  const SIG = "a".repeat(64);
  const DAY = (d: string): Date => new Date(`${d}T09:00:00Z`);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  /**
   * Asserts a refusal without poisoning the transaction, and returns it as the typed
   * error the package maps it to.
   *
   * Postgres aborts the whole transaction on any error, so each expected refusal needs
   * a savepoint. The translator runs here rather than only inside the store because
   * several tests deliberately bypass the store — writing the SQL a future code path
   * might — and the pairing worth pinning is "the database refuses this AND the package
   * names it that", against real pg errors rather than hand-made ones.
   */
  const refuses = async (tx: PoolClient, fn: () => Promise<unknown>): Promise<Error> => {
    await tx.query("SAVEPOINT expect_refusal");
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    await tx.query("ROLLBACK TO SAVEPOINT expect_refusal");
    if (caught === undefined) throw new Error("expected the database to refuse, but it accepted");
    return translateSampleError(caught);
  };

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      // The ledger is append-only and holdings are derived, so the fixture has to
      // disable those guards explicitly. Doing it in the open rather than finding a
      // path around them is the point: nothing else in the system may.
      for (const t of ["crm.sample_transaction", "crm.sample_holding", "crm.visit"]) {
        await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      }
      try {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        // ORDER MATTERS, children before parents: an adjustment written by a count
        // references it (0056, ON DELETE RESTRICT), so the ledger goes first. The
        // production erasure derives this order from the live FK graph; a fixture has to
        // be told, and this one was the first thing the new key caught.
        await tx.query("DELETE FROM crm.sample_count_line WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_count WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [TENANT]);
      } finally {
        for (const t of ["crm.sample_transaction", "crm.sample_holding", "crm.visit"]) {
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
      for (const [id, subject, number] of [
        [REP, "sm-rep", "SM-1"],
        [OTHER_REP, "sm-other", "SM-2"],
        [THIRD_REP, "sm-third", "SM-3"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$4,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, number],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'SM-TERR','Territory')
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
         VALUES ($1,$2,'SM-ACC-1','2026-01-01') ON CONFLICT DO NOTHING`,
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

  const aLot = (
    tx: PoolClient,
    opts: { expiry?: string | null; kind?: "drug_sample" | "promo_material"; number?: string } = {},
  ): Promise<SampleLot> =>
    registerLot(tx, TENANT, {
      erpItemId: "SM-ITEM-1",
      lotNumber: opts.number ?? `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: opts.kind ?? "drug_sample",
      expiryDate: opts.expiry === undefined ? "2027-12-31" : opts.expiry,
    });

  /**
   * Puts stock in a rep's bag.
   *
   * `receivedOn` defaults to a date comfortably inside every fixture lot's shelf life,
   * because 0020 refuses a receipt of ALREADY-expired stock — which is also how it works
   * in reality: material goes stale in the bag, it does not arrive stale.
   */
  const stock = async (
    tx: PoolClient,
    lot: SampleLot,
    qty: number,
    rep = REP,
    receivedOn = "2026-01-15",
  ): Promise<void> => {
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: rep,
      quantity: qty,
      occurredAt: DAY(receivedOn),
      erpWarehouseId: "SM-WH-1",
    });
  };

  const onHand = async (tx: PoolClient, lotId: string, rep = REP): Promise<string> => {
    const holdings = await holdingsFor(tx, rep, { includeEmpty: true });
    return holdings.find((h) => h.lot_id === lotId)?.quantity_on_hand ?? "absent";
  };

  describe("lots", () => {
    it("registers a drug sample lot with an expiry", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { number: "LOT-A" });
        expect(lot.lot_number).toBe("LOT-A");
        expect(lot.expiry_date).toBe("2027-12-31");
        expect(lot.status).toBe("active");
      });
    });

    /**
     * The one thing lot tracking exists for. A drug sample with no expiry cannot
     * answer "was it in date when it was handed over", and in an audit "we cannot
     * say" is the same answer as "no".
     */
    it("refuses a drug sample lot with no expiry", async () => {
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          registerLot(tx, TENANT, {
            erpItemId: "SM-ITEM-1",
            lotNumber: "LOT-NOEXP",
            materialKind: "drug_sample",
            expiryDate: null,
          }),
        );
        expect(err).toBeInstanceOf(IncompleteRecordError);
        expect(err.message).toMatch(/must have an expiry date/);
      });
    });

    it("allows promotional material with no expiry, because a pen does not have one", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { kind: "promo_material", expiry: null, number: "LOT-PEN" });
        expect(lot.expiry_date).toBeNull();
      });
    });

    it("refuses the same lot number twice for one item", async () => {
      await inTenant(async (tx) => {
        await aLot(tx, { number: "LOT-DUP" });
        expect(await refuses(tx, () => aLot(tx, { number: "LOT-DUP" }))).toBeTruthy();
      });
    });
  });

  describe("the balance", () => {
    /**
     * The headline difference from the ERP. There, `StockMovement` and `StockLevel`
     * both exist and nothing connects them — grepping the workspace for
     * `quantity_on_hand` outside the pack declaration returns zero hits. Here the
     * balance is derived in the same transaction as the movement.
     */
    it("is created and maintained by the movement, never by the caller", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        expect(await onHand(tx, lot.id)).toBe("absent");
        await stock(tx, lot, 100);
        expect(await onHand(tx, lot.id)).toBe("100.000");
        await disburseSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 4,
          occurredAt: DAY("2026-10-05"),
          erpAccountId: "SM-ACC-1",
          recipientName: "Dr Ada",
          signatureSha256: SIG,
        });
        expect(await onHand(tx, lot.id)).toBe("96.000");
      });
    });

    it("refuses a movement that would drive it negative, naming what is held", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const err = await refuses(tx, () =>
          disburseSamples(tx, TENANT, {
            id: randomUUID(),
            lotId: lot.id,
            repProfileId: REP,
            quantity: 6,
            occurredAt: DAY("2026-10-05"),
            erpAccountId: "SM-ACC-1",
            recipientName: "Dr Ada",
            signatureSha256: SIG,
          }),
        );
        expect(err).toBeInstanceOf(InsufficientHoldingError);
        expect(err.message).toMatch(/holds 5\.000/);
      });
    });

    it("cannot be written directly — it is a projection, not a number someone keeps", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        const err = await refuses(tx, () =>
          tx.query("UPDATE crm.sample_holding SET quantity_on_hand = 9999 WHERE lot_id = $1", [lot.id]),
        );
        expect(err).toBeInstanceOf(LedgerImmutableError);
        expect(await onHand(tx, lot.id)).toBe("10.000");
      });
    });

    it("keeps decimal quantities exactly, as strings", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await receiveSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: "12.345",
          occurredAt: DAY("2026-10-01"),
          erpWarehouseId: "SM-WH-1",
        });
        expect(await onHand(tx, lot.id)).toBe("12.345");
      });
    });
  });

  describe("disbursement", () => {
    const disburse = (
      tx: PoolClient,
      lot: SampleLot,
      overrides: Partial<{
        quantity: number;
        occurredAt: Date;
        erpAccountId: string;
        recipientName: string;
        signatureSha256: string;
        visitId: string | null;
      }> = {},
    ): Promise<unknown> =>
      disburseSamples(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: overrides.quantity ?? 1,
        occurredAt: overrides.occurredAt ?? DAY("2026-10-05"),
        erpAccountId: overrides.erpAccountId ?? "SM-ACC-1",
        recipientName: overrides.recipientName ?? "Dr Ada",
        signatureSha256: overrides.signatureSha256 ?? SIG,
        ...(overrides.visitId !== undefined ? { visitId: overrides.visitId } : {}),
      });

    /** Handing a drug sample to a prescriber without an acknowledgement is not recordable. */
    it("requires a recipient name and a signature hash", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        const err = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_account_id, occurred_at)
             VALUES ($1,$2,$3,$4,'disbursement',1,'SM-ACC-1',$5)`,
            [randomUUID(), TENANT, lot.id, REP, DAY("2026-10-05")],
          ),
        );
        expect(err).toBeInstanceOf(IncompleteRecordError);
        expect(err.message).toMatch(/without an acknowledgement/);
      });
    });

    it("refuses a signature that is not a sha256", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        expect(await refuses(tx, () => disburse(tx, lot, { signatureSha256: "not-a-hash" }))).toBeTruthy();
      });
    });

    /**
     * Compared against `occurred_at`, not now. A sync three days later must not
     * retroactively invalidate a hand-over that was legitimate when it happened —
     * nor legitimise one that was not.
     */
    it("refuses an expired lot, judged on the day of the hand-over", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { expiry: "2026-10-10", number: "LOT-EXP" });
        await stock(tx, lot, 10);
        // Inside its shelf life: fine.
        await disburse(tx, lot, { occurredAt: DAY("2026-10-09") });
        // One day past: refused, even though both are recorded in the same breath.
        const err = await refuses(tx, () => disburse(tx, lot, { occurredAt: DAY("2026-10-11") }));
        expect(err).toBeInstanceOf(LotExpiredError);
        expect(err.message).toMatch(/expired on 2026-10-10/);
      });
    });

    /** The recall path: one row, and every rep holding the lot is stopped at once. */
    it("refuses a quarantined lot", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        await setLotStatus(tx, lot.id, "quarantined", "supplier recall 2026-10");
        const err = await refuses(tx, () => disburse(tx, lot));
        expect(err).toBeInstanceOf(LotNotReleasedError);
        // The stock stays on the balance: material under recall still has to be
        // accounted for, and a quantity that vanished is one nobody has to return.
        expect(await onHand(tx, lot.id)).toBe("10.000");
      });
    });

    /** The same dated territory rule as a visit, so the two cannot disagree. */
    it("refuses an account the rep did not cover on the day", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        expect(await refuses(tx, () => disburse(tx, lot, { erpAccountId: "SM-NOT-MINE" }))).toBeInstanceOf(
          OutsideTerritoryError,
        );
      });
    });

    /**
     * A sample attributed to the wrong call report is worse than one attributed to
     * none: an inspector reconciles the two against each other.
     */
    it("refuses attaching the disbursement to a visit for a different account", async () => {
      await inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
           VALUES ($1,$2,'SM-ACC-2','2026-01-01') ON CONFLICT DO NOTHING`,
          [TENANT, TERRITORY],
        );
        const lot = await aLot(tx);
        await stock(tx, lot, 10);

        const visitId = randomUUID();
        await tx.query(
          `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
           VALUES ($1,$2,$3,'SM-ACC-1','completed',$4)`,
          [visitId, TENANT, REP, DAY("2026-10-05")],
        );

        // Both accounts are this rep's, so territory is not what refuses this — the
        // visit simply belongs to the other one.
        const err = await refuses(tx, () => disburse(tx, lot, { visitId, erpAccountId: "SM-ACC-2" }));
        expect(err.message).toMatch(/is not this rep's visit to account SM-ACC-2/);

        // The matching pair is accepted.
        await disburse(tx, lot, { visitId, erpAccountId: "SM-ACC-1" });
      });
    });

    /**
     * Offline idempotency. The id comes from the device, so a retried sync collapses
     * into the row already there rather than handing the doctor's samples out twice in
     * the record. Same guarantee the outbox relies on.
     */
    it("is idempotent on the device-minted id", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        const id = randomUUID();
        const input = {
          id,
          lotId: lot.id,
          repProfileId: REP,
          quantity: 3,
          occurredAt: DAY("2026-10-05"),
          erpAccountId: "SM-ACC-1",
          recipientName: "Dr Ada",
          signatureSha256: SIG,
        };
        const first = await disburseSamples(tx, TENANT, input);
        const replay = await disburseSamples(tx, TENANT, input);
        expect(replay.id).toBe(first.id);
        // Once, not twice.
        expect(await onHand(tx, lot.id)).toBe("7.000");
        expect(await ledgerFor(tx, { lotId: lot.id })).toHaveLength(2); // receipt + one disbursement
      });
    });
  });

  describe("transfers", () => {
    it("moves material through in-transit so it is never unaccounted for", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);

        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });

        const mine = (await holdingsFor(tx, REP, { includeEmpty: true })).find((h) => h.lot_id === lot.id)!;
        expect(mine.quantity_on_hand).toBe("30.000");
        expect(mine.quantity_in_transit).toBe("20.000");
        // 30 + 20 = 50: the total is conserved at every point an observer could look.

        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: OTHER_REP,
          occurredAt: DAY("2026-10-07"),
        });

        const after = (await holdingsFor(tx, REP, { includeEmpty: true })).find((h) => h.lot_id === lot.id)!;
        expect(after.quantity_on_hand).toBe("30.000");
        expect(after.quantity_in_transit).toBe("0.000");
        expect(await onHand(tx, lot.id, OTHER_REP)).toBe("20.000");
      });
    });

    /**
     * The receiving rep has no other reason to expect it: an unaccepted transfer was
     * previously visible only to whoever thought to look, and unaccepted material sits in
     * transit indefinitely.
     */
    it("tells the receiving rep that material is waiting for them", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });

        const items = await inbox(tx, OTHER_REP);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("sample_transfer_awaiting_acceptance");
        expect(items[0]!.subject).toContain(lot.lot_number);
        expect(items[0]!.body).toMatch(/in-transit until you accept/);
        // Not the sender, who just did it.
        expect(await inbox(tx, REP)).toHaveLength(0);
      });
    });

    it("refuses acceptance by a rep it was not sent to", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });
        const err = await refuses(tx, () =>
          acceptTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: THIRD_REP,
            occurredAt: DAY("2026-10-07"),
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/cannot accept it/);
      });
    });

    it("refuses a second acceptance of the same transfer", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: OTHER_REP,
          occurredAt: DAY("2026-10-07"),
        });
        const err = await refuses(tx, () =>
          acceptTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: OTHER_REP,
            occurredAt: DAY("2026-10-08"),
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/already been accepted/);
      });
    });

    it("refuses a quantity that does not match what was sent", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });
        const err = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.sample_transaction
               (id, tenant_id, lot_id, rep_profile_id, kind, quantity, counterparty_rep_profile_id, transfer_of, occurred_at)
             VALUES ($1,$2,$3,$4,'transfer_in',5,$5,$6,$7)`,
            [randomUUID(), TENANT, lot.id, OTHER_REP, REP, sent.id, DAY("2026-10-07")],
          ),
        );
        expect(err.message).toMatch(/must match the transfer exactly/);
      });
    });

    it("lists transfers nobody has accepted — the 'where is my material' query", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await transferOut(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 20,
          occurredAt: DAY("2026-10-06"),
          toRepProfileId: OTHER_REP,
        });
        expect((await outstandingTransfers(tx, REP)).map((t) => t.id)).toEqual([sent.id]);
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: OTHER_REP,
          occurredAt: DAY("2026-10-07"),
        });
        expect(await outstandingTransfers(tx, REP)).toHaveLength(0);
      });
    });
  });

  describe("write-offs and corrections", () => {
    it("requires a reason for a destruction or an expiry write-off", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        const err = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, occurred_at)
             VALUES ($1,$2,$3,$4,'destruction',1,$5)`,
            [randomUUID(), TENANT, lot.id, REP, DAY("2026-10-05")],
          ),
        );
        expect(err).toBeInstanceOf(IncompleteRecordError);
        expect(err.message).toMatch(/must carry a reason/);
      });
    });

    it("writes off expired stock, which still has to leave the balance deliberately", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { expiry: "2026-09-30" });
        await stock(tx, lot, 10);
        await writeOff(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: DAY("2026-10-02"),
          kind: "expiry_writeoff",
          reason: "expired 2026-09-30, destroyed per SOP-14",
        });
        expect(await onHand(tx, lot.id)).toBe("0.000");
      });
    });

    /** The ledger is append-only, so this is the only way to fix a mistake. */
    it("corrects by adjustment, leaving both the error and the correction in the log", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        await adjust(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 2,
          occurredAt: DAY("2026-10-03"),
          direction: "out",
          reason: "received 8, not 10 — miscount on hand-over",
        });
        expect(await onHand(tx, lot.id)).toBe("8.000");
        expect((await ledgerFor(tx, { lotId: lot.id })).map((t) => t.kind)).toEqual(["adjustment_out", "receipt"]);
      });
    });

    it("refuses an edit or a deletion of the ledger", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10);
        const [entry] = await ledgerFor(tx, { lotId: lot.id });
        expect(
          await refuses(tx, () => tx.query("UPDATE crm.sample_transaction SET quantity = 1 WHERE id = $1", [entry!.id])),
        ).toBeInstanceOf(LedgerImmutableError);
        expect(
          await refuses(tx, () => tx.query("DELETE FROM crm.sample_transaction WHERE id = $1", [entry!.id])),
        ).toBeInstanceOf(LedgerImmutableError);
      });
    });
  });

  describe("expiry surveillance", () => {
    it("reports what a rep is holding that is about to expire", async () => {
      await inTenant(async (tx) => {
        const soon = await aLot(tx, { expiry: "2026-11-15", number: "LOT-SOON" });
        const later = await aLot(tx, { expiry: "2027-11-15", number: "LOT-LATER" });
        await stock(tx, soon, 5);
        await stock(tx, later, 5);

        const rows = await expiringHoldings(tx, { repProfileId: REP, withinDays: 60, asOf: "2026-10-01" });
        expect(rows.map((r) => r.lot_number)).toEqual(["LOT-SOON"]);
        expect(rows[0]!.days_remaining).toBe(45);
        expect(rows[0]!.quantity_on_hand).toBe("5.000");
      });
    });

    it("does not report a lot the rep has already used up", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { expiry: "2026-11-15" });
        await stock(tx, lot, 2);
        await disburseSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 2,
          occurredAt: DAY("2026-10-05"),
          erpAccountId: "SM-ACC-1",
          recipientName: "Dr Ada",
          signatureSha256: SIG,
        });
        expect(await expiringHoldings(tx, { repProfileId: REP, asOf: "2026-10-01" })).toHaveLength(0);
      });
    });
  });

  describe("the count document", () => {
    /**
     * The ERP has `StockLevel.last_counted_at` and nothing behind it. A reconciliation
     * nobody can review is not a reconciliation, so a count is a document whose
     * commit writes adjustments through the ledger — leaving the balance still equal
     * to the sum of its movements.
     */
    it("turns a variance into an adjustment rather than an edit", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 20);

        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
          note: "quarterly boot-stock count",
        });
        const line = await recordCountLine(tx, TENANT, {
          countId: count.id,
          lotId: lot.id,
          countedQuantity: 17,
        });
        expect(line.expected_quantity).toBe("20.000");

        expect(await commitCount(tx, count.id)).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("17.000");
        expect((await getCount(tx, count.id))?.status).toBe("committed");

        const ledger = await ledgerFor(tx, { lotId: lot.id });
        expect(ledger.map((t) => t.kind)).toEqual(["adjustment_out", "receipt"]);
        expect(ledger[0]!.reason).toMatch(/cycle count .*counted 17/);
      });
    });

    it("writes nothing when the count agrees", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 20);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 20 });
        expect(await commitCount(tx, count.id)).toBe(0);
        expect(await onHand(tx, lot.id)).toBe("20.000");
      });
    });

    it("counts a lot up as well as down", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 9 });
        await commitCount(tx, count.id);
        expect(await onHand(tx, lot.id)).toBe("9.000");
        expect((await ledgerFor(tx, { lotId: lot.id }))[0]!.kind).toBe("adjustment_in");
      });
    });

    it("permits one open count per rep, so two counters cannot disagree in parallel", async () => {
      await inTenant(async (tx) => {
        await openCount(tx, TENANT, { repProfileId: REP, countedBy: OTHER_REP, countedAt: DAY("2026-10-20") });
        expect(
          await refuses(tx, () =>
            openCount(tx, TENANT, { repProfileId: REP, countedBy: THIRD_REP, countedAt: DAY("2026-10-21") }),
          ),
        ).toBeTruthy();
      });
    });

    /**
     * CHANGED BY 0056, deliberately. This used to assert that a second commit is refused,
     * which was right for an interactive caller and wrong for a queue: an offline client
     * cannot tell a lost reply from a refusal, so it retries — and a 409 told the rep their
     * count was refused while the ledger held the adjustments it had already written. The
     * screen and the database disagreeing, with the rep believing the screen.
     */
    it("commits twice with the same answer, because a lost reply is not a refusal", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 4 });
        expect(await commitCount(tx, count.id)).toBe(1);

        // The replay: the same number, and nothing written the second time.
        expect(await commitCount(tx, count.id)).toBe(1);
        expect(await commitCount(tx, count.id)).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("4.000");
        const ledger = await ledgerFor(tx, { lotId: lot.id });
        expect(ledger.filter((t) => t.kind === "adjustment_out")).toHaveLength(1);
      });
    });

    it("answers a repeated commit of a count that found NOTHING with zero, not with a refusal", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 5 });
        expect(await commitCount(tx, count.id)).toBe(0);
        // Zero adjustments is a real answer, and it has to survive the replay as itself
        // rather than becoming a conflict.
        expect(await commitCount(tx, count.id)).toBe(0);
      });
    });

    it("still refuses to commit a CANCELLED count, which is a repeat of nothing", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 4 });
        await cancelCount(tx, count.id);
        expect((await refuses(tx, () => commitCount(tx, count.id))).message).toMatch(/is cancelled, not open/);
        expect(await onHand(tx, lot.id)).toBe("5.000");
      });
    });

    it("cancels twice without complaining, because that is a rep's only way out", async () => {
      await inTenant(async (tx) => {
        // The dead end this closes: a count whose LINE was refused permanently stays open,
        // `uq_sample_count_one_open` then refuses every later count for that rep, and a
        // cancel that answered 409 on the retry would leave them with no action that works.
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-20"),
        });
        await cancelCount(tx, count.id);
        await cancelCount(tx, count.id);
        expect((await getCount(tx, count.id))?.status).toBe("cancelled");

        // And the rep is free to count again, which is the point.
        const next = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-21"),
        });
        expect(next.status).toBe("open");
      });
    });

    it("refuses to cancel a COMMITTED count, which would withdraw findings already in the ledger", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 5);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 4 });
        await commitCount(tx, count.id);
        expect((await refuses(tx, () => cancelCount(tx, count.id))).message).toMatch(/is committed, not open/);
      });
    });

    it("links each adjustment to the count that produced it, structurally", async () => {
      await inTenant(async (tx) => {
        // The link was prose — `cycle count <uuid>: counted 17, held 20` — and parsing it
        // back is what works until somebody rewords the message. 0056 gives it a column,
        // which is also what makes the repeated commit answerable with the same number.
        const lot = await aLot(tx);
        await stock(tx, lot, 20);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 17 });
        await commitCount(tx, count.id);

        const { rows } = await tx.query<{ kind: string; count_id: string | null }>(
          `SELECT kind, count_id FROM crm.sample_transaction
            WHERE tenant_id = $1 AND count_id = $2`,
          [TENANT, count.id],
        );
        expect(rows).toEqual([{ kind: "adjustment_out", count_id: count.id }]);

        // And nothing else carries one: a disbursement that claimed to come from a count
        // would be a movement the count never found.
        const refused = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_account_id, recipient_name, signature_sha256, occurred_at, count_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'disbursement', 1, 'SM-ACC-1', 'Dr Ada', $4, now(), $5)`,
            [TENANT, lot.id, REP, SIG, count.id],
          ),
        );
        expect(refused.message).toMatch(/sample_tx_count_only_adjustments|count_only_adjustments/);
      });
    });

    it("opens a count under an id the DEVICE minted, and a replayed open collapses onto it", async () => {
      await inTenant(async (tx) => {
        // The reason the whole of 0056 exists: the line route needs this id in its path, so
        // a rep with no signal has to be able to mint it before there is anywhere to send
        // it. And a queue that retries has to be able to send the same open twice.
        const id = randomUUID();
        const first = await openCount(tx, TENANT, {
          id,
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-20"),
          note: "counted in the car park",
        });
        expect(first.id).toBe(id);

        const again = await openCount(tx, TENANT, {
          id,
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-20"),
        });
        expect(again).toEqual(first);
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM crm.sample_count WHERE tenant_id = $1 AND rep_profile_id = $2`,
          [TENANT, REP],
        );
        expect(rows[0]?.n).toBe("1");
        // The note from the first open stands: the second is the same request arriving
        // twice, not an edit.
        expect(again.note).toBe("counted in the car park");
      });
    });

    it("still refuses a SECOND open count for one rep, however the id was minted", async () => {
      await inTenant(async (tx) => {
        await openCount(tx, TENANT, { id: randomUUID(), repProfileId: REP, countedBy: REP, countedAt: DAY("2026-10-20") });
        // A different id is a different document, and `uq_sample_count_one_open` refuses
        // it — the idempotency above is keyed on the id and must not widen into "any open
        // count will do".
        expect(
          await refuses(tx, () =>
            openCount(tx, TENANT, { id: randomUUID(), repProfileId: REP, countedBy: REP, countedAt: DAY("2026-10-21") }),
          ),
        ).toBeTruthy();
      });
    });

    it("records what the DEVICE showed the counter beside what the server held", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 20);
        const count = await openCount(tx, TENANT, {
          id: randomUUID(),
          repProfileId: REP,
          countedBy: REP,
          countedAt: DAY("2026-10-20"),
        });
        // The count was taken when the device thought there were 18 — a cached balance from
        // before something moved. It arrives when the server holds 20.
        const line = await recordCountLine(tx, TENANT, {
          countId: count.id,
          lotId: lot.id,
          countedQuantity: 17,
          deviceExpectedQuantity: 18,
        });
        expect(line.expected_quantity).toBe("20.000");
        expect(line.device_expected_quantity).toBe("18.000");

        const lines = await countLines(tx, count.id);
        expect(lines[0]).toMatchObject({
          counted_quantity: "17.000",
          expected_quantity: "20.000",
          variance: "-3.000",
          device_expected_quantity: "18.000",
          device_variance: "-1.000",
        });

        // The ledger reconciles against what is HELD, not against either snapshot, so the
        // balance afterwards is what was counted.
        expect(await commitCount(tx, count.id)).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("17.000");
      });
    });

    it("leaves both device columns null for a count taken at a desk", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 6);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 6 });
        const lines = await countLines(tx, count.id);
        expect(lines[0]?.device_expected_quantity).toBeNull();
        expect(lines[0]?.device_variance).toBeNull();
      });
    });

    it("snapshots the expected quantity when the line is written, not at commit", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 20);
        const count = await openCount(tx, TENANT, {
          repProfileId: REP,
          countedBy: OTHER_REP,
          countedAt: DAY("2026-10-20"),
        });
        const line = await recordCountLine(tx, TENANT, { countId: count.id, lotId: lot.id, countedQuantity: 20 });
        expect(line.expected_quantity).toBe("20.000");

        // Something moves after the shelf was looked at. The variance the reviewer saw
        // was zero; the adjustment is computed against the balance now, so the movement
        // is visible rather than silently absorbed.
        await disburseSamples(tx, TENANT, {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 3,
          occurredAt: DAY("2026-10-21"),
          erpAccountId: "SM-ACC-1",
          recipientName: "Dr Ada",
          signatureSha256: SIG,
        });
        expect(await commitCount(tx, count.id)).toBe(1);
        expect(await onHand(tx, lot.id)).toBe("20.000");
      });
    });

    it("returns to zero holdings cleanly for a rep who has nothing", async () => {
      await inTenant(async (tx) => {
        expect(await holdingsFor(tx, THIRD_REP)).toHaveLength(0);
      });
    });
  });
});
