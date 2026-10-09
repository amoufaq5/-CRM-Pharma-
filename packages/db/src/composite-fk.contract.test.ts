import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { appPool, TENANT_FK_A, TENANT_FK_B, withRegistryTriggersOff } from "./testing.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * Can a row in one tenant still name a record in another?
 *
 * WHY THIS EXISTS. ADR-0001 carried it as an open item — "nothing but RLS and the explicit
 * tenant match stops one naming a profile in another tenant" — and it had already happened:
 * `crm.revoke_rep_role` matched a grant on its id alone, so a rep of one tenant ended a
 * grant in another. The fix was `AND tenant_id = p_tenant_id` in one function, which is a
 * fix the next function forgets. Migrations 0035 and 0037 made the whole class impossible
 * instead: every reference inside `crm.*` is now `(tenant_id, <ref>_id) REFERENCES
 * <target>(tenant_id, id)` — all 46 of them, with nothing left behind. 0046 and 0048 then
 * dropped two of the 46, BOTH of `crm.notification_delivery`'s, on retention grounds: a
 * delivery record has to outlive the notification it describes and the endpoint it was
 * addressed to, or the evidence of a push to a third party disappears when somebody tidies
 * up either parent. 44 remained, and every reference added since arrives composite — 0056's
 * `sample_transaction.count_id` and 0059's `disposal_policy_change.changed_by` — because the
 * rule is unchanged: a reference that EXISTS is composite, and both dropped guards moved into `crm.notification_delivery_context`, which
 * is tighter than the keys were: a referential check runs with row security disabled and
 * would have found another tenant's parent, where resolving it under the caller's own policy
 * makes it read as absent.
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
 * cannot see, `visit_check_territory` refuses a rep who covers no account,
 * `notification_endpoint_probe_guard` refuses a foreign `endpoint_id` by reading the parent
 * under the caller's own RLS, `attachment_validate` refuses an uploader who neither owns nor
 * supervises the subject's rep, `attachment_blob_verify` compares the parent's `tenant_id`
 * itself — and a test that accepted any error as proof would pass just as happily with no
 * constraint there at all. Several of those guards are deliberately kept (0037 argues for the
 * probe one), which is exactly why the constraint underneath has to be probed on its own.
 * `ALTER TABLE … DISABLE TRIGGER USER` leaves the internal referential triggers running (it
 * touches only non-internal ones), so each probe is answered by the constraint it names and
 * by nothing else. It is done inside a transaction that always rolls back, so the schema is
 * the same afterwards; and `crm_app` owns these tables, which is why it is permitted at all.
 *
 * `reproduces the shipped bug` below is the one probe that runs with everything live, so the
 * end-to-end path is covered too rather than only the constraint in isolation.
 */

/**
 * The 44 references migrations 0035 (38) and 0037 (the last 8) made tenant-scoped and 0046
 * and 0048 left standing, plus the ones added composite since, and what each one must still
 * be.
 */
interface Hardened {
  /** The referencing table, unqualified. */
  readonly table: string;
  /** The referencing column, which pairs with `tenant_id`. */
  readonly column: string;
  /** The referenced table, unqualified. Always referenced by `(tenant_id, id)`. */
  readonly parent: string;
  /**
   * Preserved exactly from before the conversion — this is the business rule, and a
   * drop-and-recreate is where one gets silently rewritten. CASCADE means the child is part
   * of the parent; RESTRICT means the child is the audit trail and outlives nothing.
   */
  readonly onDelete: "RESTRICT" | "CASCADE";
  /**
   * DEFERRABLE INITIALLY DEFERRED. Two references, and the same mechanism in both:
   * `call_plan.superseded_by` and `attachment.superseded_by_attachment_id` are written on
   * the predecessor before the successor exists, because each table admits only one live row
   * per subject and so the old row has to be stood down first. Deferring to COMMIT is what
   * makes "superseded by a row that was never written" fail instead of commit. Note the
   * asymmetry on `crm.attachment`: the FORWARD link `supersedes_attachment_id` is NOT
   * deferrable, because the row it names already exists by then.
   */
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
  // 0056: the cycle count that produced an adjustment. RESTRICT like everything else out of
  // this ledger, and unreachable in practice — the append-only trigger refuses every DELETE
  // on a transaction, so nothing can orphan one from this side either.
  sample_transaction_count_id_fkey: { table: "sample_transaction", column: "count_id", parent: "sample_count", onDelete: "RESTRICT" },
  sample_holding_rep_profile_id_fkey: { table: "sample_holding", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_holding_lot_id_fkey: { table: "sample_holding", column: "lot_id", parent: "sample_lot", onDelete: "RESTRICT" },
  sample_count_rep_profile_id_fkey: { table: "sample_count", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  sample_count_counted_by_fkey: { table: "sample_count", column: "counted_by", parent: "rep_profile", onDelete: "RESTRICT" },
  // 0059. The record that a named employee changed a regulated SOP parameter; RESTRICT
  // because the log is the audit trail and outlives nothing.
  disposal_policy_change_changed_by_fkey: { table: "disposal_policy_change", column: "changed_by", parent: "rep_profile", onDelete: "RESTRICT" },
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
  // `notification_delivery_notification_id_fkey` WAS HERE and is gone as of 0046. The
  // cascade meant a delivery record could not be retained one day longer than the inbox
  // entry it described, so the reference was dropped and the facts copied — 0036's shape for
  // `crm.outbox_dead_letter`. Its tenant guard is not lost, it MOVED: see the live test
  // "notification_delivery refuses another tenant's notification" below, and the note on
  // `AWAITING_CONVERSION` about what this guard can and cannot see.

  outbox_revived_by_fkey: { table: "outbox", column: "revived_by", parent: "rep_profile", onDelete: "RESTRICT" },

  rep_role_rep_profile_id_fkey: { table: "rep_role", column: "rep_profile_id", parent: "rep_profile", onDelete: "RESTRICT" },
  rep_role_granted_by_fkey: { table: "rep_role", column: "granted_by", parent: "rep_profile", onDelete: "RESTRICT" },
  rep_role_revoked_by_fkey: { table: "rep_role", column: "revoked_by", parent: "rep_profile", onDelete: "RESTRICT" },

  // 0037: the eight that lived on tables 0033 and 0034 created, which both run BEFORE 0035
  // and so could not be reached by it. Every `ON DELETE` here is RESTRICT because
  // `crm.attachment` cannot be deleted at all (its append-only trigger refuses every
  // DELETE) and because an uploader, a reader and a probe requester are attribution on a
  // regulated record — except the one CASCADE, which is an endpoint's test history.
  attachment_uploaded_by_fkey: { table: "attachment", column: "uploaded_by", parent: "rep_profile", onDelete: "RESTRICT" },
  attachment_supersedes_attachment_id_fkey: { table: "attachment", column: "supersedes_attachment_id", parent: "attachment", onDelete: "RESTRICT" },
  attachment_superseded_by_attachment_id_fkey: { table: "attachment", column: "superseded_by_attachment_id", parent: "attachment", onDelete: "RESTRICT", deferred: true },
  attachment_blob_attachment_id_fkey: { table: "attachment_blob", column: "attachment_id", parent: "attachment", onDelete: "RESTRICT" },
  attachment_access_attachment_id_fkey: { table: "attachment_access", column: "attachment_id", parent: "attachment", onDelete: "RESTRICT" },
  attachment_access_read_by_fkey: { table: "attachment_access", column: "read_by", parent: "rep_profile", onDelete: "RESTRICT" },

  notification_endpoint_probe_endpoint_id_fkey: { table: "notification_endpoint_probe", column: "endpoint_id", parent: "notification_endpoint", onDelete: "CASCADE" },
  notification_endpoint_probe_requested_by_fkey: { table: "notification_endpoint_probe", column: "requested_by", parent: "rep_profile", onDelete: "RESTRICT" },

  // 0052: the CRM's own deletion receipt, and the only reference added since 0046 dropped two.
  // RESTRICT rather than CASCADE, and for this table that is the whole point: the attestations
  // are what the receipt's content hash commits to, so a cascade that removed them with their
  // receipt would leave a hash over nothing — and removing the receipt is refused outright by
  // its append-only trigger, which makes this RESTRICT unreachable in practice and correct
  // anyway. It is composite because 0035's rule has no exceptions: an attestation cannot name
  // another tenant's receipt.
  tenant_tombstone_attestation_tombstone_fkey: { table: "tenant_tombstone_attestation", column: "tombstone_id", parent: "tenant_tombstone", onDelete: "RESTRICT" },
};

/**
 * References into a tenant-scoped table that are STILL single-column, each with the reason.
 *
 * IT IS EMPTY, AND THAT IS THE POINT — but it is kept rather than deleted, because the
 * empty list is what the drift guard below compares against. There is no good reason for a
 * reference inside `crm.*` to be tenant-blind, so nothing would ever belong here "by
 * design": every entry is a DEBT, and the only debt there ever was has been paid.
 *
 * What was here, so a reader of the history knows what this slot is for. 0035 converted 38
 * references and left eight, on the four tables `0033_attachments.sql` and
 * `0034_endpoint_probe.sql` create — `crm.attachment`, `crm.attachment_blob`,
 * `crm.attachment_access`, `crm.notification_endpoint_probe`. Both files run BEFORE 0035,
 * so 0035 COULD have converted them and deliberately did not: both were still being written
 * while it was, and a migration that names another in-flight file's constraints breaks the
 * whole ordered chain if that file changes, where a stale entry here breaks one test with a
 * message saying what to do. `0037_composite_fks_part_two.sql` is the migration that reached
 * them, once 0033 and 0034 were applied and hash-gated. All eight are now in `HARDENED`
 * above with a probe each — and 0037's catalog survey found one attribute the list here had
 * never recorded, `attachment_superseded_by_attachment_id_fkey` being DEFERRABLE INITIALLY
 * DEFERRED, which is exactly the kind of thing a hand-written list loses and a `pg_constraint`
 * read does not.
 *
 * A reference that appears without being added here fails this suite, which is what makes
 * the next table somebody adds obey the rule without having to know the rule exists. If you
 * are here because that test failed: convert it in a migration. Adding it here is for a
 * reference that genuinely cannot be converted yet, and the entry has to say why and name
 * the migration that owes it.
 *
 * `crm.outbox_dead_letter` (0036) is the counter-example worth knowing about, and it was
 * never in this list: that table carries `revived_by` with no foreign key at all, by its own
 * argument. A column with no reference is outside what this guard can see — it checks the
 * references that exist, not the ones that should.
 *
 * `crm.notification_delivery.notification_id` (0046) and `.endpoint_id` (0048) are the second
 * and third such columns, and they are what make the blind spot worth stating twice. Both
 * were composite references and are now plain uuids, so they have LEFT this guard's view
 * rather than never having entered it — which is the shape a future reader should be
 * suspicious of. Neither guard was dropped, only moved: `crm.notification_delivery_context`
 * resolves both parents under the caller's own row security, which refuses what a referential
 * check would have accepted, because that check runs with row security disabled. Both
 * replacements are asserted live below, because a drift guard that cannot see the column
 * cannot be the thing that proves it. `crm.notification_delivery` now has NO foreign key at
 * all, which is deliberate and is the one table in `crm.*` that is true of.
 */
const AWAITING_CONVERSION: Readonly<Record<string, string>> = {};

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
  /** An expense claim, which is what an `expense_receipt` attachment hangs off (0033). */
  readonly claim: string;
  /** That claim's receipt — the parent the four `crm.attachment` references need. */
  readonly att: string;
  /** 0052's CRM deletion receipt, and the ERP receipt it has to cite to exist. */
  readonly tomb: string;
  readonly erpTomb: string;
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
  claim: `${p}0000000-0000-4000-8000-0000000000b1`,
  att: `${p}0000000-0000-4000-8000-0000000000c1`,
  // Not uuids: 0052 shapes these `crmtomb_` + 32 hex and `tomb_` + 12-40, deliberately unlike
  // each other and unlike the ERP's, so no reader can confuse the two receipts.
  // Written out rather than computed: 0052 wants exactly 32 hex after `crmtomb_`, and the
  // first version of this got it to 31 by slicing.
  tomb: `crmtomb_${p}${"0".repeat(31)}`,
  erpTomb: `tomb_${p}${"0".repeat(31)}`,
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
  disposal_policy_change_changed_by_fkey: {
    what: "a policy change attributed to another tenant's rep",
    // Every from/to column is supplied, unlike the route, which supplies only what the
    // policy should BECOME. 0059's trigger fills the rest — and this probe runs with the
    // table's user triggers off, as the whole file does, so the NOT NULLs would answer
    // first and the foreign key would never be reached.
    sql: `INSERT INTO crm.disposal_policy_change
            (tenant_id, changed_by, reason, grace_days_from, grace_days_to,
             auto_writeoff_promo_from, auto_writeoff_promo_to)
          VALUES ($1, $2, 'probing the composite key', 30, 7, false, false)`,
    params: [TENANT_FK_B, A.rep1],
  },
  sample_transaction_count_id_fkey: {
    what: "an adjustment claiming to come from another tenant's count",
    sql: `INSERT INTO crm.sample_transaction (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
                                              reason, occurred_at, count_id)
          VALUES (gen_random_uuid(), $1, $2, $3, 'adjustment_out', 1, 'probe', now(), $4)`,
    params: [TENANT_FK_B, B.lot, B.rep1, A.cnt],
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
  tenant_tombstone_attestation_tombstone_fkey: {
    what: "an attestation hung off another tenant's deletion receipt",
    sql: `INSERT INTO crm.tenant_tombstone_attestation
            (tenant_id, tombstone_id, table_name, outcome)
          VALUES ($1, $2, 'visit', 'nothing_to_erase')`,
    params: [TENANT_FK_B, A.tomb],
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
  /**
   * The four copied columns are supplied by hand HERE AND NOWHERE ELSE, because this probe
   * runs with `DISABLE TRIGGER USER` in force.
   *
   * `crm.notification_delivery_context` (0046) is a BEFORE INSERT trigger that fills them,
   * and they are NOT NULL — and `ExecConstraints` runs before the AFTER-row referential
   * trigger, so with the trigger silenced the probe would answer 23502 and this suite would
   * pass on a not-null violation while believing it had tested a foreign key. Supplying them
   * is what leaves the endpoint reference as the thing that refuses.
   */
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

  // --- 0037's eight. -------------------------------------------------------------------
  //
  // `crm.attachment` has no column default for `id` and several CHECKs that fire ahead of
  // any foreign key, so each probe below supplies a whole valid row and varies exactly one
  // reference. `subject_id` is `gen_random_uuid()` rather than a fixture id on purpose:
  // `uq_attachment_current` is UNIQUE (tenant_id, subject_table, subject_id, purpose) WHERE
  // status = 'current', and a unique index is checked during the heap insert — ahead of the
  // referential triggers — so reusing the fixture's subject would answer 23505 and the probe
  // would pass for the wrong constraint. With the user triggers disabled nothing resolves
  // `subject_id`, so an unused one is free.
  attachment_uploaded_by_fkey: {
    what: "an attachment uploaded by another tenant's rep",
    sql: `INSERT INTO crm.attachment (id, tenant_id, purpose, subject_table, subject_id,
                                      content_type, byte_size, content_sha256, uploaded_by)
          VALUES (gen_random_uuid(), $1, 'expense_receipt', 'crm.expense_claim',
                  gen_random_uuid(), 'image/png', 64, $3, $2)`,
    params: [TENANT_FK_B, A.rep1, SIG],
  },
  attachment_supersedes_attachment_id_fkey: {
    what: "an attachment superseding another tenant's attachment",
    sql: `INSERT INTO crm.attachment (id, tenant_id, purpose, subject_table, subject_id,
                                      content_type, byte_size, content_sha256, uploaded_by,
                                      supersedes_attachment_id)
          VALUES (gen_random_uuid(), $1, 'expense_receipt', 'crm.expense_claim',
                  gen_random_uuid(), 'image/png', 64, $3, $2, $4)`,
    params: [TENANT_FK_B, B.rep1, SIG, A.att],
  },
  attachment_superseded_by_attachment_id_fkey: {
    what: "an attachment superseded by another tenant's attachment",
    // The one deferred reference here: it is not checked until `SET CONSTRAINTS ALL
    // IMMEDIATE` in `attempt`. `status = 'superseded'` and a reason are both forced by
    // CHECKs (`attachment_superseded_pair`, `attachment_superseded_reason`), which is why
    // this row is not just the one above with a different column set.
    sql: `INSERT INTO crm.attachment (id, tenant_id, purpose, subject_table, subject_id,
                                      content_type, byte_size, content_sha256, uploaded_by,
                                      status, superseded_by_attachment_id, superseded_reason)
          VALUES (gen_random_uuid(), $1, 'expense_receipt', 'crm.expense_claim',
                  gen_random_uuid(), 'image/png', 64, $3, $2,
                  'superseded', $4, 'fk probe')`,
    params: [TENANT_FK_B, B.rep1, SIG, A.att],
  },
  attachment_blob_attachment_id_fkey: {
    what: "bytes stored against another tenant's attachment",
    // A real PNG magic number, and 8 octets satisfies `attachment_blob_size`. `decode`
    // rather than a bytea literal so no backslash has to survive a template literal.
    sql: `INSERT INTO crm.attachment_blob (tenant_id, attachment_id, content)
          VALUES ($1, $2, decode('89504e470d0a1a0a', 'hex'))`,
    params: [TENANT_FK_B, A.att],
  },
  attachment_access_attachment_id_fkey: {
    what: "a read recorded against another tenant's attachment",
    sql: `INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, A.att, B.rep1],
  },
  attachment_access_read_by_fkey: {
    what: "a read recorded for another tenant's rep",
    sql: `INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by) VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, B.att, A.rep1],
  },
  notification_endpoint_probe_endpoint_id_fkey: {
    what: "a probe aimed at another tenant's endpoint",
    // `notification_endpoint_probe_guard` would refuse this first with
    // `probe-foreign-endpoint:` — it reads the parent under the caller's RLS — and that arm
    // deliberately stays (0037). Disabling the user triggers is what makes this a test of
    // the constraint underneath it rather than of the guard on top.
    sql: `INSERT INTO crm.notification_endpoint_probe (tenant_id, endpoint_id, requested_by)
          VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, A.endp, B.rep1],
  },
  notification_endpoint_probe_requested_by_fkey: {
    what: "a probe requested by another tenant's rep",
    sql: `INSERT INTO crm.notification_endpoint_probe (tenant_id, endpoint_id, requested_by)
          VALUES ($1, $2, $3)`,
    params: [TENANT_FK_B, B.endp, A.rep1],
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
      // An `expense_receipt` is the attachment purpose with no cryptographic commitment to
      // satisfy, so a draft claim is all the subject it needs — a `disbursement_signature`
      // would have to hash to whatever the ledger row committed to (0033).
      await tx.query(
        `INSERT INTO crm.expense_claim (id, tenant_id, rep_profile_id, crm_category, amount,
                                        currency, incurred_on)
         VALUES ($1, $2, $3, 'travel', 12.00, 'USD', DATE '2026-01-09')`,
        [f.claim, tenant, f.rep1],
      );
      // Seeded with the triggers LIVE, like the visit fixture above: `attachment_validate`
      // asks `crm.rep_can_supervise(uploaded_by, <the claim's rep>)`, so the uploader has to
      // really be entitled to attach rather than be waved through. rep1 owns the claim, and
      // owning counts.
      await tx.query(
        `INSERT INTO crm.attachment (id, tenant_id, purpose, subject_table, subject_id,
                                     content_type, byte_size, content_sha256, uploaded_by)
         VALUES ($1, $2, 'expense_receipt', 'crm.expense_claim', $3, 'image/png', 64, $4, $5)`,
        [f.att, tenant, f.claim, SIG, f.rep1],
      );

      // 0052's receipt, which needs its tenant marked `erp_deleted` first (that trigger is
      // the pairing 0050 and 0052 build between a stop, an ERP tombstone and a CRM one). These
      // two tenants exist only for this suite, so stopping them costs nothing — and the
      // registry row is written here rather than assumed, because `crm.tenant` is empty in
      // every test database.
      await tx.query(
        `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, 'FK probe tenant')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant],
      );
      await tx.query(
        `UPDATE crm.tenant
            SET status = 'erp_deleted', erp_tombstone_id = $2, erp_tombstone_kind = 'tenant_deletion',
                erp_tombstone_deleted_at = now(), erp_tombstone_proof_sha256 = $3,
                erp_tombstone_observed_at = now()
          WHERE tenant_id = $1 AND status <> 'erp_deleted'`,
        [tenant, f.erpTomb, SIG],
      );
      await tx.query(
        `INSERT INTO crm.tenant_tombstone
           (id, tenant_id, erp_tombstone_id, content_manifest_sha256, proof_sha256,
            executed_by, approved_by, rows_erased, rows_retained)
         VALUES ($1,$2,$3,$4,$4,'ops:probe','compliance:probe',0,0)`,
        [f.tomb, tenant, f.erpTomb, SIG],
      );
    });
  };

  /**
   * Deletes in reverse dependency order. `crm.sample_transaction` and `crm.rep_role` are
   * append-only by trigger, `crm.sample_holding` refuses direct writes, and the three
   * attachment tables refuse every DELETE outright (0033 — an attachment IS the regulated
   * record, so it is superseded rather than removed), so the teardown disables user triggers
   * for the duration: a fixture has to be removable even when the table it is in is not.
   */
  const SILENCED = [
    "sample_transaction", "sample_holding", "rep_role", "visit", "call_plan",
    "attachment", "attachment_blob", "attachment_access",
    // 0052: append-only, for the same reason the attachments are — a receipt whose only job is
    // being there afterwards. A fixture still has to be removable.
    "tenant_tombstone", "tenant_tombstone_attestation",
  ];

  const unseed = async (tenant: string): Promise<void> => {
    await withTenantContext(client, tenant, async (tx) => {
      for (const t of SILENCED) {
        await tx.query(`ALTER TABLE crm.${t} DISABLE TRIGGER USER`);
      }
      for (const t of [
        // Attachments first: they are RESTRICT onto `crm.rep_profile` and onto each other,
        // and `crm.attachment` is the parent of the other two.
        "attachment_access", "attachment_blob", "attachment",
        "notification_endpoint_probe",
        "notification_delivery", "notification", "notification_endpoint",
        "disposal_obligation", "sample_count_line", "sample_count",
        "sample_holding", "sample_transaction", "sample_lot",
        "visit_product", "visit",
        "call_plan_product", "call_plan_target", "call_plan", "cycle",
        "expense_claim", "outbox", "rep_role",
        "account_assignment", "territory_assignment",
        "tenant_tombstone_attestation", "tenant_tombstone",
      ]) {
        await tx.query(`DELETE FROM crm.${t} WHERE tenant_id = $1`, [tenant]);
      }
      // Children first: `parent_id` is RESTRICT, so the root goes last.
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1 AND parent_id IS NOT NULL", [tenant]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [tenant]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      // 0053: this suite stops its tenants to seed a 0052 receipt, so the row is undeletable
      // until the guarantee is explicitly turned off.
      await withRegistryTriggersOff(tx, () =>
        tx.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [tenant]),
      );
      for (const t of SILENCED) {
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

  /**
   * `crm.attachment_access`, WITH NOTHING DISABLED — because the backlog said it had a hole.
   *
   * 0033 gave this table no insert-time guard, and 0037's own header calls that out: "It
   * carries NO insert-time guard at all, so these two are the clearest case in this file —
   * nothing but RLS was between an access record and another tenant's attachment, and
   * referential checks bypass RLS." The note left over from that reading was that the table
   * still needs a trigger in the shape of `attachment_blob_verify`, which refuses
   * `att.tenant_id <> NEW.tenant_id` in so many words.
   *
   * IT DOES NOT, and the two composite foreign keys 0037 installed are why. The probes in
   * `PROBES` above already say so, but they say it with `DISABLE TRIGGER USER` in force,
   * which is right for testing a constraint in isolation and is exactly the wrong evidence
   * for "does this table need a trigger": a reader cannot tell from them whether the refusal
   * survives the live table. These three run with every trigger enabled, as `crm_app`, under
   * FORCE ROW LEVEL SECURITY, which is the arrangement a request actually meets — so a
   * future migration that drops a composite key and adds a verify trigger instead, or drops
   * one and adds nothing, fails here rather than in production.
   *
   * WHY A FOREIGN KEY CAN DO THIS JOB AT ALL is the asymmetry 0035, 0037 and 0039 all turn
   * on, and it is worth restating where it is being relied upon: a referential check runs
   * with row security DISABLED, so it sees the parent that RLS hides and answers "same
   * tenant?" at the same moment as "does it exist?". The bulk `VALIDATE` scan of a NEWLY
   * ADDED key is an ordinary query and sees nothing under FORCE RLS with no tenant context,
   * which is why 0037 opens with a per-tenant pre-flight — but that is a statement about
   * adopting a key, not about enforcing one, and these inserts are enforcement.
   */
  it("attachment_access refuses another tenant's attachment with every trigger live", async () => {
    const record = async (attachment: string): Promise<void> => {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(
          "INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by) VALUES ($1, $2, $3)",
          [TENANT_FK_B, attachment, B.rep1],
        );
        // Never keep it: the table is append-only (0033), so a committed probe row could not
        // be removed afterwards without lifting the guard that makes it an audit trail.
        throw new Accepted("attachment_access_attachment_id_fkey");
      });
    };

    await expect(record(A.att)).rejects.toMatchObject({
      code: "23503",
      constraint: "attachment_access_attachment_id_fkey",
    });
    // The same statement against this tenant's own attachment must reach the Accepted
    // throw, or the refusal above would be about a broken insert rather than about tenancy.
    await expect(record(B.att)).rejects.toBeInstanceOf(Accepted);
  });

  it("attachment_access refuses another tenant's reader with every trigger live", async () => {
    const record = async (reader: string): Promise<void> => {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(
          "INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by) VALUES ($1, $2, $3)",
          [TENANT_FK_B, B.att, reader],
        );
        throw new Accepted("attachment_access_read_by_fkey");
      });
    };

    await expect(record(A.rep1)).rejects.toMatchObject({
      code: "23503",
      constraint: "attachment_access_read_by_fkey",
    });
    await expect(record(B.rep1)).rejects.toBeInstanceOf(Accepted);
  });

  /**
   * And with no tenant context at all, the policy refuses the row before a key is consulted.
   *
   * `crm.apply_tenant_isolation` creates its policy with a `USING` clause and no
   * `WITH CHECK`, so Postgres uses the same expression for writes — and `NULLIF(…, '')::uuid`
   * is NULL on a connection that never set the GUC and on a pooled one that reset it, so the
   * predicate is NULL and the INSERT is refused outright. That is the 42501 below. It is the
   * first thing a psql prompt meets, which is why the foreign keys above had to be probed
   * from INSIDE a tenant: without a context there is nothing for them to refuse.
   */
  it("attachment_access refuses any row at all with no tenant context, before a key is reached", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant_id', '', true)");
      await expect(
        client.query(
          "INSERT INTO crm.attachment_access (tenant_id, attachment_id, read_by) VALUES ($1, $2, $3)",
          [TENANT_FK_B, A.att, B.rep1],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  /**
   * The shape of the answer, pinned: the guard is the two keys and NOT a trigger.
   *
   * `attachment_blob_verify` is a BEFORE INSERT trigger that compares the parent's tenant
   * itself, and it is the shape the backlog note asked for here. This table has no
   * INSERT-time trigger and does not need one, so the absence is asserted rather than left
   * to be rediscovered: if someone adds one, this test says where the rule already lives,
   * and if someone drops a key believing a trigger covers it, the two tests above fail.
   */
  /**
   * `crm.notification_delivery`, WITH NOTHING DISABLED — because 0046 dropped a key here.
   *
   * The reference to `crm.notification` is gone (see the note in `HARDENED`), so this table
   * has a tenant-scoped column that this file's drift guard can no longer see. The guard did
   * not disappear with the key: `crm.notification_delivery_context` is a BEFORE INSERT
   * trigger that resolves the notification under the CALLER'S row security, which is the
   * tighter half of the asymmetry — a referential check runs with row security disabled and
   * would have found the foreign parent and accepted the row, where an invisible row reads as
   * absent here.
   *
   * Every trigger enabled, as `crm_app`, under FORCE ROW LEVEL SECURITY: the arrangement a
   * request actually meets. A future migration that removes the trigger believing the key
   * still covers it fails here.
   */
  it("notification_delivery refuses another tenant's notification, with every trigger live", async () => {
    const push = async (notification: string): Promise<void> => {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(
          `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
           VALUES ($1, $2, $3)`,
          [TENANT_FK_B, notification, B.endp],
        );
        throw new Accepted("notification_delivery_context");
      });
    };

    // 23514 is check_violation, which is what the trigger raises — deliberately NOT 23503:
    // there is no foreign key here any more and reporting one would be a lie about the
    // mechanism. The message is asserted too, so a CHECK that happened to fire first, or a
    // unique violation from a badly chosen fixture, fails rather than passes for it.
    await expect(push(A.ntf)).rejects.toMatchObject({ code: "23514" });
    await expect(push(A.ntf)).rejects.toThrow(/delivery-foreign-notification/);
    // The same statement against this tenant's own notification must reach the Accepted
    // throw, or the refusal above would be about a broken insert rather than about tenancy.
    await expect(push(B.ntf)).rejects.toBeInstanceOf(Accepted);
  });

  /**
   * And the SECOND parent, as of 0048 — the same rule, the same trigger, the other leg.
   *
   * `notification_delivery_endpoint_id_fkey` was the last foreign key on this table, and it
   * was `ON DELETE CASCADE`, so deleting an endpoint erased the record of everything ever
   * sent to it. Dropping it leaves `endpoint_id` in the same position `notification_id` has
   * been in since 0046: a tenant-scoped column this file's drift guard cannot see, whose
   * guard moved into the context trigger rather than disappearing.
   */
  it("notification_delivery refuses another tenant's endpoint, with every trigger live", async () => {
    const push = async (endpoint: string): Promise<void> => {
      await withTenantContext(client, TENANT_FK_B, async (tx) => {
        await tx.query(
          `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id)
           VALUES ($1, $2, $3)`,
          [TENANT_FK_B, B.ntf, endpoint],
        );
        throw new Accepted("notification_delivery_context");
      });
    };
    await expect(push(A.endp)).rejects.toMatchObject({ code: "23514" });
    await expect(push(A.endp)).rejects.toThrow(/delivery-foreign-endpoint/);
    await expect(push(B.endp)).rejects.toBeInstanceOf(Accepted);
  });

  /**
   * The absence itself, asserted — because this is now the one table in `crm.*` with no
   * foreign key at all, and that is a choice rather than an oversight.
   */
  it("notification_delivery declares no foreign key, and says so on purpose", async () => {
    const { rows } = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'crm.notification_delivery'::regclass AND contype = 'f'`,
    );
    expect(rows).toEqual([]);
  });

  it("has no insert-time trigger on attachment_access, because the two composite keys are the guard", async () => {
    const { rows } = await client.query<{ tgname: string; on_insert: boolean }>(
      `SELECT tgname, (tgtype & 4) <> 0 AS on_insert
         FROM pg_trigger
        WHERE tgrelid = 'crm.attachment_access'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual(["attachment_access_append_only"]);
    expect(rows.every((r) => !r.on_insert)).toBe(true);
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

  /**
   * The one reference the drift guard above is RIGHT not to see, said out loud.
   *
   * 0053 added `crm.tenant_tombstone.tenant_id -> crm.tenant (tenant_id)` — the first
   * reference into the registry in this schema's history, and a single-column one. The guard
   * does not flag it because it filters on `parent_cols = 'id'`, and that filter is exactly
   * right rather than accidentally lucky: the hazard it polices is a reference naming a ROW in
   * another tenant, and here the referenced value IS the tenant. There is no second column to
   * carry and nothing to escape.
   *
   * Asserted so the pass is a rule and not an emergent accident. A future single-column
   * reference into the registry has to appear here with its own argument; one into anything
   * else still fails the guard.
   */
  it("references the tenant registry by tenant_id, which is the one safe single-column shape", () => {
    const byTenantId = live
      .filter((f) => f.parent_cols === "tenant_id")
      .map((f) => `${f.conname} -> ${f.parent}`)
      .sort();
    expect(byTenantId).toEqual(["tenant_tombstone_tenant_id_fkey -> tenant"]);

    // And it is RESTRICT, because CASCADE would make the delete succeed and take the receipts
    // with it — the bypass 0053 closed, with extra steps. `confdeltype` is a single char here,
    // which is how this row of the catalog reads.
    const key = live.find((f) => f.conname === "tenant_tombstone_tenant_id_fkey");
    expect(key?.on_delete).toBe("r");
  });

  it("every hardened reference is still composite", () => {
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
   * where the child is part of the parent — and 0035 and 0037 between them rewrote all 46
   * constraints, which is exactly where one gets silently changed. Asserted per constraint so
   * a future migration that "tidies" a RESTRICT into a CASCADE has to argue with a test, and
   * so that deferrability is pinned too: 0037's catalog survey found
   * `attachment_superseded_by_attachment_id_fkey` deferrable where the debt list had never
   * recorded it, and recreating it immediate would have broken superseding at the first
   * attempt rather than at migration time.
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
          // 'a' is NO ACTION. Nothing in this schema updates a primary key, and all 46 were
          // NO ACTION before being converted.
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
    //
    // `crm.notification` is named separately because nothing references it any more: 0046
    // dropped the one reference there was, deliberately, and the key is KEPT rather than
    // dropped with it. It is one index on a growing table and it is what any future
    // composite reference into the inbox would need — dropping and re-adding it would be a
    // second migration over a large table to get back where this one already is.
    const UNREFERENCED_TARGETS = ["notification"];
    const parents = [
      ...new Set([...Object.values(HARDENED).map((h) => h.parent), ...UNREFERENCED_TARGETS]),
    ].sort();
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
