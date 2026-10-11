import {
  addTarget,
  approvePlan,
  createPlan,
  cycleOn,
  listCycles,
  listPlanProducts,
  listPlans,
  listTargets,
  planAdherence,
  planSummary,
  getPlan,
  removeTarget,
  returnPlanToDraft,
  setPlanProducts,
  submitPlan,
  supersedePlan,
  teamAdherence,
  teamPlans,
  withdrawPlan,
} from "@crm/callplan";
import { PostgresServiceKeyRegistry, jwksResponse } from "@crm/credential";
import {
  ENDPOINT_CHANNELS,
  ENDPOINT_HISTORY_LIMIT,
  MAX_PRUNE_GUARD_FLOOR_ROWS,
  latestProbe,
  listProbes,
  requestProbe,
  MAX_PRUNE_OVERRIDE_BY_CHARS,
  createEndpoint,
  endpointHistory,
  getEndpoint,
  grantPruneGuardOverride,
  inbox,
  listEndpoints,
  markAllRead,
  markRead,
  notifyPendingApprovals,
  clearRepNotifyAddress,
  notifyAddressCoverage,
  repNotifyAddress,
  setRepNotifyAddress,
  deliveryHistory,
  notificationDeliveryRetention,
  probeBudget,
  probeCooldownSeconds,
  notificationPolicy,
  notificationPruneGuard,
  recentDeliveries,
  prunableNotifications,
  prunePreview,
  revokePruneGuardOverride,
  setNotificationDeliveryRetention,
  setProbeBudget,
  setProbeCooldownSeconds,
  setNotificationPolicy,
  setNotificationPruneGuard,
  unreadCount,
  updateEndpoint,
} from "@crm/notify";
import {
  ROLES,
  grantRole,
  listGrants,
  revokeRole,
  roleHolders,
  type Role,
} from "@crm/role";
import {
  attemptHistory,
  deadLetter,
  deadLetters,
  outboxLetterOwner,
  recentDeaths,
  reviveDeadLetter,
  summariseAttemptHistory,
  teamDeadLetters,
} from "@crm/relay";
import {
  CONFIG_LOG_LIMIT,
  PROPOSAL_LIST_LIMIT,
  configChanges,
  configProposal,
  configProposals,
  decideConfigProposal,
  fourEyesRequired,
  fourEyesRules,
  proposalDeciders,
  proposeConfigChange,
  withAttribution,
  withTenantContext,
  type ConfigProposal,
  type ProposalDecision,
} from "@crm/db";
import {
  ACCOUNT_CODE_MAX,
  EXPENSE_CATEGORY_MAX,
  EXPENSE_CLAIM_STATES,
  anyAccountMapping,
  approveClaim,
  claimPostingStatus,
  createClaim,
  deactivateAccountMapping,
  listAccountMappings,
  listClaimsForRep,
  postClaim,
  reimburseClaim,
  rejectClaim,
  requireClaim,
  submitClaim,
  unmappedCategoriesWithClaims,
  upsertAccountMapping,
} from "@crm/expense";
import { canSupervise, teamRoster, visibleAccountIds, visibleTerritoryIds } from "@crm/territory";
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BASE64_CHARS,
  PostgresBlobStore,
  attachmentAccessLog,
  attachmentSubjectOwner,
  decodeAttachmentContent,
  getAttachment,
  listAttachmentsForSubject,
  putAttachment,
  readAttachmentContent,
  requireAttachment,
} from "@crm/storage";
import {
  appendNote,
  getVisit,
  getVisitProducts,
  listVisits,
  recordVisit,
  setVisitProducts,
  transitionVisit,
  VISIT_STATUSES,
  type VisitStatus,
} from "@crm/visit";
import {
  acceptTransfer,
  cancelCount,
  commitCount,
  countLines,
  disburseSamples,
  enqueueErpMirror,
  expiringHoldings,
  getLot,
  holdingsFor,
  incomingTransfers,
  ledgerFor,
  listWarehouses,
  requireActiveWarehouse,
  disposalHistory,
  POLICY_HISTORY_LIMIT,
  disposalPolicy,
  disposalPolicyDetail,
  disposalPolicyHistory,
  setDisposalPolicy,
  getCount,
  listCounts,
  openCount,
  outstandingTransfers,
  receiveSamples,
  recallTransfer,
  recallableTransfers,
  openObligations,
  recordCountLine,
  returnToWarehouse,
  teamExpiringHoldings,
  teamExposure,
  teamObligations,
  transferOut,
  transferPeers,
  writeOff,
} from "@crm/sample";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { requireAnyRole, requireRole, type Principal } from "../principal.js";
import { ApiError, forbidden, notFound, validationFailed } from "../problems.js";
import { Router, type HandlerResult, type RequestContext } from "../router.js";

export interface HandlerDeps {
  readonly pool: Pool;
  readonly now?: () => Date;
}

type Ctx = RequestContext<Principal>;

/** Parses with zod and reports per-field messages a form can render inline. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    errors[issue.path.join(".") || "_"] = issue.message;
  }
  throw validationFailed("the request body is not valid", errors);
}

const UUID = z.string().uuid();
const ERP_ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, "not a valid ERP record id");
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * Runs `fn` in the principal's tenant context.
 *
 * Every handler goes through here. RLS then confines the query to the tenant
 * whatever the handler does, so a missing `WHERE tenant_id` is a bug that
 * returns nothing rather than a bug that returns everything.
 */
async function inTenant<T>(deps: HandlerDeps, p: Principal, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await deps.pool.connect();
  try {
    return await withTenantContext(client, p.tenantId, fn);
  } finally {
    client.release();
  }
}

/**
 * The same, with the author and reason set for the whole transaction (0061).
 *
 * Every write to a table under `crm.require_config_attribution` goes through this, and the
 * database refuses it otherwise — so a route that forgets is a 500 rather than an unattributed
 * change. The author is the authenticated principal and the reason comes from the body, which
 * is the only division that makes sense: a client may say WHY, never WHO.
 */
async function asChange<T>(
  deps: HandlerDeps,
  p: Principal,
  reason: string,
  fn: (tx: PoolClient) => Promise<T>,
  proposalId?: string,
): Promise<T> {
  return inTenant(deps, p, (tx) =>
    withAttribution(
      tx,
      { repProfileId: p.repProfileId, reason, ...(proposalId !== undefined ? { proposalId } : {}) },
      fn,
    ),
  );
}

/**
 * A rule whose change nothing knows how to make.
 *
 * Reachable only by adding a row to `crm.four_eyes_rule` without adding a branch below, which
 * is a deployment defect rather than anything a caller did — so it is an internal error with
 * a sentence for whoever reads the log, and the switch below is written to make the omission
 * findable rather than silent. The alternative, a generic UPDATE built from `changes`, would
 * be a route that can write any column of any table from a request body.
 */
class UnappliableProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnappliableProposalError";
  }
}

/**
 * Performs the change an approved proposal authorises.
 *
 * ONE BRANCH PER TABLE, by hand, and that is the point: the write goes through the same store
 * function the single-signature route uses, so an approved change and an ordinary one take
 * exactly the same path into the database and meet the same validation. A generic applier
 * built from `changes` would be shorter and would be a route that writes arbitrary columns.
 *
 * The attribution block around this names the APPROVER as the author and the proposal as the
 * authority, which is why `changedBy` is the principal here and not `proposal.proposed_by`:
 * before the approver acted, nothing had changed. The proposal is what records who asked.
 *
 * The whole of `changes` is applied, not only the four-eyes columns. A re-pointing carries the
 * cost centre alongside the account code because `upsertAccountMapping` REPLACES it — an
 * applier that sent only the approved column would silently clear a dimension the approver
 * saw on the screen and never agreed to drop.
 */
async function applyProposal(
  tx: PoolClient,
  p: Principal,
  proposal: ConfigProposal,
  reason: string,
): Promise<unknown> {
  const changes = proposal.changes;
  switch (proposal.table_name) {
    case "disposal_policy":
      return setDisposalPolicy(tx, p.tenantId, {
        ...(typeof changes["grace_days"] === "number" ? { graceDays: changes["grace_days"] } : {}),
        ...(typeof changes["auto_writeoff_promo"] === "boolean"
          ? { autoWriteoffPromo: changes["auto_writeoff_promo"] }
          : {}),
        changedBy: p.repProfileId,
        reason,
      });
    case "expense_account_map": {
      const category = proposal.row_key["crm_category"];
      const code = changes["erp_ledger_account_code"];
      if (typeof category !== "string" || typeof code !== "string") {
        throw new UnappliableProposalError(
          `proposal ${proposal.id} names no category or no account code, so there is nothing to apply`,
        );
      }
      const centre = changes["erp_cost_center_code"];
      return upsertAccountMapping(tx, p.tenantId, {
        crmCategory: category,
        erpLedgerAccountCode: code,
        ...(centre === null || typeof centre === "string" ? { erpCostCenterCode: centre } : {}),
      });
    }
    default:
      throw new UnappliableProposalError(
        `crm.four_eyes_rule has a rule for crm.${proposal.table_name} and nothing here knows how to apply one`,
      );
  }
}

/**
 * The two decisions that only record, shared because they differ by one word.
 *
 * Approval is NOT here: it also applies the change, which needs an attribution block, the
 * table dispatcher and a re-read — and folding that into a function with a `decision`
 * parameter would make the one path that writes look like the two that do not.
 */
async function decideFourEyes(
  deps: HandlerDeps,
  ctx: Ctx,
  id: string,
  decision: Exclude<ProposalDecision, "approved">,
  reason: string,
  opts: { readonly requireGrant?: boolean } = {},
): Promise<unknown> {
  const pending = await inTenant(deps, ctx.principal, (tx) =>
    configProposal(tx, ctx.principal.tenantId, id),
  );
  if (pending === null) throw notFound(`no proposal ${id} in this tenant`);
  if (opts.requireGrant !== false) requireRole(ctx.principal, pending.role);
  return inTenant(deps, ctx.principal, (tx) =>
    decideConfigProposal(
      tx,
      ctx.principal.tenantId,
      id,
      decision,
      ctx.principal.repProfileId,
      reason,
    ),
  );
}

/** `?on=YYYY-MM-DD`, for asking a historical question. Defaults to today. */
function onDate(ctx: Ctx): string | undefined {
  const raw = ctx.query.get("on");
  if (raw === null) return undefined;
  return parse(ISO_DATE, raw);
}

/**
 * Refuses unless the rep covered the account on the date in question.
 *
 * The single authorisation gate for anything account-shaped, and it delegates to
 * `crm.rep_can_see_account` rather than reimplementing the rule — the ERP cannot
 * answer this at all, and two implementations of it would eventually disagree.
 */
async function requireAccountAccess(
  tx: PoolClient,
  p: Principal,
  erpAccountId: string,
  on?: string,
): Promise<void> {
  const { rows } = await tx.query<{ ok: boolean }>(
    "SELECT crm.rep_can_see_account($1, $2, COALESCE($3::date, CURRENT_DATE)) AS ok",
    [p.repProfileId, erpAccountId, on ?? null],
  );
  if (rows[0]?.ok !== true) {
    throw forbidden(`account ${erpAccountId} is not in your territory${on !== undefined ? ` on ${on}` : ""}`);
  }
}



const PlanBody = z.object({
  cycleId: UUID,
  /** Omitted means "mine". A manager may build a plan for a rep they supervise. */
  repProfileId: UUID.nullish(),
});

const TargetBody = z.object({
  erpAccountId: ERP_ID,
  erpContactId: ERP_ID.nullish(),
  segment: z.string().min(1).max(32).nullish(),
  targetCalls: z.number().int().min(1).max(100),
  notes: z.string().max(2000).nullish(),
});

const PlanProductsBody = z.object({
  products: z
    .array(z.object({ erpItemId: ERP_ID, keyMessage: z.string().max(2000).nullish() }))
    .max(50),
});

const CountBody = z.object({
  /**
   * Device-minted, and optional only for a caller that has a network (0056).
   *
   * A count is taken where the stock is, and the line route needs this id in its path — so
   * a rep with no signal has to be able to mint it before there is anywhere to send it.
   * Supplying one twice opens the count once: `openCount` reads the existing row back.
   */
  id: UUID.optional(),
  /** Omitted means a self-count. A manager passes a rep to record a supervised one. */
  repProfileId: UUID.nullish(),
  countedAt: z.string().datetime(),
  note: z.string().max(2000).nullish(),
});

const CountLineBody = z.object({
  lotId: UUID,
  countedQuantity: z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().min(0)]),
  /**
   * What the device had on screen when the rep counted, which for an offline count is not
   * the balance this line will snapshot on arrival. Recorded beside the server's own
   * figure, never over it — see 0056 for why that direction is the only safe one.
   */
  deviceExpectedQuantity: z
    .union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().min(0)])
    .nullish(),
});

const DisbursementBody = z.object({
  id: UUID,
  lotId: UUID,
  quantity: z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/, "expected a decimal quantity"), z.number().positive()]),
  occurredAt: z.string().datetime(),
  erpAccountId: ERP_ID,
  erpContactId: ERP_ID.nullish(),
  recipientName: z.string().min(1).max(200),
  /** The sha256 of the signature captured on the device. See 0017 on why a hash. */
  signatureSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest"),
  visitId: UUID.nullish(),
});

const ReceiptBody = z.object({
  id: UUID,
  lotId: UUID,
  quantity: z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().positive()]),
  occurredAt: z.string().datetime(),
  erpWarehouseId: ERP_ID,
});

const TransferBody = z.object({
  id: UUID,
  lotId: UUID,
  quantity: z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().positive()]),
  occurredAt: z.string().datetime(),
  toRepProfileId: UUID,
});

const AcceptBody = z.object({ id: UUID, occurredAt: z.string().datetime() });

const QUANTITY = z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().positive()]);

const WriteOffBody = z.object({
  id: UUID,
  lotId: UUID,
  quantity: QUANTITY,
  occurredAt: z.string().datetime(),
  kind: z.enum(["destruction", "expiry_writeoff"]),
  /** Required by the schema too; stated here so the 422 names the field. */
  reason: z.string().min(1).max(500),
});

const ReturnBody = z.object({
  id: UUID,
  lotId: UUID,
  quantity: QUANTITY,
  occurredAt: z.string().datetime(),
  erpWarehouseId: ERP_ID,
  reason: z.string().max(500).nullish(),
});

/**
 * Records a disbursement.
 *
 * No outbox write, deliberately: a hand-over is invisible to the ERP because the
 * material left its warehouse when the rep received it. Mirroring it would subtract the
 * same quantity from the warehouse twice. The receipt route is where the mirror belongs.
 */
async function recordDisbursement(
  tx: PoolClient,
  p: Principal,
  input: z.infer<typeof DisbursementBody>,
): Promise<unknown> {
  const row = await disburseSamples(tx, p.tenantId, {
    id: input.id,
    lotId: input.lotId,
    repProfileId: p.repProfileId,
    quantity: input.quantity,
    occurredAt: new Date(input.occurredAt),
    erpAccountId: input.erpAccountId,
    recipientName: input.recipientName,
    signatureSha256: input.signatureSha256,
    ...(input.erpContactId != null ? { erpContactId: input.erpContactId } : {}),
    ...(input.visitId != null ? { visitId: input.visitId } : {}),
  });
  return row;
}

/**
 * Refuses a plan the caller may neither own nor supervise.
 *
 * A 404 rather than a 403, consistently for every record scoped this way: whether a
 * plan exists is itself information about another rep's territory, and the ERP leaks
 * exactly this class of thing by having no row-level scoping at all (report R2).
 *
 * The supervision check is `crm.rep_can_supervise`, which answers yes for the caller
 * themselves — so this one helper covers "my plan" and "my team's plan" without the
 * route having to know which it is holding.
 */
async function requireVisiblePlan(
  tx: PoolClient,
  p: Principal,
  planId: string,
  on?: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getPlan>>>> {
  const plan = await getPlan(tx, planId);
  if (plan === null || !(await canSupervise(tx, p.repProfileId, plan.rep_profile_id, on))) {
    throw notFound(`no call plan ${planId}`);
  }
  return plan;
}

/**
 * Refuses a rep the caller may not read, for a route that takes a rep id.
 *
 * Every team route goes through here. The predicate is in SQL (0019) and RLS does not
 * help: a manager and a peer's rep are in the same tenant, so the policy admits both
 * rows and this check is the only thing between them. A route that forgets it leaks.
 */
async function requireSupervision(tx: PoolClient, p: Principal, repProfileId: string, on?: string): Promise<void> {
  if (!(await canSupervise(tx, p.repProfileId, repProfileId, on))) {
    throw notFound(`no rep ${repProfileId} on your team`);
  }
}

/**
 * Refuses a CLAIM the caller may neither own nor supervise, without naming its owner.
 *
 * `requireSupervision` is the obvious call and leaks: its sentence is
 * `no rep <id> on your team`, so a caller holding a claim id they should not — from a
 * screenshot, a support ticket, a shared spreadsheet, or a period when they did supervise
 * that rep — is handed the owner's `rep_profile` id, which is the identifier the 404 exists
 * to conceal. The disbursement-signature route next door avoids it by answering about the
 * SUBJECT; every expense route that reached for `requireSupervision` did not, and this is
 * the same leak the repo already records as shipped once.
 *
 * So the refusal names the claim the caller already had and nothing else. It stays a 404
 * rather than a 403 for the reason every scoped record here does: whether another rep's
 * claim exists is information about their work.
 */
async function requireClaimOnMyTeam(
  tx: PoolClient,
  p: Principal,
  claimId: string,
  repProfileId: string,
): Promise<void> {
  if (!(await canSupervise(tx, p.repProfileId, repProfileId))) {
    // BYTE-IDENTICAL to `ExpenseClaimNotFoundError`'s sentence, and that is the point. The
    // first version of this said `… on your team`, which removed the rep id and left an
    // existence oracle in its place: `no expense claim <id> on your team` versus
    // `no expense claim <id>` told any authenticated rep whether a claim id exists in the
    // tenant, which is the information this 404 exists to conceal. `requireVisiblePlan`
    // above already gets this right with one sentence for both cases.
    throw notFound(`no expense claim ${claimId}`);
  }
}

/**
 * Supervision AND four-eyes, for a privileged act on somebody else's expense claim.
 *
 * `canSupervise` answers yes for the caller themselves. That is right for a read — a rep
 * may always see their own work, which is why one helper covers "mine" and "my team's" —
 * and wrong for a privileged write: supervision alone let a rep approve, reject, post and
 * reimburse their own claim. Two of the four were caught downstream by
 * `expense_claim_four_eyes` and (0030) `expense_claim_reject_four_eyes`, as a 403 with no
 * explanation; `post` and `reimburse` record no actor at all, so no constraint could ever
 * have caught those. The rule belongs here, once, for all four.
 *
 * A 403 and not the 404 every other scoped record gets: the caller is the claimant, so
 * claiming the claim does not exist tells them something they know to be false, and there
 * is nothing left to conceal from the person whose money it is.
 */
async function requireExpenseApprover(
  tx: PoolClient,
  p: Principal,
  claimId: string,
  claim: { readonly rep_profile_id: string },
  verb: string,
): Promise<void> {
  if (claim.rep_profile_id === p.repProfileId) {
    throw forbidden(`a claim may not be ${verb} by the rep who filed it`);
  }
  await requireClaimOnMyTeam(tx, p, claimId, claim.rep_profile_id);
}

/**
 * Refuses a count the caller may neither own nor supervise.
 *
 * The count belongs to the rep whose stock it counts, not to whoever performed it — so a
 * manager who counted a rep's bag reaches it through supervision, and a rep reaches
 * their own count the same way (`rep_can_supervise` answers yes for self).
 */
async function requireOwnOrSupervisedCount(
  tx: PoolClient,
  p: Principal,
  countId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getCount>>>> {
  const count = await getCount(tx, countId);
  if (count === null || !(await canSupervise(tx, p.repProfileId, count.rep_profile_id))) {
    throw notFound(`no sample count ${countId}`);
  }
  return count;
}

/**
 * Who granted something, as `display name <subject>` and guaranteed to fit
 * `MAX_PRUNE_OVERRIDE_BY_CHARS`.
 *
 * Both halves come from unbounded `text` columns, so the obvious template overflowed the
 * CHECK on a long display name or a long OIDC subject and the operator was told the
 * override "must name who granted it" — true of the empty string, not of theirs.
 *
 * The subject survives whole where it can: it is the half that identifies the grantor
 * uniquely, and a truncated one names nobody. The display name gives way first, with an
 * ellipsis rather than a silent cut, so a reader can see something was dropped.
 */
function attributionOf(p: Principal): string {
  const subject = `<${p.subject}>`;
  if (subject.length >= MAX_PRUNE_OVERRIDE_BY_CHARS) {
    return `${subject.slice(0, MAX_PRUNE_OVERRIDE_BY_CHARS - 1)}\u2026`;
  }
  // The space for a name, after the subject and the separator. At two characters there is
  // room for one letter and an ellipsis; at less than that, a truncated name is all
  // ellipsis and says nothing, so the subject stands alone.
  //
  // This is where the first version overflowed the cap it documents as guaranteed. With
  // `room` at zero it still took the truncating branch, `slice(0, -1 → 0)` gave the empty
  // string, and the ellipsis appended to it made a one-character "name" — so the length
  // check below passed and the result was 201 characters against a CHECK of 200. One
  // subject length in 220 hit it (197), which is why a test of a single long display name
  // never found it.
  const room = MAX_PRUNE_OVERRIDE_BY_CHARS - subject.length - 1;
  if (room < 2) return subject;
  const name =
    p.displayName.length <= room ? p.displayName : `${p.displayName.slice(0, room - 1)}\u2026`;
  return name.length === 0 ? subject : `${name} ${subject}`;
}

const EXPENSE_STATE = z.enum(EXPENSE_CLAIM_STATES);

const PLAN_STATUS = z.enum(["draft", "submitted", "approved", "superseded", "withdrawn"]);

export function buildRouter(deps: HandlerDeps): Router<Principal> {
  const router = new Router<Principal>();

  // ---- public -------------------------------------------------------------

  /**
   * Liveness and readiness in one. The ERP has no health endpoint at all
   * (report R11), so this is ours to provide — and it checks the database,
   * because a process that is up but cannot reach Postgres is not ready.
   *
   * It also checks the ROLE, because a process connected as a privileged role is not
   * ready either: `withTenantContext` refuses such a connection, so every tenant-scoped
   * request would 500 while a `SELECT 1` kept answering. A green health check in front
   * of a deployment that cannot serve one request is the same "appears to work" failure
   * the guard exists to remove, moved one level up — so readiness reports it, and a
   * rollout that would have gone live and then 500ed never goes live at all.
   *
   * Reported as a distinct `detail`, not folded into "database unreachable": the two
   * have completely different remedies and an operator reads this string first.
   */
  router.add({
    method: "GET",
    pattern: "/healthz",
    public: true,
    handler: async (): Promise<HandlerResult> => {
      const client = await deps.pool.connect();
      try {
        const { rows } = await client.query<{ role: string; bypasses_rls: boolean }>(
          `SELECT current_user AS role,
                  (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
                    AS bypasses_rls`,
        );
        const role = rows[0];
        if (role === undefined || role.bypasses_rls !== false) {
          // The role name is safe here in a way it is not in a request error: /healthz is
          // for the operator and carries no tenant data, and naming the role is the
          // whole value of the signal.
          return {
            status: 503,
            body: {
              status: "degraded",
              detail: `connected as ${role?.role ?? "an unknown role"}, which bypasses row-level security — connect as crm_app`,
            },
          };
        }
        return { status: 200, body: { status: "ok" } };
      } catch {
        return { status: 503, body: { status: "degraded", detail: "database unreachable" } };
      } finally {
        client.release();
      }
    },
  });

  /**
   * The JWKS the ERP verifies our service tokens against (ADR-0001 item 10).
   *
   * Public by necessity — a verifier fetches it unauthenticated — and harmless:
   * it contains public keys only. The signing key is never in this process at all;
   * it lives in the scheduler, which is the one that mints tokens.
   *
   * The 503-rather-than-empty rule lives in `jwksResponse`, and the reason is the
   * ERP's own refresh logic: a non-200 makes it keep the key set it has, while a
   * 200 replaces it with whatever arrived. An empty document would therefore
   * silently disarm every verifier that fetched it.
   */
  router.add({
    method: "GET",
    pattern: "/.well-known/jwks.json",
    public: true,
    handler: async (): Promise<HandlerResult> => {
      try {
        const keys = await new PostgresServiceKeyRegistry({ pool: deps.pool }).verifiableKeys();
        // RENDERING IS INSIDE THE TRY, and it has to be. `buildJwksDocument` throws
        // `JwkError` when a registry row's `kid` is not the thumbprint of its own key — a
        // row the read itself cannot refuse. Outside the try that escaped as a 500, which
        // is non-200 and so still fail-closed (every verifier keeps its last good key set),
        // but it is the wrong answer to the same question the catch below already answers.
        return jwksResponse(keys);
      } catch {
        // A failed read, or a document that cannot be built, must not become an empty key
        // set. 503 keeps every verifier on its last good document; a 200 would replace it
        // with whatever arrived, which is how an empty answer disarms a verifier.
        return jwksResponse([]);
      }
    },
  });

  // ---- who am I -----------------------------------------------------------

  router.add({
    method: "GET",
    pattern: "/v1/me",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, async (tx) => ({
        territories: await visibleTerritoryIds(tx, ctx.principal.repProfileId, on),
        accountCount: (await visibleAccountIds(tx, ctx.principal.repProfileId, on)).length,
      }));
      return {
        status: 200,
        body: {
          repProfileId: ctx.principal.repProfileId,
          displayName: ctx.principal.displayName,
          // Surfaced because a null here is why a rep's expense claims cannot
          // reach the ERP — worth being visible rather than mysterious.
          erpEmployeeId: ctx.principal.erpEmployeeId,
          ...data,
        },
      };
    },
  });

  // ---- my accounts --------------------------------------------------------

  /**
   * The rep's accounts, joined to the snapshot for names.
   *
   * A LEFT JOIN, deliberately: an account assigned before the snapshot caught up
   * still appears, with nulls, rather than vanishing. A rep seeing an
   * unlabelled account they can investigate beats a rep silently missing one.
   */
  router.add({
    method: "GET",
    pattern: "/v1/accounts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const rows = await inTenant(deps, ctx.principal, async (tx) => {
        const { rows } = await tx.query(
          `SELECT v.erp_account_id, s.name, s.status, s.country, s.erp_updated_at::text AS synced_from
             FROM crm.visible_account_ids($1, COALESCE($2::date, CURRENT_DATE)) v
             LEFT JOIN crm.account_snapshot s
               ON s.erp_account_id = v.erp_account_id AND s.tenant_id = $3
            ORDER BY s.name NULLS LAST, v.erp_account_id`,
          [ctx.principal.repProfileId, on ?? null, ctx.principal.tenantId],
        );
        return rows;
      });
      return { status: 200, body: { data: rows } };
    },
  });

  // ---- product catalogue --------------------------------------------------

  /**
   * The catalogue, from the typed snapshot — never from the ERP.
   *
   * `minPrice`/`maxPrice` are the reason this matters: the same filter against
   * the ERP would be a TEXT comparison and return the wrong rows (report R19).
   * Here `list_price` is `NUMERIC` and the answer is correct.
   *
   * Not territory-scoped: the catalogue is the same for every rep in a tenant.
   */
  router.add({
    method: "GET",
    pattern: "/v1/products",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const q = ctx.query.get("q");
      const minPrice = ctx.query.get("minPrice");
      const maxPrice = ctx.query.get("maxPrice");
      const where: string[] = ["tenant_id = $1"];
      const params: unknown[] = [ctx.principal.tenantId];
      if (q !== null && q.trim() !== "") {
        where.push(`(sku ILIKE $${params.push(`%${q.trim()}%`)} OR name ILIKE $${params.length})`);
      }
      if (minPrice !== null) where.push(`list_price >= $${params.push(parse(z.coerce.number(), minPrice))}`);
      if (maxPrice !== null) where.push(`list_price <= $${params.push(parse(z.coerce.number(), maxPrice))}`);

      const rows = await inTenant(deps, ctx.principal, async (tx) => {
        const { rows } = await tx.query(
          `SELECT erp_item_id, sku, name, list_price::text, currency, status, category
             FROM crm.product_snapshot
            WHERE ${where.join(" AND ")}
            ORDER BY name LIMIT 500`,
          params,
        );
        return rows;
      });
      return { status: 200, body: { data: rows } };
    },
  });

  // ---- visits -------------------------------------------------------------

  const VisitBody = z.object({
    id: UUID,
    erpAccountId: ERP_ID,
    erpContactId: ERP_ID.nullish(),
    visitType: z.enum(["detailing", "follow_up", "sample_drop", "training", "cycle_meeting", "other"]).optional(),
    status: z.enum(VISIT_STATUSES).optional(),
    plannedFor: ISO_DATE.nullish(),
    occurredAt: z.string().datetime({ offset: true }).nullish(),
    durationMinutes: z.number().int().min(0).max(1440).nullish(),
    checkin: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyM: z.number().min(0).optional(),
      })
      .nullish(),
    outcome: z.enum(["successful", "no_access", "rescheduled", "declined"]).nullish(),
    notes: z.string().max(10_000).nullish(),
    products: z
      .array(
        z.object({
          erpItemId: ERP_ID,
          keyMessage: z.string().max(2000).optional(),
          reaction: z.enum(["positive", "neutral", "negative", "not_discussed"]).optional(),
        }),
      )
      .max(50)
      .optional(),
  });

  /**
   * Records a visit. Upsert by the DEVICE-MINTED id, so a retried offline sync
   * collapses into the same row.
   *
   * The rep is always the CALLER — never taken from the body. Accepting a
   * `repProfileId` would let any rep file a visit as any other, and a call
   * report attributed to the wrong person is worse than a missing one.
   */
  router.add({
    method: "POST",
    pattern: "/v1/visits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(VisitBody, ctx.body);
      const p = ctx.principal;
      const result = await inTenant(deps, p, async (tx) => {
        const visit = await recordVisit(tx, p.tenantId, {
          id: input.id,
          repProfileId: p.repProfileId,
          erpAccountId: input.erpAccountId,
          erpContactId: input.erpContactId ?? null,
          ...(input.visitType !== undefined ? { visitType: input.visitType } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          plannedFor: input.plannedFor ?? null,
          occurredAt: input.occurredAt ?? null,
          durationMinutes: input.durationMinutes ?? null,
          checkin: input.checkin ?? null,
          outcome: input.outcome ?? null,
          notes: input.notes ?? null,
        });
        const products =
          input.products !== undefined
            ? await setVisitProducts(tx, p.tenantId, visit.id, input.products)
            : await getVisitProducts(tx, visit.id);
        return { visit, products };
      });
      return { status: 200, body: result };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/visits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const p = ctx.principal;
      const statusParam = ctx.query.getAll("status");
      const account = ctx.query.get("account");
      const rows = await inTenant(deps, p, async (tx) => {
        // Scoped to the caller's own visits by default. A manager's view of the
        // team is a separate, explicitly-authorised route rather than a flag on
        // this one — a filter that widens access is too easy to pass by accident.
        if (account !== null) await requireAccountAccess(tx, p, parse(ERP_ID, account));
        return listVisits(tx, {
          repProfileId: p.repProfileId,
          ...(account !== null ? { erpAccountId: account } : {}),
          ...(statusParam.length > 0
            ? { status: statusParam.map((s) => parse(z.enum(VISIT_STATUSES), s)) as VisitStatus[] }
            : {}),
          ...(ctx.query.get("from") !== null ? { from: ctx.query.get("from")! } : {}),
          ...(ctx.query.get("to") !== null ? { to: ctx.query.get("to")! } : {}),
          limit: 200,
        });
      });
      return { status: 200, body: { data: rows } };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/visits/:id",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const found = await inTenant(deps, p, async (tx) => {
        const visit = await getVisit(tx, id);
        if (visit === null) return null;
        // A visit belongs to the rep who made it. Reading someone else's is a
        // 404, not a 403: a 403 would confirm the visit exists.
        if (visit.rep_profile_id !== p.repProfileId) return null;
        return { visit, products: await getVisitProducts(tx, id) };
      });
      if (found === null) throw notFound(`visit ${id} not found`);
      return { status: 200, body: found };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/visits/:id/transition",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(
        z.object({
          to: z.enum(VISIT_STATUSES),
          occurredAt: z.string().datetime({ offset: true }).optional(),
          durationMinutes: z.number().int().min(0).max(1440).optional(),
          outcome: z.enum(["successful", "no_access", "rescheduled", "declined"]).nullish(),
          notes: z.string().max(10_000).optional(),
        }),
        ctx.body,
      );
      const p = ctx.principal;
      const visit = await inTenant(deps, p, async (tx) => {
        const existing = await getVisit(tx, id);
        if (existing === null || existing.rep_profile_id !== p.repProfileId) {
          throw notFound(`visit ${id} not found`);
        }
        return transitionVisit(tx, id, input.to, {
          ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
          ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
      });
      return { status: 200, body: { visit } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/visits/:id/notes",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const { note } = parse(z.object({ note: z.string().min(1).max(10_000) }), ctx.body);
      const p = ctx.principal;
      const visit = await inTenant(deps, p, async (tx) => {
        const existing = await getVisit(tx, id);
        if (existing === null || existing.rep_profile_id !== p.repProfileId) {
          throw notFound(`visit ${id} not found`);
        }
        return appendNote(tx, id, note, deps.now?.() ?? new Date());
      });
      return { status: 200, body: { visit } };
    },
  });

  // ---- offline sync -------------------------------------------------------

  /**
   * Flushes a device's queue in one request.
   *
   * PER-VISIT RESULTS, not all-or-nothing. A rep with twelve queued visits, one
   * of which references an account they no longer cover, must get the other
   * eleven accepted — a batch that rejects wholesale leaves the device retrying
   * forever and the rep's day unrecorded. Each visit is applied in its own
   * transaction so one failure cannot roll back its neighbours.
   */
  router.add({
    method: "POST",
    pattern: "/v1/sync/visits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const { visits } = parse(z.object({ visits: z.array(VisitBody).max(200) }), ctx.body);
      const p = ctx.principal;

      const results: Array<{ id: string; ok: boolean; error?: string; type?: string }> = [];
      for (const input of visits) {
        try {
          await inTenant(deps, p, async (tx) => {
            const visit = await recordVisit(tx, p.tenantId, {
              id: input.id,
              repProfileId: p.repProfileId,
              erpAccountId: input.erpAccountId,
              erpContactId: input.erpContactId ?? null,
              ...(input.visitType !== undefined ? { visitType: input.visitType } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              plannedFor: input.plannedFor ?? null,
              occurredAt: input.occurredAt ?? null,
              durationMinutes: input.durationMinutes ?? null,
              checkin: input.checkin ?? null,
              outcome: input.outcome ?? null,
              notes: input.notes ?? null,
            });
            if (input.products !== undefined) {
              await setVisitProducts(tx, p.tenantId, visit.id, input.products);
            }
          });
          results.push({ id: input.id, ok: true });
        } catch (err) {
          // The device needs to know WHICH failed and whether retrying helps, so
          // the problem kind travels with each row.
          const { toProblem } = await import("../problems.js");
          const problem = toProblem(err);
          results.push({ id: input.id, ok: false, type: problem.kind, error: problem.detail ?? problem.message });
        }
      }

      const accepted = results.filter((r) => r.ok).length;
      return {
        // 207-style semantics without inventing a status: 200 with per-row
        // outcomes, because the request itself succeeded even when rows did not.
        status: 200,
        body: { accepted, rejected: results.length - accepted, results },
      };
    },
  });

  // ---- call plans ---------------------------------------------------------

  router.add({
    method: "GET",
    pattern: "/v1/cycles",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, async (tx) =>
        on !== undefined ? [await cycleOn(tx, on)].filter((c) => c !== null) : await listCycles(tx),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The caller's own plans, and only those.
   *
   * A manager's view of their team's plans is a separate route with a separate
   * authorisation question (`crm.managed_territory_ids`), and inventing it here by
   * accepting a `?rep=` parameter is how one rep ends up reading another's targets.
   */
  router.add({
    method: "GET",
    pattern: "/v1/call-plans",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const cycleId = ctx.query.get("cycle");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        listPlans(tx, {
          repProfileId: ctx.principal.repProfileId,
          ...(cycleId !== null ? { cycleId: parse(UUID, cycleId) } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/call-plans/:id",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const plan = await requireVisiblePlan(tx, ctx.principal, id);
        return {
          ...plan,
          targets: await listTargets(tx, id),
          products: await listPlanProducts(tx, id),
        };
      });
      return { status: 200, body };
    },
  });

  /**
   * Planned versus actual, straight from `crm.call_plan_adherence`.
   *
   * Computed in SQL rather than here so a manager's report, an incentive run and this
   * route cannot disagree about what counts as a call. Both numbers are returned
   * because they answer different questions: coverage is "did we reach them at all",
   * attainment is "did we call as often as we said" — and a field force can look
   * compliant on the second while a third of its customers were never seen.
   */
  router.add({
    method: "GET",
    pattern: "/v1/call-plans/:id/adherence",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        await requireVisiblePlan(tx, ctx.principal, id);
        return { summary: await planSummary(tx, id), targets: await planAdherence(tx, id) };
      });
      return { status: 200, body };
    },
  });

  // ---- sample custody -----------------------------------------------------

  router.add({
    method: "GET",
    pattern: "/v1/samples/holdings",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        holdingsFor(tx, ctx.principal.repProfileId, { includeEmpty: ctx.query.get("all") === "true" }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Material the caller sent that nobody has accepted yet — the list a recall acts on.
   *
   * Sender-scoped in SQL (`crm.recallable_transfers`), not here: only the sender's
   * `quantity_in_transit` holds the material, so offering this to a receiver would be a
   * button the database refuses.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/transfers/recallable",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        recallableTransfers(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Material on its way to the caller that they have not accepted yet — the list an
   * accept acts on, and the mirror of `/recallable` above.
   *
   * Receiver-scoped in SQL (`crm.incoming_transfers`), for the same reason that one is
   * sender-scoped: only the receiver may accept, so offering this for a transfer the
   * caller SENT would be a button the database refuses. Before it existed, the receiving
   * half of a transfer was reachable only as a notification and as raw ids from
   * `GET /v1/samples/transfers`, so no screen could say what was being accepted.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/transfers/incoming",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        incomingTransfers(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Who a transfer can be addressed to: active reps in the caller's tenant, except the
   * caller.
   *
   * As wide as the write deliberately — `POST /v1/samples/transfers` accepts any rep in
   * the tenant, because 0017's only rule is a foreign key and
   * `counterparty_rep_profile_id <> rep_profile_id`. A narrower picker would restrict the
   * screen and not the system. The reasoning, and the one place it IS narrower (a
   * departed rep is not offered), is on `transferPeers`.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/transfer-peers",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const q = ctx.query.get("q");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        transferPeers(tx, ctx.principal.repProfileId, { query: q }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Take material back out of transit.
   *
   * Before this existed, a transfer nobody accepted left the quantity in the sender's
   * `quantity_in_transit` forever with no way out — the open item ADR-0001 carried
   * against sample custody. The recall is a new ledger row, never an edit: the material
   * went out and came back, and both halves stay in the log.
   *
   * `id` is device-minted like every other movement, so a replayed offline sync recalls
   * once. The principal supplies the rep; the database refuses an impostor rather than
   * this route deciding, so the sender-only rule has exactly one home.
   */
  /**
   * The depots a return may be addressed to.
   *
   * Mirrored from the ERP (`crm.warehouse_snapshot`, 0058) rather than proxied: a return is
   * recorded on a device that may be offline for hours, so a synchronous read of the ERP
   * inside that write would make the write depend on the ERP being up at drain time — the
   * one thing the outbox exists to avoid. The list is therefore as fresh as the snapshot,
   * which the scheduler refreshes every five minutes.
   *
   * Active only, because that is also what the write accepts. `?q=` matches the code or the
   * name; the cap is a screen limit, as on `/transfer-peers`.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/warehouses",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const q = ctx.query.get("q");
      const data = await inTenant(deps, ctx.principal, (tx) => listWarehouses(tx, { query: q }));
      return { status: 200, body: { data } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/samples/transfers/:id/recall",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const transferOfId = parse(UUID, ctx.params["id"]);
      const input = parse(
        z.object({
          id: UUID,
          occurredAt: z.string().datetime(),
          reason: z.string().max(500).nullish(),
        }),
        ctx.body,
      );
      const row = await inTenant(deps, ctx.principal, (tx) =>
        recallTransfer(tx, ctx.principal.tenantId, {
          id: input.id,
          transferOf: transferOfId,
          repProfileId: ctx.principal.repProfileId,
          occurredAt: new Date(input.occurredAt),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      );
      return { status: 201, body: row };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/samples/ledger",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const lot = ctx.query.get("lot");
      const limit = ctx.query.get("limit");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        ledgerFor(tx, {
          repProfileId: ctx.principal.repProfileId,
          ...(lot !== null ? { lotId: parse(UUID, lot) } : {}),
          ...(limit !== null ? { limit: parse(z.coerce.number().int().min(1).max(500), limit) } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * What the caller is holding that is about to expire.
   *
   * Expired stock in a rep's bag is the most common sample-audit finding there is, and
   * the ERP cannot express the question at all — it has no lot and no expiry.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/expiring",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const within = ctx.query.get("withinDays");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        expiringHoldings(tx, {
          repProfileId: ctx.principal.repProfileId,
          ...(within !== null ? { withinDays: parse(z.coerce.number().int().min(0).max(1000), within) } : {}),
          ...(onDate(ctx) !== undefined ? { asOf: onDate(ctx)! } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Records a hand-over to a prescriber.
   *
   * The id comes from the DEVICE: a rep hands samples over at a clinic desk with no
   * signal, and a retried sync must collapse into the same row rather than hand the
   * doctor's samples out twice in the record.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/disbursements",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(DisbursementBody, ctx.body);
      const row = await inTenant(deps, ctx.principal, (tx) => recordDisbursement(tx, ctx.principal, input));
      return { status: 201, body: row };
    },
  });

  /**
   * The rep confirms receipt of stock from a warehouse.
   *
   * The one movement that crosses into ERP-controlled stock, so this is the one route
   * that writes the outbox — the mirrored `StockMovement` (an `issue`, from the ERP's
   * side of the door) is enqueued in the SAME transaction. A receipt that committed
   * without its mirror would leave the ERP's warehouse balance permanently overstated.
   *
   * WORTH KNOWING: the rep declares this, rather than acknowledging an issue the
   * warehouse raised. The stronger model is warehouse-initiated with rep
   * acknowledgement, and it needs an admin surface that does not exist yet. What makes
   * the weaker one defensible meanwhile is that nothing here is editable — the ledger is
   * append-only, a correction needs a reason, and the cycle count reconciles against
   * physical stock.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/receipts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(ReceiptBody, ctx.body);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const lot = await getLot(tx, input.lotId);
        if (lot === null) throw notFound(`no sample lot ${input.lotId}`);
        // THE WAREHOUSE HAS TO EXIST. Until 0058 any id of the right shape was accepted
        // here, the movement was written, and the ERP refused the mirrored `StockMovement`
        // hours later from inside the relay queue — by which time the rep who named it is
        // long gone and the only remedy is a dead letter somebody must notice. The worse
        // case is an id that IS real and belongs to another site: the ERP accepts it and
        // posts against the wrong depot's balance, and nothing anywhere refuses it.
        await requireActiveWarehouse(tx, input.erpWarehouseId);
        const row = await receiveSamples(tx, ctx.principal.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: ctx.principal.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          erpWarehouseId: input.erpWarehouseId,
        });
        const mirror = await enqueueErpMirror(tx, ctx.principal.tenantId, row, lot);
        // `erpMirrorEnqueued` is the old field, unchanged. `erpMirror` is the rest, and the
        // reason it exists: a replayed movement that collapsed onto a DEAD outbox row is not
        // the harmless duplicate `enqueued: false` used to imply — the ERP will never hear
        // about this movement until somebody retries the write
        // (`GET /v1/erp-writes/failed`, then `POST /v1/erp-writes/:id/retry`). Still a 201,
        // and deliberately: the movement IS recorded here, the ledger is append-only, and a
        // 4xx would tell the rep their hand-over was not written when it was — which is the
        // lie, and the one that makes a device retry forever.
        return { ...row, erpMirrorEnqueued: mirror.enqueued, erpMirror: mirror };
      });
      return { status: 201, body };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/samples/transfers",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(TransferBody, ctx.body);
      const row = await inTenant(deps, ctx.principal, (tx) =>
        transferOut(tx, ctx.principal.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: ctx.principal.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          toRepProfileId: input.toRepProfileId,
        }),
      );
      return { status: 201, body: row };
    },
  });

  /**
   * Accepts a transfer sent to the caller.
   *
   * Quantity and lot come from the transfer, not the request: an acceptance that
   * disagreed with what was sent would not be an acceptance, and the database refuses
   * it anyway — this removes the chance to try.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/transfers/:id/accept",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const transferOfId = parse(UUID, ctx.params["id"]);
      const input = parse(AcceptBody, ctx.body);
      const row = await inTenant(deps, ctx.principal, (tx) =>
        acceptTransfer(tx, ctx.principal.tenantId, {
          id: input.id,
          transferOf: transferOfId,
          repProfileId: ctx.principal.repProfileId,
          occurredAt: new Date(input.occurredAt),
        }),
      );
      return { status: 201, body: row };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/samples/transfers",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        outstandingTransfers(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The offline flush for disbursements, with PER-ROW results.
   *
   * A rep's day produces a batch, and one bad row — an expired lot, an account that
   * moved territory — must not reject the other nineteen. Same shape as the visit sync,
   * for the same reason.
   */
  router.add({
    method: "POST",
    pattern: "/v1/sync/disbursements",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const { disbursements } = parse(
        z.object({ disbursements: z.array(DisbursementBody).max(200) }),
        ctx.body,
      );
      const p = ctx.principal;
      const results: Array<{ id: string; ok: boolean; error?: string; type?: string }> = [];

      for (const input of disbursements) {
        try {
          await inTenant(deps, p, (tx) => recordDisbursement(tx, p, input));
          results.push({ id: input.id, ok: true });
        } catch (err) {
          const { toProblem } = await import("../problems.js");
          const problem = toProblem(err);
          results.push({ id: input.id, ok: false, type: problem.kind, error: problem.detail ?? problem.message });
        }
      }

      const accepted = results.filter((r) => r.ok).length;
      return { status: 200, body: { accepted, rejected: results.length - accepted, results } };
    },
  });

  // ---- call plan lifecycle -------------------------------------------------

  /**
   * Creates a plan, for the caller or for a rep they supervise.
   *
   * A manager building a plan for a new rep is the case four-eyes exists for: the plan
   * is the rep's, the submission is the manager's, and the approval has to be someone
   * else's again. All three are recorded separately for exactly that reason.
   */
  router.add({
    method: "POST",
    pattern: "/v1/call-plans",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(PlanBody, ctx.body);
      const p = ctx.principal;
      const repProfileId = input.repProfileId ?? p.repProfileId;
      const plan = await inTenant(deps, p, async (tx) => {
        await requireSupervision(tx, p, repProfileId);
        return createPlan(tx, p.tenantId, { cycleId: input.cycleId, repProfileId });
      });
      return { status: 201, body: plan };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/targets",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const input = parse(TargetBody, ctx.body);
      const p = ctx.principal;
      const target = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return addTarget(tx, p.tenantId, {
          planId,
          erpAccountId: input.erpAccountId,
          targetCalls: input.targetCalls,
          erpContactId: input.erpContactId ?? null,
          segment: input.segment ?? null,
          notes: input.notes ?? null,
        });
      });
      return { status: 201, body: target };
    },
  });

  router.add({
    method: "DELETE",
    pattern: "/v1/call-plans/:id/targets/:targetId",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const targetId = parse(UUID, ctx.params["targetId"]);
      const p = ctx.principal;
      const removed = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return removeTarget(tx, targetId);
      });
      if (!removed) throw notFound(`no target ${targetId}`);
      return { status: 204 };
    },
  });

  /** Replaces the product emphasis wholesale; positions come from the array order. */
  router.add({
    method: "PUT",
    pattern: "/v1/call-plans/:id/products",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const { products } = parse(PlanProductsBody, ctx.body);
      const p = ctx.principal;
      const data = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return setPlanProducts(
          tx,
          p.tenantId,
          planId,
          products.map((pr) => ({ erpItemId: pr.erpItemId, keyMessage: pr.keyMessage ?? null })),
        );
      });
      return { status: 200, body: { data } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/submit",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const plan = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return submitPlan(tx, planId, p.repProfileId);
      });
      return { status: 200, body: plan };
    },
  });

  /**
   * Approves a plan.
   *
   * Nothing is checked here beyond "may the caller see this plan" — the three rules that
   * matter are in the database: the approver is not the rep (CHECK), not the submitter
   * (CHECK), and manages a territory the rep is assigned to (trigger). Re-implementing
   * them in the route would give the offline path and this one two different answers.
   */
  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/approve",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const note = parse(z.object({ note: z.string().max(2000).nullish() }), ctx.body ?? {});
      const p = ctx.principal;
      const plan = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return approvePlan(tx, planId, p.repProfileId, { note: note.note ?? null });
      });
      return { status: 200, body: plan };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/return",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const plan = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return returnPlanToDraft(tx, planId);
      });
      return { status: 200, body: plan };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/withdraw",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const plan = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return withdrawPlan(tx, planId);
      });
      return { status: 200, body: plan };
    },
  });

  /**
   * The only way to change an approved plan. Both rows stay in the record.
   *
   * Deliberately NOT privileged: a rep may supersede their own approved plan. It
   * destroys nothing — the original stays, with its approval intact, and the replacement
   * is a draft that needs the same four-eyed approval again. What a rep cannot do is
   * edit an approved plan or make one disappear, and neither becomes possible here.
   */
  router.add({
    method: "POST",
    pattern: "/v1/call-plans/:id/supersede",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const planId = parse(UUID, ctx.params["id"]);
      const input = parse(z.object({ copyTargets: z.boolean().optional() }), ctx.body ?? {});
      const p = ctx.principal;
      const body = await inTenant(deps, p, async (tx) => {
        await requireVisiblePlan(tx, p, planId);
        return supersedePlan(tx, p.tenantId, planId, {
          ...(input.copyTargets !== undefined ? { copyTargets: input.copyTargets } : {}),
        });
      });
      return { status: 201, body };
    },
  });

  // ---- cycle counts -------------------------------------------------------

  /**
   * Opens a count of a rep's bag.
   *
   * `countedBy` is always the caller and `repProfileId` defaults to them, so a
   * self-count and a supervised one go through the same route and the difference stays
   * visible in the data — which is what a reviewer needs, since a self-count is the
   * weaker evidence.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/counts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(CountBody, ctx.body);
      const p = ctx.principal;
      const repProfileId = input.repProfileId ?? p.repProfileId;
      const count = await inTenant(deps, p, async (tx) => {
        await requireSupervision(tx, p, repProfileId);
        return openCount(tx, p.tenantId, {
          ...(input.id !== undefined ? { id: input.id } : {}),
          repProfileId,
          countedBy: p.repProfileId,
          countedAt: new Date(input.countedAt),
          note: input.note ?? null,
        });
      });
      return { status: 201, body: count };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/samples/counts/:id/lines",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const countId = parse(UUID, ctx.params["id"]);
      const input = parse(CountLineBody, ctx.body);
      const p = ctx.principal;
      const line = await inTenant(deps, p, async (tx) => {
        await requireOwnOrSupervisedCount(tx, p, countId);
        return recordCountLine(tx, p.tenantId, {
          countId,
          lotId: input.lotId,
          countedQuantity: input.countedQuantity,
          ...(input.deviceExpectedQuantity !== undefined && input.deviceExpectedQuantity !== null
            ? { deviceExpectedQuantity: input.deviceExpectedQuantity }
            : {}),
        });
      });
      return { status: 201, body: line };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/samples/counts/:id",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const countId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const body = await inTenant(deps, p, async (tx) => {
        const count = await requireOwnOrSupervisedCount(tx, p, countId);
        return { ...count, lines: await countLines(tx, countId) };
      });
      return { status: 200, body };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/samples/counts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const rep = ctx.query.get("rep");
      const p = ctx.principal;
      const data = await inTenant(deps, p, async (tx) => {
        const repProfileId = rep !== null ? parse(UUID, rep) : p.repProfileId;
        await requireSupervision(tx, p, repProfileId);
        return listCounts(tx, { repProfileId });
      });
      return { status: 200, body: { data } };
    },
  });

  /**
   * Commits the count: one adjustment per variance, written through the ledger.
   *
   * Returns how many were written, because that number is the finding — a count that
   * produced three adjustments is a different conversation from one that produced none.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/counts/:id/commit",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const countId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const adjustments = await inTenant(deps, p, async (tx) => {
        await requireOwnOrSupervisedCount(tx, p, countId);
        return commitCount(tx, countId);
      });
      return { status: 200, body: { adjustments } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/samples/counts/:id/cancel",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const countId = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      await inTenant(deps, p, async (tx) => {
        await requireOwnOrSupervisedCount(tx, p, countId);
        await cancelCount(tx, countId);
      });
      return { status: 204 };
    },
  });

  // ---- manager views ------------------------------------------------------

  /**
   * The team roster.
   *
   * Empty for a rep with no manager assignment, which is the correct answer rather than
   * a 403: "you supervise nobody" is a fact about the hierarchy, not a refusal.
   */
  router.add({
    method: "GET",
    pattern: "/v1/team",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) => teamRoster(tx, ctx.principal.repProfileId, on));
      return { status: 200, body: { data } };
    },
  });

  /**
   * The team's plans — and with `?status=submitted`, the manager's approval queue.
   *
   * Scoped inside the SQL by `crm.managed_rep_ids`, not by filtering afterwards on a
   * rep id the caller supplied: a `?rep=` the route forgets to check is one `AND` away
   * from a peer's plans.
   */
  router.add({
    method: "GET",
    pattern: "/v1/team/call-plans",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const cycle = ctx.query.get("cycle");
      const status = ctx.query.get("status");
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamPlans(tx, ctx.principal.repProfileId, {
          ...(cycle !== null ? { cycleId: parse(UUID, cycle) } : {}),
          ...(status !== null ? { status: parse(PLAN_STATUS, status) } : {}),
          ...(on !== undefined ? { on } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The territory review: one row per rep for one cycle.
   *
   * A rep with no plan appears with nulls rather than being left out — "who has not got
   * a plan" is the first question this screen is opened to answer.
   */
  router.add({
    method: "GET",
    pattern: "/v1/team/adherence",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const cycle = ctx.query.get("cycle");
      if (cycle === null) throw validationFailed("a cycle is required", { cycle: "required" });
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamAdherence(tx, ctx.principal.repProfileId, parse(UUID, cycle), on),
      );
      return { status: 200, body: { data } };
    },
  });

  /** Expiring stock across the team — the compliance screen. */
  router.add({
    method: "GET",
    pattern: "/v1/team/samples/expiring",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const within = ctx.query.get("withinDays");
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamExpiringHoldings(tx, ctx.principal.repProfileId, {
          ...(within !== null ? { withinDays: parse(z.coerce.number().int().min(0).max(1000), within) } : {}),
          ...(on !== undefined ? { asOf: on } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Custody exposure per rep, ordered by whose bag has gone longest without a count.
   *
   * The count document only earns its keep if someone can see whose count is overdue;
   * a rep never counted sorts first, ahead of one counted long ago.
   */
  router.add({
    method: "GET",
    pattern: "/v1/team/samples/exposure",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamExposure(tx, ctx.principal.repProfileId, { ...(on !== undefined ? { asOf: on } : {}) }),
      );
      return { status: 200, body: { data } };
    },
  });

  /** One rep's custody ledger, for an audit. */
  router.add({
    method: "GET",
    pattern: "/v1/team/samples/ledger",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const rep = ctx.query.get("rep");
      if (rep === null) throw validationFailed("a rep is required", { rep: "required" });
      const p = ctx.principal;
      const data = await inTenant(deps, p, async (tx) => {
        const repProfileId = parse(UUID, rep);
        await requireSupervision(tx, p, repProfileId, onDate(ctx));
        return ledgerFor(tx, { repProfileId });
      });
      return { status: 200, body: { data } };
    },
  });

  /** One rep's visits, for an activity review. */
  router.add({
    method: "GET",
    pattern: "/v1/team/visits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const rep = ctx.query.get("rep");
      if (rep === null) throw validationFailed("a rep is required", { rep: "required" });
      const p = ctx.principal;
      const data = await inTenant(deps, p, async (tx) => {
        const repProfileId = parse(UUID, rep);
        await requireSupervision(tx, p, repProfileId, onDate(ctx));
        return listVisits(tx, { repProfileId, limit: 200 });
      });
      return { status: 200, body: { data } };
    },
  });

  // ---- getting expired stock out of custody -------------------------------

  /**
   * Records a destruction or an expiry write-off.
   *
   * The resolution path for a disposal obligation, and the reason the nightly sweep does
   * not write stock off by itself: the material leaves custody when a PERSON says it did,
   * with a reason attached. `destruction` and `expiry_writeoff` are kept apart on purpose
   * — one says it was destroyed, the other that it stopped being counted — and a reader
   * who needs to tell those apart can.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/write-offs",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(WriteOffBody, ctx.body);
      const p = ctx.principal;
      const row = await inTenant(deps, p, (tx) =>
        writeOff(tx, p.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: p.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          kind: input.kind,
          reason: input.reason,
        }),
      );
      return { status: 201, body: row };
    },
  });

  /**
   * Returns material to a warehouse — the other resolution path, and the better one for
   * stock a warehouse can dispose of centrally.
   *
   * Mirrors to the ERP as a `receipt`, since the stock re-enters ERP-controlled inventory.
   * The inversion is the same one the receipt route has, in the other direction.
   */
  router.add({
    method: "POST",
    pattern: "/v1/samples/returns",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(ReturnBody, ctx.body);
      const p = ctx.principal;
      const body = await inTenant(deps, p, async (tx) => {
        const lot = await getLot(tx, input.lotId);
        if (lot === null) throw notFound(`no sample lot ${input.lotId}`);
        // Same check as the receipt, and the reason it is here rather than in a CHECK
        // constraint or a foreign key is 0058's: the snapshot is a mirror whose rows a full
        // sweep can retract, and the append-only ledger must not depend referentially on a
        // table another system can empty. A movement keeps its destination for ever; this
        // answers only whether it may be written now.
        await requireActiveWarehouse(tx, input.erpWarehouseId);
        const row = await returnToWarehouse(tx, p.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: p.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          erpWarehouseId: input.erpWarehouseId,
          reason: input.reason ?? null,
        });
        const mirror = await enqueueErpMirror(tx, p.tenantId, row, lot);
        // `erpMirrorEnqueued` is the old field, unchanged. `erpMirror` is the rest, and the
        // reason it exists: a replayed movement that collapsed onto a DEAD outbox row is not
        // the harmless duplicate `enqueued: false` used to imply — the ERP will never hear
        // about this movement until somebody retries the write
        // (`GET /v1/erp-writes/failed`, then `POST /v1/erp-writes/:id/retry`). Still a 201,
        // and deliberately: the movement IS recorded here, the ledger is append-only, and a
        // 4xx would tell the rep their hand-over was not written when it was — which is the
        // lie, and the one that makes a device retry forever.
        return { ...row, erpMirrorEnqueued: mirror.enqueued, erpMirror: mirror };
      });
      return { status: 201, body };
    },
  });

  /** What the caller must dispose of, soonest deadline first. */
  router.add({
    method: "GET",
    pattern: "/v1/samples/obligations",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        openObligations(tx, ctx.principal.repProfileId, { ...(on !== undefined ? { asOf: on } : {}) }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The tenant's disposal policy, read-only.
   *
   * Read is open because every rep is subject to it and ought to be able to see the deadline
   * they are held to. The write is `PUT /v1/admin/samples/disposal-policy` and needs the
   * `compliance` role — this comment used to say there was no write route and that the
   * parameters were set "by an administrator in SQL", which was true until 0023 built the
   * role model and stopped being true the day it landed.
   *
   * It answers the PROVENANCE as well as the values (0059): "30 days" is not an answer to
   * "what am I held to" without who set it, when, and why. All four are null for a tenant
   * that has never changed anything, which is a fact — the policy is the shipped default and
   * nobody set it — rather than missing data.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/disposal-policy",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const body = await inTenant(deps, ctx.principal, (tx) =>
        disposalPolicyDetail(tx, ctx.principal.tenantId),
      );
      return { status: 200, body };
    },
  });

  /**
   * How the policy got to where it is: every change, newest first.
   *
   * Open to every rep, for the same reason the policy is. The grace period is a commitment
   * they are measured against, and "it was thirty days until last Tuesday" is part of
   * knowing what you were held to in March — which is precisely the question an SOP
   * parameter attracts and the one this history exists to answer.
   *
   * Nothing here is a secret within the tenant: the values are already readable, and who
   * holds the `compliance` role is readable at `GET /v1/admin/roles` by an administrator and
   * visible on every change here by anyone. That is the intended arrangement for a rule
   * everybody is bound by, not an oversight.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/disposal-policy/history",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const limit = parse(
        z.coerce.number().int().min(1).max(POLICY_HISTORY_LIMIT).optional(),
        ctx.query.get("limit") ?? undefined,
      );
      const data = await inTenant(deps, ctx.principal, (tx) =>
        disposalPolicyHistory(tx, ctx.principal.tenantId, { ...(limit !== undefined ? { limit } : {}) }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The full obligation history for one (rep, lot) — the audit chain, over HTTP.
   *
   * 0030 made a disposal deadline survive the material leaving and coming back: rather
   * than raising a fresh obligation with a later `due_by`, the sweep inserts a
   * CONTINUATION row inheriting `discovered_on` and `due_by` verbatim and naming the row
   * it continues. That makes the record correct and makes it a CHAIN, and a chain nobody
   * can read is not a record — until now it existed only in SQL
   * (`crm.disposal_obligation_chain`), reachable by someone with a psql prompt.
   *
   * It answers both questions an inspector asks, separately: each link's own resolution
   * (`transferred`, `destroyed`, …) and the LEDGER's word for the movement that
   * discharged it (`resolving_transaction_kind`, joined from `crm.sample_transaction`) —
   * so "the obligation was settled" and "the stock went away and came back" stay
   * distinguishable.
   *
   * Ordered by the chain walk, not by time. Two obligations written in one transaction —
   * which a catch-up sweep produces — share `created_at` to the microsecond, because
   * `now()` is the transaction clock; the walk is the only ordering that exists.
   *
   * Scoped through `canSupervise`, which answers yes for the caller themselves, so one
   * route serves "my lot" and "my rep's lot". A 404 for anyone else: whether another
   * rep has an expired lot is information about their compliance record.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/obligations/:lotId/history",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const lotId = parse(UUID, ctx.params["lotId"]);
      const forRep = ctx.query.get("repProfileId");
      const data = await inTenant(deps, ctx.principal, async (tx) => {
        const rep = forRep === null ? ctx.principal.repProfileId : parse(UUID, forRep);
        if (rep !== ctx.principal.repProfileId) await requireSupervision(tx, ctx.principal, rep);
        return disposalHistory(tx, rep, lotId);
      });
      return { status: 200, body: { data } };
    },
  });

  /** Outstanding disposals across the team — the compliance chase list. */
  router.add({
    method: "GET",
    pattern: "/v1/team/samples/obligations",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamObligations(tx, ctx.principal.repProfileId, { ...(on !== undefined ? { asOf: on } : {}) }),
      );
      return { status: 200, body: { data } };
    },
  });

  // ---- the inbox ----------------------------------------------------------

  /**
   * What the caller has been told, newest first.
   *
   * Every notification is addressed to one rep, so there is no scoping decision to get
   * wrong here — `recipient_rep_profile_id` IS the authorisation.
   */
  router.add({
    method: "GET",
    pattern: "/v1/notifications",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const unreadOnly = ctx.query.get("unread") === "true";
      const limit = ctx.query.get("limit");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        inbox(tx, ctx.principal.repProfileId, {
          unreadOnly,
          ...(limit !== null ? { limit: parse(z.coerce.number().int().min(1).max(200), limit) } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The unread count — an actual count of an actual column.
   *
   * The ERP cannot answer this: it keeps no per-user read state, so its "unread" is a
   * recency approximation that goes wrong as soon as someone reads on two devices.
   */
  router.add({
    method: "GET",
    pattern: "/v1/notifications/unread-count",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const count = await inTenant(deps, ctx.principal, (tx) =>
        unreadCount(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { count } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/notifications/read-all",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const marked = await inTenant(deps, ctx.principal, (tx) =>
        markAllRead(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { marked } };
    },
  });

  /**
   * Marks one read. Idempotent, and keeps the FIRST read timestamp: when they saw it is
   * the fact worth keeping, not when they last tapped it.
   */
  router.add({
    method: "POST",
    pattern: "/v1/notifications/:id/read",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const ok = await inTenant(deps, ctx.principal, (tx) => markRead(tx, ctx.principal.repProfileId, id));
      // A 404 rather than a 403: whether a notification exists is itself information about
      // someone else's work.
      if (!ok) throw notFound(`no notification ${id}`);
      return { status: 204 };
    },
  });

  // ---- writes the ERP refused ---------------------------------------------

  /**
   * The caller's writes that will never reach the ERP.
   *
   * Named for what it means to a rep rather than for the table behind it: they do not know
   * what an outbox is, they know they recorded something and it did not arrive.
   */
  router.add({
    method: "GET",
    pattern: "/v1/erp-writes/failed",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        deadLetters(tx, { repProfileId: ctx.principal.repProfileId }),
      );
      return { status: 200, body: { data } };
    },
  });

  /** The team's, for a manager — most causes are theirs or an administrator's to fix. */
  router.add({
    method: "GET",
    pattern: "/v1/team/erp-writes/failed",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) =>
        teamDeadLetters(tx, ctx.principal.repProfileId),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Queues a failed write to be tried again.
   *
   * Re-sends the SAME payload, which is the useful thing when the ERP side has changed — a
   * ledger account created, a permission granted, a parent record that now exists — and
   * useless when the payload itself is wrong, in which case it dies again and `revive_count`
   * says so. It is not an edit, and the route does not pretend otherwise.
   *
   * Allowed for the caller's own writes and for a supervised rep's: a 404 for anyone else,
   * since whether a failed write exists is information about someone's work.
   */
  router.add({
    method: "POST",
    pattern: "/v1/erp-writes/:id/retry",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const body = await inTenant(deps, p, async (tx) => {
        const target = await deadLetter(tx, id);
        // A 404 for a row that is not dead, not this rep's, or produced by a table that
        // cannot be attributed to a rep at all — in the last case nobody was notified
        // either, and an operator reaches it through the SQL listing rather than here.
        if (
          target === null ||
          target.rep_profile_id === null ||
          !(await canSupervise(tx, p.repProfileId, target.rep_profile_id))
        ) {
          throw notFound(`no failed ERP write ${id}`);
        }
        const revived = await reviveDeadLetter(tx, id, p.repProfileId);
        if (!revived) throw new ApiError("conflict", `failed ERP write ${id} is no longer dead`);
        return { id, queued: true, reviveCount: target.revive_count + 1 };
      });
      return { status: 200, body };
    },
  });

  /**
   * Why a write kept failing — one row's whole death history, oldest first.
   *
   * `revive_count` says a retry has already been pressed; it does not say whether pressing
   * it again is worth anything. These two answers are different conversations and the
   * number cannot tell them apart: "died because the ledger account was missing, somebody
   * created it, died again because the period was locked" is progress, and "died twice
   * because the ledger account is still missing" is the button being pressed instead of the
   * cause being fixed. The summary names which shape this is.
   *
   * Authorised like the retry — the caller's own writes and a supervised rep's — but NOT
   * through `deadLetter`, whose `state = 'dead'` predicate would make the history
   * unreadable the moment a revive succeeded, which is the one moment it is most worth
   * reading. `outboxLetterOwner` answers without a state predicate; the state is reported
   * rather than used as a gate.
   *
   * A 404 when the queue row is gone. `crm.outbox_dead_letter` outlives it on purpose
   * (0036), so the history may well still be there — but nothing attributes it to a rep any
   * more, and guessing is not attribution. Those rows are reached through the tenant-wide
   * listing below.
   */
  router.add({
    method: "GET",
    pattern: "/v1/erp-writes/:id/history",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const p = ctx.principal;
      const body = await inTenant(deps, p, async (tx) => {
        const owner = await outboxLetterOwner(tx, id);
        if (
          owner === null ||
          owner.rep_profile_id === null ||
          !(await canSupervise(tx, p.repProfileId, owner.rep_profile_id))
        ) {
          throw notFound(`no failed ERP write ${id}`);
        }
        const data = await attemptHistory(tx, id);
        // An empty history for a row that exists is not a 404: it means this write has
        // never died, which is a true and useful answer and is not the same as "no such
        // write". The state is what distinguishes them, so it is in the body.
        return { id, state: owner.state, summary: summariseAttemptHistory(data), data };
      });
      return { status: 200, body };
    },
  });

  // ---- administration -----------------------------------------------------
  //
  // Everything below requires a ROLE (0023), not supervision. A first-line manager
  // reads their team's data and configures nothing: the parameters here bind the whole
  // tenant, including the manager's own numbers, so "supervises at least one rep" is
  // precisely the wrong gate. Each route states which role it needs and gets it from
  // the principal, resolved once per request as of today.

  /**
   * Who holds which role. Readable by any rep, deliberately.
   *
   * A rep who has been told to ask an administrator needs to know who that is, and the
   * answer is a name and a role — not a permission. Hiding it would make the system
   * unoperable without making it safer, since the grant itself is what confers power.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/roles",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const roleFilter = ctx.query.get("role");
      const includeEnded = ctx.query.get("includeEnded") === "true";
      if (roleFilter !== null && !(ROLES as readonly string[]).includes(roleFilter)) {
        throw validationFailed("unknown role", { role: `expected one of ${ROLES.join(", ")}` });
      }
      const data = await inTenant(deps, ctx.principal, (tx) =>
        listGrants(tx, ctx.principal.tenantId, {
          ...(roleFilter !== null ? { role: roleFilter as Role } : {}),
          ...(on !== undefined ? { asOf: on } : {}),
          includeEnded,
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /** The role the caller holds, so a client can decide which admin screens to show. */
  router.add({
    method: "GET",
    pattern: "/v1/me/roles",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      return { status: 200, body: { roles: ctx.principal.roles } };
    },
  });

  /**
   * Grant a role. Administrator only, and never to oneself — the database refuses that
   * and this route does not pre-empt it, so the four-eyes rule has exactly one home.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/roles",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          repProfileId: UUID,
          role: z.enum(ROLES),
          validFrom: ISO_DATE.optional(),
          validTo: ISO_DATE.nullish(),
          reason: z.string().max(500).nullish(),
        }),
        ctx.body,
      );
      const body = await inTenant(deps, ctx.principal, (tx) =>
        grantRole(tx, ctx.principal.tenantId, {
          repProfileId: input.repProfileId,
          role: input.role,
          grantedBy: ctx.principal.repProfileId,
          ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
          ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      );
      return { status: 201, body };
    },
  });

  /**
   * End a grant. A POST rather than a DELETE because nothing is deleted — the grant
   * stays, with an end date and a revoker, and that is the whole point of the table.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/roles/:id/revoke",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(
        z.object({ on: ISO_DATE.optional(), reason: z.string().max(500).nullish() }),
        ctx.body ?? {},
      );
      const body = await inTenant(deps, ctx.principal, (tx) =>
        revokeRole(tx, ctx.principal.tenantId, id, {
          revokedBy: ctx.principal.repProfileId,
          ...(input.on !== undefined ? { on: input.on } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      );
      // A grant in another tenant is indistinguishable from a nonexistent one, which is
      // the right answer: a grant id is not a probe into other tenants. The tenant is
      // matched in SQL rather than left to RLS — see crm.revoke_rep_role.
      if (body === null) throw notFound(`no role grant ${id}`);
      return { status: 200, body };
    },
  });

  /**
   * The administrators a tenant currently has.
   *
   * Separate from the grant list because the operational question is "is this tenant
   * still administrable", and the database refuses to let the answer reach zero.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/roles/administrators",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const on = onDate(ctx);
      const data = await inTenant(deps, ctx.principal, (tx) => roleHolders(tx, "administrator", on));
      return { status: 200, body: { data } };
    },
  });

  /**
   * Every recent death in the tenant, latest first — including the orphans.
   *
   * `GET /v1/erp-writes/failed` and its team sibling answer "what is dead right now" by
   * joining `crm.outbox`, so a row that died, was revived and then delivered has left them,
   * and so has one whose queue row was deleted. This reads the history table alone, so
   * neither disappears — which makes it the only way to reach a history that nothing
   * attributes to a rep, and the reason the per-row route can afford to 404 on one.
   *
   * ADMINISTRATOR, not supervision. The gate is not "is this your rep's write": the listing
   * is tenant-wide by construction and contains writes from every rep and from producing
   * tables that map to no rep at all. A first-line manager reads their team's failures
   * through the team route; this is the operator's view of the queue itself.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/erp-writes/deaths",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const limit = parse(z.coerce.number().int().min(1).max(500), ctx.query.get("limit") ?? "100");
      const data = await inTenant(deps, ctx.principal, (tx) => recentDeaths(tx, { limit }));
      return { status: 200, body: { data } };
    },
  });

  /**
   * Set the disposal policy. COMPLIANCE, not administrator.
   *
   * These are the SOP parameters every rep is measured against — the grace period they
   * get before an obligation goes overdue, and whether promotional material may be
   * written off by a job at all. A changed grace period never rewrites a deadline that
   * has already been communicated: 0020 copies it onto each obligation at discovery.
   *
   * A REASON IS REQUIRED (0059). The role model answered who may change this; it left the
   * record of WHAT HAPPENED exactly where 0023 found it — an `UPDATE … SET grace_days = 7`
   * that moved `updated_at` and nothing else, so a policy loosened last Tuesday by somebody
   * who has since lost the role looked identical to one that had stood for a year. The write
   * is now an INSERT into an append-only log that the policy row is a projection of, and the
   * author comes from the token rather than the body, like every other attributed write
   * here.
   *
   * NOT FOUR-EYED FOR THE GRACE PERIOD, and four-eyed for the switch (0062). A tenant with
   * one compliance officer must be able to set its own grace period, which is 0059's
   * reasoning and still holds; arming `auto_writeoff_promo` is the one setting here that
   * lets a scheduled job remove material from a balance with no person involved, and one
   * officer should not do that alone. Turning it OFF takes one signature, because that only
   * ever means a person must record each write-off.
   *
   * So this route has two answers. A change nobody needs to approve is applied and comes
   * back 200, as it always has. A change that needs a second signature is RECORDED AS A
   * PROPOSAL and comes back 202 with it — not refused, because a refusal would leave the
   * officer with nothing to do but try again, and not applied, because that is the whole
   * rule. The read of the live policy before either is what makes the choice honest: the
   * rule is about what MOVES, so a request restating a switch that is already on is not an
   * arming and must not be sent for approval.
   */
  router.add({
    method: "PUT",
    pattern: "/v1/admin/samples/disposal-policy",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "compliance");
      const input = parse(
        z.object({
          graceDays: z.number().int().min(0).max(365).optional(),
          autoWriteoffPromo: z.boolean().optional(),
          // Ten characters, matching the column's own CHECK — enough to stop `.` and not
          // enough to pretend prose is guaranteed. Validated here as well as there so the
          // refusal is a 422 naming the field rather than a translated constraint.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      if (input.graceDays === undefined && input.autoWriteoffPromo === undefined) {
        throw validationFailed("nothing to change", { _: "supply graceDays, autoWriteoffPromo, or both" });
      }

      const decided = await inTenant(deps, ctx.principal, async (tx) => {
        const current = await disposalPolicyDetail(tx, ctx.principal.tenantId);
        // What would actually MOVE, in the database's own column names, because that is what
        // `crm.four_eyes_rule` is written against and what the trigger will ask about. A
        // request that restates a value already in force moves nothing, and asking about the
        // whole request rather than the delta is how a grace-period change ends up waiting
        // for a second officer because the switch happened to be on.
        const moving: Record<string, unknown> = {};
        if (input.graceDays !== undefined && input.graceDays !== current.grace_days) {
          moving["grace_days"] = input.graceDays;
        }
        if (
          input.autoWriteoffPromo !== undefined &&
          input.autoWriteoffPromo !== current.auto_writeoff_promo
        ) {
          moving["auto_writeoff_promo"] = input.autoWriteoffPromo;
        }
        const needed = await fourEyesRequired(tx, "disposal_policy", moving);
        return { moving, needed };
      });

      if (decided.needed.length > 0) {
        const proposed = await inTenant(deps, ctx.principal, async (tx) => {
          const result = await proposeConfigChange(tx, ctx.principal.tenantId, {
            tableName: "disposal_policy",
            // The policy keys on the tenant alone, which is the whole of its primary key.
            rowKey: { tenant_id: ctx.principal.tenantId },
            changes: decided.moving,
            proposedBy: ctx.principal.repProfileId,
            reason: input.reason,
          });
          // THE SAME FUNCTION THE SWEEP CALLS (0063), scoped to the proposal just made.
          //
          // 0062 had the store return the people who should be told and told them here, which
          // meant the immediate notice and the scheduled catch-up were two pieces of code
          // writing two sentences about one fact. There is one sentence now, and a route that
          // forgot this call would be a route not calling an obvious function rather than a
          // route ignoring a returned list.
          await notifyPendingApprovals(tx, ctx.principal.tenantId, {
            onlyProposalId: result.proposal.id,
          });
          return result.proposal;
        });
        return { status: 202, body: proposed };
      }

      const body = await inTenant(deps, ctx.principal, (tx) =>
        setDisposalPolicy(tx, ctx.principal.tenantId, {
          ...(input.graceDays !== undefined ? { graceDays: input.graceDays } : {}),
          ...(input.autoWriteoffPromo !== undefined ? { autoWriteoffPromo: input.autoWriteoffPromo } : {}),
          changedBy: ctx.principal.repProfileId,
          reason: input.reason,
        }),
      );
      return { status: 200, body };
    },
  });

  // ---- attachments ------------------------------------------------------------
  //
  // Signature captures and expense receipts (0033). Two things shape every route here.
  //
  // FOUR EYES DOES NOT APPLY, and reaching for it would be the exact inverse of the bug it
  // was written for. `requireExpenseApprover` exists because approving, rejecting, posting
  // and reimbursing decide whether a rep gets paid, so the actor must not be the claimant.
  // Attaching EVIDENCE approves nothing, posts nothing and moves no money — and a rep must
  // be able to upload their own receipt and their own signature capture, which is the
  // whole point. Supervision-including-self is the correct gate, which is what
  // `crm.attachment_readable_by` already gives through `crm.rep_can_supervise`.
  //
  // THE READS NEED NO ROUTE-LEVEL GATE, and that is not an omission. Each read function
  // takes a reader and scopes itself inside the query: `requireAttachment` answers 404 for
  // "no such thing" and for "not yours" alike, and `listAttachmentsForSubject` returns an
  // EMPTY SET to a reader with no claim rather than everything. Whether a colleague holds a
  // named doctor's signature is itself information about that colleague's work, so one
  // answer for both is deliberate.
  //
  // And no route takes `?on=`. A write is judged on the day it happened; a DISCLOSURE is
  // judged on who is accountable now, or backdating would give the manager who has since
  // left the district continuing access to its personal data. The store no longer accepts
  // a date, so `onDate(ctx)` must not be plumbed into any handler below.
  const blobStore = new PostgresBlobStore();

  const ATTACHMENT_BODY = z.object({
    // Device-minted, like a visit and a disbursement: a signature is captured at a clinic
    // desk with no signal, so the upload is retried and the retry must collapse.
    id: UUID,
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    contentBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  });

  // There is deliberately no `sha256` and no `subjectTable` field. The digest is computed
  // from the bytes by the store and recomputed from the STORED octets by a trigger; a
  // client-supplied hash checked against client-supplied bytes proves only that the client
  // can run sha256. The subject table is derived from the purpose, so a receipt cannot be
  // attached to a ledger row by passing a mismatched pair.

  /** The signature for a disbursement. */
  router.add({
    method: "POST",
    pattern: "/v1/samples/disbursements/:id/signature",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const subjectId = parse(UUID, ctx.params["id"]);
      const input = parse(ATTACHMENT_BODY, ctx.body);
      const content = decodeAttachmentContent(input.contentBase64);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        // 404 BEFORE the trigger's 403, and that order is the point: the trigger refuses an
        // unentitled uploader with a sentence that confirms the disbursement exists and
        // names its rep. The existence of another rep's disbursement is information about
        // their work, so the route answers first and the trigger is the backstop.
        const owner = await attachmentSubjectOwner(tx, ctx.principal.tenantId, "disbursement_signature", subjectId);
        // One refusal, naming the DISBURSEMENT and never the rep who owns it.
        // `requireSupervision` would be the obvious call here and is wrong: its message is
        // "no rep <id> on your team", which hands a caller who guessed a disbursement id
        // the id of the rep who holds it. The 404 exists to conceal exactly that, so the
        // predicate is reused and the sentence is not.
        if (owner === null || !(await canSupervise(tx, ctx.principal.repProfileId, owner))) {
          throw notFound(`no sample disbursement ${subjectId} on your team`);
        }
        return putAttachment(tx, ctx.principal.tenantId, blobStore, {
          id: input.id,
          purpose: "disbursement_signature",
          subjectId,
          contentType: input.contentType,
          content,
          uploadedBy: ctx.principal.repProfileId,
        });
      });
      return { status: 201, body };
    },
  });

  /** Every signature captured for one disbursement. Normally one; a chain if ever retaken. */
  router.add({
    method: "GET",
    pattern: "/v1/samples/disbursements/:id/signature",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const subjectId = parse(UUID, ctx.params["id"]);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        listAttachmentsForSubject(tx, ctx.principal.tenantId, {
          readBy: ctx.principal.repProfileId,
          purpose: "disbursement_signature",
          subjectId,
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * A receipt for an expense claim, and the one rule the schema does not hold.
   *
   * Nothing in `crm.attachment_validate` reads `crm.expense_claim.state`, so the database
   * will let a rep swap the current receipt on a claim that is already approved, posted or
   * reimbursed. The old image survives — the table is append-only and the chain stays
   * readable — but WHICH image is the receipt changes under an approval that was given
   * against the other one. So the route holds it, in two tiers:
   *
   *   - ADDING a first receipt is allowed while `draft` or `submitted`. A claim can
   *     legitimately gain its evidence while an approver is looking at it.
   *   - REPLACING one is allowed in `draft` only. In `submitted` an approver may be reading
   *     receipt A at the moment it becomes B, and would then approve B having reviewed A.
   *     That race is the whole reason the two tiers differ.
   *   - `rejected` refuses both: there is nothing left to evidence.
   *
   * It belongs in a trigger rather than here, because a route is not where an offline sync
   * path can be made to honour it — recorded as such in ADR-0001 rather than pretended.
   */
  router.add({
    method: "POST",
    pattern: "/v1/expenses/:id/receipt",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const subjectId = parse(UUID, ctx.params["id"]);
      const input = parse(
        ATTACHMENT_BODY.extend({
          supersedes: z.object({ attachmentId: UUID, reason: z.string().min(1).max(500) }).optional(),
        }),
        ctx.body,
      );
      const content = decodeAttachmentContent(input.contentBase64);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const claim = await requireClaim(tx, ctx.principal.tenantId, subjectId);
        if (claim.rep_profile_id !== ctx.principal.repProfileId) {
          await requireClaimOnMyTeam(tx, ctx.principal, subjectId, claim.rep_profile_id);
        }
        // A REPLAY IS NOT A WRITE, so it does not meet this gate.
        //
        // `putAttachment` has an explicit retry path: same id, same bytes, same subject and
        // purpose returns the stored row and writes nothing. That is what README rule 7's
        // device-minted ids are for — an offline client re-sends a capture it is not sure
        // landed. Checking the claim's state first refused that replay with a 409 whenever
        // the claim had moved on since the original upload, even though no INSERT or UPDATE
        // would occur and 0040's trigger therefore never fires. The route was stricter than
        // the database it fronts, on the one path built to be repeated.
        //
        // So the gate is skipped when an attachment under this id is already here, and
        // `putAttachment` decides: a true replay is answered with the stored row, and a
        // DIFFERENT capture under a reused id is refused by `AttachmentIdReusedError`, which
        // is the right sentence for it and not this one. Deliberately not a comparison of
        // bytes here — duplicating `putAttachment`'s four-way check is how the two drift.
        const alreadyHere =
          (await getAttachment(tx, ctx.principal.tenantId, input.id, ctx.principal.repProfileId)) !==
          null;
        const replacing = input.supersedes !== undefined;
        const allowed = replacing ? ["draft"] : ["draft", "submitted"];
        if (!alreadyHere && !allowed.includes(claim.state)) {
          throw new ApiError(
            "conflict",
            replacing
              ? `a receipt may not be replaced once the claim has left draft (this one is ` +
                `${claim.state}); a claim approved against the wrong evidence is corrected by a new claim`
              : `a receipt may not be attached to a ${claim.state} claim`,
          );
        }
        return putAttachment(tx, ctx.principal.tenantId, blobStore, {
          id: input.id,
          purpose: "expense_receipt",
          subjectId,
          contentType: input.contentType,
          content,
          uploadedBy: ctx.principal.repProfileId,
          ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
        });
      });
      return { status: 201, body };
    },
  });

  /** The whole receipt chain for a claim, newest first, superseded images included. */
  router.add({
    method: "GET",
    pattern: "/v1/expenses/:id/receipts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const subjectId = parse(UUID, ctx.params["id"]);
      const data = await inTenant(deps, ctx.principal, (tx) =>
        listAttachmentsForSubject(tx, ctx.principal.tenantId, {
          readBy: ctx.principal.repProfileId,
          purpose: "expense_receipt",
          subjectId,
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /** One attachment's metadata. 404 for "not here" and "not yours", deliberately alike. */
  router.add({
    method: "GET",
    pattern: "/v1/attachments/:id",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, (tx) =>
        requireAttachment(tx, ctx.principal.tenantId, id, ctx.principal.repProfileId),
      );
      return { status: 200, body };
    },
  });

  /**
   * The bytes, base64 in a JSON envelope.
   *
   * Not a binary body, because `send()` JSON-stringifies everything and always writes
   * `application/json` — a Buffer would go out as `{"type":"Buffer","data":[…]}`. Base64 in
   * an envelope is symmetric with the upload, needs no change to the router, and inherits
   * its `cache-control: no-store` and `x-content-type-options: nosniff`, which are exactly
   * right for a third party's personal data. 512 KiB of base64 fits the 1 MiB body cap by
   * construction.
   *
   * The read is RECORDED — `crm.attachment_access` — and the correlation id goes with it,
   * so an access record and a log line name the same request.
   */
  router.add({
    method: "GET",
    pattern: "/v1/attachments/:id/content",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const out = await inTenant(deps, ctx.principal, (tx) =>
        readAttachmentContent(tx, ctx.principal.tenantId, blobStore, {
          attachmentId: id,
          readBy: ctx.principal.repProfileId,
          correlationId: ctx.correlationId,
        }),
      );
      return {
        status: 200,
        body: {
          id: out.attachment.id,
          purpose: out.attachment.purpose,
          contentType: out.attachment.content_type,
          byteSize: out.attachment.byte_size,
          contentSha256: out.attachment.content_sha256,
          contentBase64: out.content.toString("base64"),
        },
      };
    },
  });

  /**
   * Who has read this attachment.
   *
   * The same predicate as the bytes, so the people entitled to see a signature are exactly
   * the people entitled to see who else has.
   */
  router.add({
    method: "GET",
    pattern: "/v1/attachments/:id/access-log",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const raw = Number(ctx.query.get("limit") ?? "200");
      const data = await inTenant(deps, ctx.principal, (tx) =>
        attachmentAccessLog(tx, ctx.principal.tenantId, id, ctx.principal.repProfileId, raw),
      );
      return { status: 200, body: { data } };
    },
  });

  // There is no DELETE and no PATCH on any of the above. All three tables are append-only
  // and their triggers refuse both, so a route would advertise an operation that does not
  // exist and always 409.

  /**
   * What has been changed about this tenant's configuration, and by whom.
   *
   * ONE READ ACROSS EVERY ATTRIBUTED TABLE (0061), which is the point of a generic mechanism:
   * the inbox retention horizons, the prune guard and the expense account map all record here,
   * so "what did somebody change last week" is one question rather than three. `?table=` narrows
   * it to one; an unknown name returns nothing, which is the same answer a table that has never
   * been changed gives.
   *
   * ADMINISTRATOR ONLY. Every table it records is administrator-settable, so its history is for
   * the same audience — and unlike the disposal policy's log next door, nothing here is a rule a
   * rep is measured against.
   *
   * The two tables with their own typed logs are deliberately NOT here: `crm.disposal_policy`
   * (0059) and `crm.notification_endpoint` (0060) are read through their own routes, where the
   * history is typed because a screen draws it. The rule for a future table is in 0061's header.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/config-changes",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const table = ctx.query.get("table");
      const limit = parse(
        z.coerce.number().int().min(1).max(CONFIG_LOG_LIMIT).optional(),
        ctx.query.get("limit") ?? undefined,
      );
      const data = await inTenant(deps, ctx.principal, (tx) =>
        configChanges(tx, ctx.principal.tenantId, {
          table,
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * The tenant's notification endpoints. Administrator only.
   *
   * No secret is ever in a request or a response: `secretEnv` names an environment
   * variable and the database has only ever held the name (0021). The API therefore
   * CANNOT tell an administrator whether their secret is actually present, because the
   * sender runs in the scheduler process and reads a different environment — a check
   * here would answer confidently about the wrong one. A missing secret surfaces where
   * it is true: the delivery dead-letters rather than going out unsigned.
   */
  // ---- the changes that take two people (0062) ---------------------------------
  //
  // Every route here answers to the grant the PROPOSAL names rather than to a fixed role,
  // which is the only arrangement that can be right: `crm.four_eyes_rule` says the disposal
  // policy answers to `compliance` and the expense account map to `administrator`, and a
  // route with one `requireRole` would either let an administrator approve an SOP change or
  // let a compliance officer re-point a ledger account. The database checks it too —
  // `crm.decide_config_proposal` refuses a decision from somebody without the grant — so
  // this is the readable refusal and that is the one that cannot be forgotten.

  /**
   * Which configuration changes take two people, as a register anybody may read.
   *
   * OPEN TO EVERY REP, deliberately, and it is the same reasoning as the disposal policy
   * itself: this is a statement about how the system is governed, not about anybody's data.
   * An administrator who can see that re-pointing a ledger account needs a colleague is an
   * administrator who asks for one instead of discovering the rule as a refusal.
   */
  router.add({
    method: "GET",
    pattern: "/v1/four-eyes-rules",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const data = await inTenant(deps, ctx.principal, (tx) => fourEyesRules(tx));
      return { status: 200, body: { data } };
    },
  });

  /**
   * What is waiting for a second signature, and what has already had one.
   *
   * `?pending=true` is the approver's queue; the default is the record, which includes the
   * rejected and the withdrawn — a proposal somebody refused is as much a fact as one they
   * allowed, and a list that quietly dropped them would make a refusal look like it never
   * happened.
   *
   * Readable by the holder of EITHER grant rather than by the one a given row names. Two
   * reasons: a proposal is not secret within the tenant (its subject is a setting every rep
   * can already read), and an administrator who cannot see that an SOP change is stuck has
   * no way to know a second compliance officer needs appointing — which is the one
   * administrative act that unblocks it.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/four-eyes",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireAnyRole(ctx.principal, ["administrator", "compliance"]);
      const limit = parse(
        z.coerce.number().int().min(1).max(PROPOSAL_LIST_LIMIT).optional(),
        ctx.query.get("limit") ?? undefined,
      );
      const pendingOnly = ctx.query.get("pending") === "true";
      const data = await inTenant(deps, ctx.principal, (tx) =>
        configProposals(tx, ctx.principal.tenantId, {
          pendingOnly,
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
      return { status: 200, body: { data } };
    },
  });

  /**
   * Approve a proposal — which APPLIES it, in the same transaction.
   *
   * The decision is the act. The alternative was to mark the row and leave the proposer to
   * re-issue the write, and it opens a window in which an approved proposal exists and the
   * setting has not changed, so the tenant's configuration and its approved intent disagree
   * and nothing says which is current. Here `crm.decide_config_proposal` records the
   * agreement, the store function performs the write with the proposal named in its
   * attribution block, and `crm.require_four_eyes` stamps `applied_at` as it lets the write
   * through — so an approval and the change it authorised cannot come apart.
   *
   * ONE TRANSACTION, so a refusal at the write rolls the approval back with it. An approval
   * that stood while its change had been refused would be the worst of the three possible
   * outcomes: a record saying two people agreed, over a setting that never moved.
   *
   * The approver supplies their OWN reason. The proposer's survives on the proposal, and the
   * change's log row carries the approver's — which is the honest division, because "we
   * needed this" and "I agree, and here is what I checked" are different statements.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/four-eyes/:id/approve",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(z.object({ reason: z.string().min(10).max(1000) }), ctx.body);
      const pending = await inTenant(deps, ctx.principal, (tx) =>
        configProposal(tx, ctx.principal.tenantId, id),
      );
      if (pending === null) throw notFound(`no proposal ${id} in this tenant`);
      // The grant the PROPOSAL answers to, read from the row rather than assumed.
      requireRole(ctx.principal, pending.role);

      const body = await asChange(
        deps,
        ctx.principal,
        input.reason,
        async (tx) => {
          const proposal = await decideConfigProposal(
            tx,
            ctx.principal.tenantId,
            id,
            "approved",
            ctx.principal.repProfileId,
            input.reason,
          );
          const applied = await applyProposal(tx, ctx.principal, proposal, input.reason);
          // Re-read, so `applied_at` on the way back is the stamped one rather than the null
          // it held a statement ago. A response that said `applied_at: null` about a change
          // that had just landed would be the screen's only evidence disagreeing with the
          // database.
          return { proposal: await configProposal(tx, ctx.principal.tenantId, id), applied };
        },
        id,
      );
      return { status: 200, body };
    },
  });

  /**
   * Reject a proposal. Somebody ELSE saying no.
   *
   * A proposer who changes their mind withdraws instead, and the distinction is not
   * pedantry: without it "rejected" would cover both, and a reader counting refused changes
   * could not tell a disagreement from a second thought. The database holds the rule
   * (`config_proposal_rejected_by_another`), so this cannot be relaxed by a route.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/four-eyes/:id/reject",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(z.object({ reason: z.string().min(10).max(1000) }), ctx.body);
      const body = await decideFourEyes(deps, ctx, id, "rejected", input.reason);
      return { status: 200, body };
    },
  });

  /**
   * Withdraw a proposal. Only the rep who made it.
   *
   * No grant is required beyond the one the proposal names, and not even that is checked by
   * the database for a withdrawal: somebody who has lost the compliance grant must still be
   * able to take back a request nobody has acted on, or the queue fills with proposals that
   * can only be rejected. The route holds the same line — it asks who, not what they hold.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/four-eyes/:id/withdraw",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(z.object({ reason: z.string().min(10).max(1000) }), ctx.body);
      const body = await decideFourEyes(deps, ctx, id, "withdrawn", input.reason, {
        requireGrant: false,
      });
      return { status: 200, body };
    },
  });

  router.add({
    method: "GET",
    pattern: "/v1/admin/notification-endpoints",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const data = await inTenant(deps, ctx.principal, (tx) => listEndpoints(tx, ctx.principal.tenantId));
      return { status: 200, body: { data } };
    },
  });

  // ---- where a person's signals go (0065) -------------------------------------
  //
  // `crm.notification` is addressed to a PERSON and a delivery is addressed to an ENDPOINT,
  // and endpoints are per tenant — so until 0065 every rep's email landed in whichever single
  // mailbox the tenant's one `email` endpoint was frozen to. These four routes are the
  // administrative half of closing that: set a destination, withdraw one, read the to-do list,
  // and let a rep see where their own signals go.
  //
  // EVERY WRITE GOES THROUGH `asChange`, because 0065 puts the table under
  // `crm.require_config_attribution`: a destination for a person's notifications is a decision
  // with an author and a sentence, and the database refuses the write without both. A `reason`
  // is therefore required by the schema below and is not optional anywhere.

  /**
   * Who would be mailed and who would not — the administrator's to-do list.
   *
   * Deliberately the same shape as `GET /v1/admin/expense-account-map/unmapped`: a count, a
   * list, and one sentence. `?includeInactive=true` widens it past active reps, because "why
   * did nobody tell Omar" has a different answer when Omar is suspended.
   *
   * `suggestion` on each row is `crm.rep_profile.work_email_hint`, which 0003 declares a
   * reconciliation hint that must never be load-bearing — so it arrives under a name that
   * cannot be mistaken for a destination, for an administrator to confirm or replace. Nothing
   * in this system ever sends to it.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notify-addresses",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const includeInactive = ctx.query.get("includeInactive") === "true";
      const body = await inTenant(deps, ctx.principal, (tx) =>
        notifyAddressCoverage(tx, ctx.principal.tenantId, { includeInactive }),
      );
      return { status: 200, body };
    },
  });

  /**
   * Sets where one rep's notifications are emailed.
   *
   * A PUT, because it is an ensure: one row per rep, and setting the address it already holds
   * is a success that changes nothing (0061 records only what moved, so the no-op is not
   * logged either). 200 rather than 201 for the same reason — a client cannot tell whether the
   * row existed and should not have to care.
   */
  router.add({
    method: "PUT",
    pattern: "/v1/admin/reps/:id/notify-address",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const repProfileId = parse(UUID, ctx.params["id"]);
      const input = parse(
        z.object({
          // Bounded here only to keep an absurd body out of the store; the SHAPE is the
          // store's business and its two rules (0065's CHECK and `isMailbox`) are narrower
          // than anything expressible here. A regex in this schema would be a third opinion
          // about what an address is, which is how two of them come to disagree.
          address: z.string().min(3).max(254),
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        setRepNotifyAddress(tx, ctx.principal.tenantId, repProfileId, input.address),
      );
      return { status: 200, body };
    },
  });

  /**
   * Stops mailing one rep.
   *
   * A DELETE on the route and an UPDATE underneath, which is not a mismatch dressed up: 0061's
   * trigger fires `AFTER INSERT OR UPDATE`, so removing the row would be the one change to
   * this table that nobody signed and nothing logged. The address goes to NULL, the row stays,
   * and `crm.config_change` carries the before-image — so "somebody deliberately stopped
   * Omar's mail, and here is why" is answerable afterwards.
   *
   * A DELETE WITH A BODY, which is unusual and is the lesser evil: the reason is required by
   * the table, and the alternatives are a reason in the query string (logged by every proxy
   * between here and the client, which is the one place a sentence about a person should not
   * be) or a POST that is not what this does.
   *
   * 404 when there was nothing to withdraw, including a destination already withdrawn — the
   * route reports the change it made, and it made none.
   */
  router.add({
    method: "DELETE",
    pattern: "/v1/admin/reps/:id/notify-address",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const repProfileId = parse(UUID, ctx.params["id"]);
      const input = parse(z.object({ reason: z.string().min(10).max(1000) }), ctx.body);
      const cleared = await asChange(deps, ctx.principal, input.reason, (tx) =>
        clearRepNotifyAddress(tx, ctx.principal.tenantId, repProfileId),
      );
      // AFTER the write, which is deliberate: the attribution block has already committed
      // nothing, because there was nothing to amend, and 0061 records only what moved — so a
      // withdrawal of a destination that was not set leaves no log entry and no row changed.
      // Throwing here rather than checking first also keeps the decision in one place, where a
      // read-then-write would be two statements with a race between them.
      if (!cleared) throw notFound("this rep has no notification address to withdraw");
      return { status: 200, body: { repProfileId, address: null } };
    },
  });

  /**
   * Where MY signals go. Any authenticated rep, their own row only.
   *
   * Here because a rep who is told "we emailed you" and did not get it has nowhere else to
   * look, and because the honest answer is often "nowhere" — which they can then ask an
   * administrator to fix. No reason, no write: this is a read of one row, and the id comes from
   * the token rather than from the path, so there is no rep to name and no way to name
   * somebody else.
   */
  router.add({
    method: "GET",
    pattern: "/v1/me/notify-address",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const row = await inTenant(deps, ctx.principal, (tx) =>
        repNotifyAddress(tx, ctx.principal.tenantId, ctx.principal.repProfileId),
      );
      return {
        status: 200,
        body: {
          repProfileId: ctx.principal.repProfileId,
          // Null for "no row" and for "withdrawn" alike, which is the same answer to the
          // question being asked: neither is somewhere mail can go.
          address: row?.address ?? null,
          updatedAt: row?.updated_at ?? null,
        },
      };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/admin/notification-endpoints",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          // No default. An `https://` url and a `mailto:` are both valid endpoints and
          // each is invalid for the other channel (0029 checks the pair, not either
          // alone), so guessing would mean guessing which refusal the operator gets.
          channel: z.enum(ENDPOINT_CHANNELS),
          url: z.string().max(2000),
          secretEnv: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "must be an environment variable NAME, e.g. CRM_WEBHOOK_SECRET"),
          minSeverity: z.enum(["info", "warning", "urgent"]).optional(),
          kinds: z.array(z.string()).nullish(),
          description: z.string().max(500).nullish(),
          enabled: z.boolean().optional(),
          // REQUIRED (0060), and not the same field as `description`. A description says
          // what the endpoint is for and is amendable; this says why a route out of the
          // tenant was opened at all, is frozen with the destination, and is the thing
          // 0023's header said did not exist. Ten characters, matching the column's CHECK.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      const body = await inTenant(deps, ctx.principal, (tx) =>
        createEndpoint(tx, ctx.principal.tenantId, {
          channel: input.channel,
          url: input.url,
          secretEnv: input.secretEnv,
          ...(input.minSeverity !== undefined ? { minSeverity: input.minSeverity } : {}),
          ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          // From the token, never the body — like every other attributed write here. A
          // client that could name the author could open a route under somebody else's name.
          createdBy: ctx.principal.repProfileId,
          reason: input.reason,
        }),
      );
      return { status: 201, body };
    },
  });

  /**
   * Ask the scheduler to test an endpoint, and read the verdict it recorded.
   *
   * A POST, not the `GET` ADR-0001's open row spelled: this sends real traffic to a third
   * party and is rate-limited, so it is neither safe nor idempotent.
   *
   * The API cannot answer the question itself and that is the whole shape of this. The
   * secret an endpoint names lives in the SCHEDULER's environment — a check here would
   * report confidently about the wrong one — so the scheduler probes, records the verdict,
   * and this reads the row. `202`, because it is queued, not answered; the client polls
   * the GET below, which the next `notify_dispatch` tick (30s) fills in.
   *
   * `requestedBy` is the authenticated principal, never client-supplied: a probe is
   * attributable or it does not happen.
   *
   * Every refusal is the database's, translated — one outstanding probe per endpoint (a
   * partial unique index, so two requests racing cannot both win), a cooldown whose LENGTH
   * is the tenant's and whose SCOPE is one endpoint (`WHERE endpoint_id = …`, because each
   * endpoint is a different third party and a quiet one should not be rationed by a noisy
   * one — this bounds the rate per destination and says nothing about the tenant's total),
   * the tenant's TOTAL budget across every endpoint (0045, 120 an hour by default, counted
   * under a per-tenant advisory lock held to commit, because a count has no partial unique
   * index available to it and two administrators pressing test at once would otherwise both
   * pass a check that sees neither other's uncommitted row), and an endpoint in another
   * tenant. Both limits answer 429 rather than 409: they are rate limiting, and both messages
   * carry the moment a retry becomes legal. The cooldown is tested first, so the
   * better-aimed sentence wins when both apply.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/notification-endpoints/:id/test",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, (tx) =>
        requestProbe(tx, ctx.principal.tenantId, {
          endpointId: id,
          requestedBy: ctx.principal.repProfileId,
        }),
      );
      return { status: 202, body };
    },
  });

  /** The verdict of the last test, or 404 if the endpoint has never been tested. */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notification-endpoints/:id/test",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        // Through the endpoint, so a probe id from another tenant cannot be read by
        // guessing: RLS confines both, and an endpoint this tenant cannot see has no
        // probes to show.
        if ((await getEndpoint(tx, id)) === null) throw notFound(`no notification endpoint ${id}`);
        return latestProbe(tx, id);
      });
      if (body === null) throw notFound(`endpoint ${id} has not been tested`);
      return { status: 200, body };
    },
  });

  /**
   * The test history for one endpoint, newest first.
   *
   * Bounded by the database, not by this limit: 0034 trims to the newest twenty complete
   * probes per endpoint on insert, and since 0045 it keeps anything inside the tenant's
   * budget window as well — so AT LEAST twenty, because the budget is computed from those
   * rows and a ring that deleted one would hand the slot back. This route still clamps to
   * twenty, so the extra rows are not reachable here: they exist for the budget, not for a
   * reader. A probe result is operational, not an audit record — nobody asks which day in
   * March a webhook was tested — and a ring needs no scheduled job to honour it, where a
   * horizon would have added one more thing somebody still has to wire.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notification-endpoints/:id/tests",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const limit = Number(ctx.query.get("limit") ?? "20");
      const data = await inTenant(deps, ctx.principal, async (tx) => {
        if ((await getEndpoint(tx, id)) === null) throw notFound(`no notification endpoint ${id}`);
        return listProbes(tx, id, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 20);
      });
      return { status: 200, body: { data } };
    },
  });

  /**
   * Change an endpoint's thresholds, or switch it off.
   *
   * There is no DELETE, and that is not an omission. `crm.notification_delivery`
   * references the endpoint ON DELETE CASCADE, so removing one would erase the record
   * of everything ever sent to it — the audit trail of where a tenant's signals went.
   * `enabled: false` is how an endpoint stops, and the history stays.
   */
  router.add({
    method: "PATCH",
    pattern: "/v1/admin/notification-endpoints/:id",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const input = parse(
        z.object({
          minSeverity: z.enum(["info", "warning", "urgent"]).optional(),
          kinds: z.array(z.string()).nullish(),
          description: z.string().max(500).nullish(),
          enabled: z.boolean().optional(),
          // REQUIRED (0060). `enabled: false` is how a tenant's signals stop, and it used to
          // be an UPDATE with nothing but `updated_at` to show for it — so an endpoint
          // silenced last Tuesday by somebody who has since lost the role read exactly like
          // one that had been off for a year.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      if (
        input.minSeverity === undefined &&
        input.enabled === undefined &&
        !Object.prototype.hasOwnProperty.call(input, "kinds") &&
        !Object.prototype.hasOwnProperty.call(input, "description")
      ) {
        throw validationFailed("nothing to change", {
          _: "supply minSeverity, kinds, description or enabled",
        });
      }
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const amended = await updateEndpoint(tx, id, {
          ...(input.minSeverity !== undefined ? { minSeverity: input.minSeverity } : {}),
          ...(Object.prototype.hasOwnProperty.call(input, "kinds") ? { kinds: input.kinds ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(input, "description")
            ? { description: input.description ?? null }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          changedBy: ctx.principal.repProfileId,
          reason: input.reason,
        });
        // The existence check is the store's own read now, rather than a `getEndpoint`
        // before it: that one answered from outside the lock the amendment takes, so a
        // concurrent erasure between the two left this route reporting success for an
        // endpoint that was gone.
        if (amended === null) throw notFound(`no notification endpoint ${id}`);
        return amended;
      });
      return { status: 200, body };
    },
  });

  /**
   * How an endpoint got to its current tuning: every amendment, newest first.
   *
   * ADMINISTRATOR ONLY, unlike the disposal policy's history next door — and the difference
   * is the subject, not the sensitivity of the mechanism. A grace period is a rule every rep
   * is measured against, so its history is theirs to read. This is a list of the third
   * parties a tenant talks to and when somebody narrowed what they were told, which is no
   * rep's business and is exactly the shape of information an attacker would want first.
   *
   * The creation — who opened the route, and why — is not here: it is frozen on the endpoint
   * row itself (0049's list, extended by 0060) and comes back from the list route beside the
   * destination it belongs to.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notification-endpoints/:id/history",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const limit = parse(
        z.coerce.number().int().min(1).max(ENDPOINT_HISTORY_LIMIT).optional(),
        ctx.query.get("limit") ?? undefined,
      );
      const data = await inTenant(deps, ctx.principal, async (tx) => {
        // 404 before the history, because an endpoint in another tenant is invisible to this
        // read and an empty array would read as "nothing has ever been amended".
        if ((await getEndpoint(tx, id)) === null) throw notFound(`no notification endpoint ${id}`);
        return endpointHistory(tx, id, { ...(limit !== undefined ? { limit } : {}) });
      });
      return { status: 200, body: { data } };
    },
  });

  /**
   * How long this tenant's inboxes keep things. Readable by every rep, like the disposal
   * policy and for the same reason: a rep whose notification disappeared is entitled to
   * know it was a retention rule rather than a bug.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/retention",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const body = await inTenant(deps, ctx.principal, (tx) =>
        notificationPolicy(tx, ctx.principal.tenantId),
      );
      return { status: 200, body };
    },
  });

  /**
   * Set the horizons. ADMINISTRATOR, not compliance.
   *
   * The disposal policy next door is `compliance` because it is an SOP parameter reps are
   * measured against. This one is not: it is a statement about the system's own storage,
   * and no rep's performance turns on it. The regulated facts a notification refers to
   * live in their own tables and are never touched by a prune — which is also why the
   * split is defensible rather than arbitrary.
   */
  router.add({
    method: "PUT",
    pattern: "/v1/admin/notifications/retention",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          retainReadDays: z.number().int().min(1).max(3650).optional(),
          retainUnreadDays: z.number().int().min(1).max(3650).optional(),
          // REQUIRED (0061). Ten characters is the column's own floor; the author comes from
          // the token, and the database refuses the write if neither is set.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      if (input.retainReadDays === undefined && input.retainUnreadDays === undefined) {
        throw validationFailed("nothing to change", {
          _: "supply retainReadDays, retainUnreadDays, or both",
        });
      }
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        setNotificationPolicy(tx, ctx.principal.tenantId, {
          ...(input.retainReadDays !== undefined ? { retainReadDays: input.retainReadDays } : {}),
          ...(input.retainUnreadDays !== undefined ? { retainUnreadDays: input.retainUnreadDays } : {}),
        }),
      );
      return { status: 200, body };
    },
  });

  /**
   * The two limits on probing, readable and settable — which until now they were not.
   *
   * `probeCooldownSeconds` has been a tenant parameter since 0034 and `probeBudget` since
   * 0045, and NEITHER had a route: both were changeable only at a psql prompt, which by
   * README rule 29 means they were not shipped. They are the parameters that decide how much
   * real traffic this deployment sends to somebody else's server, so an administrator who
   * cannot see them cannot answer for them.
   *
   * Read together, in one response, because they are one question — "may I test this
   * endpoint, and when?" — answered by two rules that apply in order: the cooldown is per
   * endpoint and the budget is per tenant across all of them. Two routes would make a
   * reader believe they were independent.
   *
   * `used` and `nextSlotAt` come from the budget's own function, so the numbers an
   * administrator sees before pressing test are the numbers the trigger will use — the
   * `prune-candidates` precedent, where a dry run that disagreed with the pass would be
   * worse than no dry run.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/probe-limits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const body = await inTenant(deps, ctx.principal, async (tx) => ({
        cooldownSeconds: await probeCooldownSeconds(tx, ctx.principal.tenantId),
        budget: await probeBudget(tx, ctx.principal.tenantId),
      }));
      return { status: 200, body };
    },
  });

  router.add({
    method: "PUT",
    pattern: "/v1/admin/notifications/probe-limits",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      // The RANGES are the notify module's and are deliberately not restated here: both
      // setters refuse out of range with a sentence naming the bound and why it exists, and
      // a zod schema with its own numbers would be a second opinion that drifts. What is
      // parsed here is the shape — which fields, and that they are whole numbers at all.
      const input = parse(
        z
          .object({
            cooldownSeconds: z.number().int().optional(),
            maxProbes: z.number().int().optional(),
            windowSeconds: z.number().int().optional(),
            // REQUIRED (0061). These two decide how much real traffic this deployment sends
            // to somebody else's server, which is the kind of number an operator has to be
            // able to answer for later.
            reason: z.string().min(10).max(1000),
          })
          .strict(),
        ctx.body,
      );
      if (
        input.cooldownSeconds === undefined &&
        input.maxProbes === undefined &&
        input.windowSeconds === undefined
      ) {
        throw validationFailed("nothing to change", {
          _: "supply cooldownSeconds, maxProbes, windowSeconds, or any combination",
        });
      }
      // The budget is ONE rule with two numbers, so changing either means writing both —
      // and the one not supplied has to come from the current state rather than a default,
      // or raising the count would silently reset the window to an hour.
      //
      // TWO WRITES, ONE REASON, which is why 0061's attribution is scoped to a block rather
      // than consumed by the first write: a one-shot reason would refuse the second of these
      // and the honest unit here is the administrative action, not the statement.
      const body = await asChange(deps, ctx.principal, input.reason, async (tx) => {
        if (input.cooldownSeconds !== undefined) {
          await setProbeCooldownSeconds(tx, ctx.principal.tenantId, input.cooldownSeconds);
        }
        if (input.maxProbes !== undefined || input.windowSeconds !== undefined) {
          const now = await probeBudget(tx, ctx.principal.tenantId);
          await setProbeBudget(
            tx,
            ctx.principal.tenantId,
            input.maxProbes ?? now.maxProbes,
            input.windowSeconds ?? now.windowSeconds,
          );
        }
        return {
          cooldownSeconds: await probeCooldownSeconds(tx, ctx.principal.tenantId),
          budget: await probeBudget(tx, ctx.principal.tenantId),
        };
      });
      return { status: 200, body };
    },
  });

  /**
   * How long the record of WHERE a signal was pushed is kept (0046).
   *
   * ADMINISTRATOR to read, where the two inbox horizons above are readable by every rep —
   * and the split is the point rather than an inconsistency. A rep whose notification
   * disappeared is entitled to know it was a rule; a delivery record is evidence about a
   * third-party endpoint a rep cannot see and has no inbox entry for, so it is not an
   * answer to that question.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/delivery-retention",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const body = await inTenant(deps, ctx.principal, (tx) =>
        notificationDeliveryRetention(tx, ctx.principal.tenantId),
      );
      return { status: 200, body };
    },
  });

  router.add({
    method: "PUT",
    pattern: "/v1/admin/notifications/delivery-retention",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          retainDeliveryDays: z.number().int().min(1).max(3650),
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      // The pairing with `retainUnreadDays` — evidence must outlive the message — is the
      // database's (0046) and surfaces as a 422 naming which number to raise. Deliberately
      // not restated here: it is judged against the row as it WILL be, which only the CHECK
      // can see, and a second opinion about one fact is how two of them come to disagree.
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        setNotificationDeliveryRetention(tx, ctx.principal.tenantId, {
          retainDeliveryDays: input.retainDeliveryDays,
        }),
      );
      return { status: 200, body };
    },
  });

  /**
   * Where one signal was pushed, and whether it landed.
   *
   * Takes the NOTIFICATION id and still answers after that notification has been pruned,
   * which is the whole of 0046: the delivery row copies the four facts that make a push
   * legible on its own, so `notification_present: false` lets a client say "the inbox copy
   * is gone" rather than render a dead link.
   *
   * No 404 for an unknown id. An empty list is the honest answer, and distinguishing "never
   * existed" from "pruned" would hand an administrator guessing ids a map of the inbox —
   * the same existence-oracle rule the expense routes answer to.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/:id/deliveries",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const id = parse(UUID, ctx.params["id"]);
      const data = await inTenant(deps, ctx.principal, (tx) => deliveryHistory(tx, id));
      return { status: 200, body: { data } };
    },
  });

  /** What this tenant has pushed lately, newest first by WRITE order (0046's `seq`). */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notification-deliveries",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const limit = parse(z.coerce.number().int().min(1).max(500), ctx.query.get("limit") ?? "50");
      const data = await inTenant(deps, ctx.principal, (tx) => recentDeliveries(tx, { limit }));
      return { status: 200, body: { data } };
    },
  });

  /**
   * What tonight's prune would take, and what it would hold back.
   *
   * The question anybody sensibly asks before shortening a retention period for the first
   * time, and it is read-only — the job is the only thing that deletes. `subject_open` on
   * a row is why it would survive its horizon.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/prune-candidates",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const limit = parse(z.coerce.number().int().min(1).max(500), ctx.query.get("limit") ?? "100");
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const data = await prunableNotifications(tx, ctx.principal.tenantId, { limit });
        // The dry run has to answer "and would tonight be refused?", not only "what
        // would it take". An operator meets the volume guard here or they meet it as a
        // job summary after a night of nothing happening.
        return { data, ...(await prunePreview(tx, ctx.principal.tenantId)) };
      });
      return { status: 200, body };
    },
  });

  /** The volume guard's settings, separate from the horizons. Administrator only. */
  router.add({
    method: "GET",
    pattern: "/v1/admin/notifications/prune-guard",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const body = await inTenant(deps, ctx.principal, (tx) =>
        notificationPruneGuard(tx, ctx.principal.tenantId),
      );
      return { status: 200, body };
    },
  });

  router.add({
    method: "PUT",
    pattern: "/v1/admin/notifications/prune-guard",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          maxSharePercent: z.number().int().min(1).max(99).optional(),
          guardFloorRows: z.number().int().min(0).max(MAX_PRUNE_GUARD_FLOOR_ROWS).optional(),
          // REQUIRED (0061). Ten characters is the column's own floor; the author comes from
          // the token, and the database refuses the write if neither is set.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      if (input.maxSharePercent === undefined && input.guardFloorRows === undefined) {
        throw validationFailed("nothing to change", {
          _: "supply maxSharePercent, guardFloorRows, or both",
        });
      }
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        setNotificationPruneGuard(tx, ctx.principal.tenantId, {
          ...(input.maxSharePercent !== undefined ? { maxSharePercent: input.maxSharePercent } : {}),
          ...(input.guardFloorRows !== undefined ? { guardFloorRows: input.guardFloorRows } : {}),
        }),
      );
      return { status: 200, body };
    },
  });

  /**
   * Open a window in which the prune may exceed its ceiling.
   *
   * A POST that takes `hours` rather than a flag that stays set: a tenant draining a
   * genuine first backlog needs a way past the guard, and the obvious boolean would
   * outlive the night's reason and leave the next horizon typo unguarded. The window
   * expires on its own, names who opened it, and is capped at seven days by the
   * database. `hours` has no default on purpose — a caller that must say how long is a
   * caller that has thought about how long.
   */
  router.add({
    method: "POST",
    pattern: "/v1/admin/notifications/prune-guard/override",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({
          hours: z.number().int().min(1).max(168),
          // The window already names who opened it in `prune_guard_override_by` (0026), as a
          // label for the guard's own message. The reason is the other half, and it goes
          // where every other configuration change's reason goes.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        grantPruneGuardOverride(tx, ctx.principal.tenantId, {
          // Attributed to the caller, not to a string they supply: an override that could
          // name anyone would be an override that names nobody.
          grantedBy: attributionOf(ctx.principal),
          hours: input.hours,
        }),
      );
      return { status: 200, body };
    },
  });

  router.add({
    method: "DELETE",
    pattern: "/v1/admin/notifications/prune-guard/override",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const input = parse(
        z.object({ reason: z.string().min(10).max(1000) }),
        // A DELETE with a body, which is unusual and is the lesser of two awkwardnesses:
        // closing a window early is a configuration change like any other and 0061 wants its
        // sentence, and a reason in a query string is one that ends up in an access log.
        ctx.body,
      );
      const body = await asChange(deps, ctx.principal, input.reason, async (tx) => {
        // IDEMPOTENT, deliberately. Revoking when no window is open writes the same three
        // NULLs over three NULLs, which 0061 refuses as a change that changes nothing — and
        // answering 409 to "make sure this is closed" would be the wrong reading of a DELETE.
        // So the state is read first and the write only happens when there is something to
        // close.
        const guard = await notificationPruneGuard(tx, ctx.principal.tenantId);
        if (guard.prune_guard_override_until === null) return guard;
        return revokePruneGuardOverride(tx, ctx.principal.tenantId);
      });
      return { status: 200, body };
    },
  });

  // ---- expenses --------------------------------------------------------------
  //
  // The claim lifecycle is the CRM's (ADR-0001 item 11): the ERP's own Expense workflow
  // is a flat role check that never reads `Employee.manager_id`, so four-eyes and the
  // approval graph are enforced here or nowhere. The ERP write goes through the outbox
  // like every other write.
  //
  // Submitting REFUSES while Finance has not mapped the category to an S&M account —
  // deliberately, and it is the behaviour the whole design turns on: posting to a guessed
  // ledger account is far worse than a claim that will not leave draft.

  const now = (): Date => deps.now?.() ?? new Date();

  /** A rep's own claims. `?state=` filters; no cross-rep read without supervision. */
  router.add({
    method: "GET",
    pattern: "/v1/expenses",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const forRep = ctx.query.get("repProfileId");
      const data = await inTenant(deps, ctx.principal, async (tx) => {
        const rep = forRep === null ? ctx.principal.repProfileId : parse(UUID, forRep);
        if (rep !== ctx.principal.repProfileId) await requireSupervision(tx, ctx.principal, rep);
        // `?state=` may repeat: the approval queue wants submitted claims, a rep's
        // "outstanding" view wants submitted and approved together.
        const states = ctx.query.getAll("state").map((v) => parse(EXPENSE_STATE, v));
        return listClaimsForRep(tx, ctx.principal.tenantId, rep, {
          ...(states.length > 0 ? { states } : {}),
        });
      });
      return { status: 200, body: { data } };
    },
  });

  router.add({
    method: "POST",
    pattern: "/v1/expenses",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const input = parse(
        z.object({
          crmCategory: z.string().min(1).max(EXPENSE_CATEGORY_MAX),
          amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "an amount is a decimal string"),
          currency: z.string().length(3),
          incurredOn: ISO_DATE,
          description: z.string().max(2000).nullish(),
          receiptUrl: z.string().max(2000).nullish(),
        }),
        ctx.body,
      );
      const body = await inTenant(deps, ctx.principal, (tx) =>
        createClaim(tx, ctx.principal.tenantId, {
          // Always the caller's own: a claim is a statement about money somebody spent,
          // and filing one in another rep's name is not a thing this API does.
          repProfileId: ctx.principal.repProfileId,
          crmCategory: input.crmCategory,
          amount: input.amount,
          currency: input.currency,
          incurredOn: input.incurredOn,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.receiptUrl !== undefined ? { receiptUrl: input.receiptUrl } : {}),
        }),
      );
      return { status: 201, body };
    },
  });

  /**
   * Submit. Snapshots the S&M account in force at this instant onto the claim, so
   * re-mapping the category next quarter cannot re-attribute a claim already submitted.
   */
  router.add({
    method: "POST",
    pattern: "/v1/expenses/:id/submit",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const body = await inTenant(deps, ctx.principal, async (tx) => {
        const claim = await requireClaim(tx, ctx.principal.tenantId, id);
        // Own claim only. 404 and not 403: whether another rep's claim exists is
        // information about their spending.
        if (claim.rep_profile_id !== ctx.principal.repProfileId) throw notFound(`no expense claim ${id}`);
        return submitClaim(tx, ctx.principal.tenantId, id, now());
      });
      return { status: 200, body };
    },
  });

  /**
   * Approve or reject. The approver must supervise the claimant AND must not be them.
   *
   * Both halves are re-asserted by a CHECK once the decision is written — `approved_by`
   * and `rejected_by` each carry a four-eyes constraint — but the route is where the
   * refusal can say which rule was broken, and the two acts below it record no actor for
   * a constraint to read.
   */
  for (const [verb, past] of [
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const) {
    router.add({
      method: "POST",
      pattern: `/v1/expenses/:id/${verb}`,
      handler: async (ctx: Ctx): Promise<HandlerResult> => {
        const id = parse(UUID, ctx.params["id"]);
        const body = await inTenant(deps, ctx.principal, async (tx) => {
          const claim = await requireClaim(tx, ctx.principal.tenantId, id);
          await requireExpenseApprover(tx, ctx.principal, id, claim, past);
          return past === "approved"
            ? approveClaim(tx, ctx.principal.tenantId, id, ctx.principal.repProfileId, now())
            : rejectClaim(tx, ctx.principal.tenantId, id, ctx.principal.repProfileId, now());
        });
        return { status: 200, body };
      },
    });
  }

  /**
   * Hand the approved claim to the ERP, and later record the reimbursement.
   *
   * Separate acts rather than a side effect of approval, which is what
   * `idx_expense_claim_unsent` ("approved, not yet handed over") is for. Both enqueue an
   * outbox row; neither writes the ERP directly.
   */
  for (const [verb, past] of [
    ["post", "posted"],
    ["reimburse", "reimbursed"],
  ] as const) {
    router.add({
      method: "POST",
      pattern: `/v1/expenses/:id/${verb}`,
      handler: async (ctx: Ctx): Promise<HandlerResult> => {
        const id = parse(UUID, ctx.params["id"]);
        const body = await inTenant(deps, ctx.principal, async (tx) => {
          const claim = await requireClaim(tx, ctx.principal.tenantId, id);
          // Neither act records who performed it, so this is the only four-eyes check
          // there is: a rep who reached `approved` with a colleague's blessing could
          // otherwise hand their own claim to the ledger and mark it paid alone.
          await requireExpenseApprover(tx, ctx.principal, id, claim, past);
          return past === "posted"
            ? postClaim(tx, ctx.principal.tenantId, id, now())
            : reimburseClaim(tx, ctx.principal.tenantId, id);
        });
        return { status: 200, body };
      },
    });
  }

  /** Where the claim's ERP writes have got to — the honest view of the outbox lag. */
  router.add({
    method: "GET",
    pattern: "/v1/expenses/:id/erp",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const id = parse(UUID, ctx.params["id"]);
      const data = await inTenant(deps, ctx.principal, async (tx) => {
        const claim = await requireClaim(tx, ctx.principal.tenantId, id);
        if (claim.rep_profile_id !== ctx.principal.repProfileId) {
          await requireClaimOnMyTeam(tx, ctx.principal, id, claim.rep_profile_id);
        }
        return claimPostingStatus(tx, ctx.principal.tenantId, id);
      });
      return { status: 200, body: { data } };
    },
  });

  /**
   * The category-to-account map. ADMINISTRATOR, not compliance: this is a Finance
   * parameter — which ledger account a category posts to — and no rep is measured
   * against it.
   */
  router.add({
    method: "GET",
    pattern: "/v1/admin/expense-accounts",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const body = await inTenant(deps, ctx.principal, async (tx) => ({
        data: await listAccountMappings(tx, ctx.principal.tenantId),
        // The Finance to-do list, as a number to watch reach zero: categories reps are
        // already claiming against that nothing can post.
        unmapped: await unmappedCategoriesWithClaims(tx, ctx.principal.tenantId),
      }));
      return { status: 200, body };
    },
  });

  router.add({
    method: "PUT",
    pattern: "/v1/admin/expense-accounts/:category",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const category = parse(z.string().min(1).max(EXPENSE_CATEGORY_MAX), ctx.params["category"]);
      const input = parse(
        z.object({
          // The ERP's own `maxLength` on both code fields, via the store's constant, so
          // the route cannot advertise a longer one than the layer behind it accepts.
          erpLedgerAccountCode: z.string().min(1).max(ACCOUNT_CODE_MAX),
          erpCostCenterCode: z.string().min(1).max(ACCOUNT_CODE_MAX).nullish(),
          // REQUIRED (0061). Ten characters is the column's own floor; the author comes from
          // the token, and the database refuses the write if neither is set.
          reason: z.string().min(10).max(1000),
        }),
        ctx.body,
      );
      // 0062. Re-pointing an EXISTING mapping takes two people: every claim posted
      // afterwards lands in the new account, and pointing it back does not move them.
      // Creating one takes a single signature — a category that posts nowhere cannot post
      // wrongly, and requiring two people to write a tenant's first mapping would mean a
      // tenant cannot start claiming at all.
      //
      // `anyAccountMapping`, not `activeAccountMapping`: an INACTIVE row still names an
      // account, so bringing it back at a different one is a re-pointing. Reading only
      // active rows would read that as a creation and let it through on one signature,
      // which is the whole of the rule it would be evading.
      const existing = await inTenant(deps, ctx.principal, (tx) =>
        anyAccountMapping(tx, ctx.principal.tenantId, category),
      );
      const repointing =
        existing !== null && existing.erp_ledger_account_code !== input.erpLedgerAccountCode;

      if (repointing) {
        const proposed = await inTenant(deps, ctx.principal, async (tx) => {
          const result = await proposeConfigChange(tx, ctx.principal.tenantId, {
            tableName: "expense_account_map",
            rowKey: { tenant_id: ctx.principal.tenantId, crm_category: category },
            // THE WHOLE INTENDED ROW, not only the column needing approval. The upsert
            // REPLACES the cost centre (0061's suite pins that), so a proposal naming only
            // the account code would apply as a silent clearing of a dimension the approver
            // never saw. `crm.require_four_eyes` checks the four-eyes columns and ignores
            // the rest, which is what makes carrying both safe.
            changes: {
              erp_ledger_account_code: input.erpLedgerAccountCode,
              erp_cost_center_code: input.erpCostCenterCode ?? null,
            },
            proposedBy: ctx.principal.repProfileId,
            reason: input.reason,
          });
          // THE SAME FUNCTION THE SWEEP CALLS (0063), scoped to the proposal just made.
          //
          // 0062 had the store return the people who should be told and told them here, which
          // meant the immediate notice and the scheduled catch-up were two pieces of code
          // writing two sentences about one fact. There is one sentence now, and a route that
          // forgot this call would be a route not calling an obvious function rather than a
          // route ignoring a returned list.
          await notifyPendingApprovals(tx, ctx.principal.tenantId, {
            onlyProposalId: result.proposal.id,
          });
          return result.proposal;
        });
        return { status: 202, body: proposed };
      }

      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        upsertAccountMapping(tx, ctx.principal.tenantId, {
          crmCategory: category,
          erpLedgerAccountCode: input.erpLedgerAccountCode,
          ...(input.erpCostCenterCode !== undefined ? { erpCostCenterCode: input.erpCostCenterCode } : {}),
        }),
      );
      return { status: 200, body };
    },
  });

  router.add({
    method: "DELETE",
    pattern: "/v1/admin/expense-accounts/:category",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      requireRole(ctx.principal, "administrator");
      const category = parse(z.string().min(1).max(EXPENSE_CATEGORY_MAX), ctx.params["category"]);
      const input = parse(z.object({ reason: z.string().min(10).max(1000) }), ctx.body);
      // Deactivated, not deleted: a claim already submitted carries its own snapshot, and
      // the row is the record of what the mapping used to be. Which makes it an UPDATE, so
      // 0061 wants its author and its sentence — and this is the change most worth having
      // one, because every claim in that category stops being postable the moment it lands.
      const body = await asChange(deps, ctx.principal, input.reason, (tx) =>
        deactivateAccountMapping(tx, ctx.principal.tenantId, category),
      );
      return { status: 200, body };
    },
  });

  return router;
}
