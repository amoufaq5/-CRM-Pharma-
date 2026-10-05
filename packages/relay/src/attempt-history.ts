import type { PoolClient } from "pg";

/**
 * Why a dead letter died EACH time, not just the last time (0036 part 2).
 *
 * `crm.outbox.dead_reason` holds the latest cause and `revive_count` says it is not the
 * first. Between them they cannot tell "died because the ledger account was missing,
 * somebody created it, died again because the period was locked" from "died twice because
 * the ledger account is still missing" — and those are different conversations. The first
 * says the revive is working and a third attempt is worth having; the second says the
 * button is being pressed instead of the cause being fixed.
 *
 * `crm.outbox_dead_letter` holds one row per death, written by a trigger on the state
 * change rather than by this package, so no path records a death without recording its
 * history. This module is the read side and the question-answering side; nothing here
 * writes.
 */

export interface DeadLetterAttempt {
  readonly id: string;
  readonly outbox_id: string;
  /** Which death this was for that outbox row, from 1. The table's ordering key. */
  readonly attempt: number;
  /**
   * `crm.outbox.revive_count` as it stood at this death. Equals `attempt - 1` for every
   * death reached through `crm.revive_outbox_letter`; a disagreement means the row was put
   * back in the queue by hand, without the revive bookkeeping.
   */
  readonly revive_count_at_death: number;
  /** Dispatch attempts this episode consumed — not the number of deaths. */
  readonly dispatch_attempts: number;
  readonly died_at: Date;
  /** Null only when the death was applied without one; see 0036's header. */
  readonly reason: string | null;
  readonly entity: string;
  readonly operation: string;
  readonly target_record_id: string;
  readonly source_table: string;
  readonly source_id: string;
  /** When this episode ended, whether or not an actor was recorded for it. */
  readonly revived_at: Date | null;
  readonly revived_by: string | null;
  readonly revived_by_name: string | null;
  /** True when this death's reason is byte-identical to the previous episode's. */
  readonly is_repeat_of_previous: boolean;
}

const HISTORY_COLUMNS =
  "id, outbox_id, attempt, revive_count_at_death, dispatch_attempts, died_at, reason, " +
  "entity, operation, target_record_id, source_table, source_id, revived_at, revived_by, " +
  "revived_by_name, is_repeat_of_previous";

/**
 * One outbox row's death history, oldest first.
 *
 * Takes the outbox id rather than a `DeadLetter`, because the row this describes may be
 * gone: `crm.outbox_dead_letter` carries no foreign key to `crm.outbox` on purpose
 * (0036's header; the precedent not to recreate is `crm.notification_delivery`'s cascade),
 * and copies the entity, operation and producing row so a history row still says what
 * failed after the queue row is deleted. So this answers for a live dead letter, a
 * delivered one that died on the way, and one nothing points at any more.
 *
 * Runs inside `withTenantContext`, so RLS confines it — an id from another tenant returns
 * an empty history rather than an error, which is the fail-closed reading and not
 * distinguishable from "nothing ever died". Callers that need the difference must look the
 * outbox row up first.
 */
export async function attemptHistory(
  tx: PoolClient,
  outboxId: string,
): Promise<readonly DeadLetterAttempt[]> {
  const { rows } = await tx.query<DeadLetterAttempt>(
    `SELECT ${HISTORY_COLUMNS} FROM crm.outbox_dead_letter_history($1)`,
    [outboxId],
  );
  return rows;
}

/**
 * The tenant's recent deaths across every outbox row, latest first.
 *
 * The listing that makes an orphaned history discoverable. `crm.dead_outbox_letters`
 * answers "what is dead right now" by joining `crm.outbox`, so a row that died, was
 * revived and then delivered has left it — and so has one whose queue row was deleted.
 * This reads the history table alone, so neither disappears.
 *
 * Ordered by `died_at`, which does not tie here for the reason it ties everywhere else in
 * this schema: the relay settles each row in its OWN transaction, so each death carries
 * its own clock reading. `attempt` is the tie-break anyway, and within one outbox row it
 * is the only ordering that means anything.
 */
export async function recentDeaths(
  tx: PoolClient,
  opts: { readonly limit?: number } = {},
): Promise<readonly DeadLetterAttempt[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await tx.query<DeadLetterAttempt>(
    `SELECT d.id, d.outbox_id, d.attempt, d.revive_count_at_death, d.dispatch_attempts,
            d.died_at, d.reason, d.entity, d.operation, d.target_record_id::text AS target_record_id,
            d.source_table, d.source_id, d.revived_at, d.revived_by, rp.display_name AS revived_by_name,
            -- Window functions are evaluated before LIMIT, so this compares against the
            -- real previous episode even when that episode is not one of the rows
            -- returned. The flag therefore means the same thing here as in the per-row
            -- history: a page boundary cannot turn a repeat into a first occurrence.
            d.reason IS NOT NULL
              AND d.reason IS NOT DISTINCT FROM
                  lag(d.reason) OVER (PARTITION BY d.outbox_id ORDER BY d.attempt)
              AS is_repeat_of_previous
       FROM crm.outbox_dead_letter d
       LEFT JOIN crm.rep_profile rp ON rp.id = d.revived_by
      ORDER BY d.died_at DESC, d.attempt DESC
      LIMIT ${limit}`,
  );
  return rows;
}

export interface AttemptHistorySummary {
  readonly deaths: number;
  /** Episodes that ended — the row left `dead`, by a revive or otherwise. */
  readonly revives: number;
  /** Distinct non-null reasons. */
  readonly distinctReasons: number;
  /** Reasons seen more than once, in first-seen order. */
  readonly repeatedReasons: readonly string[];
  /** Deaths with no reason recorded at all. */
  readonly unexplained: number;
  /**
   * True when there were at least two deaths and every one after the first repeated its
   * predecessor's reason verbatim — the "the cause was never fixed" shape.
   */
  readonly alwaysTheSameReason: boolean;
  /**
   * True when there were at least two deaths and no two consecutive ones shared a reason —
   * the "progress is being made" shape.
   */
  readonly neverTheSameReason: boolean;
  /**
   * Deaths whose `attempt` and `revive_count_at_death` disagree: the row was put back in
   * the queue without `crm.revive_outbox_letter`, so a revive happened that nothing
   * attributed.
   */
  readonly unaccountedRevivals: number;
  readonly latestReason: string | null;
}

/**
 * The history, read as an answer.
 *
 * Pure, over the rows `attemptHistory` returned, so an operator surface and a test can
 * ask the same question of the same data without a second query.
 *
 * WHAT IT CANNOT DO, because the limit is worth stating where the answer is given rather
 * than only in the migration. Reasons are compared as bytes, not as classifications:
 * `classify`'s verdict (`permanent_refusal`, `retry_ordering`, …) is computed in
 * `outcome.ts`, used to choose a state, and then thrown away, so nothing persists the KIND
 * of failure. A reason that embeds a record id therefore reads as a new cause when an
 * operator would call it the same one. That under-claims repetition rather than asserting
 * it, which is the conservative direction, and closing it means persisting the
 * classification at the point of death.
 */
export function summariseAttemptHistory(
  entries: readonly DeadLetterAttempt[],
): AttemptHistorySummary {
  const ordered = [...entries].sort((a, b) => a.attempt - b.attempt);

  const counts = new Map<string, number>();
  for (const e of ordered) {
    if (e.reason === null) continue;
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }

  const repeatedReasons: string[] = [];
  for (const e of ordered) {
    if (e.reason === null) continue;
    if ((counts.get(e.reason) ?? 0) > 1 && !repeatedReasons.includes(e.reason)) {
      repeatedReasons.push(e.reason);
    }
  }

  const consecutive = ordered.slice(1);
  const latest = ordered[ordered.length - 1];

  return {
    deaths: ordered.length,
    revives: ordered.filter((e) => e.revived_at !== null).length,
    distinctReasons: counts.size,
    repeatedReasons,
    unexplained: ordered.filter((e) => e.reason === null).length,
    // `is_repeat_of_previous` is the database's own comparison, reused rather than redone:
    // a second implementation here would be a second chance to disagree with it.
    alwaysTheSameReason:
      consecutive.length > 0 && consecutive.every((e) => e.is_repeat_of_previous),
    neverTheSameReason:
      consecutive.length > 0 && consecutive.every((e) => !e.is_repeat_of_previous),
    unaccountedRevivals: ordered.filter((e) => e.attempt !== e.revive_count_at_death + 1).length,
    latestReason: latest?.reason ?? null,
  };
}
