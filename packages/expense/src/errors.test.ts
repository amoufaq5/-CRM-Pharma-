import { describe, expect, it } from "vitest";

import {
  ApprovalFieldsError,
  ExpenseClaimNotFoundError,
  FourEyesViolationError,
  InvalidAccountCodeError,
  InvalidAmountError,
  InvalidCategoryError,
  InvalidCurrencyError,
  InvalidDateError,
  MissingAccountSnapshotError,
  MissingErpExpenseIdError,
  RepNotMappedToEmployeeError,
  UnmappedCategoryError,
  translateExpenseClaimError,
} from "./errors.js";

/**
 * The translation layer.
 *
 * What is asserted is that each of 0006's refusals becomes a TYPED error whose message
 * tells the caller what to do — because a constraint name in an HTTP 500 is the failure
 * mode these classes exist to prevent. The constraint names come from the migration and
 * the live messages are pinned by `store.contract.test.ts`, which catches the real thing.
 */
describe("UnmappedCategoryError", () => {
  it("names the category", () => {
    expect(new UnmappedCategoryError("congress").message).toContain('"congress"');
  });

  it("says who has to act and where", () => {
    const msg = new UnmappedCategoryError("congress").message;
    expect(msg).toContain("Finance");
    expect(msg).toContain("crm.expense_account_map");
    expect(msg).toContain("LedgerAccount.account_code");
  });

  it("says what happens meanwhile, so the caller does not read it as a bug", () => {
    expect(new UnmappedCategoryError("x").message).toContain("stays in draft");
  });

  it("explains why a guess would be worse", () => {
    expect(new UnmappedCategoryError("x").message).toContain("mis-state the P&L");
  });

  it("keeps the category for a caller that wants to render it separately", () => {
    expect(new UnmappedCategoryError("hospitality").crmCategory).toBe("hospitality");
  });
});

describe("translateExpenseClaimError", () => {
  const pgError = (constraint: string): Error =>
    Object.assign(new Error(`new row violates check constraint "${constraint}"`), {
      code: "23514",
      constraint,
    });

  it("turns expense_claim_four_eyes into FourEyesViolationError", () => {
    const err = translateExpenseClaimError(pgError("expense_claim_four_eyes"));
    expect(err).toBeInstanceOf(FourEyesViolationError);
    expect(err.message).toContain("cannot be approved by the rep who submitted it");
  });

  it("explains in the four-eyes message why the CRM is the one enforcing it", () => {
    const err = translateExpenseClaimError(pgError("expense_claim_four_eyes"));
    expect(err.message).toContain("report R7");
  });

  it("turns expense_claim_snapshot_before_submit into MissingAccountSnapshotError", () => {
    const err = translateExpenseClaimError(pgError("expense_claim_snapshot_before_submit"));
    expect(err).toBeInstanceOf(MissingAccountSnapshotError);
    expect(err.message).toContain("submitClaim");
  });

  it("turns expense_claim_approved_fields into ApprovalFieldsError", () => {
    const err = translateExpenseClaimError(pgError("expense_claim_approved_fields"));
    expect(err).toBeInstanceOf(ApprovalFieldsError);
  });

  it("recognises a constraint named only in the message text", () => {
    const bare = Object.assign(new Error('violates check constraint "expense_claim_four_eyes"'), {
      code: "23514",
    });
    expect(translateExpenseClaimError(bare)).toBeInstanceOf(FourEyesViolationError);
  });

  it("reads the unnamed amount CHECK as an amount problem", () => {
    const err = translateExpenseClaimError(
      Object.assign(new Error('violates check constraint "expense_claim_amount_check"'), {
        code: "23514",
      }),
    );
    expect(err).toBeInstanceOf(InvalidAmountError);
  });

  it("passes an unrecognised Error through unchanged", () => {
    const original = new Error("connection terminated unexpectedly");
    expect(translateExpenseClaimError(original)).toBe(original);
  });

  it("wraps a thrown non-Error so the caller always gets an Error", () => {
    const err = translateExpenseClaimError("something threw a string");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something threw a string");
  });

  it("does not mistake a foreign-key violation for a CHECK", () => {
    const fk = Object.assign(new Error("violates foreign key constraint"), {
      code: "23503",
      constraint: "expense_claim_rep_profile_id_fkey",
    });
    expect(translateExpenseClaimError(fk)).toBe(fk);
  });

  it("survives an error object with no code, constraint or message", () => {
    expect(translateExpenseClaimError({})).toBeInstanceOf(Error);
  });
});

describe("the shape guards the database cannot make", () => {
  it("says explicitly that NaN passes 0006's amount CHECK", () => {
    expect(new InvalidAmountError("NaN").message).toContain("CHECK (amount > 0)");
  });

  it("says explicitly that char(3) pads rather than refuses", () => {
    expect(new InvalidCurrencyError("us").message).toContain("pads");
  });

  it("names the field on a bad date", () => {
    const err = new InvalidDateError("incurredOn", "01/09/2026");
    expect(err.message).toContain("incurredOn");
    expect(err.field).toBe("incurredOn");
  });

  it("cites the ERP's own 32-character limit on account codes", () => {
    const err = new InvalidAccountCodeError("erp_ledger_account_code", "x".repeat(33));
    expect(err.message).toContain("maxLength 32");
    expect(err.field).toBe("erp_ledger_account_code");
  });

  it("refuses a blank category by name", () => {
    expect(new InvalidCategoryError("  ").message).toContain("non-blank");
  });
});

describe("the posting preconditions", () => {
  it("tells the operator which rep is unreconciled and what the join key is", () => {
    const err = new RepNotMappedToEmployeeError("rep-1");
    expect(err.message).toContain("rep-1");
    expect(err.message).toContain("employee_number is the join key");
    expect(err.repProfileId).toBe("rep-1");
  });

  it("refuses to re-mint an ERP id for a claim already marked posted", () => {
    const err = new MissingErpExpenseIdError("claim-9");
    expect(err.message).toContain("claim-9");
    expect(err.message).toContain("other than postClaim");
  });

  it("names a missing claim rather than returning null from a required read", () => {
    expect(new ExpenseClaimNotFoundError("c1").message).toBe("no expense claim c1");
  });

  it("gives every class a name that survives serialisation", () => {
    const errors = [
      new ExpenseClaimNotFoundError("c"),
      new UnmappedCategoryError("c"),
      new FourEyesViolationError("m"),
      new MissingAccountSnapshotError("m"),
      new ApprovalFieldsError("m"),
      new InvalidAmountError("v"),
      new InvalidCurrencyError("v"),
      new InvalidDateError("f", "v"),
      new InvalidAccountCodeError("f", "v"),
      new InvalidCategoryError("v"),
      new RepNotMappedToEmployeeError("r"),
      new MissingErpExpenseIdError("c"),
    ];
    for (const err of errors) {
      expect(err.name).not.toBe("Error");
      expect(err.name).toBe(err.constructor.name);
    }
  });
});
