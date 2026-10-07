import type { PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import { describeRefusal, planTenantErasureWithin, type ErasurePlan } from "./plan.js";
import {
  assembleTombstone,
  newCrmTombstoneId,
  type CrmTombstone,
  type ManifestVersion,
  type TableAttestation,
} from "./tombstone.js";
import type { RetentionObligation } from "./obligations.js";

/**
 * Performs the erasure and writes the receipt, in ONE transaction.
 *
 * ADR-0319's property, and the reason there is no two-step version of this function: a deletion
 * that commits without its proof is unprovable, and a proof that commits without its deletion
 * is false. No ordering of two transactions avoids both, so there is one — every `DELETE`,
 * every attestation and the tombstone row together, or nothing.
 *
 * THE TRANSACTION IS `withTenantContext`'S, not one opened around it, and that is now enforced
 * rather than merely intended: the wrapper refuses a client already inside a transaction
 * (`TransactionAlreadyOpenError`), because its `COMMIT` would otherwise end the caller's. So
 * the only way to get atomicity here is to do all the work inside one wrapped call — which is
 * also the only way to have RLS confine every statement to the tenant being erased.
 *
 * It is RE-PLANNED inside that transaction rather than trusting a plan computed outside it. A
 * plan an operator read five minutes ago is a statement about the register and the data as they
 * were; between then and now a disposition could have been amended, a table added, or rows
 * written. The plan the deletion acts on is the one taken under the same snapshot as the
 * deletion itself.
 */

export class ErasureRefusedError extends Error {
  constructor(readonly plan: ErasurePlan) {
    super(
      `refusing to erase tenant ${plan.tenantId}: ${String(plan.refusals.length)} thing(s) stand in the way — ` +
        plan.refusals.map((r) => describeRefusal(r)).join(" | "),
    );
    this.name = "ErasureRefusedError";
  }
}

export interface ExecuteErasureOptions {
  readonly executedBy: string;
  readonly approvedBy: string;
  /** Injected so a test can pin the hashes instead of racing the clock. */
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ErasureResult {
  readonly tombstone: CrmTombstone;
  /** The order the deletes actually ran in, for the log line and for a reader asking why. */
  readonly eraseOrder: readonly string[];
}

/**
 * Deletes one table's rows for one tenant, and reports what it actually removed.
 *
 * The table name is interpolated, safely by construction rather than by trust: it comes from
 * `crm.data_disposition.table_name`, whose CHECK is `^[a-z][a-z0-9_]{2,62}$` and whose trigger
 * refuses a name that is not a real tenant-scoped table in `crm`. Quoted anyway.
 *
 * `rowCount` is the count THIS statement removed, which is the number the attestation carries
 * and the hash commits to — not a count taken before, which a concurrent write could falsify
 * between the counting and the deleting.
 */
async function eraseTable(tx: PoolClient, tenantId: string, table: string): Promise<number> {
  const { rowCount } = await tx.query(`DELETE FROM crm."${table}" WHERE tenant_id = $1`, [tenantId]);
  return rowCount ?? 0;
}

async function countTable(tx: PoolClient, tenantId: string, table: string): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM crm."${table}" WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function executeTenantErasure(
  client: PoolClient,
  tenantId: string,
  options: ExecuteErasureOptions,
): Promise<ErasureResult> {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? newCrmTombstoneId;

  return await withTenantContext(client, tenantId, async (tx) => {
    // `…Within`, not `planTenantErasure`: this transaction is already open and the wrapping
    // form would refuse (and, before that guard existed, would have COMMITTED this transaction
    // halfway through, leaving the erasure committed and the receipt never written).
    const plan = await planTenantErasureWithin(tx, tenantId);
    if (!plan.actionable) throw new ErasureRefusedError(plan);
    // `actionable` implies the tenant is `erp_deleted`, which 0050 implies carries a receipt.
    // Asserted rather than assumed because the whole chain of authority hangs off it.
    const erpTombstoneId = plan.tombstoneId;
    if (erpTombstoneId === null) {
      throw new ErasureRefusedError(plan);
    }

    const attestations: TableAttestation[] = [];

    // ERASE FIRST, in the computed order, so that a later count of a retained table is taken
    // after every deletion that could have cascaded into it. Nothing should — the plan refuses
    // a retained child of an erased parent — and counting afterwards is what makes the receipt
    // honest even if that guard were ever wrong.
    const erasePlanByTable = new Map(plan.erase.map((t) => [t.table, t]));
    for (const table of plan.eraseOrder) {
      const removed = await eraseTable(tx, tenantId, table);
      attestations.push(
        removed === 0
          ? { table, outcome: "nothing_to_erase" }
          : { table, outcome: "erased", rowsErased: removed },
      );
    }
    // Every erase-dispositioned table must have appeared in the order, or the receipt would be
    // silent about one. `assembleTombstone` would catch it; this names the cause.
    for (const table of erasePlanByTable.keys()) {
      if (!plan.eraseOrder.includes(table)) {
        throw new Error(
          `erase order omitted ${table}, which the register says to erase — refusing before any receipt is written`,
        );
      }
    }

    for (const t of plan.retain) {
      const remaining = await countTable(tx, tenantId, t.table);
      attestations.push(
        remaining === 0
          ? // A `retain` disposition over an empty table held nothing, so it says so. "We are
            // lawfully keeping it" about zero rows reads as evidence and is not.
            { table: t.table, outcome: "nothing_to_erase" }
          : {
              table: t.table,
              outcome: "retained",
              rowsRetained: remaining,
              ...(t.obligation !== undefined ? { obligation: t.obligation as RetentionObligation } : {}),
              ...(t.obligationNote !== undefined ? { obligationNote: t.obligationNote } : {}),
              ...(t.retainedReference !== undefined ? { retainedReference: t.retainedReference } : {}),
            },
      );
    }

    const tombstone = assembleTombstone({
      tenantId,
      erpTombstoneId,
      deletedAt: now().toISOString(),
      executedBy: options.executedBy,
      approvedBy: options.approvedBy,
      inScope: plan.inScope,
      attestations,
      excludedTables: plan.excludedTables,
      id: newId(),
    });

    await tx.query(
      `INSERT INTO crm.tenant_tombstone
         (id, tenant_id, erp_tombstone_id, deleted_at, content_manifest_sha256, proof_sha256,
          executed_by, approved_by, rows_erased, rows_retained, excluded_tables, manifest_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12)`,
      [
        tombstone.id,
        tenantId,
        tombstone.erpTombstoneId,
        tombstone.deletedAt,
        tombstone.contentManifestSha256,
        tombstone.proofSha256,
        tombstone.executedBy,
        tombstone.approvedBy,
        tombstone.rowsErased,
        tombstone.rowsRetained,
        [...tombstone.excludedTables],
        tombstone.manifestVersion,
      ],
    );

    for (const a of tombstone.attestations) {
      await tx.query(
        `INSERT INTO crm.tenant_tombstone_attestation
           (tenant_id, tombstone_id, table_name, outcome, rows_erased, rows_retained,
            obligation, obligation_note, retained_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId,
          tombstone.id,
          a.table,
          a.outcome,
          a.rowsErased ?? null,
          a.rowsRetained ?? null,
          a.obligation ?? null,
          a.obligationNote ?? null,
          a.retainedReference ?? null,
        ],
      );
    }

    return { tombstone, eraseOrder: plan.eraseOrder };
  });
}

/** Reads back a stored receipt, in the shape `verifyTombstone` checks. */
export async function readTenantTombstones(
  client: PoolClient,
  tenantId: string,
): Promise<readonly CrmTombstone[]> {
  return await withTenantContext(client, tenantId, async (tx) => {
    const { rows: heads } = await tx.query<{
      id: string;
      erp_tombstone_id: string;
      deleted_at: Date;
      content_manifest_sha256: string;
      proof_sha256: string;
      executed_by: string;
      approved_by: string;
      rows_erased: number;
      rows_retained: number;
      excluded_tables: string[];
      manifest_version: ManifestVersion;
    }>(
      `SELECT id, erp_tombstone_id, deleted_at, content_manifest_sha256, proof_sha256,
              executed_by, approved_by, rows_erased, rows_retained, excluded_tables,
              manifest_version
         FROM crm.tenant_tombstone WHERE tenant_id = $1 ORDER BY seq`,
      [tenantId],
    );

    const out: CrmTombstone[] = [];
    for (const h of heads) {
      const { rows: as } = await tx.query<{
        table_name: string;
        outcome: TableAttestation["outcome"];
        rows_erased: number | null;
        rows_retained: number | null;
        obligation: string | null;
        obligation_note: string | null;
        retained_reference: string | null;
      }>(
        `SELECT table_name, outcome, rows_erased, rows_retained, obligation, obligation_note,
                retained_reference
           FROM crm.tenant_tombstone_attestation
          WHERE tenant_id = $1 AND tombstone_id = $2
          ORDER BY table_name`,
        [tenantId, h.id],
      );
      out.push({
        id: h.id,
        tenantId,
        erpTombstoneId: h.erp_tombstone_id,
        // The hash committed to an ISO string, so the comparison has to be made against one.
        deletedAt: h.deleted_at.toISOString(),
        contentManifestSha256: h.content_manifest_sha256,
        proofSha256: h.proof_sha256,
        executedBy: h.executed_by,
        approvedBy: h.approved_by,
        rowsErased: h.rows_erased,
        rowsRetained: h.rows_retained,
        excludedTables: h.excluded_tables,
        manifestVersion: h.manifest_version,
        attestations: as.map((a) => ({
          table: a.table_name,
          outcome: a.outcome,
          ...(a.rows_erased !== null ? { rowsErased: a.rows_erased } : {}),
          ...(a.rows_retained !== null ? { rowsRetained: a.rows_retained } : {}),
          ...(a.obligation !== null ? { obligation: a.obligation as RetentionObligation } : {}),
          ...(a.obligation_note !== null ? { obligationNote: a.obligation_note } : {}),
          ...(a.retained_reference !== null ? { retainedReference: a.retained_reference } : {}),
        })),
      });
    }
    return out;
  });
}
