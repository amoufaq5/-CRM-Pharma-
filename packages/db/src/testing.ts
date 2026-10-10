import { readdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { Pool, type PoolClient } from "pg";

/**
 * The FIXTURE connection. Connects as the admin role.
 *
 * Contract tests need a REAL Postgres: RLS, ownership and type coercion cannot be
 * asserted against a fake, and every finding these tests encode was found by running
 * SQL rather than by reading it. CI provides a service container; locally, point PG* at
 * any throwaway cluster.
 *
 * A test takes ONE client from here and immediately `SET ROLE crm_app`, which is what
 * makes RLS apply to it — a superuser bypasses the policy even under `FORCE`. Use this
 * for setting up and tearing down rows, and for the few assertions that need to look at
 * the catalog or prove the bypass itself.
 *
 * Do NOT hand this pool to code under test that connects its own clients: it would take
 * fresh superuser connections with no `SET ROLE`, and nothing it does would be subject
 * to a policy. Use `appPool()` for that. See the comment there — this distinction cost
 * a real cross-tenant write before it was drawn.
 */
export function testPool(): Pool {
  return new Pool({ ...connection(), max: 4 });
}

/**
 * The APPLICATION connection. Connects as `crm_app`, exactly as the deployed API and
 * scheduler do (`deploy/README.md`, "Two database identities").
 *
 * This is the pool to hand to anything under test that connects clients of its own —
 * `startApi`, `Scheduler`, `OutboxRelay`, `SnapshotRefresher`. Those open their own
 * connections and set only the tenant GUC, so the ROLE they inherit from the pool is
 * the one their queries run under.
 *
 * It exists because the API contract suite used to hand them the admin pool. Every
 * route in it therefore ran as a superuser, so row-level security was switched off for
 * the entire suite and no test could have caught a missing tenant predicate. One was
 * missing: `crm.revoke_rep_role` matched on a grant id alone, and a rep of one tenant
 * ended a grant in another. The suite passed. Connecting as `crm_app` is what makes a
 * tenant-isolation assertion mean anything here.
 *
 * `PGAPPUSER` overrides the role for a cluster that names it differently; the password
 * is whatever the migration runner set, supplied as `PGAPPPASSWORD`. Over a unix socket
 * with local trust, neither is needed.
 */
export function appPool(): Pool {
  return new Pool({
    ...connection(),
    user: process.env["PGAPPUSER"] ?? "crm_app",
    ...(process.env["PGAPPPASSWORD"] !== undefined ? { password: process.env["PGAPPPASSWORD"] } : {}),
    max: 8,
  });
}

function connection(): {
  host: string;
  database: string;
  user: string;
  password?: string;
  port?: number;
} {
  return {
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
  };
}

/**
 * Reserved tenant ids, ONE BLOCK PER TEST FILE.
 *
 * Test files share a database and run sequentially (`fileParallelism: false`),
 * so two files using the same tenant id see each other's rows — and the failure
 * is maddening, because each file passes on its own. That has bitten three
 * times now, so the ids are handed out here rather than chosen per file:
 * a collision is visible in one place instead of being discovered at runtime.
 *
 * Adding a test file means adding a block here, not inventing a UUID.
 */
/** packages/db — rls.contract. Read-only against its own fixture table. */
export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";

/** packages/db — schema.contract. */
export const TENANT_DB_SCHEMA_A = "1a111111-1111-4111-8111-111111111111";
export const TENANT_DB_SCHEMA_B = "1b222222-2222-4222-8222-222222222222";

/** packages/db — expense.contract. */
export const TENANT_DB_EXPENSE = "1c333333-3333-4333-8333-333333333333";

/** packages/relay. */
export const TENANT_RELAY = "88888888-8888-4888-8888-888888888888";

/** packages/scheduler. */
export const TENANT_SCHEDULER_A = "99999999-9999-4999-8999-999999999991";
export const TENANT_SCHEDULER_B = "99999999-9999-4999-8999-999999999992";

/** packages/scheduler — the loop and recordResult suites. */
export const TENANT_SCHEDULER_LOOP = "33333333-3333-4333-8333-333333333333";
export const TENANT_SCHEDULER_RESULT = "44444444-4444-4444-8444-444444444444";

/** packages/territory. */
export const TENANT_TERRITORY_A = "55555555-5555-4555-8555-555555555555";
export const TENANT_TERRITORY_B = "66666666-6666-4666-8666-666666666666";

/** packages/api. */
export const TENANT_API = "8a111111-1111-4111-8111-111111111111";
export const TENANT_API_OTHER = "8b222222-2222-4222-8222-222222222222";

/** packages/visit. */
export const TENANT_VISIT = "7a111111-1111-4111-8111-111111111111";

/** packages/sync — snapshot refresh. */
export const TENANT_SYNC = "77777777-7777-4777-8777-777777777777";

/** packages/credential — role-source.contract. */
export const TENANT_CREDENTIAL_A = "9a111111-1111-4111-8111-111111111111";
export const TENANT_CREDENTIAL_B = "9b222222-2222-4222-8222-222222222222";

/** packages/credential — boot.contract. */
export const TENANT_CREDENTIAL_BOOT = "9c333333-3333-4333-8333-333333333333";

/** packages/callplan. */
export const TENANT_CALLPLAN = "ca000000-0000-4000-8000-000000000001";

/** packages/sample — custody contract. */
export const TENANT_SAMPLE = "cb000000-0000-4000-8000-000000000002";

/** packages/sample — the ERP mirror contract. */
export const TENANT_SAMPLE_MIRROR = "cc000000-0000-4000-8000-000000000003";

/** packages/territory — supervision.contract. */
export const TENANT_SUPERVISION = "da000000-0000-4000-8000-000000000001";

/** packages/sample — expiry-sweep.contract. */
export const TENANT_EXPIRY_SWEEP = "ce000000-0000-4000-8000-000000000004";

/** packages/notify — raise.contract and dispatch.contract. */
export const TENANT_NOTIFY = "cf000000-0000-4000-8000-000000000005";

/** packages/relay — dead-letters.contract. */
export const TENANT_DEAD_LETTERS = "d1000000-0000-4000-8000-000000000006";

/** packages/role — roles.contract. */
export const TENANT_ROLE = "d2000000-0000-4000-8000-000000000007";

/** packages/notify — endpoints.contract. Separate from TENANT_NOTIFY: the endpoint
 *  suite creates and disables endpoints, which the dispatch suite reads. */
export const TENANT_ENDPOINTS = "d3000000-0000-4000-8000-000000000008";

/** packages/notify — retention.contract. */
export const TENANT_RETENTION = "d4000000-0000-4000-8000-000000000009";

/** packages/sample — recall.contract. */
export const TENANT_RECALL = "d6000000-0000-4000-8000-00000000000a";

/** packages/notify — prune-guard.contract. */
export const TENANT_PRUNE_GUARD = "d7000000-0000-4000-8000-00000000000b";

/** packages/relay — sequence.contract. */
export const TENANT_OUTBOX_SEQ = "d8000000-0000-4000-8000-00000000000c";

/** packages/expense — accounts.contract. */
export const TENANT_EXPENSE_MAP = "d9000000-0000-4000-8000-00000000000d";

/** packages/expense — store.contract. */
export const TENANT_EXPENSE_STORE = "da100000-0000-4000-8000-00000000000e";

/** packages/sample — disposal-reopen.contract. */
export const TENANT_DISPOSAL_REOPEN = "db100000-0000-4000-8000-00000000000f";

/** packages/expense — sweeper.contract. */
export const TENANT_EXPENSE_SWEEP = "dc100000-0000-4000-8000-000000000010";

/** packages/storage — attachment.contract. */
export const TENANT_STORAGE = "dd100000-0000-4000-8000-000000000011";

/** packages/storage — a second tenant, for the cross-tenant blob-reach test. */
export const TENANT_STORAGE_OTHER = "de100000-0000-4000-8000-000000000012";

/** packages/notify — channel-coverage.contract and probe.contract. */
export const TENANT_CHANNEL_COVERAGE = "df100000-0000-4000-8000-000000000013";

/** db/migrations — composite-fk.contract, the tenant that must NOT be reachable. */
export const TENANT_FK_A = "e0100000-0000-4000-8000-000000000014";
export const TENANT_FK_B = "e1100000-0000-4000-8000-000000000015";

/** packages/sample — disposal ordering under one transaction. */
export const TENANT_DISPOSAL_SEQ = "e2100000-0000-4000-8000-000000000016";

/** scripts/live-erp — the live handshake against a running operate-server. */
export const TENANT_LIVE_ERP = "e3100000-0000-4000-8000-000000000017";

/** packages/relay — the dead-letter attempt history. */
export const TENANT_ATTEMPT_HISTORY = "e4100000-0000-4000-8000-000000000018";

/** packages/relay — the outbox store's settle guards. */
export const TENANT_RELAY_STORE = "e5100000-0000-4000-8000-000000000019";

/**
 * packages/expense — lifecycle.contract (migration 0044).
 *
 * The id is derived from the migration number rather than continued from the sequence
 * above: four agents were adding files at once, and "the next one" is not a safe guess for
 * any of them.
 */
export const TENANT_EXPENSE_LIFECYCLE = "e6440000-0000-4000-8000-00000000001a";

/** packages/notify — delivery retention, and the tenant it must not reach (0046). */
export const TENANT_DELIVERY_RETENTION = "e7100000-0000-4000-8000-00000000001a";
export const TENANT_DELIVERY_RETENTION_OTHER = "e8100000-0000-4000-8000-00000000001b";

/**
 * packages/notify — endpoint-rules.contract (migration 0049).
 *
 * Derived from the migration number, as 0044's is, and separate from `TENANT_ENDPOINTS`
 * because this suite's whole subject is UPDATEs that must be refused: a failed statement
 * aborts the transaction, and sharing a tenant with a suite that reads endpoints back
 * would make one file's refusals the other file's missing rows.
 */
export const TENANT_ENDPOINT_RULES = "e9490000-0000-4000-8000-00000000001c";

/**
 * packages/sync — tenant-deletion.contract (migration 0050).
 *
 * Two, and they are not interchangeable: this suite MARKS a tenant `erp_deleted`, which 0050
 * makes terminal, so the tenant it stops can never be reused by a later test in the same
 * database. The second is the one that must stay alive, to prove the mark is per tenant.
 */
export const TENANT_DELETION_STOPPED = "ea500000-0000-4000-8000-00000000001d";
export const TENANT_DELETION_LIVE = "eb500000-0000-4000-8000-00000000001e";

/**
 * packages/erasure — plan.contract (migration 0051).
 *
 * Marked `erp_deleted` by that suite, which 0050 makes terminal, so it is its own tenant and
 * never shared. The live one beside it proves the plan is per tenant.
 */
export const TENANT_ERASURE_STOPPED = "ec510000-0000-4000-8000-00000000001f";
export const TENANT_ERASURE_LIVE = "ed510000-0000-4000-8000-000000000020";

/**
 * packages/erasure — execute.contract (migration 0052).
 *
 * Its own tenant, never shared: this suite really deletes rows, and `erp_deleted` is terminal.
 * The second one stays alive so every assertion that the erasure is per tenant means something.
 */
export const TENANT_ERASE_EXEC = "ee520000-0000-4000-8000-000000000021";
export const TENANT_ERASE_BYSTANDER = "ef520000-0000-4000-8000-000000000022";

/**
 * packages/sample — incoming.contract (migration 0055).
 *
 * Its own tenant because the peer list is tenant-wide by design: a suite sharing a tenant
 * with another would see that suite's reps appear in the picker and the count assertions
 * would drift with whatever else was seeded.
 */
export const TENANT_INCOMING = "f0550000-0000-4000-8000-000000000023";

/**
 * packages/sample — disposal-policy.contract (migration 0059).
 *
 * Its own tenant because this suite's whole subject is the tenant-wide SOP parameters: a
 * suite sharing a tenant would have its grace period changed underneath it, and the
 * sweep suites assert on deadlines computed from exactly that number.
 */
export const TENANT_DISPOSAL_POLICY = "f0590000-0000-4000-8000-000000000026";

/**
 * packages/sample — warehouses.contract (migration 0058).
 *
 * Two, and the second is the subject of a test rather than a spare: `requireActiveWarehouse`
 * answers differently when a tenant's warehouse list is EMPTY (the snapshot has never
 * synced, so nothing can be validated and the refusal is a 503) from when the list exists
 * and the id is simply not in it (422). Proving that needs a tenant whose snapshot stays
 * empty for the whole run, which no suite seeding warehouses can also be.
 */
export const TENANT_WAREHOUSE = "f0580000-0000-4000-8000-000000000024";
export const TENANT_WAREHOUSE_UNSYNCED = "f1580000-0000-4000-8000-000000000025";

/**
 * A rep to attribute a fixture's notification endpoint to.
 *
 * 0060 refuses an endpoint that names nobody, because adding one opens a route out of the
 * tenant for records carrying a rep's name. Four suites need an endpoint to exist and none
 * of them is ABOUT authorship — the dispatcher's, the probe's, the channel-coverage check's
 * and the retention sweep's — so the one upsert lives here rather than as four slightly
 * different copies, each of which would have to seed a profile in whichever tenants it uses.
 *
 * Idempotent on `(tenant_id, subject)`, so a `beforeEach` that wipes endpoints and leaves
 * profiles alone can call it every time. It is deliberately NOT a suite's main rep: a
 * fixture author with its own subject cannot be mistaken for one of the people a test is
 * actually about.
 */
export async function endpointAuthor(tx: PoolClient, tenantId: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name, status)
     VALUES ($1, 'fixture-endpoint-author', 'FIXTURE-EP', 'A Fixture Administrator', 'active')
     ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [tenantId],
  );
  return rows[0]!.id;
}

/**
 * Wipes a tenant's notification endpoints, and the amendment log that pins them.
 *
 * Two statements and a disabled trigger, which is the shape of a fixture undoing a
 * guarantee rather than working around one. 0060's log references the endpoint `ON DELETE
 * RESTRICT` — the convention for an audit child in this schema — and refuses a DELETE on
 * itself, so wiping endpoints means retiring the history first and saying so. A tenant
 * erasure does not need this: `eraseOrder` derives children-before-parents from the live
 * foreign-key graph, so it removes the log and then the endpoints with the triggers on.
 *
 * Shared because seven suites wipe endpoints and seven copies of a trigger-disable is how
 * one of them ends up missing the re-enable.
 */
export async function wipeEndpoints(tx: PoolClient, tenantId: string): Promise<void> {
  await tx.query("ALTER TABLE crm.notification_endpoint_change DISABLE TRIGGER USER");
  try {
    await tx.query("DELETE FROM crm.notification_endpoint_change WHERE tenant_id = $1", [tenantId]);
  } finally {
    await tx.query("ALTER TABLE crm.notification_endpoint_change ENABLE TRIGGER USER");
  }
  await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [tenantId]);
}

/**
 * Runs `fn` with `crm.tenant`'s protective triggers off, for test cleanup only.
 *
 * Migration 0053 made a stopped tenant's registry row undeletable, because deleting it
 * un-stopped the tenant (the API serves an unlisted tenant by design) and orphaned its
 * erasure receipt. That is a guarantee, so the only legitimate way around it is a fixture
 * handing back a tenant id it borrowed — and the only honest way to do that is to turn the
 * guarantee off explicitly, here, where it is named and commented, rather than for a test to
 * quietly find a statement that works.
 *
 * Shared because four suites need it and four copies of a trigger-disable is how one of them
 * ends up missing the re-enable. `crm_app` owns the table, so it may do this; the `finally`
 * puts both triggers back even when `fn` throws.
 *
 * A suite that asserts the REFUSAL must not use this — see `tenant-deletion.contract.test.ts`,
 * which tests the delete is refused with the triggers on and only then cleans up with them off.
 */
export async function withRegistryTriggersOff<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("ALTER TABLE crm.tenant DISABLE TRIGGER tenant_erp_deleted_is_terminal");
  try {
    return await fn();
  } finally {
    await client.query("ALTER TABLE crm.tenant ENABLE TRIGGER tenant_erp_deleted_is_terminal");
  }
}

/**
 * Grep the repository, in Node, because `rg` is not everywhere.
 *
 * Two coverage suites derived their claim by shelling out to ripgrep —
 * every `src` file of every package for every `subjectTable` argument, `db/migrations`
 * for every `CREATE TABLE crm.attachment`. Both worked on the machine they were written
 * on and neither works on a GitHub runner, which has no ripgrep: `spawnSync rg ENOENT`.
 * That is
 * the fixture-kinder-than-reality failure in its purest form — a test whose verdict
 * depends on a binary nobody declared — and it was one of the two reasons CI stayed red
 * for 33 consecutive runs.
 *
 * The name above is written without its colon on purpose: the notify suite greps for
 * that exact token in non-test source, and this file is non-test source. It found this
 * very comment, which is the test working.
 *
 * Installing ripgrep in the workflow would have fixed the symptom. This removes the
 * dependency: a directory walk and a RegExp, output in ripgrep's `path:line:text` shape
 * so the call sites parse it unchanged.
 *
 * IT THROWS ON ZERO MATCHES, and that is deliberate rather than tidy. `rg` exits 1 when
 * it finds nothing, which made `execFileSync` throw — so a scan that found nothing failed
 * the test. A Node implementation returning `[]` would instead hand a coverage test an
 * empty producer set, which it would pass vacuously: the single worst outcome available
 * here, worse than ENOENT, because it is green. Scanning zero files throws for the same
 * reason, and names the root it was given.
 */
export function grepRepo(opts: {
  readonly root: string;
  readonly dir: string;
  readonly pattern: RegExp;
  readonly include?: (relativePath: string) => boolean;
}): readonly string[] {
  const { root, dir, pattern } = opts;
  const include = opts.include ?? ((): boolean => true);
  const skip = new Set(["node_modules", ".git", "dist", "coverage"]);
  const hits: string[] = [];
  let scanned = 0;

  const walk = (relative: string): void => {
    const entries = readdirSync(resolvePath(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(rel);
        continue;
      }
      if (!entry.isFile() || !include(rel)) continue;
      scanned += 1;
      const lines = readFileSync(resolvePath(root, rel), "utf8").split("\n");
      lines.forEach((text, i) => {
        // A fresh lastIndex per line: a /g pattern from a caller would otherwise skip
        // lines depending on where the previous match ended.
        pattern.lastIndex = 0;
        if (pattern.test(text)) hits.push(`${rel}:${i + 1}:${text}`);
      });
    }
  };

  // "." is the repository root, and it must not become a "./" prefix on every path:
  // ripgrep printed one, these call sites do not want one, and a caller matching on
  // `rel === "package.json"` would silently see nothing. Normalised here rather than at
  // each site.
  walk(dir === "." ? "" : dir);
  if (scanned === 0) {
    throw new Error(`grepRepo scanned no files under ${root}/${dir} — wrong root, or an include() that matches nothing`);
  }
  if (hits.length === 0) {
    throw new Error(
      `grepRepo found no match for ${String(pattern)} in ${scanned} file(s) under ${root}/${dir} — ` +
        `ripgrep exited 1 here and failed the test, and so does this`,
    );
  }
  return hits;
}
