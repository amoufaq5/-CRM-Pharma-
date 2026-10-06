#!/usr/bin/env node
import { Pool } from "pg";

import { RETENTION_OBLIGATIONS } from "../obligations.js";
import { describeRefusal, planTenantErasure, type ErasurePlan } from "../plan.js";

/**
 * What this CRM would do with a deleted tenant's data, and what it still has to be told.
 *
 *   crm-erasure plan <tenant-uuid> [--json]   the per-table plan, or the refusals
 *   crm-erasure questions [--json]            every undecided table and its question
 *   crm-erasure obligations                   the retention vocabulary
 *
 * A CLI RATHER THAN A ROUTE, and the reason is a tension migration 0050 created on purpose:
 * once a tenant is marked `erp_deleted`, `resolvePrincipal` refuses every request for it, so
 * the tenant's own API is exactly the surface that cannot answer questions about its data.
 * That is correct — a rep of a deleted tenant must not be served — and it means this is a
 * platform-operator act, performed with a database credential by somebody who can already read
 * the schema, in the shape `crm-service-key` established for the other operator-only job.
 *
 * It does not erase anything. There is no `execute` here yet, and `plan` is the honest limit
 * of what can be offered while 19 of 39 tables are declared `undecided`: CrossEngin's ADR-0317
 * is exact that "a proof over a scope assembled from nothing is a correct proof of a false
 * claim", and a deletion run against an incomplete register would be the same mistake with
 * real rows behind it.
 */

const USAGE = `crm-erasure — the retention disposition register (migration 0051)

  crm-erasure plan <tenant-uuid> [--json]   what would happen to that tenant's rows
  crm-erasure questions [--json]            the tables nobody has decided about, with the question
  crm-erasure obligations                   the retention-obligation vocabulary

Reads PGHOST/PGDATABASE/PGUSER/PGPASSWORD like every other binary here. Needs the crm_app role.
Nothing in this command destroys anything.`;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printPlan(plan: ErasurePlan): void {
  const head = plan.actionable
    ? `ACTIONABLE — tenant ${plan.tenantId} is erp_deleted (ERP tombstone ${plan.tombstoneId ?? "none recorded"})`
    : `NOT ACTIONABLE — ${String(plan.refusals.length)} thing(s) stand in the way`;
  process.stdout.write(`${head}\n\n`);

  if (plan.refusals.length > 0) {
    process.stdout.write("WHY NOT:\n");
    for (const r of plan.refusals) process.stdout.write(`  - ${describeRefusal(r)}\n`);
    process.stdout.write("\n");
  }

  const width = Math.max(
    12,
    ...[...plan.erase, ...plan.retain].map((t) => t.table.length),
  );
  if (plan.erase.length > 0) {
    process.stdout.write(`ERASE (${String(plan.eraseRows)} rows across ${String(plan.erase.length)} tables):\n`);
    for (const t of plan.erase) {
      process.stdout.write(`  ${pad(t.table, width)}  ${String(t.rows).padStart(8)}\n`);
    }
    process.stdout.write("\n");
  }
  if (plan.retain.length > 0) {
    process.stdout.write(
      `RETAIN (${String(plan.retainRows)} rows across ${String(plan.retain.length)} tables):\n`,
    );
    for (const t of plan.retain) {
      process.stdout.write(
        `  ${pad(t.table, width)}  ${String(t.rows).padStart(8)}  ${t.obligation ?? "?"}\n` +
          `  ${" ".repeat(width)}            ${t.obligationNote ?? ""}\n` +
          `  ${" ".repeat(width)}            kept at: ${t.retainedReference ?? "?"}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const undecided = plan.refusals.find((r) => r.kind === "undecided");
  if (undecided !== undefined && undecided.kind === "undecided") {
    process.stdout.write("UNDECIDED — these are not counted, because a number in front of an\n");
    process.stdout.write("undecided table invites a decision nobody has authority to make:\n");
    for (const q of undecided.questions) process.stdout.write(`  - ${q.table}\n`);
    process.stdout.write("\nRun `crm-erasure questions` for what each one needs answered.\n");
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  const json = argv.includes("--json");

  if (command === "" || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return command === "" ? 2 : 0;
  }

  if (command === "obligations") {
    if (json) process.stdout.write(`${JSON.stringify(RETENTION_OBLIGATIONS, null, 2)}\n`);
    else for (const o of RETENTION_OBLIGATIONS) process.stdout.write(`${o}\n`);
    return 0;
  }

  const pool = new Pool();
  try {
    const client = await pool.connect();
    try {
      if (command === "questions") {
        const { rows } = await client.query<{ table_name: string; question: string }>(
          "SELECT table_name, question FROM crm.undecided_dispositions()",
        );
        if (json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        } else if (rows.length === 0) {
          process.stdout.write("Every tenant-scoped table has a decided disposition.\n");
        } else {
          process.stdout.write(
            `${String(rows.length)} table(s) need a decision before any tenant's data can be erased.\n\n`,
          );
          for (const r of rows) process.stdout.write(`${r.table_name}\n  ${r.question}\n\n`);
        }
        return 0;
      }

      if (command === "plan") {
        const tenantId = argv[1] ?? "";
        if (!UUID_RE.test(tenantId)) {
          process.stderr.write("crm-erasure plan needs a tenant uuid\n");
          return 2;
        }
        const plan = await planTenantErasure(client, tenantId);
        if (json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        else printPlan(plan);
        // 0 when the plan could be acted on, 1 when something stands in the way. An operator
        // scripting this wants the exit code to mean "is this ready", and today it is not.
        return plan.actionable ? 0 : 1;
      }

      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}\n`);
      return 2;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
