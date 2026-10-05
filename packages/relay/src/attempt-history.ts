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
 *
 * The trigger records whatever the state change says, which puts the other half of the
 * guarantee in `store.ts`: a settlement that arrives after another worker has already
 * settled the row would otherwise write a death that never happened, permanently, into a
 * table nothing prunes. See the note above `markDelivered` there.
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
 * ORDERING. `died_at` DOES tie, and the earlier claim here that it could not — "the relay
 * settles each row in its own transaction, so each death carries its own clock reading" —
 * was wrong twice over. `died_at` is not `now()`: the trigger copies `crm.outbox.dead_at`,
 * which `markDead` receives as a caller-supplied `Date`, so a separate transaction buys
 * nothing. And a `Date` has millisecond resolution, where the one path that dead-letters
 * without an ERP round trip in between — `UnknownOperationError`, refused before any HTTP
 * call — settles a whole batch inside one millisecond. Two rows in one drain therefore
 * share `died_at` exactly, and `attempt` is no tie-break at all across different outbox
 * rows, because both are 1. That is Part 1 of 0036's own lesson, in Part 2's read side.
 *
 * So the sort ends on `(outbox_id, attempt)`, which is UNIQUE and therefore makes the
 * order total: within one outbox row the newest episode first, and between rows a uuid,
 * which is meaningless as an ordering and is the point — where the data cannot say, pick
 * once and keep picking the same way (0027, and 0036's own backfill). What it buys is a
 * page boundary that does not drop or duplicate a row between two identical requests.
 * Recovering the real write order needs a `seq` on this table; see the follow-up.
 */
export async function recentDeaths(
  tx: PoolClient,
  opts: { readonly limit?: number } = {},
): Promise<readonly DeadLetterAttempt[]> {
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
      ORDER BY d.died_at DESC, d.outbox_id, d.attempt DESC
      LIMIT $1`,
    [clampLimit(opts.limit)],
  );
  return rows;
}

/**
 * Bound the page size, as a parameter rather than as text.
 *
 * `LIMIT ${n}` was interpolated, and the clamp around it admitted anything numeric: a
 * `1.5` reached Postgres verbatim and a `NaN` — which `Math.min(Math.max(NaN, 1), 500)`
 * returns unchanged — reached it as the identifier `NaN`, so a caller passing a parsed
 * query parameter got a syntax error instead of a page. Every other query in this package
 * binds its arguments; this one now does too, and a value that is not a whole number is
 * truncated towards the floor rather than refused, because a listing is not the place to
 * invent a 400.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.floor(limit), 1), 500);
}

export interface AttemptHistorySummary {
  /** Deaths IN HAND — rows this summary was given. */
  readonly deaths: number;
  /**
   * Deaths this outbox row has ever had, from the highest `attempt` present.
   *
   * The trigger allocates `attempt` as one past the highest already recorded, so the
   * newest surviving row carries the true count however many older ones are gone. That is
   * what makes a history that is pruned still able to say how much it is not showing, and
   * it is why the retention answer can be a ring rather than a cascade: discarding the
   * oldest episodes loses their reasons, never the count.
   */
  readonly deathsEverRecorded: number;
  /**
   * Episodes that happened and are not here — `deathsEverRecorded - deaths`.
   *
   * Non-zero today means a history row was deleted by hand, since nothing prunes this
   * table yet; under a ring it means the oldest episodes were trimmed. Either way a
   * reader is told rather than shown a short list that looks complete.
   */
  readonly episodesMissing: number;
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
  /*
   * Both shapes above compare the entries IN HAND from the second onward, so they describe
   * a page rather than a history whenever `episodesMissing` is non-zero. The first entry's
   * own `is_repeat_of_previous` is deliberately not folded in: for a complete history it is
   * always false, since episode 1 has no predecessor, and counting it would make
   * `alwaysTheSameReason` unreachable.
   */
  /**
   * Deaths whose `attempt` and `revive_count_at_death` disagree: the row was put back in
   * the queue without `crm.revive_outbox_letter`, so a revive happened that nothing
   * attributed.
   */
  readonly unaccountedRevivals: number;
  /**
   * Episodes stamped as having ended BEFORE they began — `revived_at < died_at`.
   *
   * Impossible by construction on the attributed path, and reachable today: the trigger's
   * revive branch takes `COALESCE(NEW.revived_at, now())`, and on the hand-written path
   * that moves a row out of `dead` without `crm.revive_outbox_letter`, `crm.outbox`
   * still holds the PREVIOUS revive's timestamp — so the episode is closed with a moment
   * that predates its own death. Demonstrated against the real database; see the contract
   * suite, and the follow-up for the one-line trigger fix 0037 should carry.
   *
   * Counted rather than corrected, for the reason every other number here is: a history
   * that quietly repaired its own rows would be the one record nobody could audit.
   *
   * It compares two clocks, which is sound only in production. `died_at` is the relay's
   * `now` for that settlement; `revived_at` is `now()` in the transaction that closed the
   * episode, because `crm.outbox` has nowhere to record "the episode ended at" and the
   * trigger has nothing else to fall back on. Under an injected clock — every test, and
   * `RelayOptions.now` — the two are unrelated and this will count a sound row.
   */
  readonly impossibleRevivals: number;
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

  const everRecorded = ordered.length === 0 ? 0 : Math.max(...ordered.map((e) => e.attempt));

  return {
    deaths: ordered.length,
    deathsEverRecorded: everRecorded,
    episodesMissing: Math.max(0, everRecorded - ordered.length),
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
    impossibleRevivals: ordered.filter(
      (e) => e.revived_at !== null && e.revived_at.getTime() < e.died_at.getTime(),
    ).length,
    latestReason: latest?.reason ?? null,
  };
}
