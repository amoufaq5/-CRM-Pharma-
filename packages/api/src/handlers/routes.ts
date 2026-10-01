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

  return router;
}
