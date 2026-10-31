import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { appPool, TENANT_STORAGE_BACKEND as TENANT } from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import { assembleTombstone, TombstoneInvalidError } from "./tombstone.js";
import { describeRefusal, planTenantErasureWithin } from "./plan.js";

/**
 * The bytes that are not a table (migration 0074).
 *
 * ADR-0001 carried a row saying the erasure receipt is complete about 41 TABLES and would be
 * silent about an object store the moment one existed, because `crm.undeclared_tenant_tables()`
 * enumerates `pg_catalog` and a bucket is not a table. This asserts the guard that refuses
 * rather than the attestation nothing can yet write.
 *
 * AS `crm_app`, NOT THE ADMIN, and that is load-bearing twice over. The derivation counts rows
 * in `crm.attachment` under FORCE row-level security, so the only honest way to assert it
 * answers correctly is to ask it the way the application does; and the function's refusal when
 * the tenant context is missing is a property of a confined caller, which a superuser could
 * not demonstrate at all.
 *
 * EVERY PROBE ROLLS BACK. The registry is platform-wide with a primary key on `backend`, so a
 * probe row that escaped would not merely pollute data — it would make the NEXT suite's plan
 * refuse for a reason nobody wrote. The last test asserts the registry is one seeded row again,
 * which is the only way to know the rollbacks happened rather than to hope they did.
 */
describe("the storage backends a receipt cannot speak for (0074)", () => {
  let pool: Pool;
  let client: PoolClient;

  /** A subsystem backend, registered only inside a transaction that rolls back. */
  const PROBE = "objstore_probe";
  /** The rep every probe attachment is attributed to: `uploaded_by` is a real reference. */
  let repId = "";

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, 'Storage backend guard (0074)')
         ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANT],
    );
    // One rep, committed, because `crm.attachment.uploaded_by` references `crm.rep_profile`
    // and a probe cannot invent an uploader. Inside the tenant's context, since the table is
    // under FORCE row-level security and `crm_app` is confined by it like anybody else.
    repId = await withTenantContext(client, TENANT, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name, erp_employee_id)
         VALUES ($1, 'storage-backend-0074', 'E-0074', 'Storage backend probe', 'erp-0074')
             ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [TENANT],
      );
      return rows[0]?.id ?? "";
    });
    expect(repId, "the probe needs a rep to attribute an upload to").not.toBe("");
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  /**
   * Inserts one attachment naming a backend, with the table's own triggers off.
   *
   * `crm.attachment` validates that its subject row exists and is append-only, and neither is
   * what this file is about: the derivation reads `storage_backend`, and a probe that had to
   * build a visit, a rep and an expense claim first would be a test of those. The pattern is
   * `composite-fk.contract.test.ts`'s, for its reason — a probe should exercise the one rule
   * it names and nothing else.
   */
  const plantAttachment = async (backend: string): Promise<void> => {
    // NO RE-ENABLE, and NOT because it would be tidy to skip: `crm.attachment` carries a
    // DEFERRABLE INITIALLY DEFERRED self-reference, so an INSERT leaves the transaction with
    // pending trigger events and `ALTER TABLE … ENABLE TRIGGER` is refused outright ("cannot
    // ALTER TABLE because it has pending trigger events"). `DISABLE TRIGGER` is transactional,
    // so the ROLLBACK every probe ends with is what restores them — and the last test in this
    // file asserts that from `pg_trigger` instead of trusting it.
    //
    // A SAVEPOINT, because the first version without one swallowed the very refusal it was
    // written to assert: the re-enable ran inside an aborted transaction, raised 25P02, and
    // replaced the 23503 on its way out.
    await client.query("SAVEPOINT plant");
    await client.query("ALTER TABLE crm.attachment DISABLE TRIGGER USER");
    try {
      await client.query(
        // `seq` is GENERATED ALWAYS and refuses a supplied value (428C9) — which the first
        // version of this probe discovered by having its 23503 replaced by one.
        `INSERT INTO crm.attachment
           (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
            content_sha256, storage_backend, uploaded_by)
         VALUES (gen_random_uuid(), $1, 'expense_receipt', 'crm.expense_claim', gen_random_uuid(),
                 'image/png', 1024, repeat('a', 64), $2, $3)`,
        [TENANT, backend, repId],
      );
      await client.query("RELEASE SAVEPOINT plant");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT plant");
      throw err;
    }
  };

  /** Runs one statement expecting it to be refused, without taking the transaction with it. */
  const refused = async (sql: string): Promise<{ code?: string; constraint?: string; message?: string }> => {
    await client.query("SAVEPOINT probe");
    const err = await client
      .query(sql)
      .then(() => null, (e: unknown) => e as { code?: string; constraint?: string; message?: string });
    await client.query("ROLLBACK TO SAVEPOINT probe");
    if (err === null) throw new Error(`expected a refusal, but the statement succeeded: ${sql.slice(0, 80)}`);
    return err;
  };

  it("found the registry, or every assertion below is vacuous", async () => {
    const { rows } = await client.query<{
      backend: string;
      erasure_covered_by_table: string | null;
      subsystem: string | null;
    }>(
      `SELECT backend, erasure_covered_by_table, subsystem
         FROM crm.attachment_storage_backend ORDER BY backend`,
    );
    expect(rows).toEqual([
      { backend: "postgres", erasure_covered_by_table: "attachment_blob", subsystem: null },
    ]);
  });

  /**
   * The one column in `crm` that names a storage backend, derived from the catalog.
   *
   * The derivation reads `crm.attachment.storage_backend` and nothing else, so a future table
   * that stored objects under a column of its own would be outside the guard entirely — the
   * same shape of hole 0051 closed for the register and 0066 for the ERP references. Asserted
   * from `pg_attribute` rather than remembered, so the migration that adds the second one
   * fails here on the day it is written.
   */
  it("is the only column in crm that names a storage backend", async () => {
    const { rows } = await client.query<{ col: string }>(
      `SELECT c.relname || '.' || a.attname AS col
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'crm' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname LIKE '%backend%'
        ORDER BY col`,
    );
    expect(
      rows.map((r) => r.col),
      "a second backend-naming column is a store the gap derivation cannot see; declare it in " +
        "crm.uncovered_storage_backends or explain here why it holds no bytes",
    ).toEqual([
      "attachment.storage_backend",
      // The registry's own primary key, which is the thing being referenced rather than a
      // pointer into it. Listed rather than filtered out by name, so the day somebody adds
      // a second column here it has to be argued for too.
      "attachment_storage_backend.backend",
    ]);
  });

  it("refuses a backend that is neither covered by a table nor a subsystem, and one that is both", async () => {
    await client.query("BEGIN");
    try {
      const neither = await refused(
        `INSERT INTO crm.attachment_storage_backend (backend, note, declared_by)
         VALUES ('probe_neither', 'a backend declared with no answer at all, which is the gap', 'test')`,
      );
      expect(neither.constraint).toBe("attachment_storage_backend_covered_xor_subsystem");

      const both = await refused(
        `INSERT INTO crm.attachment_storage_backend
           (backend, erasure_covered_by_table, subsystem, note, declared_by)
         VALUES ('probe_both', 'attachment_blob', 'object_storage',
                 'two different things cannot both have destroyed the same bytes', 'test')`,
      );
      expect(both.constraint).toBe("attachment_storage_backend_covered_xor_subsystem");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("refuses a covering table that does not exist, and one no tenant owns rows in", async () => {
    await client.query("BEGIN");
    try {
      const missing = await refused(
        `INSERT INTO crm.attachment_storage_backend (backend, erasure_covered_by_table, note, declared_by)
         VALUES ('probe_missing', 'no_such_table', 'a declaration that governs nothing at all', 'test')`,
      );
      expect(missing.message).toMatch(/storage-backend-unknown-table/);

      // `crm.data_disposition` is real, and it is the register itself: one row per
      // tenant-scoped TABLE, platform-wide, with no `tenant_id`. So erasing a tenant erases
      // nothing in it and it cannot cover anybody's bytes. (`crm.tenant` would NOT do here,
      // which the first draft got wrong: the tenant registry is keyed BY `tenant_id`, so it
      // passes the trigger's column check while being just as unerasable.)
      const platform = await refused(
        `INSERT INTO crm.attachment_storage_backend (backend, erasure_covered_by_table, note, declared_by)
         VALUES ('probe_platform', 'data_disposition', 'a platform table cannot be erased per tenant', 'test')`,
      );
      expect(platform.message).toMatch(/storage-backend-not-tenant-scoped/);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * The column stopped being a list, so an unregistered backend cannot be written.
   *
   * 0033's `CHECK (storage_backend IN ('postgres'))` was a one-word edit away from admitting a
   * store nobody had accounted for. A reference makes the edit an INSERT into a table whose
   * CHECK demands the answer to "and who destroys its bytes" — and the refusal below is
   * ENFORCEMENT, which is not confined by row security, unlike the bulk validation the
   * migration's own comment records as vacuous here.
   */
  it("refuses an attachment naming a backend nobody registered", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      const refusal = await plantAttachment("s3_unregistered").then(
        () => null,
        (e: unknown) => e as { code?: string; constraint?: string },
      );
      expect(refusal?.code).toBe("23503");
      expect(refusal?.constraint).toBe("attachment_storage_backend_fkey");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * "I could not look" must not read like "there is nothing there" — 0066's `unverifiable`,
   * 0067's `self_test_failed` and 0073's refusal, in a fourth place.
   *
   * Every row the derivation counts is under FORCE row-level security, so a caller without the
   * context reads zero and would be told nothing is uncovered. That is not an error; it is a
   * signed receipt that is silent about the bytes, which is why the function raises instead.
   */
  it("refuses to answer without the tenant's own context, rather than answering zero", async () => {
    const unset = await client
      .query("SELECT * FROM crm.uncovered_storage_backends($1)", [TENANT])
      .then(() => null, (e: unknown) => e as { message?: string; code?: string });
    expect(unset?.code).toBe("42501");
    expect(unset?.message).toMatch(/storage-backend-scan-unscoped/);

    // And asked about a DIFFERENT tenant from the one the context names, which is the subtler
    // version of the same mistake: the context is set, so nothing looks wrong, and every row
    // the count reaches belongs to somebody else.
    const wrong = await withTenantContext(client, TENANT, (tx) =>
      tx
        .query("SELECT * FROM crm.uncovered_storage_backends($1)", [
          "f4740000-0000-4000-8000-0000000000ff",
        ])
        .then(() => null, (e: unknown) => e as { message?: string }),
    );
    expect(wrong?.message).toMatch(/storage-backend-scan-unscoped/);
  });

  /**
   * The passing case, and it is a BEGIN rather than `withTenantContext` on purpose: that
   * wrapper COMMITS, and a probe attachment that committed would make this file's own
   * nothing-left-behind assertion false and the next suite's counts wrong. The context is set
   * with `set_config(..., true)` instead, which is the same local GUC the wrapper sets.
   */
  it("reports nothing uncovered for a tenant whose bytes are all in Postgres", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      await plantAttachment("postgres");
      const { rows } = await client.query("SELECT * FROM crm.uncovered_storage_backends($1)", [
        TENANT,
      ]);
      expect(rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * The gap, with a subsystem backend that exists only inside this transaction.
   *
   * This is what the row this guard closes was about: a bucket holding a signature, named by an
   * attachment row, with nothing in Postgres that destroys it.
   */
  it("reports a subsystem backend this tenant's own rows name, and refuses the plan", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO crm.attachment_storage_backend (backend, subsystem, note, declared_by)
         VALUES ($1, 'object_storage',
                 'a probe: objects in a bucket, named by an attachment row, destroyed by nothing in Postgres',
                 'storage-backend.contract.test.ts')`,
        [PROBE],
      );
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      await plantAttachment(PROBE);

      const { rows } = await client.query<{
        backend: string;
        reason: string;
        subsystem: string | null;
        objects: string;
      }>("SELECT backend, reason, subsystem, objects FROM crm.uncovered_storage_backends($1)", [
        TENANT,
      ]);
      expect(rows).toEqual([
        { backend: PROBE, reason: "no_covering_table", subsystem: "object_storage", objects: "1" },
      ]);

      // THE PLAN REFUSES, which is where an operator is told — before anything is deleted.
      const plan = await planTenantErasureWithin(client, TENANT);
      expect(plan.actionable).toBe(false);
      const refusal = plan.refusals.find((r) => r.kind === "uncovered_storage_backend");
      expect(refusal, `refusals were ${plan.refusals.map((r) => r.kind).join(", ")}`).toBeDefined();
      expect(plan.uncoveredBackends.map((b) => b.backend)).toEqual([PROBE]);
      const sentence = refusal === undefined ? "" : describeRefusal(refusal);
      expect(sentence).toMatch(/objstore_probe holds 1 of this tenant's attachment/);
      expect(sentence).toMatch(/object_storage it belongs to owes an attestation of its own/);
      expect(sentence).toMatch(/a bucket is not a table/);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * A COVERED backend whose coverer cannot attest is uncovered, and nothing else would notice.
   *
   * 0054 excludes a receipt store from every receipt's scope, because the transaction that
   * signs an attestation about it is the one that writes its rows. So the day somebody marks
   * `crm.attachment_blob` a receipt store, `postgres` stops being covered — the bytes are still
   * destroyed, but no attestation in the receipt says so. That is a one-column change with no
   * visible consequence anywhere else, which is exactly the kind this reason exists for.
   */
  it("reports a backend whose covering table has left the receipt's scope", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
      await plantAttachment("postgres");
      await client.query(
        `UPDATE crm.data_disposition
            SET disposition = 'retain', obligation = 'deletion_evidence',
                obligation_note = 'a probe, rolled back: pretending the blob table is a receipt store',
                retained_reference = 'crm.attachment_blob', decided_by = 'test',
                decided_at = now(), question = NULL, is_receipt_store = true
          WHERE table_name = 'attachment_blob'`,
      );

      const { rows } = await client.query<{ backend: string; reason: string }>(
        "SELECT backend, reason FROM crm.uncovered_storage_backends($1)",
        [TENANT],
      );
      expect(rows).toEqual([{ backend: "postgres", reason: "covering_table_not_in_scope" }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * And the SIGNING guard, which is the plan's refusal a second time on purpose.
   *
   * The plan refuses before anything is deleted, where an operator wants to be told; this
   * refuses before anything is signed, where a future second caller gets told. Pure, so it is
   * asserted here without a database.
   */
  it("refuses to assemble a receipt while a backend is uncovered", () => {
    const attempt = (): unknown =>
      assembleTombstone({
        tenantId: TENANT,
        erpTombstoneId: "tomb_0074",
        deletedAt: "2026-10-31T12:00:00.000Z",
        executedBy: "ops:alice",
        approvedBy: "compliance:bob",
        inScope: ["only_table"],
        attestations: [{ table: "only_table", outcome: "erased", rowsErased: 3 }],
        uncoveredBackends: [
          {
            backend: PROBE,
            reason: "no_covering_table",
            subsystem: "object_storage",
            objects: 2,
            note: "a probe: objects in a bucket that no table destroys",
          },
        ],
      });
    expect(attempt).toThrow(TombstoneInvalidError);
    expect(attempt).toThrow(/1 storage backend\(s\) hold this tenant's attachment bytes/);
    expect(attempt).toThrow(/silent about the most sensitive data in the system/);
  });

  /**
   * The probes left nothing behind, asserted rather than hoped.
   *
   * The registry is platform-wide with a primary key, so an escaped probe row would make the
   * next suite's plan refuse with a sentence about a bucket that does not exist. Checked last,
   * because the point is the state after every transaction above has ended.
   */
  it("left the registry as one seeded row and this tenant with no attachments", async () => {
    const { rows: registry } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM crm.attachment_storage_backend",
    );
    expect(registry[0]?.n).toBe("1");

    const mine = await withTenantContext(client, TENANT, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM crm.attachment WHERE tenant_id = $1",
        [TENANT],
      );
      return rows[0]?.n;
    });
    expect(mine).toBe("0");

    const { rows: disposition } = await client.query<{ is_receipt_store: boolean }>(
      "SELECT is_receipt_store FROM crm.data_disposition WHERE table_name = 'attachment_blob'",
    );
    expect(disposition[0]?.is_receipt_store).toBe(false);

    // AND THE TRIGGERS ARE BACK ON. The probes above turn them off and never turn them on
    // again — a rollback is what restores them, and this is the assertion that it did. Left
    // off, `crm.attachment` would stop validating its subject and stop being append-only for
    // every suite that runs after this one, which is a failure nobody would trace back here.
    const { rows: triggers } = await client.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'crm.attachment'::regclass AND NOT tgisinternal
          AND tgenabled <> 'O' ORDER BY tgname`,
    );
    expect(triggers, "a probe left crm.attachment's own triggers disabled").toEqual([]);
  });
});
