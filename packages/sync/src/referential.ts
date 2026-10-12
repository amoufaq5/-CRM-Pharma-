/**
 * The orphan check ADR-0001 Q1's answer promised (0066).
 *
 * Q1 chose "3-degraded" over migrating the ERP to typed columns, and the answer was not "no
 * foreign keys" — it was "no FKs; ACL-enforced integrity **plus a nightly orphan check**".
 * `crm.referential_check_run` has existed since migration 0005 to hold the results, with a
 * partial index on `orphan_count > 0` and a header naming the only two things an orphan can be.
 * Nothing wrote a row for sixty-one migrations. This writes them.
 *
 * WHAT IT CHECKS, AND WHY NOT THE OBVIOUS THING. The obvious design is to ask the ERP whether
 * each mirrored record still exists, and it is the wrong one: the snapshots are a mirror of
 * somebody else's master data, the ERP keeps no per-record tombstone, and `deleteStale` is what
 * reconciles drift. An orphan count that is always non-zero teaches nobody anything, which is
 * the objection that kept this unbuilt and is correct about that design.
 *
 * This runs the other way round — the CRM's own operational rows against the CRM's own mirror.
 * `crm.visit.erp_account_id` is NOT NULL and the ACL validated it against
 * `crm.account_snapshot` when the visit was recorded; `crm.sample_lot.erp_item_id` was validated
 * against `crm.product_snapshot`. So a CRM row its own snapshot cannot resolve is not a steady
 * state. It is an ERP deletion nobody told us about, or an ACL bug — 0005's two cases, both of
 * which want a human.
 *
 * FAIL CLOSED, which is what separates this from a liar. Every row would read as an orphan
 * against a mirror that has never synced, and most would against one a week behind. So a
 * reference whose mirror is `never_synced` or past its own `block_after_seconds` is recorded
 * `unverifiable`, counting nothing — "we could not look" must not read like "there is nothing
 * there", the same distinction `ChannelCoverageReport.unreadable` draws.
 *
 * THE POPULATION COMES FROM THE DATABASE, never from a list here. 0066's register is seeded
 * complete and `crm.unregistered_erp_references()` derives the gap from `pg_catalog`, so a
 * migration that adds an `crm.erp_record_id` column and forgets to declare it fails a test the
 * same day. A list in this file is the thing that would go stale — which is exactly how the
 * table came to be empty in the first place.
 */
import type { PoolClient } from "pg";
import { raiseNotification } from "@crm/notify";

import { evaluateStaleness, readFreshness } from "./snapshot-store.js";

/** How many offending ids a run keeps. A sample, not the set — see the column comment in 0066. */
export const ORPHAN_SAMPLE_LIMIT = 10;

/**
 * The mirror a reference is checked against, named as `crm.snapshot_freshness` names it.
 *
 * The register stores the TABLE (`account_snapshot`) because that is what the join needs and
 * what the catalog can validate; freshness is keyed by the projection's short name
 * (`account`). One mapping, here, rather than a second column in the register that could
 * disagree with `PROJECTIONS`.
 */
const FRESHNESS_NAME: Readonly<Record<string, string>> = {
  account_snapshot: "account",
  product_snapshot: "product",
  rep_snapshot: "rep",
  warehouse_snapshot: "warehouse",
};

export type ReferentialVerdict = "clean" | "orphans" | "unverifiable";

export interface CheckableReference {
  readonly source_table: string;
  readonly source_column: string;
  readonly erp_entity: string;
  readonly verifiable_against: string;
  readonly verify_column: string;
  readonly source_nullable: boolean;
}

export interface ReferenceCheck {
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly erpEntity: string;
  readonly snapshotTable: string;
  readonly verdict: ReferentialVerdict;
  readonly checkedCount: number;
  readonly orphanCount: number;
  readonly orphanSample: readonly string[];
  readonly snapshotLastSuccessAt: Date | null;
  readonly snapshotAgeSeconds: number | null;
  /** Why nothing was counted. Null unless the verdict is `unverifiable`. */
  readonly unverifiableBecause: string | null;
}

export interface ReferentialCheckResult {
  readonly references: readonly ReferenceCheck[];
  readonly checked: number;
  readonly clean: number;
  readonly withOrphans: number;
  readonly unverifiable: number;
  /** Total orphan rows across every reference that could be checked. */
  readonly orphans: number;
  /**
   * Notifications raised — one per (administrator, reference with orphans).
   *
   * Zero on a clean sweep, and zero on a second sweep that found the same thing: the dedup key
   * names the reference and nothing else, so an administrator is told once per reference and not
   * once per night. 0064's rule, which this had no excuse to re-learn.
   */
  readonly notified: number;
  /** One line for a scheduler's job detail, in the order an operator should read it. */
  readonly summary: string;
}

/**
 * Quotes an identifier the register supplied.
 *
 * The register's own CHECKs bound these to `^[a-z][a-z0-9_]{2,62}$` and 0066's trigger refuses a
 * name that is not a real column, so nothing unsafe can be in the table — and this quotes
 * anyway, because "the data cannot be bad" is the assumption every injection starts from, and a
 * future migration could relax a CHECK without anybody rereading this file.
 */
function ident(name: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(name)) {
    throw new Error(`refusing to build a query from ${JSON.stringify(name)}: not an identifier`);
  }
  return `"${name}"`;
}

export async function checkableReferences(tx: PoolClient): Promise<readonly CheckableReference[]> {
  const { rows } = await tx.query<CheckableReference>(
    `SELECT source_table, source_column, erp_entity, verifiable_against, verify_column,
            source_nullable
       FROM crm.checkable_erp_references()`,
  );
  return rows;
}

/**
 * Checks one reference and returns the finding. Writes nothing.
 *
 * Separate from the recording below so the decision and its persistence can be exercised apart,
 * and because a finding is worth having even when a caller does not want a row — the live gate
 * reads one directly.
 *
 * ONE QUERY PER REFERENCE, not one per row. A tenant with 200k visits costs a single anti-join;
 * the HTTP-per-record design is what made this look expensive enough not to build.
 */
export async function checkReference(
  tx: PoolClient,
  tenantId: string,
  reference: CheckableReference,
  now: Date,
): Promise<ReferenceCheck> {
  const snapshotTable = reference.verifiable_against;
  const freshnessName = FRESHNESS_NAME[snapshotTable];
  const base = {
    sourceTable: reference.source_table,
    sourceColumn: reference.source_column,
    erpEntity: reference.erp_entity,
    snapshotTable,
  };

  if (freshnessName === undefined) {
    // A register row naming a mirror this process does not know how to age. Unverifiable rather
    // than checked, because the whole fail-closed rule rests on the age and a check with no age
    // cannot tell an ERP deletion from a mirror that is behind.
    return {
      ...base,
      verdict: "unverifiable",
      checkedCount: 0,
      orphanCount: 0,
      orphanSample: [],
      snapshotLastSuccessAt: null,
      snapshotAgeSeconds: null,
      unverifiableBecause:
        `crm.${snapshotTable} has no entry in this build's freshness map, so the age of its ` +
        `answer is unknown — and without the age an orphan cannot be told from a stale mirror`,
    };
  }

  const freshness = await readFreshness(tx, tenantId, freshnessName);
  if (freshness === null) {
    return {
      ...base,
      verdict: "unverifiable",
      checkedCount: 0,
      orphanCount: 0,
      orphanSample: [],
      snapshotLastSuccessAt: null,
      snapshotAgeSeconds: null,
      unverifiableBecause:
        `the ${freshnessName} snapshot has no freshness row for this tenant, so it has never ` +
        `been refreshed here — every row would read as an orphan`,
    };
  }

  const staleness = evaluateStaleness(freshness, now);
  if (staleness.level === "never_synced" || staleness.level === "block") {
    // THE FAIL-CLOSED ARM. `block_after_seconds` is the tenant's own declaration of the point at
    // which a snapshot value must not drive a decision (0005), and this is a decision: counting
    // orphans against a mirror nobody would let a rep act on would be a statement about the
    // mirror wearing the clothes of a statement about the data.
    return {
      ...base,
      verdict: "unverifiable",
      checkedCount: 0,
      orphanCount: 0,
      orphanSample: [],
      snapshotLastSuccessAt: staleness.lastSuccessAt,
      snapshotAgeSeconds: staleness.ageSeconds,
      unverifiableBecause:
        staleness.level === "never_synced"
          ? `the ${freshnessName} snapshot has never synced successfully for this tenant`
          : `the ${freshnessName} snapshot last synced ${String(staleness.ageSeconds)}s ago, past its own ` +
            `block_after_seconds of ${String(freshness.block_after_seconds)} — too old to call anything an orphan`,
    };
  }

  const src = ident(reference.source_table);
  const col = ident(reference.source_column);
  const mirror = ident(snapshotTable);
  const key = ident(reference.verify_column);
  // The null predicate is written once and applied to both counts, so "checked" and "orphan"
  // cannot end up measuring different populations — which is what a nullable column invites. A
  // null is not an orphan: `sample_transaction.erp_account_id` is null on a rep-to-rep transfer
  // by design.
  const notNull = reference.source_nullable ? `AND s.${col} IS NOT NULL` : "";
  const { rows } = await tx.query<{
    checked: string;
    orphans: string;
    sample: readonly string[] | null;
  }>(
    `WITH considered AS (
       SELECT s.${col} AS value
         FROM crm.${src} s
        WHERE s.tenant_id = $1 ${notNull}
     ),
     missing AS (
       SELECT DISTINCT c.value
         FROM considered c
        WHERE NOT EXISTS (
          SELECT 1 FROM crm.${mirror} m
           WHERE m.tenant_id = $1 AND m.${key} = c.value)
     )
     SELECT (SELECT count(*)::text FROM considered) AS checked,
            -- The ROWS, not the distinct values: "forty visits point at a deleted account" is
            -- the number an operator acts on, where "one account is missing" understates it.
            (SELECT count(*)::text FROM considered c
              WHERE c.value IN (SELECT value FROM missing)) AS orphans,
            -- And the sample is DISTINCT values, because ten copies of one id is not a sample.
            --
            -- THE ::text CAST IS LOAD-BEARING. The column is of the crm.erp_record_id DOMAIN,
            -- and node-postgres has no parser registered for a domain's array type -- so
            -- without the cast this comes back as the literal string {acct-1,acct-2} and every
            -- .slice() on it is a runtime TypeError, which the types do not catch because the
            -- row shape is declared and not inferred. Found by running it, which is the only
            -- way: an offline fake asserts the SQL's shape and cannot see what the driver does
            -- with the result. (No backticks: this is inside a template literal.)
            (SELECT array_agg(value::text ORDER BY value::text)
               FROM (SELECT value FROM missing ORDER BY value LIMIT $2) t) AS sample`,
    [tenantId, ORPHAN_SAMPLE_LIMIT],
  );

  const row = rows[0]!;
  const orphanCount = Number(row.orphans);
  return {
    ...base,
    verdict: orphanCount > 0 ? "orphans" : "clean",
    checkedCount: Number(row.checked),
    orphanCount,
    orphanSample: row.sample ?? [],
    snapshotLastSuccessAt: staleness.lastSuccessAt,
    snapshotAgeSeconds: staleness.ageSeconds,
    unverifiableBecause: null,
  };
}

/** Writes one finding to `crm.referential_check_run` and returns its id. */
export async function recordReferenceCheck(
  tx: PoolClient,
  tenantId: string,
  check: ReferenceCheck,
  now: Date,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm.referential_check_run
       (tenant_id, ran_at, source_table, source_column, erp_entity, checked_count, orphan_count,
        orphan_sample, verdict, snapshot_table, snapshot_last_success_at, snapshot_age_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
     RETURNING id`,
    [
      tenantId,
      now,
      check.sourceTable,
      check.sourceColumn,
      check.erpEntity,
      check.checkedCount,
      check.orphanCount,
      // The sample carries the reason too when there is one, so a row that counted nothing says
      // why in the one column that can hold a sentence — `last_error` has no analogue here.
      JSON.stringify(
        check.unverifiableBecause === null
          ? check.orphanSample
          : { unverifiable_because: check.unverifiableBecause },
      ),
      check.verdict,
      check.snapshotTable,
      check.snapshotLastSuccessAt,
      check.snapshotAgeSeconds,
    ],
  );
  return rows[0]!.id;
}

/**
 * Walks every checkable reference for one tenant and records what it found.
 *
 * Must be called inside `withTenantContext`: every query here is tenant-scoped by row-level
 * security as well as by its own predicate, and a caller who forgot the wrapper would check
 * nothing and record a clean sweep — the fail-closed answer being also the most misleading one,
 * which is why the predicate is written out in the SQL as well.
 *
 * ONE TRANSACTION, deliberately. The rows of one sweep belong together: an operator reading
 * `verdict = 'orphans'` wants to know what the rest of the sweep said at the same moment, and a
 * partial sweep that committed half its findings would be indistinguishable from a complete one.
 * `seq` is what orders them within it, since `ran_at` is the transaction clock (0066).
 */
export async function runReferentialCheck(
  tx: PoolClient,
  tenantId: string,
  now: Date,
): Promise<ReferentialCheckResult> {
  const references = await checkableReferences(tx);
  const findings: ReferenceCheck[] = [];
  for (const reference of references) {
    findings.push(await checkReference(tx, tenantId, reference, now));
  }
  let notified = 0;
  for (const finding of findings) {
    const id = await recordReferenceCheck(tx, tenantId, finding, now);
    if (finding.verdict === "orphans") {
      notified += await notifyOrphans(tx, tenantId, finding, id);
    }
  }
  return { ...summariseReferentialCheck(findings), notified };
}

/**
 * Tells the administrators, once per reference.
 *
 * 0063'S LESSON, APPLIED WITHOUT BEING ASKED: a finding nobody is told about is a finding that
 * waits for somebody to run a query, and `crm.referential_check_run` spent sixty-one migrations
 * being that query. The audience is the administrators from `crm.role_holders`, read live — an
 * orphan is not any one rep's to fix and the remedy (ask the ERP what happened to that account,
 * or find the ACL bug) belongs to whoever administers the tenant.
 *
 * NO PERIOD IN THE DEDUP KEY. `referential-orphans:<table>.<column>`, and nothing else. A
 * nightly job whose key carried the date would be nagging by construction (0063's own words),
 * and the orphan is a STATE rather than an event — `notification_subject_open` reads it from the
 * newest run, so the notice closes itself when a later run comes back clean. The cost is stated
 * rather than hidden: a fault fixed and later recurring raises no second notice while the first
 * is still in the inbox, so the key lives exactly as long as the record of having told somebody.
 *
 * `warning`, not `urgent`. An orphan wants a human this week; 0064's `urgent` is for a deadline
 * that has already passed, and a channel routed on severity must keep that distinction worth
 * something.
 */
async function notifyOrphans(
  tx: PoolClient,
  tenantId: string,
  finding: ReferenceCheck,
  runId: string,
): Promise<number> {
  const { rows } = await tx.query<{ rep_profile_id: string }>(
    `SELECT rep_profile_id FROM crm.role_holders('administrator')`,
  );
  const where = `${finding.sourceTable}.${finding.sourceColumn}`;
  const age =
    finding.snapshotAgeSeconds === null
      ? "of unknown age"
      : `last refreshed ${String(Math.round(finding.snapshotAgeSeconds / 60))} minute(s) ago`;
  let raised = 0;
  for (const holder of rows) {
    const result = await raiseNotification(tx, tenantId, {
      recipientRepProfileId: holder.rep_profile_id,
      kind: "referential_orphans_found",
      severity: "warning",
      subject: `${String(finding.orphanCount)} row(s) in ${where} name a missing ${finding.erpEntity}`,
      body:
        `The nightly integrity check found ${String(finding.orphanCount)} of ${String(finding.checkedCount)} ` +
        `row(s) in crm.${finding.sourceTable} whose ${finding.sourceColumn} is not in ` +
        `crm.${finding.snapshotTable}, which was ${age}. That is one of two things, and both ` +
        `need somebody to look: the ERP deleted a ${finding.erpEntity} and nothing told us, or a ` +
        `write got past the validation that should have refused it. Examples: ` +
        `${finding.orphanSample.slice(0, 5).join(", ")}. ` +
        `This is the only notice for this reference — a later check that comes back clean closes it.`,
      dedupKey: `referential-orphans:${where}`,
      subjectTable: "crm.referential_check_run",
      subjectId: runId,
      payload: {
        sourceTable: finding.sourceTable,
        sourceColumn: finding.sourceColumn,
        erpEntity: finding.erpEntity,
        snapshotTable: finding.snapshotTable,
        orphanCount: finding.orphanCount,
        checkedCount: finding.checkedCount,
        sample: finding.orphanSample,
      },
    });
    if (result.created) raised += 1;
  }
  return raised;
}

/**
 * The counters and the line, as a pure function of the findings.
 *
 * Separate so the whole decision table can be exercised without a database, and so the sentence
 * is written once — `dispatch.ts` and `channel-coverage.ts` take the same shape for the same
 * reason.
 */
export function summariseReferentialCheck(
  findings: readonly ReferenceCheck[],
): ReferentialCheckResult {
  const withOrphans = findings.filter((f) => f.verdict === "orphans");
  const unverifiable = findings.filter((f) => f.verdict === "unverifiable");
  const orphans = withOrphans.reduce((n, f) => n + f.orphanCount, 0);

  const parts = [
    // ORPHANS FIRST and in capitals, like `ESCALATED=` and `LOST=` on the lines beside it: it is
    // the one value here that means somebody has to do something.
    ...(withOrphans.length > 0 ? [`ORPHANS=${String(orphans)}`] : []),
    ...(unverifiable.length > 0 ? [`UNVERIFIABLE=${String(unverifiable.length)}`] : []),
    `references=${String(findings.length)}`,
    `clean=${String(findings.length - withOrphans.length - unverifiable.length)}`,
  ];
  if (withOrphans.length > 0) {
    // Named, not just counted. "ORPHANS=40" sends an operator to a query; "visit.erp_account_id"
    // sends them to the table.
    parts.push(
      `in=${withOrphans.map((f) => `${f.sourceTable}.${f.sourceColumn}:${String(f.orphanCount)}`).join(",")}`,
    );
  }
  if (unverifiable.length > 0) {
    parts.push(`unchecked=${unverifiable.map((f) => `${f.sourceTable}.${f.sourceColumn}`).join(",")}`);
  }

  return {
    references: findings,
    checked: findings.length,
    clean: findings.length - withOrphans.length - unverifiable.length,
    withOrphans: withOrphans.length,
    unverifiable: unverifiable.length,
    orphans,
    // Zero from the pure summary, which knows nothing about who was told; `runReferentialCheck`
    // replaces it with what it actually raised. Present here rather than optional so a caller
    // reading a summarised result cannot find the field missing.
    notified: 0,
    summary: parts.join(" "),
  };
}

export interface ReferentialRunRow {
  readonly id: string;
  readonly seq: string;
  readonly ran_at: Date;
  readonly source_table: string;
  readonly source_column: string;
  readonly erp_entity: string;
  readonly checked_count: string;
  readonly orphan_count: string;
  readonly orphan_sample: unknown;
  readonly verdict: ReferentialVerdict;
  readonly snapshot_table: string | null;
  readonly snapshot_last_success_at: Date | null;
  readonly snapshot_age_seconds: string | null;
}

/**
 * The newest finding per reference — what an operator's screen shows.
 *
 * `DISTINCT ON (source_table, source_column) … ORDER BY seq DESC` rather than a time filter,
 * because the question is "where does this schema stand", not "what happened on Tuesday". A
 * reference whose last run was `unverifiable` reads as unverifiable rather than falling back to
 * the clean run before it: the most recent answer is the only one that is still a claim.
 */
export async function latestReferentialFindings(
  tx: PoolClient,
  tenantId: string,
): Promise<readonly ReferentialRunRow[]> {
  const { rows } = await tx.query<ReferentialRunRow>(
    `SELECT DISTINCT ON (source_table, source_column)
            id::text AS id, seq::text AS seq, ran_at, source_table, source_column, erp_entity,
            checked_count::text AS checked_count, orphan_count::text AS orphan_count,
            orphan_sample, verdict, snapshot_table, snapshot_last_success_at,
            snapshot_age_seconds::text AS snapshot_age_seconds
       FROM crm.referential_check_run
      WHERE tenant_id = $1
      ORDER BY source_table, source_column, seq DESC`,
    [tenantId],
  );
  return rows;
}

export interface UnverifiableReference {
  readonly source_table: string;
  readonly source_column: string;
  readonly erp_entity: string;
  readonly question: string;
}

/** The references no mirror can answer for, with the question each is waiting on (0066). */
export async function unverifiableReferences(
  tx: PoolClient,
): Promise<readonly UnverifiableReference[]> {
  const { rows } = await tx.query<UnverifiableReference>(
    `SELECT source_table, source_column, erp_entity, question
       FROM crm.unverifiable_erp_references()`,
  );
  return rows;
}
