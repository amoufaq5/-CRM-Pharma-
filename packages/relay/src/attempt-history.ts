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
 * settled the row would otherwise write a death that never happened into this table. See
 * the note above `markDelivered` there. "Permanently" is now almost true rather than
 * entirely: 0041 made the same trigger a RING, keeping the newest
 * `crm.outbox_dead_letter_ring_size()` episodes per outbox row and discarding older ones,
 * so a false death would be aged out after fifty more real ones. That is no comfort and
 * `markDelivered`'s guard is still the thing that prevents it.
 */

export interface DeadLetterAttempt {
  readonly id: string;
  /**
   * bigint, as text. The real write order (0041), and the key `recentDeaths` sorts on.
   *
   * Exposed because a reader that cannot see the ordering key cannot page by it — which
   * makes keyset paging possible (`WHERE seq < <last seen> ORDER BY seq DESC`) and is
   * deliberately not built: nothing asks for a second page, and a paging API nobody calls
   * is a surface to maintain for a reader that does not exist.
   *
   * Text rather than a number for the reason `ProbeRow.seq` is: a bigint that arrives as a
   * JavaScript number is a bigint that silently rounds. It HAS GAPS and is not a count —
   * identity allocation does not roll back, and the ring (0041 part 2) deletes rows, so a
   * gap here is the normal case. `deathsEverRecorded` is read off `attempt` and nothing
   * else.
   */
  readonly seq: string;
  readonly outbox_id: string;
  /**
   * Which death this was for that outbox row, from 1. This table's per-row ordering key,
   * and the one the ring cannot disturb: the trigger allocates it as one past the highest
   * already recorded, so the newest surviving row carries the true count however many older
   * episodes were trimmed.
   */
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
  "id, seq::text AS seq, outbox_id, attempt, revive_count_at_death, dispatch_attempts, " +
  "died_at, reason, entity, operation, target_record_id, source_table, source_id, " +
  "revived_at, revived_by, revived_by_name, is_repeat_of_previous";

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
 *
 * STILL ORDERED BY `attempt`, NOT BY `seq`, and the burden was on changing it rather than on
 * keeping it. `attempt` is UNIQUE per `outbox_id` so it cannot tie, it is declared rather
 * than temporal so it orders correctly however many rows share a transaction, and it is the
 * number every answer in `summariseAttemptHistory` is computed from. For every row this
 * schema writes `seq` would give the identical order anyway — the trigger allocates
 * `attempt` as one past the highest recorded, inside the transaction that killed the row, so
 * a higher `attempt` always carries a later `seq`. The one case where they disagree is a
 * history row inserted by hand with an out-of-order `attempt`, and switching would make it
 * WORSE: the list would be ordered by `seq` while still being numbered by `attempt`, so
 * `is_repeat_of_previous` — computed with `lag(reason) OVER (ORDER BY attempt)` in the
 * database — would describe a different neighbour than the one printed above it. `seq` is
 * returned on the row (0041) so a reader can see the listing's key; it is not the key here.
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
 * ORDERING. `seq DESC` — the real write order, since 0041 gave this table one.
 *
 * WHY IT HAD TO EXIST, because the lesson is the reason and not a footnote. `died_at` TIES.
 * It is not `now()`: the trigger copies `crm.outbox.dead_at`, which `markDead` receives as a
 * caller-supplied `Date`, so settling each row in its own transaction buys nothing — and a
 * `Date` has millisecond resolution, where the one path that dead-letters without an ERP
 * round trip in between (`UnknownOperationError`, refused before any HTTP call) settles a
 * whole batch inside one millisecond. Two rows in one drain therefore share `died_at`
 * exactly. `attempt` is no tie-break at all across different outbox rows either, because
 * for two rows dying for the first time both are 1. So this sort used to end on `outbox_id`
 * — a uuid, meaningless as an ordering, chosen only to make the order TOTAL so a page
 * boundary could not drop or duplicate a row. It bought a stable page and reported a
 * fiction: the leading row was whichever uuid sorted smallest, not the row that died last.
 *
 * `seq` is allocated at INSERT time, so it records the order the INSERTs ran, and it is
 * GENERATED ALWAYS so no writer can supply one. It is unique, so the order is still total
 * and a short page is still a prefix of a long one. The difference is that the order is now
 * the truth for anything written after 0041 — the backfilled prefix is a chosen order
 * (`died_at, outbox_id, attempt`, which is this function's own former key, so nothing an
 * operator has already read was reshuffled), because history's real write order was never
 * recorded and cannot be recovered, only chosen.
 *
 * It does NOT order concurrent enqueues across transactions, and it has gaps: identity
 * allocation is outside transaction control and the ring (0041 part 2) deletes rows. Nothing
 * here reads `seq` as a count.
 */
export async function recentDeaths(
  tx: PoolClient,
  opts: { readonly limit?: number } = {},
): Promise<readonly DeadLetterAttempt[]> {
  const { rows } = await tx.query<DeadLetterAttempt>(
    `SELECT d.id, d.seq::text AS seq, d.outbox_id, d.attempt, d.revive_count_at_death,
            d.dispatch_attempts,
            d.died_at, d.reason, d.entity, d.operation, d.target_record_id::text AS target_record_id,
            d.source_table, d.source_id, d.revived_at, d.revived_by, rp.display_name AS revived_by_name,
            -- Window functions are evaluated before LIMIT, so this compares against the
            -- real previous episode even when that episode is not one of the rows
            -- returned. The flag therefore means the same thing here as in the per-row
            -- history: a page boundary cannot turn a repeat into a first occurrence.
            -- A TRIM can, and that is the one thing the ring costs this flag: once the
            -- previous episode has been discarded (0041 part 2) the lag is NULL and the
            -- oldest surviving death reads as a first occurrence. Under-claiming
            -- repetition, never asserting it -- the same conservative direction that
            -- comparing reasons as bytes already errs in.
            d.reason IS NOT NULL
              AND d.reason IS NOT DISTINCT FROM
                  lag(d.reason) OVER (PARTITION BY d.outbox_id ORDER BY d.attempt)
              AS is_repeat_of_previous
       FROM crm.outbox_dead_letter d
       LEFT JOIN crm.rep_profile rp ON rp.id = d.revived_by
      ORDER BY d.seq DESC
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
   * Non-zero means the oldest episodes were trimmed by the ring (0041 part 2: the newest
   * `crm.outbox_dead_letter_ring_size()` survive per outbox row), or a history row was
   * deleted by hand, or this is a page rather than a history. Either way a reader is told
   * rather than shown a short list that looks complete — which is the property that makes a
   * ring an acceptable answer to retention where a cascade is not. The trim discards
   * reasons; it cannot touch the count, because `attempt` is allocated past every episode
   * ever recorded.
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
   * a page rather than a history whenever `episodesMissing` is non-zero — and under the ring
   * (0041 part 2) that is no longer only a paging artefact: for an outbox row that has died
   * more than `crm.outbox_dead_letter_ring_size()` times, both flags describe THE NEWEST
   * FIFTY EPISODES and not the history, because the older ones no longer exist to compare.
   * Neither flag changes; the scope of the claim does, and `episodesMissing` is how a reader
   * knows which they are being given.
   *
   * The first entry's own `is_repeat_of_previous` is deliberately not folded in: for a
   * complete history it is always false, since episode 1 has no predecessor, and counting it
   * would make `alwaysTheSameReason` unreachable. That exclusion also absorbs the trim —
   * the oldest SURVIVING entry has lost its predecessor, so its flag is false whether or not
   * it repeated one, and it is the entry these two skip.
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
