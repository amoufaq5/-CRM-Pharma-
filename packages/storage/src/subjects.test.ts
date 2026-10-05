import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_PURPOSES,
  ATTACHMENT_STATUSES,
  ATTACHMENT_STORAGE_BACKENDS,
  ATTACHMENT_SUBJECT_TABLES,
  COMMITTED_PURPOSES,
  SUBJECT_TABLE_BY_PURPOSE,
  SUPERSEDABLE_PURPOSES,
  isAttachmentContentType,
  isAttachmentPurpose,
  isAttachmentStatus,
  isAttachmentSubjectTable,
  isCommittedPurpose,
  isSupersedablePurpose,
  subjectTableFor,
  type AttachmentPurpose,
} from "./subjects.js";

/**
 * The vocabulary, on its own.
 *
 * These are constants rather than lookups for the reason ADR-0001 item 13 gives about
 * roles: "a role nothing checks is worse than no role", so adding a purpose should
 * require a migration AND the rule that honours it. The three-way agreement between these
 * constants, the CHECK constraints and the SQL branches is asserted in
 * `subject-coverage.contract.test.ts`; this file asserts the constants are internally
 * coherent, which no database can tell us.
 */
describe("attachment vocabulary", () => {
  it("names the two purposes the system can write", () => {
    expect(ATTACHMENT_PURPOSES).toEqual(["disbursement_signature", "expense_receipt"]);
  });

  it("names the two subject tables", () => {
    expect(ATTACHMENT_SUBJECT_TABLES).toEqual(["crm.sample_transaction", "crm.expense_claim"]);
  });

  it("names the three content types, and does not admit svg", () => {
    expect(ATTACHMENT_CONTENT_TYPES).toEqual(["image/png", "image/jpeg", "application/pdf"]);
    // Deliberate, and the reason is in `subjects.ts`: SVG is a script container and
    // something will eventually hand one to a browser.
    expect(ATTACHMENT_CONTENT_TYPES as readonly string[]).not.toContain("image/svg+xml");
    expect(ATTACHMENT_CONTENT_TYPES as readonly string[]).not.toContain("application/octet-stream");
  });

  it("has one storage backend, and a column that could hold two", () => {
    expect(ATTACHMENT_STORAGE_BACKENDS).toEqual(["postgres"]);
  });

  it("has no deleted status, because there is no deletion", () => {
    expect(ATTACHMENT_STATUSES).toEqual(["current", "superseded"]);
    expect(ATTACHMENT_STATUSES as readonly string[]).not.toContain("deleted");
  });

  it("maps every purpose to a subject table", () => {
    for (const purpose of ATTACHMENT_PURPOSES) {
      expect(Object.keys(SUBJECT_TABLE_BY_PURPOSE)).toContain(purpose);
      expect(ATTACHMENT_SUBJECT_TABLES as readonly string[]).toContain(SUBJECT_TABLE_BY_PURPOSE[purpose]);
    }
    expect(Object.keys(SUBJECT_TABLE_BY_PURPOSE).sort()).toEqual([...ATTACHMENT_PURPOSES].sort());
  });

  it("maps a signature to the ledger and a receipt to the claim", () => {
    expect(subjectTableFor("disbursement_signature")).toBe("crm.sample_transaction");
    expect(subjectTableFor("expense_receipt")).toBe("crm.expense_claim");
  });

  /**
   * The two sets are complementary, and that is not a coincidence to be left implicit: a
   * purpose whose bytes must match a commitment somebody else recorded cannot also be
   * replaceable, because replacing it would mean the commitment was wrong.
   */
  it("makes exactly the committed purposes unsupersedable", () => {
    const committed = new Set<AttachmentPurpose>(COMMITTED_PURPOSES);
    const supersedable = new Set<AttachmentPurpose>(SUPERSEDABLE_PURPOSES);
    for (const purpose of ATTACHMENT_PURPOSES) {
      expect(committed.has(purpose), `${purpose} committed`).toBe(!supersedable.has(purpose));
    }
  });

  it("lets a receipt be superseded", () => {
    expect(isSupersedablePurpose("expense_receipt")).toBe(true);
    expect(isCommittedPurpose("expense_receipt")).toBe(false);
  });

  it("refuses to supersede a signature, because the ledger commitment is final", () => {
    expect(isSupersedablePurpose("disbursement_signature")).toBe(false);
    expect(isCommittedPurpose("disbursement_signature")).toBe(true);
  });

  it("accepts the purposes it declares", () => {
    for (const purpose of ATTACHMENT_PURPOSES) expect(isAttachmentPurpose(purpose)).toBe(true);
  });

  it("rejects a purpose it does not declare", () => {
    for (const value of ["", "signature", "DISBURSEMENT_SIGNATURE", "visit_photo", null, 7, {}]) {
      expect(isAttachmentPurpose(value), String(value)).toBe(false);
    }
  });

  it("accepts the subject tables it declares", () => {
    for (const table of ATTACHMENT_SUBJECT_TABLES) expect(isAttachmentSubjectTable(table)).toBe(true);
  });

  it("rejects an unqualified or unknown subject table", () => {
    // Unqualified is refused on purpose: the SQL branches match the schema-qualified
    // name, so `sample_transaction` would resolve to no owner and therefore to no reader.
    for (const value of ["sample_transaction", "crm.visit", "public.attachment", undefined]) {
      expect(isAttachmentSubjectTable(value), String(value)).toBe(false);
    }
  });

  it("accepts the content types it declares", () => {
    for (const type of ATTACHMENT_CONTENT_TYPES) expect(isAttachmentContentType(type)).toBe(true);
  });

  it("rejects a content type it does not declare, including a parameterised one", () => {
    for (const value of ["image/svg+xml", "text/html", "image/png; charset=utf-8", "IMAGE/PNG", ""]) {
      expect(isAttachmentContentType(value), value).toBe(false);
    }
  });

  it("accepts the statuses it declares and nothing else", () => {
    expect(isAttachmentStatus("current")).toBe(true);
    expect(isAttachmentStatus("superseded")).toBe(true);
    expect(isAttachmentStatus("deleted")).toBe(false);
    expect(isAttachmentStatus("quarantined")).toBe(false);
  });

  /**
   * The ERP's `files` package declares `uploading -> scanning -> available -> quarantined
   * -> archived` and has no runtime behind any of it. Declaring the same states here with
   * nothing scanning would be that mistake with our name on it (README rule 29), so the
   * absence is asserted rather than left to be noticed.
   */
  it("declares no lifecycle state nothing implements", () => {
    for (const unbuilt of ["uploading", "scanning", "available", "archived"]) {
      expect(ATTACHMENT_STATUSES as readonly string[]).not.toContain(unbuilt);
    }
  });

  it("keeps the vocabulary sets free of duplicates", () => {
    const sets: ReadonlyArray<readonly string[]> = [
      ATTACHMENT_PURPOSES,
      ATTACHMENT_SUBJECT_TABLES,
      ATTACHMENT_CONTENT_TYPES,
      ATTACHMENT_STATUSES,
      ATTACHMENT_STORAGE_BACKENDS,
    ];
    for (const set of sets) {
      expect(new Set(set).size).toBe(set.length);
    }
  });
});
