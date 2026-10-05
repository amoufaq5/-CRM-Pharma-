import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool, TENANT_STORAGE as TENANT, TENANT_STORAGE_OTHER as OTHER_TENANT } from "@crm/db/testing";

import { PostgresBlobStore, type BlobStore } from "./blob.js";
import { MAX_ATTACHMENT_BYTES, sha256Hex } from "./content.js";

/**
 * The blob store on its own, against a real Postgres as `crm_app`.
 *
 * Separate from `attachment.contract.test.ts` because the seam is worth testing as a seam:
 * everything here is written against the `BlobStore` interface and nothing reaches past it,
 * so the file is also the specification a future `S3BlobStore` would have to satisfy —
 * except for the one property it could not, which is asserted and labelled as such at the
 * bottom.
 *
 * It writes its own metadata rows rather than going through `putAttachment`, so a failure
 * here is a failure of the store rather than of the rules above it.
 */
describe("PostgresBlobStore", () => {
  let pool: Pool;
  let client: PoolClient;
  const store: BlobStore = new PostgresBlobStore();

  const REP = "dd400000-0000-4000-8000-000000000001";
  /**
   * A SECOND rep id for the other tenant, rather than the same uuid twice.
   *
   * `crm.expense_claim.rep_profile_id` is a plain foreign key to `crm.rep_profile (id)`,
   * as every rep-profile reference in this schema is, and a foreign-key check bypasses
   * row-level security — so one uuid inserted under two tenants silently becomes ONE row
   * that both tenants' claims reference, and tearing down the first tenant fails on the
   * second tenant's claim. That is ADR-0001's open item about composite
   * `(tenant_id, id)` references, met in a fixture.
   */
  const OTHER_REP = "dd400000-0000-4000-8000-000000000002";
  const TERRITORY = "dd500000-0000-4000-8000-000000000001";
  let claimId = "";
  let otherClaimId = "";

  const jpeg = (salt: string | Buffer): Buffer =>
    Buffer.concat([Buffer.from("ffd8ff", "hex"), typeof salt === "string" ? Buffer.from(salt, "utf8") : salt]);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOtherTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER_TENANT, fn);

  /** A metadata row declaring exactly these bytes, so the verify trigger is satisfied. */
  const declare = async (
    tx: PoolClient,
    tenant: string,
    subject: string,
    content: Buffer,
  ): Promise<string> => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO crm.attachment
         (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
          content_sha256, uploaded_by)
       VALUES ($1,$2,'expense_receipt','crm.expense_claim',$3,'image/jpeg',$4,$5,$6)`,
      [id, tenant, subject, content.length, sha256Hex(content), tenant === TENANT ? REP : OTHER_REP],
    );
    return id;
  };

  const clear = async (): Promise<void> => {
    for (const run of [inTenant, inOtherTenant]) {
      await run(async (tx) => {
        for (const t of ["crm.attachment", "crm.attachment_blob", "crm.attachment_access"]) {
          await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        }
        try {
          await tx.query("DELETE FROM crm.attachment_access");
          await tx.query("DELETE FROM crm.attachment_blob");
          await tx.query("DELETE FROM crm.attachment");
        } finally {
          for (const t of ["crm.attachment", "crm.attachment_blob", "crm.attachment_access"]) {
            await tx.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
          }
        }
      });
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    for (const [tenant, rep, assign] of [
      [TENANT, REP, true],
      [OTHER_TENANT, OTHER_REP, false],
    ] as const) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,'bl-rep','BL-1','BL Rep') ON CONFLICT DO NOTHING`,
          [rep, tenant],
        );
        if (assign) {
          await tx.query(
            `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'BL-T','T')
             ON CONFLICT DO NOTHING`,
            [TERRITORY, tenant],
          );
          await tx.query(
            `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
             VALUES ($1,$2,$3,'primary','2026-01-01') ON CONFLICT DO NOTHING`,
            [tenant, TERRITORY, rep],
          );
        }
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO crm.expense_claim
             (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
           VALUES ($1,$2,'travel', 10.00, 'EUR', CURRENT_DATE) RETURNING id`,
          [tenant, rep],
        );
        if (tenant === TENANT) claimId = rows[0]!.id;
        else otherClaimId = rows[0]!.id;
      });
    }
  });

  afterAll(async () => {
    await clear();
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    client?.release();
    await pool?.end();
  });

  beforeEach(clear);

  it("names the backend the metadata column records", async () => {
    expect(store.backend).toBe("postgres");
    const admitted = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.attachment'::regclass AND conname = 'attachment_storage_backend_check'`,
      );
      return rows[0]?.def ?? "";
    });
    expect(admitted).toContain(store.backend);
  });

  it("round-trips bytes unchanged", async () => {
    const content = jpeg("a receipt");
    const got = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return store.get(tx, TENANT, id);
    });
    expect(got?.equals(content)).toBe(true);
  });

  it("round-trips arbitrary binary, including nulls and high bytes", async () => {
    // A JPEG is not text, and a store that went through a text encoding anywhere would
    // mangle exactly this and pass every test written with ASCII fixtures.
    const content = jpeg(Buffer.concat([Buffer.of(0, 0, 0xff, 0x80, 0x0a, 0x0d), randomBytes(512)]));
    const got = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return store.get(tx, TENANT, id);
    });
    expect(got?.equals(content)).toBe(true);
    expect(sha256Hex(got!)).toBe(sha256Hex(content));
  });

  it("round-trips a blob of the maximum size", async () => {
    const content = jpeg(Buffer.alloc(MAX_ATTACHMENT_BYTES - 3, 0xab));
    expect(content.length).toBe(MAX_ATTACHMENT_BYTES);
    const got = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return store.get(tx, TENANT, id);
    });
    expect(got?.length).toBe(MAX_ATTACHMENT_BYTES);
    expect(sha256Hex(got!)).toBe(sha256Hex(content));
  });

  it("stores the column out of line and uncompressed, because the formats are already compressed", async () => {
    const storage = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ attstorage: string }>(
        `SELECT attstorage FROM pg_attribute
          WHERE attrelid = 'crm.attachment_blob'::regclass AND attname = 'content'`,
      );
      return rows[0]?.attstorage;
    });
    // 'e' is EXTERNAL: out of line, no compression attempt. 'x' would be EXTENDED, which
    // spends CPU on every write and read trying to compress a PNG.
    expect(storage).toBe("e");
  });

  it("answers has() without reading the bytes, and false when there are none", async () => {
    const answers = await inTenant(async (tx) => {
      const content = jpeg("x");
      const id = await declare(tx, TENANT, claimId, content);
      const before = await store.has(tx, TENANT, id);
      await store.put(tx, TENANT, id, content);
      return { before, after: await store.has(tx, TENANT, id), missing: await store.has(tx, TENANT, randomUUID()) };
    });
    expect(answers).toEqual({ before: false, after: true, missing: false });
  });

  it("returns null for an attachment it holds no bytes for", async () => {
    const got = await inTenant(async (tx) => store.get(tx, TENANT, randomUUID()));
    expect(got).toBeNull();
  });

  it("is idempotent: a second put of the same bytes is a no-op", async () => {
    const content = jpeg("retried");
    const { rows, got } = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      await store.put(tx, TENANT, id, content);
      await store.put(tx, TENANT, id, content);
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.attachment_blob WHERE attachment_id = $1",
        [id],
      );
      return { rows: Number(rows[0]!.n), got: await store.get(tx, TENANT, id) };
    });
    expect(rows).toBe(1);
    expect(got?.equals(content)).toBe(true);
  });

  /**
   * The one idempotency that must NOT be an upsert — and the refusal arrives from further
   * up than `ON CONFLICT` does.
   *
   * `ON CONFLICT DO NOTHING` rather than `DO UPDATE` is deliberate: the content hash is a
   * commitment, so a second put must never replace what the commitment refers to. In
   * practice the conflict clause never gets a chance for mismatched bytes, because a
   * BEFORE INSERT trigger runs ahead of the conflict check — so `attachment_blob_verify`
   * compares the new bytes against the metadata row and refuses them outright. Worth
   * pinning both halves: the refusal, AND that the stored bytes are still the first ones
   * afterwards, which is what would matter if the trigger were ever relaxed.
   */
  it("refuses a second put with different bytes, and keeps the first ones", async () => {
    const first = jpeg("the real receipt");
    const got = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, first);
      await store.put(tx, TENANT, id, first);
      await tx.query("SAVEPOINT substitute");
      await expect(store.put(tx, TENANT, id, jpeg("a substitute"))).rejects.toThrow(
        /declares \d+ bytes and these are|declares sha256/,
      );
      await tx.query("ROLLBACK TO SAVEPOINT substitute");
      return store.get(tx, TENANT, id);
    });
    expect(got?.equals(first)).toBe(true);
  });

  it("refuses a second put of the same LENGTH but different bytes, by digest", async () => {
    // The length check alone would admit this, which is why the digest is checked too.
    const first = jpeg("aaaaaaa");
    const swap = jpeg("bbbbbbb");
    expect(swap.length).toBe(first.length);
    await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, first);
      await store.put(tx, TENANT, id, first);
      await tx.query("SAVEPOINT same_length");
      await expect(store.put(tx, TENANT, id, swap)).rejects.toThrow(/declares sha256/);
      await tx.query("ROLLBACK TO SAVEPOINT same_length");
    });
  });

  it("refuses bytes for an attachment that does not exist", async () => {
    await inTenant(async (tx) => {
      await tx.query("SAVEPOINT orphan");
      await expect(store.put(tx, TENANT, randomUUID(), jpeg("orphan"))).rejects.toThrow(
        /to store bytes for|violates foreign key constraint/,
      );
      await tx.query("ROLLBACK TO SAVEPOINT orphan");
    });
  });

  // -------------------------------------------------------------------------
  // Isolation, proved positively and as the table's owner.
  // -------------------------------------------------------------------------

  it("does not serve one tenant's bytes to another, even though crm_app owns the table", async () => {
    const content = jpeg("tenant one's receipt");
    const id = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return id;
    });

    const reached = await inOtherTenant(async (tx) => ({
      viaStore: await store.get(tx, OTHER_TENANT, id),
      // And asking for it under the OWNING tenant's id from the other tenant's context,
      // which is what a route with a mixed-up tenant parameter would do: the policy
      // answers, not the predicate.
      viaWrongTenantArgument: await store.get(tx, TENANT, id),
      has: await store.has(tx, OTHER_TENANT, id),
      raw: await tx.query("SELECT content FROM crm.attachment_blob"),
    }));

    expect(reached.viaStore).toBeNull();
    expect(reached.viaWrongTenantArgument).toBeNull();
    expect(reached.has).toBe(false);
    expect(reached.raw.rowCount).toBe(0);

    // The row is genuinely there for its own tenant, so the four assertions above are
    // about isolation and not about an empty table.
    const own = await inTenant(async (tx) => store.get(tx, TENANT, id));
    expect(own?.equals(content)).toBe(true);
  });

  it("keeps two tenants' blobs for the same-shaped content apart", async () => {
    const content = jpeg("identical bytes");
    const mine = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return id;
    });
    const theirs = await inOtherTenant(async (tx) => {
      const id = await declare(tx, OTHER_TENANT, otherClaimId, content);
      await store.put(tx, OTHER_TENANT, id, content);
      return id;
    });
    expect(mine).not.toBe(theirs);

    const counts = await Promise.all([
      inTenant(async (tx) => (await tx.query("SELECT 1 FROM crm.attachment_blob")).rowCount),
      inOtherTenant(async (tx) => (await tx.query("SELECT 1 FROM crm.attachment_blob")).rowCount),
    ]);
    expect(counts).toEqual([1, 1]);
  });

  it("refuses to write a blob row into another tenant", async () => {
    await expect(
      inTenant(async (tx) => {
        const content = jpeg("smuggled");
        const id = await declare(tx, TENANT, claimId, content);
        await store.put(tx, OTHER_TENANT, id, content);
      }),
    ).rejects.toThrow(/row-level security|belongs to another tenant/);
  });

  it("sees nothing at all without a tenant context, rather than everything", async () => {
    const content = jpeg("needs context");
    const id = await inTenant(async (tx) => {
      const id = await declare(tx, TENANT, claimId, content);
      await store.put(tx, TENANT, id, content);
      return id;
    });
    // A query outside `withTenantContext` leaves `app.current_tenant_id` unset, so the
    // policy predicate is NULL and the answer is no rows. This is the third fail-closed
    // layer `tenant-context.ts` describes, asserted on this table rather than assumed.
    const { rowCount } = await client.query("SELECT 1 FROM crm.attachment_blob WHERE attachment_id = $1", [id]);
    expect(rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The property an S3 store could not offer. Asserted, and labelled.
  // -------------------------------------------------------------------------

  /**
   * `put` writes inside the CALLER'S transaction.
   *
   * This is the whole reason the interface takes one, and it is the property 0033's header
   * names as the cost of the seam: an object store's write would land before the row and
   * an aborted transaction would leave it orphaned, so moving to S3 means a sweeper for
   * unreferenced objects rather than a drop-in swap. Pinned here so that cost is a failing
   * test for whoever makes the swap, not a surprise.
   */
  it("writes transactionally, so a rollback leaves no bytes behind", async () => {
    const content = jpeg("rolled back");
    let id = "";
    await expect(
      inTenant(async (tx) => {
        id = await declare(tx, TENANT, claimId, content);
        await store.put(tx, TENANT, id, content);
        expect(await store.has(tx, TENANT, id)).toBe(true);
        throw new Error("the rest of the request failed");
      }),
    ).rejects.toThrow("the rest of the request failed");

    const after = await inTenant(async (tx) => store.has(tx, TENANT, id));
    expect(after).toBe(false);
  });

  it("is stateless, so one instance serves every tenant and every transaction", async () => {
    // It holds no client and no connection of its own: the API and the scheduler share one.
    expect(Object.keys(store)).toEqual(["backend"]);
    const content = jpeg("shared instance");
    const results = await inTenant(async (tx) => {
      const ids = [await declare(tx, TENANT, claimId, content)];
      await store.put(tx, TENANT, ids[0]!, content);
      return store.get(tx, TENANT, ids[0]!);
    });
    expect(results?.equals(content)).toBe(true);
  });
});
