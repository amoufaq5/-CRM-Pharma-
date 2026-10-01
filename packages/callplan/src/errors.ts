/**
 * The database refuses these, and the raw message is unhelpful to a caller.
 *
 * Each class below corresponds to one rule in 0015/0016. Translating rather than
 * re-checking in TypeScript is deliberate: a second implementation of the rule
 * would eventually disagree with the one the database enforces, and the database's
 * is the one that holds for the offline-sync path and a psql prompt too.
 */

export class CallPlanNotFoundError extends Error {
  constructor(id: string) {
    super(`no call plan ${id}`);
    this.name = "CallPlanNotFoundError";
  }
}

/** The target account is not the plan rep's at any point in the cycle. */
export class TargetOutsideTerritoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetOutsideTerritoryError";
  }
}

/** A status move the lifecycle map does not allow. */
export class InvalidPlanTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanTransitionError";
  }
}

/** The plan is approved or later; its substance is fixed. */
export class PlanFrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanFrozenError";
  }
}

/**
 * The approver is the rep, the submitter, or does not manage the rep's territory.
 *
 * Three distinct causes with one consequence, so one error type carrying the
 * database's own message — which names which of the three it was.
 */
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}

/** A live plan already exists for this rep and cycle. */
export class DuplicatePlanError extends Error {
  constructor(cycleId: string, repProfileId: string) {
    super(
      `rep ${repProfileId} already has a live plan for cycle ${cycleId}. ` +
        `Supersede it rather than creating a second — "the plan for this cycle" must have one answer.`,
    );
    this.name = "DuplicatePlanError";
  }
}

export class DuplicateTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateTargetError";
  }
}

export class InvalidCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCycleError";
  }
}

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

/** Recognises the database's refusals. Anything unrecognised passes through unchanged. */
export function translateCallPlanError(err: unknown, ctx: { cycleId?: string; repProfileId?: string } = {}): Error {
  const e = err as PgErrorShape;
  const message = e?.message ?? "";

  if (e?.constraint === "uq_call_plan_live" || (e?.code === "23505" && message.includes("uq_call_plan_live"))) {
    return new DuplicatePlanError(ctx.cycleId ?? "?", ctx.repProfileId ?? "?");
  }
  if (e?.code === "23505" && message.includes("call_plan_target")) {
    return new DuplicateTargetError(
      `that account is already a target of this plan. ` +
        `A second row for the same account would be counted twice against adherence.`,
    );
  }
  if (message.includes("does not cover account")) return new TargetOutsideTerritoryError(message);
  if (message.includes("cannot move from")) return new InvalidPlanTransitionError(message);
  if (message.includes("are fixed")) return new PlanFrozenError(message);
  if (message.includes("cannot be deleted")) return new PlanFrozenError(message);
  if (message.includes("they cannot approve")) return new ApprovalRefusedError(message);
  if (e?.constraint?.startsWith("call_plan_four_eyes") === true) {
    return new ApprovalRefusedError(
      `the approver cannot be the rep whose plan it is, nor whoever submitted it (four-eyes): ${message}`,
    );
  }
  if (e?.constraint?.startsWith("cycle_") === true) return new InvalidCycleError(message);

  return err instanceof Error ? err : new Error(String(err));
}
