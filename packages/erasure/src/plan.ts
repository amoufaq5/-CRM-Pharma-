import type { PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import type { Disposition, RetentionObligation } from "./obligations.js";

/**
 * What would happen to every row this CRM holds for one tenant, and why.
 *
 * NOT a tombstone, and the distinction is the whole reason this file stops where it does.
 * CrossEngin's ADR-0317 is exact about it: "A proof over a scope assembled from nothing is a
 * correct proof of a false claim." A plan says what WOULD happen; a tombstone says what DID.
 * Composing a tombstone here, before anything is erased, would reproduce the original defect
 * ADR-0316 was written to close — a signed receipt for a deletion that did not occur. So this
 * produces a plan an operator and a compliance officer read and sign off, and the execution
 * that earns a tombstone is the next increment.
 *
 * THE PLAN REFUSES RATHER THAN SUMMARISING WHAT IT KNOWS, on four grounds, and each refusal is
 * the same rule at a different depth:
 *
 *   undeclared — a tenant-scoped table with no register row. ADR-0317's rule verbatim:
 *                silence is not "none". Nobody has looked at this table.
 *   undecided  — a register row that says so, carrying the question. Also a refusal, and the
 *                difference from the above is everything: this is an agenda item, not a bug.
 *   orphaned   — a register row for a table that no longer exists, so the register's claim to
 *                completeness can no longer be reconciled against the schema.
 *   not_stopped — asked for a tenant the ERP has not deleted. Allowed as an ADVISORY plan,
 *                refused as an actionable one, because a plan that reads the same before and
 *                after a deletion is one somebody will mistake for authorisation.
 */

export interface TablePlan {
  readonly table: string;
  readonly disposition: Extract<Disposition, "erase" | "retain">;
  readonly rows: number;
  readonly obligation?: RetentionObligation;
  readonly obligationNote?: string;
  readonly retainedReference?: string;
}

export type PlanRefusal =
  | { readonly kind: "undeclared"; readonly tables: readonly string[] }
  | { readonly kind: "undecided"; readonly questions: readonly { table: string; question: string }[] }
  | { readonly kind: "orphaned"; readonly tables: readonly string[] }
  | { readonly kind: "not_stopped"; readonly status: string | null }
  /**
   * A table that would be KEPT references a table that would be ERASED.
   *
   * The refusal the FK graph makes mandatory, and the cascading edges are why it cannot be
   * skipped. A `RESTRICT` edge from a retained child to an erased parent refuses the DELETE:
   * loud, and the whole transaction rolls back. A `CASCADE` edge DESTROYS the retained child
   * — silently, with no attestation, inside a transaction that then commits a signed proof
   * saying those rows were lawfully kept. `crm.call_plan_product -> crm.call_plan` and
   * `crm.visit_product -> crm.visit` are both `CASCADE` today, so this is not hypothetical:
   * it is the first mistake a half-answered register will produce.
   */
  | {
      readonly kind: "retained_child_of_erased";
      readonly edges: readonly { child: string; parent: string; onDelete: string }[];
    }
  /** A cycle in the FK graph among the tables to erase, so no delete order exists. */
  | { readonly kind: "cyclic_erase_order"; readonly tables: readonly string[] };

export interface ErasurePlan {
  readonly tenantId: string;
  /**
   * Whether this plan may be acted on. False means every refusal below has to be answered
   * first — and an advisory plan is still worth printing, because "here are the 19 questions
   * Compliance owes you" is the most useful thing this code can say today.
   */
  readonly actionable: boolean;
  readonly refusals: readonly PlanRefusal[];
  readonly erase: readonly TablePlan[];
  readonly retain: readonly TablePlan[];
  readonly eraseRows: number;
  readonly retainRows: number;
  /** The ERP tombstone this plan is downstream of, when there is one. */
  readonly tombstoneId: string | null;
  readonly tenantStatus: string | null;
  /**
   * The order the erases must happen in: children before their parents.
   *
   * Computed rather than written down, because `crm.rep_profile` is the parent of eleven
   * tables and the graph moves with every migration. Children first even where a `CASCADE`
   * would remove them anyway — not for the delete's correctness but for the FIGURES': a child
   * removed by its parent's cascade reports zero rows erased while its rows are gone, and that
   * zero goes into a hash. A proof is only as good as its least careful number.
   */
  readonly eraseOrder: readonly string[];
  /** Every table the register governs, which is what an attestation list is checked against. */
  readonly inScope: readonly string[];
  /**
   * The receipt stores (0054): in the register, and NOT in a receipt's scope, because the
   * transaction that signs an attestation about them is the one that writes their rows.
   */
  readonly excludedTables: readonly string[];
}

interface DispositionRow {
  readonly table_name: string;
  readonly disposition: Disposition;
  readonly obligation: string | null;
  readonly obligation_note: string | null;
  readonly retained_reference: string | null;
  readonly question: string | null;
  readonly is_receipt_store: boolean;
}

/**
 * Counts every table's rows for one tenant in ONE query, and the "one" is load-bearing.
 *
 * Thirty-nine separate counts are thirty-nine moments. A plan whose figures were taken at
 * different instants cannot be reconciled with anything — and the figures are the part a
 * tombstone will eventually commit to by hash, which is the ERP's `rowCount` in
 * `erasureDeletionScope`. One statement is one snapshot.
 *
 * The table names are interpolated, and that is safe by construction rather than by trust:
 * every one comes from `crm.data_disposition.table_name`, whose CHECK is
 * `^[a-z][a-z0-9_]{2,62}$` and whose trigger refuses a name that is not a real tenant-scoped
 * table in `crm`. They are quoted anyway, because defence that costs nothing is free.
 */
async function countRows(
  tx: PoolClient,
  tenantId: string,
  tables: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (tables.length === 0) return new Map();
  const parts = tables.map(
    (t) => `SELECT '${t}' AS t, count(*)::bigint AS n FROM crm."${t}" WHERE tenant_id = $1`,
  );
  const { rows } = await tx.query<{ t: string; n: string }>(parts.join(" UNION ALL "), [tenantId]);
  return new Map(rows.map((r) => [r.t, Number(r.n)]));
}

export class NoTenantContextError extends Error {
  constructor(tenantId: string, actual: string | null) {
    super(
      `planTenantErasureWithin needs a client already inside withTenantContext(${tenantId}), but ` +
        `app.current_tenant_id is ${actual === null || actual === "" ? "unset" : actual}. Every count it ` +
        `takes is of a table under FORCE row-level security, so without the context the answer is not ` +
        `an error — it is ZERO for every table, and a plan reporting nothing to erase is the most ` +
        `dangerous wrong answer this module can give.`,
    );
    this.name = "NoTenantContextError";
  }
}

/**
 * Builds the plan.
 *
 * Reads the register, the completeness functions and the tenant's own row, then counts. The
 * refusals are gathered rather than thrown one at a time, because an operator asking "what
 * stands between us and being able to do this" wants the whole list, not the first item.
 */
export async function planTenantErasure(client: PoolClient, tenantId: string): Promise<ErasurePlan> {
  return await withTenantContext(client, tenantId, (tx) => planTenantErasureWithin(tx, tenantId));
}

/**
 * The same plan, on a client that is ALREADY inside the tenant's context.
 *
 * Two entry points rather than one that guesses, and the split was forced by a real bug: the
 * executor opens one transaction for the whole erasure, called `planTenantErasure` inside it,
 * and `withTenantContext` refused — correctly, because the inner `COMMIT` would have ended the
 * executor's transaction and destroyed the atomicity the receipt depends on. Before that guard
 * existed this would have shipped silently.
 *
 * The naming follows the ERP's `appendWithin(tx, …)`, which exists for the same reason: a
 * caller that needs its work and this work in one transaction has to be able to hand over the
 * transaction rather than have one opened under it.
 *
 * IT ASSERTS THE CONTEXT rather than trusting the caller, and that assertion is the point of
 * the function being public at all. Every count below is of a table under FORCE row-level
 * security, so a client without the context does not fail — it answers ZERO for every table,
 * and a plan that reports nothing to erase is the worst wrong answer available here. Fail
 * closed means noticing that the question was never really asked.
 */
export async function planTenantErasureWithin(
  tx: PoolClient,
  tenantId: string,
): Promise<ErasurePlan> {
  const { rows: ctx } = await tx.query<{ current: string | null }>(
    "SELECT current_setting('app.current_tenant_id', true) AS current",
  );
  const current = ctx[0]?.current ?? null;
  if (current !== tenantId) throw new NoTenantContextError(tenantId, current);

  const client = tx;
  const refusals: PlanRefusal[] = [];

  const { rows: tenantRows } = await client.query<{ status: string; erp_tombstone_id: string | null }>(
    "SELECT status, erp_tombstone_id FROM crm.tenant WHERE tenant_id = $1",
    [tenantId],
  );
  const tenantStatus = tenantRows[0]?.status ?? null;
  const tombstoneId = tenantRows[0]?.erp_tombstone_id ?? null;
  if (tenantStatus !== "erp_deleted") {
    refusals.push({ kind: "not_stopped", status: tenantStatus });
  }

  const { rows: undeclared } = await client.query<{ t: string }>(
    "SELECT t FROM crm.undeclared_tenant_tables() AS t",
  );
  if (undeclared.length > 0) refusals.push({ kind: "undeclared", tables: undeclared.map((r) => r.t) });

  const { rows: orphans } = await client.query<{ t: string }>(
    "SELECT t FROM crm.disposition_orphans() AS t",
  );
  if (orphans.length > 0) refusals.push({ kind: "orphaned", tables: orphans.map((r) => r.t) });

  const { rows: register } = await client.query<DispositionRow>(
    `SELECT table_name, disposition, obligation, obligation_note, retained_reference, question,
            is_receipt_store
       FROM crm.data_disposition ORDER BY table_name`,
  );

  // Split off the receipt stores before anything else looks at the register. They stay in it —
  // 0051's completeness guard is over every tenant-scoped table and has no exceptions — but a
  // receipt neither counts them nor speaks about them.
  const excludedTables = register.filter((r) => r.is_receipt_store).map((r) => r.table_name).sort();
  const governed = register.filter((r) => !r.is_receipt_store);

  const undecided = governed.filter((r) => r.disposition === "undecided");
  if (undecided.length > 0) {
    refusals.push({
      kind: "undecided",
      questions: undecided.map((r) => ({ table: r.table_name, question: r.question ?? "" })),
    });
  }

  // Counted for the DECIDED tables only. Counting an undecided table would put a number in
  // front of somebody who has not been told what the number means, and the first thing anyone
  // does with "crm.visit: 4,312 rows" is decide it is too many to keep.
  const decided = governed.filter((r) => r.disposition !== "undecided");
  const counts = await countRows(
    client,
    tenantId,
    decided.map((r) => r.table_name),
  );

  const toPlan = (r: DispositionRow): TablePlan => ({
    table: r.table_name,
    disposition: r.disposition === "retain" ? "retain" : "erase",
    rows: counts.get(r.table_name) ?? 0,
    ...(r.obligation !== null ? { obligation: r.obligation as RetentionObligation } : {}),
    ...(r.obligation_note !== null ? { obligationNote: r.obligation_note } : {}),
    ...(r.retained_reference !== null ? { retainedReference: r.retained_reference } : {}),
  });

  const erase = decided.filter((r) => r.disposition === "erase").map(toPlan);
  const retain = decided.filter((r) => r.disposition === "retain").map(toPlan);

  // The FK graph, read from the catalog inside the same call, because both rules below are
  // properties of the schema as it is now rather than of the register.
  const { rows: edges } = await client.query<{ child: string; parent: string; on_delete: string }>(
    "SELECT child, parent, on_delete FROM crm.tenant_table_fk_edges()",
  );

  const eraseSet = new Set(erase.map((t) => t.table));
  const keptSet = new Set(retain.map((t) => t.table));
  const dangling = edges
    .filter((e) => keptSet.has(e.child) && eraseSet.has(e.parent))
    .map((e) => ({ child: e.child, parent: e.parent, onDelete: e.on_delete }));
  if (dangling.length > 0) refusals.push({ kind: "retained_child_of_erased", edges: dangling });

  const { order: eraseOrder, cycle } = eraseDeleteOrder(eraseSet, edges);
  if (cycle.length > 0) refusals.push({ kind: "cyclic_erase_order", tables: cycle });

  return {
    tenantId,
    actionable: refusals.length === 0,
    refusals,
    erase,
    retain,
    eraseRows: erase.reduce((a, t) => a + t.rows, 0),
    retainRows: retain.reduce((a, t) => a + t.rows, 0),
    tombstoneId,
    tenantStatus,
    eraseOrder,
    inScope: governed.map((r) => r.table_name),
    excludedTables,
  };
}

/**
 * Children before parents, among the tables being erased.
 *
 * Kahn's algorithm over the edges confined to the erase set — an edge to a table that is not
 * being erased constrains nothing, and including it would make every erase set with a retained
 * parent look cyclic. Deterministic: ready tables are taken in name order, so the same schema
 * and the same register always produce the same order and a reader comparing two runs sees a
 * real difference rather than a scheduling one.
 *
 * A cycle cannot be ordered and is reported rather than broken. There is none today; a schema
 * that grew one would need deferrable constraints and a decision nobody has made.
 */
export function eraseDeleteOrder(
  eraseSet: ReadonlySet<string>,
  edges: readonly { child: string; parent: string }[],
): { readonly order: readonly string[]; readonly cycle: readonly string[] } {
  const inside = edges.filter((e) => eraseSet.has(e.child) && eraseSet.has(e.parent) && e.child !== e.parent);
  // A table's "dependents" must go first, so we count, for each table, how many of its own
  // parents are still waiting — a table is ready once nothing it references is left.
  const parentsOf = new Map<string, Set<string>>();
  const childrenOf = new Map<string, Set<string>>();
  for (const t of eraseSet) {
    parentsOf.set(t, new Set());
    childrenOf.set(t, new Set());
  }
  for (const e of inside) {
    parentsOf.get(e.child)?.add(e.parent);
    childrenOf.get(e.parent)?.add(e.child);
  }

  const order: string[] = [];
  const remaining = new Set(eraseSet);
  // Ready = nothing still references it. Those are deleted first: a child with no dependents
  // of its own can go, then its parent once every child has gone.
  for (;;) {
    const ready = [...remaining]
      .filter((t) => [...(childrenOf.get(t) ?? [])].every((c) => !remaining.has(c)))
      .sort();
    if (ready.length === 0) break;
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return { order, cycle: [...remaining].sort() };
}

/** One line per refusal, in the words an operator has to act on. */
export function describeRefusal(r: PlanRefusal): string {
  switch (r.kind) {
    case "not_stopped":
      return `the ERP has not deleted this tenant (crm.tenant says ${r.status ?? "it is not in the registry at all"}), so this plan is ADVISORY: it says what would happen, and authorises nothing`;
    case "undeclared":
      return `${String(r.tables.length)} tenant-scoped table(s) have no entry in crm.data_disposition, so nobody has decided about them: ${r.tables.join(", ")}. Silence is not "none".`;
    case "orphaned":
      return `crm.data_disposition names ${String(r.tables.length)} table(s) that no longer exist: ${r.tables.join(", ")}. The register can no longer be reconciled against the schema.`;
    case "undecided":
      return `${String(r.questions.length)} table(s) are declared undecided and need an answer before anything is erased: ${r.questions.map((q) => q.table).join(", ")}`;
    case "retained_child_of_erased":
      return (
        `${String(r.edges.length)} retained table(s) reference a table that would be erased: ` +
        r.edges.map((e) => `${e.child} -> ${e.parent} (ON DELETE ${e.onDelete})`).join(", ") +
        `. A RESTRICT edge would refuse the delete; a CASCADE edge would DESTROY the retained ` +
        `rows with no attestation while the receipt claimed they were kept. Decide the parent ` +
        `the same way as the child, or the child the same way as the parent.`
      );
    case "cyclic_erase_order":
      return `the tables to erase contain a foreign-key cycle, so no delete order exists: ${r.tables.join(", ")}`;
  }
}
