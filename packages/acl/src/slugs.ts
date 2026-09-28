/**
 * The ERP derives its REST paths from entity names with a NAIVE pluraliser
 * (`operate-runtime/src/slugs.ts`): kebab-case, then a literal `"s"`. So
 * `Opportunity` → `/v1/opportunitys` and `Currency` → `/v1/currencys`, not the
 * English plurals. Reproduced here EXACTLY, mistakes included, because the
 * server's route table is the contract and "fixing" it produces 404s.
 *
 * Prefer `UiSchemaCache.slugFor()`, which derives slugs from the server's own
 * `/v1/meta/schema`. This function is the fallback for when the schema has not
 * been fetched yet, and the property test in `slugs.test.ts` pins the two
 * against each other.
 */
export function resourceSlug(entityName: string): string {
  return `${entityName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}s`;
}

/** `Product` → `product`, `SalesOrder` → `salesOrder`. */
export function entityCamel(entityName: string): string {
  return entityName.length === 0 ? entityName : entityName[0]!.toLowerCase() + entityName.slice(1);
}

/** A gateway operationId: `salesOrder.list`, `invoice.mark_paid`. */
export function operationId(entityName: string, action: string): string {
  return `${entityCamel(entityName)}.${action}`;
}
