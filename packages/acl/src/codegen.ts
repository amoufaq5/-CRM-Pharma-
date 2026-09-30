import { createHash } from "node:crypto";
import type { UiEntitySchema, UiFieldSchema, UiSchema } from "./ui-schema.js";

export interface CodegenResult {
  /** The generated TypeScript module. */
  readonly source: string;
  /** Content hash of the SCHEMA the types came from — the drift signal. */
  readonly schemaSha256: string;
  readonly entityCount: number;
}

/**
 * The TS type for one served field.
 *
 * Everything the ERP stores in the JSONB document comes back as whatever
 * `JSON.parse` produced, and the store does no coercion on read — so a
 * `NUMERIC` written as a string stays a string. Numeric fields are therefore
 * typed `string | number`, which is honest rather than convenient: pretending
 * they are `number` would hide the very coercion bug that makes ERP numeric
 * filters wrong (report R19) and push it into application code.
 */
function tsType(field: UiFieldSchema): string {
  if (field.enumValues !== undefined && field.enumValues.length > 0) {
    return field.enumValues.map((v) => JSON.stringify(v)).join(" | ");
  }
  switch (field.input) {
    case "boolean":
      return "boolean";
    case "number":
      return "string | number";
    case "reference":
      return "string";
    default:
      return "string";
  }
}

function comment(field: UiFieldSchema): string {
  const notes: string[] = [];
  if (field.classification !== undefined) notes.push(`classification: ${field.classification}`);
  if (field.readOnly === true) notes.push("server-generated (sequence)");
  if (field.defaulted === true) notes.push("server-defaulted on create");
  if (field.referenceTarget !== undefined) notes.push(`-> ${field.referenceTarget}`);
  if (field.unique === true) notes.push("unique");
  return notes.length > 0 ? ` // ${notes.join("; ")}` : "";
}

function entityInterface(entity: UiEntitySchema): string {
  const fields = entity.fields
    .map((f) => `  readonly ${f.name}${f.required ? "" : "?"}: ${tsType(f)};${comment(f)}`)
    .join("\n");
  return [
    `/** ${entity.singular} — ${entity.module}. Served at \`/v1/${entity.slug}\`. */`,
    `export interface ${entity.name} {`,
    "  readonly id: string;",
    fields,
    "}",
  ].join("\n");
}

function literalUnion(values: readonly string[]): string {
  return values.length === 0 ? "never" : values.map((v) => JSON.stringify(v)).join(" | ");
}

/**
 * Generates typed bindings from a tenant's served `/v1/meta/schema`.
 *
 * Generated, never hand-written, because three ERP behaviours punish guessing:
 * the pluraliser is naive (`Opportunity` -> `/v1/opportunitys`), an unknown
 * filter param is silently dropped rather than rejected, and a non-sortable
 * sort falls back to the view default without complaint. All three fail quietly
 * and in the direction of returning MORE data than asked for.
 *
 * The emitted `ERP_ENTITY_META` carries the server's own filterable, sortable
 * and searchable sets so a compile-time mistake is possible at all — and
 * `SCHEMA_SHA256` lets CI fail when the served schema moves underneath us.
 */
export function generateTypes(schema: UiSchema, opts: { source?: string } = {}): CodegenResult {
  const entities = [...schema.entities].sort((a, b) => a.name.localeCompare(b.name));

  // Hash the SHAPE, not the payload: `generatedAt` changes on every request and
  // would make every run look like drift.
  const canonical = JSON.stringify(
    entities.map((e) => ({
      name: e.name,
      slug: e.slug,
      stateField: e.stateField,
      fields: e.fields.map((f) => ({
        name: f.name,
        input: f.input,
        required: f.required,
        enumValues: f.enumValues ?? null,
        referenceTarget: f.referenceTarget ?? null,
      })),
      filterableFields: [...e.filterableFields].sort(),
      sortableFields: [...e.sortableFields].sort(),
      searchableFields: [...e.searchableFields].sort(),
      transitions: e.transitions.map((t) => ({ name: t.name, from: [...t.from].sort(), to: t.to })),
    })),
  );
  const schemaSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");

  const header = [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    `// Produced by @crm/acl codegen from GET /v1/meta/schema${opts.source !== undefined ? ` (${opts.source})` : ""}.`,
    "// Regenerate with: pnpm erp:codegen",
    "//",
    "// Hand-writing any of this is a bug waiting to happen. The ERP's pluraliser is",
    "// naive (Opportunity -> /v1/opportunitys), an unknown filter param is silently",
    "// ignored rather than rejected, and a non-sortable sort quietly falls back to the",
    "// view's default. Each failure is invisible and widens the result set.",
    "",
    `export const SCHEMA_SHA256 = ${JSON.stringify(schemaSha256)};`,
    "",
  ].join("\n");

  const interfaces = entities.map(entityInterface).join("\n\n");

  const meta = [
    "/** The server's own answer for each entity — slugs, and what may be filtered or sorted. */",
    "export const ERP_ENTITY_META = {",
    ...entities.map((e) =>
      [
        `  ${e.name}: {`,
        `    slug: ${JSON.stringify(e.slug)},`,
        `    stateField: ${JSON.stringify(e.stateField)},`,
        `    filterable: [${e.filterableFields.map((f) => JSON.stringify(f)).join(", ")}] as const,`,
        `    sortable: [${e.sortableFields.map((f) => JSON.stringify(f)).join(", ")}] as const,`,
        `    searchable: [${e.searchableFields.map((f) => JSON.stringify(f)).join(", ")}] as const,`,
        `    transitions: [${e.transitions.map((t) => JSON.stringify(t.name)).join(", ")}] as const,`,
        `    numericFields: [${e.fields
          .filter((f) => f.input === "number")
          .map((f) => JSON.stringify(f.name))
          .join(", ")}] as const, // range filters and sorts on these are WRONG on --store pg (R19)`,
        "  },",
      ].join("\n"),
    ),
    "} as const;",
    "",
    "export type ErpEntityName = keyof typeof ERP_ENTITY_META;",
    "",
    `export const ERP_ENTITY_NAMES = [${entities.map((e) => JSON.stringify(e.name)).join(", ")}] as const;`,
    "",
    "/** Entities carrying a lifecycle, and the transitions each accepts. */",
    "export type ErpTransition = {",
    ...entities
      .filter((e) => e.transitions.length > 0)
      .map((e) => `  readonly ${e.name}: ${literalUnion(e.transitions.map((t) => t.name))};`),
    "};",
  ].join("\n");

  return {
    source: `${header}\n${interfaces}\n\n${meta}\n`,
    schemaSha256,
    entityCount: entities.length,
  };
}
