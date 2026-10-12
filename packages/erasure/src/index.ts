export {
  CRM_RETENTION_OBLIGATIONS,
  DISPOSITIONS,
  ERP_RETENTION_OBLIGATIONS,
  NOT_A_BASIS,
  RETENTION_OBLIGATIONS,
  isRetentionObligation,
  type Disposition,
  type RetentionObligation,
} from "./obligations.js";

export {
  NoTenantContextError,
  describeRefusal,
  planTenantErasure,
  planTenantErasureWithin,
  type ErasurePlan,
  type PlanRefusal,
  type TablePlan,
} from "./plan.js";

export {
  ErasureRefusedError,
  executeTenantErasure,
  readTenantTombstones,
  type ErasureResult,
  type ExecuteErasureOptions,
} from "./execute.js";

export {
  ATTESTATION_OUTCOMES,
  CURRENT_MANIFEST_VERSION,
  MANIFEST_VERSIONS,
  type ManifestVersion,
  TombstoneInvalidError,
  assembleTombstone,
  assertAttestationWellFormed,
  canonicalAttestationManifest,
  computeContentManifestSha256,
  computeProofSha256,
  newCrmTombstoneId,
  verifyTombstone,
  type AttestationOutcome,
  type CrmTombstone,
  type TableAttestation,
} from "./tombstone.js";

export { eraseDeleteOrder } from "./plan.js";

export {
  FAILURE_SAMPLE_LIMIT,
  RECEIPT_VERDICTS,
  SELF_TEST_ATTESTATIONS,
  SELF_TEST_EXCLUSIONS,
  SELF_TEST_VECTORS,
  decideReceiptVerdict,
  latestReceiptVerification,
  recordReceiptVerification,
  runSelfTest,
  sweepReceipts,
  verifyStoredReceipts,
  type ReceiptFailure,
  type ReceiptVerdict,
  type ReceiptVerificationResult,
  type ReceiptVerificationRow,
  type SelfTestResult,
  type VersionCohort,
} from "./verify-receipts.js";
