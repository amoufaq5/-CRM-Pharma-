export const VISIT_STATUSES = ["planned", "in_progress", "completed", "cancelled", "missed"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/**
 * Which status changes are legitimate.
 *
 * `missed` is deliberately reachable only from `planned`: a visit the rep turned
 * up to and abandoned is `completed` with outcome `no_access`, which is a
 * different fact from never having gone, and the two must not blur — coverage
 * reporting depends on telling them apart.
 *
 * `completed` and `cancelled` are terminal here as well as in the database. A
 * correction is a new visit, not an edit.
 */
export const VISIT_TRANSITIONS: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  planned: ["in_progress", "cancelled", "missed"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  missed: [],
};

export class InvalidTransitionError extends Error {
  /**
   * True when the SOURCE state has no outgoing transitions at all.
   *
   * The constructor already branched on this to choose its sentence — "a completed visit is
   * final" versus "cannot move a visit from planned to completed" — and then threw the
   * distinction away, so `problems.ts` had one error class covering two different facts and
   * answered both with the `visit_final` problem type. A `planned → completed` refusal
   * therefore came back titled "Visit is final" with a detail saying otherwise.
   *
   * Carried as a field rather than recomputed by the mapper, because `VISIT_TRANSITIONS` is
   * this package's to know and a second reader of it is a second thing to keep in step.
   */
  readonly fromIsFinal: boolean;

  constructor(
    readonly from: VisitStatus,
    readonly to: VisitStatus,
  ) {
    const allowed = VISIT_TRANSITIONS[from];
    super(
      allowed.length === 0
        ? `a ${from} visit is final and cannot become ${to}; record a correcting visit instead`
        : `cannot move a visit from ${from} to ${to} (allowed: ${allowed.join(", ")})`,
    );
    this.name = "InvalidTransitionError";
    this.fromIsFinal = allowed.length === 0;
  }
}

export function canTransition(from: VisitStatus, to: VisitStatus): boolean {
  return VISIT_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: VisitStatus, to: VisitStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isFinal(status: VisitStatus): boolean {
  return VISIT_TRANSITIONS[status].length === 0;
}
