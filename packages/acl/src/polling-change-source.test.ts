import { describe, expect, it } from "vitest";
import { ErpClient, type FetchLike, type TenantCredential } from "./client.js";
import { PollingChangeSource } from "./polling-change-source.js";
import { ERP_SCHEMA_FIXTURE } from "./fixtures.js";
import type { UiSchema } from "./ui-schema.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

/**
 * A schema in which `updated_at` IS filterable and sortable.
 *
 * It is not the ERP's. No entity the ERP serves declares `updated_at` — see
 * `change-source.ts` — so an incremental poll is only possible against a server that
 * publishes it, which `pack-erp-core` does not. This fixture exists to exercise the
 * incremental path at all; the tests below that use the real fixture are the ones that
 * describe what happens today.
 *
 * Built by ADDING the field rather than hand-writing a schema, so everything else about
 * it stays whatever the ERP really serves.
 */
const schemaWithUpdatedAt = (): UiSchema => ({
  ...ERP_SCHEMA_FIXTURE,
  entities: ERP_SCHEMA_FIXTURE.entities.map((e) =>
    e.name === "Item"
      ? {
          ...e,
          fields: [
            ...e.fields,
            {
              name: "updated_at",
              label: "Updated At",
              input: "datetime" as const,
              required: true,
              defaulted: true,
            },
          ],
          filterableFields: [...e.filterableFields, "updated_at"],
          sortableFields: [...e.sortableFields, "updated_at"],
        }
      : e,
  ),
});

function harness(
  pages: Array<{ data: unknown[]; nextCursor: string | null }>,
  schema: UiSchema = schemaWithUpdatedAt(),
) {
  const urls: string[] = [];
  const queue = [...pages];
  const fetchImpl: FetchLike = (url) => {
    urls.push(url);
    const body = url.endsWith("/v1/meta/schema")
      ? schema
      : (() => {
          const p = queue.shift() ?? { data: [], nextCursor: null };
          return { data: p.data, page: { nextCursor: p.nextCursor } };
        })();
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
  const credential: TenantCredential = { token: () => Promise.resolve("t") };
  const client = new ErpClient({ baseUrl: "https://erp.example", credential, fetch: fetchImpl });
  return { source: new PollingChangeSource({ client }), urls };
}

describe("PollingChangeSource", () => {
  it("queries updated_at INCLUSIVELY, ascending — where the server publishes it", async () => {
    const { source, urls } = harness([{ data: [], nextCursor: null }]);
    await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
    const q = new URL(urls.at(-1)!).searchParams;
    // gte, not gt: two records can share an updated_at to the millisecond, and
    // re-reading one is free while skipping one is a silent hole.
    expect(q.get("updated_at[gte]")).toBe("2026-09-01T00:00:00.000Z");
    expect(q.get("sort")).toBe("updated_at");
    expect(q.get("order")).toBe("asc");
  });

  /**
   * What happens against the ERP as it actually is.
   *
   * These six tests passed for the life of the project against a hand-written fixture
   * that declared `updated_at` filterable and sortable. A real `operate-server` serving
   * `pack-erp-core` declares it on none of its 51 entities, so the code under test threw
   * `UnsupportedFilterError` for every entity while its suite was green.
   */
  describe("against a server that does not publish updated_at", () => {
    it("does not send a filter the ERP would silently ignore", async () => {
      const { source, urls } = harness([{ data: [], nextCursor: null }], ERP_SCHEMA_FIXTURE);
      await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
      const q = new URL(urls.at(-1)!).searchParams;
      // Sending it would widen the result set while looking like it narrowed it: the ERP
      // drops an unknown filter rather than refusing it.
      expect(q.get("updated_at[gte]")).toBeNull();
      expect(q.get("sort")).toBeNull();
    });

    it("says so, rather than letting a full read pass for an incremental one", async () => {
      const { source } = harness(
        [{ data: [{ id: "a", updated_at: "2026-09-02T00:00:00.000Z" }], nextCursor: null }],
        ERP_SCHEMA_FIXTURE,
      );
      const batch = await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
      expect(batch.mode).toBe("full_sweep");
      // The records are still correct; what is untrue of them is that `since` bounded it.
      expect(batch.records).toHaveLength(1);
    });

    it("reports the degradation before reading anything", async () => {
      const { source } = harness([], ERP_SCHEMA_FIXTURE);
      expect(await source.supportsIncremental(TENANT, "Item")).toBe(false);
    });

    it("needs BOTH the filter and the sort, not just the filter", async () => {
      // Filtered-but-unsorted would be correct per page and still wrong overall: the
      // cursor would walk the view's default order while the watermark advanced by
      // `updated_at`, and the two can disagree about what has been seen.
      const filterOnly: UiSchema = {
        ...ERP_SCHEMA_FIXTURE,
        entities: ERP_SCHEMA_FIXTURE.entities.map((e) =>
          e.name === "Item" ? { ...e, filterableFields: [...e.filterableFields, "updated_at"] } : e,
        ),
      };
      const { source } = harness([], filterOnly);
      expect(await source.supportsIncremental(TENANT, "Item")).toBe(false);
    });
  });

  it("returns the changed records with their ids and timestamps", async () => {
    const { source } = harness([
      {
        data: [
          { id: "i1", sku: "A", updated_at: "2026-09-02T00:00:00.000Z" },
          { id: "i2", sku: "B", updated_at: "2026-09-03T00:00:00.000Z" },
        ],
        nextCursor: null,
      },
    ]);
    const batch = await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
    expect(batch.records.map((r) => r.recordId)).toEqual(["i1", "i2"]);
    expect(batch.records[0]?.entity).toBe("Item");
  });

  it("advances the high-water mark only when the page is drained", async () => {
    // Advancing mid-page would skip the remainder if the process died before the
    // next call — a silent hole in the snapshot rather than a repeated read.
    const { source } = harness([
      { data: [{ id: "i1", updated_at: "2026-09-02T00:00:00.000Z" }], nextCursor: "cur1" },
    ]);
    const batch = await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
    expect(batch.cursor).toBe("cur1");
    expect(batch.highWaterMark).toBeNull();
  });

  it("reports the newest timestamp once there is no next cursor", async () => {
    const { source } = harness([
      {
        data: [
          { id: "i1", updated_at: "2026-09-02T00:00:00.000Z" },
          { id: "i2", updated_at: "2026-09-05T00:00:00.000Z" },
        ],
        nextCursor: null,
      },
    ]);
    const batch = await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
    expect(batch.highWaterMark).toBe("2026-09-05T00:00:00.000Z");
  });

  it("skips a record with no id or no updated_at rather than guessing", async () => {
    const { source } = harness([
      {
        data: [
          { sku: "no-id", updated_at: "2026-09-02T00:00:00.000Z" },
          { id: "i2" },
          { id: "i3", updated_at: "2026-09-04T00:00:00.000Z" },
        ],
        nextCursor: null,
      },
    ]);
    const batch = await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z");
    // Neither can be stored or resumed from; they reappear next pass if real.
    expect(batch.records.map((r) => r.recordId)).toEqual(["i3"]);
    expect(batch.highWaterMark).toBe("2026-09-04T00:00:00.000Z");
  });

  it("passes a cursor through to continue a partially drained sweep", async () => {
    const { source, urls } = harness([{ data: [], nextCursor: null }]);
    await source.changesSince(TENANT, "Item", "2026-09-01T00:00:00.000Z", "cur1");
    expect(new URL(urls.at(-1)!).searchParams.get("cursor")).toBe("cur1");
  });
});
