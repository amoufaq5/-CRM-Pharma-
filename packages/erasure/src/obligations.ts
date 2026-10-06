/**
 * The retention-obligation vocabulary, and which half of it is not ours.
 *
 * Mirrors `crm.retention_obligations()` (migration 0051), which in turn takes five codes
 * verbatim from CrossEngin's `RETENTION_OBLIGATIONS` in
 * `packages/tenant-lifecycle/src/gdpr-deletion.ts`. The spellings are deliberate: a CRM
 * obligation the ERP's enum can express uses the ERP's word for it, so a deletion recorded on
 * both sides of the boundary reads as one record rather than two dialects.
 *
 * Three copies of this list now exist — here, in the SQL function, and in the ERP. The first
 * two are checked against each other by a contract test; the third by
 * `scripts/verify-live-erp.sh`, which greps the ERP's own source, because a vocabulary copied
 * by hand is a vocabulary that drifts and the whole value of matching spellings is lost the
 * first time one side renames a code.
 */

/** Taken from the ERP, spelled as the ERP spells them. Changing one of these is a bug. */
export const ERP_RETENTION_OBLIGATIONS = [
  "tax_records_7y",
  "medical_records_10y",
  "audit_logs_3y",
  "financial_transactions_7y",
  "anti_money_laundering_5y",
  "none",
] as const;

/**
 * This CRM's own, for obligations the ERP has no word for.
 *
 * `drug_sample_custody` carries no period, unlike every ERP code, and that is the honest
 * shape: how long a pharma company must keep drug-sample custody records differs by
 * jurisdiction, so a number in the code name would make every deployment outside that
 * jurisdiction either wrong or forced to misuse the code. The period lives in the register
 * row's `obligation_note`, where the deployment's actual rule can be named.
 *
 * `deletion_evidence` is not a statutory retention at all: it is the receipt. Destroying the
 * proof that a deletion happened defeats the deletion.
 */
export const CRM_RETENTION_OBLIGATIONS = ["drug_sample_custody", "deletion_evidence"] as const;

export const RETENTION_OBLIGATIONS = [
  ...ERP_RETENTION_OBLIGATIONS,
  ...CRM_RETENTION_OBLIGATIONS,
] as const;
export type RetentionObligation = (typeof RETENTION_OBLIGATIONS)[number];

/**
 * `none` is in the vocabulary only so the two lists match code for code. It is never a basis
 * for keeping anything — `erase` already means "no obligation" — and the register's
 * `data_disposition_retain_has_basis` CHECK refuses it on a retain row.
 */
export const NOT_A_BASIS: readonly RetentionObligation[] = ["none"];

export function isRetentionObligation(value: string): value is RetentionObligation {
  return (RETENTION_OBLIGATIONS as readonly string[]).includes(value);
}

/** What the register can say about a table. See 0051 on why `undecided` is first-class. */
export const DISPOSITIONS = ["erase", "retain", "undecided"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
