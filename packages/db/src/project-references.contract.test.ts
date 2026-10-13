import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Every workspace dependency a package declares must also be a TypeScript project reference.
 *
 * WHAT THIS CAUGHT, and the reason it exists at all. Two increments added `@crm/sync` and
 * `@crm/erasure` to other packages' `dependencies`, imported them, and typechecked clean locally —
 * then CI went red on all four jobs with `Cannot find module '@crm/erasure' or its corresponding
 * type declarations`. Nothing was wrong with the code. The two lists had drifted:
 *
 *   * `pnpm -r build` and `npx tsc -p packages/api` build in the order the PNPM graph gives, so a
 *     dependency's `dist/` is already there by the time anything needs it — which is why this is
 *     invisible locally;
 *   * `pnpm typecheck` is `tsc --build --force`, which orders by `references` in `tsconfig.json`
 *     and knows nothing about `package.json`. An unreferenced dependency has no `dist/`, and a
 *     package whose `types` points into `dist/` then resolves to nothing.
 *
 * So the manifest said one thing and the compiler was told another, and the only place the
 * disagreement showed was a clean-checkout build. This is the third pair of lists in this
 * repository that has to agree — `JOB_NAMES`/`crm.scheduled_jobs()` and
 * `NOTIFICATION_KINDS`/`crm.notification_kinds()` are the others — and the arrangement is the same
 * one: derive both sides from the files rather than restating either, and fail the day they part.
 *
 * NO DATABASE, so this is not a `.contract` test in the usual sense of the word — the name is kept
 * because it asserts a contract between two files that nothing else checks, and because a reader
 * looking for the repository's cross-file guards should find it with them.
 */
describe("tsconfig references and package.json dependencies", () => {
  const root = join(__dirname, "..", "..", "..");
  const workspaces = ["packages", "apps"] as const;

  interface Pkg {
    readonly dir: string;
    readonly name: string;
    readonly workspaceDeps: readonly string[];
    readonly references: readonly string[];
    readonly hasTsconfig: boolean;
  }

  const read = (): readonly Pkg[] => {
    const out: Pkg[] = [];
    for (const ws of workspaces) {
      const base = join(root, ws);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(base, entry.name);
        const manifest = join(dir, "package.json");
        if (!existsSync(manifest)) continue;
        const pkg = parseJsonc(readFileSync(manifest, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        // DEPENDENCIES ONLY, not devDependencies. A dev dependency is for a test or a build
        // script, and `tsc --build` deliberately excludes `*.test.ts` — so requiring a reference
        // for one would force the whole workspace to be built to typecheck anything.
        const workspaceDeps = Object.entries(pkg.dependencies ?? {})
          .filter(([, spec]) => spec.startsWith("workspace:"))
          .map(([dep]) => dep)
          .sort();

        const tsconfigPath = join(dir, "tsconfig.json");
        const hasTsconfig = existsSync(tsconfigPath);
        const references = hasTsconfig
          ? ((parseJsonc(readFileSync(tsconfigPath, "utf8")) as {
                references?: readonly { path: string }[];
              }).references?.map((r) => r.path) ?? [])
          : [];
        out.push({
          dir: `${ws}/${entry.name}`,
          name: pkg.name ?? entry.name,
          workspaceDeps,
          references,
          hasTsconfig,
        });
      }
    }
    return out;
  };

  /**
   * A tsconfig is JSONC, and `apps/field/tsconfig.json` really has comments in it.
   *
   * Comments stripped rather than a JSONC dependency added, and only the two forms TypeScript's
   * own configs use: `//` to end of line, and `/* … *\/`. Deliberately NOT trailing commas —
   * `JSON.parse` would then throw on one, which is the right outcome, because a trailing comma in
   * a tsconfig is a file `tsc` reads and `JSON.parse` here would have to guess about.
   *
   * A string containing `//` would be mangled by this, and no path in any of these files does.
   * Stated rather than guarded, because a guard would be a JSON parser and that is the dependency
   * this is avoiding.
   */
  const parseJsonc = (text: string): unknown =>
    JSON.parse(
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'\\])\/\/.*$/gm, (_m, lead: string) => lead),
    );

  /** `@crm/sync` → `sync`, which is what a reference path ends with. */
  const folderOf = (dep: string): string => dep.replace(/^@crm\//, "");

  const packages = read();

  /**
   * Projects `tsc --build` deliberately does not visit, with the reason each one is excluded.
   *
   * EXPLICIT AND LISTED, like `RLS_EXEMPT` in `schema.contract.test.ts` and
   * `DELIBERATELY_INTERNAL` in the problems audit, so adding one is a visible act with a reason
   * attached rather than a silent hole. There is exactly one, and this guard found it the moment
   * it was written — which is the point: the exclusion was real and undeclared.
   */
  const NOT_IN_THE_BUILD: Readonly<Record<string, string>> = {
    "apps/field":
      "the browser client, with `composite: false`, `noEmit: true` and `moduleResolution: " +
      "Bundler` — so it cannot BE a project reference (composite is required) and does not need " +
      "one (esbuild resolves `@crm/client` through the workspace link, and `tsc` here only " +
      "typechecks). The root `typecheck` script runs it separately for exactly this reason, and " +
      "it is the one project whose tests `tsc --build` covers, since it includes them",
  };

  it("found the workspace, or every assertion below is vacuous", () => {
    // The guard on the guard. This test reads the filesystem rather than a manifest list, so a
    // wrong `root` would make it pass by examining nothing — which is exactly the vacuous-green
    // failure 0066's live gate had to be corrected for.
    expect(packages.length).toBeGreaterThan(15);
    expect(packages.map((p) => p.name)).toContain("@crm/api");
    expect(packages.map((p) => p.name)).toContain("@crm/erasure");
  });

  /**
   * The assertion itself, reported as one list rather than one failure per package.
   *
   * A reader fixing this wants every missing reference at once: adding them one CI run at a time
   * is how a clean-checkout build stays broken for four runs.
   */
  it("references every workspace dependency it declares", () => {
    const missing: string[] = [];
    for (const pkg of packages) {
      if (!pkg.hasTsconfig) continue;
      if (pkg.dir in NOT_IN_THE_BUILD) continue;
      for (const dep of pkg.workspaceDeps) {
        const want = `../${folderOf(dep)}`;
        if (!pkg.references.includes(want)) {
          missing.push(`${pkg.dir}/tsconfig.json needs { "path": "${want}" } for ${dep}`);
        }
      }
    }
    expect(
      missing,
      "pnpm typecheck is `tsc --build`, which orders by these references and not by package.json — " +
        "an unreferenced dependency has no dist/ and resolves to nothing on a clean checkout",
    ).toEqual([]);
  });

  /**
   * And the other direction: a reference to something that is no longer a dependency.
   *
   * Harmless to the build — `tsc --build` would just build one package more than it needs — and it
   * makes the two lists disagree, which is how a completeness claim quietly stops being checked.
   * Same argument as `crm.disposition_orphans()` for the retention register.
   */
  it("references nothing it does not depend on", () => {
    const extra: string[] = [];
    for (const pkg of packages) {
      const declared = new Set(pkg.workspaceDeps.map((d) => `../${folderOf(d)}`));
      for (const ref of pkg.references) {
        if (pkg.dir in NOT_IN_THE_BUILD) continue;
      if (!declared.has(ref)) {
          extra.push(`${pkg.dir}/tsconfig.json references ${ref}, which is not a dependency`);
        }
      }
    }
    expect(extra).toEqual([]);
  });

  /**
   * A workspace package that `tsc --build` cannot see at all.
   *
   * The root `tsconfig.json` lists every project; one missing from it is one the build never
   * visits, so its `dist/` appears only when something else happens to build it — the same class
   * of fault as a missing reference, one level up.
   */
  it("lists every package in the root build", () => {
    const rootConfig = parseJsonc(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      references?: readonly { path: string }[];
    };
    const listed = new Set((rootConfig.references ?? []).map((r) => r.path.replace(/^\.\//, "")));
    const unlisted = packages
      .filter((p) => p.hasTsconfig && !listed.has(p.dir) && !(p.dir in NOT_IN_THE_BUILD))
      .map((p) => `${p.dir} is not in the root tsconfig's references`);
    expect(unlisted).toEqual([]);

    // And the exclusions have to name something real, or the list is a way to silence this test
    // by typo — the rule `crm.data_disposition`'s trigger applies to its own register.
    const dirs = new Set(packages.map((p) => p.dir));
    expect(Object.keys(NOT_IN_THE_BUILD).filter((d) => !dirs.has(d))).toEqual([]);
  });
});
