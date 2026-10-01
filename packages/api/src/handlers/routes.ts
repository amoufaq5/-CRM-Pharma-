import {
  cycleOn,
  listCycles,
  listPlanProducts,
  listPlans,
  listTargets,
  planAdherence,
  planSummary,
  getPlan,
} from "@crm/callplan";
import { PostgresServiceKeyRegistry, jwksResponse } from "@crm/credential";
import { withTenantContext } from "@crm/db";
import { visibleAccountIds, visibleTerritoryIds } from "@crm/territory";
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
  disburseSamples,
  enqueueErpMirror,
  expiringHoldings,
  getLot,
  holdingsFor,
  ledgerFor,
  outstandingTransfers,
  receiveSamples,
  transferOut,
} from "@crm/sample";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { Principal } from "../principal.js";
import { forbidden, notFound, validationFailed } from "../problems.js";
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
 * Refuses a plan that is not the caller's.
 *
 * A 404 rather than a 403: whether a plan exists is itself information about another
 * rep's territory, and the ERP leaks exactly this kind of thing by having no row-level
 * scoping at all (report R2).
 */
async function requireOwnPlan(tx: PoolClient, p: Principal, planId: string): Promise<NonNullable<Awaited<ReturnType<typeof getPlan>>>> {
  const plan = await getPlan(tx, planId);
  if (plan === null || plan.rep_profile_id !== p.repProfileId) {
    throw notFound(`no call plan ${planId}`);
  }
  return plan;
}

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
        const plan = await requireOwnPlan(tx, ctx.principal, id);
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
        await requireOwnPlan(tx, ctx.principal, id);
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

  return router;
}
