import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { translateSampleError } from "./errors.js";

/**
 * The nightly sweep over expired stock.
 *
 * WHAT IT DOES NOT DO, first, because it is the whole design: it does not write off a
 * drug sample. The material is physically in the rep's bag; posting a movement that
 * removes it from the balance would make the system assert the stock is gone when it is
 * not, and the question an inspector asks is "where did these expired units actually
 * go?" — to which "a scheduled job stopped counting them" is worse than an untidy
 * balance, because it reads like an answer.
 *
 * What it does instead is the thing nobody was doing: notice, date, chase, and attribute.
 *
 *   1. close obligations whose stock has actually gone, recording WHICH movement did it;
 *   2. open an obligation for every expired holding that has none;
 *   3. write off expired PROMO MATERIAL, if the tenant opted in — a leaflet past its
 *      campaign date carries no custody obligation;
 *   4. mark anything past its deadline overdue.
 *
 * Resolution happens through a person recording a `destruction` or a
 * `return_to_warehouse`. This sweep only observes that it happened.
 *
 * Runs inside the caller's transaction and inside `withTenantContext`, like every other
 * store function, so a failure anywhere leaves the night's sweep as though it had not
 * run — which is the right outcome for a job that runs again tomorrow.
 */

export const DEFAULT_GRACE_DAYS = 30;

export interface DisposalPolicy {
  readonly grace_days: number;
  readonly auto_writeoff_promo: boolean;
}

export interface ExpirySweepResult {
  readonly expiredHoldings: number;
  readonly opened: number;
  readonly resolved: number;
  readonly markedOverdue: number;
  readonly autoWrittenOff: number;
  /** Stock that has gone with no decreasing movement to explain it — see below. */
  readonly unattributed: number;
  readonly policy: DisposalPolicy;
}

export interface ExpirySweepOptions {
  /** The sweep's "today". Injected so a test can stand on any date. */
  readonly asOf?: Date;
  /** Overrides the tenant's policy. For tests and for a one-off catch-up run. */
  readonly graceDays?: number;
}

interface ExpiredHolding {
  readonly rep_profile_id: string;
  readonly lot_id: string;
  readonly lot_number: string;
  readonly material_kind: "drug_sample" | "promo_material";
  readonly expiry_date: string;
  readonly days_expired: number;
  readonly quantity_on_hand: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Reads the tenant's disposal policy, creating the default row on first sight.
 *
 * Created lazily rather than by the migration: a policy row for a tenant that has no
 * samples is noise, and `ON CONFLICT DO NOTHING` makes the first sweep of a new tenant
 * self-provisioning without a separate onboarding step to forget.
 */
export async function disposalPolicy(tx: PoolClient, tenantId: string): Promise<DisposalPolicy> {
  await tx.query(
    `INSERT INTO crm.disposal_policy (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
  const { rows } = await tx.query<DisposalPolicy>(
    `SELECT grace_days, auto_writeoff_promo FROM crm.disposal_policy WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? { grace_days: DEFAULT_GRACE_DAYS, auto_writeoff_promo: false };
}

export async function setDisposalPolicy(
  tx: PoolClient,
  tenantId: string,
  input: { graceDays?: number; autoWriteoffPromo?: boolean },
): Promise<DisposalPolicy> {
  await disposalPolicy(tx, tenantId);
  const { rows } = await tx.query<DisposalPolicy>(
    `UPDATE crm.disposal_policy
        SET grace_days = COALESCE($2, grace_days),
            auto_writeoff_promo = COALESCE($3, auto_writeoff_promo),
            updated_at = now()
      WHERE tenant_id = $1
      RETURNING grace_days, auto_writeoff_promo`,
    [tenantId, input.graceDays ?? null, input.autoWriteoffPromo ?? null],
  );
  return rows[0]!;
}

export async function sweepExpiredStock(
  tx: PoolClient,
  tenantId: string,
  opts: ExpirySweepOptions = {},
): Promise<ExpirySweepResult> {
  const asOf = opts.asOf ?? new Date();
  const today = isoDate(asOf);

  try {
    const stored = await disposalPolicy(tx, tenantId);
    const policy: DisposalPolicy = {
      grace_days: opts.graceDays ?? stored.grace_days,
      auto_writeoff_promo: stored.auto_writeoff_promo,
    };

    // ---- 1. close what has actually gone --------------------------------
    //
    // Before opening anything, so a lot that was disposed of and then re-expired on a
    // second carton gets a clean new obligation rather than inheriting the old one's
    // deadline.
    const { rows: live } = await tx.query<{
      id: string;
      rep_profile_id: string;
      lot_id: string;
      discovered_on: string;
    }>(
      `SELECT o.id, o.rep_profile_id, o.lot_id, o.discovered_on::text AS discovered_on
         FROM crm.disposal_obligation o
         LEFT JOIN crm.sample_holding h
                ON h.rep_profile_id = o.rep_profile_id AND h.lot_id = o.lot_id
        WHERE o.tenant_id = $1
          AND o.status IN ('open', 'overdue')
          AND COALESCE(h.quantity_on_hand, 0) = 0`,
      [tenantId],
    );

    let resolved = 0;
    let unattributed = 0;
    for (const row of live) {
      const { rows: movement } = await tx.query<{ transaction_id: string; resolution: string }>(
        `SELECT transaction_id, resolution
           FROM crm.disposal_resolving_movement($1, $2, $3::date)`,
        [row.rep_profile_id, row.lot_id, row.discovered_on],
      );
      const found = movement[0];
      if (found === undefined) {
        // The stock is gone and no decreasing movement since discovery explains it. The
        // obligation stays OPEN deliberately: closing it with a guessed reason would put
        // a fabricated disposal in the record, which is the one thing this whole design
        // exists to avoid. Counted so the scheduler log shows it.
        unattributed += 1;
        continue;
      }
      await tx.query(
        `UPDATE crm.disposal_obligation
            SET status = 'resolved', resolved_on = $2::date, resolution = $3,
                resolving_transaction_id = $4, updated_at = now()
          WHERE id = $1`,
        [row.id, today, found.resolution, found.transaction_id],
      );
      resolved += 1;
    }

    // ---- 2. open an obligation for every expired holding -----------------
    const { rows: expired } = await tx.query<ExpiredHolding>(
      `SELECT rep_profile_id, lot_id, lot_number, material_kind,
              expiry_date::text AS expiry_date, days_expired,
              quantity_on_hand::text AS quantity_on_hand
         FROM crm.expired_sample_holdings($1::date)`,
      [today],
    );

    let opened = 0;
    const dueBy = isoDate(new Date(asOf.getTime() + policy.grace_days * 86_400_000));
    for (const holding of expired) {
      const { rowCount } = await tx.query(
        `INSERT INTO crm.disposal_obligation
           (tenant_id, rep_profile_id, lot_id, quantity_at_discovery, expired_on, discovered_on, due_by)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7::date)
         -- Inferred against uq_disposal_obligation_live: one live obligation per
         -- (rep, lot). The sweep runs nightly and must not raise a row per night for
         -- the same carton, which would reset the deadline every time — the opposite of
         -- chasing it.
         ON CONFLICT (rep_profile_id, lot_id) WHERE status IN ('open', 'overdue')
         DO NOTHING`,
        [tenantId, holding.rep_profile_id, holding.lot_id, holding.quantity_on_hand,
         holding.expiry_date, today, dueBy],
      );
      opened += rowCount ?? 0;
    }

    // ---- 3. auto write-off, promotional material only --------------------
    let autoWrittenOff = 0;
    if (policy.auto_writeoff_promo) {
      for (const holding of expired.filter((h) => h.material_kind === "promo_material")) {
        const transactionId = randomUUID();
        await tx.query(
          `INSERT INTO crm.sample_transaction
             (id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at)
           VALUES ($1, $2, $3, $4, 'expiry_writeoff', $5, $6, $7)`,
          [
            transactionId,
            tenantId,
            holding.lot_id,
            holding.rep_profile_id,
            holding.quantity_on_hand,
            // The reason says a machine did it and on what authority. A reader must be
            // able to tell this from a destruction someone witnessed.
            `automatic expiry write-off (promotional material, tenant policy): lot ${holding.lot_number} ` +
              `expired ${holding.expiry_date}, ${holding.days_expired} day(s) before the sweep of ${today}`,
            asOf,
          ],
        );
        // Closed on this pass rather than tomorrow's: the movement is right here, so
        // attributing it now is exact where re-deriving it later is inference.
        await tx.query(
          `UPDATE crm.disposal_obligation
              SET status = 'resolved', resolved_on = $3::date, resolution = 'written_off',
                  resolving_transaction_id = $4, updated_at = now()
            WHERE rep_profile_id = $1 AND lot_id = $2 AND status IN ('open', 'overdue')`,
          [holding.rep_profile_id, holding.lot_id, today, transactionId],
        );
        autoWrittenOff += 1;
      }
    }

    // ---- 4. mark the stragglers overdue ----------------------------------
    const { rowCount: markedOverdue } = await tx.query(
      `UPDATE crm.disposal_obligation
          SET status = 'overdue', updated_at = now()
        WHERE tenant_id = $1 AND status = 'open' AND due_by < $2::date`,
      [tenantId, today],
    );

    return {
      expiredHoldings: expired.length,
      opened,
      resolved,
      markedOverdue: markedOverdue ?? 0,
      autoWrittenOff,
      unattributed,
      policy,
    };
  } catch (err) {
    throw translateSampleError(err);
  }
}
