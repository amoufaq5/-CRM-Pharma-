import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrations, MigrationChangedError, sha256 } from "./migrate.js";

describe("sha256", () => {
  it("is stable and content-addressed", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(sha256("a")).not.toBe(sha256("b"));
    expect(sha256("")).toHaveLength(64);
  });
});

describe("MigrationChangedError", () => {
  it("names the file and tells the reader what to do instead", () => {
    const err = new MigrationChangedError("0003_rep_profile.sql", "a".repeat(64), "b".repeat(64));
    expect(err.message).toContain("0003_rep_profile.sql");
    expect(err.message).toContain("Write a new migration");
    expect(err.name).toBe("MigrationChangedError");
  });
});

describe("loadMigrations", () => {
  const DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

  it("loads the real migrations in numeric order", async () => {
    const all = await loadMigrations(DIR);
    expect(all.length).toBeGreaterThan(10);
    const names = all.map((m) => m.filename);
    expect([...names].sort()).toEqual(names);
    expect(names[0]).toBe("0001_roles_and_grants.sql");
  });

  it("classifies exactly the privileged files as DBA", async () => {
    const all = await loadMigrations(DIR);
    expect(all.filter((m) => m.requiresDba).map((m) => m.filename)).toEqual([
      "0001_roles_and_grants.sql",
      "0002_crm_schema.sql",
    ]);
  });

  /**
   * The rule that was learned the hard way.
   *
   * Migration 0010 created `btree_gist`, which crm_app cannot do — so it ran as
   * the admin, which left its tables owned by the admin, and an OWNER BYPASSES
   * RLS. The territory tables had policies that did nothing for a week.
   *
   * A statement needing cluster privileges therefore belongs in a file marked
   * `@requires: dba`, and nothing else does: an unmarked file containing one
   * either fails on deploy or, worse, succeeds and voids isolation.
   */
  it("no unmarked migration contains a statement crm_app cannot run", async () => {
    const PRIVILEGED = /\b(CREATE|ALTER|DROP)\s+(EXTENSION|ROLE|USER|DATABASE|TABLESPACE)\b/i;
    const offenders = (await loadMigrations(DIR))
      .filter((m) => !m.requiresDba && PRIVILEGED.test(m.sql))
      .map((m) => m.filename);
    expect(
      offenders,
      "add `-- @requires: dba` — or these tables end up owned by the admin, which bypasses RLS",
    ).toEqual([]);
  });

  it("the DBA files come first, so the app role and ledger exist before anything needs them", async () => {
    const all = await loadMigrations(DIR);
    const lastDba = all.findLastIndex((m) => m.requiresDba);
    const firstApp = all.findIndex((m) => !m.requiresDba);
    expect(lastDba).toBeLessThan(firstApp);
  });
});
