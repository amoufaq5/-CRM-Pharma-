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
