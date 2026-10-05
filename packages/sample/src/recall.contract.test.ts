import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_RECALL as TENANT, appPool } from "@crm/db/testing";

import {
  IncompleteRecordError,
  LedgerImmutableError,
  TransferAlreadySettledError,
  TransferMismatchError,
  TransferNotSenderError,
  translateSampleError,
} from "./errors.js";
import { recallOf, recallTransfer, recallableTransfers } from "./recall.js";
import {
  acceptTransfer,
  holdingsFor,
  ledgerFor,
  receiveSamples,
  registerLot,
  setLotStatus,
  transferOut,
  type SampleLot,
} from "./store.js";

/**
 * Transfer recall against a real Postgres.
 *
 * The feature is one row and two balance columns, so the assertions that matter are
 * arithmetic: `quantity_in_transit` down, `quantity_on_hand` up, by the same amount, and
 * the total across both reps unchanged at every point an observer could look. Everything
 * else here is a refusal, and each one is a question an audit asks about material that
 * came back: who took it back, how much, and had somebody already taken it.
 */
describe("sample transfer recall", () => {
  let pool: Pool;
  let client: PoolClient;

  const SENDER = "d6100000-0000-4000-8000-000000000001";
  const RECEIVER = "d6200000-0000-4000-8000-000000000002";
  const THIRD_REP = "d6300000-0000-4000-8000-000000000003";
  const DAY = (d: string): Date => new Date(`${d}T09:00:00Z`);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  /**
   * Asserts a refusal without poisoning the transaction, and returns it as the typed
   * error the package maps it to.
   *
   * Postgres aborts the whole transaction on any error, so each expected refusal needs its
   * own savepoint. The translator runs here rather than only inside the store because
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
      // The ledger is append-only and holdings are derived, so the fixture has to disable
      // those guards explicitly. Doing it in the open rather than finding a path around
      // them is the point: nothing else in the system may.
      for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
        await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      }
      try {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      } finally {
        for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
        }
      }
    });
  };

  beforeAll(async () => {
    // appPool connects as crm_app, which is what makes RLS apply — and what
    // withTenantContext demands, since it refuses a connection whose role bypasses it.
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, number, name] of [
        [SENDER, "rc-sender", "RC-1", "Sender Rep"],
        [RECEIVER, "rc-receiver", "RC-2", "Receiver Rep"],
        [THIRD_REP, "rc-third", "RC-3", "Third Rep"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, number, name],
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

  const aLot = (tx: PoolClient, opts: { expiry?: string | null } = {}): Promise<SampleLot> =>
    registerLot(tx, TENANT, {
      erpItemId: "RC-ITEM-1",
      lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: "drug_sample",
      expiryDate: opts.expiry === undefined ? "2027-12-31" : opts.expiry,
    });

  /** Receipts are dated inside the lot's shelf life: 0020 refuses a receipt of expired stock. */
  const stock = async (tx: PoolClient, lot: SampleLot, qty: number, rep = SENDER): Promise<void> => {
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: rep,
      quantity: qty,
      occurredAt: DAY("2026-01-15"),
      erpWarehouseId: "RC-WH-1",
    });
  };

  const sendOut = (
    tx: PoolClient,
    lot: SampleLot,
    qty: number,
    opts: { from?: string; to?: string; on?: string } = {},
  ): Promise<{ readonly id: string }> =>
    transferOut(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: opts.from ?? SENDER,
      quantity: qty,
      occurredAt: DAY(opts.on ?? "2026-09-20"),
      toRepProfileId: opts.to ?? RECEIVER,
    });

  const balance = async (
    tx: PoolClient,
    lotId: string,
    rep = SENDER,
  ): Promise<{ onHand: string; inTransit: string }> => {
    const holding = (await holdingsFor(tx, rep, { includeEmpty: true })).find((h) => h.lot_id === lotId);
    return {
      onHand: holding?.quantity_on_hand ?? "absent",
      inTransit: holding?.quantity_in_transit ?? "absent",
    };
  };

  /** The SQL a future code path might write. Every field is the caller's, so each can be got wrong. */
  const rawRecall = (
    tx: PoolClient,
    row: {
      lotId: string;
      repProfileId: string;
      quantity: number;
      counterparty: string | null;
      transferOf: string | null;
    },
  ): Promise<unknown> =>
    tx.query(
      `INSERT INTO crm.sample_transaction
         (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
          counterparty_rep_profile_id, transfer_of, occurred_at)
       VALUES ($1,$2,$3,$4,'transfer_recall',$5,$6,$7,$8)`,
      [
        randomUUID(),
        TENANT,
        row.lotId,
        row.repProfileId,
        row.quantity,
        row.counterparty,
        row.transferOf,
        DAY("2026-09-25"),
      ],
    );

  describe("the balance", () => {
    it("takes the material out of transit and back into the sender's bag", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);

        const inFlight = await balance(tx, lot.id);
        expect(inFlight.onHand).toBe("30.000");
        expect(inFlight.inTransit).toBe("20.000");

        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        const after = await balance(tx, lot.id);
        expect(after.onHand).toBe("50.000");
        expect(after.inTransit).toBe("0.000");
        // 30 + 20 before, 50 + 0 after: the sender's total custody never changed, which
        // is the invariant the acceptance branch preserves and this one has to as well.
      });
    });

    it("does not touch the rep it was sent to", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        // The receiver never took custody, so there is nothing of theirs to correct —
        // not a row at zero, no row at all.
        expect(await holdingsFor(tx, RECEIVER, { includeEmpty: true })).toHaveLength(0);
      });
    });

    it("recalls one transfer and leaves the other in transit", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const first = await sendOut(tx, lot, 20, { to: RECEIVER });
        await sendOut(tx, lot, 5, { to: THIRD_REP, on: "2026-09-21" });

        const both = await balance(tx, lot.id);
        expect(both.onHand).toBe("25.000");
        expect(both.inTransit).toBe("25.000");

        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: first.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        const after = await balance(tx, lot.id);
        expect(after.onHand).toBe("45.000");
        expect(after.inTransit).toBe("5.000");
      });
    });

    it("hands back material that can be sent again and accepted", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20, { to: RECEIVER });
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        // Genuinely back on hand, not merely counted there.
        const resent = await sendOut(tx, lot, 20, { to: THIRD_REP, on: "2026-09-26" });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: resent.id,
          repProfileId: THIRD_REP,
          occurredAt: DAY("2026-09-27"),
        });

        const mine = await balance(tx, lot.id);
        expect(mine.onHand).toBe("30.000");
        expect(mine.inTransit).toBe("0.000");
        expect((await balance(tx, lot.id, THIRD_REP)).onHand).toBe("20.000");
      });
    });

    it("cannot be done by writing the balance instead", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        await sendOut(tx, lot, 20);

        // The alternative this feature exists to replace: clearing the stuck column by
        // hand. The balance is a projection of the ledger and nothing writes it directly.
        const err = await refuses(tx, () =>
          tx.query(
            `UPDATE crm.sample_holding
                SET quantity_in_transit = 0, quantity_on_hand = 50
              WHERE rep_profile_id = $1 AND lot_id = $2`,
            [SENDER, lot.id],
          ),
        );
        expect(err).toBeInstanceOf(LedgerImmutableError);
        expect(err.message).toMatch(/cannot be written directly/);
      });
    });
  });

  describe("the ledger row", () => {
    it("is a new append-only row that leaves the transfer exactly as recorded", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const recall = await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
          reason: "receiver on leave, boxes never collected",
        });

        expect(recall.kind).toBe("transfer_recall");
        expect(recall.transfer_of).toBe(sent.id);
        expect(recall.rep_profile_id).toBe(SENDER);
        expect(recall.counterparty_rep_profile_id).toBe(RECEIVER);
        expect(recall.quantity).toBe("20.000");
        expect(recall.reason).toBe("receiver on leave, boxes never collected");

        const ledger = await ledgerFor(tx, { lotId: lot.id });
        expect(ledger.map((t) => t.kind)).toEqual(["transfer_recall", "transfer_out", "receipt"]);
        const original = ledger.find((t) => t.id === sent.id)!;
        expect(original.kind).toBe("transfer_out");
        expect(original.quantity).toBe("20.000");
        expect(original.transfer_of).toBeNull();
      });
    });

    it("cannot itself be edited or deleted", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const recall = await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        const edited = await refuses(tx, () =>
          tx.query("UPDATE crm.sample_transaction SET quantity = 1 WHERE id = $1", [recall.id]),
        );
        expect(edited).toBeInstanceOf(LedgerImmutableError);
        const deleted = await refuses(tx, () =>
          tx.query("DELETE FROM crm.sample_transaction WHERE id = $1", [recall.id]),
        );
        expect(deleted).toBeInstanceOf(LedgerImmutableError);
      });
    });

    it("is idempotent on the device-minted id", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const input = {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        };
        const first = await recallTransfer(tx, TENANT, input);
        const replay = await recallTransfer(tx, TENANT, input);

        expect(replay.id).toBe(first.id);
        // Once, not twice: a redelivered sync must look like success, and the balance
        // must not move again.
        const after = await balance(tx, lot.id);
        expect(after.onHand).toBe("50.000");
        expect(after.inTransit).toBe("0.000");
        expect(await ledgerFor(tx, { lotId: lot.id })).toHaveLength(3);
      });
    });

    /**
     * The regression this nearly shipped as. 0025 added the terminal-event check to the
     * BEFORE trigger, which runs before `ON CONFLICT (id) DO NOTHING` arbitrates — so a
     * redelivered ACCEPTANCE was refused as a second terminal event, breaking an
     * idempotency the acceptance path had since 0018 and the offline sync depends on.
     */
    it("leaves a redelivered acceptance idempotent", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const input = {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: RECEIVER,
          occurredAt: DAY("2026-09-22"),
        };
        const first = await acceptTransfer(tx, TENANT, input);
        const replay = await acceptTransfer(tx, TENANT, input);

        expect(replay.id).toBe(first.id);
        expect(await balance(tx, lot.id)).toEqual({ onHand: "30.000", inTransit: "0.000" });
        expect((await balance(tx, lot.id, RECEIVER)).onHand).toBe("20.000");
      });
    });

    it("is an increasing movement, so a disposal is never attributed to it", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { expiry: "2026-02-28" });
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        // crm.disposal_resolving_movement reads crm.sample_effect to find the DECREASING
        // movement that emptied a holding. A recall puts material back, so it must not be
        // offered as an explanation for material leaving.
        const { rows } = await tx.query<{ transaction_id: string; kind: string }>(
          `SELECT transaction_id, kind FROM crm.disposal_resolving_movement($1, $2, '2026-01-01')`,
          [SENDER, lot.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("transfer_out");
        expect(rows[0]!.transaction_id).toBe(sent.id);
      });
    });
  });

  describe("who may recall", () => {
    it("refuses a recall by the rep it was sent to", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);

        // A receiver who does not want the material is refusing delivery, which is a
        // different act with a different destination and is not built.
        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: RECEIVER,
            occurredAt: DAY("2026-09-25"),
          }),
        );
        expect(err).toBeInstanceOf(TransferNotSenderError);
        expect(err.message).toMatch(/only the sender can take material back/);
      });
    });

    it("refuses a recall by an unrelated rep", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: THIRD_REP,
            occurredAt: DAY("2026-09-25"),
          }),
        );
        expect(err).toBeInstanceOf(TransferNotSenderError);
      });
    });

    it("refuses a recall that names a rep the transfer was not sent to", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20, { to: RECEIVER });
        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: lot.id,
            repProfileId: SENDER,
            quantity: 20,
            counterparty: THIRD_REP,
            transferOf: sent.id,
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/must name the rep it was sent to/);
      });
    });
  });

  describe("one terminal event per transfer", () => {
    it("refuses a recall of a transfer that was accepted", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: RECEIVER,
          occurredAt: DAY("2026-09-22"),
        });

        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: SENDER,
            occurredAt: DAY("2026-09-25"),
          }),
        );
        expect(err).toBeInstanceOf(TransferAlreadySettledError);
        expect(err.message).toMatch(/already been accepted/);
        // The refusal says who accepted it and when, because that is what the sender
        // needs to know: the material is somebody else's now.
        expect(err.message).toContain(RECEIVER);
        expect(err.message).toContain("2026-09-22");
      });
    });

    it("refuses a second recall of the same transfer", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            // A different device id: the same one collapses into the row already there.
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: SENDER,
            occurredAt: DAY("2026-09-26"),
          }),
        );
        expect(err).toBeInstanceOf(TransferAlreadySettledError);
        expect(err.message).toMatch(/already been recalled/);
      });
    });

    it("refuses an acceptance of a transfer that was recalled", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });

        // The symmetry that makes the pair safe: whichever event lands first, the other
        // is refused. Otherwise the receiver could accept material already back in the
        // sender's bag and it would exist twice.
        const err = await refuses(tx, () =>
          acceptTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: sent.id,
            repProfileId: RECEIVER,
            occurredAt: DAY("2026-09-26"),
          }),
        );
        expect(err).toBeInstanceOf(TransferAlreadySettledError);
        expect(err.message).toMatch(/already been recalled/);
        expect(await balance(tx, lot.id)).toEqual({ onHand: "50.000", inTransit: "0.000" });
      });
    });
  });

  describe("what a recall must match", () => {
    it("refuses a partial recall", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);

        // The remainder would be stranded: the transfer already has its one terminal
        // event, so nothing could ever clear the rest out of transit.
        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: lot.id,
            repProfileId: SENDER,
            quantity: 5,
            counterparty: RECEIVER,
            transferOf: sent.id,
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/must take back exactly what was sent/);
      });
    });

    it("refuses a recall of more than was sent", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: lot.id,
            repProfileId: SENDER,
            quantity: 25,
            counterparty: RECEIVER,
            transferOf: sent.id,
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/must take back exactly what was sent/);
      });
    });

    it("refuses a recall naming a different lot", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        const other = await aLot(tx);
        await stock(tx, lot, 50);
        await stock(tx, other, 50);
        const sent = await sendOut(tx, lot, 20);

        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: other.id,
            repProfileId: SENDER,
            quantity: 20,
            counterparty: RECEIVER,
            transferOf: sent.id,
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/must take back exactly what was sent/);
      });
    });

    it("refuses a recall of something that is not a transfer_out", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const receipt = (await ledgerFor(tx, { lotId: lot.id }))[0]!;

        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: receipt.id,
            repProfileId: SENDER,
            occurredAt: DAY("2026-09-25"),
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/not a transfer_out/);
      });
    });

    it("refuses a recall of a transfer that does not exist", async () => {
      await inTenant(async (tx) => {
        const err = await refuses(tx, () =>
          recallTransfer(tx, TENANT, {
            id: randomUUID(),
            transferOf: randomUUID(),
            repProfileId: SENDER,
            occurredAt: DAY("2026-09-25"),
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        expect(err.message).toMatch(/does not exist/);
      });
    });

    it("refuses a recall that names no transfer", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        await sendOut(tx, lot, 20);
        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: lot.id,
            repProfileId: SENDER,
            quantity: 20,
            counterparty: RECEIVER,
            transferOf: null,
          }),
        );
        expect(err).toBeInstanceOf(TransferMismatchError);
        // Reached in the trigger before the CHECK: a null transfer_of reads as a transfer
        // that is not there, which is the more useful of the two sentences.
        expect(err.message).toMatch(/does not exist/);
      });
    });

    it("refuses a recall that names no counterparty", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        const err = await refuses(tx, () =>
          rawRecall(tx, {
            lotId: lot.id,
            repProfileId: SENDER,
            quantity: 20,
            counterparty: null,
            transferOf: sent.id,
          }),
        );
        expect(err).toBeInstanceOf(IncompleteRecordError);
        expect(err.message).toContain("sample_tx_transfer_recall_fields");
      });
    });
  });

  describe("expiry and lot status", () => {
    /**
     * The same reasoning 0020 gives for not refusing a `transfer_in`: material already in
     * custody has to be somewhere. Refusing the only way out of transit would strand it
     * there with nobody accountable, which is the bug being fixed.
     */
    it("recalls an expired lot", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx, { expiry: "2026-02-28" });
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);

        const recall = await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });
        expect(recall.kind).toBe("transfer_recall");
        expect(await balance(tx, lot.id)).toEqual({ onHand: "50.000", inTransit: "0.000" });
      });
    });

    it("recalls a withdrawn lot", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        // The likeliest reason to take a transfer back: the lot was pulled while the
        // material was in transit. Refusing here would leave it nowhere.
        await setLotStatus(tx, lot.id, "withdrawn", "manufacturer recall");

        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });
        expect(await balance(tx, lot.id)).toEqual({ onHand: "50.000", inTransit: "0.000" });
      });
    });
  });

  describe("transfers I could still recall", () => {
    it("lists the sender's open transfers with what a screen needs to show them", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);

        const open = await recallableTransfers(tx, SENDER);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          transaction_id: sent.id,
          lot_id: lot.id,
          lot_number: lot.lot_number,
          erp_item_id: "RC-ITEM-1",
          expiry_date: "2027-12-31",
          quantity: "20.000",
          sent_to: RECEIVER,
          sent_to_name: "Receiver Rep",
        });
        expect(typeof open[0]!.days_in_transit).toBe("number");
      });
    });

    it("does not offer the receiver an action the database would refuse", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        await sendOut(tx, lot, 20);

        // Narrower than outstandingTransfers on purpose: that one answers "where is my
        // material" for either side, and only the sender can recall.
        expect(await recallableTransfers(tx, RECEIVER)).toHaveLength(0);
      });
    });

    it("drops a transfer once it is recalled", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });
        expect(await recallableTransfers(tx, SENDER)).toHaveLength(0);
      });
    });

    it("drops a transfer once it is accepted", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const sent = await sendOut(tx, lot, 20);
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: RECEIVER,
          occurredAt: DAY("2026-09-22"),
        });
        expect(await recallableTransfers(tx, SENDER)).toHaveLength(0);
      });
    });

    it("puts the longest-stuck transfer first", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const older = await sendOut(tx, lot, 5, { on: "2026-08-01" });
        const newer = await sendOut(tx, lot, 5, { to: THIRD_REP, on: "2026-09-20" });

        const open = await recallableTransfers(tx, SENDER);
        expect(open.map((t) => t.transaction_id)).toEqual([older.id, newer.id]);
        // Relative, not absolute: the column counts from today, so only the ordering is
        // a fact about the data rather than about when the suite ran.
        expect(open[0]!.days_in_transit).toBeGreaterThan(open[1]!.days_in_transit);
      });
    });

    it("names the recall recorded against a transfer, and nothing for an accepted one", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 50);
        const recalled = await sendOut(tx, lot, 20, { to: RECEIVER });
        const accepted = await sendOut(tx, lot, 5, { to: THIRD_REP, on: "2026-09-21" });

        const recall = await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: recalled.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-09-25"),
        });
        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: accepted.id,
          repProfileId: THIRD_REP,
          occurredAt: DAY("2026-09-22"),
        });

        expect((await recallOf(tx, recalled.id))?.id).toBe(recall.id);
        expect(await recallOf(tx, accepted.id)).toBeNull();
      });
    });
  });

  /**
   * The correction, which is the half that makes a recall honest.
   *
   * `transferOut` tells the receiver material is on its way. After a recall that
   * notification names material sitting in somebody else's bag, and a rep who goes
   * looking for it has been sent on an errand by us — so the recall raises its
   * counterpart in the SAME transaction as the ledger row.
   */
  describe("the receiver is told", () => {
    const notifications = (tx: PoolClient) =>
      tx.query<{ kind: string; subject: string; recipient_rep_profile_id: string; dedup_key: string }>(
        `SELECT kind, subject, recipient_rep_profile_id, dedup_key
           FROM crm.notification WHERE tenant_id = $1 ORDER BY created_at, kind`,
        [TENANT],
      );

    it("raises sample_transfer_recalled to the receiver, beside the signal it corrects", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 40);
        const out = await sendOut(tx, lot, 12);
        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: out.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-02-05"),
        });

        const { rows } = await notifications(tx);
        expect(rows.map((r) => r.kind)).toEqual([
          "sample_transfer_awaiting_acceptance",
          "sample_transfer_recalled",
        ]);
        const recalled = rows[1]!;
        // To the RECEIVER: they are the one holding a false expectation.
        expect(recalled.recipient_rep_profile_id).toBe(RECEIVER);
        // "12", not "12.000" — numeric(16,3) comes back padded, and the message this one
        // corrects says 12. Two notifications about one transfer that disagree about the
        // quantity read like two different events.
        expect(recalled.subject).toContain("took back 12 of lot");
        expect(recalled.subject).not.toContain("12.000");
        // Keyed on the transfer, matching the signal it corrects.
        expect(recalled.dedup_key).toBe(`transfer:${out.id}:recalled`);
      });
    });

    it("notifies once when a recall is redelivered", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 40);
        const out = await sendOut(tx, lot, 5);
        const recall = {
          id: randomUUID(),
          transferOf: out.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-02-05"),
        };
        await recallTransfer(tx, TENANT, recall);
        await recallTransfer(tx, TENANT, recall);
        const { rows } = await notifications(tx);
        expect(rows.filter((r) => r.kind === "sample_transfer_recalled")).toHaveLength(1);
      });
    });

    /**
     * The exemption in `crm.notification_subject_open` reads ANY row with
     * `transfer_of` as settling the transfer, so a recall makes the original
     * awaiting-acceptance notification prunable. Asserted here rather than assumed:
     * retention and custody are in different packages and this is where they meet.
     */
    it("leaves the corrected notification prunable", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 40);
        const out = await sendOut(tx, lot, 7);
        const open = await tx.query<{ open: boolean }>(
          "SELECT crm.notification_subject_open('crm.sample_transaction', $1) AS open",
          [out.id],
        );
        expect(open.rows[0]!.open).toBe(true);

        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: out.id,
          repProfileId: SENDER,
          occurredAt: DAY("2026-02-05"),
        });
        const closed = await tx.query<{ open: boolean }>(
          "SELECT crm.notification_subject_open('crm.sample_transaction', $1) AS open",
          [out.id],
        );
        expect(closed.rows[0]!.open).toBe(false);
      });
    });
  });

});
