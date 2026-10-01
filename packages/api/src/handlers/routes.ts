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
import { inbox, markAllRead, markRead, unreadCount } from "@crm/notify";
import { deadLetter, deadLetters, reviveDeadLetter, teamDeadLetters } from "@crm/relay";
import { withTenantContext } from "@crm/db";
import { canSupervise, teamRoster, visibleAccountIds, visibleTerritoryIds } from "@crm/territory";
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
  ledgerFor,
  disposalPolicy,
  getCount,
  listCounts,
  openCount,
  outstandingTransfers,
  receiveSamples,
  openObligations,
  recordCountLine,
  returnToWarehouse,
  teamExpiringHoldings,
  teamExposure,
  teamObligations,
  transferOut,
  writeOff,
} from "@crm/sample";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { Principal } from "../principal.js";
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
  /** Omitted means a self-count. A manager passes a rep to record a supervised one. */
  repProfileId: UUID.nullish(),
  countedAt: z.string().datetime(),
  note: z.string().max(2000).nullish(),
});

const CountLineBody = z.object({
  lotId: UUID,
  countedQuantity: z.union([z.string().regex(/^\d{1,13}(\.\d{1,3})?$/), z.number().min(0)]),
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

const PLAN_STATUS = z.enum(["draft", "submitted", "approved", "superseded", "withdrawn"]);

export function buildRouter(deps: HandlerDeps): Router<Principal> {
  const router = new Router<Principal>();

  // ---- public -------------------------------------------------------------

  /**
   * Liveness and readiness in one. The ERP has no health endpoint at all
   * (report R11), so this is ours to provide — and it checks the database,
   * because a process that is up but cannot reach Postgres is not ready.
   */
  router.add({
    method: "GET",
    pattern: "/healthz",
    public: true,
    handler: async (): Promise<HandlerResult> => {
      const client = await deps.pool.connect();
      try {
        await client.query("SELECT 1");
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
      let keys;
      try {
        keys = await new PostgresServiceKeyRegistry({ pool: deps.pool }).verifiableKeys();
      } catch {
        // A failed read must not become an empty key set. 503 keeps every verifier
        // on its last good document.
        return jwksResponse([]);
      }
      return jwksResponse(keys);
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
        const row = await receiveSamples(tx, ctx.principal.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: ctx.principal.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          erpWarehouseId: input.erpWarehouseId,
        });
        const mirrored = await enqueueErpMirror(tx, ctx.principal.tenantId, row, lot);
        return { ...row, erpMirrorEnqueued: mirrored };
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
        const row = await returnToWarehouse(tx, p.tenantId, {
          id: input.id,
          lotId: input.lotId,
          repProfileId: p.repProfileId,
          quantity: input.quantity,
          occurredAt: new Date(input.occurredAt),
          erpWarehouseId: input.erpWarehouseId,
          reason: input.reason ?? null,
        });
        const mirrored = await enqueueErpMirror(tx, p.tenantId, row, lot);
        return { ...row, erpMirrorEnqueued: mirrored };
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
   * No write route, deliberately. The grace period and the promo auto-write-off flag are
   * SOP parameters with a regulatory flavour, and every principal here is a rep profile —
   * there is no compliance role to restrict a write to, and "supervises at least one rep"
   * would let a first-line manager change a tenant-wide commitment. Until there is a role
   * model, this is set by an administrator in SQL. Read is open because every rep is
   * subject to it and ought to be able to see the deadline they are held to.
   */
  router.add({
    method: "GET",
    pattern: "/v1/samples/disposal-policy",
    handler: async (ctx: Ctx): Promise<HandlerResult> => {
      const body = await inTenant(deps, ctx.principal, (tx) => disposalPolicy(tx, ctx.principal.tenantId));
      return { status: 200, body };
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

  return router;
}
