/**
 * Re-verifying the erasure receipts, on a timer, and telling a hashing bug from a rewritten row
 * (0067).
 *
 * 0052 writes a cryptographic receipt when a tenant is erased, 0054 versioned the manifest format
 * so one stays checkable for as long as it is kept, and `verifyTombstone` recomputes both hashes
 * and is pure. Nothing ever called it except an operator typing `crm-erasure receipts`.
 *
 * THE DECISION THAT WAS MISSING, in ADR-0001's own words: "a receipt that no longer recomputes is
 * either a bug in our own canonicalisation or evidence that somebody with database access rewrote
 * a deletion record, and those want very different responses… a job that cried wolf about its own
 * hashing bug would be worse than no job."
 *
 * They can be told apart decisively, and the mechanism is a KNOWN-ANSWER SELF-TEST. Before a
 * single stored receipt is read, this hashes `SELF_TEST_VECTORS` — a fixed set of attestations
 * with a hard-coded expected digest, one vector per entry in `MANIFEST_VERSIONS` — and compares.
 * A hashing bug cannot hide from a known-answer test, and no amount of tampering with stored rows
 * can make one fail. From there:
 *
 *   * the self-test fails  → this build cannot hash correctly. Nothing is read, nothing is
 *                            called tampered: `self_test_failed`.
 *   * all of a version fail → the receipts were written by a build whose canonicalisation
 *                            differed from this one, i.e. a format change shipped without a new
 *                            version number. Our bug: `unreproducible`.
 *   * some fail, siblings pass → a row was rewritten after it was written, under a format this
 *                            build reproduces perfectly for every other receipt: `tampered`.
 *   * nothing fails        → `verified`.
 *
 * The cohort is what makes the third arm sound. "One of forty failed" is not a shape a
 * canonicalisation bug can produce.
 *
 * WHY IT IS PLATFORM WORK AND NOT A PER-TENANT JOB. A receipt belongs to a tenant that has been
 * ERASED, and `activeTenants` is `status = 'active'` — deliberately, because 0050's whole point is
 * that a deleted tenant's background work stops. So no per-tenant job can ever reach a receipt,
 * and 0067 adds `crm.platform_job` for work that is about the deployment rather than about
 * anybody's data.
 *
 * AND NOBODY IS NOTIFIED, which is not an oversight. `crm.notification` is addressed to a rep and
 * endpoints are per tenant; a deleted tenant has no reps, and telling every live tenant's
 * administrators about another tenant's erasure receipt would be the cross-tenant disclosure the
 * erasure exists to prevent. The channel for a platform finding is the process's log line, which
 * carries `TAMPERED=` in capitals for a shipper to alert on, plus the stored row and the route.
 */
import type { Pool, PoolClient } from "pg";

import { readTenantTombstones } from "./execute.js";
import {
  MANIFEST_VERSIONS,
  computeContentManifestSha256,
  verifyTombstone,
  type ManifestVersion,
  type TableAttestation,
} from "./tombstone.js";

/** How many failing receipts a run names. A sample, like 0066's orphan sample and for its reason. */
export const FAILURE_SAMPLE_LIMIT = 10;

/**
 * The known-answer vector, and every field in it is load-bearing.
 *
 * It exercises all three outcomes, because the canonical line differs per outcome: `erased`
 * carries a row count and nothing else, `nothing_to_erase` carries no figures at all, and
 * `retained` carries an obligation, a note and a reference. A vector of one `erased` row would go
 * on passing after a change that broke the other two.
 *
 * The table names are deliberately out of alphabetical order. `canonicalAttestationManifest` sorts
 * them, and a vector already in order could not tell a working sort from a removed one.
 *
 * These are not real tables and the tenant is not a real tenant. The vector hashes the MANIFEST,
 * which commits only to the attestation lines and the exclusion list — nothing about identity — so
 * it needs no tenant at all, and inventing one would suggest the proof hash is covered here. It is
 * not: the proof commits to who did it, for whom, under what authority, and there is nothing to
 * pin that against without a stored receipt. What the self-test proves is that THIS BUILD
 * reproduces the manifest bytes of each format version, which is the half that goes wrong when
 * somebody edits a canonicaliser.
 */
export const SELF_TEST_ATTESTATIONS: readonly TableAttestation[] = [
  { table: "zz_last_by_name", outcome: "erased", rowsErased: 3 },
  { table: "aa_first_by_name", outcome: "nothing_to_erase" },
  {
    table: "mm_middle_by_name",
    outcome: "retained",
    rowsRetained: 7,
    obligation: "medical_records_10y",
    obligationNote: "a self-test vector, not a real retention rule for any deployment",
    retainedReference: "the self-test vector's imaginary archive",
  },
];

/** The exclusion list the vector hashes with. Unsorted, for the reason above. */
export const SELF_TEST_EXCLUSIONS: readonly string[] = ["zz_excluded", "aa_excluded"];

/**
 * The expected digests, per format version, written out rather than computed.
 *
 * A vector whose expected value is produced by the function under test is not a test. These were
 * taken from a build known good at 0067 and committed as constants; the day one of them stops
 * matching is the day somebody changed a canonicaliser, and the right response is a new
 * `MANIFEST_VERSIONS` entry rather than a new constant here.
 *
 * `v1` and `v2` differ exactly as 0054 says they do: v1 hashed the attestations alone, v2 appends
 * the exclusion list. Two constants over one vector is what pins that difference.
 */
export const SELF_TEST_VECTORS: Readonly<Record<ManifestVersion, string>> = {
  v1: "feefca41ec7d593feb8b6b69159cabc12e99a08582046c40e0877752e52af4b2",
  v2: "f8eee6f0031d53709955b30f8b096b2e282e488d0b6701f345a26136eee36c5d",
};

export type SelfTestResult = Readonly<Record<string, "ok" | "mismatch" | "threw">>;

/**
 * Hashes the vector under every format version and reports which ones this build reproduces.
 *
 * `threw` is its own answer rather than being folded into `mismatch`: a canonicaliser that throws
 * on the vector is a different fault from one that returns the wrong bytes, and an operator
 * reading the stored run should be able to tell them apart without the stack trace.
 */
export function runSelfTest(): SelfTestResult {
  const out: Record<string, "ok" | "mismatch" | "threw"> = {};
  for (const version of MANIFEST_VERSIONS) {
    try {
      const got = computeContentManifestSha256(SELF_TEST_ATTESTATIONS, SELF_TEST_EXCLUSIONS, version);
      out[version] = got === SELF_TEST_VECTORS[version] ? "ok" : "mismatch";
    } catch {
      out[version] = "threw";
    }
  }
  return out;
}

export const RECEIPT_VERDICTS = ["verified", "self_test_failed", "unreproducible", "tampered"] as const;
export type ReceiptVerdict = (typeof RECEIPT_VERDICTS)[number];

export interface ReceiptFailure {
  readonly tenantId: string;
  readonly receiptId: string;
  readonly manifestVersion: string;
  readonly problems: readonly string[];
}

export interface VersionCohort {
  readonly checked: number;
  readonly failed: number;
}

export interface ReceiptVerificationResult {
  readonly verdict: ReceiptVerdict;
  readonly selfTest: SelfTestResult;
  readonly tenantsChecked: number;
  readonly receiptsChecked: number;
  readonly receiptsFailed: number;
  readonly byVersion: Readonly<Record<string, VersionCohort>>;
  /** Up to `FAILURE_SAMPLE_LIMIT` of them, so an operator has one to go and look at. */
  readonly failures: readonly ReceiptFailure[];
  /** Tenants whose receipts could not be read at all. Not a verdict — see the field's note. */
  readonly unreadable: readonly string[];
  readonly summary: string;
}

/**
 * The verdict, as a pure function of the self-test and the cohorts.
 *
 * Separate from the reading so the whole decision table can be exercised without a database —
 * which matters more here than anywhere else in this repository, because the table IS the
 * contribution: three bad verdicts that an operator responds to in three different ways, and the
 * only way to be sure of the boundaries is to enumerate them.
 */
export function decideReceiptVerdict(
  selfTest: SelfTestResult,
  byVersion: Readonly<Record<string, VersionCohort>>,
): ReceiptVerdict {
  // FIRST, ALWAYS. A build that cannot hash correctly has no standing to call anything tampered,
  // and this is the arm the open row was worried about: "a job that cried wolf about its own
  // hashing bug would be worse than no job."
  if (Object.values(selfTest).some((v) => v !== "ok")) return "self_test_failed";

  const cohorts = Object.values(byVersion);
  const failed = cohorts.reduce((n, c) => n + c.failed, 0);
  if (failed === 0) return "verified";

  // A version is `unreproducible` when EVERY receipt of it failed: the format this build writes is
  // not the format those rows were written under, which is a version-discipline bug. `tampered`
  // when some failed and their siblings passed — a shape no canonicalisation bug can produce,
  // because a bug does not pick rows.
  const anyPartial = cohorts.some((c) => c.failed > 0 && c.failed < c.checked);
  return anyPartial ? "tampered" : "unreproducible";
}

/**
 * Reads every tenant's receipts and verifies them. Writes nothing.
 *
 * ONE SHORT TRANSACTION PER TENANT, like `checkChannelCoverage`, and for the same reason:
 * `crm.tenant_tombstone` is tenant-scoped under FORCE row security, so a cross-tenant read returns
 * zero rows — correctly, silently, and reporting every deployment clean. The enumeration comes
 * from `crm.tenant`, the one RLS-exempt registry, and includes EVERY status: a receipt belongs to
 * a tenant that has been erased, so a list filtered to `active` would hold no receipts at all.
 *
 * A tenant whose read fails does NOT fail the sweep. Its id goes in `unreadable`, because "we
 * could not look" and "there is nothing there" are the two answers an integrity report must never
 * conflate — 0066's rule, and `ChannelCoverageReport.unreadable`'s before it.
 */
export async function verifyStoredReceipts(pool: Pool): Promise<ReceiptVerificationResult> {
  const selfTest = runSelfTest();
  const unreadable: string[] = [];

  if (Object.values(selfTest).some((v) => v !== "ok")) {
    // NOT A SINGLE RECEIPT IS READ. The point is not to save the queries — it is that a build
    // which fails its own known-answer test must not produce a per-receipt report at all, because
    // every line of it would be noise an operator could mistake for evidence.
    return {
      verdict: "self_test_failed",
      selfTest,
      tenantsChecked: 0,
      receiptsChecked: 0,
      receiptsFailed: 0,
      byVersion: {},
      failures: [],
      unreadable,
      summary: summarise("self_test_failed", selfTest, 0, 0, 0, {}, unreadable),
    };
  }

  const client = await pool.connect();
  const byVersion: Record<string, VersionCohort> = {};
  const failures: ReceiptFailure[] = [];
  let tenantsChecked = 0;
  let receiptsChecked = 0;
  let receiptsFailed = 0;

  try {
    const { rows: tenants } = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM crm.tenants_with_receipts()",
    );
    for (const { tenant_id: tenantId } of tenants) {
      tenantsChecked += 1;
      let receipts;
      try {
        receipts = await readTenantTombstones(client, tenantId);
      } catch {
        unreadable.push(tenantId);
        continue;
      }
      for (const receipt of receipts) {
        receiptsChecked += 1;
        const version = receipt.manifestVersion;
        const cohort = byVersion[version] ?? { checked: 0, failed: 0 };
        const problems = verifyTombstone(receipt);
        byVersion[version] = {
          checked: cohort.checked + 1,
          failed: cohort.failed + (problems.length > 0 ? 1 : 0),
        };
        if (problems.length > 0) {
          receiptsFailed += 1;
          if (failures.length < FAILURE_SAMPLE_LIMIT) {
            failures.push({ tenantId, receiptId: receipt.id, manifestVersion: version, problems });
          }
        }
      }
    }
  } finally {
    client.release();
  }

  const verdict = decideReceiptVerdict(selfTest, byVersion);
  return {
    verdict,
    selfTest,
    tenantsChecked,
    receiptsChecked,
    receiptsFailed,
    byVersion,
    failures,
    unreadable,
    summary: summarise(verdict, selfTest, tenantsChecked, receiptsChecked, receiptsFailed, byVersion, unreadable),
  };
}

function summarise(
  verdict: ReceiptVerdict,
  selfTest: SelfTestResult,
  tenantsChecked: number,
  receiptsChecked: number,
  receiptsFailed: number,
  byVersion: Readonly<Record<string, VersionCohort>>,
  unreadable: readonly string[],
): string {
  const versions = Object.entries(byVersion)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, c]) => `${v}=${String(c.checked)}${c.failed > 0 ? `/${String(c.failed)}bad` : ""}`)
    .join(",");

  // CAPITALISED WHEN SOMEBODY HAS TO ACT, like `ORPHANS=` and `ESCALATED=` on the lines beside it,
  // and `TAMPERED=` first of all: it is the only line this process can emit that means somebody
  // with database access rewrote a record of a deletion.
  const parts = [
    ...(verdict === "tampered" ? [`TAMPERED=${String(receiptsFailed)}`] : []),
    ...(verdict === "unreproducible" ? [`UNREPRODUCIBLE=${String(receiptsFailed)}`] : []),
    ...(verdict === "self_test_failed"
      ? [
          `SELF_TEST_FAILED=${Object.entries(selfTest)
            .filter(([, v]) => v !== "ok")
            .map(([v, r]) => `${v}:${r}`)
            .join(",")}`,
        ]
      : []),
    ...(unreadable.length > 0 ? [`UNREADABLE=${String(unreadable.length)}`] : []),
    `verdict=${verdict}`,
    `tenants=${String(tenantsChecked)}`,
    `receipts=${String(receiptsChecked)}`,
    ...(versions === "" ? [] : [`versions=${versions}`]),
  ];
  if (verdict === "self_test_failed") {
    parts.push("noReceiptsRead=this build cannot reproduce its own manifest format, so nothing was checked");
  }
  return parts.join(" ");
}

/** Writes one sweep to `crm.receipt_verification_run` and returns its id. */
export async function recordReceiptVerification(
  client: PoolClient,
  result: ReceiptVerificationResult,
  now: Date,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO crm.receipt_verification_run
       (ran_at, verdict, receipts_checked, receipts_failed, tenants_checked,
        by_version, self_test, failures)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
     RETURNING id`,
    [
      now,
      result.verdict,
      result.receiptsChecked,
      result.receiptsFailed,
      result.tenantsChecked,
      JSON.stringify(result.byVersion),
      JSON.stringify(result.selfTest),
      // The unreadable tenants ride in `failures` rather than getting a column: they are not a
      // verdict and there is no honest count to pair with one, but a reader of the row must be
      // able to see that the sweep did not cover everything.
      JSON.stringify(
        result.unreadable.length === 0
          ? result.failures
          : [...result.failures, { unreadableTenants: result.unreadable }],
      ),
    ],
  );
  return rows[0]!.id;
}

/** Verifies and records in one call — what the platform job runs. */
export async function sweepReceipts(
  pool: Pool,
  now: Date,
): Promise<ReceiptVerificationResult> {
  const result = await verifyStoredReceipts(pool);
  const client = await pool.connect();
  try {
    await recordReceiptVerification(client, result, now);
  } finally {
    client.release();
  }
  return result;
}

export interface ReceiptVerificationRow {
  readonly id: string;
  readonly seq: string;
  readonly ran_at: Date;
  readonly verdict: ReceiptVerdict;
  readonly receipts_checked: number;
  readonly receipts_failed: number;
  readonly tenants_checked: number;
  readonly by_version: unknown;
  readonly self_test: unknown;
  readonly failures: unknown;
}

/** The newest sweep, which is the only one that is still a claim. */
export async function latestReceiptVerification(
  client: PoolClient,
): Promise<ReceiptVerificationRow | null> {
  const { rows } = await client.query<ReceiptVerificationRow>(
    `SELECT id::text AS id, seq::text AS seq, ran_at, verdict, receipts_checked, receipts_failed,
            tenants_checked, by_version, self_test, failures
       FROM crm.latest_receipt_verification()`,
  );
  return rows[0] ?? null;
}
