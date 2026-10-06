export {
  ErpError,
  type ErpErrorKind,
  HandlerErrorSchema,
  ProblemDetailsSchema,
  codeFromProblemType,
  toErpError,
} from "./problems.js";
export { entityCamel, operationId, resourceSlug } from "./slugs.js";
export { ErpDecimalError, erpDecimal } from "./values.js";
export {
  TENANT_DELETION_TOMBSTONE_KIND,
  classifyTombstonePayload,
  classifyTombstoneRefusal,
  readTenantDeletionVerdict,
  type TenantDeletionVerdict,
  type TenantTombstone,
  type TombstoneReader,
} from "./tombstones.js";
export type { ChangeBatch, ChangeMode, ChangedRecord, ChangeSource } from "./change-source.js";
export {
  TenantSchema,
  UiEntitySchemaSchema,
  UiFieldSchemaSchema,
  UiSchemaSchema,
  UiTransitionSchemaSchema,
  UnknownEntityError,
  UnsupportedFilterError,
  type UiEntitySchema,
  type UiFieldSchema,
  type UiSchema,
  type UiTransitionSchema,
} from "./ui-schema.js";
export {
  ErpClient,
  MAX_PAGE_SIZE,
  parseListPage,
  type ErpClientOptions,
  type FetchLike,
  type ListOptions,
  type ListPage,
  type TenantCredential,
} from "./client.js";
export { PollingChangeSource, type PollingChangeSourceOptions } from "./polling-change-source.js";
export { generateTypes, type CodegenResult } from "./codegen.js";

/**
 * The generated ERP types. Captured from a live `operate-server` serving `pack-erp-core`
 * (51 entities) — re-exported because they were unreachable from this package until now,
 * which is why `@crm/expense` and `@crm/sample` still type their ERP payloads by hand.
 */
export * from "./generated/erp.js";
