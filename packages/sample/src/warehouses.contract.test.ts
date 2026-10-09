import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@crm/db";
import { TENANT_WAREHOUSE as TENANT, TENANT_WAREHOUSE_UNSYNCED as UNSYNCED, appPool } from "@crm/db/testing";

import {
  ACTIVE_WAREHOUSE_STATUS,
  WAREHOUSE_LIMIT,
  listWarehouses,
  requireActiveWarehouse,
} from "./warehouses.js";

/**
 * The warehouse list, against a real Postgres.
 *
 * Two things carry this file, and neither can be checked against a fake connection.
 *
 * The first is that the list and the write enforce the SAME rule. A picker that offered a
 * depot the write refuses is a button that 409s, and a write that accepted a depot the
 * picker never showed is an id nobody chose — so `listWarehouses` and
 * `requireActiveWarehouse` are tested against one another on every status, not separately.
 *
 * The second is the three-way refusal. "No list at all" is an integration state (503),
 * "not in the list" is the caller's mistake (422) and "closed" is the depot's state (409),
 * and telling them apart needs one tenant whose snapshot is populated and one whose is
 * empty — the exact distinction a single-tenant fixture would hide, because an empty list
 * looks like a missing row.
 */
describe("the warehouse list", () => {
  let pool: Pool;
  let client: PoolClient;

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const DEPOTS = [
    ["wh-north", "DEPOT-N", "Northern Distribution", "distribution", "Dubai", "AE", "active"],
    ["wh-south", "DEPOT-S", "Southern Distribution", "distribution", "Abu Dhabi", "AE", "active"],
    ["wh-closed", "DEPOT-X", "Old Transit Shed", "transit", "Sharjah", "AE", "closed"],
    ["wh-idle", "DEPOT-I", "Seasonal Store", "retail", "Ajman", "AE", "inactive"],
    // A status the ERP has never published. The snapshot mirrors it verbatim and the
    // writer's rule reads it as "not active" rather than crashing or, worse, admitting it.
    ["wh-odd", "DEPOT-Q", "Mothballed Depot", "virtual", null, "AE", "mothballed"],
    // The one with no status at all: a row whose ERP record omitted it. It must not be
    // offered, and the refusal has to be sayable without a status to name.
    ["wh-null", "DEPOT-0", "Unstated Depot", null, null, null, null],
  ] as const;

  const seed = async (tx: PoolClient, tenant: string): Promise<void> => {
    for (const [id, code, name, type, city, country, status] of DEPOTS) {
      await tx.query(
        `INSERT INTO crm.warehouse_snapshot
           (tenant_id, erp_warehouse_id, code, name, warehouse_type, city, country, status, erp_updated_at, sync_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, '2026-09-01T00:00:00Z', gen_random_uuid())
         ON CONFLICT (tenant_id, erp_warehouse_id) DO UPDATE
           SET code = EXCLUDED.code, name = EXCLUDED.name, warehouse_type = EXCLUDED.warehouse_type,
               city = EXCLUDED.city, country = EXCLUDED.country, status = EXCLUDED.status`,
        [tenant, id, code, name, type, city, country, status],
      );
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  beforeEach(async () => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.warehouse_snapshot WHERE tenant_id = $1", [TENANT]);
      await seed(tx, TENANT);
    });
    // The unsynced tenant is emptied rather than merely left alone: a previous file in the
    // same database must not be able to make this one's 503 disappear.
    await withTenantContext(client, UNSYNCED, (tx) =>
      tx.query("DELETE FROM crm.warehouse_snapshot WHERE tenant_id = $1", [UNSYNCED]),
    );
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it("offers the active depots, by code, and nothing else", async () => {
    const rows = await inTenant((tx) => listWarehouses(tx));
    expect(rows.map((w) => w.code)).toEqual(["DEPOT-N", "DEPOT-S"]);
    expect(rows.every((w) => w.status === ACTIVE_WAREHOUSE_STATUS)).toBe(true);
  });

  it("carries what a picker shows a rep", async () => {
    const [north] = await inTenant((tx) => listWarehouses(tx, { query: "DEPOT-N" }));
    expect(north).toMatchObject({
      erp_warehouse_id: "wh-north",
      code: "DEPOT-N",
      name: "Northern Distribution",
      warehouse_type: "distribution",
      city: "Dubai",
      // char(2) comes back without its padding, so the device can print it.
      country: "AE",
    });
  });

  it("matches the code or the long name, because a rep knows whichever is on the paperwork", async () => {
    const byCode = await inTenant((tx) => listWarehouses(tx, { query: "depot-s" }));
    expect(byCode.map((w) => w.code)).toEqual(["DEPOT-S"]);
    const byName = await inTenant((tx) => listWarehouses(tx, { query: "northern" }));
    expect(byName.map((w) => w.code)).toEqual(["DEPOT-N"]);
  });

  it("treats % and _ in a query as characters and not as wildcards", async () => {
    // Were they wildcards, '%' would match every depot — the failure that makes a search
    // box look like it works while answering a different question.
    expect(await inTenant((tx) => listWarehouses(tx, { query: "%" }))).toHaveLength(0);
    expect(await inTenant((tx) => listWarehouses(tx, { query: "_" }))).toHaveLength(0);
    expect(await inTenant((tx) => listWarehouses(tx, { query: "DEPOT_N" }))).toHaveLength(0);
  });

  it("treats a blank query as no query at all", async () => {
    const all = await inTenant((tx) => listWarehouses(tx));
    // An ABSENT `query` and a present-but-empty one are different types under
    // `exactOptionalPropertyTypes` and must be the same answer, so both are here: the route
    // passes what `?q=` gave it, which is `null` when the parameter is missing and `""`
    // when it is present and empty.
    expect(await inTenant((tx) => listWarehouses(tx, {}))).toHaveLength(all.length);
    for (const q of [null, "", "   "]) {
      expect(await inTenant((tx) => listWarehouses(tx, { query: q }))).toHaveLength(all.length);
    }
  });

  it("caps the page and clamps a nonsense limit rather than erroring", async () => {
    expect(await inTenant((tx) => listWarehouses(tx, { limit: 1 }))).toHaveLength(1);
    // Zero is clamped UP to one, not treated as "no limit" — `?? ` does not catch it, and
    // a LIMIT 0 that quietly meant "everything" would be the worse reading of the two.
    expect(await inTenant((tx) => listWarehouses(tx, { limit: 0 }))).toHaveLength(1);
    expect(await inTenant((tx) => listWarehouses(tx, { limit: -5 }))).toHaveLength(1);
    expect(await inTenant((tx) => listWarehouses(tx, { limit: WAREHOUSE_LIMIT + 10_000 }))).toHaveLength(2);
  });

  it("is scoped by tenant, like every other read here", async () => {
    await withTenantContext(client, UNSYNCED, async (tx) => {
      expect(await listWarehouses(tx)).toHaveLength(0);
    });
  });

  describe("resolving a movement's destination", () => {
    it("accepts an active depot and hands back what it resolved", async () => {
      const found = await inTenant((tx) => requireActiveWarehouse(tx, "wh-north"));
      expect(found.code).toBe("DEPOT-N");
    });

    it("accepts exactly what the list offers, and nothing the list omits", async () => {
      // The property that keeps the picker and the write from drifting apart.
      const offered = await inTenant((tx) => listWarehouses(tx));
      for (const w of offered) {
        await expect(inTenant((tx) => requireActiveWarehouse(tx, w.erp_warehouse_id))).resolves.toBeTruthy();
      }
      const omitted = DEPOTS.map(([id]) => id).filter((id) => !offered.some((w) => w.erp_warehouse_id === id));
      expect(omitted).toHaveLength(4);
      for (const id of omitted) {
        await expect(inTenant((tx) => requireActiveWarehouse(tx, id))).rejects.toThrow();
      }
    });

    it("refuses a closed depot as a conflict, naming its status", async () => {
      await expect(inTenant((tx) => requireActiveWarehouse(tx, "wh-closed"))).rejects.toMatchObject({
        name: "WarehouseInactiveError",
        message: expect.stringContaining("closed"),
      });
      await expect(inTenant((tx) => requireActiveWarehouse(tx, "wh-idle"))).rejects.toMatchObject({
        name: "WarehouseInactiveError",
        message: expect.stringContaining("inactive"),
      });
    });

    it("refuses a status it has never seen, rather than admitting it", async () => {
      await expect(inTenant((tx) => requireActiveWarehouse(tx, "wh-odd"))).rejects.toMatchObject({
        name: "WarehouseInactiveError",
        message: expect.stringContaining("mothballed"),
      });
    });

    it("refuses a depot with no status and still produces a sentence", async () => {
      await expect(inTenant((tx) => requireActiveWarehouse(tx, "wh-null"))).rejects.toMatchObject({
        name: "WarehouseInactiveError",
        message: expect.stringContaining("unknown status"),
      });
    });

    it("refuses an id the list does not have as the caller's mistake", async () => {
      await expect(inTenant((tx) => requireActiveWarehouse(tx, "wh-invented"))).rejects.toMatchObject({
        name: "UnknownWarehouseError",
      });
    });

    it("refuses another tenant's depot as unknown, not as closed", async () => {
      // Scoping is RLS's, and this is the proof that it holds for the WRITE check and not
      // only for the list: a depot that exists elsewhere must be as unknown as one that
      // does not exist at all.
      await withTenantContext(client, UNSYNCED, (tx) => seed(tx, UNSYNCED));
      try {
        await inTenant(async (tx) => {
          await tx.query("DELETE FROM crm.warehouse_snapshot WHERE erp_warehouse_id = 'wh-north'");
          await expect(requireActiveWarehouse(tx, "wh-north")).rejects.toMatchObject({
            name: "UnknownWarehouseError",
          });
        });
      } finally {
        await withTenantContext(client, UNSYNCED, (tx) =>
          tx.query("DELETE FROM crm.warehouse_snapshot WHERE tenant_id = $1", [UNSYNCED]),
        );
      }
    });

    it("says the list has never synced rather than blaming the id", async () => {
      // THE DISTINCTION THAT MATTERS MOST HERE. A 422 would send a rep hunting a typo in an
      // id that was never checked against anything, because the CRM has no list to check
      // it against. It is a 503 and it names the cause.
      await withTenantContext(client, UNSYNCED, async (tx) => {
        await expect(requireActiveWarehouse(tx, "wh-north")).rejects.toMatchObject({
          name: "WarehouseListUnsyncedError",
          message: expect.stringContaining("no list of ERP warehouses yet"),
        });
      });
    });

    it("stops failing closed the moment one depot arrives", async () => {
      // The 503 is a statement about the LIST, so a single synced row turns the same id
      // into an ordinary unknown — and the depot that did arrive is usable immediately.
      await withTenantContext(client, UNSYNCED, async (tx) => {
        await tx.query(
          `INSERT INTO crm.warehouse_snapshot (tenant_id, erp_warehouse_id, code, name, status)
           VALUES ($1, 'wh-only', 'DEPOT-1', 'The Only Depot', 'active')`,
          [UNSYNCED],
        );
        await expect(requireActiveWarehouse(tx, "wh-invented")).rejects.toMatchObject({
          name: "UnknownWarehouseError",
        });
        await expect(requireActiveWarehouse(tx, "wh-only")).resolves.toMatchObject({ code: "DEPOT-1" });
      });
    });

    it("keeps answering for a depot that has closed, because the movement still happened", async () => {
      // Not an FK, deliberately (0058): the snapshot's rows can be retracted by a full
      // sweep, and the ledger must not depend on a table another system can empty. The
      // consequence worth pinning is that a historical destination stays readable — the
      // row is gone from the picker and the ledger's own `erp_warehouse_id` is untouched.
      await inTenant(async (tx) => {
        await tx.query("UPDATE crm.warehouse_snapshot SET status = 'closed' WHERE erp_warehouse_id = 'wh-north'");
        expect((await listWarehouses(tx)).map((w) => w.code)).toEqual(["DEPOT-S"]);
        const { rows } = await tx.query<{ code: string }>(
          "SELECT code FROM crm.warehouse_snapshot WHERE erp_warehouse_id = 'wh-north'",
        );
        expect(rows[0]?.code).toBe("DEPOT-N");
      });
    });
  });
});
