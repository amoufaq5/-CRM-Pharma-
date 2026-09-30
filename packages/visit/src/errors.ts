/** A rep recording a visit against an account they did not cover on that date. */
export class OutsideTerritoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutsideTerritoryError";
  }
}

/** An edit or delete against a completed or cancelled visit. */
export class VisitIsFinalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisitIsFinalError";
  }
}

export class VisitNotFoundError extends Error {
  constructor(id: string) {
    super(`visit ${id} not found in this tenant`);
    this.name = "VisitNotFoundError";
  }
}

/**
 * Turns the database's own refusals into typed errors.
 *
 * Both rules are enforced by triggers, so they raise `check_violation` with a
 * message rather than a distinguishable SQLSTATE. Matching on the message is
 * unlovely but it is the only signal Postgres gives, and the alternative —
 * re-checking in application code — would mean two implementations of a rule
 * that must not disagree.
 */
export function translateVisitError(err: unknown): Error {
  const message = (err as { message?: string })?.message ?? "";
  if (message.includes("did not cover account")) return new OutsideTerritoryError(message);
  if (message.includes("cannot be edited") || message.includes("cannot be deleted")) {
    return new VisitIsFinalError(message);
  }
  if (message.includes("detailing lines cannot be changed")) return new VisitIsFinalError(message);
  return err instanceof Error ? err : new Error(String(err));
}
