import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { appPool } from "@crm/db/testing";

import { NOTIFICATION_KINDS } from "./kinds.js";

/**
 * Does `crm.notification_subject_open` have a branch for every producer?
 *
 * WHY THIS EXISTS. Retention prunes a notification once it is past its horizon UNLESS the
 * thing it is about is still unfinished, and that question is answered by one SQL function
 * with a branch per producing table (migration 0024). A table it has no branch for reads
 * as NOT open — deliberately, because the failure being fixed is unbounded growth and
 * "keep forever when unsure" would reintroduce it silently.
 *
 * The cost of that choice is this: a producer added without a branch prunes its
 * notifications at the normal horizon even while the obligation they name is open. The
 * job's `unknownSubjects` count reports it, but only after the fact, and only if somebody
 * reads a log line. ADR-0001 recorded the gap as open on the grounds that "a test that
 * derives the producer list from the code would have to parse it".
 *
 * It does not have to parse it. Every producer passes `subjectTable:` with a STRING
 * LITERAL — there is no computed case in the repo and this test fails loudly if one
 * appears — so ripgrep finds the set, and the live catalog gives the branches. Comparing
 * the two is the whole test.
 *
 * Read from `pg_proc` rather than from the migration file on purpose: what matters is the
 * function the database is actually running, which is what a prune will consult.
 */
describe("notification subject coverage", () => {
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

  /** Every `subjectTable:` argument in non-test source, as written. */
  const producersInSource = (): ReadonlyMap<string, readonly string[]> => {
    // `--glob` excludes tests and build output: a fixture naming a made-up table is the
    // retention suite proving the unknown-subject path, not a producer.
    const out = execFileSync(
      "rg",
      [
        "--no-heading", "--line-number", "--color=never",
        "--glob", "packages/*/src/**/*.ts",
        "--glob", "!**/*.test.ts",
        "--glob", "!**/dist/**",
        "subjectTable:\\s*",
        ".",
      ],
      { cwd: root, encoding: "utf8" },
    );

    const byTable = new Map<string, string[]>();
    const unparsed: string[] = [];
    for (const line of out.split("\n").filter((l) => l !== "")) {
      const where = line.slice(0, line.indexOf(":", line.indexOf(":") + 1));
      const arg = line.slice(line.indexOf("subjectTable:") + "subjectTable:".length).trim();
      // `input.subjectTable ?? null` in raise.ts is the sink, not a producer.
      if (arg.startsWith("string") || /^(input|opts|options)\./.test(arg)) continue;
      const literal = /^"([a-z_.]+)"/.exec(arg);
      if (literal === null) {
        unparsed.push(`${where} -> ${arg.slice(0, 60)}`);
        continue;
      }
      const table = literal[1]!;
      byTable.set(table, [...(byTable.get(table) ?? []), where]);
    }

    // The one assumption this test rests on. A computed subject table would make the set
    // unknowable by grep, and silently weakening to "whatever we could parse" is how a
    // coverage test stops covering anything — so it fails instead, naming the line.
    expect(
      unparsed,
      "a subjectTable argument that is not a string literal: this test can no longer " +
        "derive the producer set, and the coverage it claims is no longer real",
    ).toEqual([]);
    return byTable;
  };

  const branchesInDatabase = async (): Promise<readonly string[]> => {
    const { rows } = await client.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname = 'notification_subject_open'",
    );
    expect(rows, "crm.notification_subject_open is missing from the database").toHaveLength(1);
    return [...rows[0]!.prosrc.matchAll(/WHEN '([a-z_.]+)'/g)].map((m) => m[1]!);
  };

  it("has a branch for every table a producer names", async () => {
    const producers = producersInSource();
    const branches = new Set(await branchesInDatabase());

    // Not a smoke test: if the grep found nothing, the pattern has drifted and the
    // comparison below would pass vacuously.
    expect(producers.size).toBeGreaterThan(2);

    const missing = [...producers.entries()]
      .filter(([table]) => !branches.has(table))
      .map(([table, sites]) => `${table} (raised at ${sites.join(", ")})`);

    expect(
      missing,
      "these tables are named as a notification subject but crm.notification_subject_open " +
        "has no branch for them, so their notifications prune at the normal horizon even " +
        "while the thing they are about is still open. Add a branch in a migration.",
    ).toEqual([]);
  });

  /**
   * The other direction, as a warning rather than a failure in spirit — but asserted,
   * because a branch for a table nobody raises against is either a producer that was
   * deleted or a table name that was mistyped, and both are worth knowing.
   */
  it("has no branch for a table no producer names", async () => {
    const producers = producersInSource();
    const orphans = (await branchesInDatabase()).filter((t) => !producers.has(t));
    expect(
      orphans,
      "crm.notification_subject_open branches on tables nothing raises a notification " +
        "about — a deleted producer, or a typo that means the real table has no branch",
    ).toEqual([]);
  });

  /** Each branch must name a table that exists, or it can never match. */
  it("branches only on tables that exist", async () => {
    const branches = await branchesInDatabase();
    const { rows } = await client.query<{ missing: string }>(
      `SELECT t AS missing FROM unnest($1::text[]) AS t
        WHERE to_regclass(t) IS NULL`,
      [branches],
    );
    expect(rows.map((r) => r.missing)).toEqual([]);
  });

  /**
   * And the vocabulary the other way: every kind in `NOTIFICATION_KINDS` must be legal in
   * the database. 0021 put a CHECK on `crm.notification.kind` and every migration up to
   * 0031 had to re-state the whole list; one forgotten value means a raise that throws at
   * runtime, which is the kind of thing that only shows up on the night the signal fires.
   *
   * This used to read the list by pattern-matching `'...'::text` out of the deparsed CHECK,
   * and 0049 broke it — correctly. The list now lives in `crm.notification_kinds()` and the
   * CHECK calls it, so there are no literals to match and the test saw a constraint that
   * accepted nothing. The replacement does not look at the CHECK's SPELLING at all: it
   * takes the deparsed predicate and ASKS POSTGRES TO EVALUATE IT against every kind the
   * code can raise. That is stronger than the string match was and it is indifferent to
   * where the vocabulary is declared, so the next move of it will not break this again.
   */
  it("every notification kind the code can raise is accepted by the database", async () => {
    const kinds: readonly string[] = NOTIFICATION_KINDS;
    expect(kinds.length).toBeGreaterThan(5);

    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'crm.notification'::regclass AND conname = 'notification_kind_check'`,
    );
    const def = rows[0]?.def ?? "";
    expect(def, "notification_kind_check must exist to be evaluated").toMatch(/^CHECK\s*\(/);
    // Safe to interpolate: this string is `pg_get_constraintdef` of one constraint found by
    // name, not anything a caller supplied.
    const predicate = def.replace(/^CHECK\s*\(/, "").replace(/\)\s*$/, "");
    const { rows: refused } = await client.query<{ kind: string }>(
      `SELECT kind FROM unnest($1::text[]) AS t(kind) WHERE NOT (${predicate})`,
      [kinds],
    );
    expect(refused.map((r) => r.kind), "kinds the CHECK would refuse").toEqual([]);

    // The other direction cannot be asked of a predicate — nothing enumerates what an
    // arbitrary expression accepts — so it is asked of the declaration the predicate reads.
    const { rows: declared } = await client.query<{ kinds: string[] }>(
      "SELECT crm.notification_kinds() AS kinds",
    );
    expect(
      declared[0]!.kinds.filter((k) => !kinds.includes(k)),
      "kinds the database admits that no code can raise",
    ).toEqual([]);
  });

  /** A sanity check that the source tree is where this test thinks it is. */
  it("is reading the repository it is part of", () => {
    expect(readFileSync(resolve(root, "package.json"), "utf8")).toContain('"typecheck:tests"');
  });
});
