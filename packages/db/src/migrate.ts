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
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
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
      return { filename, sql, sha256: sha256(sql), requiresDba: /^--\s*@requires:\s*dba\s*$/m.test(sql) };
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
export async function applyMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

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
  return { applied, skipped };
}
