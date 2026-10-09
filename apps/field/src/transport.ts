import {
  Problem,
  SyncResponse,
  problemKind,
  type AcceptBody,
  type CountBody,
  type CountLineBody,
  type DisbursementBody,
  type RecallBody,
  type ReturnBody,
  type SignatureBody,
  type TransferBody,
  type VisitBody,
  type WriteOffBody,
} from "@crm/client";
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

  async postDisbursements(disbursements: readonly DisbursementBody[]): Promise<TransportResult> {
    return this.request("POST", "/v1/sync/disbursements", { disbursements: [...disbursements] });
  }

  /**
   * The signature bytes, for a disbursement that must already exist.
   *
   * One request per signature, because the route takes one — and the engine knows that,
   * which is why it sends this kind with a batch size of one and only after the
   * disbursement has left the queue.
   */
  async putSignature(disbursementId: string, body: SignatureBody): Promise<TransportResult> {
    return this.request("POST", `/v1/samples/disbursements/${encodeURIComponent(disbursementId)}/signature`, body);
  }

  /**
   * The three transfer movements, one request each.
   *
   * Each goes to its own route and answers 201 with the ledger row it wrote; there is no
   * batch endpoint to send them to, which is why the engine gives all three a batch size
   * of one. The transfer id is in the PATH for the last two, encoded here rather than
   * interpolated raw — it comes from a server response, but a client that trusts that
   * blindly is one bad row away from a request to a path it did not mean.
   */
  async postTransfer(body: TransferBody): Promise<TransportResult> {
    return this.request("POST", "/v1/samples/transfers", body);
  }

  async postAcceptance(transferId: string, body: AcceptBody): Promise<TransportResult> {
    return this.request("POST", `/v1/samples/transfers/${encodeURIComponent(transferId)}/accept`, body);
  }

  async postRecall(transferId: string, body: RecallBody): Promise<TransportResult> {
    return this.request("POST", `/v1/samples/transfers/${encodeURIComponent(transferId)}/recall`, body);
  }

  /**
   * The count document and its three follow-ups.
   *
   * Four routes for one act of counting, and the ids in the paths are the reason the count
   * has a device-minted id at all: a rep with no signal cannot address a line to a count
   * the server has not named yet.
   */
  async postCount(body: CountBody): Promise<TransportResult> {
    return this.request("POST", "/v1/samples/counts", body);
  }

  async postCountLine(countId: string, body: CountLineBody): Promise<TransportResult> {
    return this.request("POST", `/v1/samples/counts/${encodeURIComponent(countId)}/lines`, body);
  }

  async postCountCommit(countId: string): Promise<TransportResult> {
    // The route takes no body, and sending `{}` rather than nothing keeps the request a
    // JSON POST like every other write here.
    return this.request("POST", `/v1/samples/counts/${encodeURIComponent(countId)}/commit`, {});
  }

  async postCountCancel(countId: string): Promise<TransportResult> {
    return this.request("POST", `/v1/samples/counts/${encodeURIComponent(countId)}/cancel`, {});
  }

  /** Material out of custody. One route, one row, always with a reason. */
  async postWriteOff(body: WriteOffBody): Promise<TransportResult> {
    return this.request("POST", "/v1/samples/write-offs", body);
  }

  /** Material back to a warehouse, which is also a write the ERP has to be told about. */
  async postReturn(body: ReturnBody): Promise<TransportResult> {
    return this.request("POST", "/v1/samples/returns", body);
  }

  /**
   * Ask the server to try a dead ERP write again.
   *
   * NOT a queued outbox kind, and that is the one deliberate inconsistency in this client.
   * Everything the queue holds is a record of something that happened in the field, which
   * must survive a dead battery; this is an operator action on a queue that lives on the
   * server, where nothing happens until there is a network anyway. Queuing it would also
   * mean classifying "that write is no longer dead" — which is good news — as a refusal.
   */
  async retryErpWrite(id: string): Promise<TransportResult> {
    return this.request("POST", `/v1/erp-writes/${encodeURIComponent(id)}/retry`, {});
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
