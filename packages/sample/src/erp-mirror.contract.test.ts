import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_SAMPLE_MIRROR as TENANT, testPool } from "@crm/db/testing";
import { claimBatch, markDead, markDelivered, raiseDeadLetterAlarm } from "@crm/relay";

import { enqueueErpMirror, mirrorRecordId } from "./erp-mirror.js";
import { receiveSamples, registerLot, returnToWarehouse, disburseSamples, type SampleLot } from "./store.js";

/**
 * The mirror and the movement commit together, or neither does.
 *
 * This is the one-transaction guarantee the outbox exists for: a movement that
 * committed without its mirror leaves the ERP's warehouse balance permanently
 * overstated, and a mirror without its movement understates it. Only a real database
 * can show that.
 */
describe("mirroring sample movements to the ERP", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "cc100000-0000-4000-8000-000000000001";
  const TERRITORY = "cc200000-0000-4000-8000-000000000002";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  /**
   * The outbox rows for this tenant, keyed by target record id.
   *
   * NOT ordered by `created_at`, and that is a finding rather than a preference: `now()`
   * is the TRANSACTION timestamp, so two rows enqueued in one transaction carry the same
   * `created_at` to the microsecond and any order between them is arbitrary. The relay
   * copes — an ERP transition that arrives before its create is classified
   * `retry_ordering` and retried — but a test must not assume a sequence the table does
   * not provide.
   */
  const outbox = async (tx: PoolClient): Promise<Map<string, Record<string, unknown>>> => {
    const { rows } = await tx.query<Record<string, unknown> & { target_record_id: string }>(
      `SELECT entity, operation, payload, target_record_id::text AS target_record_id,
              source_table, source_id, state
         FROM crm.outbox WHERE tenant_id = $1`,
      [TENANT],
    );
    return new Map(rows.map((r) => [r.target_record_id, r]));
  };

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1,$2,'mir-rep','MIR-1','Mirror Rep') ON CONFLICT DO NOTHING`,
        [REP, TENANT],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'MIR-T','T')
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
         VALUES ($1,$2,'MIR-ACC','2026-01-01') ON CONFLICT DO NOTHING`,
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

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      try {
        // No FK to crm.outbox (0036), so a death episode outlives its queue row.
        await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
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

  const aLot = (tx: PoolClient): Promise<SampleLot> =>
    registerLot(tx, TENANT, {
      erpItemId: "MIR-ITEM",
      lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: "drug_sample",
      expiryDate: "2027-12-31",
    });

  it("enqueues one StockMovement issue for a receipt", async () => {
    await inTenant(async (tx) => {
      const lot = await aLot(tx);
      const movement = await receiveSamples(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: 40,
        occurredAt: new Date("2026-10-01T08:00:00Z"),
        erpWarehouseId: "MIR-WH",
      });
      expect(await enqueueErpMirror(tx, TENANT, movement, lot)).toMatchObject({
        applicable: true,
        enqueued: true,
        state: "pending",
        deadLettered: false,
        deadReason: null,
      });

      const rows = await outbox(tx);
      expect(rows.size).toBe(1);
      const row = rows.get(mirrorRecordId(movement.id))!;
      expect(row["entity"]).toBe("StockMovement");
      expect(row["operation"]).toBe("create");
      expect(row["state"]).toBe("pending");
      // Correlates back to the CRM row that produced it, which is what support needs
      // when the ERP rejects something three days later.
      expect(row["source_table"]).toBe("crm.sample_transaction");
      expect(row["source_id"]).toBe(movement.id);

      const payload = row["payload"] as Record<string, unknown>;
      expect(payload["movement_type"]).toBe("issue");
      // A number since the `erpDecimal` change. `quantity::text` is how the store reads a
      // `NUMERIC` out of Postgres, and sending that text verbatim put the string "40.000"
      // into a field the ERP's own schema calls a decimal.
      expect(payload["quantity"]).toBe(40);
      expect(typeof payload["quantity"]).toBe("number");
    });
  });

  it("enqueues an ERP receipt for a return to the warehouse", async () => {
    await inTenant(async (tx) => {
      const lot = await aLot(tx);
      const received = await receiveSamples(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: 10,
        occurredAt: new Date("2026-10-01T08:00:00Z"),
        erpWarehouseId: "MIR-WH",
      });
      await enqueueErpMirror(tx, TENANT, received, lot);

      const returned = await returnToWarehouse(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: 4,
        occurredAt: new Date("2026-10-20T08:00:00Z"),
        erpWarehouseId: "MIR-WH",
        reason: "surplus at cycle end",
      });
      await enqueueErpMirror(tx, TENANT, returned, lot);

      const rows = await outbox(tx);
      expect(rows.size).toBe(2);
      // Addressed by target id rather than by position: both rows share a `created_at`.
      expect((rows.get(mirrorRecordId(received.id))!["payload"] as Record<string, unknown>)["movement_type"]).toBe(
        "issue",
      );
      expect((rows.get(mirrorRecordId(returned.id))!["payload"] as Record<string, unknown>)["movement_type"]).toBe(
        "receipt",
      );
    });
  });

  /**
   * A disbursement is invisible to the ERP: the material left its stock at receipt.
   * Mirroring it would subtract the same quantity from the warehouse twice.
   */
  it("enqueues nothing for a disbursement", async () => {
    await inTenant(async (tx) => {
      const lot = await aLot(tx);
      const received = await receiveSamples(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: 10,
        occurredAt: new Date("2026-10-01T08:00:00Z"),
        erpWarehouseId: "MIR-WH",
      });
      await enqueueErpMirror(tx, TENANT, received, lot);

      const given = await disburseSamples(tx, TENANT, {
        id: randomUUID(),
        lotId: lot.id,
        repProfileId: REP,
        quantity: 2,
        occurredAt: new Date("2026-10-05T09:00:00Z"),
        erpAccountId: "MIR-ACC",
        recipientName: "Dr Mir",
        signatureSha256: "b".repeat(64),
      });
      // Nothing to mirror is not the same answer as a collapse, and the shape says so:
      // there is no outbox row to name and no state to report.
      expect(await enqueueErpMirror(tx, TENANT, given, lot)).toEqual({
        applicable: false,
        enqueued: false,
        outboxId: null,
        state: null,
        deadLettered: false,
        deadReason: null,
      });
      expect((await outbox(tx)).size).toBe(1);
    });
  });

  /**
   * A replayed offline batch must not post the warehouse movement twice. The
   * deterministic target id plus the outbox's unique constraint is what guarantees
   * that — not the ERP's idempotency header, whose store is in-memory.
   */
  it("is idempotent: a replayed movement enqueues once", async () => {
    await inTenant(async (tx) => {
      const lot = await aLot(tx);
      const id = randomUUID();
      const input = {
        id,
        lotId: lot.id,
        repProfileId: REP,
        quantity: 10,
        occurredAt: new Date("2026-10-01T08:00:00Z"),
        erpWarehouseId: "MIR-WH",
      };
      const first = await receiveSamples(tx, TENANT, input);
      const enqueued = await enqueueErpMirror(tx, TENANT, first, lot);
      expect(enqueued.enqueued).toBe(true);

      const replay = await receiveSamples(tx, TENANT, input);
      // The ordinary collapse, and it stays exactly as quiet as it was: `enqueued: false`,
      // the same row, nothing dead about it.
      expect(await enqueueErpMirror(tx, TENANT, replay, lot)).toEqual({
        applicable: true,
        enqueued: false,
        outboxId: enqueued.outboxId,
        state: "pending",
        deadLettered: false,
        deadReason: null,
      });
      expect((await outbox(tx)).size).toBe(1);
    });
  });

  /**
   * A REPLAY THAT COLLAPSES ONTO A WRITE THE ERP HAS ALREADY REFUSED.
   *
   * The movement id is device-minted and `insertMovement` collapses a redelivered offline
   * movement onto the row already there, so a replayed receipt reaches `enqueueErpMirror` a
   * second time and collapses onto the outbox row too. While that row is alive that is the
   * designed path and `enqueued: false` is the honest answer. While it is `dead` the same
   * `false` was a lie by omission: the relay has stopped retrying, the ERP's warehouse
   * balance is overstated and will stay overstated, and the rep has been answered
   * `201 Created` for a hand-over the ERP will never hear about.
   *
   * The row below is killed the way the relay kills one — `claimBatch`, then `markDead`,
   * which fires `crm.outbox_dead_letter_record()` and writes the episode, then
   * `raiseDeadLetterAlarm`, exactly as `OutboxRelay.settle` does. Nothing sets `state` by
   * hand, because a row whose column says `dead` without the trigger having run is not the
   * row production has.
   */
  describe("a replay that collapses onto a dead mirror", () => {
    /** Later than the row's `now()` default, so `claimBatch`'s due check can see it. */
    const RELAY_CLOCK = new Date("2027-01-01T09:00:00Z");
    const DEAD_REASON = "warehouse MIR-WH not found in this tenant";

    /** A received movement whose mirror the relay has genuinely dead-lettered. */
    const receivedWithDeadMirror = async (): Promise<{
      input: Parameters<typeof receiveSamples>[2];
      lot: SampleLot;
      outboxId: string;
    }> =>
      inTenant(async (tx) => {
        const lot = await aLot(tx);
        const input = {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: new Date("2026-10-01T08:00:00Z"),
          erpWarehouseId: "MIR-WH",
        };
        const movement = await receiveSamples(tx, TENANT, input);
        const { outboxId } = await enqueueErpMirror(tx, TENANT, movement, lot);

        const [row] = await claimBatch(tx, TENANT, "relay-worker-a", 10, RELAY_CLOCK);
        expect(row?.id).toBe(outboxId);
        expect(await markDead(tx, row!.id, RELAY_CLOCK, DEAD_REASON)).toBe(true);
        // The relay tells the rep in the same transaction as the death. Everything below
        // happens with the rep ALREADY notified about the write.
        expect((await raiseDeadLetterAlarm(tx, TENANT, row!, DEAD_REASON)).repProfileId).toBe(REP);
        return { input, lot, outboxId: outboxId! };
      });

    it("says dead-lettered, with the reason, instead of reporting a harmless duplicate", async () => {
      const { input, lot, outboxId } = await receivedWithDeadMirror();

      const result = await inTenant(async (tx) => {
        const replay = await receiveSamples(tx, TENANT, input);
        // The movement itself still collapses onto the row already there — the replay is
        // not a second hand-over and must not read as a failure.
        expect(replay.id).toBe(input.id);
        return enqueueErpMirror(tx, TENANT, replay, lot);
      });

      expect(result).toEqual({
        applicable: true,
        enqueued: false,
        outboxId,
        state: "dead",
        deadLettered: true,
        deadReason: DEAD_REASON,
      });
    });

    it("writes nothing and loses nothing: one movement, one dead row", async () => {
      const { input, lot } = await receivedWithDeadMirror();
      await inTenant(async (tx) => {
        const replay = await receiveSamples(tx, TENANT, input);
        await enqueueErpMirror(tx, TENANT, replay, lot);
      });

      await inTenant(async (tx) => {
        const rows = await outbox(tx);
        expect(rows.size).toBe(1);
        expect(rows.get(mirrorRecordId(input.id))!["state"]).toBe("dead");
        const { rows: movements } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.sample_transaction WHERE tenant_id = $1",
          [TENANT],
        );
        expect(Number(movements[0]!.n)).toBe(1);
      });
    });

    /**
     * THE TRUTH THIS CHANGE HAD TO PRESERVE, AND THE NOISE IT HAD TO NOT MAKE.
     *
     * `raiseDeadLetterAlarm` already told the rep — urgently, because they believe that
     * write landed — and keyed it on `revive_count` so a second death is news and a second
     * mention of the same death is not. A replay must not add a second signal about the
     * same dead row: the response carries the fact, the inbox does not repeat it.
     */
    it("raises no further notification: the rep was told when it died, not again per replay", async () => {
      const { input, lot } = await receivedWithDeadMirror();
      const before = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.notification WHERE tenant_id = $1",
          [TENANT],
        );
        return Number(rows[0]!.n);
      });
      // Two signals: the rep's, and the escalation this tenant's hierarchy produces.
      expect(before).toBeGreaterThan(0);

      for (let i = 0; i < 3; i += 1) {
        await inTenant(async (tx) => {
          const replay = await receiveSamples(tx, TENANT, input);
          expect((await enqueueErpMirror(tx, TENANT, replay, lot)).deadLettered).toBe(true);
        });
      }

      const after = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.notification WHERE tenant_id = $1",
          [TENANT],
        );
        return Number(rows[0]!.n);
      });
      expect(after).toBe(before);
    });

    /**
     * The same fixture with the row left alive. If these ever report the same thing again
     * the distinction is gone, whichever way round it went.
     */
    it("stays silent when the row it collapsed onto is delivered", async () => {
      const lotAndInput = await inTenant(async (tx) => {
        const lot = await aLot(tx);
        const input = {
          id: randomUUID(),
          lotId: lot.id,
          repProfileId: REP,
          quantity: 10,
          occurredAt: new Date("2026-10-01T08:00:00Z"),
          erpWarehouseId: "MIR-WH",
        };
        const movement = await receiveSamples(tx, TENANT, input);
        const { outboxId } = await enqueueErpMirror(tx, TENANT, movement, lot);
        const [row] = await claimBatch(tx, TENANT, "relay-worker-a", 10, RELAY_CLOCK);
        expect(await markDelivered(tx, row!.id, RELAY_CLOCK, { ok: true })).toBe(true);
        return { lot, input, outboxId };
      });

      const result = await inTenant(async (tx) => {
        const replay = await receiveSamples(tx, TENANT, lotAndInput.input);
        return enqueueErpMirror(tx, TENANT, replay, lotAndInput.lot);
      });
      expect(result).toEqual({
        applicable: true,
        enqueued: false,
        outboxId: lotAndInput.outboxId,
        state: "delivered",
        deadLettered: false,
        deadReason: null,
      });
    });
  });

  /**
   * The whole point of the outbox. If the movement rolls back, the mirror goes with
   * it — the ERP is never told about stock that did not move.
   */
  it("rolls the mirror back with the movement", async () => {
    const lotId = await inTenant(async (tx) => (await aLot(tx)).id);

    await expect(
      inTenant(async (tx) => {
        const movement = await receiveSamples(tx, TENANT, {
          id: randomUUID(),
          lotId,
          repProfileId: REP,
          quantity: 10,
          occurredAt: new Date("2026-10-01T08:00:00Z"),
          erpWarehouseId: "MIR-WH",
        });
        await enqueueErpMirror(tx, TENANT, movement, { ...(await lotRow(tx, lotId)) });
        throw new Error("something later in the handler failed");
      }),
    ).rejects.toThrow(/something later/);

    await inTenant(async (tx) => {
      expect((await outbox(tx)).size).toBe(0);
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.sample_transaction WHERE tenant_id = $1",
        [TENANT],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  const lotRow = async (tx: PoolClient, lotId: string): Promise<SampleLot> => {
    const { rows } = await tx.query<SampleLot>(
      `SELECT id, erp_item_id::text AS erp_item_id, lot_number, expiry_date::text AS expiry_date,
              material_kind, controlled, status, status_reason
         FROM crm.sample_lot WHERE id = $1`,
      [lotId],
    );
    return rows[0]!;
  };
});
