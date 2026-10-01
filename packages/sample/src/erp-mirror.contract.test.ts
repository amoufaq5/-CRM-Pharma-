import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_SAMPLE_MIRROR as TENANT, testPool } from "@crm/db/testing";

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
      expect(await enqueueErpMirror(tx, TENANT, movement, lot)).toBe(true);

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
      expect(payload["quantity"]).toBe("40.000");
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
      expect(await enqueueErpMirror(tx, TENANT, given, lot)).toBe(false);
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
      expect(await enqueueErpMirror(tx, TENANT, first, lot)).toBe(true);

      const replay = await receiveSamples(tx, TENANT, input);
      expect(await enqueueErpMirror(tx, TENANT, replay, lot)).toBe(false);
      expect((await outbox(tx)).size).toBe(1);
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
