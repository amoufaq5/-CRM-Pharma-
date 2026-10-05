#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ErpClient, type FetchLike, type TenantCredential } from "../client.js";
import { generateTypes } from "../codegen.js";
import { UiSchemaSchema } from "../ui-schema.js";

/**
 * Regenerates `src/generated/erp.ts` from a live `GET /v1/meta/schema`.
 *
 *   pnpm erp:codegen                     # write, from ERP_BASE_URL + ERP_TENANT_ID
 *   pnpm erp:codegen --check             # fail if the file is stale (CI)
 *   pnpm erp:codegen --from schema.json  # from a saved payload, no server needed
 *
 * `--check` is the drift gate ADR-0001 item 4 promises: the ERP has no CI of its
 * own, so a schema change lands there unannounced and the first we would hear of
 * it is a filter quietly returning the wrong rows in production.
 */
// Runs from dist/bin/, writes into src/generated/ — the generated module is
// source, committed and reviewed like any other file, not a build artifact.
const OUT = resolve(dirname(new URL(import.meta.url).pathname), "../../src/generated/erp.ts");

async function loadSchema(argv: readonly string[]): Promise<{ schema: unknown; source: string }> {
  const fromIdx = argv.indexOf("--from");
  if (fromIdx !== -1) {
    const path = argv[fromIdx + 1];
    if (path === undefined) throw new Error("--from needs a file path");
    return { schema: JSON.parse(await readFile(path, "utf8")), source: path };
  }

  const baseUrl = process.env["ERP_BASE_URL"];
  const tenantId = process.env["ERP_TENANT_ID"];
  const token = process.env["ERP_TOKEN"];
  if (baseUrl === undefined || tenantId === undefined || token === undefined) {
    throw new Error(
      "set ERP_BASE_URL, ERP_TENANT_ID and ERP_TOKEN, or pass --from <schema.json>",
    );
  }
  const credential: TenantCredential = { token: () => Promise.resolve(token) };
  const client = new ErpClient({
    baseUrl,
    credential,
    fetch: globalThis.fetch as unknown as FetchLike,
  });
  const tenantSchema = await client.schema(tenantId);
  return { schema: tenantSchema.schema, source: `${baseUrl} tenant ${tenantId}` };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");

  const { schema, source } = await loadSchema(argv);
  const result = generateTypes(UiSchemaSchema.parse(schema), { source });

  if (check) {
    const existing = await readFile(OUT, "utf8").catch(() => null);
    if (existing === result.source) {
      console.log(`erp codegen: up to date (${result.entityCount} entities, ${result.schemaSha256.slice(0, 12)}…)`);
      return 0;
    }
    if (existing === null) {
      console.error(`erp codegen: ${OUT} is missing — run \`pnpm erp:codegen\``);
      return 1;
    }
    const committed = /SCHEMA_SHA256 = "([0-9a-f]+)"/.exec(existing)?.[1] ?? null;
    if (committed === result.schemaSha256) {
      // Same input, different output. That is the GENERATOR having changed, not the ERP —
      // a different thing to be told, and the old message printed two identical hashes
      // under the heading "the served schema no longer matches", which sent a reader
      // looking for a schema change that had not happened.
      console.error(
        `erp codegen: STALE. The schema is unchanged (${result.schemaSha256.slice(0, 12)}…) but the\n` +
          `committed file is not what this generator now emits. The generator changed; run\n` +
          `\`pnpm erp:codegen:baseline\` and commit the regenerated file.`,
      );
      return 1;
    }
    console.error(
      `erp codegen: DRIFT. The served schema no longer matches the committed types.\n` +
        `  committed: ${committed?.slice(0, 12) ?? "unknown"}…\n` +
        `  served:    ${result.schemaSha256.slice(0, 12)}…\n` +
        `Run \`pnpm erp:codegen\` and review the diff — a field that stopped being\n` +
        `filterable is the dangerous case: the ERP ignores such a filter silently,\n` +
        `so every query relying on it starts returning MORE rows than asked for.`,
    );
    return 1;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, result.source, "utf8");
  console.log(`erp codegen: wrote ${OUT} (${result.entityCount} entities, ${result.schemaSha256.slice(0, 12)}…)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`erp codegen failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
