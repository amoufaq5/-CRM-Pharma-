/** A date that is not `YYYY-MM-DD`, or a range that ends before it starts. */
export class InvalidDateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateRangeError";
  }
}

/**
 * An assignment would overlap one already in force.
 *
 * Raised by the database's EXCLUDE constraint and translated here, because
 * `conflicting key value violates exclusion constraint` tells a caller nothing
 * about what they did wrong.
 */
export class OverlappingAssignmentError extends Error {
  constructor(
    readonly subject: string,
    readonly from: string,
  ) {
    super(
      `${subject} already has an assignment covering ${from}. ` +
        `Close the existing one first — reassignAccount does this atomically.`,
    );
    this.name = "OverlappingAssignmentError";
  }
}

export class TerritoryCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerritoryCycleError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(label: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new InvalidDateRangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    throw new InvalidDateRangeError(`${label} is not a real calendar date: ${value}`);
  }
}

export function assertRange(from: string, to: string | null): void {
  assertDate("valid_from", from);
  if (to === null) return;
  assertDate("valid_to", to);
  if (to <= from) {
    // `valid_to` is exclusive, so equal dates describe an empty range — almost
    // always a caller meaning "one day" and getting zero.
    throw new InvalidDateRangeError(
      `valid_to (${to}) must be after valid_from (${from}); the range is half-open [from, to)`,
    );
  }
}

/** Recognises the database's own refusals so callers get a typed error. */
export function translatePgError(err: unknown, subject: string, from: string): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23P01") return new OverlappingAssignmentError(subject, from);
  if (e?.message?.includes("territory hierarchy cycle") === true) {
    return new TerritoryCycleError(e.message);
  }
  if (e?.message?.includes("territory hierarchy deeper") === true) {
    return new TerritoryCycleError(e.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}
