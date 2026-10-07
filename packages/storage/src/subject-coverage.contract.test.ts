import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { appPool, grepRepo } from "@crm/db/testing";

import { MAX_ATTACHMENT_BYTES } from "./content.js";
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_PURPOSES,
  ATTACHMENT_STATUSES,
  ATTACHMENT_STORAGE_BACKENDS,
  ATTACHMENT_SUBJECT_TABLES,
  COMMITTED_PURPOSES,
  SUBJECT_TABLE_BY_PURPOSE,
  SUPERSEDABLE_PURPOSES,
} from "./subjects.js";

/**
 * Does the database agree with this package about what an attachment can be?
 *
 * WHY THIS EXISTS. The attachment vocabulary is stated THREE times: as constants in
 * `subjects.ts`, as CHECK constraints on `crm.attachment`, and as branches in
 * `crm.attachment_subject_rep` / `crm.attachment_subject_table_for`. Three statements of
 * one rule is three chances to disagree, and the consequences are not symmetrical — a
 * purpose the constants know and the owner function does not would be a row nobody owns
 * and therefore nobody may read, which 0033 makes unstorable precisely so the failure is
 * loud. This test is what keeps it loud.
 *
 * Modelled on `packages/notify/src/subject-coverage.contract.test.ts`, which does the same
 * for `crm.notification_subject_open` after ADR-0001 recorded the gap as open on the
 * grounds that "a test that derives the producer list from the code would have to parse
 * it". It does not: the branches come out of `pg_proc` and the producers out of a typed
 * constant, and comparing the two is the whole test.
 *
 * Read from the live catalog rather than from the migration file, deliberately: what
 * matters is the function the database is actually running, which is what a write will
 * consult.
 */
describe("attachment subject coverage", () => {
  let pool: Pool;
  let client: PoolClient;
  const root = resolve(import.meta.dirname, "../../..");

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  /** The values a named CHECK constraint on crm.attachment admits, as the catalog spells them. */
  const admitted = async (conname: string): Promise<readonly string[]> => {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'crm.attachment'::regclass AND conname = $1`,
      [conname],
    );
    expect(rows, `crm.attachment has no constraint ${conname}`).toHaveLength(1);
    return [...rows[0]!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
  };

  const branches = async (proname: string): Promise<readonly string[]> => {
    const { rows } = await client.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crm' AND p.proname = $1",
      [proname],
    );
    expect(rows, `crm.${proname} is missing from the database`).toHaveLength(1);
    return [...rows[0]!.prosrc.matchAll(/WHEN '([^']+)'/g)].map((m) => m[1]!);
  };

  it("admits exactly the purposes this package can write", async () => {
    expect([...(await admitted("attachment_purpose_check"))].sort()).toEqual([...ATTACHMENT_PURPOSES].sort());
  });

  it("admits exactly the subject tables this package names", async () => {
    expect([...(await admitted("attachment_subject_table_check"))].sort()).toEqual(
      [...ATTACHMENT_SUBJECT_TABLES].sort(),
    );
  });

  it("admits exactly the content types this package accepts", async () => {
    expect([...(await admitted("attachment_content_type_check"))].sort()).toEqual(
      [...ATTACHMENT_CONTENT_TYPES].sort(),
    );
  });

  it("admits exactly the statuses and backends this package knows", async () => {
    expect([...(await admitted("attachment_status_check"))].sort()).toEqual([...ATTACHMENT_STATUSES].sort());
    expect([...(await admitted("attachment_storage_backend_check"))].sort()).toEqual(
      [...ATTACHMENT_STORAGE_BACKENDS].sort(),
    );
  });

  /**
   * The fail-closed direction, asserted as coverage rather than as behaviour.
   *
   * A purpose with no owner branch is a row nobody owns, and nobody may read an
   * attachment nobody owns — so the gap would not leak data, it would make the feature
   * silently unusable for that subject, with the refusal arriving as "no rep owns this".
   * Either way it is a defect, and this is where it shows up.
   */
  it("has an owner branch for every subject table a purpose can name", async () => {
    const owners = new Set(await branches("attachment_subject_rep"));
    const missing = ATTACHMENT_SUBJECT_TABLES.filter((t) => !owners.has(t));
    expect(
      missing,
      "crm.attachment_subject_rep has no branch for these tables, so an attachment on one " +
        "would have no owning rep — which means nobody could be authorised to read it, and " +
        "nobody could create it. Add a branch in a migration.",
    ).toEqual([]);
  });

  it("has no owner branch for a table no purpose can name", async () => {
    const orphans = (await branches("attachment_subject_rep")).filter(
      (t) => !(ATTACHMENT_SUBJECT_TABLES as readonly string[]).includes(t),
    );
    expect(
      orphans,
      "crm.attachment_subject_rep resolves owners for tables nothing can attach to — a " +
        "deleted purpose, or a typo that means the real table has no branch",
    ).toEqual([]);
  });

  it("branches only on tables that exist", async () => {
    const tables = await branches("attachment_subject_rep");
    const { rows } = await client.query<{ missing: string }>(
      "SELECT t AS missing FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NULL",
      [tables],
    );
    expect(rows.map((r) => r.missing)).toEqual([]);
  });

  /**
   * The pairing, stated three times and compared all three ways.
   *
   * `SUBJECT_TABLE_BY_PURPOSE` here, `crm.attachment_subject_table_for` in the trigger,
   * and the `attachment_purpose_subject` CHECK underneath it. The function and the CHECK
   * are separate on purpose — the constraint reads as its own statement in
   * `\d crm.attachment` and holds if the trigger is ever dropped — which is exactly why
   * they need comparing.
   */
  it("pairs each purpose with the same subject table in TypeScript, in the function and in the CHECK", async () => {
    const { rows } = await client.query<{ purpose: string; table: string | null }>(
      `SELECT p AS purpose, crm.attachment_subject_table_for(p) AS table
         FROM unnest($1::text[]) AS p`,
      [[...ATTACHMENT_PURPOSES]],
    );
    for (const row of rows) {
      expect(row.table, `crm.attachment_subject_table_for(${row.purpose})`).toBe(
        SUBJECT_TABLE_BY_PURPOSE[row.purpose as (typeof ATTACHMENT_PURPOSES)[number]],
      );
    }
    expect(rows).toHaveLength(ATTACHMENT_PURPOSES.length);

    const { rows: check } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'crm.attachment'::regclass AND conname = 'attachment_purpose_subject'`,
    );
    // Split on the disjunction and read one arm per purpose, rather than searching the
    // whole text for two substrings: the loose form passes a constraint whose arms have
    // been CROSSED, which is the exact mistake worth catching.
    const arms = (check[0]?.def ?? "").split(/\bOR\b/);
    for (const purpose of ATTACHMENT_PURPOSES) {
      const table = SUBJECT_TABLE_BY_PURPOSE[purpose];
      const matching = arms.filter((arm) => arm.includes(`'${purpose}'::text`));
      expect(matching, `attachment_purpose_subject has no single arm for ${purpose}`).toHaveLength(1);
      expect(matching[0], `${purpose} must pair with ${table}`).toContain(`'${table}'::text`);
      for (const other of ATTACHMENT_SUBJECT_TABLES) {
        if (other === table) continue;
        expect(matching[0], `${purpose} must not also admit ${other}`).not.toContain(`'${other}'::text`);
      }
    }
  });

  it("resolves no subject table for a purpose it does not know", async () => {
    const { rows } = await client.query<{ table: string | null }>(
      "SELECT crm.attachment_subject_table_for('visit_photo') AS table",
    );
    // NULL, not a guess. The trigger compares `IS DISTINCT FROM`, so NULL refuses every
    // table rather than matching one.
    expect(rows[0]?.table).toBeNull();
  });

  /**
   * The signature commitment check is the reason this subsystem exists, and the set of
   * purposes it applies to is stated in two places: `COMMITTED_PURPOSES` here and the
   * `IF NEW.purpose = ...` arm in `crm.attachment_validate`. A purpose added to the
   * constant without an arm would advertise a guarantee nothing enforces, which is the
   * worst of the available failures.
   */
  it("checks a commitment in the trigger for every purpose declared as committed", async () => {
    const { rows } = await client.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crm' AND p.proname = 'attachment_validate'",
    );
    const src = rows[0]?.prosrc ?? "";
    expect(src).not.toBe("");
    for (const purpose of COMMITTED_PURPOSES) {
      expect(src, `crm.attachment_validate has no commitment arm for ${purpose}`).toContain(
        `NEW.purpose = '${purpose}'`,
      );
    }
    expect(src).toContain("signature_sha256");
    // And every committed purpose is refused a supersession, because a replaceable
    // attachment with an immutable commitment is a contradiction.
    for (const purpose of COMMITTED_PURPOSES) {
      expect(SUPERSEDABLE_PURPOSES as readonly string[]).not.toContain(purpose);
    }
  });

  it("refuses a supersession of a committed purpose in the trigger as well as in the store", async () => {
    const { rows } = await client.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crm' AND p.proname = 'attachment_validate'",
    );
    const src = rows[0]?.prosrc ?? "";
    for (const purpose of COMMITTED_PURPOSES) {
      // The store refuses this early so a client is not asked to upload first; the trigger
      // is what holds for a psql prompt, and "a rule in the route only" is a rule this
      // repo has shipped broken before (ADR-0001, the email channel).
      expect(src, `no trigger-level supersession refusal for ${purpose}`).toMatch(
        new RegExp(`${purpose}[\\s\\S]{0,400}cannot be superseded`),
      );
    }
  });

  /**
   * The size ceiling, stated in TypeScript and twice in SQL.
   *
   * Three copies of one number, so all three are compared. The TypeScript copy is the one
   * with the derivation attached (the API's body cap and base64's 4/3 expansion), and a
   * schema that drifted from it would refuse a file the route accepted or accept one the
   * route could not deliver.
   */
  it("carries one size ceiling across TypeScript and both CHECK constraints", async () => {
    const { rows } = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('crm.attachment'::regclass, 'crm.attachment_blob'::regclass)
          AND conname IN ('attachment_byte_size_check', 'attachment_blob_size')
        ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(["attachment_blob_size", "attachment_byte_size_check"]);
    for (const row of rows) {
      expect(row.def, row.conname).toContain(String(MAX_ATTACHMENT_BYTES));
    }
  });

  /**
   * Nothing here may be SECURITY DEFINER.
   *
   * `packages/db/src/schema.contract.test.ts` asserts this across the whole schema, and it
   * is re-asserted for these functions specifically because they are the ones that decide
   * who may read a third party's biometric data: a definer function runs as its OWNER, so
   * one owned by a privileged role would read every tenant's rows whoever called it, and
   * `withTenantContext`'s role guard would have said yes (ADR-0001 item 15).
   */
  it("keeps every attachment function SECURITY INVOKER, so tenant scoping reaches it", async () => {
    const { rows } = await client.query<{ name: string; secdef: boolean }>(
      `SELECT p.proname AS name, p.prosecdef AS secdef
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'crm' AND p.proname LIKE 'attachment%'
        ORDER BY p.proname`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.filter((r) => r.secdef).map((r) => r.name)).toEqual([]);
  });

  it("puts every attachment table under RLS with FORCE, and leaves none platform-wide", async () => {
    const { rows } = await client.query<{ relname: string; rls: boolean; forced: boolean; owner: string }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'crm' AND c.relkind = 'r' AND c.relname LIKE 'attachment%'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(["attachment", "attachment_access", "attachment_blob"]);
    for (const row of rows) {
      expect(row.rls, `${row.relname} must ENABLE ROW LEVEL SECURITY`).toBe(true);
      // FORCE is the one that matters: crm_app OWNS these tables and an owner is exempt
      // from a policy it is not forced under.
      expect(row.forced, `${row.relname} must FORCE ROW LEVEL SECURITY`).toBe(true);
      expect(row.owner).toBe("crm_app");
    }
  });

  it("gives every attachment table a stable order that is not the transaction clock", async () => {
    // `now()` is the transaction timestamp, so rows written together share it to the
    // microsecond and nothing may order by it — 0027's finding on crm.outbox. Both tables
    // that are ever listed carry a sequence; a new one without is the same latent bug.
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'crm' AND c.relkind = 'r' AND c.relname IN ('attachment', 'attachment_access')
          AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'seq' AND NOT a.attisdropped)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  /**
   * One migration, as assigned, and nothing else in `db/migrations/` touches these tables.
   *
   * The working tree is shared, so this also catches a second file created by mistake —
   * two migrations creating `crm.attachment` would leave whichever ran second failing on a
   * fresh database, which is a failure nobody sees until CI builds one from nothing.
   */
  it("is created by exactly one migration", () => {
    // Was ripgrep; a GitHub runner has none (`spawnSync rg ENOENT`). `grepRepo` scans in
    // Node and, like `rg`, throws rather than returning nothing — which here would turn
    // "exactly one migration creates it" into "no migration mentions it, fine".
    const hits = grepRepo({
      root,
      dir: "db/migrations",
      pattern: /CREATE TABLE crm\.attachment/,
    });
    expect(hits).toHaveLength(3);
    for (const hit of hits) expect(hit).toMatch(/^db\/migrations\/0033_attachments\.sql:/);
  });

  it("is reading the repository it is part of", () => {
    expect(readFileSync(resolve(root, "package.json"), "utf8")).toContain('"typecheck:tests"');
  });
});
