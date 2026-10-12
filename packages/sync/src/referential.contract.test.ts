import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import {
  TENANT_REFERENTIAL as TENANT,
  TENANT_REFERENTIAL_OTHER as OTHER,
  testPool,
} from "@crm/db/testing";
import { inbox } from "@crm/notify";

import {
  ORPHAN_SAMPLE_LIMIT,
  checkReference,
  checkableReferences,
  latestReferentialFindings,
  runReferentialCheck,
  summariseReferentialCheck,
  unverifiableReferences,
  type CheckableReference,
  type ReferenceCheck,
} from "./referential.js";

/**
 * Migration 0066 — the orphan check ADR-0001 Q1's answer promised.
 *
 * Q1 chose "3-degraded" and the answer was "no FKs; ACL-enforced integrity **plus a nightly
 * orphan check**". `crm.referential_check_run` has held the results since migration 0005, with a
 * partial index on `orphan_count > 0` and a header naming the only two things an orphan can be.
 * Nothing wrote a row for sixty-one migrations.
 *
 * WHAT THIS SUITE IS REALLY ABOUT is the two ways such a check lies, and both of them need a
 * database to catch:
 *
 *   * IT COUNTS AGAINST A MIRROR IT CANNOT TRUST. Every row reads as an orphan against a
 *     snapshot that has never synced, and most do against one a week behind, so a check that
 *     counted anyway would report a fault in the data that is really a fault in the mirror. The
 *     verdict is `unverifiable` and the count is zero, and the CHECK constraint in 0066 enforces
 *     that pairing — which a fake connection would report as written.
 *   * IT CHECKS THE WRONG POPULATION. A nullable reference is null by design on most rows
 *     (`sample_transaction.erp_account_id` is null on a rep-to-rep transfer), and an anti-join
 *     that forgot the null predicate would call every one of them an orphan. The suite seeds
 *     exactly that row.
 *
 * And the register's completeness, which is the property the whole thing rests on: a column of
 * the `crm.erp_record_id` domain that nobody declared is a reference the check does not know
 * about, which is how a check comes to pass while missing what it was built for.
 */
describe("the orphan check Q1 promised (0066)", () => {
  let pool: Pool;
  let client: PoolClient;

  let rep = "";
  let admin = "";
  let otherRep = "";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOther = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER, fn);

  const NOW = new Date("2026-10-12T09:00:00.000Z");
  /** Well inside every snapshot's default `warn_after_seconds` of an hour. */
  const JUST_SYNCED = new Date(NOW.getTime() - 60_000);

  const seedRep = async (tenant: string, subject: string, name: string): Promise<string> => {
    const { rows } = await withTenantContext(client, tenant, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [tenant, subject, name],
      ),
    );
    return rows[0]!.id;
  };

  /** A freshness row, so the fail-closed arm can be turned off deliberately rather than by luck. */
  const freshen = (tenant: string, snapshot: string, at: Date | null): Promise<unknown> =>
    withTenantContext(client, tenant, (tx) =>
      tx.query(
        `INSERT INTO crm.snapshot_freshness (tenant_id, snapshot, last_refresh_at, last_success_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (tenant_id, snapshot) DO UPDATE
           SET last_refresh_at = EXCLUDED.last_refresh_at,
               last_success_at = EXCLUDED.last_success_at`,
        [tenant, snapshot, at],
      ),
    );

  const account = (tenant: string, id: string): Promise<unknown> =>
    withTenantContext(client, tenant, (tx) =>
      tx.query(
        `INSERT INTO crm.account_snapshot (tenant_id, erp_account_id, name, erp_updated_at)
         VALUES ($1, $2, 'A Mirrored Account', now())
         ON CONFLICT (tenant_id, erp_account_id) DO NOTHING`,
        [tenant, id],
      ),
    );

  /**
   * A visit, recorded the way the application records one: through 0013's territory guard.
   *
   * The guard matters to this suite rather than being in its way. An orphan is by definition a
   * row that the live guards would now refuse, so a fixture has to reach that state DELIBERATELY
   * and say which of 0005's two cases it is reproducing — and this is the honest one. The visit
   * is legal when written, and the account leaves the mirror afterwards, which is exactly what an
   * ERP deletion nobody told us about looks like from in here. `visitPastTheGuard` below is the
   * other case.
   */
  const visit = async (tenant: string, who: string, accountId: string): Promise<void> => {
    await account(tenant, accountId);
    await cover(tenant, who, accountId);
    await withTenantContext(client, tenant, (tx) =>
      tx.query(
        // `id` is supplied, because a visit's id is minted on the DEVICE as a uuid v7 — the
        // column has no default by design (0015), so a fixture has to say so rather than
        // discovering it as a not-null violation.
        `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'completed', now())`,
        [tenant, who, accountId],
      ),
    );
  };

  /** The rep's coverage of one account: a territory, the rep in it, and the account assigned. */
  const cover = (tenant: string, who: string, accountId: string): Promise<unknown> =>
    withTenantContext(client, tenant, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO crm.territory (tenant_id, code, name)
         VALUES ($1, 'REF-T', 'The orphan-check suite''s territory')
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenant],
      );
      const territory = rows[0]!.id;
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         SELECT $1, $2, $3, 'primary', CURRENT_DATE - 1
          WHERE NOT EXISTS (SELECT 1 FROM crm.territory_assignment a
                             WHERE a.tenant_id = $1 AND a.territory_id = $2
                               AND a.rep_profile_id = $3 AND a.valid_to IS NULL)`,
        [tenant, territory, who],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
         SELECT $1, $2::crm.erp_record_id, $3, CURRENT_DATE - 1
          WHERE NOT EXISTS (SELECT 1 FROM crm.account_assignment a
                             WHERE a.tenant_id = $1 AND a.erp_account_id = $2::crm.erp_record_id
                               AND a.valid_to IS NULL)`,
        [tenant, accountId, territory],
      );
    });

  /** The account leaves the mirror: an ERP deletion nobody told us about. */
  const erpDeleted = (tenant: string, accountId: string): Promise<unknown> =>
    withTenantContext(client, tenant, (tx) =>
      tx.query(
        "DELETE FROM crm.account_snapshot WHERE tenant_id = $1 AND erp_account_id = $2",
        [tenant, accountId],
      ),
    );

  const reference = async (table: string, column: string): Promise<CheckableReference> => {
    const all = await inTenant((tx) => checkableReferences(tx));
    const found = all.find((r) => r.source_table === table && r.source_column === column);
    if (found === undefined) throw new Error(`${table}.${column} is not a checkable reference`);
    return found;
  };

  /**
   * The reference is resolved BEFORE the context opens, deliberately.
   *
   * `reference()` reads the register through `inTenant`, and `withTenantContext` refuses to
   * nest — it issues its own BEGIN/COMMIT, and Postgres treats a nested BEGIN as a no-op, so the
   * inner COMMIT would end the outer transaction. The wrapper says so in its own refusal, which
   * is how this was caught rather than producing a half-committed fixture.
   */
  const checkVisits = async (): Promise<ReferenceCheck> => {
    const ref = await reference("visit", "erp_account_id");
    return inTenant((tx) => checkReference(tx, TENANT, ref, NOW));
  };

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    rep = await seedRep(TENANT, "ref-rep", "A Rep");
    admin = await seedRep(TENANT, "ref-admin", "An Administrator");
    otherRep = await seedRep(OTHER, "ref-other", "Another Tenant's Rep");
    // The grant the notification's audience comes from. Granted by the rep, because 0023 lets
    // nobody grant themselves one.
    await withTenantContext(client, TENANT, (tx) =>
      tx.query(
        `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
         SELECT $1, $2, 'administrator', $3, CURRENT_DATE - 1, 'the orphan-check suite needs an audience'
          WHERE NOT EXISTS (SELECT 1 FROM crm.rep_role r
                             WHERE r.tenant_id = $1 AND r.rep_profile_id = $2
                               AND r.role = 'administrator' AND r.valid_to IS NULL)`,
        [TENANT, admin, rep],
      ),
    );
  });

  afterAll(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("ALTER TABLE crm.visit DISABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.visit ENABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.referential_check_run WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.account_snapshot WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.snapshot_freshness WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.rep_role WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  });

  /**
   * Back to no visits, no mirror, no freshness and no findings.
   *
   * Both sides of every assertion here are counts over a whole tenant, so an accumulated visit
   * from the previous test would move the numerator and the denominator at once — the coupling
   * two suites in this repo have been found to have.
   */
  beforeEach(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("ALTER TABLE crm.visit DISABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [tenant]);
        await tx.query("ALTER TABLE crm.visit ENABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.referential_check_run WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.account_snapshot WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.snapshot_freshness WHERE tenant_id = $1", [tenant]);
        // Territory and coverage too, because `account_assignment.erp_account_id` is itself one
        // of the references under test: an assignment left behind by the previous test would be
        // a second finding in every sweep after it.
        await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [tenant]);
      });
    }
  });

  describe("the register, which is what makes the check complete", () => {
    /**
     * 0051's guard for a different population, and the one assertion that makes every other
     * one here worth having.
     *
     * A column of the `crm.erp_record_id` domain absent from the register is a reference the
     * check does not know about. Derived from `pg_catalog`, so a migration that adds one and
     * forgets to declare it fails here the same day instead of being discovered by whatever the
     * orphan would have broken.
     */
    it("declares every crm.erp_record_id column in the schema", async () => {
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ source_table: string; source_column: string }>(
          "SELECT source_table, source_column FROM crm.unregistered_erp_references()",
        );
        expect(
          rows.map((r) => `${r.source_table}.${r.source_column}`),
          "every column of the crm.erp_record_id domain needs a row in crm.erp_reference_register",
        ).toEqual([]);
      });
    });

    it("has no row naming a column that no longer exists", async () => {
      await inTenant(async (tx) => {
        const { rows } = await tx.query("SELECT * FROM crm.erp_reference_orphans()");
        expect(rows).toEqual([]);
      });
    });

    it("names what each unmirrored reference is waiting on", async () => {
      const unmirrored = await inTenant((tx) => unverifiableReferences(tx));
      // Seven at 0066, and the point is not the number: a reference with no mirror is DECLARED
      // with a question rather than omitted, so "we cannot check this one" is in the register
      // instead of being the silence that looks like completeness.
      expect(unmirrored.length).toBeGreaterThan(0);
      for (const row of unmirrored) {
        expect(row.question.length, `${row.source_table}.${row.source_column}`).toBeGreaterThan(10);
      }
      // The contact references are the ones that matter most, and all three say so.
      expect(unmirrored.map((r) => `${r.source_table}.${r.source_column}`)).toContain(
        "visit.erp_contact_id",
      );
    });

    it("refuses a register row that names nothing, or a mirror that cannot answer", async () => {
      await inTenant(async (tx) => {
        const attempt = async (sql: string, params: readonly unknown[]): Promise<string> => {
          await tx.query("SAVEPOINT r");
          try {
            await tx.query(sql, [...params]);
            return "ACCEPTED";
          } catch (err) {
            return (err as { message?: string }).message ?? "";
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT r");
          }
        };
        const row = (table: string, column: string, mirror: string | null, key: string | null): readonly unknown[] => [
          table,
          column,
          "Account",
          mirror,
          key,
          mirror === null ? "a question about a reference nothing can answer for" : null,
          "a row the suite is attempting",
        ];
        const INSERT = `INSERT INTO crm.erp_reference_register
          (source_table, source_column, kind, erp_entity, verifiable_against, verify_column,
           question, note, declared_by)
          VALUES ($1, $2, 'reference', $3, $4, $5, $6, $7, 'the suite')`;

        expect(await attempt(INSERT, row("vist", "erp_account_id", "account_snapshot", "erp_account_id")))
          .toContain("erp-reference-unknown-table");
        expect(await attempt(INSERT, row("visit", "erp_acount_id", "account_snapshot", "erp_account_id")))
          .toContain("erp-reference-unknown-column");
        // THE ONE THAT WOULD HAVE BITTEN AT 3AM: a typo in the mirror's key column makes the
        // runner's join fail rather than report, so it is refused by the migration that wrote it.
        expect(await attempt(INSERT, row("visit", "erp_account_id", "account_snapshot", "erp_acount_id")))
          .toContain("erp-reference-unknown-mirror-column");
        expect(await attempt(INSERT, row("visit", "erp_account_id", "notification_kinds", "erp_account_id")))
          .toContain("erp-reference-unknown-mirror");
        // A mirror with no tenant_id would make the check's per-tenant join cross tenants.
        expect(await attempt(INSERT, row("visit", "erp_account_id", "four_eyes_rule", "table_name")))
          .toContain("erp-reference-mirror-not-tenant-scoped");
      });
    });

    it("refuses a reference with both a mirror and a question, and one with neither", async () => {
      await inTenant(async (tx) => {
        const attempt = async (mirror: string | null, question: string | null): Promise<string> => {
          await tx.query("SAVEPOINT x");
          try {
            await tx.query(
              `INSERT INTO crm.erp_reference_register
                 (source_table, source_column, kind, erp_entity, verifiable_against, verify_column,
                  question, note, declared_by)
               VALUES ('account_assignment', 'erp_account_id', 'reference', 'Account', $1::text,
                       CASE WHEN $1::text IS NULL THEN NULL ELSE 'erp_account_id' END, $2::text,
                       'a row the suite is attempting', 'the suite')`,
              [mirror, question],
            );
            return "ACCEPTED";
          } catch (err) {
            return (err as { constraint?: string }).constraint ?? "";
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT x");
          }
        };
        // XOR, deliberately: neither is the silence this register exists to make impossible,
        // and both is a row that says it can be checked and also that it cannot.
        expect(await attempt("account_snapshot", "a question it does not need")).toBe(
          "erp_reference_has_a_mirror_or_a_question",
        );
        expect(await attempt(null, null)).toBe("erp_reference_has_a_mirror_or_a_question");
      });
    });
  });

  describe("what a check counts", () => {
    it("reports clean when every row resolves", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await account(TENANT, "acct-1");
      await visit(TENANT, rep, "acct-1");

      const finding = await checkVisits();
      expect(finding).toMatchObject({
        verdict: "clean",
        checkedCount: 1,
        orphanCount: 0,
        snapshotTable: "account_snapshot",
      });
      expect(finding.snapshotAgeSeconds).toBe(60);
      expect(finding.unverifiableBecause).toBeNull();
    });

    it("counts the ROWS that point at a missing record, not the distinct records", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await account(TENANT, "acct-live");
      await visit(TENANT, rep, "acct-live");
      // Three visits to one account that the mirror does not hold. The ACL would have refused
      // these; this is the state the check exists to find, and getting there needs the mirror
      // row removed afterwards — which is exactly what an ERP deletion looks like from here.
      for (let i = 0; i < 3; i += 1) await visit(TENANT, rep, "acct-deleted");
      await erpDeleted(TENANT, "acct-deleted");

      const finding = await checkVisits();
      expect(finding.verdict).toBe("orphans");
      expect(finding.checkedCount).toBe(4);
      // THREE, not one. "Three visits point at a deleted account" is the number an operator
      // acts on; "one account is missing" understates what has to be reconciled.
      expect(finding.orphanCount).toBe(3);
      // And the SAMPLE is distinct values, because ten copies of one id is not a sample.
      expect(finding.orphanSample).toEqual(["acct-deleted"]);
    });

    it("does not call a null an orphan", async () => {
      // `sample_transaction.erp_account_id` is nullable because a rep-to-rep transfer names no
      // account. An anti-join that forgot the null predicate would report every transfer in the
      // deployment as an orphan — and would be reported as clean by any fake connection, since
      // the SQL is well-formed either way.
      const ref = await reference("sample_transaction", "erp_account_id");
      const visitRef = await reference("visit", "erp_account_id");
      expect(ref.source_nullable).toBe(true);
      await freshen(TENANT, "account", JUST_SYNCED);
      const finding = await inTenant((tx) => checkReference(tx, TENANT, ref, NOW));
      // Nothing seeded, so the interesting half is that `checked` counts only the non-null rows.
      expect(finding).toMatchObject({ verdict: "clean", checkedCount: 0, orphanCount: 0 });

      // And the NOT NULL side of the same question, read from the catalog rather than declared
      // twice: the register does not carry nullability, so the two cannot disagree.
      expect(visitRef.source_nullable).toBe(false);
    });

    it("caps the sample rather than storing every id", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      for (let i = 0; i < ORPHAN_SAMPLE_LIMIT + 5; i += 1) {
        await visit(TENANT, rep, `acct-gone-${String(i)}`);
        await erpDeleted(TENANT, `acct-gone-${String(i)}`);
      }
      const finding = await checkVisits();
      expect(finding.orphanCount).toBe(ORPHAN_SAMPLE_LIMIT + 5);
      // An orphan count in the thousands is one fault; storing thousands of ids per run would
      // make this table the biggest thing in the database.
      expect(finding.orphanSample).toHaveLength(ORPHAN_SAMPLE_LIMIT);
    });

    it("does not resolve one tenant's row against another tenant's mirror", async () => {
      // THE PROPERTY THE WHOLE CHECK RESTS ON. Both tenants are RLS-forced and the runner adds
      // its own tenant predicate besides, which is 0043's rule: a reader of the query must be
      // able to see the tenant match rather than infer it from a policy two files away.
      await freshen(TENANT, "account", JUST_SYNCED);
      await freshen(OTHER, "account", JUST_SYNCED);
      await visit(OTHER, otherRep, "acct-theirs");
      // The same account id, in THIS tenant, and THIS tenant's mirror no longer holds it. If the
      // anti-join crossed tenants it would resolve against the other tenant's row and report
      // clean, which is the one way this check can be wrong and still look right.
      await visit(TENANT, rep, "acct-theirs");
      await erpDeleted(TENANT, "acct-theirs");

      const mine = await checkVisits();
      expect(mine.verdict).toBe("orphans");
      expect(mine.orphanCount).toBe(1);
      // And the other tenant sees its own as clean, so this is a tenant boundary rather than a
      // broken join.
      const visitRef = await reference("visit", "erp_account_id");
      const theirs = await inOther((tx) => checkReference(tx, OTHER, visitRef, NOW));
      expect(theirs).toMatchObject({ verdict: "clean", orphanCount: 0, checkedCount: 1 });
    });
  });

  describe("the fail-closed rule", () => {
    it("refuses to count against a mirror that has never synced", async () => {
      await visit(TENANT, rep, "acct-1");
      // No freshness row at all, which is what a tenant whose scheduler has never run looks
      // like. Every row would resolve here, so this is NOT a test that the count would be
      // wrong — it is a test that the check does not make a claim it has no basis for.
      const finding = await checkVisits();
      expect(finding.verdict).toBe("unverifiable");
      expect(finding.checkedCount).toBe(0);
      expect(finding.orphanCount).toBe(0);
      expect(finding.unverifiableBecause).toContain("never been refreshed");
    });

    it("refuses when the mirror synced and then failed, and says never rather than old", async () => {
      await freshen(TENANT, "account", null);
      await visit(TENANT, rep, "acct-1");
      const finding = await checkVisits();
      expect(finding.verdict).toBe("unverifiable");
      // "never" and "a very long time" are different sentences, which is why
      // `evaluateStaleness` has a `never_synced` level at all and why the age is null here.
      expect(finding.unverifiableBecause).toContain("never synced successfully");
      expect(finding.snapshotAgeSeconds).toBeNull();
      expect(finding.snapshotLastSuccessAt).toBeNull();
    });

    it("refuses past the tenant's own block_after_seconds, and reports the age", async () => {
      // `block_after_seconds` is the tenant's declaration of the point at which a snapshot value
      // must not drive a decision (0005). Counting orphans against a mirror nobody would let a
      // rep act on would be a statement about the mirror wearing the clothes of a statement
      // about the data.
      await freshen(TENANT, "account", new Date(NOW.getTime() - 2 * 86_400_000));
      await visit(TENANT, rep, "acct-1");
      const finding = await checkVisits();
      expect(finding.verdict).toBe("unverifiable");
      expect(finding.snapshotAgeSeconds).toBe(2 * 86_400);
      expect(finding.unverifiableBecause).toContain("block_after_seconds");
    });

    it("counts against a merely STALE mirror, because warn is not block", async () => {
      // Two hours: past `warn_after_seconds` (an hour) and well inside `block_after_seconds`
      // (a day). A check that refused here would be unverifiable on most real deployments most
      // of the time, which is a check nobody reads — the age is recorded so an operator can
      // weigh it themselves.
      await freshen(TENANT, "account", new Date(NOW.getTime() - 2 * 3_600_000));
      await visit(TENANT, rep, "acct-missing");
      await erpDeleted(TENANT, "acct-missing");
      const finding = await checkVisits();
      expect(finding.verdict).toBe("orphans");
      expect(finding.snapshotAgeSeconds).toBe(2 * 3_600);
    });
  });

  describe("a whole sweep", () => {
    it("records one row per checkable reference, and the CHECK pins the pairing", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      const references = await inTenant((tx) => checkableReferences(tx));
      const result = await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      expect(result.checked).toBe(references.length);
      expect(result.references).toHaveLength(references.length);

      const findings = await inTenant((tx) => latestReferentialFindings(tx, TENANT));
      expect(findings).toHaveLength(references.length);
      // The account mirror was freshened and the others were not, so the sweep is a mix — which
      // is the realistic state and the one that proves the verdict is per reference.
      const byVerdict = new Set(findings.map((f) => f.verdict));
      expect(byVerdict).toContain("unverifiable");
      expect(byVerdict).toContain("clean");
      // 0066's constraint: an `unverifiable` run counted nothing. Asserted against the stored
      // rows rather than the returned objects, because the constraint is the database's.
      for (const row of findings.filter((f) => f.verdict === "unverifiable")) {
        expect(row.checked_count).toBe("0");
        expect(row.orphan_count).toBe("0");
      }
    });

    it("orders by seq, because every row of a sweep shares ran_at", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      const { rows } = await inTenant((tx) =>
        tx.query<{ ran_at: Date; seq: string }>(
          "SELECT ran_at, seq::text AS seq FROM crm.referential_check_run WHERE tenant_id = $1 ORDER BY seq",
          [TENANT],
        ),
      );
      expect(rows.length).toBeGreaterThan(1);
      // ONE TIMESTAMP ACROSS THE WHOLE SWEEP, which is the reason `seq` exists: `ran_at` is the
      // runner's single clock and the rows are written in one transaction, so a time-ordered
      // read would return them in whatever order the plan produced. 0027, 0033, 0041 and 0046
      // each learned this on a different table.
      expect(new Set(rows.map((r) => r.ran_at.getTime())).size).toBe(1);
      expect(rows.map((r) => Number(r.seq))).toEqual(
        [...rows.map((r) => Number(r.seq))].sort((a, b) => a - b),
      );
    });

    it("shows the newest answer per reference, not the last clean one", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await visit(TENANT, rep, "acct-gone");
      await erpDeleted(TENANT, "acct-gone");
      await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      const first = (await inTenant((tx) => latestReferentialFindings(tx, TENANT))).find(
        (f) => f.source_table === "visit",
      );
      expect(first?.verdict).toBe("orphans");

      // The mirror goes stale. The reference does not become clean — it becomes unverifiable,
      // and reading the clean-or-orphan run before it would be reporting an answer that is no
      // longer a claim.
      await freshen(TENANT, "account", new Date(NOW.getTime() - 2 * 86_400_000));
      await inTenant((tx) => runReferentialCheck(tx, TENANT, new Date(NOW.getTime() + 1000)));
      const second = (await inTenant((tx) => latestReferentialFindings(tx, TENANT))).find(
        (f) => f.source_table === "visit",
      );
      expect(second?.verdict).toBe("unverifiable");
      // And the history is still there: the sweep records, it does not replace.
      const { rows } = await inTenant((tx) =>
        tx.query(
          `SELECT 1 FROM crm.referential_check_run
            WHERE tenant_id = $1 AND source_table = 'visit' AND source_column = 'erp_account_id'`,
          [TENANT],
        ),
      );
      expect(rows).toHaveLength(2);
    });

    it("tells the administrators once, and not again the next night", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await visit(TENANT, rep, "acct-gone");
      await erpDeleted(TENANT, "acct-gone");

      const first = await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      // TWO references, from ONE deletion, which is what an operator really sees: the visit
      // points at the account and so does the assignment that let the rep visit it. Asserted
      // rather than narrowed to one, because a check that reported only the visit would leave
      // the rep's account list silently short with nobody told.
      expect(first.withOrphans).toBe(2);
      expect(first.references.filter((r) => r.verdict === "orphans").map((r) => r.sourceTable).sort()).toEqual([
        "account_assignment",
        "visit",
      ]);
      // One notice per (administrator, reference), and there is one administrator.
      expect(first.notified).toBe(2);

      const told = await inTenant((tx) => inbox(tx, admin, { limit: 10 }));
      const notice = told.find((n) => n.subject.includes("visit.erp_account_id"));
      expect(notice?.kind).toBe("referential_orphans_found");
      expect(notice?.severity).toBe("warning");
      expect(notice?.subject).toContain("visit.erp_account_id");
      // The sentence that makes a single notice honest rather than a limitation.
      expect(notice?.body).toContain("This is the only notice");
      // 0005's two cases, both named, because the remedy differs: ask the ERP what happened, or
      // find the write that got past validation.
      expect(notice?.body).toContain("the ERP deleted");
      expect(notice?.subject_table).toBe("crm.referential_check_run");

      // THE SECOND NIGHT. 0063's own argument against a periodic reminder — "a dedup key
      // carrying a period is nagging by construction" — so the key names the reference and
      // nothing else.
      //
      // The mirror is refreshed first, because `snapshot_full` runs nightly too. Without that
      // the second pass is `unverifiable` rather than `orphans` — the mirror would be a day and
      // a minute old, past its own `block_after_seconds` — which is the fail-closed rule working
      // and would have made this test pass for the wrong reason.
      const tomorrow = new Date(NOW.getTime() + 86_400_000);
      await freshen(TENANT, "account", new Date(tomorrow.getTime() - 60_000));
      const second = await inTenant((tx) => runReferentialCheck(tx, TENANT, tomorrow));
      expect(second.withOrphans).toBe(2);
      expect(second.notified).toBe(0);
    });

    it("closes the notice when a later run comes back clean", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await visit(TENANT, rep, "acct-gone");
      await erpDeleted(TENANT, "acct-gone");
      await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      const noticeId = (await inTenant((tx) => inbox(tx, admin, { limit: 10 }))).find(
        (n) => n.subject.includes("visit.erp_account_id"),
      )?.id;
      expect(noticeId).toBeDefined();

      const isOpen = async (): Promise<boolean> => {
        const { rows } = await inTenant((tx) =>
          tx.query<{ open: boolean }>(
            `SELECT crm.notification_subject_open(n.subject_table, n.subject_id) AS open
               FROM crm.notification n WHERE n.id = $1`,
            [noticeId],
          ),
        );
        return rows[0]!.open;
      };
      expect(await isOpen()).toBe(true);

      // Somebody fixes it — here, by the mirror catching up, which is one of the two real
      // remedies. The notice closes itself: the fault is the live state, not the history of
      // having reported it, which is the shape every other arm of
      // `notification_subject_open` uses.
      await account(TENANT, "acct-gone");
      await inTenant((tx) => runReferentialCheck(tx, TENANT, new Date(NOW.getTime() + 1000)));
      expect(await isOpen()).toBe(false);
      // And the notification is STILL THERE — it closed, it was not deleted. A notice whose
      // subject is settled is how every other arm of `notification_subject_open` behaves, and
      // retention is what eventually removes it.
      expect(
        (await inTenant((tx) => inbox(tx, admin, { limit: 10 }))).map((n) => n.id),
      ).toContain(noticeId);
    });

    it("tells nobody when nothing is wrong", async () => {
      await freshen(TENANT, "account", JUST_SYNCED);
      await account(TENANT, "acct-1");
      await visit(TENANT, rep, "acct-1");
      const result = await inTenant((tx) => runReferentialCheck(tx, TENANT, NOW));
      expect(result.withOrphans).toBe(0);
      expect(result.notified).toBe(0);
      expect(await inTenant((tx) => inbox(tx, admin, { limit: 10 }))).toHaveLength(0);
    });
  });

  describe("the line an operator reads", () => {
    const finding = (over: Partial<ReferenceCheck>): ReferenceCheck => ({
      sourceTable: "visit",
      sourceColumn: "erp_account_id",
      erpEntity: "Account",
      snapshotTable: "account_snapshot",
      verdict: "clean",
      checkedCount: 10,
      orphanCount: 0,
      orphanSample: [],
      snapshotLastSuccessAt: JUST_SYNCED,
      snapshotAgeSeconds: 60,
      unverifiableBecause: null,
      ...over,
    });

    it("is all lower case when there is nothing to do", () => {
      const r = summariseReferentialCheck([finding({}), finding({ sourceTable: "sample_lot" })]);
      expect(r.summary).toBe("references=2 clean=2");
      expect(r.orphans).toBe(0);
    });

    it("capitalises the two values that mean somebody has to act, and names where", () => {
      const r = summariseReferentialCheck([
        finding({ verdict: "orphans", orphanCount: 3 }),
        finding({
          sourceTable: "sample_lot",
          sourceColumn: "erp_item_id",
          verdict: "unverifiable",
          checkedCount: 0,
          unverifiableBecause: "the product snapshot has never synced",
        }),
      ]);
      // ORPHANS first, like `ESCALATED=` and `LOST=` on the lines beside it: it is the one
      // value here that means a human has to do something.
      expect(r.summary).toBe(
        "ORPHANS=3 UNVERIFIABLE=1 references=2 clean=0 " +
          "in=visit.erp_account_id:3 unchecked=sample_lot.erp_item_id",
      );
      // Named, not just counted. "ORPHANS=3" sends an operator to a query; the reference sends
      // them to the table.
      expect(r.summary).toContain("in=visit.erp_account_id:3");
      expect(r.withOrphans).toBe(1);
      expect(r.unverifiable).toBe(1);
    });

    it("reports notified as zero from the pure summary, which knows nothing about who was told", () => {
      expect(summariseReferentialCheck([finding({ verdict: "orphans", orphanCount: 1 })]).notified).toBe(0);
    });
  });
});
