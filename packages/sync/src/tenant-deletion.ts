import type { PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { readTenantDeletionVerdict, type TenantDeletionVerdict, type TombstoneReader } from "@crm/acl";

/**
 * Watching for the one thing the ERP can tell us that stops everything.
 *
 * `packages/acl`'s classifier decides WHAT the ERP said; this decides what the CRM does
 * about it, which is two statements in one transaction: record the observation, and — only
 * for a `tenant_deletion` tombstone — mark the tenant `erp_deleted` with the receipt under
 * it. Migration 0050 makes that mark terminal and refuses it without the receipt, so this
 * module cannot quarantine a tenant by deciding to.
 *
 * It lives in `@crm/sync` because this is the same kind of thing as a snapshot refresh — a
 * fact learned from the ERP and written down — and not in `@crm/scheduler`, which owns when
 * work happens and not what it means.
 *
 * WHAT MARKING COSTS, stated here because the caller cannot see it: `crm.tenant` is where
 * the scheduler enumerates whose work to do (`WHERE status = 'active'`), so the mark removes
 * the tenant from every job at once — the ERP relay, both snapshots, the expiry sweep,
 * notification dispatch and pruning, and the expense posting. That is the intent. A tenant
 * whose controller relationship has ended is one whose data we stop processing, and the
 * webhook dispatch in particular is a disclosure to a third party that must not outlive the
 * deletion by one tick.
 *
 * IT DOES NOT ERASE ANYTHING. See 0050's header: the CRM's copies may include records some
 * jurisdiction requires us to keep, and the vocabulary for "not deleted, and here is why" is
 * what the ERP calls a `retentionObligation`. Until the CRM has that, erasing would be
 * guessing and keeping-while-stopped is the defensible half.
 */

export interface TenantDeletionWatchResult {
  readonly tenantId: string;
  readonly verdict: TenantDeletionVerdict["verdict"];
  readonly httpStatus: number | null;
  readonly detail: string | null;
  /** True only on the transition — the check that first marked it, not every later one. */
  readonly marked: boolean;
  readonly tombstoneId: string | null;
}

/**
 * Records one observation, and marks the tenant when the observation is a deletion.
 *
 * ONE TRANSACTION, deliberately. The alternative — mark, then log — can leave a tenant
 * stopped with no recorded reason, which is the single worst state here: every job silently
 * does nothing for them and the table that would explain it is empty. Logged-but-not-marked
 * is recoverable by the next tick; marked-but-not-logged is a mystery.
 *
 * The UPDATE is guarded on `status <> 'erp_deleted'`, so a second deletion verdict is a
 * no-op rather than an error from 0050's write-once trigger — and `marked` reports which it
 * was, because "we just stopped a tenant" and "we confirmed one we already stopped" are
 * different lines in a log.
 *
 * `crm.tenant` is the deliberately RLS-exempt registry, so this writes it from inside the
 * tenant context without needing an exemption: there is no policy to satisfy. The check log
 * beside it IS tenant-scoped and under RLS, which is why both statements run in one
 * `withTenantContext`.
 */
export async function recordTenantDeletionCheck(
  client: PoolClient,
  tenantId: string,
  verdict: TenantDeletionVerdict,
): Promise<TenantDeletionWatchResult> {
  return await withTenantContext(client, tenantId, async (tx) => {
    const detail = verdict.verdict === "unknown" ? verdict.detail : null;
    await tx.query(
      `INSERT INTO crm.tenant_deletion_check (tenant_id, verdict, http_status, detail)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, verdict.verdict, verdict.httpStatus, detail],
    );

    if (verdict.verdict !== "deleted") {
      return {
        tenantId,
        verdict: verdict.verdict,
        httpStatus: verdict.httpStatus,
        detail,
        marked: false,
        tombstoneId: null,
      };
    }

    const t = verdict.tombstone;
    const { rowCount } = await tx.query(
      `UPDATE crm.tenant
          SET status                         = 'erp_deleted',
              erp_tombstone_id               = $2,
              erp_tombstone_kind             = $3,
              erp_tombstone_deleted_at       = $4,
              erp_tombstone_proof_sha256     = $5,
              erp_tombstone_chain_entry_hash = $6,
              erp_tombstone_observed_at      = now(),
              updated_at                     = now()
        WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
      [tenantId, t.tombstoneId, t.kind, t.deletedAt, t.proofSha256, t.chainEntryHash],
    );

    return {
      tenantId,
      verdict: "deleted",
      httpStatus: verdict.httpStatus,
      detail: null,
      // Zero rows means either already marked, or — the case worth not hiding — no registry
      // row at all. The second is reported by the caller as a refusal rather than silently,
      // because a tenant the scheduler works but the registry does not list cannot be stopped
      // by a status nobody reads.
      marked: rowCount === 1,
      tombstoneId: t.tombstoneId,
    };
  });
}

/** Whether `crm.tenant` lists this tenant at all, and what it currently says. */
export async function tenantRegistryStatus(
  client: PoolClient,
  tenantId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ status: string }>(
    "SELECT status FROM crm.tenant WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]?.status ?? null;
}

export class TenantNotRegisteredError extends Error {
  constructor(readonly tenantId: string) {
    super(
      `tenant ${tenantId} has a tenant_deletion tombstone at the ERP and no row in crm.tenant, ` +
        `so there is nothing to mark erp_deleted. The observation is recorded; the tenant is NOT stopped.`,
    );
    this.name = "TenantNotRegisteredError";
  }
}

/**
 * The job body: ask the ERP, write down the answer, stop the tenant if the answer says to.
 *
 * Refuses rather than returning quietly when a deletion lands on an unregistered tenant,
 * because that is the one outcome where the signal worked and the consequence did not — and
 * a job that reports success there would leave every other job happily processing a deleted
 * tenant's data with a `deleted` row in the check log saying everything was fine.
 */
export async function watchTenantDeletion(
  client: PoolClient,
  reader: TombstoneReader,
  tenantId: string,
): Promise<TenantDeletionWatchResult> {
  const verdict = await readTenantDeletionVerdict(reader, tenantId);
  const result = await recordTenantDeletionCheck(client, tenantId, verdict);
  if (result.verdict === "deleted" && !result.marked) {
    const current = await tenantRegistryStatus(client, tenantId);
    if (current === null) throw new TenantNotRegisteredError(tenantId);
  }
  return result;
}

/** One line for the scheduler's log. */
export function summariseTenantDeletionWatch(r: TenantDeletionWatchResult): string {
  const status = r.httpStatus === null ? "no-answer" : String(r.httpStatus);
  if (r.verdict === "deleted") {
    return r.marked
      ? `verdict=deleted STOPPED tenant tombstone=${r.tombstoneId ?? "?"}`
      : `verdict=deleted already-stopped tombstone=${r.tombstoneId ?? "?"}`;
  }
  if (r.verdict === "live") return `verdict=live http=${status}`;
  return `verdict=unknown http=${status} detail="${r.detail ?? ""}"`;
}
