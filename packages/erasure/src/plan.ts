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
  | { readonly kind: "not_stopped"; readonly status: string | null };

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
}

interface DispositionRow {
  readonly table_name: string;
  readonly disposition: Disposition;
  readonly obligation: string | null;
  readonly obligation_note: string | null;
  readonly retained_reference: string | null;
  readonly question: string | null;
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
  client: PoolClient,
  tenantId: string,
  tables: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (tables.length === 0) return new Map();
  const parts = tables.map(
    (t) => `SELECT '${t}' AS t, count(*)::bigint AS n FROM crm."${t}" WHERE tenant_id = $1`,
  );
  const { rows } = await withTenantContext(client, tenantId, (tx) =>
    tx.query<{ t: string; n: string }>(parts.join(" UNION ALL "), [tenantId]),
  );
  return new Map(rows.map((r) => [r.t, Number(r.n)]));
}

/**
 * Builds the plan.
 *
 * Reads the register, the completeness functions and the tenant's own row, then counts. The
 * refusals are gathered rather than thrown one at a time, because an operator asking "what
 * stands between us and being able to do this" wants the whole list, not the first item.
 */
export async function planTenantErasure(client: PoolClient, tenantId: string): Promise<ErasurePlan> {
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
    `SELECT table_name, disposition, obligation, obligation_note, retained_reference, question
       FROM crm.data_disposition ORDER BY table_name`,
  );

  const undecided = register.filter((r) => r.disposition === "undecided");
  if (undecided.length > 0) {
    refusals.push({
      kind: "undecided",
      questions: undecided.map((r) => ({ table: r.table_name, question: r.question ?? "" })),
    });
  }

  // Counted for the DECIDED tables only. Counting an undecided table would put a number in
  // front of somebody who has not been told what the number means, and the first thing anyone
  // does with "crm.visit: 4,312 rows" is decide it is too many to keep.
  const decided = register.filter((r) => r.disposition !== "undecided");
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
  };
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
  }
}
