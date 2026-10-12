import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_RECEIPT_VERIFY as TENANT,
  TENANT_RECEIPT_VERIFY_OTHER as OTHER,
  appPool,
  withRegistryTriggersOff,
} from "@crm/db/testing";
import { withTenantContext } from "@crm/db";

import {
  FAILURE_SAMPLE_LIMIT,
  SELF_TEST_ATTESTATIONS,
  SELF_TEST_EXCLUSIONS,
  SELF_TEST_VECTORS,
  decideReceiptVerdict,
  latestReceiptVerification,
  runSelfTest,
  sweepReceipts,
  verifyStoredReceipts,
  type SelfTestResult,
  type VersionCohort,
} from "./verify-receipts.js";
import {
  CURRENT_MANIFEST_VERSION,
  MANIFEST_VERSIONS,
  computeContentManifestSha256,
  computeProofSha256,
  type ManifestVersion,
  type TableAttestation,
} from "./tombstone.js";

/**
 * Migration 0067 — re-verifying the erasure receipts, and telling our own bug from a rewrite.
 *
 * ADR-0001 recorded the blocker rather than guessing at it: "a receipt that no longer recomputes
 * is either a bug in our own canonicalisation or evidence that somebody with database access
 * rewrote a deletion record, and those want very different responses… a job that cried wolf about
 * its own hashing bug would be worse than no job."
 *
 * The answer is a KNOWN-ANSWER SELF-TEST plus a cohort, and this suite is mostly about the
 * boundaries between the four verdicts it produces — which is why `decideReceiptVerdict` is pure
 * and enumerated here exhaustively, and why the database half is about the two things only a
 * database can show: that a receipt really does stop verifying when somebody rewrites it, and
 * that the sweep can read receipts belonging to tenants that no longer exist.
 *
 * `appPool()`, not `testPool()`: the sweep opens its OWN connections from the pool it is handed,
 * and those inherit the pool's role — the admin pool would run every read as a superuser, which
 * bypasses row-level security even under FORCE, so a missing tenant predicate would be invisible
 * to this whole suite.
 */
describe("re-verifying the erasure receipts (0067)", () => {
  let pool: Pool;
  let client: PoolClient;

  const ERP_TOMB_A = "tomb_00000000000000000000000000000671";
  const ERP_TOMB_B = "tomb_00000000000000000000000000000672";
  const SHA = "b".repeat(64);

  const ATTESTATIONS: readonly TableAttestation[] = [
    { table: "visit", outcome: "erased", rowsErased: 4 },
    { table: "rep_profile", outcome: "erased", rowsErased: 1 },
    { table: "product_snapshot", outcome: "nothing_to_erase" },
  ];

  const register = (tenantId: string, name: string): Promise<unknown> =>
    client.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, name],
    );

  /**
   * `erp_deleted`, which is the only status a receipt may be written under (0052).
   *
   * IDEMPOTENT BY PREDICATE, not by catching a refusal: 0053 makes the status terminal and
   * refuses to rewrite a stopped tenant's receipt, with a sentence about the evidence. That is
   * the guarantee rather than an obstacle, so the `beforeEach` that calls this on every test has
   * to not ask twice — `AND status <> 'erp_deleted'` is how, and it leaves the trigger live for
   * the thing it is there to refuse.
   */
  const stop = (tenantId: string, erpTombstoneId: string): Promise<unknown> =>
    client.query(
      `UPDATE crm.tenant
          SET status = 'erp_deleted', erp_tombstone_id = $2, erp_tombstone_kind = 'tenant_deletion',
              erp_tombstone_deleted_at = now(), erp_tombstone_proof_sha256 = $3,
              erp_tombstone_observed_at = now()
        WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
      [tenantId, erpTombstoneId, SHA],
    );

  /**
   * A receipt whose hashes are genuinely correct, written the way 0052 writes one.
   *
   * The hashes are computed by the same functions the verifier uses, which would be circular if
   * the suite were testing the hashing — it is not. It is testing the SWEEP, and what it needs is
   * a receipt that verifies, so that a later one that does not is a difference the sweep found
   * rather than a fixture that was always broken.
   */
  const writeReceipt = async (
    tenantId: string,
    receiptId: string,
    erpTombstoneId: string,
    version: ManifestVersion = CURRENT_MANIFEST_VERSION,
  ): Promise<void> => {
    const deletedAt = "2026-06-01T00:00:00.000Z";
    const manifest = computeContentManifestSha256(ATTESTATIONS, [], version);
    const proof = computeProofSha256({
      tenantId,
      erpTombstoneId,
      deletedAt,
      contentManifestSha256: manifest,
      executedBy: "ops:alice",
      approvedBy: "compliance:bob",
    });
    await withTenantContext(client, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO crm.tenant_tombstone
           (id, tenant_id, erp_tombstone_id, deleted_at, content_manifest_sha256, proof_sha256,
            executed_by, approved_by, rows_erased, rows_retained, excluded_tables, manifest_version)
         VALUES ($1,$2,$3,$4,$5,$6,'ops:alice','compliance:bob',5,0,'{}'::text[],$7)`,
        [receiptId, tenantId, erpTombstoneId, deletedAt, manifest, proof, version],
      );
      for (const a of ATTESTATIONS) {
        await tx.query(
          `INSERT INTO crm.tenant_tombstone_attestation
             (tenant_id, tombstone_id, table_name, outcome, rows_erased, rows_retained)
           VALUES ($1,$2,$3,$4,$5,NULL)`,
          [tenantId, receiptId, a.table, a.outcome, a.rowsErased ?? null],
        );
      }
    });
  };

  /**
   * Somebody with database access rewrites a receipt.
   *
   * THE TRIGGERS COME OFF EXPLICITLY, and that is the honest shape rather than a workaround: 0052
   * makes both tables append-only so the application role cannot do this, and the threat this
   * whole job exists for is somebody who is not the application role. A fixture that could rewrite
   * a row through the normal path would be proving the append-only rule broken.
   */
  const rewrite = (tenantId: string, receiptId: string, sql: string): Promise<unknown> =>
    withTenantContext(client, tenantId, async (tx) => {
      await tx.query("ALTER TABLE crm.tenant_tombstone DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.tenant_tombstone_attestation DISABLE TRIGGER USER");
      try {
        await tx.query(sql, [tenantId, receiptId]);
      } finally {
        await tx.query("ALTER TABLE crm.tenant_tombstone ENABLE TRIGGER USER");
        await tx.query("ALTER TABLE crm.tenant_tombstone_attestation ENABLE TRIGGER USER");
      }
    });

  /** Only this suite's own receipts, because the sweep is platform-wide. */
  const mine = (result: { readonly failures: readonly { readonly tenantId: string }[] }): readonly unknown[] =>
    result.failures.filter((f) => f.tenantId === TENANT || f.tenantId === OTHER);

  const wipe = async (): Promise<void> => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        for (const t of ["tenant_tombstone_attestation", "tenant_tombstone"]) {
          await tx.query(`ALTER TABLE crm.${t} DISABLE TRIGGER USER`);
        }
        try {
          await tx.query("DELETE FROM crm.tenant_tombstone_attestation WHERE tenant_id = $1", [tenant]);
          await tx.query("DELETE FROM crm.tenant_tombstone WHERE tenant_id = $1", [tenant]);
        } finally {
          for (const t of ["tenant_tombstone_attestation", "tenant_tombstone"]) {
            await tx.query(`ALTER TABLE crm.${t} ENABLE TRIGGER USER`);
          }
        }
      });
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    await wipe();
    await client.query("DELETE FROM crm.receipt_verification_run");
    // 0053 refuses to delete a stopped tenant's registry row, which is the guarantee rather than
    // an obstacle — so a fixture handing back the tenants it borrowed says so.
    await withRegistryTriggersOff(client, async () => {
      for (const tenant of [TENANT, OTHER]) {
        await client.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [tenant]);
      }
    });
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await wipe();
    await client.query("DELETE FROM crm.receipt_verification_run");
    await register(TENANT, "An Erased Tenant");
    await register(OTHER, "Another Erased Tenant");
    await stop(TENANT, ERP_TOMB_A);
    await stop(OTHER, ERP_TOMB_B);
  });

  describe("the known-answer self-test, which is the whole decision", () => {
    it("reproduces every format version's vector", () => {
      // THE ASSERTION THE REST OF THE FILE RESTS ON. If this build cannot reproduce the committed
      // digests, no verdict it reaches about a stored receipt means anything — which is exactly
      // what `self_test_failed` says, and why it is checked before a single row is read.
      expect(runSelfTest()).toEqual(
        Object.fromEntries(MANIFEST_VERSIONS.map((v) => [v, "ok"])),
      );
    });

    it("covers every declared version, so a new format cannot ship without a vector", () => {
      // A vector list that lagged `MANIFEST_VERSIONS` would make the self-test pass while saying
      // nothing about the format the receipts are actually written under.
      expect(Object.keys(SELF_TEST_VECTORS).sort()).toEqual([...MANIFEST_VERSIONS].sort());
    });

    it("pins v1 and v2 apart, which is the difference 0054 introduced", () => {
      // v1 hashed the attestations alone; v2 appends the exclusion list. One vector with two
      // expected digests is what keeps a v1 receipt verifiable forever — and if the two were
      // equal, the version field would be decoration.
      expect(SELF_TEST_VECTORS["v1"]).not.toBe(SELF_TEST_VECTORS["v2"]);
      expect(computeContentManifestSha256(SELF_TEST_ATTESTATIONS, SELF_TEST_EXCLUSIONS, "v1")).toBe(
        SELF_TEST_VECTORS["v1"],
      );
      expect(computeContentManifestSha256(SELF_TEST_ATTESTATIONS, SELF_TEST_EXCLUSIONS, "v2")).toBe(
        SELF_TEST_VECTORS["v2"],
      );
    });

    it("exercises all three outcomes and an unsorted input", () => {
      // The canonical line differs per outcome — `erased` carries a count, `nothing_to_erase`
      // carries no figures, `retained` carries an obligation, a note and a reference — so a
      // vector of one `erased` row would go on passing after a change that broke the other two.
      expect(new Set(SELF_TEST_ATTESTATIONS.map((a) => a.outcome))).toEqual(
        new Set(["erased", "nothing_to_erase", "retained"]),
      );
      // And the input is deliberately out of order, so a removed sort cannot pass.
      const tables = SELF_TEST_ATTESTATIONS.map((a) => a.table);
      expect(tables).not.toEqual([...tables].sort());
      expect(SELF_TEST_EXCLUSIONS).not.toEqual([...SELF_TEST_EXCLUSIONS].sort());
    });
  });

  describe("the verdict table, enumerated", () => {
    const allOk: SelfTestResult = Object.fromEntries(MANIFEST_VERSIONS.map((v) => [v, "ok"]));
    const cohort = (checked: number, failed: number): VersionCohort => ({ checked, failed });

    it("verified when nothing failed", () => {
      expect(decideReceiptVerdict(allOk, { v2: cohort(40, 0) })).toBe("verified");
      // Including the vacuous case, which is the honest answer on a deployment that has never
      // erased a tenant: there is nothing to verify and nothing is wrong.
      expect(decideReceiptVerdict(allOk, {})).toBe("verified");
    });

    it("self_test_failed FIRST, whatever the receipts say", () => {
      // The arm the open row was worried about. A build that cannot hash correctly has no
      // standing to call anything tampered, so this outranks every cohort shape — including the
      // one that would otherwise read as tampering.
      for (const bad of ["mismatch", "threw"] as const) {
        expect(decideReceiptVerdict({ ...allOk, v2: bad }, { v2: cohort(40, 1) })).toBe(
          "self_test_failed",
        );
        expect(decideReceiptVerdict({ ...allOk, v2: bad }, { v2: cohort(40, 40) })).toBe(
          "self_test_failed",
        );
        expect(decideReceiptVerdict({ ...allOk, v2: bad }, {})).toBe("self_test_failed");
      }
    });

    it("unreproducible when EVERY receipt of a version failed", () => {
      // A format change shipped under an existing version number: our bug, and not a crime.
      expect(decideReceiptVerdict(allOk, { v2: cohort(40, 40) })).toBe("unreproducible");
      // And per version, which is the case that actually happens: v1 receipts were written years
      // ago and v2 are current, so a broken v1 canonicaliser must not implicate v2.
      expect(decideReceiptVerdict(allOk, { v1: cohort(3, 3), v2: cohort(40, 0) })).toBe(
        "unreproducible",
      );
    });

    it("tampered when some failed and their siblings passed", () => {
      // The shape no canonicalisation bug can produce, because a bug does not pick rows.
      expect(decideReceiptVerdict(allOk, { v2: cohort(40, 1) })).toBe("tampered");
      expect(decideReceiptVerdict(allOk, { v2: cohort(2, 1) })).toBe("tampered");
      // A whole version failing AND another version partially failing is tampering, because the
      // partial one cannot be explained by a format change.
      expect(decideReceiptVerdict(allOk, { v1: cohort(3, 3), v2: cohort(40, 2) })).toBe("tampered");
    });

    it("calls a single receipt failing alone unreproducible, not tampered", () => {
      // THE ONE BOUNDARY THAT IS GENUINELY ARGUABLE, and it is decided towards our own bug: with
      // one receipt of a version there is no sibling to compare against, so "all of them failed"
      // and "one of them failed" are the same observation. Accusing somebody of rewriting a
      // record on that evidence would be exactly the wolf-crying the open row refused.
      expect(decideReceiptVerdict(allOk, { v2: cohort(1, 1) })).toBe("unreproducible");
    });
  });

  describe("against the database", () => {
    it("verifies a receipt belonging to a tenant that no longer exists", async () => {
      // THE STRUCTURAL POINT. A receipt belongs to an ERASED tenant, and `activeTenants` is
      // `status = 'active'` — so no per-tenant job could ever reach this row, which is why 0067
      // adds platform work at all. Both tenants here are `erp_deleted`.
      await writeReceipt(TENANT, "crmtomb_00000000000000000000000000000671", ERP_TOMB_A);
      const result = await verifyStoredReceipts(pool);
      expect(result.verdict).toBe("verified");
      expect(result.receiptsChecked).toBeGreaterThanOrEqual(1);
      expect(mine(result)).toEqual([]);
      // And the tenant really is stopped, or the paragraph above is not what was tested.
      const { rows } = await client.query<{ status: string }>(
        "SELECT status FROM crm.tenant WHERE tenant_id = $1",
        [TENANT],
      );
      expect(rows[0]!.status).toBe("erp_deleted");
    });

    it("finds a rewritten receipt, and calls it tampered because its sibling passed", async () => {
      await writeReceipt(TENANT, "crmtomb_00000000000000000000000000000671", ERP_TOMB_A);
      await writeReceipt(OTHER, "crmtomb_00000000000000000000000000000672", ERP_TOMB_B);
      // Somebody edits the row count a receipt attests to — the plausible rewrite, because it is
      // the figure a deletion record is read for. The manifest no longer recomputes.
      await rewrite(
        TENANT,
        "crmtomb_00000000000000000000000000000671",
        `UPDATE crm.tenant_tombstone_attestation
            SET rows_erased = 999
          WHERE tenant_id = $1 AND tombstone_id = $2 AND table_name = 'visit'`,
      );

      const result = await verifyStoredReceipts(pool);
      expect(result.verdict).toBe("tampered");
      const failures = result.failures.filter((f) => f.tenantId === TENANT);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.receiptId).toBe("crmtomb_00000000000000000000000000000671");
      expect(failures[0]!.problems.join(" ")).toContain("content manifest hash");
      // The sibling is what makes the verdict `tampered` rather than `unreproducible`, and it is
      // asserted explicitly: it passed, under the same format, in the same sweep.
      expect(result.failures.some((f) => f.tenantId === OTHER)).toBe(false);
      const cohort = (result.byVersion as Record<string, VersionCohort>)[CURRENT_MANIFEST_VERSION];
      expect(cohort?.failed).toBeGreaterThanOrEqual(1);
      expect(cohort?.checked).toBeGreaterThan(cohort!.failed);
    });

    it("finds a rewritten PROOF, which an edited manifest hash alone would hide", async () => {
      // The subtler rewrite: change the manifest hash on the head so the manifest "verifies"
      // against the edited attestations. The proof commits to the manifest hash AND to who did it
      // for whom, so it stops recomputing — which is the reason 0052 hashes identity at all.
      await writeReceipt(TENANT, "crmtomb_00000000000000000000000000000671", ERP_TOMB_A);
      await writeReceipt(OTHER, "crmtomb_00000000000000000000000000000672", ERP_TOMB_B);
      await rewrite(
        TENANT,
        "crmtomb_00000000000000000000000000000671",
        `UPDATE crm.tenant_tombstone SET executed_by = 'ops:somebody-else'
          WHERE tenant_id = $1 AND id = $2`,
      );
      const result = await verifyStoredReceipts(pool);
      expect(result.verdict).toBe("tampered");
      expect(
        result.failures.find((f) => f.tenantId === TENANT)?.problems.join(" "),
      ).toContain("proof hash");
    });

    it("records the sweep, and the newest one is what a reader gets", async () => {
      await writeReceipt(TENANT, "crmtomb_00000000000000000000000000000671", ERP_TOMB_A);
      const first = await sweepReceipts(pool, new Date("2026-10-12T02:00:00.000Z"));
      expect(first.verdict).toBe("verified");

      await rewrite(
        TENANT,
        "crmtomb_00000000000000000000000000000671",
        `UPDATE crm.tenant_tombstone SET rows_erased = 99 WHERE tenant_id = $1 AND id = $2`,
      );
      await sweepReceipts(pool, new Date("2026-10-13T02:00:00.000Z"));

      const latest = await latestReceiptVerification(client);
      // `seq DESC`, not `ran_at`: two sweeps in one test share nothing but the ordering key that
      // actually works, which is 0066's and 0041's lesson before it.
      expect(latest?.verdict).not.toBe("verified");
      expect(Number(latest?.receipts_failed)).toBeGreaterThanOrEqual(1);
      // The cohort evidence is stored rather than derived, so a later reader can see what the
      // verdict rested on.
      expect(latest?.by_version).toBeTruthy();
      expect(latest?.self_test).toEqual(
        Object.fromEntries(MANIFEST_VERSIONS.map((v) => [v, "ok"])),
      );
      // And the history is kept: a sweep records, it does not replace.
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM crm.receipt_verification_run",
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });

    it("refuses to store a verdict that claims a count it did not take", async () => {
      // 0067's CHECK, asserted against the database because that is whose rule it is. A
      // `self_test_failed` row with a non-zero count would be a sweep claiming to have read
      // receipts with a build that could not hash them.
      const err = await client
        .query(
          `INSERT INTO crm.receipt_verification_run
             (verdict, receipts_checked, receipts_failed, tenants_checked)
           VALUES ('self_test_failed', 5, 0, 1)`,
        )
        .then(
          () => "ACCEPTED",
          (e: { constraint?: string }) => e.constraint ?? "",
        );
      expect(err).toBe("receipt_verification_self_test_reads_nothing");
    });

    it("refuses a verdict whose failure count disagrees with it", async () => {
      const attempt = (verdict: string, failed: number): Promise<string> =>
        client
          .query(
            `INSERT INTO crm.receipt_verification_run
               (verdict, receipts_checked, receipts_failed, tenants_checked)
             VALUES ($1, 10, $2, 1)`,
            [verdict, failed],
          )
          .then(
            () => "ACCEPTED",
            (e: { constraint?: string }) => e.constraint ?? "",
          );
      // Both directions, because a column that is sometimes meaningful is a column every reader
      // has to think about: `verified` with failures, and `tampered` with none.
      expect(await attempt("verified", 2)).toBe("receipt_verification_failures_pair_with_verdict");
      expect(await attempt("tampered", 0)).toBe("receipt_verification_failures_pair_with_verdict");
    });

    it("caps the failure sample rather than storing every problem", async () => {
      // An operator needs one receipt to go and look at. A sweep that stored every problem would
      // become the biggest thing in the database on the day a canonicaliser broke — which is the
      // day it would least be wanted.
      expect(FAILURE_SAMPLE_LIMIT).toBeLessThanOrEqual(20);
      for (let i = 0; i < FAILURE_SAMPLE_LIMIT + 3; i += 1) {
        const id = `crmtomb_006710000000000000000000000000${String(i).padStart(2, "0")}`;
        await writeReceipt(TENANT, id, ERP_TOMB_A);
        await rewrite(
          TENANT,
          id,
          `UPDATE crm.tenant_tombstone SET rows_erased = 77 WHERE tenant_id = $1 AND id = $2`,
        );
      }
      const result = await verifyStoredReceipts(pool);
      expect(result.receiptsFailed).toBeGreaterThanOrEqual(FAILURE_SAMPLE_LIMIT + 3);
      expect(result.failures).toHaveLength(FAILURE_SAMPLE_LIMIT);
    });

    it("says nothing is wrong on a deployment that has never erased a tenant", async () => {
      // No receipts anywhere. `verified` is the honest verdict — there is nothing to verify and
      // nothing is broken — and the counters say so rather than the word implying a check that
      // did not happen.
      const result = await verifyStoredReceipts(pool);
      expect(result.verdict).toBe("verified");
      expect(mine(result)).toEqual([]);
      expect(result.summary).toContain("verdict=verified");
      expect(result.tenantsChecked).toBeGreaterThanOrEqual(2);
    });
  });

  describe("the line an operator reads", () => {
    it("capitalises TAMPERED and puts it first", async () => {
      await writeReceipt(TENANT, "crmtomb_00000000000000000000000000000671", ERP_TOMB_A);
      await writeReceipt(OTHER, "crmtomb_00000000000000000000000000000672", ERP_TOMB_B);
      await rewrite(
        TENANT,
        "crmtomb_00000000000000000000000000000671",
        `UPDATE crm.tenant_tombstone SET rows_erased = 99 WHERE tenant_id = $1 AND id = $2`,
      );
      const result = await verifyStoredReceipts(pool);
      // It is the only line this process can emit that means somebody with database access
      // rewrote a record of a deletion, and it is the alerting channel: there is nobody to
      // notify, because the tenant it concerns no longer has any reps.
      expect(result.summary.startsWith("TAMPERED=")).toBe(true);
      expect(result.summary).toContain("verdict=tampered");
      expect(result.summary).toContain(`versions=${CURRENT_MANIFEST_VERSION}=`);
    });

    it("says plainly that a failed self-test read nothing", () => {
      // Not an inference from `receipts=0`, which a deployment with no receipts also shows. The
      // two states are indistinguishable by counters alone and want very different responses.
      const bad: SelfTestResult = { ...Object.fromEntries(MANIFEST_VERSIONS.map((v) => [v, "ok"])), v2: "mismatch" };
      expect(decideReceiptVerdict(bad, {})).toBe("self_test_failed");
    });
  });
});
