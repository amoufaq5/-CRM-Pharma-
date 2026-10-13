import type { Pool, PoolClient } from "pg";
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
  /**
   * Queued work settled `abandoned` in the same transaction that stopped the tenant (0068).
   *
   * Zero on every verdict but a transition to `deleted`, and zero on most of those too — a tenant
   * with an empty queue is the ordinary case. Non-zero is the interesting line: these are writes
   * the ERP will never receive and pushes a third party will never get, settled rather than left
   * `pending` forever.
   */
  readonly abandonedOutbox: number;
  readonly abandonedDeliveries: number;
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
        // Zero rather than omitted, so a caller reading a result cannot find the field missing:
        // "this check settled nothing" is the answer for every verdict but a transition, and it
        // is an answer rather than an absence.
        abandonedOutbox: 0,
        abandonedDeliveries: 0,
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
    const marked = rowCount === 1;

    // 0068. THE QUEUE IS SETTLED IN THE SAME TRANSACTION THAT STOPS THE TENANT, so there is
    // never an instant in which a deleted tenant has live pending work. The alternative — mark
    // now, settle on the next platform tick — leaves a day's window in which `crm.outbox` and
    // `crm.notification_delivery` hold rows nothing will ever send and nothing says so, which is
    // the state ADR-0001's open row described as "unbounded and nobody decided it".
    //
    // ONLY ON THE TRANSITION. A second deletion verdict for an already-stopped tenant settles
    // nothing, because the first one already did and `abandon_stopped_tenant_work` touches only
    // `pending` and `in_flight`. Guarding on `marked` as well is belt and braces, and it keeps
    // this transaction short on the overwhelmingly common path.
    const settled = marked
      ? await abandonStoppedTenantWork(tx, tenantId)
      : { tenantId, outboxRows: 0, deliveryRows: 0 };

    return {
      tenantId,
      verdict: "deleted",
      httpStatus: verdict.httpStatus,
      detail: null,
      // Zero rows means either already marked, or — the case worth not hiding — no registry
      // row at all. The second is reported by the caller as a refusal rather than silently,
      // because a tenant the scheduler works but the registry does not list cannot be stopped
      // by a status nobody reads.
      marked,
      tombstoneId: t.tombstoneId,
      abandonedOutbox: settled.outboxRows,
      abandonedDeliveries: settled.deliveryRows,
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
    // 0068. What the mark SETTLED, appended only when it settled something — the convention
    // every line in this process follows, because a zero that is always there is a zero nobody
    // sees. On a transition it is the consequence an operator most wants: this many writes the
    // ERP will never receive, and this many pushes a third party will never get.
    const settled =
      r.abandonedOutbox + r.abandonedDeliveries > 0
        ? ` ABANDONED=${String(r.abandonedOutbox + r.abandonedDeliveries)}` +
          ` outbox=${String(r.abandonedOutbox)} deliveries=${String(r.abandonedDeliveries)}`
        : "";
    return r.marked
      ? `verdict=deleted STOPPED tenant tombstone=${r.tombstoneId ?? "?"}${settled}`
      : `verdict=deleted already-stopped tombstone=${r.tombstoneId ?? "?"}`;
  }
  if (r.verdict === "live") return `verdict=live http=${status}`;
  return `verdict=unknown http=${status} detail="${r.detail ?? ""}"`;
}

/**
 * Settles the queued work of a tenant the ERP has deleted (0068).
 *
 * `abandoned`, NOT `dead`, and the distinction is the whole of it. `dead` means a destination
 * refused us or we gave up after the attempt cap: it is the state `crm.outbox_dead_letter` keeps a
 * history for, the state the dead-letter listing offers an operator to RETRY, and the state the
 * alarm counts — and that alarm raises `erp_write_failed` AT A REP. Marking these `dead` would
 * put writes nobody will ever make in front of somebody to retry, and notify the reps of a tenant
 * that no longer exists, which is the disclosure 0050 stopped arriving one tick later by a
 * different door.
 *
 * The database refuses this for a live tenant, by name, and that is the guard that matters: this
 * function's job is to make queued work unsendable, so running it against an active tenant would
 * destroy that tenant's pending ERP writes and notifications. It is checked against `crm.tenant`
 * rather than against an argument, because a caller that could assert "this tenant is deleted"
 * would be a caller that could be wrong about it.
 */
export interface AbandonResult {
  readonly tenantId: string;
  readonly outboxRows: number;
  readonly deliveryRows: number;
}

export async function abandonStoppedTenantWork(
  tx: PoolClient,
  tenantId: string,
): Promise<AbandonResult> {
  const { rows } = await tx.query<{ outbox_rows: string; delivery_rows: string }>(
    "SELECT outbox_rows, delivery_rows FROM crm.abandon_stopped_tenant_work($1)",
    [tenantId],
  );
  const row = rows[0]!;
  return {
    tenantId,
    outboxRows: Number(row.outbox_rows),
    deliveryRows: Number(row.delivery_rows),
  };
}

export interface StoppedTenantWork {
  readonly tenantId: string;
  readonly outboxRows: number;
  readonly deliveryRows: number;
}

export interface AbandonSweepResult {
  readonly stoppedTenants: number;
  readonly settledTenants: number;
  readonly outboxRows: number;
  readonly deliveryRows: number;
  /** Tenants whose queue could not be read or settled. Not a count of zero — see the note. */
  readonly unreadable: readonly string[];
  readonly summary: string;
}

/**
 * The platform sweep: every stopped tenant, settled.
 *
 * THE BACKSTOP AND NOT THE MECHANISM. `watchTenantDeletion` settles in the same transaction that
 * stops the tenant, so there is never an instant in which a deleted tenant has live pending work.
 * This exists for the rows of a tenant stopped BEFORE 0068 shipped, or stopped by hand in SQL —
 * which 0053's rules permit and this repository's own fixtures do. On a healthy deployment it
 * settles nothing, every night, and says so.
 *
 * ONE SHORT TRANSACTION PER TENANT, like `checkChannelCoverage` and 0067's receipt sweep: the
 * tables are RLS-FORCEd, so a cross-tenant pass would see nothing — correctly, silently, and
 * reporting every deployment clean. The enumeration comes from `crm.tenant`, the one registry with
 * no policy.
 *
 * A tenant whose settle fails does NOT fail the sweep. Its id goes in `unreadable`, because "we
 * could not look" and "there was nothing there" are the two answers an integrity report must never
 * conflate — 0066's rule, and `ChannelCoverageReport.unreadable`'s before it.
 */
export async function sweepAbandonStoppedWork(
  pool: Pool,
  opts: { readonly settle?: boolean } = {},
): Promise<AbandonSweepResult> {
  const client = await pool.connect();
  const unreadable: string[] = [];
  let stoppedTenants = 0;
  let settledTenants = 0;
  let outboxRows = 0;
  let deliveryRows = 0;
  try {
    const { rows: stopped } = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM crm.stopped_tenants()",
    );
    stoppedTenants = stopped.length;
    for (const { tenant_id: tenantId } of stopped) {
      try {
        const result = await withTenantContext(client, tenantId, async (tx) => {
          // Counted FIRST, and through the same function the settle's predicate comes from, so
          // the line cannot report a number the settle did not touch.
          const { rows } = await tx.query<{ outbox_rows: string; delivery_rows: string }>(
            "SELECT outbox_rows, delivery_rows FROM crm.unsent_work($1)",
            [tenantId],
          );
          const before = rows[0]!;
          if (Number(before.outbox_rows) + Number(before.delivery_rows) === 0) {
            return { tenantId, outboxRows: 0, deliveryRows: 0 };
          }
          // `settle: false` is the dry run an operator wants before letting a nightly job make
          // somebody's queue unsendable for the first time. It reports what WOULD be settled.
          if (opts.settle === false) {
            return {
              tenantId,
              outboxRows: Number(before.outbox_rows),
              deliveryRows: Number(before.delivery_rows),
            };
          }
          return await abandonStoppedTenantWork(tx, tenantId);
        });
        if (result.outboxRows + result.deliveryRows > 0) {
          settledTenants += 1;
          outboxRows += result.outboxRows;
          deliveryRows += result.deliveryRows;
        }
      } catch {
        unreadable.push(tenantId);
      }
    }
  } finally {
    client.release();
  }

  // CAPITALISED WHEN SOMETHING HAPPENED, like `ORPHANS=` and `TAMPERED=` on the lines beside it.
  // `SETTLED=` is not an alarm — it is the job working — but it is the one value here that means
  // rows changed, and on a healthy deployment every line is zeroes.
  const parts = [
    ...(outboxRows + deliveryRows > 0
      ? [`SETTLED=${String(outboxRows + deliveryRows)}`]
      : []),
    ...(unreadable.length > 0 ? [`UNREADABLE=${String(unreadable.length)}`] : []),
    `stopped=${String(stoppedTenants)}`,
    `tenants=${String(settledTenants)}`,
    `outbox=${String(outboxRows)}`,
    `deliveries=${String(deliveryRows)}`,
    ...(opts.settle === false ? ["dryRun=true"] : []),
  ];
  return {
    stoppedTenants,
    settledTenants,
    outboxRows,
    deliveryRows,
    unreadable,
    summary: parts.join(" "),
  };
}
