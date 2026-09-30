import { z } from "zod";

/**
 * The ERP's `GET /v1/meta/schema` payload, mirrored from
 * `operate-runtime/src/ui-schema.ts`.
 *
 * This is the ACL's source of truth for slugs, filterable/sortable field sets
 * and field types. Nothing in this repo hand-writes a resource path or assumes a
 * field is filterable: the ERP's pluraliser is naive (`/v1/opportunitys`) and an
 * unknown filter param is SILENTLY DROPPED rather than rejected, so a mistyped
 * filter widens the result set instead of erroring (report R13). Deriving from
 * the served schema is the only way to be sure.
 *
 * `.passthrough()` throughout: the ERP adds fields to this payload as it grows,
 * and an unknown key must never fail a read.
 */
export const UiFieldSchemaSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    input: z.enum([
      "text",
      "textarea",
      "email",
      "number",
      "boolean",
      "date",
      "datetime",
      "select",
      "reference",
    ]),
    required: z.boolean(),
    enumValues: z.array(z.string()).optional(),
    referenceTarget: z.string().optional(),
    classification: z.string().optional(),
    unique: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    defaulted: z.boolean().optional(),
  })
  .passthrough();
export type UiFieldSchema = z.infer<typeof UiFieldSchemaSchema>;

export const UiTransitionSchemaSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    operationId: z.string(),
    stateField: z.string(),
    from: z.array(z.string()),
    to: z.string(),
    roles: z.array(z.string()),
  })
  .passthrough();
export type UiTransitionSchema = z.infer<typeof UiTransitionSchemaSchema>;

export const UiEntitySchemaSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    label: z.string(),
    singular: z.string(),
    module: z.string(),
    access: z
      .object({
        list: z.array(z.string()),
        read: z.array(z.string()),
        create: z.array(z.string()),
        update: z.array(z.string()),
        delete: z.array(z.string()),
      })
      .passthrough(),
    fields: z.array(UiFieldSchemaSchema),
    listColumns: z.array(z.string()),
    sortableFields: z.array(z.string()),
    filterableFields: z.array(z.string()),
    searchableFields: z.array(z.string()),
    stateField: z.string().nullable(),
    transitions: z.array(UiTransitionSchemaSchema),
  })
  .passthrough();
export type UiEntitySchema = z.infer<typeof UiEntitySchemaSchema>;

export const UiSchemaSchema = z
  .object({
    entities: z.array(UiEntitySchemaSchema),
    roles: z.array(z.object({ name: z.string(), label: z.string() }).passthrough()),
    generatedAt: z.string(),
  })
  .passthrough();
export type UiSchema = z.infer<typeof UiSchemaSchema>;

export class UnknownEntityError extends Error {
  constructor(entity: string, tenantId: string) {
    super(
      `entity ${JSON.stringify(entity)} is not served to tenant ${tenantId}. ` +
        `With per-tenant manifests enabled, a tenant on a custom manifest has a ` +
        `different entity set from the boot pack — this is a supported state, not a bug.`,
    );
    this.name = "UnknownEntityError";
  }
}

export class UnsupportedFilterError extends Error {
  constructor(
    readonly entity: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`cannot filter ${entity}.${field}: ${reason}`);
    this.name = "UnsupportedFilterError";
  }
}

/** Range operators. Safe on ISO-8601 dates, wrong on numbers — see `assertFilterable`. */
const RANGE_OPS = new Set(["gt", "gte", "lt", "lte"]);

/**
 * One tenant's served schema, indexed for lookup.
 *
 * Per tenant, not per deployment: `--per-tenant-manifests` is enabled (ADR-0001
 * Q11), so a tenant on a custom manifest has a different entity set, and a single
 * global cache would be wrong for it.
 */
export class TenantSchema {
  private readonly byName: ReadonlyMap<string, UiEntitySchema>;

  constructor(
    readonly tenantId: string,
    readonly schema: UiSchema,
    readonly fetchedAt: number,
  ) {
    this.byName = new Map(schema.entities.map((e) => [e.name, e]));
  }

  has(entity: string): boolean {
    return this.byName.has(entity);
  }

  entity(entity: string): UiEntitySchema {
    const found = this.byName.get(entity);
    if (found === undefined) throw new UnknownEntityError(entity, this.tenantId);
    return found;
  }

  /** The resource slug as the SERVER derives it — never guessed from the entity name. */
  slugFor(entity: string): string {
    return this.entity(entity).slug;
  }

  field(entity: string, field: string): UiFieldSchema | undefined {
    return this.entity(entity).fields.find((f) => f.name === field);
  }

  /**
   * Refuses a filter the ERP would mishandle, rather than sending it and trusting
   * the result. Two distinct failures are caught:
   *
   * 1. **Not filterable.** The ERP silently ignores an unknown or non-filterable
   *    param, so the query comes back WIDER than asked for. Silently wrong in the
   *    dangerous direction.
   *
   * 2. **A range operator on a numeric field.** The deployed ERP runs
   *    `--store pg`, whose list SQL emits `document ->> 'field'` with no cast, so
   *    every comparison is textual (report R19, pinned by test in @crm/db).
   *    `?total[gte]=1000` returns 999 AND 20, because "999" and "20" both sort
   *    above "1000" as text. Dates are exempt: ISO-8601 lexicographic order is
   *    chronological order, which is the only reason incremental polling works.
   */
  assertFilterable(entity: string, field: string, op: string): void {
    const ent = this.entity(entity);
    if (!ent.filterableFields.includes(field)) {
      throw new UnsupportedFilterError(
        entity,
        field,
        `not in the server's filterableFields (it would be silently ignored, widening the result set). ` +
          `Filterable: ${ent.filterableFields.join(", ") || "(none)"}`,
      );
    }
    const f = ent.fields.find((x) => x.name === field);
    if (f?.input === "number" && RANGE_OPS.has(op)) {
      throw new UnsupportedFilterError(
        entity,
        field,
        `${op} on a numeric field is evaluated as a TEXT comparison by the deployed ERP ` +
          `(--store pg), so the result is wrong rather than merely slow. ` +
          `Query crm.*_snapshot, which holds this value in a typed column.`,
      );
    }
  }

  /** Refuses a sort the ERP would order lexicographically. Same reasoning as above. */
  assertSortable(entity: string, field: string): void {
    const ent = this.entity(entity);
    if (!ent.sortableFields.includes(field)) {
      throw new UnsupportedFilterError(
        entity,
        field,
        `not in the server's sortableFields (the ERP would silently fall back to the view's default sort). ` +
          `Sortable: ${ent.sortableFields.join(", ") || "(none)"}`,
      );
    }
    const f = ent.fields.find((x) => x.name === field);
    if (f?.input === "number") {
      throw new UnsupportedFilterError(
        entity,
        field,
        `sorting a numeric field orders it lexicographically (100, 20, 9) on the deployed ERP, ` +
          `and the keyset cursor paginates that wrong order consistently rather than erroring. ` +
          `Sort in crm.*_snapshot instead.`,
      );
    }
  }
}
