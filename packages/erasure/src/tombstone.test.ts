import { describe, expect, it } from "vitest";

import {
  TombstoneInvalidError,
  assembleTombstone,
  assertAttestationWellFormed,
  canonicalAttestationManifest,
  computeContentManifestSha256,
  computeProofSha256,
  newCrmTombstoneId,
  verifyTombstone,
  type TableAttestation,
} from "./tombstone.js";
import { eraseDeleteOrder } from "./plan.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ERP_TOMB = "tomb_0123456789abcdef0123456789abcdef";

const erased = (table: string, rows = 3): TableAttestation => ({
  table,
  outcome: "erased",
  rowsErased: rows,
});
const nothing = (table: string): TableAttestation => ({ table, outcome: "nothing_to_erase" });
const retained = (table: string, rows = 2): TableAttestation => ({
  table,
  outcome: "retained",
  rowsRetained: rows,
  obligation: "financial_transactions_7y",
  obligationNote: "an accounting record, kept for the statutory period",
  retainedReference: "crm.expense_claim",
});

const assemble = (over: Partial<Parameters<typeof assembleTombstone>[0]> = {}) =>
  assembleTombstone({
    tenantId: TENANT,
    erpTombstoneId: ERP_TOMB,
    deletedAt: "2026-10-07T09:00:00.000Z",
    executedBy: "ops:alice",
    approvedBy: "compliance:bob",
    inScope: ["a_table", "b_table", "c_table"],
    attestations: [erased("a_table"), nothing("b_table"), retained("c_table")],
    id: "crmtomb_00000000000000000000000000000001",
    ...over,
  });

describe("the canonical manifest", () => {
  /** Sorted, not taken in the order the executor produced — which is FK-delete order. */
  it("is independent of the order the attestations arrive in", () => {
    const one = canonicalAttestationManifest([erased("a_table"), nothing("b_table")]);
    const two = canonicalAttestationManifest([nothing("b_table"), erased("a_table")]);
    expect(one).toBe(two);
  });

  it("is domain-tagged, so a digest cannot be mistaken for another kind of claim", () => {
    expect(canonicalAttestationManifest([])).toContain("crm.tenant_tombstone.manifest.v1");
    const manifest = computeContentManifestSha256([erased("a_table")]);
    const proof = computeProofSha256({
      tenantId: TENANT,
      erpTombstoneId: ERP_TOMB,
      deletedAt: "2026-10-07T09:00:00.000Z",
      contentManifestSha256: manifest,
      executedBy: "ops:alice",
      approvedBy: "compliance:bob",
    });
    expect(proof).not.toBe(manifest);
  });

  /**
   * Absent fields are written as a marker rather than omitted. Omitting them lets
   * `{obligation: null, note: "x"}` and `{obligation: "x", note: null}` produce identical
   * bytes, which is a hash collision somebody could construct on purpose.
   */
  it("cannot be made to collide by moving a value between fields", () => {
    const a: TableAttestation = {
      table: "t",
      outcome: "retained",
      rowsRetained: 1,
      obligation: "audit_logs_3y",
      obligationNote: "x".repeat(10),
      retainedReference: "ref",
    };
    const b: TableAttestation = {
      table: "t",
      outcome: "retained",
      rowsRetained: 1,
      obligation: "audit_logs_3y",
      obligationNote: "ref",
      retainedReference: "x".repeat(10),
    };
    expect(computeContentManifestSha256([a])).not.toBe(computeContentManifestSha256([b]));
  });

  it("changes when any figure changes", () => {
    const base = computeContentManifestSha256([erased("a_table", 3)]);
    expect(computeContentManifestSha256([erased("a_table", 4)])).not.toBe(base);
    expect(computeContentManifestSha256([nothing("a_table")])).not.toBe(base);
  });
});

describe("the proof", () => {
  /** Hashing the attestations alone would verify against any tenant and any executor. */
  it.each([
    ["tenantId", { tenantId: "22222222-2222-4222-8222-222222222222" }],
    ["erpTombstoneId", { erpTombstoneId: "tomb_ffffffffffffffffffffffffffffffff" }],
    ["deletedAt", { deletedAt: "2026-10-07T09:00:01.000Z" }],
    ["executedBy", { executedBy: "ops:eve" }],
    ["approvedBy", { approvedBy: "compliance:eve" }],
  ])("commits to %s", (_label, over) => {
    const a = assemble();
    const b = assemble(over);
    expect(b.proofSha256).not.toBe(a.proofSha256);
  });

  it("re-verifies over what was assembled", () => {
    expect(verifyTombstone(assemble())).toEqual([]);
  });

  it.each([
    ["a rewritten figure", (t: ReturnType<typeof assemble>) => ({
      ...t,
      attestations: [erased("a_table", 99), nothing("b_table"), retained("c_table")],
    })],
    ["a rewritten executor", (t: ReturnType<typeof assemble>) => ({ ...t, executedBy: "ops:eve" })],
    ["a rewritten total", (t: ReturnType<typeof assemble>) => ({ ...t, rowsErased: 0 })],
  ])("reports %s", (_label, mutate) => {
    const problems = verifyTombstone(mutate(assemble()));
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("assembleTombstone", () => {
  /** ADR-0317's rule, which is the only reason any of this is worth hashing. */
  it("refuses when a table in scope did not attest, and names it", () => {
    expect(() => assemble({ inScope: ["a_table", "b_table", "c_table", "d_table"] })).toThrow(
      /d_table/,
    );
    expect(() => assemble({ inScope: ["a_table", "b_table", "c_table", "d_table"] })).toThrow(
      /Silence is not "none"/,
    );
  });

  it("refuses an attestation for a table the register does not govern", () => {
    expect(() =>
      assemble({ attestations: [erased("a_table"), nothing("b_table"), retained("c_table"), erased("z_table")] }),
    ).toThrow(/z_table attested but is not in scope/);
  });

  it("refuses the same table attested twice", () => {
    expect(() =>
      assemble({
        inScope: ["a_table"],
        attestations: [erased("a_table", 1), erased("a_table", 2)],
      }),
    ).toThrow(/attested twice/);
  });

  it("refuses four-eyes violations", () => {
    expect(() => assemble({ executedBy: "ops:alice", approvedBy: "ops:alice" })).toThrow(
      /four-eyes/,
    );
  });

  it("totals the figures from the attestations rather than being told them", () => {
    const t = assemble({
      inScope: ["a_table", "c_table"],
      attestations: [erased("a_table", 5), retained("c_table", 7)],
    });
    expect(t.rowsErased).toBe(5);
    expect(t.rowsRetained).toBe(7);
  });

  it("mints an id that cannot be mistaken for the ERP's", () => {
    const id = newCrmTombstoneId();
    expect(id).toMatch(/^crmtomb_[0-9a-f]{32}$/);
    expect(id.startsWith("tomb_")).toBe(false);
  });
});

describe("attestation well-formedness", () => {
  it("refuses erased with no rows: zero rows found is nothing_to_erase", () => {
    expect(() => assertAttestationWellFormed({ table: "t", outcome: "erased" })).toThrow(
      /at least one row/,
    );
  });

  it("refuses erased that carries an obligation — nothing was kept", () => {
    expect(() =>
      assertAttestationWellFormed({
        table: "t",
        outcome: "erased",
        rowsErased: 1,
        obligation: "audit_logs_3y",
      }),
    ).toThrow(/may not carry an obligation/);
  });

  it("refuses nothing_to_erase that carries figures", () => {
    expect(() =>
      assertAttestationWellFormed({ table: "t", outcome: "nothing_to_erase", rowsErased: 1 }),
    ).toThrow(/carries no figures/);
  });

  /** "Lawfully keeping" zero rows reads as evidence and is not. */
  it("refuses retained with no rows", () => {
    expect(() =>
      assertAttestationWellFormed({
        table: "t",
        outcome: "retained",
        obligation: "audit_logs_3y",
        obligationNote: "x".repeat(10),
        retainedReference: "ref",
      }),
    ).toThrow(/at least one row/);
  });

  it("refuses `none` as a retained basis, though it is in the vocabulary", () => {
    expect(() =>
      assertAttestationWellFormed({
        table: "t",
        outcome: "retained",
        rowsRetained: 1,
        obligation: "none",
        obligationNote: "x".repeat(10),
        retainedReference: "ref",
      }),
    ).toThrow(/'none' is not one/);
  });

  it("refuses retained with no reference: 'we kept it' is not an answer alone", () => {
    expect(() =>
      assertAttestationWellFormed({
        table: "t",
        outcome: "retained",
        rowsRetained: 1,
        obligation: "audit_logs_3y",
        obligationNote: "x".repeat(10),
      }),
    ).toThrow(/where the data still is/);
  });
});

describe("eraseDeleteOrder", () => {
  const edges = [
    { child: "visit_product", parent: "visit" },
    { child: "visit", parent: "rep_profile" },
    { child: "expense_claim", parent: "rep_profile" },
  ];

  /** Children first: a parent cannot go while anything still references it. */
  it("puts a child before its parent", () => {
    const { order, cycle } = eraseDeleteOrder(
      new Set(["visit", "visit_product", "rep_profile", "expense_claim"]),
      edges,
    );
    expect(cycle).toEqual([]);
    expect(order.indexOf("visit_product")).toBeLessThan(order.indexOf("visit"));
    expect(order.indexOf("visit")).toBeLessThan(order.indexOf("rep_profile"));
    expect(order.indexOf("expense_claim")).toBeLessThan(order.indexOf("rep_profile"));
  });

  it("covers every table in the set exactly once", () => {
    const set = new Set(["visit", "visit_product", "rep_profile", "expense_claim"]);
    const { order } = eraseDeleteOrder(set, edges);
    expect([...order].sort()).toEqual([...set].sort());
  });

  /**
   * An edge to a table NOT being erased constrains nothing. Without this, every erase set with
   * a retained parent would look cyclic and nothing could ever be erased.
   */
  it("ignores edges that leave the erase set", () => {
    const { order, cycle } = eraseDeleteOrder(new Set(["visit_product"]), edges);
    expect(cycle).toEqual([]);
    expect(order).toEqual(["visit_product"]);
  });

  it("is deterministic, so two runs of the same schema compare", () => {
    const set = new Set(["visit", "visit_product", "rep_profile", "expense_claim"]);
    expect(eraseDeleteOrder(set, edges).order).toEqual(eraseDeleteOrder(set, edges).order);
  });

  it("reports a cycle rather than breaking one", () => {
    const { order, cycle } = eraseDeleteOrder(new Set(["a", "b"]), [
      { child: "a", parent: "b" },
      { child: "b", parent: "a" },
    ]);
    expect(order).toEqual([]);
    expect(cycle).toEqual(["a", "b"]);
  });

  it("tolerates a self-reference, which constrains nothing", () => {
    const { order, cycle } = eraseDeleteOrder(new Set(["t"]), [{ child: "t", parent: "t" }]);
    expect(cycle).toEqual([]);
    expect(order).toEqual(["t"]);
  });
});
