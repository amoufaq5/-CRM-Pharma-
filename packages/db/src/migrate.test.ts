import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadMigrations,
  MigrationChangedError,
  sha256,
  supersededFiles,
  type Migration,
} from "./migrate.js";

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

describe("supersededFiles", () => {
  const DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  const m = (filename: string, supersedes: readonly string[] = []): Migration => ({
    filename,
    sql: "SELECT 1",
    sha256: sha256(filename),
    requiresDba: false,
    supersedes,
  });

  /**
   * The escape hatch for the one failure the hash ledger cannot survive: a migration that
   * CANNOT succeed. `applyMigrations` halts on the first failure and records nothing, so a
   * database stuck on such a file retries it forever and every migration after it — the one
   * written to repair it included — is unreachable. 0032 was that file and 0039 was that
   * repair.
   */
  it("reads the declaration out of the real migrations", async () => {
    const all = await loadMigrations(DIR);
    expect([...supersededFiles(all).entries()]).toEqual([
      ["0032_prune_floor_cap.sql", "0042_retire_0032.sql"],
    ]);
  });

  it("refuses a name that matches no migration, because a typo would be silent", () => {
    // The whole failure mode: a mistyped target leaves the dead file running, and failing,
    // with nothing to say the declaration did not take.
    expect(() => supersededFiles([m("0001_a.sql"), m("0002_b.sql", ["0001_typo.sql"])])).toThrow(
      /not a migration/,
    );
  });

  it("refuses a target that does not come before the declaring file", () => {
    // "This earlier thing is dead" is the only claim the declaration can make. A later
    // target would retire something that has not happened yet; itself would never run at all.
    expect(() => supersededFiles([m("0001_a.sql", ["0002_b.sql"]), m("0002_b.sql")])).toThrow(
      /does not come before it/,
    );
    expect(() => supersededFiles([m("0001_a.sql", ["0001_a.sql"])])).toThrow(/does not come before it/);
  });

  it("is computed over every file, so a declaration reaches back past the dead one", async () => {
    // The property that makes the mechanism work at all: the declaration lives in a file
    // numbered AFTER the one it retires, so the runner has to know before the loop gets
    // there. 0042 is ten files past 0032.
    const all = await loadMigrations(DIR);
    const names = all.map((x) => x.filename);
    expect(names.indexOf("0042_retire_0032.sql")).toBeGreaterThan(names.indexOf("0032_prune_floor_cap.sql"));
  });
});
