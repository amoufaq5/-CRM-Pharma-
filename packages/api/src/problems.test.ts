import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as acl from "@crm/acl";
import * as callplan from "@crm/callplan";
import * as credential from "@crm/credential";
import * as db from "@crm/db";
import * as expense from "@crm/expense";
import * as notify from "@crm/notify";
import * as relay from "@crm/relay";
import * as role from "@crm/role";
import * as sample from "@crm/sample";
import * as storage from "@crm/storage";
import * as territory from "@crm/territory";
import * as visit from "@crm/visit";

import { ApiError, PROBLEM_BASE, toProblem } from "./problems.js";

/**
 * Domain errors are mapped to problems BY NAME (see `toProblem`), which is robust
 * across package boundaries and fragile in one specific way: a new error class added
 * to a domain package falls through to a 500 and nothing says so.
 *
 * So the mapping is asserted structurally, over every workspace package rather than
 * over a list somebody remembered to extend. The list used to be hand-written and went
 * stale three times — `@crm/expense` (twelve refusals, including the one the Finance
 * dependency rests on), `@crm/relay` (`DeadLetterNotFoundError`), and `@crm/acl`
 * (`ErpError`, which the file's own comment admitted was never asserted). Nothing is
 * learned by discovering that a fourth time, so the set of packages is now DERIVED from
 * every `packages/<dir>/package.json` in the workspace, and a package leaves it only
 * through `EXCLUDED`, with a reason, grounded in `@crm/api`'s own dependency manifest.
 */
describe("toProblem covers every domain error", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const PACKAGES_DIR = join(REPO_ROOT, "packages");

  /** The package under test — excluded from the audit, and from the grounding rule below. */
  const SELF = "@crm/api";

  /**
   * Every package whose exported errors must map to something a client can act on,
   * paired with its barrel namespace.
   *
   * Derived in the sense that matters: the test below refuses to run green if a package
   * under `packages/` is in neither this table nor `EXCLUDED`, so adding a package to the
   * workspace forces a decision about its errors instead of granting it silence.
   */
  const AUDITED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["@crm/acl", acl as unknown as Record<string, unknown>],
    ["@crm/callplan", callplan as unknown as Record<string, unknown>],
    ["@crm/credential", credential as unknown as Record<string, unknown>],
    ["@crm/db", db as unknown as Record<string, unknown>],
    ["@crm/expense", expense as unknown as Record<string, unknown>],
    ["@crm/notify", notify as unknown as Record<string, unknown>],
    ["@crm/relay", relay as unknown as Record<string, unknown>],
    ["@crm/role", role as unknown as Record<string, unknown>],
    ["@crm/sample", sample as unknown as Record<string, unknown>],
    ["@crm/storage", storage as unknown as Record<string, unknown>],
    ["@crm/territory", territory as unknown as Record<string, unknown>],
    ["@crm/visit", visit as unknown as Record<string, unknown>],
  ];

  /**
   * Packages this audit does not cover, with the reason each one does not need covering.
   *
   * A reason in prose is not enough — that is how the old list stayed wrong — so each one
   * is also GROUNDED: everything here but `@crm/api` itself must be absent from
   * `@crm/api`'s dependencies, which is what makes "no request can reach it" a fact about
   * the manifest rather than a claim. Add one of these to the API's dependencies and this
   * file fails until the package is audited instead.
   */
  const EXCLUDED: Readonly<Record<string, string>> = {
    [SELF]:
      "the package under test. `ApiError` is toProblem's OUTPUT, not an input to map, and " +
      "`JwtError` is converted into `unauthenticated` at its only throw site (server.ts), " +
      "so neither is a domain error this audit is about",
    "@crm/scheduler":
      "the background process, which drives the relay, the refresher and the sweeps. Not a " +
      "dependency of @crm/api, so nothing it raises can reach a request — and it declares " +
      "no error class of its own",
    "@crm/sync":
      "snapshot refresh, run by the scheduler. Not a dependency of @crm/api. Its one error, " +
      "`CoercionError`, rejects a record whose ERP value will not coerce into a typed column " +
      "(rule 4) and is reported as a `RejectedRecord` in the refresh result, never to a caller",
    "@crm/erasure":
      "the retention disposition register and the erasure plan (0051), reached only by the " +
      "`crm-erasure` CLI. Not a dependency of @crm/api, and deliberately not reachable over " +
      "HTTP at all: 0050 makes the API refuse every request for an `erp_deleted` tenant, so " +
      "the tenant's own API is precisely the surface that must not answer questions about its " +
      "data. It exports no error class — a plan reports its refusals as data, in a typed " +
      "`PlanRefusal` list, because \"what stands between us and being able to do this\" is an " +
      "answer and not an exception",
  };

  /**
   * Errors that SHOULD fall through to a 500, with the reason each one does.
   *
   * The rule above exists to catch an error class added to a domain package and never
   * mapped. It is not a claim that every error belongs in a response: an error that only
   * ever means "this process is broken" has no 4xx — giving it one invents a meaning it
   * does not have and hands a client a status it cannot act on.
   *
   * Explicit and listed, like RLS_EXEMPT in schema.contract.test.ts, so adding one is a
   * visible act with a reason attached rather than a silent hole. An entry here is NOT the
   * remedy for a class the probe cannot construct — see `PROBE_ARGS`.
   */
  const DELIBERATELY_INTERNAL: Readonly<Record<string, string>> = {
    // The email channel. These three happen inside the SCHEDULER while it talks to an SMTP
    // relay, where the sender converts them into a `SendOutcome` and the dispatcher logs them.
    InvalidSmtpRelayError: "boot-time relay configuration; the scheduler must fail to start, not answer a request",
    SmtpProtocolError: "the relay spoke something that is not SMTP; becomes a dead SendOutcome",
    SmtpTimeoutError: "a relay stopped answering; becomes a retry SendOutcome",
    UnknownAttachmentSubjectError:
      "crm.attachment_subject_rep has no branch for a subject table — the purpose pins the " +
      "table, so no request can reach this. It means the schema and the code disagree, it " +
      "names a database function, and only we can fix it",
    UnknownOperationError:
      "an outbox row carries an operation the dispatcher cannot parse — written by our own " +
      "producers, never by a request, so a client cannot provoke it and can do nothing " +
      "with it. The relay dead-letters the row with this sentence, which is where it belongs",
    ClientAlreadyInTenantContextError:
      "a caller handed the expense sweep a client already inside withTenantContext — a " +
      "programming error in the scheduler, not something a request can provoke or a client act on",

    // @crm/acl. Both are raised inside `ErpClient`, and @crm/api imports no part of
    // @crm/acl at all: the client runs in the scheduler's refresher and in the relay.
    UnknownEntityError:
      "the tenant's served manifest has no such entity. Raised by ErpClient while the " +
      "scheduler refreshes a snapshot, and its own message calls that a supported state " +
      "rather than a bug; no request path constructs an ErpClient",
    UnsupportedFilterError:
      "we asked the ERP to filter on a field its text-comparing store cannot answer " +
      "correctly (rules 3 and 4). It means OUR query was built wrong, inside the " +
      "scheduler, and only we can fix it — a client never chose the filter",

    // @crm/credential. The service credential and its key lifecycle. The only part of this
    // package on a request path is `GET /.well-known/jwks.json`.
    CredentialConfigError:
      "boot-time environment validation for the ERP service credential; the scheduler must " +
      "fail to start rather than answer a request",
    JwkError:
      "a key registry row whose kid is not the thumbprint of its own key — a hand-edited " +
      "row, which only we can fix. The jwks route now renders its document INSIDE its own " +
      "try/catch, so this no longer escapes as a 500: it falls to the designed 503, which " +
      "is where that answer belongs rather than in a mapping here. (An earlier version of " +
      "this entry described the escape as current; it was fixed in the same commit that " +
      "wrote the sentence.)",
    KeyRegistryError:
      "the service-key lifecycle, driven by the `key` CLI and the credential's own refresh. " +
      "The jwks route already catches every registry read failure and answers 503",
    KeyNotPropagatedError:
      "rule 12's first wait — a key signs only once it has been published. Enforced by the " +
      "registry for the key CLI and the credential, never on a request",
    KeyStillTrustedError:
      "rule 12's second wait — a key retires only once its tokens have expired. Same path, " +
      "same reason",
    ServiceRoleUnavailableError:
      "a tenant with no service role to mint against (rule 11). Raised while the scheduler " +
      "mints a token for an outbox dispatch",
    ServiceTokenError:
      "minting refused its own inputs — a ttl or a scope out of range. Our own callers " +
      "supply both; a request supplies neither",
    SignerError:
      "the local Ed25519 signer could not sign. A key or a crypto-library problem in the " +
      "process, not a request",

    // @crm/db. The substrate. Two of the three have no request path at all.
    InvalidTenantIdError:
      "`resolvePrincipal` checks the tenant against a UUID pattern BEFORE it calls " +
      "withTenantContext, and every other caller passes `principal.tenantId`, so a request " +
      "cannot provoke it — and its message would echo the rejected value back",
    MigrationChangedError:
      "the migration runner, which is a CLI. No request reaches it, and its sentence tells " +
      "whoever runs the migrations to write a new file instead of editing an applied one",
    PrivilegedConnectionError:
      "rule 1: the connection's role bypasses row-level security. An operator " +
      "misconfiguration that names a database role — see the dedicated test below",
    SupersedeDeclarationError:
      "the migration runner again (0043): a `-- @supersedes:` line naming no migration, or " +
      "naming one that does not come before the declaring file. A repository defect caught " +
      "at deploy time by a CLI, so there is no request to answer and the sentence is for " +
      "whoever wrote the declaration",
  };

  /**
   * Error classes a package declares with `export class` and deliberately keeps out of its
   * barrel, with the reason.
   *
   * Recorded rather than tolerated. "Built and unreachable" has shipped here three times,
   * so a class the gateway cannot see is worth a line that says why — and a NEW one cannot
   * appear without this file failing.
   */
  const PACKAGE_PRIVATE: Readonly<Record<string, string>> = {
    "@crm/relay.TargetAlreadyPresentError":
      "minted by `dispatch` and consumed by `classify` in the same package: it is how a " +
      "read-back of the target record overrides a duplicate-key guess. It never escapes " +
      "@crm/relay — classify turns it into an `Outcome` — so there is nothing for toProblem " +
      "to map and nothing for a caller to catch",
    "@crm/relay.TargetConfirmedAbsentError":
      "the other half of the same read-back, carrying the original write failure for " +
      "classify to rule on. Same lifetime, same reason",
  };

  /**
   * Error classes declared, used and tested inside a package, and MISSING FROM ITS BARREL —
   * found by the check below rather than reasoned about here.
   *
   * These are defects, not exemptions. Each one is `export class`, each is thrown on a path
   * a request can reach, and none is reachable from `@crm/api`: the barrel is the only door,
   * so `toProblem` can never be handed one and the refusal would arrive as "an unexpected
   * error occurred". That is the "built and unreachable" shape this repo has now shipped
   * five times — the whole reason the gate below exists.
   *
   * EMPTY, AND IT HAS TO BE ASSERTED EMPTY. The first version of this list skipped its
   * entries unconditionally, where `PACKAGE_PRIVATE` below ASSERTS the class stays
   * unexported — so a stale entry there fails loudly and a stale entry here was silent. It
   * went stale within one commit: the two classes it named were exported and mapped by the
   * same change that wrote it, and the prose still said "neither is reachable" about one
   * remaining item. A stale entry is worse than no list: the export test would skip the
   * class and the mapping test, which iterates barrel exports, would never see it — total
   * silence, reopening exactly the hole this file exists to close. So the skip is now an
   * assertion that the barrel really does NOT export it, and the list is empty, which is
   * the only state it should ever be committed in. The remedy for a new one is a mapping in
   * `problems.ts` plus the barrel export, in the same change.
   */
  const UNEXPORTED_AND_UNMAPPED: Readonly<Record<string, string>> = {};

  /**
   * Arguments for classes whose constructors read their arguments rather than merely
   * interpolating them.
   *
   * The default is one placeholder string per declared parameter, which satisfies every
   * class in the workspace but these two: both index a transition map with `from`, so a
   * placeholder makes the lookup `undefined` and the constructor throws on `.length`. The
   * values come from each package's own exported state list, so a renamed state breaks the
   * probe here rather than silently exempting the class.
   *
   * This exists because the probe USED TO SWALLOW THAT: it constructed each candidate
   * inside a try/catch and `continue`d on a throw, so a class whose constructor needed real
   * arguments simply vanished from an audit that called itself exhaustive —
   * `InvalidExpenseClaimTransitionError` was being skipped in a package that was in the
   * list precisely because all twelve of its refusals had once reached a client as a 500.
   * A class that cannot be probed is now a failure, and the remedy is an entry here, never
   * an entry in DELIBERATELY_INTERNAL.
   */
  const PROBE_ARGS: Readonly<Record<string, readonly unknown[]>> = {
    InvalidTransitionError: [visit.VISIT_STATUSES[0], visit.VISIT_STATUSES[1]],
    InvalidExpenseClaimTransitionError: [expense.EXPENSE_CLAIM_STATES[0], expense.EXPENSE_CLAIM_STATES[1]],
  };

  type ErrorClass = new (...args: readonly unknown[]) => Error;

  /**
   * Whether a value is an error CLASS, decided by walking its prototype chain to `Error`.
   *
   * Structural rather than by name, which is what excludes the `translateXError` helpers:
   * a function's prototype chain reaches `Function.prototype`, never `Error`. The old check
   * constructed the value and compared `instance.name`, which excluded those helpers too —
   * and excluded anything that threw, which is the hole this file now closes.
   */
  const isErrorClass = (value: unknown): value is ErrorClass => {
    if (typeof value !== "function") return false;
    let proto: unknown = Object.getPrototypeOf(value) as unknown;
    while (typeof proto === "function") {
      if (proto === Error) return true;
      proto = Object.getPrototypeOf(proto) as unknown;
    }
    return false;
  };

  const errorClassNames = (mod: Record<string, unknown>): readonly string[] =>
    Object.entries(mod)
      .filter(([, value]) => isErrorClass(value))
      .map(([name]) => name)
      .sort();

  const defaultProbeArgs = (arity: number): readonly unknown[] =>
    Array.from({ length: Math.max(arity, 1) }, (_unused, i) => `probe-arg-${i}`);

  const construct = (moduleName: string, name: string, Cls: ErrorClass): Error => {
    const args = PROBE_ARGS[name] ?? defaultProbeArgs(Cls.length);
    try {
      return new Cls(...args);
    } catch (cause) {
      expect.fail(
        `${moduleName}.${name} could not be constructed with ${JSON.stringify(args)}: ` +
          `${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}. ` +
          `A class the probe cannot build used to be skipped in silence, which exempted it ` +
          `from this audit entirely. Give it an entry in PROBE_ARGS with arguments its ` +
          `constructor accepts, read off the constructor itself — do NOT add it to ` +
          `DELIBERATELY_INTERNAL, and do not drop the package from AUDITED.`,
      );
    }
  };

  const sourceFiles = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
      return entry.name.includes(".test.") ? [] : [full];
    });

  /**
   * The error classes a package DECLARES, read off its source.
   *
   * Only `extends …Error` is recognised, which is every error class in this workspace. A
   * class extending an Error-derived base that is not named `…Error` would be missed; the
   * prototype-chain check above is the authority on what gets audited, and this scan backs
   * only the narrower claim that nothing declared is missing from the barrel.
   */
  const declaredErrorClasses = (packageDir: string): readonly string[] => {
    const pattern = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+[A-Za-z0-9_$]*Error\b/gm;
    const out: string[] = [];
    for (const file of sourceFiles(join(PACKAGES_DIR, packageDir, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) out.push(name);
      }
    }
    return out.sort();
  };

  interface PackageManifest {
    readonly name?: unknown;
    readonly dependencies?: unknown;
  }

  const manifest = (packageDir: string): PackageManifest =>
    JSON.parse(readFileSync(join(PACKAGES_DIR, packageDir, "package.json"), "utf8")) as PackageManifest;

  const workspacePackageNames = (): readonly string[] => {
    const names: string[] = [];
    for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(PACKAGES_DIR, entry.name, "package.json"))) continue;
      const name = manifest(entry.name).name;
      if (typeof name !== "string") throw new Error(`packages/${entry.name}/package.json declares no name`);
      names.push(name);
    }
    return names.sort();
  };

  /** `@crm/sample` → `sample`. Every package in this workspace is `packages/<basename>`. */
  const packageDirOf = (moduleName: string): string => moduleName.replace(/^@crm\//, "");

  it("audits every package under packages/, or excludes it with a reason", () => {
    const workspace = workspacePackageNames();
    const accounted = new Set<string>([...AUDITED.map(([name]) => name), ...Object.keys(EXCLUDED)]);

    for (const name of workspace) {
      expect(
        accounted.has(name),
        `${name} is in the workspace but neither in AUDITED nor in EXCLUDED. Its exported ` +
          `errors are therefore unchecked — add it to AUDITED, or to EXCLUDED with the reason ` +
          `no request can reach them.`,
      ).toBe(true);
    }
    // And the other direction, so a deleted or renamed package cannot leave a line here
    // claiming to cover something that no longer exists.
    for (const name of accounted) {
      expect(workspace, `${name} is listed here but is not a package under packages/`).toContain(name);
    }
  });

  it("grounds every exclusion in @crm/api's own dependencies", () => {
    const deps = manifest(packageDirOf(SELF)).dependencies;
    expect(typeof deps).toBe("object");
    const declared = Object.keys(deps as Record<string, unknown>);

    for (const [name] of AUDITED) {
      expect(declared, `${name} is imported by this test but is not a dependency of ${SELF}`).toContain(name);
    }
    for (const name of Object.keys(EXCLUDED)) {
      if (name === SELF) continue;
      expect(
        declared,
        `${name} is excluded on the grounds that no request can reach it, yet ${SELF} depends ` +
          `on it. Either the dependency is wrong or the package now needs auditing — the ` +
          `exclusion is not a judgement call any more.`,
      ).not.toContain(name);
    }
  });

  for (const [moduleName, mod] of AUDITED) {
    it(`exports every error class ${moduleName} declares`, () => {
      const declared = declaredErrorClasses(packageDirOf(moduleName));
      // Every audited package declares at least one; a barrel that stopped exporting all of
      // them would otherwise pass the mapping test below by offering nothing to map. This
      // replaces the hand-written per-package minimums, which were guesses kept "deliberately
      // close to the real count" and drifted from it.
      expect(declared.length, `${moduleName} declares no error class — is this still the right package?`).toBeGreaterThan(0);

      const exported = new Set(errorClassNames(mod));
      for (const name of declared) {
        const key = `${moduleName}.${name}`;
        if (key in UNEXPORTED_AND_UNMAPPED) {
          // Asserted, not skipped: an entry that has been fixed must fail here rather than
          // keep exempting the class from both this test and the mapping test.
          expect(
            exported.has(name),
            `${key} is recorded as unexported-and-unmapped and the barrel now exports it; ` +
              `drop the entry and make sure problems.ts maps it`,
          ).toBe(false);
          continue;
        }
        if (key in PACKAGE_PRIVATE) {
          expect(
            exported.has(name),
            `${key} is recorded as package-private and the barrel now exports it; drop the entry and map it`,
          ).toBe(false);
          continue;
        }
        expect(
          exported.has(name),
          `${moduleName}/src declares ${name} and the barrel does not export it, so it is ` +
            `unreachable from the gateway and toProblem can never be given one. Export it, or ` +
            `record it in PACKAGE_PRIVATE with the reason it stays inside the package.`,
        ).toBe(true);
      }
    });

    it(`maps every error exported by ${moduleName}`, () => {
      const names = errorClassNames(mod);
      expect(names.length).toBeGreaterThan(0);

      for (const name of names) {
        const Cls = mod[name];
        expect(isErrorClass(Cls)).toBe(true);
        const instance = construct(moduleName, name, Cls as ErrorClass);

        // `toProblem` dispatches on `name`, not on the export name or `instanceof`, so a
        // class that names itself something else is unmappable however carefully it is
        // listed. Asserted rather than used as a filter: the old probe silently dropped a
        // mismatch, which is the same hole as dropping a throw.
        expect(
          instance.name,
          `${moduleName}.${name} names itself ${JSON.stringify(instance.name)}; toProblem dispatches on that name`,
        ).toBe(name);

        const problem = toProblem(instance);
        if (name in DELIBERATELY_INTERNAL) {
          expect(problem.kind, `${name} is listed as internal; if that changed, map it`).toBe("internal");
          continue;
        }
        expect(problem.kind, `${moduleName}.${name} falls through to a 500`).not.toBe("internal");
        // The invariant is "not a 500 the client can do nothing with", and for most packages
        // that is the same as 4xx. `MissingAttachmentBlobError` is the legitimate exception:
        // the metadata row exists and the blob store does not hold its bytes, which is a
        // stated upstream condition rather than our surprise, and 0033 keeps it as a named
        // refusal so the failure arrives with the backend to look in rather than as an empty
        // body. `ErpError` has mapped to the same kind since the ACL shipped. Allowed BY KIND
        // and not by status, so a new 5xx mapping has to be added here deliberately.
        if (problem.kind === "upstream_unavailable") {
          expect(problem.status, `${name} is upstream_unavailable`).toBe(503);
        } else {
          expect(problem.status).toBeLessThan(500);
        }
      }
    });
  }

  it("keeps an unrecognised throw generic, and says nothing about the internals", () => {
    const problem = toProblem(new Error("relation crm.sample_holding does not exist"));
    expect(problem.kind).toBe("internal");
    expect(problem.status).toBe(500);
    // An internal message can carry a table name, a column or SQL. The client is the
    // wrong place for that; the log is the right one.
    expect(problem.detail).toBe("an unexpected error occurred");
    expect(problem.detail).not.toContain("sample_holding");
  });

  it("gives the custody refusals a client can branch on their own types", () => {
    expect(toProblem(new sample.LotExpiredError("expired on 2026-01-01")).body().type).toBe(
      `${PROBLEM_BASE}/lot-expired`,
    );
    expect(toProblem(new sample.InsufficientHoldingError("holds 2.000")).body().type).toBe(
      `${PROBLEM_BASE}/insufficient-stock`,
    );
    expect(toProblem(new callplan.PlanFrozenError("are fixed")).body().type).toBe(`${PROBLEM_BASE}/plan-final`);
  });

  it("gives an unmapped expense category its own type, because Finance must act on it", () => {
    const problem = toProblem(new expense.UnmappedCategoryError("congress"));
    expect(problem.body().type).toBe(`${PROBLEM_BASE}/unmapped-category`);
    expect(problem.status).toBe(409);
    // The sentence has to survive: it names the category and the table Finance fills in.
    expect(problem.detail).toContain("congress");
  });

  it("gives the lockout refusal its own type, because a client must act on it", () => {
    expect(toProblem(new role.LastAdministratorError("refusing to revoke the last administrator")).body().type).toBe(
      `${PROBLEM_BASE}/last-administrator`,
    );
    expect(toProblem(new role.SelfGrantError("cannot grant themselves")).status).toBe(403);
    expect(toProblem(new role.RoleAlreadyHeldError("compliance", "2026-01-01")).status).toBe(409);
  });

  /**
   * The state-machine refusals the old probe could not even construct.
   *
   * Both read their own transition map inside the constructor, so both threw on the
   * probe's placeholder arguments and both were dropped from the audit without a word —
   * `@crm/expense` was in the list and `InvalidExpenseClaimTransitionError` was not being
   * checked. They are mapped, as it happens; that was luck, not coverage.
   */
  it("maps the transition refusals whose constructors need real states", () => {
    expect(toProblem(new visit.InvalidTransitionError("completed", "in_progress")).status).toBe(409);
    expect(toProblem(new expense.InvalidExpenseClaimTransitionError("reimbursed", "draft")).status).toBe(409);
    // All three state machines answer ONE type, and it is not a `*_final` one. A refused
    // transition is usually not terminal — `planned → completed` is the obvious case — and
    // it used to come back titled "Visit is final" with a detail saying otherwise, which is
    // the wrong sentence for a client that renders `title`.
    for (const e of [
      // `planned` has outgoing transitions, so this is "not from here" and NOT "this is
      // over" — the case that used to be titled "Visit is final".
      new visit.InvalidTransitionError("planned", "completed"),
      new callplan.InvalidPlanTransitionError("draft cannot be approved"),
      new expense.InvalidExpenseClaimTransitionError("draft", "posted"),
    ]) {
      const problem = toProblem(e);
      expect(problem.kind, e.name).toBe("invalid_transition");
      // Through `body()`, because the TITLE a client renders is the thing that was wrong —
      // asserting the kind alone would have passed before this change too.
      expect(problem.body().title, e.name).toBe("Transition not allowed");
      expect(problem.body().type).toBe(`${PROBLEM_BASE}/invalid-transition`);
      // The detail still carries the states, which is where the specifics belong.
      expect(problem.body().detail, e.name).toBe(e.message);
    }
  });

  /**
   * And the two that really DO mean "this is over" keep their own types, because the
   * remedy differs: a transition refusal says try a legal one, a final-state refusal says
   * there is nothing left to do to this record.
   */
  it("keeps a separate type for the genuinely final states", () => {
    expect(toProblem(new visit.VisitIsFinalError("visit v1 is completed")).body().title).toBe("Visit is final");
    // And the SAME class answers `visit_final` when its source state really is terminal,
    // which is the distinction the flag exists for.
    const terminal = toProblem(new visit.InvalidTransitionError("completed", "in_progress"));
    expect(terminal.kind).toBe("visit_final");
    expect(terminal.body().title).toBe("Visit is final");
    expect(toProblem(new callplan.PlanFrozenError("plan p1 is frozen")).body().title).toBe(
      "Call plan is final",
    );
  });

  /**
   * The one domain error that SHOULD fall through to a generic 500.
   *
   * A connection whose role bypasses RLS is an operator misconfiguration, not something
   * a client did or can fix, and the error names a database role. Mapping it to a
   * friendlier problem would publish that name to anyone who can make a request. The
   * full message goes to the structured log, where the operator is.
   */
  it("keeps a privileged-connection refusal internal, and does not name the role", () => {
    const problem = toProblem(new db.PrivilegedConnectionError("postgres"));
    expect(problem.kind).toBe("internal");
    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem.body("cid"))).not.toContain("postgres");
    expect(JSON.stringify(problem.body("cid"))).not.toContain("row-level security");
  });

  it("passes an ApiError through untouched", () => {
    const original = new ApiError("not_found", "no such thing");
    expect(toProblem(original)).toBe(original);
  });
});
