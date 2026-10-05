import { describe, expect, it } from "vitest";

import {
  APPROVED_STATES,
  EXPENSE_CLAIM_STATES,
  EXPENSE_CLAIM_TRANSITIONS,
  InvalidExpenseClaimTransitionError,
  SNAPSHOT_REQUIRED_STATES,
  assertExpenseClaimTransition,
  canTransitionExpenseClaim,
  isExpenseClaimState,
  isFinalExpenseClaimState,
  requiresAccountSnapshot,
  requiresApproval,
  type ExpenseClaimState,
} from "./states.js";

/**
 * The lifecycle, pinned against 0006.
 *
 * The constants here are not the authority — the CHECK constraints are — so the tests
 * that matter most are the ones that would fail if this map and the migration ever
 * disagreed.
 */
describe("EXPENSE_CLAIM_STATES", () => {
  it("lists exactly the six values 0006's state CHECK allows, in its order", () => {
    expect(EXPENSE_CLAIM_STATES).toEqual([
      "draft",
      "submitted",
      "approved",
      "rejected",
      "posted",
      "reimbursed",
    ]);
  });

  it("has a transition entry for every state and no others", () => {
    expect(Object.keys(EXPENSE_CLAIM_TRANSITIONS).sort()).toEqual([...EXPENSE_CLAIM_STATES].sort());
  });

  it("never names a target that is not itself a state", () => {
    for (const targets of Object.values(EXPENSE_CLAIM_TRANSITIONS)) {
      for (const target of targets) expect(EXPENSE_CLAIM_STATES).toContain(target);
    }
  });

  it("recognises its own members", () => {
    for (const state of EXPENSE_CLAIM_STATES) expect(isExpenseClaimState(state)).toBe(true);
  });

  it("refuses a value that only looks like a state", () => {
    for (const bogus of ["paid", "Draft", "", "submitted "]) {
      expect(isExpenseClaimState(bogus)).toBe(false);
    }
  });
});

describe("the happy path", () => {
  it("runs draft -> submitted -> approved -> posted -> reimbursed", () => {
    const path: readonly ExpenseClaimState[] = [
      "draft",
      "submitted",
      "approved",
      "posted",
      "reimbursed",
    ];
    for (let i = 0; i + 1 < path.length; i += 1) {
      expect(canTransitionExpenseClaim(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("reaches every state from draft", () => {
    const seen = new Set<ExpenseClaimState>(["draft"]);
    for (let i = 0; i < EXPENSE_CLAIM_STATES.length; i += 1) {
      for (const from of [...seen]) {
        for (const to of EXPENSE_CLAIM_TRANSITIONS[from]) seen.add(to);
      }
    }
    expect([...seen].sort()).toEqual([...EXPENSE_CLAIM_STATES].sort());
  });
});

describe("rejection", () => {
  it("is reachable from submitted", () => {
    expect(canTransitionExpenseClaim("submitted", "rejected")).toBe(true);
  });

  it("is NOT reachable from approved — the posting is already handed over", () => {
    expect(canTransitionExpenseClaim("approved", "rejected")).toBe(false);
  });

  it("is not reachable from draft: there is nothing yet to reject", () => {
    expect(canTransitionExpenseClaim("draft", "rejected")).toBe(false);
  });

  it("is not reachable from posted or reimbursed", () => {
    expect(canTransitionExpenseClaim("posted", "rejected")).toBe(false);
    expect(canTransitionExpenseClaim("reimbursed", "rejected")).toBe(false);
  });
});

describe("refusals", () => {
  it("refuses skipping approval", () => {
    expect(canTransitionExpenseClaim("submitted", "posted")).toBe(false);
  });

  it("refuses skipping the posting", () => {
    expect(canTransitionExpenseClaim("approved", "reimbursed")).toBe(false);
  });

  it("refuses going back to draft from anywhere", () => {
    for (const from of EXPENSE_CLAIM_STATES) {
      expect(canTransitionExpenseClaim(from, "draft")).toBe(false);
    }
  });

  it("refuses a state becoming itself", () => {
    for (const state of EXPENSE_CLAIM_STATES) {
      expect(canTransitionExpenseClaim(state, state)).toBe(false);
    }
  });

  it("throws with the allowed set named", () => {
    try {
      assertExpenseClaimTransition("submitted", "posted");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidExpenseClaimTransitionError);
      expect((err as Error).message).toContain("approved, rejected");
    }
  });

  it("says a terminal claim is final rather than listing an empty set", () => {
    try {
      assertExpenseClaimTransition("reimbursed", "posted");
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("is final");
      expect((err as Error).message).toContain("raise a new claim");
    }
  });

  it("carries from and to on the error", () => {
    const err = new InvalidExpenseClaimTransitionError("draft", "approved");
    expect(err.from).toBe("draft");
    expect(err.to).toBe("approved");
    expect(err.name).toBe("InvalidExpenseClaimTransitionError");
  });

  it("passes a legal move without throwing", () => {
    expect(() => assertExpenseClaimTransition("draft", "submitted")).not.toThrow();
  });
});

describe("terminality", () => {
  it("treats rejected and reimbursed as final", () => {
    expect(isFinalExpenseClaimState("rejected")).toBe(true);
    expect(isFinalExpenseClaimState("reimbursed")).toBe(true);
  });

  it("treats everything else as live", () => {
    for (const state of ["draft", "submitted", "approved", "posted"] as const) {
      expect(isFinalExpenseClaimState(state)).toBe(false);
    }
  });
});

describe("the CHECK constraints this map has to agree with", () => {
  it("requires approved_at in exactly approved, posted and reimbursed", () => {
    expect([...APPROVED_STATES]).toEqual(["approved", "posted", "reimbursed"]);
    for (const state of EXPENSE_CLAIM_STATES) {
      expect(requiresApproval(state)).toBe(APPROVED_STATES.includes(state));
    }
  });

  it("does NOT require approved_at in rejected — the CHECK is an equality, not an implication", () => {
    expect(requiresApproval("rejected")).toBe(false);
  });

  it("requires an account snapshot in every state but draft", () => {
    expect([...SNAPSHOT_REQUIRED_STATES]).toEqual([
      "submitted",
      "approved",
      "rejected",
      "posted",
      "reimbursed",
    ]);
    for (const state of EXPENSE_CLAIM_STATES) {
      expect(requiresAccountSnapshot(state)).toBe(state !== "draft");
    }
  });

  it("requires the snapshot the moment the first legal move out of draft happens", () => {
    for (const to of EXPENSE_CLAIM_TRANSITIONS.draft) {
      expect(requiresAccountSnapshot(to)).toBe(true);
    }
  });

  it("never leads out of draft to a state needing approved_at", () => {
    // draft -> submitted is the only exit, and a submitted claim has not been approved,
    // so no single transition can need both the snapshot and an approval timestamp.
    for (const to of EXPENSE_CLAIM_TRANSITIONS.draft) expect(requiresApproval(to)).toBe(false);
  });
});
