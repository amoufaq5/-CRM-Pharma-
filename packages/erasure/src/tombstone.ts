import { createHash, randomUUID } from "node:crypto";

import type { RetentionObligation } from "./obligations.js";

/**
 * The receipt, and the two hashes that make it checkable. All pure.
 *
 * Mirrors CrossEngin's `computeContentManifestSha256` / `computeProofSha256` in intent and in
 * the one property that matters: both are DOMAIN-TAGGED and canonical. The tag is what stops a
 * hash computed for one kind of claim verifying as another — without it, a manifest over a list
 * of tables and some unrelated digest over the same bytes are indistinguishable, and "the hash
 * matches" stops being an answer to any particular question.
 *
 * `JSON.stringify` IS NOT USED, and that is the whole reason this file exists rather than two
 * one-liners. Its output depends on property insertion order, so two attestation lists that
 * differ only in how they were built would hash differently and the same list rebuilt by a
 * later reader could fail to verify. Every field is written in a fixed order, separated by a
 * character the values cannot contain, with absent values written as a marker rather than
 * omitted — because omitting them makes `obligation=null, note="x"` and `obligation="x",
 * note=null` collide.
 */

export const ATTESTATION_OUTCOMES = ["erased", "nothing_to_erase", "retained"] as const;
export type AttestationOutcome = (typeof ATTESTATION_OUTCOMES)[number];

export interface TableAttestation {
  readonly table: string;
  readonly outcome: AttestationOutcome;
  /** Present only on `erased`, and at least 1: zero rows found is `nothing_to_erase`. */
  readonly rowsErased?: number;
  /** Present only on `retained`, and at least 1, for the same reason. */
  readonly rowsRetained?: number;
  readonly obligation?: RetentionObligation;
  readonly obligationNote?: string;
  readonly retainedReference?: string;
}

/**
 * A place this tenant's attachment bytes are that no per-table attestation can speak for.
 *
 * Derived by `crm.uncovered_storage_backends` from the tenant's OWN attachment rows (0074),
 * never from a list here: `crm.attachment.storage_backend` references a registry whose CHECK
 * demands, for every backend, either the table whose attestation destroys its bytes or the
 * subsystem it must attest under. One of the two, never neither.
 *
 * `postgres` is covered by `crm.attachment_blob`, so today this is always empty and the
 * receipt is honest — which is exactly the state that makes the guard worth having before a
 * bucket exists rather than after.
 */
export interface UncoveredStorageBackend {
  readonly backend: string;
  readonly reason: "no_covering_table" | "covering_table_not_in_scope";
  /** The subsystem it owes an attestation under, when the registry names one. */
  readonly subsystem: string | null;
  /** How many of this tenant's attachments name it. At least 1, or it would not be reported. */
  readonly objects: number;
  /** The registry's own sentence, so a refusal reads as the declaration did. */
  readonly note: string;
}

export function describeUncoveredBackend(b: UncoveredStorageBackend): string {
  const where =
    b.reason === "no_covering_table"
      ? `nothing in Postgres destroys its objects, so the ${b.subsystem ?? "subsystem"} it belongs ` +
        `to owes an attestation of its own`
      : `the table the registry says covers it is not in this receipt's scope, so its attestation ` +
        `cannot speak for these bytes`;
  return (
    `${b.backend} holds ${String(b.objects)} of this tenant's attachment(s) and ${where}. ` +
    `Declared as: ${b.note}`
  );
}

export interface CrmTombstone {
  readonly id: string;
  readonly tenantId: string;
  /** The ERP receipt this deletion was performed under. */
  readonly erpTombstoneId: string;
  readonly deletedAt: string;
  readonly contentManifestSha256: string;
  readonly proofSha256: string;
  readonly executedBy: string;
  readonly approvedBy: string;
  readonly rowsErased: number;
  readonly rowsRetained: number;
  readonly attestations: readonly TableAttestation[];
  /**
   * The tables this receipt is DELIBERATELY silent about: its own storage.
   *
   * 0051's insight one level in — a declared "we are not speaking about this" is not the same
   * as silence. Without it a reader comparing the register's rows to the attestations finds a
   * discrepancy with no explanation, and "the hash covers everything except two things you
   * have to work out" is not a property anybody can check. Sorted, and inside the manifest.
   */
  readonly excludedTables: readonly string[];
  readonly manifestVersion: ManifestVersion;
}

/**
 * The manifest format, versioned in the domain tag AND stored on the row.
 *
 * `v2` added the deliberately-excluded table list (0054). A receipt whose stored hash no
 * longer recomputes is indistinguishable from a tampered one, so the format a receipt was
 * signed under is recorded with it rather than assumed, and `v1` receipts stay verifiable
 * forever under the rules they were made with. The version is inside the hashed bytes as well
 * as beside them, so rewriting the column cannot make a v1 digest verify as v2.
 *
 * The PROOF format is unchanged and stays `v1`: its field list is the same, and the manifest
 * hash it commits to differs by itself. Retagging it would say something untrue — that the
 * proof's own shape moved.
 */
export const MANIFEST_VERSIONS = ["v1", "v2"] as const;
export type ManifestVersion = (typeof MANIFEST_VERSIONS)[number];
export const CURRENT_MANIFEST_VERSION: ManifestVersion = "v2";

const manifestDomain = (version: ManifestVersion): string =>
  `crm.tenant_tombstone.manifest.${version}`;
const PROOF_DOMAIN = "crm.tenant_tombstone.proof.v1";

/** `\u001f`, the ASCII unit separator: no field below can contain it, and a table name cannot. */
const SEP = "\u001f";
const ABSENT = "\u0000";

function field(value: string | number | undefined): string {
  return value === undefined ? ABSENT : String(value);
}

/**
 * One line per attestation, sorted by table name.
 *
 * Sorted rather than taken in the order the executor happened to produce — which is FK-delete
 * order, a property of the schema graph that a later reader has no reason to reproduce. A hash
 * nobody can recompute is decoration.
 */
export function canonicalAttestationManifest(
  attestations: readonly TableAttestation[],
  excludedTables: readonly string[] = [],
  version: ManifestVersion = CURRENT_MANIFEST_VERSION,
): string {
  const lines = [...attestations]
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
    .map((a) =>
      [
        a.table,
        a.outcome,
        field(a.rowsErased),
        field(a.rowsRetained),
        field(a.obligation),
        field(a.obligationNote),
        field(a.retainedReference),
      ].join(SEP),
    );
  const body = `${manifestDomain(version)}\n${lines.join("\n")}\n`;
  // v1 receipts hashed the attestations alone. Appending the exclusion list only for v2 is
  // what keeps those verifiable: the bytes they were signed over are reproduced exactly.
  return version === "v1" ? body : `${body}excluded${SEP}${[...excludedTables].sort().join(SEP)}\n`;
}

export function computeContentManifestSha256(
  attestations: readonly TableAttestation[],
  excludedTables: readonly string[] = [],
  version: ManifestVersion = CURRENT_MANIFEST_VERSION,
): string {
  return createHash("sha256")
    .update(canonicalAttestationManifest(attestations, excludedTables, version), "utf8")
    .digest("hex");
}

/**
 * The proof commits to the manifest hash AND to who did it, for whom, under what authority.
 *
 * Hashing the attestations alone would leave a manifest that verifies against any tenant, any
 * executor and any ERP tombstone — true of the list and silent about the claim. The identity
 * fields are what make it a statement rather than a checksum.
 */
export function computeProofSha256(input: {
  readonly tenantId: string;
  readonly erpTombstoneId: string;
  readonly deletedAt: string;
  readonly contentManifestSha256: string;
  readonly executedBy: string;
  readonly approvedBy: string;
}): string {
  const body = [
    input.tenantId,
    input.erpTombstoneId,
    input.deletedAt,
    input.contentManifestSha256,
    input.executedBy,
    input.approvedBy,
  ].join(SEP);
  return createHash("sha256").update(`${PROOF_DOMAIN}\n${body}\n`, "utf8").digest("hex");
}

/** `crmtomb_` + 32 hex. Deliberately unlike the ERP's `tomb_`: see 0052's header. */
export function newCrmTombstoneId(uuid: string = randomUUID()): string {
  return `crmtomb_${uuid.replace(/-/g, "").slice(0, 32)}`;
}

export class TombstoneInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TombstoneInvalidError";
  }
}

/**
 * The contract's own rules, checked before anything is written.
 *
 * The database checks all of this too (0052), and that is the point rather than a redundancy:
 * a CHECK refuses the row and this names the rule, and the two disagreeing is a bug somebody
 * finds in a test rather than in a transaction that has already deleted things.
 */
export function assertAttestationWellFormed(a: TableAttestation): void {
  const fail = (why: string): never => {
    throw new TombstoneInvalidError(`attestation for ${a.table}: ${why}`);
  };
  if (a.outcome === "erased") {
    if (a.rowsErased === undefined || a.rowsErased < 1) fail("erased must report at least one row");
    if (a.rowsRetained !== undefined) fail("erased may not report retained rows");
    if (a.obligation !== undefined) fail("erased may not carry an obligation — nothing was kept");
    if (a.retainedReference !== undefined) fail("erased may not carry a retained reference");
  } else if (a.outcome === "nothing_to_erase") {
    if (a.rowsErased !== undefined || a.rowsRetained !== undefined) {
      fail("nothing_to_erase carries no figures: it means the table was asked and held nothing");
    }
    if (a.obligation !== undefined || a.retainedReference !== undefined) {
      fail("nothing_to_erase carries no obligation: there was nothing to keep");
    }
  } else {
    if (a.rowsRetained === undefined || a.rowsRetained < 1) {
      fail("retained must report at least one row — 'lawfully keeping' zero rows is not evidence");
    }
    if (a.rowsErased !== undefined) fail("retained may not report erased rows");
    if (a.obligation === undefined || a.obligation === "none") {
      fail("retained needs a lawful basis, and 'none' is not one");
    }
    if (a.obligationNote === undefined) fail("retained needs the rule in words, not just a code");
    if (a.retainedReference === undefined) {
      fail("retained needs to say where the data still is — 'we kept it' is not an answer without it");
    }
  }
}

/**
 * Assembles the receipt, and REFUSES when a table in scope has not attested.
 *
 * ADR-0317's rule, which is the only reason any of this is worth hashing: "Silence is not
 * 'none'. A subsystem in scope must say what it destroyed, say it found nothing, or say it is
 * lawfully keeping it. An absent attestation refuses the tombstone."
 *
 * `inScope` is the register's full table list, passed in rather than derived here, so the
 * comparison is against what the database said a moment ago inside the same transaction and
 * not against anything this module remembers.
 */
export function assembleTombstone(input: {
  readonly tenantId: string;
  readonly erpTombstoneId: string;
  readonly deletedAt: string;
  readonly executedBy: string;
  readonly approvedBy: string;
  readonly inScope: readonly string[];
  readonly attestations: readonly TableAttestation[];
  /**
   * Places this tenant's bytes are that no table in `inScope` can attest about (0074).
   *
   * REQUIRED, not optional with an empty default, and that is the whole point: a default
   * would be a fail-OPEN default, and the one thing this field exists to prevent is a
   * receipt assembled by a caller who never considered object storage. A new call site has
   * to answer the question, which is the same reason `inScope` is passed in rather than
   * derived here.
   */
  readonly uncoveredBackends: readonly UncoveredStorageBackend[];
  /** Receipt stores: tables this receipt may not speak about because it is them (0054). */
  readonly excludedTables?: readonly string[];
  readonly id?: string;
}): CrmTombstone {
  if (input.executedBy === input.approvedBy) {
    throw new TombstoneInvalidError(
      `four-eyes: executedBy and approvedBy are both ${JSON.stringify(input.executedBy)} — the one ` +
        `operation here that destroys data on purpose is not one person's to perform and approve`,
    );
  }

  const excluded = [...(input.excludedTables ?? [])].sort();
  const attested = new Set(input.attestations.map((a) => a.table));

  /**
   * AN EXCLUDED TABLE MAY NOT ALSO ATTEST, which is the rule 0054 exists for. The first
   * version of 0052 attested `nothing_to_erase` about `crm.tenant_tombstone` inside the
   * transaction that wrote a row into it — a statement its own signing falsified, with the
   * hash committing to it. Excluding a table and then attesting about it anyway would restore
   * exactly that, so it is refused rather than deduplicated.
   */
  const bothWays = excluded.filter((t) => attested.has(t));
  if (bothWays.length > 0) {
    throw new TombstoneInvalidError(
      `${bothWays.join(", ")} ${bothWays.length === 1 ? "is" : "are"} excluded from this receipt's ` +
        `scope AND attested in it. A receipt cannot speak about its own storage: the transaction ` +
        `that signs the attestation is the one that writes the rows it describes.`,
    );
  }
  if (attested.size !== input.attestations.length) {
    const seen = new Set<string>();
    const dup = input.attestations.find((a) => (seen.has(a.table) ? true : (seen.add(a.table), false)));
    throw new TombstoneInvalidError(
      `${dup?.table ?? "a table"} attested twice: the hash would cover a list with a duplicate, and ` +
        `whichever figure a reader believed would be a coin toss`,
    );
  }

  const silent = input.inScope.filter((t) => !attested.has(t) && !excluded.includes(t)).sort();
  if (silent.length > 0) {
    throw new TombstoneInvalidError(
      `${String(silent.length)} table(s) in scope did not attest: ${silent.join(", ")}. ` +
        `Silence is not "none" — a table must say what it destroyed, that it held nothing, or ` +
        `that it is lawfully kept. Refusing to assemble a proof that would be silent about them.`,
    );
  }
  const unexpected = [...attested].filter((t) => !input.inScope.includes(t)).sort();
  if (unexpected.length > 0) {
    throw new TombstoneInvalidError(
      `${unexpected.join(", ")} attested but ${unexpected.length === 1 ? "is" : "are"} not in scope — ` +
        `an attestation for a table the register does not govern has no decision behind it`,
    );
  }

  for (const a of input.attestations) assertAttestationWellFormed(a);

  /**
   * AND THE BYTES THAT ARE NOT A TABLE (0074). ADR-0317's rule one level out: the per-table
   * attestations above are complete about the TABLES, and a receipt that is complete about
   * the tables while silent about an object store is a correct proof of a false claim.
   *
   * Refused here as well as in the plan, and the duplication is deliberate for the reason
   * `assertAttestationWellFormed` gives: the plan refuses before anything is deleted, which
   * is where an operator wants to be told, and this refuses before anything is SIGNED, which
   * is where a future second caller gets told. The two disagreeing is a bug somebody finds
   * in a test rather than in a transaction that has already destroyed things.
   */
  if (input.uncoveredBackends.length > 0) {
    throw new TombstoneInvalidError(
      `${String(input.uncoveredBackends.length)} storage backend(s) hold this tenant's attachment ` +
        `bytes and no table in scope attests about them: ` +
        input.uncoveredBackends.map((b) => describeUncoveredBackend(b)).join(" | ") +
        `. Refusing to sign a receipt that is complete about 41 tables and silent about the most ` +
        `sensitive data in the system.`,
    );
  }

  const contentManifestSha256 = computeContentManifestSha256(
    input.attestations,
    excluded,
    CURRENT_MANIFEST_VERSION,
  );
  return {
    id: input.id ?? newCrmTombstoneId(),
    tenantId: input.tenantId,
    erpTombstoneId: input.erpTombstoneId,
    deletedAt: input.deletedAt,
    contentManifestSha256,
    proofSha256: computeProofSha256({
      tenantId: input.tenantId,
      erpTombstoneId: input.erpTombstoneId,
      deletedAt: input.deletedAt,
      contentManifestSha256,
      executedBy: input.executedBy,
      approvedBy: input.approvedBy,
    }),
    executedBy: input.executedBy,
    approvedBy: input.approvedBy,
    rowsErased: input.attestations.reduce((n, a) => n + (a.rowsErased ?? 0), 0),
    rowsRetained: input.attestations.reduce((n, a) => n + (a.rowsRetained ?? 0), 0),
    attestations: input.attestations,
    excludedTables: excluded,
    manifestVersion: CURRENT_MANIFEST_VERSION,
  };
}

/** Recomputes both hashes and reports what, if anything, disagrees. */
export function verifyTombstone(t: CrmTombstone): readonly string[] {
  const problems: string[] = [];
  // Verified under the format it was SIGNED under, which is why the version is stored.
  const manifest = computeContentManifestSha256(t.attestations, t.excludedTables, t.manifestVersion);
  if (manifest !== t.contentManifestSha256) {
    problems.push(`content manifest hash is ${t.contentManifestSha256} but recomputes to ${manifest}`);
  }
  const proof = computeProofSha256({
    tenantId: t.tenantId,
    erpTombstoneId: t.erpTombstoneId,
    deletedAt: t.deletedAt,
    contentManifestSha256: t.contentManifestSha256,
    executedBy: t.executedBy,
    approvedBy: t.approvedBy,
  });
  if (proof !== t.proofSha256) {
    problems.push(`proof hash is ${t.proofSha256} but recomputes to ${proof}`);
  }
  const erased = t.attestations.reduce((n, a) => n + (a.rowsErased ?? 0), 0);
  const retained = t.attestations.reduce((n, a) => n + (a.rowsRetained ?? 0), 0);
  if (erased !== t.rowsErased) problems.push(`rows_erased says ${String(t.rowsErased)}, attestations sum to ${String(erased)}`);
  if (retained !== t.rowsRetained) problems.push(`rows_retained says ${String(t.rowsRetained)}, attestations sum to ${String(retained)}`);
  return problems;
}
