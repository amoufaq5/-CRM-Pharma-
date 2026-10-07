import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { grepRepo } from "./testing.js";

/**
 * The test harness's own grep, tested — because its failure mode is a test that passes.
 *
 * Two coverage suites used to shell out to ripgrep, which a GitHub runner does not have:
 * `spawnSync rg ENOENT`, and one of the two reasons CI was red for 33 consecutive runs.
 * Replacing it with a Node walk removed the dependency and introduced a worse hazard,
 * which is what these assertions are for. `rg` exits 1 on no match, so `execFileSync`
 * threw and the test failed. A Node implementation that returned `[]` would hand a
 * coverage suite an empty producer set and let it pass vacuously — green, and claiming
 * coverage it never checked.
 */
describe("grepRepo", () => {
  const root = resolve(import.meta.dirname, "../../..");

  it("finds matches and reports them in ripgrep's path:line:text shape", () => {
    const hits = grepRepo({
      root,
      dir: "db/migrations",
      pattern: /CREATE SCHEMA IF NOT EXISTS crm/,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit).toMatch(/^db\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql:[0-9]+:/);
    }
    // 0001 is the DBA step that creates the schema; the call sites rely on the path
    // prefix being repository-relative and POSIX-shaped, which is what rg printed.
    expect(hits.some((h) => h.startsWith("db/migrations/0001_"))).toBe(true);
  });

  it("THROWS when nothing matches, as rg's exit 1 did", () => {
    expect(() =>
      grepRepo({ root, dir: "db/migrations", pattern: /CREATE TABLE crm\.no_such_table_anywhere/ }),
    ).toThrow(/found no match/);
  });

  it("throws when it scanned no files at all, naming the root", () => {
    expect(() => grepRepo({ root, dir: "db/migrations", pattern: /./, include: () => false })).toThrow(
      /scanned no files under .*db\/migrations/,
    );
  });

  it("does not descend into node_modules or dist", () => {
    // `packages/*/dist` exists after a build, so an include that only accepts a path
    // inside it must scan nothing — which is the walk's skip list, observed.
    expect(() =>
      grepRepo({ root, dir: "packages", pattern: /./, include: (rel) => rel.includes("/dist/") }),
    ).toThrow(/scanned no files/);
  });

  it("matches every line independently under a /g pattern", () => {
    // A /g RegExp carries lastIndex between calls, so without a reset the walk would
    // test line 2 starting from wherever line 1's match ended and silently skip hits.
    const hits = grepRepo({ root, dir: "db/migrations", pattern: /CREATE TABLE/g });
    const once = grepRepo({ root, dir: "db/migrations", pattern: /CREATE TABLE/ });
    expect(hits).toEqual(once);
    expect(hits.length).toBeGreaterThan(30);
  });

  it("is reading the repository it is part of", () => {
    // The same guard the storage suite carries: a wrong root makes every claim above
    // vacuous, and this is the cheapest way to notice.
    const hits = grepRepo({ root, dir: ".", pattern: /"typecheck:tests"/, include: (rel) => rel === "package.json" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^package\.json:[0-9]+:/);
  });
});
