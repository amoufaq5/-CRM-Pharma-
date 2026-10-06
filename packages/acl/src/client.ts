import { randomUUID } from "node:crypto";

import { toErpError, ErpError } from "./problems.js";
import { TenantSchema, UiSchemaSchema, type UiSchema } from "./ui-schema.js";

/** Injected so tests need no network and no server. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Mints the credential for one tenant's ERP calls.
 *
 * ADR-0001 item 10: the CRM holds ONE service credential per tenant and never
 * forwards a user's token, because the ERP cannot scope a read to a rep — ABAC
 * is declared and never enforced, so any role sees every row in the tenant
 * (report R2). User-level authorisation happens in the CRM.
 *
 * Implementations mint a short-lived Ed25519 JWT. Ed25519 is not a preference:
 * the ERP's JWKS parser keeps only `kty=OKP, crv=Ed25519` and silently drops
 * everything else, so an RS256 issuer yields zero usable keys and every request
 * 401s.
 */
export interface TenantCredential {
  /** A bearer token for this tenant. Called per request; implementations cache. */
  token(tenantId: string): Promise<string>;
}

export interface ErpClientOptions {
  readonly baseUrl: string;
  readonly credential: TenantCredential;
  readonly fetch: FetchLike;
  /** Per-tenant schema cache TTL. Default 5 minutes. */
  readonly schemaTtlMs?: number;
  readonly now?: () => number;
  /** Bounds a single request. Default 15s. */
  readonly timeoutMs?: number;
  /**
   * Called when the gateway answers a write with a REPLAY it has no body for, and this
   * client therefore asks again under a fresh key. One call per occurrence.
   *
   * Observability only — the retry happens either way. It exists because this is the one
   * place the client issues a request the caller did not ask for, and "each ambiguous write
   * costs exactly one extra request" has to be assertable rather than promised.
   */
  readonly onIdempotentReplay?: (info: { readonly method: string; readonly path: string; readonly status: number }) => void;
}

export interface ListOptions {
  readonly filters?: ReadonlyArray<{ field: string; op?: string; value: string | readonly string[] }>;
  readonly sort?: { field: string; direction?: "asc" | "desc" };
  readonly search?: string;
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ListPage<T = Record<string, unknown>> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

const DEFAULT_SCHEMA_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** The ERP's hard ceiling (`MAX_PAGE_SIZE`); asking for more is silently clamped. */
export const MAX_PAGE_SIZE = 500;

/**
 * The ACL's HTTP client for the CrossEngin ERP.
 *
 * Every read and write in the CRM goes through here. It is deliberately
 * opinionated about the ERP's sharp edges rather than transparent to them:
 * slugs come from the served schema, filters are validated before they are sent,
 * both error shapes normalise to one `ErpError`, and pagination follows the
 * keyset cursor rather than trusting a caller's page arithmetic.
 */
export class ErpClient {
  private readonly baseUrl: string;
  private readonly schemaTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly schemas = new Map<string, TenantSchema>();
  /** De-duplicates concurrent schema fetches for the same tenant. */
  private readonly inflight = new Map<string, Promise<TenantSchema>>();

  constructor(private readonly options: ErpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.schemaTtlMs = options.schemaTtlMs ?? DEFAULT_SCHEMA_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * This tenant's served schema, cached for `schemaTtlMs`.
   *
   * Per tenant because `--per-tenant-manifests` is on (ADR-0001 Q11): a tenant
   * on a custom manifest is served a different entity set, and from the JSONB
   * store rather than typed tables.
   */
  async schema(tenantId: string): Promise<TenantSchema> {
    const cached = this.schemas.get(tenantId);
    if (cached !== undefined && this.now() - cached.fetchedAt < this.schemaTtlMs) return cached;

    const pending = this.inflight.get(tenantId);
    if (pending !== undefined) return pending;

    const fetching = (async (): Promise<TenantSchema> => {
      try {
        const body = await this.request(tenantId, "GET", "/v1/meta/schema");
        const parsed = UiSchemaSchema.parse(body);
        const fresh = new TenantSchema(tenantId, parsed, this.now());
        this.schemas.set(tenantId, fresh);
        return fresh;
      } finally {
        this.inflight.delete(tenantId);
      }
    })();
    this.inflight.set(tenantId, fetching);
    return fetching;
  }

  /** Drops the cached schema, forcing a refetch. For tests and for a manifest activation. */
  invalidateSchema(tenantId?: string): void {
    if (tenantId === undefined) this.schemas.clear();
    else this.schemas.delete(tenantId);
  }

  async list<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    options: ListOptions = {},
  ): Promise<ListPage<T>> {
    const schema = await this.schema(tenantId);
    const query = this.buildListQuery(schema, entity, options);
    const body = await this.request(
      tenantId,
      "GET",
      `/v1/${schema.slugFor(entity)}${query}`,
    );
    return parseListPage<T>(body);
  }

  /**
   * Every page of a list, following the keyset cursor.
   *
   * A generator rather than an array: a full product catalogue or account list
   * is a snapshot refresh, and materialising it costs memory for no benefit when
   * the caller is writing rows as they arrive.
   */
  async *listAll<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    options: ListOptions = {},
  ): AsyncGenerator<T, void, undefined> {
    let cursor: string | null = options.cursor ?? null;
    do {
      const page: ListPage<T> = await this.list<T>(tenantId, entity, { ...options, cursor });
      for (const record of page.data) yield record;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async get<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    id: string,
  ): Promise<T | null> {
    const schema = await this.schema(tenantId);
    try {
      return (await this.request(tenantId, "GET", `/v1/${schema.slugFor(entity)}/${encodeURIComponent(id)}`)) as T;
    } catch (err) {
      if (err instanceof ErpError && err.kind === "not_found") return null;
      throw err;
    }
  }

  /**
   * Creates a record, sending `id` when the caller supplies one.
   *
   * The ERP's `resolveRecordId` accepts a client-supplied id matching
   * `^[A-Za-z0-9_-]{1,200}$`, and every entity is unique on
   * `(tenant_id, entity, record_id)`. That database constraint is what makes a
   * retry safe — NOT the `Idempotency-Key` header, whose store is in-memory in
   * the deployed binary, dies on restart and does not span instances (report
   * R6). The header is still sent, as belt and braces.
   */
  async create<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    record: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const schema = await this.schema(tenantId);
    return (await this.request(
      tenantId,
      "POST",
      `/v1/${schema.slugFor(entity)}`,
      record,
      idempotencyKey,
    )) as T;
  }

  async update<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<T> {
    const schema = await this.schema(tenantId);
    return (await this.request(
      tenantId,
      "PATCH",
      `/v1/${schema.slugFor(entity)}/${encodeURIComponent(id)}`,
      patch,
    )) as T;
  }

  /**
   * Drives a lifecycle transition (`POST /v1/<slug>/{id}/<transition>`).
   *
   * The transition name is checked against the served schema first: an unknown
   * one is a 404 from the gateway, which is indistinguishable from a missing
   * record and sends the relay down a retry path for something that will never
   * succeed.
   */
  async transition<T = Record<string, unknown>>(
    tenantId: string,
    entity: string,
    id: string,
    transition: string,
    body: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const schema = await this.schema(tenantId);
    const ent = schema.entity(entity);
    if (!ent.transitions.some((t) => t.name === transition)) {
      throw new ErpError(
        "not_found",
        404,
        "unknown_transition",
        `${entity} has no transition ${JSON.stringify(transition)}. ` +
          `Available: ${ent.transitions.map((t) => t.name).join(", ") || "(none)"}`,
        null,
      );
    }
    return (await this.request(
      tenantId,
      "POST",
      `/v1/${ent.slug}/${encodeURIComponent(id)}/${transition}`,
      body,
      idempotencyKey,
    )) as T;
  }

  /**
   * Reads a tenant's deletion receipts — `GET /v1/platform/tenants/{id}/tombstones`.
   *
   * The ONE platform-scoped route this client speaks to, and the one read the CRM makes about
   * a tenant rather than about its records. It is here rather than behind a generic
   * "GET any path" because knowing the ERP's URLs is this package's whole job: a caller that
   * could name its own path could name an entity table, which ADR-0001 forbids.
   *
   * Returns the parsed body and throws `ErpError` on anything else, exactly like every other
   * method — the classifier in `tombstones.ts` is what turns both outcomes into a verdict,
   * because "the ERP refused to tell us" is an answer the caller has to handle and not an
   * exception it should swallow.
   *
   * No `Idempotency-Key`: this is a GET, so the replay path the other methods guard against
   * cannot apply, and sending one would put a read into a store that never evicts.
   */
  async tenantTombstones(tenantId: string): Promise<unknown> {
    return await this.request(
      tenantId,
      "GET",
      `/v1/platform/tenants/${encodeURIComponent(tenantId)}/tombstones`,
    );
  }

  /** Builds and validates the query string. Throws before sending on a bad filter. */
  private buildListQuery(schema: TenantSchema, entity: string, options: ListOptions): string {
    const params = new URLSearchParams();

    for (const f of options.filters ?? []) {
      const op = f.op ?? "eq";
      schema.assertFilterable(entity, f.field, op);
      const key = op === "eq" ? f.field : `${f.field}[${op}]`;
      params.append(key, Array.isArray(f.value) ? f.value.join(",") : String(f.value));
    }

    if (options.sort !== undefined) {
      schema.assertSortable(entity, options.sort.field);
      params.set("sort", options.sort.field);
      params.set("order", options.sort.direction ?? "asc");
    }

    if (options.search !== undefined && options.search.trim() !== "") {
      params.set("q", options.search.trim());
    }
    if (options.fields !== undefined && options.fields.length > 0) {
      params.set("fields", options.fields.join(","));
    }
    if (options.limit !== undefined) {
      // Clamped here rather than sent and silently clamped by the server, so the
      // caller's page arithmetic matches what it actually gets back.
      params.set("limit", String(Math.min(Math.max(1, options.limit), MAX_PAGE_SIZE)));
    }
    if (options.cursor != null && options.cursor !== "") params.set("cursor", options.cursor);

    const qs = params.toString();
    return qs === "" ? "" : `?${qs}`;
  }

  private async request(
    tenantId: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const token = await this.options.credential.token(tenantId);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      // Load-bearing: a JWT principal's tenant comes from this header, and the
      // gateway cross-checks it against the token's claim (ADR-0098).
      "x-tenant-id": tenantId,
      accept: "application/json, application/problem+json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;

    const send = (key: string | undefined): ReturnType<FetchLike> => {
      const h = key === undefined ? headers : { ...headers, "idempotency-key": key };
      return withTimeout(
        this.options.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: h,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        this.timeoutMs,
        `${method} ${path}`,
      );
    };

    let res = await send(idempotencyKey);

    // A REPLAYED REFUSAL IS NOT AN ANSWER, so ask again under a key the gateway has not
    // seen.
    //
    // The deployed gateway's idempotency store keeps a reply's STATUS and not its body
    // (`api-gateway-runtime/src/runtime.ts`: `bodyBytes: null`, `x-idempotent-replay:
    // "true"`), and it keeps a handler's 4xx and 5xx the same way it keeps a success, for a
    // 24-hour TTL in a store that never evicts. So a retry of the same outbox row — and the
    // relay retries on every transient refusal, 60 times over for a locked fiscal period —
    // got the status with the cause stripped out, which every error parse then failed. Two
    // measured consequences, both wrong in the expensive direction: a bodiless 422 read as
    // `validation_failed` and DEAD-LETTERED a correct write with
    // `rejected: unrecognised_error_shape`, and a bodiless 409 read as a bare `conflict` —
    // past the `invalid_transition` branch written to catch exactly it — and marked a
    // transition DELIVERED that the ERP had refused and never applied.
    //
    // Re-asking is safe by construction, and that is the whole argument: the gateway only
    // replays what it stored, and a stored 4xx/5xx means the handler REFUSED, so nothing was
    // written and nothing is applied twice. A replayed 2xx is left alone — there the write
    // did land, the empty body is expected, and the caller settles on it (which is what the
    // live gate's replay check pins).
    //
    // One extra request, never a loop: the second key is fresh, so the gateway cannot
    // replay it, and whatever comes back is a real answer from the handler.
    if (res.status >= 400 && res.headers.get("x-idempotent-replay") === "true") {
      this.options.onIdempotentReplay?.({ method, path, status: res.status });
      res = await send(`${idempotencyKey ?? "crm"}-asked-again-${randomUUID()}`);
    }

    const text = await res.text();
    const parsed = text === "" ? null : safeJson(text);

    if (res.status === 204) return null;
    if (res.status >= 400) throw toErpError(res.status, parsed ?? text);
    return parsed;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy, or a truncated body. Hand the raw text to
    // the error mapper, which types it rather than throwing a SyntaxError from
    // somewhere unhelpful.
    return text;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ErpError("unavailable", 504, "client_timeout", `${label} exceeded ${ms}ms`, null)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reads the ERP's list envelope, `{ data: [...], page: { limit, nextCursor } }`.
 *
 * Strict about the shape: a body that does not match means the route returned
 * something other than a list (an error the status did not flag, a proxy page),
 * and treating that as "zero records" would look like an empty tenant. For a
 * snapshot refresh that silently empties a table, so it throws instead.
 */
export function parseListPage<T>(body: unknown): ListPage<T> {
  if (body === null || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new ErpError(
      "unknown",
      200,
      "malformed_list_response",
      `expected { data: [...] }, got ${JSON.stringify(body)?.slice(0, 200)}`,
      body,
    );
  }
  const envelope = body as { data: T[]; page?: { nextCursor?: unknown } };
  const next = envelope.page?.nextCursor;
  return {
    data: envelope.data,
    nextCursor: typeof next === "string" && next !== "" ? next : null,
  };
}
