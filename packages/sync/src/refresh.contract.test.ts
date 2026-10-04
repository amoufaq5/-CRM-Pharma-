import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { ErpClient, type FetchLike, type TenantCredential } from "@crm/acl";
import { ERP_SCHEMA_FIXTURE } from "@crm/acl/fixtures";
import { withTenantContext } from "@crm/db";

import { SnapshotRefresher } from "./refresh.js";
import { evaluateStaleness, readFreshness } from "./snapshot-store.js";

import { appPool, TENANT_SYNC as TENANT } from "@crm/db/testing";

/**
 * `appPool()`, not `testPool()`: this pool is handed to code that opens its OWN
 * connections, and those inherit the pool's role. The admin pool would run every one of
 * them as a superuser, which bypasses row-level security even under `FORCE` — so a
 * missing tenant predicate would be invisible to this whole suite. One was.
 * See the comment on `appPool` in `@crm/db/testing`.
 */

/** An ERP serving a fixed set of Items, honouring ?updated_at[gte]= and the cursor. */
function erpServing(items: Array<Record<string, unknown>>, pageSize = 100): ErpClient {
  const fetchImpl: FetchLike = (url) => {
    if (url.endsWith("/v1/meta/schema")) {
      return Promise.resolve(res(200, ERP_SCHEMA_FIXTURE));
    }
    const q = new URL(url).searchParams;
    const since = q.get("updated_at[gte]") ?? "";
    const offset = Number(q.get("cursor") ?? "0");
    const matching = items
      .filter((i) => String(i["updated_at"] ?? "") >= since)
      .sort((a, b) => String(a["updated_at"]).localeCompare(String(b["updated_at"])));
    const slice = matching.slice(offset, offset + pageSize);
    const next = offset + pageSize < matching.length ? String(offset + pageSize) : null;
    return Promise.resolve(res(200, { data: slice, page: { nextCursor: next } }));
  };
  return new ErpClient({
    baseUrl: "https://erp.example",
    credential: { token: () => Promise.resolve("t") } satisfies TenantCredential,
    fetch: fetchImpl,
  });
}

function res(status: number, body: unknown) {
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sku: `SKU-${id}`,
  name: `Item ${id}`,
  status: "active",
  list_price: "10.00",
  updated_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("snapshot refresh against a real database", () => {
  let p: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    p = appPool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
  });

  afterAll(async () => {
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  beforeEach(async () => {
    await withTenantContext(admin, TENANT, async (tx) => {
      await tx.query("DELETE FROM crm.product_snapshot WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.snapshot_freshness WHERE tenant_id = $1", [TENANT]);
    });
  });

  async function snapshotRows(): Promise<Array<{ erp_item_id: string; list_price: string | null; name: string }>> {
    return withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query(
        "SELECT erp_item_id, list_price, name FROM crm.product_snapshot WHERE tenant_id = $1 ORDER BY erp_item_id",
        [TENANT],
      );
      return rows;
    });
  }

  it("fills the snapshot with EXACT decimals — the reason these tables exist", async () => {
    const r = new SnapshotRefresher({
      pool: p,
      client: erpServing([item("rec_1", { list_price: "1234567890.12" })]),
    });
    const result = await r.refresh(TENANT, "product", "full");

    expect(result).toMatchObject({ read: 1, upserted: 1, rejected: [] });
    const rows = await snapshotRows();
    // Stored and read back byte-exact. A float64 round trip would have lost it.
    expect(rows[0]?.list_price).toBe("1234567890.12");
  });

  it("answers a numeric query CORRECTLY, where the ERP would not", async () => {
    const r = new SnapshotRefresher({
      pool: p,
      client: erpServing([
        item("rec_a", { list_price: "999" }),
        item("rec_b", { list_price: "1000" }),
        item("rec_c", { list_price: "20" }),
      ]),
    });
    await r.refresh(TENANT, "product", "full");

    const found = await withTenantContext(admin, TENANT, async (tx) => {
      const { rows } = await tx.query<{ list_price: string }>(
        "SELECT list_price FROM crm.product_snapshot WHERE tenant_id = $1 AND list_price >= 1000",
        [TENANT],
      );
      return rows.map((x) => x.list_price);
    });
    // The same predicate against the ERP returns {1000, 999, 20} because every
    // comparison there is textual (report R19). Here it is just right.
    expect(found).toEqual(["1000.00"]);
  });

  it("is idempotent — re-running upserts rather than duplicating", async () => {
    const client = erpServing([item("rec_1"), item("rec_2")]);
    const r = new SnapshotRefresher({ pool: p, client });
    await r.refresh(TENANT, "product", "full");
    await r.refresh(TENANT, "product", "full");
    expect(await snapshotRows()).toHaveLength(2);
  });

  it("updates a changed record in place", async () => {
    const r1 = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1", { name: "Before" })]) });
    await r1.refresh(TENANT, "product", "full");

    const r2 = new SnapshotRefresher({
      pool: p,
      client: erpServing([item("rec_1", { name: "After", updated_at: "2026-09-02T00:00:00.000Z" })]),
    });
    await r2.refresh(TENANT, "product", "incremental");

    const rows = await snapshotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("After");
  });

  it("resumes incrementally from the stored high-water mark", async () => {
    const r1 = new SnapshotRefresher({
      pool: p,
      client: erpServing([item("rec_1", { updated_at: "2026-09-01T00:00:00.000Z" })]),
    });
    const first = await r1.refresh(TENANT, "product", "full");
    expect(first.highWaterMark).toBe("2026-09-01T00:00:00.000Z");

    // Only the newer record should be read on the next pass.
    const r2 = new SnapshotRefresher({
      pool: p,
      client: erpServing([
        item("rec_1", { updated_at: "2026-09-01T00:00:00.000Z" }),
        item("rec_2", { updated_at: "2026-09-05T00:00:00.000Z" }),
      ]),
    });
    const second = await r2.refresh(TENANT, "product", "incremental");
    // Inclusive gte, so rec_1 is re-read; that is intended — skipping is worse
    // than repeating, and the write is an idempotent upsert.
    expect(second.read).toBe(2);
    expect(second.highWaterMark).toBe("2026-09-05T00:00:00.000Z");
  });

  it("paginates a sweep larger than one page", async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      item(`rec_${String(i).padStart(3, "0")}`, {
        updated_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const r = new SnapshotRefresher({ pool: p, client: erpServing(items, 10), pageSize: 10 });
    const result = await r.refresh(TENANT, "product", "full");
    expect(result.read).toBe(25);
    expect(await snapshotRows()).toHaveLength(25);
  });

  describe("deletions — reconcilable only by a full sweep", () => {
    it("a full sweep REMOVES a record the ERP no longer serves", async () => {
      const r1 = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1"), item("rec_2")]) });
      await r1.refresh(TENANT, "product", "full");
      expect(await snapshotRows()).toHaveLength(2);

      // rec_2 deleted at the ERP: it simply stops being returned, with no
      // tombstone anywhere (pack-erp-core declares `auditable`, not
      // `soft_deletable`).
      const r2 = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1")]) });
      const result = await r2.refresh(TENANT, "product", "full");

      expect(result.deleted).toBe(1);
      expect((await snapshotRows()).map((x) => x.erp_item_id)).toEqual(["rec_1"]);
    });

    it("an INCREMENTAL refresh cannot see a deletion — the ghost persists", async () => {
      // Not a bug to fix here: polling by updated_at can never observe the
      // absence of a record. This test exists so the limitation is stated and
      // cannot be forgotten, and so the full sweep's necessity is evidenced.
      const r1 = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1"), item("rec_2")]) });
      await r1.refresh(TENANT, "product", "full");

      const r2 = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1")]) });
      const result = await r2.refresh(TENANT, "product", "incremental");

      expect(result.deleted).toBe(0);
      expect(await snapshotRows()).toHaveLength(2); // rec_2 still there
    });

    it("records when the last full sweep happened, separately from the last success", async () => {
      const r = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1")]) });
      await r.refresh(TENANT, "product", "incremental");
      let f = await withTenantContext(admin, TENANT, (tx) => readFreshness(tx, TENANT, "product"));
      // Incremental succeeded but reconciled nothing, so a snapshot that has
      // only ever been refreshed incrementally is visible as such.
      expect(f?.last_success_at).not.toBeNull();
      expect(f?.last_full_sweep_at).toBeNull();

      await r.refresh(TENANT, "product", "full");
      f = await withTenantContext(admin, TENANT, (tx) => readFreshness(tx, TENANT, "product"));
      expect(f?.last_full_sweep_at).not.toBeNull();
    });
  });

  describe("malformed records", () => {
    it("rejects the bad record BY NAME and syncs the rest", async () => {
      const r = new SnapshotRefresher({
        pool: p,
        client: erpServing([item("rec_ok"), item("rec_bad", { list_price: "$10" }), item("rec_ok2")]),
      });
      const result = await r.refresh(TENANT, "product", "full");

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.recordId).toBe("rec_bad");
      expect(result.rejected[0]?.reason).toMatch(/list_price/);
      expect(result.upserted).toBe(2);
    });

    it("surfaces the rejection in freshness, so it is not merely a return value", async () => {
      const r = new SnapshotRefresher({
        pool: p,
        client: erpServing([item("rec_bad", { list_price: "abc" })]),
      });
      await r.refresh(TENANT, "product", "full");
      const f = await withTenantContext(admin, TENANT, (tx) => readFreshness(tx, TENANT, "product"));
      expect(f?.last_error).toMatch(/1 record\(s\) rejected/);
    });

    it("does not delete a rejected record's existing row on a full sweep", async () => {
      // The record still EXISTS at the ERP; we merely cannot represent this
      // version of it. Deleting the last good copy would turn a data problem
      // into missing data.
      const good = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1", { list_price: "5.00" })]) });
      await good.refresh(TENANT, "product", "full");

      const bad = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1", { list_price: "$5" })]) });
      const result = await bad.refresh(TENANT, "product", "full");

      expect(result.rejected).toHaveLength(1);
      const rows = await snapshotRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.list_price).toBe("5.00"); // the last good value survives
    });
  });

  describe("staleness", () => {
    it("reports never_synced before the first run, not infinite age", async () => {
      await withTenantContext(admin, TENANT, (tx) =>
        tx.query(
          `INSERT INTO crm.snapshot_freshness (tenant_id, snapshot) VALUES ($1,'product')
           ON CONFLICT DO NOTHING`,
          [TENANT],
        ),
      );
      const f = await withTenantContext(admin, TENANT, (tx) => readFreshness(tx, TENANT, "product"));
      // "This device has no price list yet" is a different message to a rep
      // than "prices may be out of date".
      expect(evaluateStaleness(f!, new Date()).level).toBe("never_synced");
    });

    it("moves fresh -> warn -> block as the budget is crossed", async () => {
      const r = new SnapshotRefresher({ pool: p, client: erpServing([item("rec_1")]) });
      await r.refresh(TENANT, "product", "full");
      const f = await withTenantContext(admin, TENANT, (tx) => readFreshness(tx, TENANT, "product"));

      const at = (secondsLater: number) =>
        evaluateStaleness(f!, new Date(f!.last_success_at!.getTime() + secondsLater * 1000)).level;

      expect(at(60)).toBe("fresh");
      expect(at(f!.warn_after_seconds + 1)).toBe("warn");
      expect(at(f!.block_after_seconds + 1)).toBe("block");
    });
  });

  it("refreshAll continues past a snapshot that fails", async () => {
    // A broken product feed must not also stop the rep roster updating.
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/v1/meta/schema")) return Promise.resolve(res(200, ERP_SCHEMA_FIXTURE));
      if (url.includes("/v1/items")) return Promise.resolve(res(500, { error: "boom" }));
      return Promise.resolve(res(200, { data: [], page: { nextCursor: null } }));
    };
    const client = new ErpClient({
      baseUrl: "https://erp.example",
      credential: { token: () => Promise.resolve("t") },
      fetch: fetchImpl,
    });
    const results = await new SnapshotRefresher({ pool: p, client }).refreshAll(TENANT, "incremental");
    expect(results).toHaveLength(3);
    expect(results[0]).toHaveProperty("error");
  });

  it("stops a runaway sweep rather than looping forever", async () => {
    // A cursor that never terminates usually means the ERP's keyset sort field
    // changed under us. Better a loud stop than an infinite loop.
    const fetchImpl: FetchLike = (url) =>
      Promise.resolve(
        url.endsWith("/v1/meta/schema")
          ? res(200, ERP_SCHEMA_FIXTURE)
          : res(200, { data: [], page: { nextCursor: "always" } }),
      );
    const client = new ErpClient({
      baseUrl: "https://erp.example",
      credential: { token: () => Promise.resolve("t") },
      fetch: fetchImpl,
    });
    const r = new SnapshotRefresher({ pool: p, client, maxPages: 5 });
    await expect(r.refresh(TENANT, "product", "full")).rejects.toThrow(/exceeded 5 pages/);
  });
});
