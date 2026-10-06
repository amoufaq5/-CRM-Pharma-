import { describe, expect, it } from "vitest";

import { ErpError } from "./problems.js";
import {
  TENANT_DELETION_TOMBSTONE_KIND,
  classifyTombstonePayload,
  classifyTombstoneRefusal,
  readTenantDeletionVerdict,
} from "./tombstones.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const CHAIN = "b".repeat(64);

const tomb = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tombstoneId: "tomb_0123456789abcdef0123456789abcdef",
  kind: TENANT_DELETION_TOMBSTONE_KIND,
  deletedAt: "2026-10-06T12:00:00.000Z",
  proofSha256: SHA,
  chainEntryHash: CHAIN,
  ...over,
});

const body = (data: unknown[], tenantId = TENANT): Record<string, unknown> => ({ tenantId, data });

describe("classifyTombstonePayload", () => {
  it("reads a tenant_deletion tombstone as deleted, with its evidence", () => {
    const v = classifyTombstonePayload(TENANT, body([tomb()]));
    expect(v.verdict).toBe("deleted");
    if (v.verdict !== "deleted") throw new Error("unreachable");
    expect(v.tombstone).toEqual({
      tombstoneId: "tomb_0123456789abcdef0123456789abcdef",
      kind: "tenant_deletion",
      deletedAt: "2026-10-06T12:00:00.000Z",
      proofSha256: SHA,
      chainEntryHash: CHAIN,
    });
  });

  it("reads an empty list as an affirmative live", () => {
    expect(classifyTombstonePayload(TENANT, body([]))).toEqual({ verdict: "live", httpStatus: 200 });
  });

  /**
   * THE TEST THIS MODULE EXISTS FOR.
   *
   * The ERP's route returns both kinds it can store. A `data_subject_erasure` tombstone is
   * ONE person exercising Article 17 inside a tenant that is otherwise entirely alive, so
   * reacting to it would take a working tenant's whole field force offline the first time an
   * employee asked to be forgotten. It is read, skipped, and the answer is `live`.
   */
  it("does NOT read a data_subject_erasure tombstone as a tenant deletion", () => {
    const v = classifyTombstonePayload(TENANT, body([tomb({ kind: "data_subject_erasure" })]));
    expect(v).toEqual({ verdict: "live", httpStatus: 200 });
  });

  it("finds a tenant deletion among other kinds", () => {
    const v = classifyTombstonePayload(
      TENANT,
      body([tomb({ kind: "data_subject_erasure" }), tomb({ tombstoneId: "tomb_ffffffffffffffffffffffffffffffff" })]),
    );
    expect(v.verdict).toBe("deleted");
    if (v.verdict !== "deleted") throw new Error("unreachable");
    expect(v.tombstone.tombstoneId).toBe("tomb_ffffffffffffffffffffffffffffffff");
  });

  it("accepts a null chainEntryHash, because a deletion commits without waiting on its anchor", () => {
    const v = classifyTombstonePayload(TENANT, body([tomb({ chainEntryHash: null })]));
    expect(v.verdict).toBe("deleted");
    if (v.verdict !== "deleted") throw new Error("unreachable");
    expect(v.tombstone.chainEntryHash).toBeNull();
  });

  it("refuses to be answered about a different tenant", () => {
    const v = classifyTombstonePayload(TENANT, body([tomb()], OTHER));
    expect(v.verdict).toBe("unknown");
    if (v.verdict !== "unknown") throw new Error("unreachable");
    expect(v.detail).toContain(OTHER);
  });

  /**
   * A body we cannot read is `unknown` and never `live`. Failing to understand the answer is
   * not the ERP saying no — the same asymmetry the ERP's own 503 insists on.
   */
  it.each([
    ["not an object", 42],
    ["no tenant", { data: [] }],
    ["no data array", { tenantId: TENANT }],
    ["a non-object entry", body(["nope"])],
  ])("reads %s as unknown rather than live", (_label, payload) => {
    expect(classifyTombstonePayload(TENANT, payload).verdict).toBe("unknown");
  });

  it.each([
    ["a bad tombstone id", { tombstoneId: "tombstone-7" }],
    ["no kind", { kind: "" }],
    ["an unparseable deletedAt", { deletedAt: "the other day" }],
    ["a proof that is not a sha256", { proofSha256: "deadbeef" }],
    ["a chain hash that is neither null nor a sha256", { chainEntryHash: "deadbeef" }],
  ])("reads a tombstone with %s as unknown", (_label, over) => {
    const v = classifyTombstonePayload(TENANT, body([tomb(over)]));
    expect(v.verdict).toBe("unknown");
  });

  /**
   * The COMPOSED detail is bounded, not just the fragment interpolated into it. The first
   * version of `tombstones.ts` capped the fragment, so this sentence's own prefix pushed the
   * result past the cap it was enforcing — caught here, and fixed by routing every `unknown`
   * through one constructor.
   */
  it("bounds the whole composed detail, prefix included", () => {
    const v = classifyTombstonePayload(TENANT, body([tomb()], "x".repeat(5000)));
    expect(v.verdict).toBe("unknown");
    if (v.verdict !== "unknown") throw new Error("unreachable");
    expect(v.detail.length).toBeLessThanOrEqual(300);
    expect(v.detail.startsWith("asked about ")).toBe(true);
  });

  /** And every path's detail fits `crm.tenant_deletion_check.detail`'s 500-char CHECK. */
  it("never produces a detail the column would refuse", () => {
    const long = "y".repeat(9000);
    const details = [
      classifyTombstonePayload(TENANT, body([tomb()], long)),
      classifyTombstonePayload(TENANT, body([tomb({ tombstoneId: long })])),
      classifyTombstoneRefusal(new ErpError("unknown", 500, long, long, null)),
      classifyTombstoneRefusal(new Error(long)),
    ].map((v) => (v.verdict === "unknown" ? v.detail : ""));
    for (const d of details) {
      expect(d.length).toBeGreaterThan(0);
      expect(d.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("classifyTombstoneRefusal", () => {
  /** Every refusal is unknown. None of them is a deletion and none is a clean bill of health. */
  it.each([
    [403, /not in --tenant-tombstone-read-role/],
    [404, /not running --tenant-deletion-routes/],
    [503, /not to treat this as an absence/],
    [401, /says nothing about whether the tenant was deleted/],
    [500, /answered 500/],
  ])("reads %i as unknown, saying why", (status, pattern) => {
    const v = classifyTombstoneRefusal(new ErpError("unknown", status, "whatever", undefined, null));
    expect(v.verdict).toBe("unknown");
    if (v.verdict !== "unknown") throw new Error("unreachable");
    expect(v.httpStatus).toBe(status);
    expect(v.detail).toMatch(pattern);
  });

  it("carries the ERP's own detail alongside ours", () => {
    const v = classifyTombstoneRefusal(
      new ErpError("unavailable", 503, "tombstones_unreadable", "a stored tombstone could not be read", null),
    );
    if (v.verdict !== "unknown") throw new Error("unreachable");
    expect(v.detail).toContain("a stored tombstone could not be read");
  });

  it("reads no answer at all as unknown with a null status", () => {
    const v = classifyTombstoneRefusal(new Error("GET /v1/platform/... timed out after 10000ms"));
    expect(v).toMatchObject({ verdict: "unknown", httpStatus: null });
    if (v.verdict !== "unknown") throw new Error("unreachable");
    expect(v.detail).toContain("timed out");
  });
});

describe("readTenantDeletionVerdict", () => {
  it("never throws: a refusal becomes a verdict", async () => {
    const v = await readTenantDeletionVerdict(
      {
        tenantTombstones: () =>
          Promise.reject(new ErpError("forbidden", 403, "forbidden", "not granted", null)),
      },
      TENANT,
    );
    expect(v.verdict).toBe("unknown");
  });

  it("passes a 200 body to the classifier", async () => {
    const v = await readTenantDeletionVerdict(
      { tenantTombstones: () => Promise.resolve(body([tomb()])) },
      TENANT,
    );
    expect(v.verdict).toBe("deleted");
  });

  it("asks about the tenant it was given", async () => {
    const asked: string[] = [];
    await readTenantDeletionVerdict(
      {
        tenantTombstones: (t) => {
          asked.push(t);
          return Promise.resolve(body([], t));
        },
      },
      TENANT,
    );
    expect(asked).toEqual([TENANT]);
  });
});
