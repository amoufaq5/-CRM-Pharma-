export {
  ORDERING_BACKOFF,
  PERIOD_BACKOFF,
  TRANSIENT_BACKOFF,
  nextDelayMs,
  policyFor,
  type BackoffPolicy,
} from "./backoff.js";
export { classify, isTerminal, type ClassifyInput, type Outcome, type OutcomeKind } from "./outcome.js";
export {
  UnknownOperationError,
  dispatch,
  idempotencyKeyFor,
  parseOperation,
  type ParsedOperation,
} from "./dispatch.js";
export {
  claimBatch,
  enqueueOutbox,
  markDead,
  markDelivered,
  markRetry,
  outboxLag,
  reclaimStale,
  type EnqueueInput,
  type OutboxLag,
  type OutboxRow,
  // Part of `enqueueOutbox`'s public return type, so a consumer that has to branch on it
  // can name it. Without this export the only way to say "the state the enqueue reported"
  // was `Awaited<ReturnType<typeof enqueueOutbox>>["state"]`, which is how `packages/sample`
  // had to spell it.
  type OutboxState,
} from "./store.js";
export { OutboxRelay, type RelayEvent, type RelayOptions, type RelayResult } from "./relay.js";
export {
  DeadLetterNotFoundError,
  deadLetter,
  deadLetters,
  outboxLetterOwner,
  raiseDeadLetterAlarm,
  reviveDeadLetter,
  teamDeadLetters,
  type DeadLetter,
  type DeadLetterAlarm,
  type OutboxLetterOwner,
} from "./dead-letters.js";
export {
  attemptHistory,
  recentDeaths,
  summariseAttemptHistory,
  type AttemptHistorySummary,
  type DeadLetterAttempt,
} from "./attempt-history.js";
export {
  PROBE_TIMEOUT_MS,
  probeTargetRecord,
  type ProbeOptions,
  type ProbeReader,
  type ProbeTarget,
  type ProbeVerdict,
} from "./probe.js";
