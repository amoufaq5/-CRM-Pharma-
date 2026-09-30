export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Cap on attempts before a retryable failure is dead-lettered. */
  readonly maxAttempts: number;
}

/** Ordinary transient failures: fast at first, capped at 5 minutes. */
export const TRANSIENT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 5 * 60 * 1_000,
  maxAttempts: 10,
};

/**
 * Ordering waits (a transition whose create has not landed). Shorter ceiling
 * and fewer attempts than a transient fault: if the sibling row has not arrived
 * within a couple of minutes it is stuck too, and a second row grinding away
 * adds noise rather than progress.
 */
export const ORDERING_BACKOFF: BackoffPolicy = {
  baseMs: 2_000,
  maxMs: 60_000,
  maxAttempts: 8,
};

/**
 * A locked fiscal period. Hours, not seconds — this waits on an accountant
 * opening the next period, and the attempt cap is generous because the entry is
 * CORRECT and dropping it would silently lose legitimate spend.
 */
export const PERIOD_BACKOFF: BackoffPolicy = {
  baseMs: 15 * 60 * 1_000,
  maxMs: 6 * 60 * 60 * 1_000,
  maxAttempts: 60,
};

/**
 * Full-jitter exponential backoff: `random(0, min(max, base * 2^n))`.
 *
 * Full jitter rather than the exponential value itself, because every row in a
 * batch fails at the same instant when the ERP is down — undithered, they would
 * all return together and re-stampede it on every cycle.
 */
export function nextDelayMs(
  attempts: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);
  // Clamp the exponent before shifting: 2 ** 1024 is Infinity, and Infinity * 0
  // (a plausible random()) is NaN, which would land in the database as a null
  // next_attempt_at and make the row invisible forever.
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(exponent, 30));
  return Math.floor(random() * ceiling);
}

export function policyFor(kind: "retry_transient" | "retry_ordering" | "retry_period"): BackoffPolicy {
  switch (kind) {
    case "retry_ordering":
      return ORDERING_BACKOFF;
    case "retry_period":
      return PERIOD_BACKOFF;
    default:
      return TRANSIENT_BACKOFF;
  }
}
