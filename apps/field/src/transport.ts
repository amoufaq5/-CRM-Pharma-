import { Problem, SyncResponse, problemKind, type VisitBody } from "@crm/client";
import type { SyncTransport, TransportResult } from "@crm/client";

/**
 * `fetch`, turned into the tagged result the sync engine expects.
 *
 * Nothing here throws for an expected condition. Being offline is this client's NORMAL
 * state, and an exception is the wrong shape for a normal state — it reaches the engine
 * as `{kind: "network"}` and the queue waits. Only a programming error throws.
 *
 * Every response goes through zod on the way in. A captive portal answering 200 with a
 * login page is the case that makes this non-negotiable: read as success, it would empty
 * a rep's queue into nothing.
 */
export interface TransportOptions {
  /** Where the API lives. Same origin in the deployed stack, which is also what keeps
   * this free of CORS: Caddy serves the app and proxies /v1 to the API. */
  readonly baseUrl: string;
  /** Called before every request, so a refreshed token is picked up without rewiring. */
  readonly accessToken: () => string | null;
  /** The server takes the tenant from a `tenant` claim or this header; an IdP that does
   * not carry the claim needs the header, so it is sent whenever it is known. */
  readonly tenantId?: (() => string | null) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export class ApiTransport implements SyncTransport {
  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  async request(method: string, path: string, body?: unknown): Promise<TransportResult> {
    const token = this.options.accessToken();
    const tenant = this.options.tenantId?.() ?? null;
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    if (tenant !== null) headers["x-tenant-id"] = tenant;
    if (body !== undefined) headers["content-type"] = "application/json";

    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return { kind: "network", detail: err instanceof Error ? err.message : "fetch failed" };
    }

    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const problem = Problem.safeParse(parsed);
      return problem.success
        ? {
            kind: "status",
            status: response.status,
            problemKind: problemKind(problem.data.type),
            ...(problem.data.detail !== undefined ? { detail: problem.data.detail } : { detail: problem.data.title }),
          }
        : { kind: "status", status: response.status, detail: `HTTP ${response.status}` };
    }

    return { kind: "ok", status: response.status, body: parsed };
  }

  async postVisits(visits: readonly VisitBody[]): Promise<TransportResult> {
    return this.request("POST", "/v1/sync/visits", { visits: [...visits] });
  }

  /**
   * A read, validated by the caller's schema.
   *
   * Returns the tagged result rather than the value: a screen that cannot tell "offline"
   * from "the server said no" cannot tell the rep anything useful, and a thrown error
   * erases that distinction.
   */
  async get(path: string): Promise<TransportResult> {
    return this.request("GET", path);
  }
}

/** The one place a sync response is read, so the shape lives in one place. */
export function readSyncResponse(result: TransportResult): SyncResponse | null {
  if (result.kind !== "ok") return null;
  const parsed = SyncResponse.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
