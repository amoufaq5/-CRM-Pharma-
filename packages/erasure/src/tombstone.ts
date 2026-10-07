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
}

const MANIFEST_DOMAIN = "crm.tenant_tombstone.manifest.v1";
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
export function canonicalAttestationManifest(attestations: readonly TableAttestation[]): string {
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
  return `${MANIFEST_DOMAIN}\n${lines.join("\n")}\n`;
}

export function computeContentManifestSha256(attestations: readonly TableAttestation[]): string {
  return createHash("sha256").update(canonicalAttestationManifest(attestations), "utf8").digest("hex");
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
  readonly id?: string;
}): CrmTombstone {
  if (input.executedBy === input.approvedBy) {
    throw new TombstoneInvalidError(
      `four-eyes: executedBy and approvedBy are both ${JSON.stringify(input.executedBy)} — the one ` +
        `operation here that destroys data on purpose is not one person's to perform and approve`,
    );
  }

  const attested = new Set(input.attestations.map((a) => a.table));
  if (attested.size !== input.attestations.length) {
    const seen = new Set<string>();
    const dup = input.attestations.find((a) => (seen.has(a.table) ? true : (seen.add(a.table), false)));
    throw new TombstoneInvalidError(
      `${dup?.table ?? "a table"} attested twice: the hash would cover a list with a duplicate, and ` +
        `whichever figure a reader believed would be a coin toss`,
    );
  }

  const silent = input.inScope.filter((t) => !attested.has(t)).sort();
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

  const contentManifestSha256 = computeContentManifestSha256(input.attestations);
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
  };
}

/** Recomputes both hashes and reports what, if anything, disagrees. */
export function verifyTombstone(t: CrmTombstone): readonly string[] {
  const problems: string[] = [];
  const manifest = computeContentManifestSha256(t.attestations);
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
