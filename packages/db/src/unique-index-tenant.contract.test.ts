import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { testPool } from "./testing.js";

/**
 * A UNIQUE INDEX is enforced with row security DISABLED. Every one of them has to survive that.
 *
 * THE RULE THIS FILE CARRIES, which ADR-0001 held open as three lessons learned the hard way and
 * worth having in one place, because a migration author needs the SET and not one of them:
 *
 *   * 0035 — adding a composite FOREIGN KEY as `crm_app` under FORCE ROW LEVEL SECURITY
 *     validates against ZERO VISIBLE ROWS and marks itself `convalidated = true` over a table
 *     holding a violation. A bulk validation is an ordinary query, so it is confined, so it sees
 *     nothing: it needs a pre-flight that asks from inside each tenant.
 *   * 0032 — a clamp (plain DML) was blind the same way, and the validated CHECK that followed
 *     was NOT, so the migration refused its own repair. DML needs FORCE lifted (0027's pattern).
 *   * 0043 — a UNIQUE INDEX is ENFORCED with row security disabled, so
 *     `uq_outbox_dead_letter_attempt (outbox_id, attempt)` refused across tenants while the
 *     trigger allocating `attempt` was confined. Demonstrated live: tenant B saw zero rows and
 *     the index refused anyway, which made it an EXISTENCE ORACLE and took `UPDATE crm.outbox`
 *     down with it.
 *
 * So the asymmetry is: DML and a foreign key's bulk validation are ordinary queries and are
 * confined; a CHECK's validation scan and a unique index's enforcement are not. The first two
 * need the migration to lift FORCE; the third needs the KEY to carry `tenant_id` — or to be a
 * key whose values cannot repeat across tenants in the first place.
 *
 * WHY A TEST AND NOT A PARAGRAPH. The two migrations that got this wrong were written by someone
 * who had already learned it once. The rule only helps at the moment a key is being chosen, so it
 * has to arrive then: a new unique index over a tenant-relative value — a code, a counter, a
 * name, a date — lands in `CONFINED_BY_CONSTRUCTION` below and fails this test until its author
 * either prefixes it with `tenant_id` or writes down why it cannot collide.
 *
 * `testPool()`, the ADMIN connection, because this reads `pg_index` and `pg_attribute` and asks
 * nothing of any tenant's rows. The behaviour of the keys themselves is `composite-fk`'s subject.
 */
describe("every unique index on a tenant-scoped table (0035, 0032, 0043)", () => {
  let pool: Pool;
  let client: PoolClient;

  interface Live {
    readonly table: string;
    readonly index: string;
    /** Key columns in index order, comma-joined. Expression columns read as `(expr)`. */
    readonly cols: string;
    /** The first key column's declared type, which is what decides a uuid-scoped key. */
    readonly first_type: string;
    readonly first_col: string;
    readonly has_tenant: boolean;
    readonly is_primary: boolean;
  }

  let live: readonly Live[] = [];

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    const { rows } = await client.query<Live>(
      `WITH scoped AS (
         SELECT c.oid, c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crm' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                           AND a.attnum > 0 AND NOT a.attisdropped)
       )
       SELECT s.relname AS table,
              i.relname AS index,
              -- An expression index has attnum 0 for that position; it reads as (expr) rather
              -- than being dropped, so a key this test cannot classify cannot pass unnoticed.
              -- (No backticks in this SQL: it is a template literal, which is the fourth time
              -- that has cost a build in this repository.)
              (SELECT string_agg(COALESCE(a.attname, '(expr)'), ',' ORDER BY k.ord)
                 FROM unnest(ix.indkey::int[]) WITH ORDINALITY k(att, ord)
                 LEFT JOIN pg_attribute a ON a.attrelid = s.oid AND a.attnum = k.att) AS cols,
              COALESCE(f.attname, '(expr)') AS first_col,
              COALESCE(format_type(f.atttypid, f.atttypmod), 'expression') AS first_type,
              (SELECT bool_or(a.attname = 'tenant_id')
                 FROM unnest(ix.indkey::int[]) k(att)
                 JOIN pg_attribute a ON a.attrelid = s.oid AND a.attnum = k.att) AS has_tenant,
              ix.indisprimary AS is_primary
         FROM scoped s
         JOIN pg_index ix ON ix.indrelid = s.oid AND ix.indisunique
         JOIN pg_class i ON i.oid = ix.indexrelid
         LEFT JOIN pg_attribute f ON f.attrelid = s.oid AND f.attnum = (ix.indkey::int[])[0]
        ORDER BY 1, 2`,
    );
    live = rows;
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  /**
   * Keys that carry no `tenant_id` and are not scoped by a uuid, with the reason each one cannot
   * collide across tenants anyway.
   *
   * EXPLICIT AND LISTED, like `RLS_EXEMPT` in `schema.contract.test.ts` and `NOT_IN_THE_BUILD` in
   * the project-reference guard, so an addition is a visible act with an argument attached. Both
   * of today's entries are globally unique by construction, which is the only reason that counts:
   * it is not that a collision would be unlikely, it is that the generator cannot produce one.
   */
  const CONFINED_BY_CONSTRUCTION: Readonly<Record<string, string>> = {
    uq_disposal_obligation_seq:
      "`seq` is `bigint DEFAULT nextval('crm.disposal_obligation_seq_seq')` — ONE sequence for " +
      "the whole table, not a per-tenant counter, so two tenants cannot be handed the same value. " +
      "That is exactly the distinction 0043 turned on: its `attempt` was allocated by COUNTING " +
      "rows the allocator could see, which is per-tenant, where a sequence is not",
    tenant_tombstone_pkey:
      "`crm.tenant_tombstone.id` is text and holds `newCrmTombstoneId()` — `crmtomb_` followed " +
      "by the 32 hex digits of a random uuid. A uuid wearing a prefix, so the uuid argument " +
      "applies; it is listed rather than inferred because this test reads types, and `text` is " +
      "the type a per-tenant code would also have",
  };

  it("found the catalog, or every assertion below is vacuous", () => {
    // The guard on the guard: this derives from `pg_index`, so a query that matched nothing would
    // report a clean schema — the vacuous green this repository has now been bitten by twice.
    expect(live.length).toBeGreaterThan(60);
    expect(live.map((u) => u.index)).toContain("rep_profile_pkey");
    expect(live.map((u) => u.table)).toContain("outbox_dead_letter");
  });

  /**
   * The rule itself, reported as one list rather than one failure per index.
   *
   * A reader adding a unique index wants to be told what is wrong with THEIR key and what the two
   * ways out are, which is why the message carries both rather than only the verdict.
   */
  it("is prefixed with tenant_id, scoped by a uuid, or declared with a reason", () => {
    const unexplained = live
      .filter((u) => !u.has_tenant)
      .filter((u) => u.first_type !== "uuid")
      .filter((u) => CONFINED_BY_CONSTRUCTION[u.index] === undefined)
      .map(
        (u) =>
          `crm.${u.table}.${u.index} (${u.cols}) — first key column ${u.first_col} is ` +
          `${u.first_type}, not uuid`,
      );
    expect(
      unexplained,
      "a unique index is ENFORCED with row security disabled (0043), so a key whose values can " +
        "repeat across tenants refuses one tenant's legitimate row because of another's — an " +
        "existence oracle, and an outage for whatever writes through it. Either add tenant_id to " +
        "the key, or add the index to CONFINED_BY_CONSTRUCTION with the reason its values cannot " +
        "collide",
    ).toEqual([]);
  });

  /**
   * And the declared list names something real, which is the rule `crm.data_disposition`'s own
   * trigger applies to its register: a list that can be satisfied by a typo is a list that
   * silences this test by accident.
   */
  it("declares no index that does not exist, and none that needs no declaration", () => {
    const names = new Set(live.map((u) => u.index));
    expect(Object.keys(CONFINED_BY_CONSTRUCTION).filter((n) => !names.has(n))).toEqual([]);
    // And nothing in the list is already covered by the mechanical rules, or the reason is dead
    // text that outlived the thing it explained.
    const redundant = live
      .filter((u) => CONFINED_BY_CONSTRUCTION[u.index] !== undefined)
      .filter((u) => u.has_tenant || u.first_type === "uuid")
      .map((u) => `${u.index} is already ${u.has_tenant ? "tenant-prefixed" : "uuid-scoped"}`);
    expect(redundant).toEqual([]);
  });

  /**
   * The 0043 index itself, as it stands today.
   *
   * The incident is the reason this file exists, so the repaired key is asserted by name rather
   * than left to the rule above: a future migration that "simplified" it back to
   * `(outbox_id, attempt)` would pass the generic check — `outbox_id` is a uuid — and reopen
   * the oracle, because what made it wrong was the per-tenant ALLOCATOR and not the key's shape.
   */
  it("keeps 0043's repaired key tenant-prefixed, which the generic rule cannot see", () => {
    // The repair RENAMED it as well as re-keying it — `uq_outbox_dead_letter_tenant_attempt` —
    // which this test got wrong on its first run, asserting the pre-0043 name and failing with
    // "is gone". Worth keeping as written: a rename is exactly what a by-name assertion is for.
    const attempt = live.find((u) => u.index === "uq_outbox_dead_letter_tenant_attempt");
    expect(
      attempt,
      "uq_outbox_dead_letter_tenant_attempt is gone — if that is deliberate, say so here",
    ).toBeDefined();
    expect(attempt?.cols).toBe("tenant_id,outbox_id,attempt");
  });

  /**
   * WHY, demonstrated rather than asserted — the shape the rule forbids, refusing live.
   *
   * The catalog rule above is a claim about keys; this is the behaviour that makes the claim
   * worth having. An `employee_number` is the archetype: tenants number their own staff, so E1
   * exists in every one of them. With a unique index over it and no `tenant_id`, the second
   * tenant's legitimate row is refused because of a row it cannot see — an existence oracle,
   * and an outage for whatever writes through that table.
   *
   * EVERYTHING ROLLS BACK, which is why this needs no reserved tenants of its own: the index and
   * both rows exist only inside the transaction. `CREATE INDEX` (non-concurrent) is transactional,
   * which is what makes the demonstration possible at all.
   *
   * As the ADMIN, because the point is what the index does with row security OUT of the way —
   * which is the condition a unique index is always enforced under, for every caller.
   */
  it("refuses a second tenant's identical key, which is the whole reason for the rule", async () => {
    const A = "00000000-0000-4000-8000-00000000ff01";
    const B = "00000000-0000-4000-8000-00000000ff02";
    const rep = (tenant: string, n: string): string =>
      `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name, erp_employee_id)
       VALUES ('${tenant}', 'oracle-probe-${n}-${tenant.slice(-4)}', '${n}', 'Probe', 'erp-${n}-${tenant.slice(-4)}')`;

    await client.query("BEGIN");
    try {
      // Registered inside the transaction, because since 0075 `crm.rep_profile` references
      // `crm.tenant (tenant_id)` — a probe tenant with no registry row cannot hold a rep at
      // all. Both rows roll back with everything else below.
      for (const t of [A, B]) {
        await client.query(
          `INSERT INTO crm.tenant (tenant_id, display_name, status)
           VALUES ($1, 'unique-index probe (0074)', 'active') ON CONFLICT (tenant_id) DO NOTHING`,
          [t],
        );
      }
      // THE PREDICATE IS NOT WHAT MAKES THIS SAFE — it is what stops the demonstration depending
      // on what other suites have committed. `crm.rep_profile` is shared, every suite numbers its
      // own reps from E1, so an unqualified unique index cannot even be CREATED here: the full
      // run fails with "could not create unique index" against rows that are all perfectly
      // legitimate. (It created fine when this file ran alone, which is the same premise-that-
      // depends-on-the-table trap `disposal-sequence` was corrected for twice.) Narrowed to two
      // tenants nothing else uses, the index validates against zero rows and then refuses the
      // second insert — which is the point: the KEY carries no tenant_id, so enforcement reaches
      // across the two tenants inside the predicate exactly as it reached across all of them.
      await client.query(
        `CREATE UNIQUE INDEX uq_probe_employee_number ON crm.rep_profile (employee_number)
          WHERE tenant_id = ANY (ARRAY['${A}'::uuid, '${B}'::uuid])`,
      );
      await client.query(rep(A, "E1"));
      const refusal = await client
        .query(rep(B, "E1"))
        .then(() => null, (e: unknown) => e as { code?: string; constraint?: string });

      // 23505 is unique_violation. The constraint named is the one this test created, so the
      // failure cannot be some other key on the table answering first.
      expect(refusal?.code).toBe("23505");
      expect(refusal?.constraint).toBe("uq_probe_employee_number");
    } finally {
      await client.query("ROLLBACK");
    }

    // And the index is gone with the transaction, so the catalog this file reads is unchanged.
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_class WHERE relname = 'uq_probe_employee_number'",
    );
    expect(rows[0]!.n).toBe("0");
  });

  /**
   * A partial unique index is enforced the same way, and its PREDICATE is evaluated with row
   * security disabled too — so a predicate that reads like a per-tenant statement is not one.
   *
   * Asserted as a property of the three that exist rather than as a rule, because a predicate
   * cannot be classified mechanically: what matters is that each one's key is already confined,
   * which the rule above covers, and that somebody has looked at the predicate.
   */
  it("has seven partial unique indexes, none of them confined by their predicate", async () => {
    const { rows } = await client.query<{ index: string; pred: string }>(
      `SELECT i.relname AS index, pg_get_expr(ix.indpred, ix.indrelid) AS pred
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'crm' AND ix.indisunique AND ix.indpred IS NOT NULL
        ORDER BY 1`,
    );
    // Not restricted to tenant-scoped tables, deliberately: `uq_service_key_one_active` is on a
    // PLATFORM table (one active service key per deployment, which is the point of it), and a
    // list that quietly excluded it would hide the one case where "no tenant_id" is correct
    // because there is no tenant.
    expect(rows.map((r) => r.index)).toEqual([
      "uq_attachment_current",
      "uq_call_plan_live",
      "uq_disposal_obligation_live",
      "uq_notification_endpoint_probe_outstanding",
      "uq_sample_count_one_open",
      "uq_sample_tx_transfer_accepted",
      "uq_service_key_one_active",
    ]);
    // EVERY predicate selects by STATE — a status, a state, a non-null transfer — and never by
    // tenant. That matters because a predicate is evaluated with row security disabled like the
    // rest of the index: a `tenant_id = …` term in one of these would READ like confinement and
    // not be it, which is 0043's mistake in a different clause. Three of these keys do carry
    // `tenant_id`; what is asserted here is that none of them relies on the predicate for it.
    for (const r of rows) expect(r.pred, r.index).not.toContain("tenant_id");
  });
});
