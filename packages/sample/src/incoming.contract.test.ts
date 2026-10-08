import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@crm/db";
import { TENANT_INCOMING as TENANT, appPool } from "@crm/db/testing";

import { TRANSFER_PEER_LIMIT, incomingTransfers, transferPeers } from "./incoming.js";
import { recallTransfer, recallableTransfers } from "./recall.js";
import {
  acceptTransfer,
  receiveSamples,
  registerLot,
  transferOut,
  type SampleLot,
} from "./store.js";

/**
 * The receiver's side of a transfer, against a real Postgres.
 *
 * Two properties carry this file. The first is that `incoming_transfers` and
 * `recallable_transfers` are mirror images: the same transfer must appear in exactly one
 * of them for each rep, on the side that can act on it, and in NEITHER once it is settled.
 * A list that showed a rep a transfer they cannot accept is the failure this scoping
 * exists to prevent, and it is the kind that looks fine until a button 403s.
 *
 * The second is that the peer list is as wide as the write. That is a deliberate decision
 * rather than an oversight, so it is pinned here: if someone narrows the list later they
 * have to change this test, and changing it means deciding whether the WRITE narrows too.
 */
describe("the receiving side of a transfer", () => {
  let pool: Pool;
  let client: PoolClient;

  const ADA = "f0551000-0000-4000-8000-000000000001";
  const GRACE = "f0552000-0000-4000-8000-000000000002";
  const THIRD = "f0553000-0000-4000-8000-000000000003";
  const DEPARTED = "f0554000-0000-4000-8000-000000000004";
  const DAY = (d: string): Date => new Date(`${d}T09:00:00Z`);

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
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      for (const [id, subject, number, name, status] of [
        [ADA, "in-ada", "IN-1", "Ada Lovelace", "active"],
        [GRACE, "in-grace", "IN-2", "Grace Hopper", "active"],
        [THIRD, "in-third", "IN-3", "Katherine Johnson", "active"],
        [DEPARTED, "in-gone", "IN-4", "Departed Rep", "departed"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name, status)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
          [id, TENANT, subject, number, name, status],
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
      erpItemId: "IN-ITEM-1",
      lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
      materialKind: "drug_sample",
      expiryDate: opts.expiry === undefined ? "2027-12-31" : opts.expiry,
    });

  const stock = async (tx: PoolClient, lot: SampleLot, qty: number, rep: string): Promise<void> => {
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: rep,
      quantity: qty,
      occurredAt: DAY("2026-01-15"),
      erpWarehouseId: "IN-WH-1",
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
      repProfileId: opts.from ?? ADA,
      quantity: qty,
      occurredAt: DAY(opts.on ?? "2026-09-20"),
      toRepProfileId: opts.to ?? GRACE,
    });

  describe("what is on its way to me", () => {
    it("names the sender, the lot and its expiry — everything a screen needs to accept it", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        const sent = await sendOut(tx, lot, 4);

        const incoming = await incomingTransfers(tx, GRACE);
        expect(incoming).toHaveLength(1);
        expect(incoming[0]).toMatchObject({
          transaction_id: sent.id,
          lot_id: lot.id,
          lot_number: lot.lot_number,
          erp_item_id: "IN-ITEM-1",
          expiry_date: "2027-12-31",
          quantity: "4.000",
          sent_by: ADA,
          sent_by_name: "Ada Lovelace",
        });
      });
    });

    it("is empty for the SENDER, who can recall it but cannot accept it", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        await sendOut(tx, lot, 4);

        expect(await incomingTransfers(tx, ADA)).toHaveLength(0);
        // The mirror: the same transfer, on the side that can act on it.
        expect(await recallableTransfers(tx, ADA)).toHaveLength(1);
        expect(await recallableTransfers(tx, GRACE)).toHaveLength(0);
      });
    });

    it("is empty for a rep the transfer has nothing to do with", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        await sendOut(tx, lot, 4);

        expect(await incomingTransfers(tx, THIRD)).toHaveLength(0);
        expect(await recallableTransfers(tx, THIRD)).toHaveLength(0);
      });
    });

    it("drops out of BOTH lists once it is accepted", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        const sent = await sendOut(tx, lot, 4);

        await acceptTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: GRACE,
          occurredAt: DAY("2026-09-21"),
        });

        expect(await incomingTransfers(tx, GRACE)).toHaveLength(0);
        expect(await recallableTransfers(tx, ADA)).toHaveLength(0);
      });
    });

    it("drops out of BOTH lists once it is recalled — the receiver must stop being offered it", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        const sent = await sendOut(tx, lot, 4);

        await recallTransfer(tx, TENANT, {
          id: randomUUID(),
          transferOf: sent.id,
          repProfileId: ADA,
          occurredAt: DAY("2026-09-22"),
        });

        // This is the assertion that matters most on this list. A receiver still offered a
        // recalled transfer would press accept and be refused by the database, with the
        // material already back on the sender's balance.
        expect(await incomingTransfers(tx, GRACE)).toHaveLength(0);
        expect(await recallableTransfers(tx, ADA)).toHaveLength(0);
      });
    });

    it("counts days in transit from the day custody changed, and is oldest first", async () => {
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        await sendOut(tx, lot, 1, { on: "2026-09-20" });
        await sendOut(tx, lot, 2, { on: "2026-09-18" });

        const incoming = await incomingTransfers(tx, GRACE);
        expect(incoming.map((t) => t.quantity)).toEqual(["2.000", "1.000"]);
        const [first] = incoming;
        if (first === undefined) throw new Error("expected two incoming transfers");
        const days = Math.floor((Date.now() - Date.parse("2026-09-18T00:00:00Z")) / 86_400_000);
        // Computed by Postgres against CURRENT_DATE, so this is a range rather than a
        // value: the assertion is that it counts from `occurred_at` and not from now.
        expect(Math.abs(first.days_in_transit - days)).toBeLessThanOrEqual(1);
      });
    });

    it("shows a transfer of an EXPIRED lot with its date, rather than hiding it", async () => {
      await inTenant(async (tx) => {
        // The material physically exists and somebody is holding it. Hiding the transfer
        // would strand it in transit with no screen able to settle it; showing the expiry
        // is what lets the receiver see what they are being handed.
        const lot = await aLot(tx, { expiry: "2026-02-01" });
        await stock(tx, lot, 10, ADA);
        await sendOut(tx, lot, 3, { on: "2026-01-20" });

        const incoming = await incomingTransfers(tx, GRACE);
        expect(incoming).toHaveLength(1);
        expect(incoming[0]?.expiry_date).toBe("2026-02-01");
      });
    });

    it("carries a null expiry for promo material, which has none", async () => {
      await inTenant(async (tx) => {
        // Only a `drug_sample` must have an expiry date (0017's
        // `sample_lot_drug_needs_expiry`). Promo material legitimately has none, and the
        // screen has to render that rather than assume every transfer has a date.
        const lot = await registerLot(tx, TENANT, {
          erpItemId: "IN-ITEM-PROMO",
          lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
          materialKind: "promo_material",
          expiryDate: null,
        });
        await stock(tx, lot, 5, ADA);
        await sendOut(tx, lot, 2);

        const incoming = await incomingTransfers(tx, GRACE);
        expect(incoming).toHaveLength(1);
        expect(incoming[0]?.expiry_date).toBeNull();
      });
    });
  });

  describe("who a transfer can be addressed to", () => {
    it("offers every ACTIVE colleague, and never the caller", async () => {
      await inTenant(async (tx) => {
        const peers = await transferPeers(tx, ADA);
        expect(peers.map((p) => p.rep_profile_id)).toEqual([GRACE, THIRD]);
        expect(peers.map((p) => p.display_name)).toEqual(["Grace Hopper", "Katherine Johnson"]);
      });
    });

    it("does not offer a departed rep, who is a destination nobody should be given", async () => {
      await inTenant(async (tx) => {
        const peers = await transferPeers(tx, ADA);
        expect(peers.map((p) => p.rep_profile_id)).not.toContain(DEPARTED);
      });
    });

    it("is as wide as the WRITE: the database accepts a transfer to anyone in the tenant", async () => {
      // The decision this pins. A narrower picker would restrict the screen and not the
      // system, so narrowing the list later means deciding whether the write narrows too.
      await inTenant(async (tx) => {
        const lot = await aLot(tx);
        await stock(tx, lot, 10, ADA);
        const sent = await sendOut(tx, lot, 1, { to: THIRD });
        expect(await incomingTransfers(tx, THIRD)).toHaveLength(1);
        expect((await incomingTransfers(tx, THIRD))[0]?.transaction_id).toBe(sent.id);
      });
    });

    it("matches a name or an employee number, case-insensitively", async () => {
      await inTenant(async (tx) => {
        expect((await transferPeers(tx, ADA, { query: "grace" })).map((p) => p.rep_profile_id)).toEqual([GRACE]);
        expect((await transferPeers(tx, ADA, { query: "HOPPER" })).map((p) => p.rep_profile_id)).toEqual([GRACE]);
        expect((await transferPeers(tx, ADA, { query: "IN-3" })).map((p) => p.rep_profile_id)).toEqual([THIRD]);
      });
    });

    it("treats % and _ in a query as characters to look for, not wildcards", async () => {
      await inTenant(async (tx) => {
        // Unescaped, '%' matches everything and '_' matches any single character, so a rep
        // typing either would be shown the whole tenant and believe it was a match.
        expect(await transferPeers(tx, ADA, { query: "%" })).toHaveLength(0);
        expect(await transferPeers(tx, ADA, { query: "_" })).toHaveLength(0);
        expect(await transferPeers(tx, ADA, { query: "Grac_" })).toHaveLength(0);
      });
    });

    it("treats a blank query as no query rather than as a search for nothing", async () => {
      await inTenant(async (tx) => {
        expect(await transferPeers(tx, ADA, { query: "   " })).toHaveLength(2);
        expect(await transferPeers(tx, ADA, { query: null })).toHaveLength(2);
      });
    });

    it("clamps the limit to something a screen can hold", async () => {
      await inTenant(async (tx) => {
        expect(await transferPeers(tx, ADA, { limit: 1 })).toHaveLength(1);
        // Asked for more than the cap, answered with the cap — not refused.
        expect(await transferPeers(tx, ADA, { limit: TRANSFER_PEER_LIMIT + 1_000 })).toHaveLength(2);
        expect(await transferPeers(tx, ADA, { limit: 0 })).toHaveLength(1);
      });
    });
  });
});
