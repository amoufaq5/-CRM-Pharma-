#!/usr/bin/env node
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";

import { applyMigrations, loadMigrations, supersededFiles, type Migration } from "../migrate.js";

/**
 * Applies the CRM's schema.
 *
 *   crm-migrate            apply what is pending
 *   crm-migrate --dry-run  report what would be applied, change nothing
 *
 * Connects ONCE, as the admin identity (PGUSER), and runs the two phases with
 * different privileges:
 *
 *   1. DBA migrations, as the admin. Every deploy, because the ledger that would
 *      track them is created by one of them — so they must be idempotent, and
 *      the runner says so loudly if one fails.
 *   2. Application migrations, after `SET ROLE crm_app`. Hash-gated: applied
 *      once each, and an edited file that was already applied is refused rather
 *      than silently re-run or silently skipped.
 *
 * The SET ROLE matters more than it looks. Running application migrations as the
 * admin would leave every table owned by it, and a table's OWNER BYPASSES
 * row-level security — so the tenant isolation this whole design rests on would
 * be decoration. That exact bug happened once already (migration 0010), which is
 * why the runner does it rather than trusting a deploy script to remember.
 */
const MIGRATIONS_DIR = process.env["MIGRATIONS_DIR"] ?? resolve(process.cwd(), "db/migrations");
const APP_ROLE = process.env["CRM_APP_ROLE"] ?? "crm_app";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  if (!ROLE_RE.test(APP_ROLE)) throw new Error(`invalid CRM_APP_ROLE: ${APP_ROLE}`);

  const all = await loadMigrations(MIGRATIONS_DIR);
  const dba = all.filter((m) => m.requiresDba);
  const app = all.filter((m) => !m.requiresDba);
  log({ type: "loaded", dir: MIGRATIONS_DIR, total: all.length, dba: dba.length, app: app.length });

  if (dba.length === 0) {
    // Without 0001/0002 there is no crm schema, no ledger and no app role, so
    // every later step would fail with a confusing error instead of this one.
    throw new Error(
      `no DBA migrations found in ${MIGRATIONS_DIR}. At least one file must declare "-- @requires: dba".`,
    );
  }

  const pool = new Pool({
    host: env("PGHOST", "/var/run/postgresql"),
    database: env("PGDATABASE"),
    user: env("PGUSER"),
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 1,
  });

  const client = await pool.connect();
  try {
    if (dryRun) return await reportPending(client, dba, app);

    // ---- phase 1: DBA, idempotent, every deploy --------------------------
    for (const m of dba) {
      try {
        await client.query(m.sql);
        log({ type: "dba_applied", filename: m.filename });
      } catch (err) {
        throw new Error(
          `DBA migration ${m.filename} failed. These run on EVERY deploy and must be ` +
            `idempotent — use CREATE ... IF NOT EXISTS, CREATE OR REPLACE, or a DO block ` +
            `that swallows duplicate_object. Cause: ${String(err)}`,
          { cause: err },
        );
      }
    }

    // The application role needs a password to connect from the app containers.
    // Set here rather than in 0001 so the secret never enters a committed file.
    const appPassword = process.env["CRM_APP_PASSWORD"];
    if (appPassword !== undefined && appPassword !== "") {
      // ALTER ROLE is a utility command and does not accept a bind parameter, so
      // the literal has to be inlined. `escapeLiteral` is node-postgres's own
      // escaper — hand-rolled quote doubling here would be exactly the kind of
      // shortcut that turns a password containing a quote into a SQL injection.
      await client.query(`ALTER ROLE ${APP_ROLE} WITH PASSWORD ${client.escapeLiteral(appPassword)}`);
      log({ type: "app_role_password_set", role: APP_ROLE });
    } else {
      log({
        type: "warning",
        detail: `CRM_APP_PASSWORD is not set, so ${APP_ROLE} keeps whatever password it had. ` +
          `The api and scheduler containers cannot connect without one.`,
      });
    }

    // ---- phase 2: application migrations, as the app role ----------------
    // SET ROLE, not a second connection: the admin must remain able to grant,
    // and a role switch on one connection is simpler to reason about than two
    // identities racing.
    await client.query(`SET ROLE ${APP_ROLE}`);
    const result = await applyMigrations(client, app);
    await client.query("RESET ROLE");

    for (const filename of result.applied) log({ type: "applied", filename });
    // A warning and not an `info`, deliberately: a file the repository contains and the
    // database never executed is something an operator should have to read past, once per
    // deploy, rather than something they could only learn by reading the migration source.
    for (const detail of result.superseded) {
      log({ type: "warning", detail: `recorded WITHOUT running: ${detail}` });
    }
    log({
      type: "done",
      dbaApplied: dba.length,
      applied: result.applied.length,
      alreadyApplied: result.skipped.length,
      superseded: result.superseded.length,
    });
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

/** Reports what a real run would do, touching nothing. */
async function reportPending(
  client: PoolClient,
  dba: readonly Migration[],
  app: readonly Migration[],
): Promise<number> {
  let recorded = new Map<string, string>();
  try {
    const { rows } = await client.query<{ filename: string; sha256: string }>(
      "SELECT filename, sha256 FROM crm._migrations",
    );
    recorded = new Map(rows.map((r) => [r.filename, r.sha256]));
  } catch {
    // No ledger yet: this is a first deploy, so everything is pending.
    log({ type: "no_ledger", detail: "crm._migrations does not exist — this would be a first deploy" });
  }

  for (const m of dba) log({ type: "would_apply_dba", filename: m.filename, note: "runs every deploy" });

  // Validated here too, so `--dry-run` refuses a bad declaration rather than reporting a
  // plan the real run will reject.
  const dead = supersededFiles(app);

  let pending = 0;
  let changed = 0;
  let superseded = 0;
  for (const m of app) {
    const was = recorded.get(m.filename);
    const retiredBy = dead.get(m.filename);
    if (was === undefined && retiredBy !== undefined) {
      log({ type: "would_record_without_running", filename: m.filename, detail: `superseded by ${retiredBy}` });
      superseded += 1;
    } else if (was === undefined) {
      log({ type: "would_apply", filename: m.filename });
      pending += 1;
    } else if (was !== m.sha256) {
      // Worth reporting rather than discovering mid-deploy.
      log({ type: "CHANGED_AFTER_APPLY", filename: m.filename, detail: "a real run would REFUSE this" });
      changed += 1;
    }
  }
  log({ type: "dry_run_done", pending, superseded, changedAfterApply: changed });
  return changed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: "failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  },
);
