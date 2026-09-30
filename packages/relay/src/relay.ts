import type { ErpClient } from "@crm/acl";
import { withTenantContext } from "@crm/db";
import type { Pool } from "pg";

import { nextDelayMs, policyFor, TRANSIENT_BACKOFF } from "./backoff.js";
import { dispatch, parseOperation, UnknownOperationError } from "./dispatch.js";
import { classify, type Outcome } from "./outcome.js";
import {
  claimBatch,
  markDead,
  markDelivered,
  markRetry,
  outboxLag,
  reclaimStale,
  type OutboxLag,
  type OutboxRow,
} from "./store.js";

export interface RelayOptions {
  readonly pool: Pool;
  readonly client: ErpClient;
  /** Identifies this worker in `claimed_by`, for debugging a stuck queue. */
  readonly workerId: string;
  readonly batchSize?: number;
  /** How long a claim is held before another worker may reclaim it. */
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onEvent?: (event: RelayEvent) => void;
}

export type RelayEvent =
  | { readonly type: "delivered"; readonly row: OutboxRow }
  | { readonly type: "already_delivered"; readonly row: OutboxRow }
  | { readonly type: "retry"; readonly row: OutboxRow; readonly delayMs: number; readonly outcome: Outcome }
  | { readonly type: "dead"; readonly row: OutboxRow; readonly outcome: Outcome }
  | { readonly type: "reclaimed"; readonly tenantId: string; readonly count: number };

export interface RelayResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  readonly lag: OutboxLag;
}

const DEFAULT_BATCH = 25;
const DEFAULT_LEASE_MS = 60_000;

/**
 * Drains one tenant's outbox against the ERP.
 *
 * Shape and its reasons:
 *
 * - **Per tenant, not global.** Every query runs inside `withTenantContext`, so
 *   RLS confines it. Draining the whole table in one pass would mean bypassing
 *   RLS, which is the one thing this architecture refuses to do.
 * - **Claim and settle are separate transactions.** The ERP call happens
 *   BETWEEN them, never inside one: holding a Postgres transaction open across
 *   a network round trip pins a connection and turns an ERP slowdown into
 *   database connection exhaustion.
 * - **Each row settles independently.** One poisoned row must not roll back the
 *   settlement of its batch-mates that succeeded.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly options: RelayOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  async drainTenant(tenantId: string): Promise<RelayResult> {
    const client = await this.options.pool.connect();
    try {
      const reclaimed = await withTenantContext(client, tenantId, (tx) =>
        reclaimStale(tx, tenantId, this.leaseMs, this.now()),
      );
      if (reclaimed > 0) {
        this.options.onEvent?.({ type: "reclaimed", tenantId, count: reclaimed });
      }

      const rows = await withTenantContext(client, tenantId, (tx) =>
        claimBatch(tx, tenantId, this.options.workerId, this.batchSize, this.now()),
      );

      let delivered = 0;
      let retried = 0;
      let dead = 0;

      for (const row of rows) {
        // Deliberately outside any transaction — see the class comment.
        const outcome = await this.attempt(row);

        await withTenantContext(client, tenantId, async (tx) => {
          switch (outcome.kind) {
            case "delivered":
            case "already_delivered": {
              await markDelivered(tx, row.id, this.now(), outcome.response);
              delivered += 1;
              this.options.onEvent?.({
                type: outcome.kind === "delivered" ? "delivered" : "already_delivered",
                row,
              });
              return;
            }
            case "dead": {
              await markDead(tx, row.id, this.now(), outcome.reason);
              dead += 1;
              this.options.onEvent?.({ type: "dead", row, outcome });
              return;
            }
            default: {
              const policy = policyFor(outcome.kind);
              if (row.attempts >= policy.maxAttempts) {
                const reason = `giving up after ${row.attempts} attempts — ${outcome.reason}`;
                await markDead(tx, row.id, this.now(), reason);
                dead += 1;
                this.options.onEvent?.({ type: "dead", row, outcome: { ...outcome, reason } });
                return;
              }
              const delayMs = nextDelayMs(row.attempts, policy, this.random);
              await markRetry(
                tx,
                row.id,
                new Date(this.now().getTime() + delayMs),
                outcome.reason,
              );
              retried += 1;
              this.options.onEvent?.({ type: "retry", row, delayMs, outcome });
            }
          }
        });
      }

      const lag = await withTenantContext(client, tenantId, (tx) =>
        outboxLag(tx, tenantId, this.now()),
      );
      return { claimed: rows.length, delivered, retried, dead, lag };
    } finally {
      client.release();
    }
  }

  /** One dispatch attempt, reduced to an outcome. Never throws. */
  private async attempt(
    row: OutboxRow,
  ): Promise<(Outcome & { response?: unknown }) | { kind: "delivered"; reason: string; response: unknown }> {
    let isTransition = false;
    try {
      // Parsed up front so a malformed operation dead-letters with a readable
      // reason rather than being classified as a transient fault and retried
      // ten times first.
      isTransition = parseOperation(row.operation).kind === "transition";
    } catch (err) {
      if (err instanceof UnknownOperationError) {
        return { kind: "dead", reason: err.message };
      }
      throw err;
    }

    try {
      const { response } = await dispatch(this.options.client, row);
      return { kind: "delivered", reason: "ok", response };
    } catch (err) {
      const outcome = classify({ error: err, isTransition });
      return outcome.kind === "already_delivered" ? { ...outcome, response: null } : outcome;
    }
  }
}

export { TRANSIENT_BACKOFF };
