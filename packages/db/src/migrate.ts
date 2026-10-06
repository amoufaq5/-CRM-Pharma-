import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";

export interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
  /**
   * True when the file declares `-- @requires: dba`.
   *
   * Two kinds of migration exist and they have different rules:
   *
   * - **DBA** migrations need privileges the application role does not have
   *   (CREATE ROLE, CREATE EXTENSION). They run as the admin identity, they run
   *   on EVERY deploy, and they must therefore be IDEMPOTENT. They cannot be
   *   hash-gated because the ledger they would be recorded in is created by one
   *   of them.
   * - **Application** migrations run as `crm_app` and are hash-gated: applied
   *   once, and an edit after the fact is refused.
   *
   * The requirement is declared IN THE FILE rather than in a list the deploy
   * script maintains, so a new DBA migration cannot be missed by someone
   * forgetting to update the list.
   */
  readonly requiresDba: boolean;
  /**
   * Files this migration declares `-- @supersedes: <filename>` for, which are RECORDED
   * WITHOUT BEING RUN.
   *
   * The escape hatch for the one failure the hash ledger cannot survive on its own: a
   * migration that CANNOT SUCCEED. `applyMigrations` stops at the first failure and records
   * nothing, so a database halted on such a file retries it on every deploy and every
   * migration after it — including the one written to repair it — is unreachable forever.
   * That is what happened to `0032_prune_floor_cap.sql`: its clamp is DML on an RLS-FORCEd
   * table as `crm_app` with no tenant context, so it updates zero rows, and the validated
   * CHECK that follows then refuses the file. `0039_prune_floor_repair.sql` is the repair
   * and could never run.
   *
   * Declared IN THE FILE, like `@requires: dba`, and for the same reason: a list the deploy
   * script maintains is a list someone forgets, and a declaration shows up in a diff where
   * a reviewer will argue with it. It is deliberately narrow — the superseded file's hash is
   * still recorded, so editing an applied migration is refused exactly as before, and a
   * database that DID apply the file is untouched. It must be named by a LATER file, which
   * is checked, because "this earlier thing is dead" is the only claim it can make.
   */
  readonly supersedes: readonly string[];
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  /**
   * Files recorded without being run, because a later migration declares
   * `-- @supersedes:` for them. Reported separately from `skipped` — which means "already
   * applied" — because this is the one path on which the database never executed a file the
   * repository contains, and that is not something to learn from reading the source.
   */
  readonly superseded: readonly string[];
}

const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Loads migrations in lexical order, which is numeric order given the mandated
 * `NNNN_name.sql` shape. A file that does not match is an error rather than a
 * silent skip — a typo'd migration that never runs is worse than a failed boot.
 */
export async function loadMigrations(dir: string): Promise<readonly Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const bad = entries.filter((f) => !MIGRATION_RE.test(f));
  if (bad.length > 0) {
    throw new Error(`migration filenames must match NNNN_name.sql: ${bad.join(", ")}`);
  }
  return Promise.all(
    entries.map(async (filename) => {
      const sql = await readFile(join(dir, filename), "utf8");
      return {
        filename,
        sql,
        sha256: sha256(sql),
        requiresDba: /^--\s*@requires:\s*dba\s*$/m.test(sql),
        supersedes: [...sql.matchAll(/^--\s*@supersedes:\s*(\S+)\s*$/gm)].map((m) => m[1] as string),
      };
    }),
  );
}

export class MigrationChangedError extends Error {
  constructor(filename: string, expected: string, actual: string) {
    super(
      `migration ${filename} changed after it was applied ` +
        `(recorded ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}…). ` +
        `Write a new migration instead of editing an applied one.`,
    );
    this.name = "MigrationChangedError";
  }
}

/**
 * Applies pending migrations in order, each in its own transaction, recording
 * the file's hash in `crm._migrations`.
 *
 * An already-applied file whose content has changed is a hard error. Silently
 * re-running it would be wrong (it is not idempotent in general) and silently
 * skipping it would leave the database disagreeing with the repository — so the
 * only safe move is to refuse and make someone write a new migration.
 *
 * Only applies the files it is given. The caller separates DBA from application
 * migrations (see `Migration.requiresDba`) and runs this for the application
 * ones, under the application role.
 */
export class SupersedeDeclarationError extends Error {
  constructor(detail: string) {
    super(`invalid @supersedes declaration: ${detail}`);
    this.name = "SupersedeDeclarationError";
  }
}

/**
 * The set of files a later migration has declared dead, validated.
 *
 * Computed over EVERY loaded migration before the loop starts, which is what makes the
 * mechanism work at all: the declaration lives in a file numbered after the one it retires,
 * so by the time the loop reaches the dead file the runner has to already know. Refuses two
 * things rather than ignoring them, because both are silent otherwise — a name that matches
 * no file (a typo, so the dead file still runs and still fails), and a name that does not
 * sort before the declaring file (which would let a migration retire something that has not
 * happened yet, or itself).
 */
export function supersededFiles(migrations: readonly Migration[]): Map<string, string> {
  const names = new Set(migrations.map((m) => m.filename));
  const dead = new Map<string, string>();
  for (const m of migrations) {
    for (const target of m.supersedes) {
      if (!names.has(target)) {
        throw new SupersedeDeclarationError(`${m.filename} names ${target}, which is not a migration`);
      }
      if (target >= m.filename) {
        throw new SupersedeDeclarationError(
          `${m.filename} names ${target}, which does not come before it — a migration can only retire an earlier one`,
        );
      }
      dead.set(target, m.filename);
    }
  }
  return dead;
}

export async function applyMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const superseded: string[] = [];
  const dead = supersededFiles(migrations);

  const { rows } = await client.query<{ filename: string; sha256: string }>(
    "SELECT filename, sha256 FROM crm._migrations",
  );
  const seen = new Map(rows.map((r) => [r.filename, r.sha256]));

  for (const m of migrations) {
    const recorded = seen.get(m.filename);
    if (recorded !== undefined) {
      if (recorded !== m.sha256) throw new MigrationChangedError(m.filename, recorded, m.sha256);
      skipped.push(m.filename);
      continue;
    }
    const retiredBy = dead.get(m.filename);
    if (retiredBy !== undefined) {
      // RECORDED, NOT RUN — and the hash is the real one, so the "edited after it was
      // applied" refusal keeps working on this file exactly as on every other. A database
      // that already ran it took the branch above and never reaches here.
      await client.query("INSERT INTO crm._migrations (filename, sha256) VALUES ($1, $2)", [
        m.filename,
        m.sha256,
      ]);
      superseded.push(`${m.filename} (by ${retiredBy})`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(m.sql);
      await client.query("INSERT INTO crm._migrations (filename, sha256) VALUES ($1, $2)", [
        m.filename,
        m.sha256,
      ]);
      await client.query("COMMIT");
      applied.push(m.filename);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.filename} failed: ${String(err)}`, { cause: err });
    }
  }
  return { applied, skipped, superseded };
}
