import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_DELETION_LIVE as LIVE_TENANT,
  TENANT_DELETION_STOPPED as STOPPED_TENANT,
  appPool,
} from "@crm/db/testing";
import { TENANT_DELETION_TOMBSTONE_KIND, type TenantDeletionVerdict } from "@crm/acl";
import { withTenantContext } from "@crm/db";

import {
  TenantNotRegisteredError,
  recordTenantDeletionCheck,
  summariseTenantDeletionWatch,
  tenantRegistryStatus,
  watchTenantDeletion,
} from "./tenant-deletion.js";

/**
 * The deletion signal against a real Postgres (migration 0050).
 *
 * Everything here is about what the DATABASE refuses, so none of it could be asserted against
 * a fake connection: the terminal rule is a trigger, the status-needs-a-receipt rule is a
 * CHECK, the ring is a trigger keyed on `seq`, and the mark's effect is a row the scheduler's
 * own `WHERE status = 'active'` stops returning.
 *
 * `crm.tenant` is the deliberately RLS-exempt registry, so the fixtures write it directly —
 * which is also what lets the last test prove the quarantine is per tenant rather than per
 * connection.
 */
describe("tenant deletion signal (0050)", () => {
  let pool: Pool;
  let client: PoolClient;

  const SHA = "a".repeat(64);
  const CHAIN = "b".repeat(64);

  const deleted = (over: Record<string, unknown> = {}): TenantDeletionVerdict => ({
    verdict: "deleted",
    httpStatus: 200,
    tombstone: {
      tombstoneId: "tomb_0123456789abcdef0123456789abcdef",
      kind: TENANT_DELETION_TOMBSTONE_KIND,
      deletedAt: "2026-10-06T12:00:00.000Z",
      proofSha256: SHA,
      chainEntryHash: CHAIN,
      ...over,
    },
  });
  const live: TenantDeletionVerdict = { verdict: "live", httpStatus: 200 };
  const unknown = (detail: string, httpStatus: number | null = 403): TenantDeletionVerdict => ({
    verdict: "unknown",
    httpStatus,
    detail,
  });

  /** A reader that answers whatever this test wants, without a server. */
  const reader = (answer: () => Promise<unknown>) => ({ tenantTombstones: answer });

  const register = async (tenantId: string, name: string): Promise<void> => {
    await client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, name],
    );
  };

  const statusOf = (tenantId: string): Promise<string | null> => tenantRegistryStatus(client, tenantId);

  /**
   * ALSO inside a tenant context, per tenant, and the reason is the one that actually bit:
   * a `DELETE` as `crm_app` with no context matches zero rows and reports success, so the
   * cleanup silently did nothing and the next test read twenty rows it had not written. The
   * same asymmetry as the read above and the third form of it this repository has recorded —
   * DML is an ordinary query, so RLS confines it rather than refusing it.
   */
  const clearChecks = async (): Promise<void> => {
    for (const t of [STOPPED_TENANT, LIVE_TENANT]) {
      await withTenantContext(client, t, (tx) =>
        tx.query("DELETE FROM crm.tenant_deletion_check WHERE tenant_id = $1", [t]),
      );
    }
  };

  /**
   * INSIDE a tenant context, necessarily — and the first version of this file was not, which
   * is how it rediscovered the lesson this repository keeps relearning. `crm.tenant` is the
   * RLS-exempt registry, so reading and writing IT needs no context; the check log beside it
   * is tenant-scoped and under `FORCE ROW LEVEL SECURITY`, so a `SELECT` without a context
   * returns zero rows and an `INSERT` is refused by the policy rather than by the CHECK the
   * test was aiming at. Reading as `crm_app` through `withTenantContext` is what the code
   * does, so it is what the test must do.
   */
  const checks = (tenantId: string): Promise<{ verdict: string; detail: string | null }[]> =>
    withTenantContext(client, tenantId, async (tx) => {
      const { rows } = await tx.query<{ verdict: string; detail: string | null }>(
        "SELECT verdict, detail FROM crm.tenant_deletion_check WHERE tenant_id = $1 ORDER BY seq",
        [tenantId],
      );
      return rows;
    });

  /** `tenantId` set when the statement touches the tenant-scoped log; omitted for `crm.tenant`. */
  const refusal = async (
    sql: string,
    params: readonly unknown[] = [],
    tenantId?: string,
  ): Promise<string> => {
    try {
      if (tenantId === undefined) await client.query(sql, [...params]);
      else await withTenantContext(client, tenantId, (tx) => tx.query(sql, [...params]));
    } catch (err) {
      return (err as { message?: string }).message ?? String(err);
    }
    throw new Error(`expected a refusal: ${sql}`);
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    // The stopped tenant's row is deliberately left behind: 0050 makes `erp_deleted` terminal
    // and its receipt write-once, so the only way to clean it up is a DELETE.
    await clearChecks();
    await client.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1)", [[STOPPED_TENANT, LIVE_TENANT]]);
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await clearChecks();
    await client.query("DELETE FROM crm.tenant WHERE tenant_id = ANY($1)", [[STOPPED_TENANT, LIVE_TENANT]]);
    await register(LIVE_TENANT, "Still Trading");
  });

  // -------------------------------------------------------------------------
  // Recording, including the answers that answered nothing.
  // -------------------------------------------------------------------------
  it("records an affirmative live without touching the tenant", async () => {
    const r = await recordTenantDeletionCheck(client, LIVE_TENANT, live);
    expect(r).toMatchObject({ verdict: "live", marked: false, tombstoneId: null });
    expect(await statusOf(LIVE_TENANT)).toBe("active");
    expect(await checks(LIVE_TENANT)).toEqual([{ verdict: "live", detail: null }]);
  });

  /**
   * An `unknown` is recorded WITH its reason, which is the whole point of the table: a
   * deployment whose read role was never granted gets 403 forever, and a signal that silently
   * never fires is worse than no signal because the deployment believes it is watching.
   */
  it("records an unknown with the reason it was unknown", async () => {
    await recordTenantDeletionCheck(client, LIVE_TENANT, unknown("not in --tenant-tombstone-read-role"));
    expect(await checks(LIVE_TENANT)).toEqual([
      { verdict: "unknown", detail: "not in --tenant-tombstone-read-role" },
    ]);
    expect(await statusOf(LIVE_TENANT)).toBe("active");
  });

  it("refuses an unknown with no reason, in the database", async () => {
    const msg = await refusal(
      `INSERT INTO crm.tenant_deletion_check (tenant_id, verdict, http_status)
       VALUES ($1, 'unknown', 403)`,
      [LIVE_TENANT],
      LIVE_TENANT,
    );
    expect(msg).toContain("tenant_deletion_check_unknown_has_reason");
  });

  // -------------------------------------------------------------------------
  // The mark.
  // -------------------------------------------------------------------------
  it("stops a tenant on a tenant_deletion tombstone, keeping the receipt", async () => {
    await register(STOPPED_TENANT, "Gone");
    const r = await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    expect(r).toMatchObject({ verdict: "deleted", marked: true, tombstoneId: "tomb_0123456789abcdef0123456789abcdef" });

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT status, erp_tombstone_id, erp_tombstone_kind, erp_tombstone_proof_sha256,
              erp_tombstone_chain_entry_hash, erp_tombstone_observed_at IS NOT NULL AS observed
         FROM crm.tenant WHERE tenant_id = $1`,
      [STOPPED_TENANT],
    );
    expect(rows[0]).toMatchObject({
      status: "erp_deleted",
      erp_tombstone_id: "tomb_0123456789abcdef0123456789abcdef",
      erp_tombstone_kind: "tenant_deletion",
      erp_tombstone_proof_sha256: SHA,
      erp_tombstone_chain_entry_hash: CHAIN,
      observed: true,
    });
  });

  /** Per tenant, not per connection: the other tenant in the same database is untouched. */
  it("stops only the tenant the tombstone names", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    expect(await statusOf(LIVE_TENANT)).toBe("active");
  });

  it("is idempotent: a second deletion verdict reports already-stopped", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    const again = await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    expect(again).toMatchObject({ verdict: "deleted", marked: false });
    expect(summariseTenantDeletionWatch(again)).toContain("already-stopped");
    expect((await checks(STOPPED_TENANT)).map((c) => c.verdict)).toEqual(["deleted", "deleted"]);
  });

  /**
   * The one outcome where the signal worked and the consequence did not. Reporting success
   * here would leave every other job processing a deleted tenant's data with a `deleted` row
   * in the log saying all was well.
   */
  it("refuses when a deletion lands on a tenant the registry does not list", async () => {
    await expect(
      watchTenantDeletion(client, reader(() => Promise.resolve({ tenantId: STOPPED_TENANT, data: [
        { tombstoneId: "tomb_0123456789abcdef0123456789abcdef", kind: "tenant_deletion",
          deletedAt: "2026-10-06T12:00:00.000Z", proofSha256: SHA, chainEntryHash: CHAIN },
      ] })), STOPPED_TENANT),
    ).rejects.toThrow(TenantNotRegisteredError);
    // And the observation is still on the record — the refusal is about the consequence.
    expect((await checks(STOPPED_TENANT)).map((c) => c.verdict)).toEqual(["deleted"]);
  });

  // -------------------------------------------------------------------------
  // What the database refuses.
  // -------------------------------------------------------------------------
  it("refuses the status without a receipt", async () => {
    const msg = await refusal("UPDATE crm.tenant SET status = 'erp_deleted' WHERE tenant_id = $1", [
      LIVE_TENANT,
    ]);
    expect(msg).toContain("tenant_erp_deleted_needs_receipt");
  });

  it("refuses a receipt without the status", async () => {
    const msg = await refusal(
      "UPDATE crm.tenant SET erp_tombstone_id = 'tomb_0123456789abcdef0123456789abcdef' WHERE tenant_id = $1",
      [LIVE_TENANT],
    );
    expect(msg).toContain("tenant_erp_deleted_needs_receipt");
  });

  /**
   * The second layer under `classifyTombstonePayload`'s kind filter. A `data_subject_erasure`
   * tombstone is one person, in a tenant that is otherwise alive; if it ever reached this
   * column the whole tenant would be stopped by one employee's Article 17 request.
   */
  it("refuses a data_subject_erasure tombstone in the tenant's receipt", async () => {
    const msg = await refusal(
      `UPDATE crm.tenant
          SET status = 'erp_deleted', erp_tombstone_id = 'tomb_0123456789abcdef0123456789abcdef',
              erp_tombstone_kind = 'data_subject_erasure'
        WHERE tenant_id = $1`,
      [LIVE_TENANT],
    );
    expect(msg).toContain("tenant_erp_tombstone_kind");
  });

  it.each([
    ["erp_tombstone_proof_sha256", "'deadbeef'", "tenant_erp_tombstone_proof_shape"],
    ["erp_tombstone_chain_entry_hash", "'deadbeef'", "tenant_erp_tombstone_chain_shape"],
  ])("refuses a malformed %s", async (column, value, constraint) => {
    const msg = await refusal(
      `UPDATE crm.tenant SET status = 'erp_deleted',
          erp_tombstone_id = 'tomb_0123456789abcdef0123456789abcdef', ${column} = ${value}
        WHERE tenant_id = $1`,
      [LIVE_TENANT],
    );
    expect(msg).toContain(constraint);
  });

  it("refuses a malformed erp_tombstone_id", async () => {
    const msg = await refusal(
      "UPDATE crm.tenant SET status = 'erp_deleted', erp_tombstone_id = 'tombstone-7' WHERE tenant_id = $1",
      [LIVE_TENANT],
    );
    expect(msg).toContain("tenant_erp_tombstone_id_shape");
  });

  it("is terminal: there is no transition out", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    for (const next of ["active", "paused", "disabled"]) {
      const msg = await refusal("UPDATE crm.tenant SET status = $2 WHERE tenant_id = $1", [
        STOPPED_TENANT,
        next,
      ]);
      expect(msg).toMatch(/^tenant-erp-deleted-terminal: /);
      expect(msg).toContain(next);
    }
    expect(await statusOf(STOPPED_TENANT)).toBe("erp_deleted");
  });

  it("freezes the receipt once it is filed", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    const msg = await refusal(
      "UPDATE crm.tenant SET erp_tombstone_proof_sha256 = $2 WHERE tenant_id = $1",
      [STOPPED_TENANT, "c".repeat(64)],
    );
    expect(msg).toMatch(/^tenant-erp-deleted-terminal: /);
    expect(msg).toContain("rewriting the evidence");
  });

  /** Not frozen: a deleted tenant's display name is not evidence, and 0047's rule says so. */
  it("leaves the display name writable", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    await client.query("UPDATE crm.tenant SET display_name = 'Gone (deleted)' WHERE tenant_id = $1", [
      STOPPED_TENANT,
    ]);
    const { rows } = await client.query<{ display_name: string }>(
      "SELECT display_name FROM crm.tenant WHERE tenant_id = $1",
      [STOPPED_TENANT],
    );
    expect(rows[0]?.display_name).toBe("Gone (deleted)");
  });

  // -------------------------------------------------------------------------
  // The ring.
  // -------------------------------------------------------------------------
  it("keeps the newest twenty checks per tenant", async () => {
    for (let i = 0; i < 25; i += 1) {
      await recordTenantDeletionCheck(client, LIVE_TENANT, unknown(`attempt ${String(i)}`));
    }
    const kept = await checks(LIVE_TENANT);
    expect(kept).toHaveLength(20);
    expect(kept[0]?.detail).toBe("attempt 5");
    expect(kept[19]?.detail).toBe("attempt 24");
  });

  /** And trims per tenant, so a busy tenant cannot evict a quiet one's history. */
  it("trims per tenant", async () => {
    await register(STOPPED_TENANT, "Gone");
    await recordTenantDeletionCheck(client, STOPPED_TENANT, live);
    for (let i = 0; i < 25; i += 1) {
      await recordTenantDeletionCheck(client, LIVE_TENANT, live);
    }
    expect(await checks(STOPPED_TENANT)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The whole job.
  // -------------------------------------------------------------------------
  it("asks, records and stops, in one call", async () => {
    await register(STOPPED_TENANT, "Gone");
    const r = await watchTenantDeletion(
      client,
      reader(() =>
        Promise.resolve({
          tenantId: STOPPED_TENANT,
          data: [
            {
              tombstoneId: "tomb_0123456789abcdef0123456789abcdef",
              kind: "tenant_deletion",
              deletedAt: "2026-10-06T12:00:00.000Z",
              proofSha256: SHA,
              chainEntryHash: null,
            },
          ],
        }),
      ),
      STOPPED_TENANT,
    );
    expect(summariseTenantDeletionWatch(r)).toContain("STOPPED tenant");
    expect(await statusOf(STOPPED_TENANT)).toBe("erp_deleted");
  });

  it("records a refusal as unknown rather than throwing", async () => {
    const r = await watchTenantDeletion(
      client,
      reader(() => Promise.reject(new Error("connect ECONNREFUSED"))),
      LIVE_TENANT,
    );
    expect(r.verdict).toBe("unknown");
    expect(r.httpStatus).toBeNull();
    expect(await statusOf(LIVE_TENANT)).toBe("active");
    expect((await checks(LIVE_TENANT))[0]?.detail).toContain("ECONNREFUSED");
  });

  /**
   * The consequence the mark exists for, asserted through the query the scheduler actually
   * uses rather than by restating it: a stopped tenant is not enumerated, so every job stops.
   */
  it("removes a stopped tenant from the scheduler's own enumeration", async () => {
    await register(STOPPED_TENANT, "Gone");
    const active = async (): Promise<string[]> => {
      const { rows } = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM crm.tenant WHERE status = 'active' ORDER BY created_at",
      );
      return rows.map((r) => r.tenant_id);
    };
    expect(await active()).toContain(STOPPED_TENANT);
    await recordTenantDeletionCheck(client, STOPPED_TENANT, deleted());
    expect(await active()).not.toContain(STOPPED_TENANT);
    expect(await active()).toContain(LIVE_TENANT);
  });
});
