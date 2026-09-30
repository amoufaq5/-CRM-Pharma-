import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ApiError, toProblem } from "./problems.js";

export interface RequestContext<P = unknown> {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly params: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly correlationId: string;
  /** Set once authentication has run. Absent on a public route. */
  readonly principal: P;
}

export type Handler<P = unknown> = (ctx: RequestContext<P>) => Promise<HandlerResult>;

export interface HandlerResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Route<P = unknown> {
  readonly method: string;
  /** `/v1/visits/:id/transition` — `:name` captures one segment. */
  readonly pattern: string;
  readonly handler: Handler<P>;
  /** Public routes skip authentication. Default false — secure by omission. */
  readonly public?: boolean;
}

interface CompiledRoute<P> extends Route<P> {
  readonly segments: readonly string[];
}

/** 1 MiB. The ERP caps at 10 MiB and returns 413; an offline sync batch is the only large body here. */
export const MAX_BODY_BYTES = 1024 * 1024;

export class Router<P = unknown> {
  private readonly routes: CompiledRoute<P>[] = [];

  add(route: Route<P>): this {
    this.routes.push({ ...route, segments: route.pattern.split("/").filter((s) => s !== "") });
    return this;
  }

  /**
   * Matches a path, distinguishing "no such path" from "wrong method".
   *
   * The distinction is not pedantry: a 404 where a 405 belongs sends a client
   * looking for a typo in its URL when the real problem is the verb.
   */
  match(method: string, path: string): { route: CompiledRoute<P>; params: Record<string, string> } | "method_mismatch" | null {
    const parts = path.split("/").filter((s) => s !== "");
    let pathMatched = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i]!;
        const actual = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(actual);
        else if (seg !== actual) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? "method_mismatch" : null;
  }

  list(): readonly Route<P>[] {
    return this.routes;
  }
}

/** Reads the body, refusing anything oversized before it is buffered whole. */
export async function readBody(req: IncomingMessage): Promise<{ raw: string }> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError("payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Checked per chunk as well as up front: content-length is a claim, and a
    // chunked request need not send one at all.
    if (total > MAX_BODY_BYTES) {
      throw new ApiError("payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return { raw: Buffer.concat(chunks).toString("utf8") };
}

export function parseJsonBody(raw: string, contentType: string | undefined): unknown {
  if (raw === "") return undefined;
  if (contentType !== undefined && !contentType.includes("application/json")) {
    throw new ApiError("unsupported_media_type", "expected application/json");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("validation_failed", "body is not valid JSON");
  }
}

export interface DispatchOptions<P> {
  readonly router: Router<P>;
  /** Resolves a principal, or throws. Not called for a public route. */
  readonly authenticate: (ctx: Omit<RequestContext<null>, "principal">) => Promise<P>;
  readonly onError?: (err: unknown, ctx: { correlationId: string; path: string }) => void;
}

/**
 * The request pipeline, framework-free.
 *
 * Every response — success, refusal, or an unexpected throw — leaves through
 * here, so `application/problem+json` is the only error shape a client can
 * observe. That is the property the ERP lacks, and it is only true because
 * nothing writes to the socket except this function.
 */
export async function dispatch<P>(
  req: IncomingMessage,
  res: ServerResponse,
  options: DispatchOptions<P>,
): Promise<void> {
  const correlationId = (req.headers["x-correlation-id"] as string | undefined) ?? randomUUID();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const isProblem = status >= 400;
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": isProblem ? "application/problem+json" : "application/json",
      "x-correlation-id": correlationId,
      // A CRM response is per-user and per-territory; a shared cache holding one
      // would serve another rep's accounts.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(payload);
  };

  try {
    const matched = options.router.match(req.method ?? "GET", path);
    if (matched === null) throw new ApiError("not_found", `no route for ${path}`);
    if (matched === "method_mismatch") {
      throw new ApiError("method_not_allowed", `${req.method ?? "GET"} is not allowed on ${path}`);
    }

    const { raw } = await readBody(req);
    const body = parseJsonBody(raw, req.headers["content-type"]);

    const partial = {
      method: req.method ?? "GET",
      path,
      query: url.searchParams,
      params: matched.params,
      headers: req.headers,
      body,
      correlationId,
    };

    const principal = matched.route.public === true
      ? (null as P)
      : await options.authenticate(partial as Omit<RequestContext<null>, "principal">);

    const result = await matched.route.handler({ ...partial, principal });
    send(result.status, result.body, result.headers ?? {});
  } catch (err) {
    const problem = toProblem(err);
    // The full error is logged; only the sanitised problem reaches the client.
    if (problem.kind === "internal") options.onError?.(err, { correlationId, path });
    send(problem.status, problem.body(correlationId));
  }
}
