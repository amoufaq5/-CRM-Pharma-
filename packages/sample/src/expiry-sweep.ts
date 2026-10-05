import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { raiseForSupervisors, raiseNotification } from "@crm/notify";

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
 *   2. open an obligation for every expired holding that has none — CONTINUING the
 *      (rep, lot)'s earlier deadline where there was one, rather than granting a fresh
 *      grace period to material that left custody and came back (0030);
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
  /**
   * How many of `opened` inherited an earlier deadline instead of being granted a fresh
   * one — material that left this rep's custody and came back. A subset of `opened`, not
   * a separate total, because a continuation IS an obligation now live that was not.
   */
  readonly continued: number;
  readonly resolved: number;
  readonly markedOverdue: number;
  readonly autoWrittenOff: number;
  /** Stock that has gone with no decreasing movement to explain it — see below. */
  readonly unattributed: number;
  /** In-app notifications raised, counting one per recipient. */
  readonly notified: number;
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
    let continued = 0;
    let notified = 0;
    const freshDueBy = isoDate(new Date(asOf.getTime() + policy.grace_days * 86_400_000));
    for (const holding of expired) {
      const { rows: raised } = await tx.query<{
        id: string;
        discovered_on: string;
        due_by: string;
        continues_obligation_id: string | null;
      }>(
        // The dates are decided in SQL for the reason `crm.open_disposal_obligations`
        // is: `crm.disposal_carry_forward` is the one definition of "the deadline this
        // rep already has for this lot", and a second one here would eventually disagree
        // with it. In the same statement as the ON CONFLICT rather than before it, so a
        // night that has nothing to insert computes no deadline at all — the conflicting
        // case must not be able to produce a date that something later reads.
        `WITH carried AS (SELECT * FROM crm.disposal_carry_forward($2, $3))
         INSERT INTO crm.disposal_obligation
           (tenant_id, rep_profile_id, lot_id, quantity_at_discovery, expired_on,
            discovered_on, due_by, continues_obligation_id)
         SELECT $1, $2, $3, $4, $5::date,
                COALESCE(c.discovered_on, $6::date),
                COALESCE(c.due_by, $7::date),
                c.continues_obligation_id
           FROM carried c
         -- Inferred against uq_disposal_obligation_live: one live obligation per
         -- (rep, lot). The sweep runs nightly and must not raise a row per night for
         -- the same carton, which would reset the deadline every time — the opposite of
         -- chasing it.
         ON CONFLICT (rep_profile_id, lot_id) WHERE status IN ('open', 'overdue')
         DO NOTHING
         RETURNING id, discovered_on::text AS discovered_on, due_by::text AS due_by,
                   continues_obligation_id`,
        [tenantId, holding.rep_profile_id, holding.lot_id, holding.quantity_on_hand,
         holding.expiry_date, today, freshDueBy],
      );
      const obligation = raised[0];
      if (obligation === undefined) continue;
      opened += 1;

      const isContinuation = obligation.continues_obligation_id !== null;
      if (isContinuation) continued += 1;

      // Told in the SAME transaction as the obligation. Previously this was the whole gap:
      // the sweep raised an obligation at 3am and the rep found out whenever they next
      // happened to open the app.
      //
      // A continuation is told separately and says so. It has to: the first notification
      // is still in the inbox under the `:raised` key, so reusing that key would dedup
      // against it and the rep would never learn that the material is back — and the fact
      // they most need is the one a fresh grace period would have hidden, that the
      // original deadline still stands.
      await raiseNotification(tx, tenantId, {
        recipientRepProfileId: holding.rep_profile_id,
        kind: "disposal_obligation_raised",
        severity: "warning",
        subject: isContinuation
          ? `Expired stock back in your custody: lot ${holding.lot_number}`
          : `Expired stock to dispose of: lot ${holding.lot_number}`,
        body: isContinuation
          ? `${holding.quantity_on_hand} unit(s) of lot ${holding.lot_number} are back on your ` +
            `balance. This is the same disposal you were told about on ` +
            `${obligation.discovered_on} and the deadline has not moved: record a destruction ` +
            `or return it to a warehouse by ${obligation.due_by}.`
          : `${holding.quantity_on_hand} unit(s) of lot ${holding.lot_number} expired on ` +
            `${holding.expiry_date}. Record a destruction or return it to a warehouse by ` +
            `${obligation.due_by}.`,
        // Scoped to the lot and the event, with no date in it: the key is what makes a
        // nightly sweep tell them once rather than every night. A continuation is keyed
        // to its own obligation instead, so each return is news exactly once.
        dedupKey: isContinuation
          ? `disposal:${holding.lot_id}:resumed:${obligation.id}`
          : `disposal:${holding.lot_id}:raised`,
        subjectTable: "crm.disposal_obligation",
        // Named so retention can tell that this notification is about something
        // unfinished. `crm.notification_subject_open` matches on the id, so without it a
        // notice about a live regulated disposal prunes at the ordinary horizon — which
        // for the one deadline this file exists to preserve is the wrong way round.
        subjectId: obligation.id,
        payload: {
          lotNumber: holding.lot_number,
          materialKind: holding.material_kind,
          expiredOn: holding.expiry_date,
          dueBy: obligation.due_by,
          quantity: holding.quantity_on_hand,
          continuesObligationId: obligation.continues_obligation_id,
        },
      });
      notified += 1;
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
    //
    // RETURNING rather than a bare UPDATE, because each one has to be escalated: an
    // overdue regulated disposal goes to the rep AND up the hierarchy. A count would have
    // been enough for the log line and useless for telling anyone.
    const { rows: nowOverdue } = await tx.query<{
      id: string;
      rep_profile_id: string;
      lot_id: string;
      due_by: string;
    }>(
      `UPDATE crm.disposal_obligation
          SET status = 'overdue', updated_at = now()
        WHERE tenant_id = $1 AND status = 'open' AND due_by < $2::date
        RETURNING id, rep_profile_id, lot_id, due_by::text AS due_by`,
      [tenantId, today],
    );

    for (const row of nowOverdue) {
      const { rows: lotRows } = await tx.query<{ lot_number: string }>(
        `SELECT lot_number FROM crm.sample_lot WHERE id = $1`,
        [row.lot_id],
      );
      const lotNumber = lotRows[0]?.lot_number ?? row.lot_id;
      const detail = {
        subject: `OVERDUE: expired stock not disposed of (lot ${lotNumber})`,
        dedupKey: `disposal:${row.lot_id}:overdue`,
        subjectTable: "crm.disposal_obligation",
        subjectId: row.id,
        payload: { lotNumber, dueBy: row.due_by },
      } as const;

      await raiseNotification(tx, tenantId, {
        ...detail,
        recipientRepProfileId: row.rep_profile_id,
        kind: "disposal_obligation_overdue",
        // Urgent for the rep holding it: this is the finding an inspection would open with.
        severity: "urgent",
        body:
          `Lot ${lotNumber} was due to be disposed of by ${row.due_by} and is still on your ` +
          `balance. Record a destruction or return it to a warehouse now.`,
      });
      notified += 1;

      // Escalated, not just repeated: the rep already knows. The supervisor is told
      // because accountability for an overdue regulated disposal does not stop at the
      // person holding the carton.
      const escalations = await raiseForSupervisors(tx, tenantId, row.rep_profile_id, {
        ...detail,
        kind: "disposal_obligation_overdue",
        severity: "warning",
        body:
          `Lot ${lotNumber} on a rep's balance was due for disposal by ${row.due_by} and has ` +
          `not been actioned.`,
      }, { on: today });
      notified += escalations.length;
    }
    const markedOverdue = nowOverdue.length;

    return {
      expiredHoldings: expired.length,
      opened,
      continued,
      resolved,
      markedOverdue,
      autoWrittenOff,
      unattributed,
      notified,
      policy,
    };
  } catch (err) {
    throw translateSampleError(err);
  }
}

/**
 * One (rep, lot)'s disposal history, oldest first.
 *
 * The read that makes carrying a deadline forward auditable rather than merely correct.
 * A resolved obligation and the continuation that inherited its deadline are two rows,
 * and this is where the pair reads as what happened: discovered on a date, due on a date,
 * discharged by a named movement of a named KIND, then continued — so an auditor can see
 * that the stock was transferred away and came back, which is a different fact from an
 * obligation that simply exists.
 *
 * Separate from `openObligations` on purpose: that one answers "what must this rep
 * clear", which is a live list and has no business carrying resolved rows.
 */
export interface DisposalObligationHistoryEntry {
  readonly id: string;
  /**
   * The INSERT order (0036), as a decimal string because it is a `bigint`.
   *
   * Distinct from `sequence_number`, which is the continuation walk's depth: `seq` says
   * when the row was written, the depth says where it sits in the chain. They agree for
   * every chain this schema writes and diverge for a row written by hand, which is the
   * only way a row gets a depth of 0.
   */
  readonly seq: string;
  readonly sequence_number: number;
  readonly continues_obligation_id: string | null;
  readonly quantity_at_discovery: string;
  readonly expired_on: string;
  readonly discovered_on: string;
  readonly due_by: string;
  readonly status: "open" | "overdue" | "resolved";
  readonly resolved_on: string | null;
  readonly resolution: string | null;
  readonly resolving_transaction_id: string | null;
  /** The custody ledger's own word for the movement — `transfer_out`, not `transferred`. */
  readonly resolving_transaction_kind: string | null;
  readonly created_at: Date;
}

export async function disposalHistory(
  tx: PoolClient,
  repProfileId: string,
  lotId: string,
): Promise<readonly DisposalObligationHistoryEntry[]> {
  const { rows } = await tx.query<DisposalObligationHistoryEntry>(
    `SELECT id, seq::text AS seq, sequence_number, continues_obligation_id,
            quantity_at_discovery::text AS quantity_at_discovery,
            expired_on::text AS expired_on, discovered_on::text AS discovered_on,
            due_by::text AS due_by, status,
            resolved_on::text AS resolved_on, resolution,
            resolving_transaction_id, resolving_transaction_kind, created_at
       FROM crm.disposal_obligation_chain($1, $2)`,
    [repProfileId, lotId],
  );
  return rows;
}
