#!/usr/bin/env node
import { Pool } from "pg";

import { ErasureRefusedError, executeTenantErasure, readTenantTombstones } from "../execute.js";
import { RETENTION_OBLIGATIONS } from "../obligations.js";
import { describeRefusal, planTenantErasure, type ErasurePlan } from "../plan.js";
import { verifyTombstone } from "../tombstone.js";

/**
 * What this CRM would do with a deleted tenant's data, and what it still has to be told.
 *
 *   crm-erasure plan <tenant-uuid> [--json]   the per-table plan, or the refusals
 *   crm-erasure execute <tenant-uuid> …       perform it, and write the receipt
 *   crm-erasure receipts <tenant-uuid>        the receipts, with their hashes re-verified
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
 * `execute` IS THE ONLY THING IN THIS REPOSITORY THAT DESTROYS DATA ON PURPOSE, and it is
 * gated accordingly: it refuses unless the plan is actionable (which requires the ERP to have
 * deleted the tenant and every table to have a decision), it requires `--executed-by` and
 * `--approved-by` to differ, and it requires `--yes-destroy-data` typed out. Three gates, and
 * the register's 19 undecided tables mean the first one refuses today — which is correct, not
 * a limitation: ADR-0317 is exact that "a proof over a scope assembled from nothing is a
 * correct proof of a false claim", and a deletion run against a half-answered register is the
 * same mistake with real rows behind it.
 *
 * `--executed-by` is a flag rather than the OS user, deliberately. On a shared operations box
 * the OS user is whoever last logged in, which is not an accountable identity; a flag makes the
 * name a deliberate claim that goes into the receipt's proof hash.
 */

const USAGE = `crm-erasure — the retention disposition register (migration 0051)

  crm-erasure plan <tenant-uuid> [--json]   what would happen to that tenant's rows
  crm-erasure execute <tenant-uuid> --executed-by <who> --approved-by <who> --yes-destroy-data
                                            perform it, and write the receipt
  crm-erasure receipts <tenant-uuid> [--json]  the receipts, with both hashes re-verified
  crm-erasure questions [--json]            the tables nobody has decided about, with the question
  crm-erasure obligations                   the retention-obligation vocabulary

Reads PGHOST/PGDATABASE/PGUSER/PGPASSWORD like every other binary here. Needs the crm_app role.
Only the execute subcommand destroys anything, and only when the plan says it may.`;

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

      if (command === "receipts") {
        const tenantId = argv[1] ?? "";
        if (!UUID_RE.test(tenantId)) {
          process.stderr.write("crm-erasure receipts needs a tenant uuid\n");
          return 2;
        }
        const receipts = await readTenantTombstones(client, tenantId);
        // Re-verified on the way out, every time, because a receipt nobody checks is a receipt
        // nobody can rely on — and the check is two hashes over data already in hand.
        const checked = receipts.map((t) => ({ ...t, problems: verifyTombstone(t) }));
        if (json) {
          process.stdout.write(`${JSON.stringify(checked, null, 2)}\n`);
        } else if (checked.length === 0) {
          process.stdout.write(`no CRM erasure receipts for ${tenantId}\n`);
        } else {
          for (const t of checked) {
            process.stdout.write(
              `${t.id}  ${t.deletedAt}\n` +
                `  under ERP tombstone ${t.erpTombstoneId}\n` +
                `  ${String(t.rowsErased)} rows erased, ${String(t.rowsRetained)} retained, ` +
                `${String(t.attestations.length)} tables attested\n` +
                `  executed by ${t.executedBy}, approved by ${t.approvedBy}\n` +
                `  manifest ${t.contentManifestSha256}\n  proof    ${t.proofSha256}\n` +
                `  ${t.problems.length === 0 ? "VERIFIED: both hashes recompute" : `FAILED: ${t.problems.join("; ")}`}\n\n`,
            );
          }
        }
        return checked.every((t) => t.problems.length === 0) ? 0 : 1;
      }

      if (command === "execute") {
        const tenantId = argv[1] ?? "";
        if (!UUID_RE.test(tenantId)) {
          process.stderr.write("crm-erasure execute needs a tenant uuid\n");
          return 2;
        }
        const flag = (name: string): string | undefined => {
          const i = argv.indexOf(`--${name}`);
          if (i >= 0) return argv[i + 1];
          const eq = argv.find((a) => a.startsWith(`--${name}=`));
          return eq === undefined ? undefined : eq.slice(name.length + 3);
        };
        const executedBy = flag("executed-by");
        const approvedBy = flag("approved-by");
        if (executedBy === undefined || approvedBy === undefined) {
          process.stderr.write(
            "crm-erasure execute needs --executed-by <who> and --approved-by <who>: this is the one " +
              "operation here that destroys data on purpose, and it is not one person's to perform and approve\n",
          );
          return 2;
        }
        if (executedBy === approvedBy) {
          process.stderr.write(`four-eyes: --executed-by and --approved-by are both ${executedBy}\n`);
          return 2;
        }
        if (!argv.includes("--yes-destroy-data")) {
          process.stderr.write(
            "crm-erasure execute needs --yes-destroy-data. Run `crm-erasure plan` first and read it.\n",
          );
          return 2;
        }

        try {
          const { tombstone, eraseOrder } = await executeTenantErasure(client, tenantId, {
            executedBy,
            approvedBy,
          });
          const problems = verifyTombstone(tombstone);
          if (json) {
            process.stdout.write(`${JSON.stringify({ tombstone, eraseOrder, problems }, null, 2)}\n`);
          } else {
            process.stdout.write(
              `ERASED tenant ${tenantId}\n\n` +
                `  receipt   ${tombstone.id}\n` +
                `  under     ERP tombstone ${tombstone.erpTombstoneId}\n` +
                `  destroyed ${String(tombstone.rowsErased)} rows\n` +
                `  retained  ${String(tombstone.rowsRetained)} rows\n` +
                `  attested  ${String(tombstone.attestations.length)} tables\n` +
                `  manifest  ${tombstone.contentManifestSha256}\n` +
                `  proof     ${tombstone.proofSha256}\n` +
                `  order     ${eraseOrder.join(" -> ")}\n\n` +
                `${problems.length === 0 ? "VERIFIED: both hashes recompute over what was written." : `FAILED: ${problems.join("; ")}`}\n`,
            );
          }
          return problems.length === 0 ? 0 : 1;
        } catch (err) {
          if (err instanceof ErasureRefusedError) {
            process.stderr.write(`REFUSED — nothing was deleted.\n\n`);
            for (const r of err.plan.refusals) process.stderr.write(`  - ${describeRefusal(r)}\n`);
            return 1;
          }
          throw err;
        }
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
