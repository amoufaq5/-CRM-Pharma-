import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { appPool, TENANT_FK_A, TENANT_FK_B } from "./testing.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * Can a row in one tenant still name a record in another?
 *
 * WHY THIS EXISTS. ADR-0001 carried it as an open item — "nothing but RLS and the explicit
 * tenant match stops one naming a profile in another tenant" — and it had already happened:
 * `crm.revoke_rep_role` matched a grant on its id alone, so a rep of one tenant ended a
 * grant in another. The fix was `AND tenant_id = p_tenant_id` in one function, which is a
 * fix the next function forgets. Migration 0035 made the whole class impossible instead:
 * every reference inside `crm.*` is now `(tenant_id, <ref>_id) REFERENCES
 * <target>(tenant_id, id)`.
 *
 * THIS SUITE CONNECTS AS `crm_app`, AND THAT IS THE WHOLE POINT. The original bug survived
 * a green suite because the suite connected as a superuser, so row-level security was off
 * for every test in it and no assertion about tenant isolation could have meant anything.
 * `appPool()` connects as `crm_app` — `NOSUPERUSER NOBYPASSRLS`, and the owner of these
 * tables under FORCE ROW LEVEL SECURITY — and `withTenantContext` refuses any role that
 * is exempt. A test here that passes has passed under the policy.
 *
 * WHY EACH PROBE DISABLES THE *USER* TRIGGERS ON THE TABLE IT WRITES. The thing under test
 * is a foreign key, and a foreign key is checked after the BEFORE triggers have had their
 * say. Several of these tables have one that would raise first — `sample_holding_guard`
 * refuses every direct write, `sample_transaction_validate` refuses a `transfer_of` it
 * cannot see, `visit_check_territory` refuses a rep who covers no account — and a test that
 * accepted any error as proof would pass just as happily with no constraint there at all.
 * `ALTER TABLE … DISABLE TRIGGER USER` leaves the internal referential triggers running (it
 * touches only non-internal ones), so each probe is answered by the constraint it names and
 * by nothing else. It is done inside a transaction that always rolls back, so the schema is
 * the same afterwards; and `crm_app` owns these tables, which is why it is permitted at all.
 *
 * `reproduces the shipped bug` below is the one probe that runs with everything live, so the
 * end-to-end path is covered too rather than only the constraint in isolation.
 */

/** The 38 references migration 0035 made tenant-scoped, and what each one must still be. */
interface Hardened {
  /** The referencing table, unqualified. */
  readonly table: string;
  /** The referencing column, which pairs with `tenant_id`. */
  readonly column: string;
  /** The referenced table, unqualified. Always referenced by `(tenant_id, id)`. */
  readonly parent: string;
  /**
   * Preserved exactly from before 0035 — this is the business rule, and a drop-and-recreate
   * is where one gets silently rewritten. CASCADE means the child is part of the parent;
   * RESTRICT means the child is the audit trail and outlives nothing.
   */
  readonly onDelete: "RESTRICT" | "CASCADE";
  /** Only `call_plan.superseded_by`: both rows are written in one transaction. */
  readonly deferred?: true;
}

const HARDENED: Readonly<Record<string, Hardened>> = {
  account_assignment_territory_id_fkey: { table: "account_assignment", column: "territory_id", parent: "territory", onDelete: "RESTRICT" },

  territory_parent_id_fkey: { table: "territory", column: "parent_id", parent: "territory", onDelete: "RESTRICT" },
  territory_assignment_territory_id_fkey: { table: "territory_assignment", column: "territory_id", parent: "territory", onDelete: "RESTRICT" },
  territory_assignment_rep_profile_id_fkey: { table: "territory_assignment", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },

  call_plan_cycle_id_fkey: { table: "call_plan", column: "cycle_id", parent: "cycle", onDelete: "RESTRICT" },
  call_plan_rep_profile_id_fkey: { table: "call_plan", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  call_plan_submitted_by_fkey: { table: "call_plan", column: "submitted_by", parent: "rep_profile", onDelete: "RESTRICT" },
  call_plan_approved_by_fkey: { table: "call_plan", column: "approved_by", parent: "rep_profile", onDelete: "RESTRICT" },
  call_plan_superseded_by_fkey: { table: "call_plan", column: "superseded_by", parent: "call_plan", onDelete: "RESTRICT", deferred: true },
  call_plan_product_call_plan_id_fkey: { table: "call_plan_product", column: "call_plan_id", parent: "call_plan", onDelete: "CASCADE" },
  call_plan_target_call_plan_id_fkey: { table: "call_plan_target", column: "call_plan_id", parent: "call_plan", onDelete: "CASCADE" },

  visit_rep_profile_id_fkey: { table: "visit", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  visit_product_visit_id_fkey: { table: "visit_product", column: "visit_id", parent: "visit", onDelete: "CASCADE" },

  sample_transaction_lot_id_fkey: { table: "sample_transaction", column: "lot_id", parent: "sample_lot", onDelete: "RESTRICT" },
  sample_transaction_rep_profile_id_fkey: { table: "sample_transaction", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_transaction_counterparty_rep_profile_id_fkey: { table: "sample_transaction", column: "counterparty_rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_transaction_visit_id_fkey: { table: "sample_transaction", column: "visit_id", parent: "visit", onDelete: "RESTRICT" },
  sample_transaction_transfer_of_fkey: { table: "sample_transaction", column: "transfer_of", parent: "sample_transaction", onDelete: "RESTRICT" },
  sample_holding_rep_profile_id_fkey: { table: "sample_holding", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_holding_lot_id_fkey: { table: "sample_holding", column: "lot_id", parent: "sample_lot", onDelete: "RESTRICT" },
  sample_count_rep_profile_id_fkey: { table: "sample_count", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_count_counted_by_fkey: { table: "sample_count", column: "counted_by", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_count_line_count_id_fkey: { table: "sample_count_line", column: "count_id", parent: "sample_count", onDelete: "CASCADE" },
  sample_count_line_lot_id_fkey: { table: "sample_count_line", column: "lot_id", parent: "sample_lot", onDelete: "RESTRICT" },

  disposal_obligation_rep_profile_id_fkey: { table: "disposal_obligation", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  disposal_obligation_lot_id_fkey: { table: "disposal_obligation", column: "lot_id", parent: "sample_lot", onDelete: "RESTRICT" },
  disposal_obligation_resolving_transaction_id_fkey: { table: "disposal_obligation", column: "resolving_transaction_id", parent: "sample_transaction", onDelete: "RESTRICT" },
  disposal_obligation_continues_obligation_id_fkey: { table: "disposal_obligation", column: "continues_obligation_id", parent: "disposal_obligation", onDelete: "RESTRICT" },

  expense_claim_rep_profile_id_fkey: { table: "expense_claim", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  expense_claim_approved_by_fkey: { table: "expense_claim", column: "approved_by", parent: "rep_profile", onDelete: "RESTRICT" },
  expense_claim_rejected_by_fkey: { table: "expense_claim", column: "rejected_by", parent: "rep_profile", onDelete: "RESTRICT" },

  notification_recipient_rep_profile_id_fkey: { table: "notification", column: "recipient_rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  notification_delivery_notification_id_fkey: { table: "notification_delivery", column: "notification_id", parent: "notification", onDelete: "CASCADE" },
  notification_delivery_endpoint_id_fkey: { table: "notification_delivery", column: "endpoint_id", parent: "notification_endpoint", onDelete: "CASCADE" },

  outbox_revived_by_fkey: { table: "outbox", column: "revived_by", parent: "rep_profile", onDelete: "RESTRICT" },

  rep_role_rep_profile_id_fkey: { table: "rep_role", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  rep_role_granted_by_fkey: { table: "rep_role", column: "granted_by", parent: "rep_profile", onDelete: "RESTRICT" },
  rep_role_revoked_by_fkey: { table: "rep_role", column: "revoked_by", parent: "rep_profile", onDelete: "RESTRICT" },
};

/**
 * References into a tenant-scoped table that are STILL single-column, each with the reason.
 *
 * This is the drift guard, and an empty-by-intent list is the point of it: there is no good
 * reason for a reference inside `crm.*` to be tenant-blind, so nothing is here "by design".
 * Every entry is a DEBT — a table whose creating migration was authored in parallel with
 * 0035, named here so it is finite and visible rather than a quietly reopened class. A
 * reference that appears without being added here fails this suite, which is what makes the
 * next table somebody adds obey the rule without having to know it exists.
 *
 * Each needs the same treatment in a migration that can reach it — 0033 and 0034 both run
 * BEFORE 0035, so any later migration can convert their eight. 0035 does not, deliberately:
 * both files were still being written while this one was, and a migration that names another
 * in-flight file's constraints breaks the whole ordered chain if that file changes, where a
 * stale entry here breaks one test with a message saying what to do.
 *
 * `crm.outbox_dead_letter` (0036) is the counter-example worth knowing about, and it is NOT
 * in this list: that table carries `revived_by` with no foreign key at all, by its own
 * argument. A column with no reference is outside what this guard can see — it checks the
 * references that exist, not the ones that should.
 */
const AWAITING_CONVERSION: Readonly<Record<string, string>> = {
  attachment_uploaded_by_fkey:
    "crm.attachment (0033), authored in parallel with 0035 — owed (tenant_id, uploaded_by) -> crm.rep_profile (tenant_id, id)",
  attachment_supersedes_attachment_id_fkey:
    "crm.attachment self-reference (0033), authored in parallel with 0035 — owed (tenant_id, supersedes_attachment_id) -> crm.attachment (tenant_id, id)",
  attachment_superseded_by_attachment_id_fkey:
    "crm.attachment self-reference (0033), authored in parallel with 0035 — owed (tenant_id, superseded_by_attachment_id) -> crm.attachment (tenant_id, id)",
  attachment_blob_attachment_id_fkey:
    "crm.attachment_blob (0033), authored in parallel with 0035 — owed (tenant_id, attachment_id) -> crm.attachment (tenant_id, id)",
  attachment_access_attachment_id_fkey:
    "crm.attachment_access (0033), authored in parallel with 0035 — owed (tenant_id, attachment_id) -> crm.attachment (tenant_id, id)",
  attachment_access_read_by_fkey:
    "crm.attachment_access (0033), authored in parallel with 0035 — owed (tenant_id, read_by) -> crm.rep_profile (tenant_id, id)",
  notification_endpoint_probe_endpoint_id_fkey:
    "crm.notification_endpoint_probe (0034), authored in parallel with 0035 — owed (tenant_id, endpoint_id) -> crm.notification_endpoint (tenant_id, id)",
  notification_endpoint_probe_requested_by_fkey:
    "crm.notification_endpoint_probe (0034), authored in parallel with 0035 — owed (tenant_id, requested_by) -> crm.rep_profile (tenant_id, id)",
};

/** Deterministic fixture ids, one connected graph per tenant. */
interface Fixture {
  readonly rep1: string;
  readonly rep2: string;
  readonly terr1: string;
  readonly terr2: string;
  readonly cyc: string;
  readonly plan: string;
  readonly vis: string;
  readonly lot: string;
  readonly tx: string;
  readonly cnt: string;
  readonly obl: string;
  readonly ntf: string;
  readonly endp: string;
}

const fixture = (p: "a" | "b"): Fixture => ({
  rep1: `${p}0000000-0000-4000-8000-000000000001`,
  rep2: `${p}0000000-0000-4000-8000-000000000002`,
  terr1: `${p}0000000-0000-4000-8000-000000000011`,
  terr2: `${p}0000000-0000-4000-8000-000000000012`,
  cyc: `${p}0000000-0000-4000-8000-000000000021`,
  plan: `${p}0000000-0000-4000-8000-000000000031`,
  vis: `${p}0000000-0000-4000-8000-000000000041`,
  lot: `${p}0000000-0000-4000-8000-000000000051`,
  tx: `${p}0000000-0000-4000-8000-000000000061`,
  cnt: `${p}0000000-0000-4000-8000-000000000071`,
  obl: `${p}0000000-0000-4000-8000-000000000081`,
  ntf: `${p}0000000-0000-4000-8000-000000000091`,
  endp: `${p}0000000-0000-4000-8000-0000000000a1`,
});

const A = fixture("a");
const B = fixture("b");
const SIG = "0".repeat(64);

/** One probe per hardened reference: a tenant-B row that tries to name a tenant-A record. */
interface Probe {
  /** What the row is, for the test name. */
  readonly what: string;
  readonly sql: string;
  readonly params: readonly string[];
}

const PROBES: Readonly<Record<string, Probe>> = {
  account_assignment_territory_id_fkey: {
    what: "an account assigned to another tenant's territory",
    sql: `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
          VALUES ($1, 'acct-probe', $2, DATE '2021-01-01')`,
    params: [TENANT_FK_B, A.terr1],
  },
  territory_parent_id_fkey: {
    what: "a territory whose parent is in another tenant",
    sql: `INSERT INTO crm.territory (tenant_id, code, name, parent_id)
          VALUES ($1, 'FK-PROBE', 'Probe', $2)`,
    params: [TENANT_FK_B, A.terr1],
  },
  territory_assignment_territory_id_fkey: {
    what: "a rep assigned to another tenant's territory",
    sql: `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
          VALUES ($1, $2, $3, 'primary', DATE '2021-01-01')`,
    params: [TENANT_FK_B, A.terr1, B.rep2],
  },
  territory_assignment_rep_profile_id_fkey: {
    what: "another tenant's rep assigned to a territory",
    sql: `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
          VALUES ($1, $2, $3, 'primary', DATE '2021-01-01')`,
    params: [TENANT_FK_B, B.terr2, A.rep1],
  },
  call_plan_cycle_id_fkey: {
    what: "a call plan in another tenant's cycle",
    sql: `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, A.cyc, B.rep1],
  },
  call_plan_rep_profile_id_fkey: {
    what: "a call plan for another tenant's rep",
    sql: `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, B.cyc, A.rep1],
  },
  call_plan_submitted_by_fkey: {
    what: "a call plan submitted by another tenant's rep",
    sql: `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id, status, submitted_at, submitted_by)
          VALUES ($1, $2, $3, 'submitted', now(), $4)`,
    params: [TENANT_FK_B, B.cyc, B.rep2, A.rep1],
  },
  call_plan_approved_by_fkey: {
    what: "a call plan approved by another tenant's rep",
    sql: `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id, status,
                                     submitted_at, submitted_by, approved_at, approved_by)
          VALUES ($1, $2, $3, 'approved', now(), $4, now(), $5)`,
    params: [TENANT_FK_B, B.cyc, B.rep2, B.rep1, A.rep1],
  },
  call_plan_superseded_by_fkey: {
    what: "a call plan superseded by another tenant's plan",
    sql: `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id, status, superseded_by)
          VALUES ($1, $2, $3, 'superseded', $4)`,
    params: [TENANT_FK_B, B.cyc, B.rep2, A.plan],
  },
  call_plan_product_call_plan_id_fkey: {
    what: "a product line on another tenant's call plan",
    sql: `INSERT INTO crm.call_plan_product (tenant_id, call_plan_id, erp_item_id, position)
          VALUES ($1, $2, 'item-probe', 1)`,
    params: [TENANT_FK_B, A.plan],
  },
  call_plan_target_call_plan_id_fkey: {
    what: "a target on another tenant's call plan",
    sql: `INSERT INTO crm.call_plan_target (tenant_id, call_plan_id, erp_account_id, target_calls)
          VALUES ($1, $2, 'acct-probe', 1)`,
    params: [TENANT_FK_B, A.plan],
  },
  visit_rep_profile_id_fkey: {
    what: "a visit recorded by another tenant's rep",
    sql: `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, planned_for)
          VALUES (gen_random_uuid(), $1, $2, 'acct-fk', DATE '2026-02-03')`,
    params: [TENANT_FK_B, A.rep1],
  },
  visit_product_visit_id_fkey: {
    what: "a detailing line on another tenant's visit",
    sql: `INSERT INTO crm.visit_product (tenant_id, visit_id, erp_item_id, position)
          VALUES ($1, $2, 'item-probe', 1)`,
    params: [TENANT_FK_B, A.vis],
  },
  sample_transaction_lot_id_fkey: {
    what: "a custody movement of another tenant's lot",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'adjustment_in', 1, 'probe', now())`,
    params: [TENANT_FK_B, A.lot, B.rep1],
  },
  sample_transaction_rep_profile_id_fkey: {
    what: "a custody movement by another tenant's rep",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'adjustment_in', 1, 'probe', now())`,
    params: [TENANT_FK_B, B.lot, A.rep1],
  },
  sample_transaction_counterparty_rep_profile_id_fkey: {
    what: "a transfer out to another tenant's rep",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
                                              counterparty_rep_profile_id, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'transfer_out', 1, $4, now())`,
    params: [TENANT_FK_B, B.lot, B.rep1, A.rep1],
  },
  sample_transaction_visit_id_fkey: {
    what: "a disbursement attached to another tenant's visit",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
                                              erp_account_id, recipient_name, signature_sha256, visit_id, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'disbursement', 1, 'acct-fk', 'Dr Probe', $4, $5, now())`,
    params: [TENANT_FK_B, B.lot, B.rep1, SIG, A.vis],
  },
  sample_transaction_transfer_of_fkey: {
    what: "a recall of another tenant's transfer",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
                                              counterparty_rep_profile_id, transfer_of, occurred_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'transfer_recall', 1, $4, $5, now())`,
    params: [TENANT_FK_B, B.lot, B.rep1, B.rep2, A.tx],
  },
  sample_holding_rep_profile_id_fkey: {
    what: "a derived balance held by another tenant's rep",
    sql: `INSERT INTO crm.sample_holding (tenant_id, rep_profile_id, lot_id, quantity_on_hand, quantity_in_transit)
          VALUES ($1, $2, $3, 0, 0)`,
    params: [TENANT_FK_B, A.rep1, B.lot],
  },
  sample_holding_lot_id_fkey: {
    what: "a derived balance of another tenant's lot",
    sql: `INSERT INTO crm.sample_holding (tenant_id, rep_profile_id, lot_id, quantity_on_hand, quantity_in_transit)
          VALUES ($1, $2, $3, 0, 0)`,
    params: [TENANT_FK_B, B.rep2, A.lot],
  },
  sample_count_rep_profile_id_fkey: {
    what: "a stock count of another tenant's rep's bag",
    sql: `INSERT INTO crm.sample_count (tenant_id, rep_profile_id, counted_by, counted_at)
          VALUES ($1, $2, $3, now())`,
    params: [TENANT_FK_B, A.rep1, B.rep1],
  },
  sample_count_counted_by_fkey: {
    what: "a stock count carried out by another tenant's rep",
    sql: `INSERT INTO crm.sample_count (tenant_id, rep_profile_id, counted_by, counted_at)
          VALUES ($1, $2, $3, now())`,
    params: [TENANT_FK_B, B.rep2, A.rep1],
  },
  sample_count_line_count_id_fkey: {
    what: "a count line on another tenant's count",
    sql: `INSERT INTO crm.sample_count_line (tenant_id, count_id, lot_id, counted_quantity, expected_quantity)
          VALUES ($1, $2, $3, 1, 1)`,
    params: [TENANT_FK_B, A.cnt, B.lot],
  },
  sample_count_line_lot_id_fkey: {
    what: "a count line for another tenant's lot",
    sql: `INSERT INTO crm.sample_count_line (tenant_id, count_id, lot_id, counted_quantity, expected_quantity)
          VALUES ($1, $2, $3, 1, 1)`,
    params: [TENANT_FK_B, B.cnt, A.lot],
  },
  disposal_obligation_rep_profile_id_fkey: {
    what: "a disposal obligation raised against another tenant's rep",
    sql: `INSERT INTO crm.disposal_obligation (tenant_id, rep_profile_id, lot_id, quantity_at_discovery,
                                               expired_on, discovered_on, due_by)
          VALUES ($1, $2, $3, 1, DATE '2026-01-05', DATE '2026-01-06', DATE '2026-02-05')`,
    params: [TENANT_FK_B, A.rep1, B.lot],
  },
  disposal_obligation_lot_id_fkey: {
    what: "a disposal obligation for another tenant's lot",
    sql: `INSERT INTO crm.disposal_obligation (tenant_id, rep_profile_id, lot_id, quantity_at_discovery,
                                               expired_on, discovered_on, due_by)
          VALUES ($1, $2, $3, 1, DATE '2026-01-05', DATE '2026-01-06', DATE '2026-02-05')`,
    params: [TENANT_FK_B, B.rep2, A.lot],
  },
  disposal_obligation_resolving_transaction_id_fkey: {
    what: "a disposal resolved by another tenant's movement",
    sql: `INSERT INTO crm.disposal_obligation (tenant_id, rep_profile_id, lot_id, quantity_at_discovery,
                                               expired_on, discovered_on, due_by,
                                               status, resolved_on, resolution, resolving_transaction_id)
          VALUES ($1, $2, $3, 1, DATE '2026-01-05', DATE '2026-01-06', DATE '2026-02-05',
                  'resolved', DATE '2026-01-20', 'destroyed', $4)`,
    params: [TENANT_FK_B, B.rep2, B.lot, A.tx],
  },
  disposal_obligation_continues_obligation_id_fkey: {
    what: "a disposal continuing another tenant's obligation",
    sql: `INSERT INTO crm.disposal_obligation (tenant_id, rep_profile_id, lot_id, quantity_at_discovery,
                                               expired_on, discovered_on, due_by, continues_obligation_id)
          VALUES ($1, $2, $3, 1, DATE '2026-01-05', DATE '2026-01-06', DATE '2026-02-05', $4)`,
    params: [TENANT_FK_B, B.rep2, B.lot, A.obl],
  },
  expense_claim_rep_profile_id_fkey: {
    what: "an expense claim filed by another tenant's rep",
    sql: `INSERT INTO crm.expense_claim (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
          VALUES ($1, $2, 'travel', 10.00, 'USD', DATE '2026-01-10')`,
    params: [TENANT_FK_B, A.rep1],
  },
  expense_claim_approved_by_fkey: {
    what: "an expense claim approved by another tenant's rep",
    sql: `INSERT INTO crm.expense_claim (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on,
                                         erp_ledger_account_code, state, approved_at, approved_by)
          VALUES ($1, $2, 'travel', 10.00, 'USD', DATE '2026-01-10', '6000', 'approved', now(), $3)`,
    params: [TENANT_FK_B, B.rep1, A.rep1],
  },
  expense_claim_rejected_by_fkey: {
    what: "an expense claim rejected by another tenant's rep",
    sql: `INSERT INTO crm.expense_claim (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on,
                                         erp_ledger_account_code, state, rejected_at, rejected_by)
          VALUES ($1, $2, 'travel', 10.00, 'USD', DATE '2026-01-10', '6000', 'rejected', now(), $3)`,
    params: [TENANT_FK_B, B.rep1, A.rep1],
  },
  notification_recipient_rep_profile_id_fkey: {
    what: "a notification addressed to another tenant's rep",
    sql: `INSERT INTO crm.notification (tenant_id, recipient_rep_profile_id, kind, severity, subject, body, dedup_key)
          VALUES ($1, $2, 'erp_write_failed', 'warning', 'Probe', 'Probe', 'fk-probe')`,
    params: [TENANT_FK_B, A.rep1],
  },
  notification_delivery_notification_id_fkey: {
    what: "a delivery attempt for another tenant's notification",
    sql: `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, A.ntf, B.endp],
  },
  notification_delivery_endpoint_id_fkey: {
    what: "a delivery attempt aimed at another tenant's endpoint",
    sql: `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, B.ntf, A.endp],
  },
  outbox_revived_by_fkey: {
    what: "a dead letter revived by another tenant's rep",
    sql: `INSERT INTO crm.outbox (tenant_id, entity, operation, payload, target_record_id,
                                  source_table, source_id, revived_by)
          VALUES ($1, 'StockMovement', 'create', '{}'::jsonb, 'rec-fk-probe',
                  'crm.sample_transaction', gen_random_uuid(), $2)`,
    params: [TENANT_FK_B, A.rep1],
  },
  rep_role_rep_profile_id_fkey: {
    what: "a role granted to another tenant's rep",
    sql: `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from)
          VALUES ($1, $2, 'compliance', $3, CURRENT_DATE)`,
    params: [TENANT_FK_B, A.rep1, B.rep1],
  },
  rep_role_granted_by_fkey: {
    what: "a role granted BY another tenant's rep — the shipped bug's column",
    sql: `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from)
          VALUES ($1, $2, 'compliance', $3, CURRENT_DATE)`,
    params: [TENANT_FK_B, B.rep2, A.rep1],
  },
  rep_role_revoked_by_fkey: {
    what: "a role revoked BY another tenant's rep — the shipped bug's other column",
    sql: `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, revoked_by, revoked_at)
          VALUES ($1, $2, 'compliance', $3, CURRENT_DATE, $4, now())`,
    params: [TENANT_FK_B, B.rep2, B.rep1, A.rep1],
  },
};

/** Thrown when a probe's row was NOT refused, to force the probe transaction to roll back. */
class Accepted extends Error {
  constructor(constraint: string) {
    super(`the database ACCEPTED a cross-tenant row that ${constraint} must refuse`);
    this.name = "Accepted";
  }
}

interface PgError {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

describe("a cross-tenant reference is refused by the database", () => {
  let pool: Pool;
  let client: PoolClient;

  const seed = async (tenant: string, f: Fixture): Promise<void> => {
    await withTenantContext(client, tenant, async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1, $3, 'fk-rep1', 'FK-E1', 'FK Rep One'), ($2, $3, 'fk-rep2', 'FK-E2', 'FK Rep Two')`,
        [f.rep1, f.rep2, tenant],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1, $2, 'FK-T1', 'FK Terr One')`,
        [f.terr1, tenant],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name, parent_id)
         VALUES ($1, $2, 'FK-T2', 'FK Terr Two', $3)`,
        [f.terr2, tenant, f.terr1],
      );
      // The visit fixture needs the rep to actually cover the account, because
      // `visit_check_territory` asks — so the coverage graph is real rather than bypassed.
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1, $2, $3, 'primary', DATE '2020-01-01')`,
        [tenant, f.terr1, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
         VALUES ($1, 'acct-fk', $2, DATE '2020-01-01')`,
        [tenant, f.terr1],
      );
      await tx.query(
        `INSERT INTO crm.cycle (id, tenant_id, code, name, starts_on, ends_on)
         VALUES ($1, $2, 'FK-C1', 'FK Cycle', DATE '2026-01-01', DATE '2026-03-31')`,
        [f.cyc, tenant],
      );
      await tx.query(
        `INSERT INTO crm.call_plan (id, tenant_id, cycle_id, rep_profile_id) VALUES ($1, $2, $3, $4)`,
        [f.plan, tenant, f.cyc, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, planned_for)
         VALUES ($1, $2, $3, 'acct-fk', DATE '2026-02-02')`,
        [f.vis, tenant, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.sample_lot (id, tenant_id, erp_item_id, lot_number, material_kind)
         VALUES ($1, $2, 'item-fk', 'FK-LOT-1', 'promo_material')`,
        [f.lot, tenant],
      );
      // `adjustment_in` with a reason: the one kind the validate trigger admits without a
      // warehouse, an account or a counterparty. Its apply trigger seeds the balance row.
      await tx.query(
        `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at)
         VALUES ($1, $2, $3, $4, 'adjustment_in', 10, 'fk fixture opening balance', now())`,
        [f.tx, tenant, f.lot, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.sample_count (id, tenant_id, rep_profile_id, counted_by, counted_at)
         VALUES ($1, $2, $3, $3, now())`,
        [f.cnt, tenant, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.disposal_obligation (tenant_id, id, rep_profile_id, lot_id, quantity_at_discovery,
                                              expired_on, discovered_on, due_by)
         VALUES ($1, $2, $3, $4, 5, DATE '2026-01-05', DATE '2026-01-06', DATE '2026-02-05')`,
        [tenant, f.obl, f.rep1, f.lot],
      );
      await tx.query(
        `INSERT INTO crm.notification (id, tenant_id, recipient_rep_profile_id, kind, severity,
                                       subject, body, dedup_key)
         VALUES ($1, $2, $3, 'erp_write_failed', 'warning', 'FK fixture', 'FK fixture body', 'fk-fixture-1')`,
        [f.ntf, tenant, f.rep1],
      );
      await tx.query(
        `INSERT INTO crm.notification_endpoint (id, tenant_id, channel, url, secret_env)
         VALUES ($1, $2, 'webhook', 'https://fk.example.test/hook', 'FK_FIXTURE_SECRET')`,
        [f.endp, tenant],
      );
    });
  };

  /**
   * Deletes in reverse dependency order. `crm.sample_transaction` and `crm.rep_role` are
   * append-only by trigger and `crm.sample_holding` refuses direct writes, so the teardown
   * disables user triggers for the duration — a fixture has to be removable even when the
   * table it is in is not.
   */
  const unseed = async (tenant: string): Promise<void> => {
    await withTenantContext(client, tenant, async (tx) => {
      for (const t of ["sample_transaction", "sample_holding", "rep_role", "visit", "call_plan"]) {
        await tx.query(`ALTER TABLE crm.${t} DISABLE TRIGGER USER`);
      }
      for (const t of [
        "notification_delivery", "notification", "notification_endpoint",
        "disposal_obligation", "sample_count_line", "sample_count",
        "sample_holding", "sample_transaction", "sample_lot",
        "visit_product", "visit",
        "call_plan_product", "call_plan_target", "call_plan", "cycle",
        "expense_claim", "outbox", "rep_role",
        "account_assignment", "territory_assignment",
      ]) {
        await tx.query(`DELETE FROM crm.${t} WHERE tenant_id = $1`, [tenant]);
      }
      // Children first: `parent_id` is RESTRICT, so the root goes last.
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1 AND parent_id IS NOT NULL", [tenant]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [tenant]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      for (const t of ["sample_transaction", "sample_holding", "rep_role", "visit", "call_plan"]) {
        await tx.query(`ALTER TABLE crm.${t} ENABLE TRIGGER USER`);
      }
    });
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await unseed(TENANT_FK_A);
    await unseed(TENANT_FK_B);
    await seed(TENANT_FK_A, A);
    await seed(TENANT_FK_B, B);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await unseed(TENANT_FK_A);
      await unseed(TENANT_FK_B);
      client.release();
    }
    await pool?.end();
  });

  /**
   * Attempts the row and reports what the database said. Always rolls back: on refusal
   * because `withTenantContext` does, and on acceptance because the probe throws `Accepted`
   * rather than returning, so a hole in the schema cannot leave a row behind either.
   */
  const attempt = async (constraint: string, probe: Probe): Promise<PgError> => {
    const hardened = HARDENED[constraint];
    if (hardened === undefined) throw new Error(`${constraint} is not in HARDENED`);
    try {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(`ALTER TABLE crm.${hardened.table} DISABLE TRIGGER USER`);
        await tx.query(probe.sql, [...probe.params]);
        // A deferred constraint is checked at COMMIT, which is outside this callback — so
        // ask for it here instead, where the error belongs to the probe rather than to the
        // wrapper. Only `call_plan.superseded_by` needs it; harmless for the rest.
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        throw new Accepted(constraint);
      });
      throw new Error("withTenantContext returned from a callback that always throws");
    } catch (err) {
      if (err instanceof Accepted) return { code: "ACCEPTED", constraint: "(none)", message: err.message };
      const e = err as PgError;
      return { code: e.code ?? "", constraint: e.constraint ?? "", message: e.message ?? "" };
    }
  };

  for (const [constraint, probe] of Object.entries(PROBES)) {
    it(`${constraint} refuses ${probe.what}`, async () => {
      const outcome = await attempt(constraint, probe);
      // 23503 is foreign_key_violation. Asserting the CODE and the CONSTRAINT NAME together
      // is what makes this a test of the foreign key: a CHECK that happened to fire, or a
      // trigger, or a unique-violation from a badly chosen fixture value, all fail here.
      expect(
        { code: outcome.code, constraint: outcome.constraint },
        `expected a foreign-key violation on ${constraint}; got: ${outcome.message}`,
      ).toEqual({ code: "23503", constraint });
    });
  }

  /**
   * The shipped bug, end to end, with NOTHING disabled — no trigger turned off, RLS live,
   * connected as `crm_app`. This is the one that would have failed before migration 0035
   * and it is deliberately the plainest statement of the rule in the file.
   */
  it("reproduces the shipped bug: a tenant cannot name another tenant's rep as grantor", async () => {
    const grant = async (grantedBy: string): Promise<void> => {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(
          `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from)
           VALUES ($1, $2, 'administrator', $3, CURRENT_DATE)`,
          [TENANT_FK_B, B.rep2, grantedBy],
        );
        // Never keep it: `crm.rep_role` is append-only, so a committed probe row could not
        // be deleted afterwards.
        throw new Accepted("rep_role_granted_by_fkey");
      });
    };

    await expect(grant(A.rep1)).rejects.toMatchObject({
      code: "23503",
      constraint: "rep_role_granted_by_fkey",
    });
    // The same statement with a grantor in the CALLER'S tenant must still work, or this
    // would be passing because the insert is broken rather than because the tenant is wrong.
    await expect(grant(B.rep1)).rejects.toBeInstanceOf(Accepted);
  });
});

describe("no reference in crm escapes its tenant", () => {
  let pool: Pool;
  let client: PoolClient;

  /**
   * Every foreign key in `crm`, with the shape the catalog reports. Read from
   * `pg_constraint` rather than from the migration text: what matters is the constraint the
   * database is enforcing, which is what a write will actually meet.
   */
  interface LiveFk {
    readonly conname: string;
    readonly child: string;
    readonly child_cols: string;
    readonly parent: string;
    readonly parent_cols: string;
    readonly on_delete: string;
    readonly on_update: string;
    readonly deferrable: boolean;
    readonly deferred: boolean;
    readonly match_type: string;
    readonly parent_tenant_scoped: boolean;
  }

  let live: readonly LiveFk[] = [];

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    const { rows } = await client.query<LiveFk>(`
      SELECT con.conname,
             child.relname  AS child,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(con.conkey) WITH ORDINALITY k(att, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att) AS child_cols,
             parent.relname AS parent,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(con.confkey) WITH ORDINALITY k(att, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.att) AS parent_cols,
             con.confdeltype AS on_delete,
             con.confupdtype AS on_update,
             con.condeferrable AS deferrable,
             con.condeferred AS deferred,
             con.confmatchtype AS match_type,
             EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id'
                        AND NOT a.attisdropped) AS parent_tenant_scoped
        FROM pg_constraint con
        JOIN pg_class child  ON child.oid  = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace n  ON n.oid      = child.relnamespace
       WHERE con.contype = 'f' AND n.nspname = 'crm'
       ORDER BY con.conname`);
    live = rows;
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it("finds foreign keys at all", () => {
    // Without this the comparisons below could all pass on an empty result set.
    expect(live.length).toBeGreaterThanOrEqual(Object.keys(HARDENED).length);
  });

  /**
   * THE DRIFT GUARD. Any reference by single-column id into a tenant-scoped table is a
   * cross-tenant reference waiting to be written, so the set of them must be exactly the
   * named debt in `AWAITING_CONVERSION` — nothing may join it silently.
   */
  it("every reference into a tenant-scoped table is tenant-scoped, except the named debt", () => {
    const stillBlind = live
      .filter(
        (f) =>
          f.parent_tenant_scoped &&
          f.child_cols.split(",").length === 1 &&
          f.parent_cols === "id",
      )
      .map((f) => f.conname)
      .sort();

    const known = Object.keys(AWAITING_CONVERSION).sort();
    expect(
      stillBlind,
      "a foreign key referencing a tenant-scoped table by id ALONE: nothing but RLS stops " +
        "it naming another tenant's row, and referential checks bypass RLS. Make it " +
        "(tenant_id, <col>) REFERENCES <target> (tenant_id, id) in a migration — or, if it " +
        "genuinely cannot be converted yet, add it to AWAITING_CONVERSION with the reason " +
        "and the migration that owes it.",
    ).toEqual(known);
  });

  it("the references 0035 hardened are all still composite", () => {
    const composite = live
      .filter((f) => f.child_cols.split(",").length === 2)
      .map((f) => f.conname)
      .sort();
    expect(composite).toEqual(Object.keys(HARDENED).sort());
  });

  it("each hardened reference carries tenant_id first, on both sides", () => {
    const wrong = live
      .filter((f) => HARDENED[f.conname] !== undefined)
      .flatMap((f) => {
        const want = HARDENED[f.conname];
        if (want === undefined) return [];
        const expected = `${f.child}(tenant_id,${want.column}) -> ${want.parent}(tenant_id,id)`;
        const actual = `${f.child}(${f.child_cols}) -> ${f.parent}(${f.parent_cols})`;
        return expected === actual ? [] : [`${f.conname}: expected ${expected}, found ${actual}`];
      });
    // tenant_id FIRST is not cosmetic: the index behind (tenant_id, id) can serve a
    // tenant-scoped scan, where (id, tenant_id) would be a prefix of the primary key and
    // therefore pure overhead.
    expect(wrong).toEqual([]);
  });

  /**
   * ON DELETE is the business rule — RESTRICT where the child is the audit trail, CASCADE
   * where the child is part of the parent — and 0035 rewrote all 38 constraints, which is
   * exactly where one gets silently changed. Asserted per constraint so a future migration
   * that "tidies" a RESTRICT into a CASCADE has to argue with a test.
   */
  it("ON DELETE, ON UPDATE, deferrability and match type are what each reference declares", () => {
    const ON_DELETE: Readonly<Record<string, "RESTRICT" | "CASCADE">> = { r: "RESTRICT", c: "CASCADE" };
    const drift = live
      .filter((f) => HARDENED[f.conname] !== undefined)
      .flatMap((f) => {
        const want = HARDENED[f.conname];
        if (want === undefined) return [];
        const found = {
          onDelete: ON_DELETE[f.on_delete] ?? `confdeltype=${f.on_delete}`,
          // 'a' is NO ACTION. Nothing in this schema updates a primary key, and all 38 were
          // NO ACTION before 0035.
          onUpdate: f.on_update,
          deferred: f.deferrable && f.deferred,
          // 's' is MATCH SIMPLE, which is load-bearing: under it a reference whose column is
          // NULL is not checked, which is what keeps every nullable FK here optional. MATCH
          // FULL would refuse every row with a null reference, since tenant_id never is.
          match: f.match_type,
        };
        const expected = {
          onDelete: want.onDelete,
          onUpdate: "a",
          deferred: want.deferred === true,
          match: "s",
        };
        return JSON.stringify(found) === JSON.stringify(expected)
          ? []
          : [`${f.conname}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)}`];
      });
    expect(drift).toEqual([]);
  });

  it("every hardened reference has a probe that proves it refuses", () => {
    // A reference documented in HARDENED but never attempted would be a claim with no
    // evidence, which is the failure mode this whole file exists to avoid.
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(HARDENED).sort());
  });

  it("the tenant-scoped targets exist as referenceable unique constraints", async () => {
    // What makes a composite reference possible at all: Postgres only lets a foreign key
    // name columns covered by a unique index. These are redundant as uniqueness claims —
    // `id` is already a primary key — and exist solely to be referenced.
    const parents = [...new Set(Object.values(HARDENED).map((h) => h.parent))].sort();
    expect(parents.length).toBeGreaterThan(5);
    const { rows } = await client.query<{ relname: string }>(
        `SELECT child.relname
           FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = child.relnamespace
          WHERE n.nspname = 'crm' AND con.contype = 'u'
            AND (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY k(att, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att) = 'tenant_id,id'
          ORDER BY child.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(parents);
  });

  it("no foreign key reaches outside crm, in either direction", async () => {
    // ADR-0001 Q1: the CRM is 3-degraded and holds no foreign key into the ERP, because the
    // deployed ERP keeps every record in one JSONB table. An `erp_*_id` is a CHECKed TEXT
    // domain, not a reference, and 0035 deliberately left all of them alone.
    const { rows } = await client.query<{ pair: string }>(
        `SELECT n1.nspname || '.' || s.relname || ' -> ' || n2.nspname || '.' || t.relname AS pair
           FROM pg_constraint con
           JOIN pg_class s ON s.oid = con.conrelid
           JOIN pg_class t ON t.oid = con.confrelid
           JOIN pg_namespace n1 ON n1.oid = s.relnamespace
           JOIN pg_namespace n2 ON n2.oid = t.relnamespace
          WHERE con.contype = 'f' AND (n1.nspname = 'crm') <> (n2.nspname = 'crm')`,
    );
    expect(rows.map((r) => r.pair)).toEqual([]);
  });
});
