import { describe, expect, it } from "vitest";

import {
  CRM_RETENTION_OBLIGATIONS,
  DISPOSITIONS,
  ERP_RETENTION_OBLIGATIONS,
  NOT_A_BASIS,
  RETENTION_OBLIGATIONS,
  isRetentionObligation,
} from "./obligations.js";

describe("the retention-obligation vocabulary", () => {
  /**
   * THE ERP'S HALF, SPELLED EXACTLY. Pinned as literals rather than derived, because the whole
   * value of matching the ERP code for code is lost the moment one side renames one — and a
   * test that computed the expectation from the constant would pass through a rename happily.
   * `scripts/verify-live-erp.sh` compares these against the ERP's own source; this is the
   * cheap copy that fails in the suite.
   */
  it("carries the ERP's five codes and `none`, spelled as the ERP spells them", () => {
    expect([...ERP_RETENTION_OBLIGATIONS]).toEqual([
      "tax_records_7y",
      "medical_records_10y",
      "audit_logs_3y",
      "financial_transactions_7y",
      "anti_money_laundering_5y",
      "none",
    ]);
  });

  it("adds exactly two of its own, and says which", () => {
    expect([...CRM_RETENTION_OBLIGATIONS]).toEqual(["drug_sample_custody", "deletion_evidence"]);
    for (const code of CRM_RETENTION_OBLIGATIONS) {
      expect(ERP_RETENTION_OBLIGATIONS as readonly string[]).not.toContain(code);
    }
  });

  it("is the two halves and nothing else, with no duplicates", () => {
    expect([...RETENTION_OBLIGATIONS]).toEqual([
      ...ERP_RETENTION_OBLIGATIONS,
      ...CRM_RETENTION_OBLIGATIONS,
    ]);
    expect(new Set(RETENTION_OBLIGATIONS).size).toBe(RETENTION_OBLIGATIONS.length);
  });

  /**
   * `drug_sample_custody` deliberately carries no period where every ERP code does. The period
   * is jurisdictional and lives in the register row's note; a number in the code name would
   * make every deployment outside that jurisdiction either wrong or forced to misuse the code.
   */
  it("gives the sample-custody code no period in its name", () => {
    expect("drug_sample_custody").not.toMatch(/\d/);
    for (const code of ERP_RETENTION_OBLIGATIONS) {
      if (code !== "none") expect(code).toMatch(/_\d+y$/);
    }
  });

  it("treats `none` as not a basis for keeping anything", () => {
    expect([...NOT_A_BASIS]).toEqual(["none"]);
    expect(RETENTION_OBLIGATIONS as readonly string[]).toContain("none");
  });

  it("recognises its own codes and nothing else", () => {
    for (const code of RETENTION_OBLIGATIONS) expect(isRetentionObligation(code)).toBe(true);
    for (const code of ["tax_records", "none_", "TAX_RECORDS_7Y", ""]) {
      expect(isRetentionObligation(code)).toBe(false);
    }
  });

  /** `anonymise` is deliberately absent. See 0051's header: nothing wants it yet. */
  it("offers three dispositions and not a fourth nothing implements", () => {
    expect([...DISPOSITIONS]).toEqual(["erase", "retain", "undecided"]);
    expect(DISPOSITIONS as readonly string[]).not.toContain("anonymise");
  });
});
