import { describe, expect, it } from "vitest";

import { ApiTransport } from "./transport.js";

function stubFetch(answers: readonly (Response | Error)[]): { impl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (answer instanceof Error) throw answer;
    return answer ?? new Response("", { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const problem = (status: number, type: string, detail?: string): Response =>
  new Response(JSON.stringify({ type, title: "t", status, ...(detail !== undefined ? { detail } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

describe("ApiTransport", () => {
  it("sends the bearer token and the tenant header", () => {
    const { impl, calls } = stubFetch([new Response("{}", { status: 200 })]);
    const t = new ApiTransport({ baseUrl: "https://crm.example", accessToken: () => "tok", tenantId: () => "ten", fetchImpl: impl });
    return t.get("/v1/me").then(() => {
      expect(calls[0]?.url).toBe("https://crm.example/v1/me");
      const headers = calls[0]?.init?.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer tok");
      expect(headers["x-tenant-id"]).toBe("ten");
    });
  });

  it("omits the headers it has no value for, rather than sending empty ones", async () => {
    // `Authorization: Bearer null` is a 401 with a confusing reason; no header at all is
    // the honest request.
    const { impl, calls } = stubFetch([new Response("{}", { status: 200 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => null, fetchImpl: impl });
    await t.get("/v1/me");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["x-tenant-id"]).toBeUndefined();
  });

  it("reads the token on every call, so a refresh is picked up", async () => {
    let token = "first";
    const { impl, calls } = stubFetch([new Response("{}", { status: 200 }), new Response("{}", { status: 200 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => token, fetchImpl: impl });
    await t.get("/v1/me");
    token = "second";
    await t.get("/v1/me");
    expect((calls[1]?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer second");
  });

  it("turns a thrown fetch into a network result instead of an exception", async () => {
    // Being offline is this client's normal state; an exception is the wrong shape for a
    // normal state, and the sync engine is written against the tagged result.
    const { impl } = stubFetch([new TypeError("Failed to fetch")]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    expect(await t.get("/v1/me")).toEqual({ kind: "network", detail: "Failed to fetch" });
  });

  it("carries the problem KIND out of an RFC 9457 type URL", async () => {
    const { impl } = stubFetch([problem(403, "https://crm.pharma/errors/tenant-deleted", "gone")]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    expect(await t.get("/v1/me")).toEqual({ kind: "status", status: 403, problemKind: "tenant_deleted", detail: "gone" });
  });

  it("falls back to the title when a problem has no detail", async () => {
    const { impl } = stubFetch([problem(409, "https://crm.pharma/errors/conflict")]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    expect(await t.get("/v1/me")).toMatchObject({ kind: "status", status: 409, problemKind: "conflict", detail: "t" });
  });

  it("does not invent a problem kind when the error body is not a problem document", async () => {
    // A proxy's own 502 page, for instance. Guessing a kind here would feed the
    // classifier a lie; the status alone is enough for it to decide to retry.
    const { impl } = stubFetch([new Response("<html>502</html>", { status: 502 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    expect(await t.get("/v1/me")).toEqual({ kind: "status", status: 502, detail: "HTTP 502" });
  });

  it("posts the sync envelope the API expects", async () => {
    const { impl, calls } = stubFetch([new Response(JSON.stringify({ accepted: 1, rejected: 0, results: [{ id: "a", ok: true }] }), { status: 200 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    const result = await t.postVisits([{ id: "a", erpAccountId: "ACC-1" }]);
    expect(calls[0]?.url).toBe("/v1/sync/visits");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ visits: [{ id: "a", erpAccountId: "ACC-1" }] });
    expect(result.kind).toBe("ok");
  });

  it("posts each transfer movement to its own route, with the id in the path", async () => {
    const { impl, calls } = stubFetch([
      new Response("{}", { status: 201 }),
      new Response("{}", { status: 201 }),
      new Response("{}", { status: 201 }),
    ]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    await t.postTransfer({
      id: "t1",
      lotId: "lot",
      quantity: "4",
      occurredAt: "2026-10-08T09:00:00.000Z",
      toRepProfileId: "rep2",
    });
    await t.postAcceptance("t1", { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" });
    await t.postRecall("t1", { id: "r1", occurredAt: "2026-10-08T11:00:00.000Z" });

    expect(calls.map((c) => c.url)).toEqual([
      "/v1/samples/transfers",
      "/v1/samples/transfers/t1/accept",
      "/v1/samples/transfers/t1/recall",
    ]);
    // The body is the movement itself, not an envelope: these are single-item routes.
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ id: "t1", toRepProfileId: "rep2" });
  });

  it("encodes a transfer id into the path rather than interpolating it raw", async () => {
    // The id comes from a server response, and a client that pastes one straight into a
    // URL is one malformed row away from requesting a path it did not mean.
    const { impl, calls } = stubFetch([new Response("{}", { status: 201 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    await t.postAcceptance("../../v1/admin?x=1", { id: "a1", occurredAt: "2026-10-08T10:00:00.000Z" });
    expect(calls[0]?.url).toBe("/v1/samples/transfers/..%2F..%2Fv1%2Fadmin%3Fx%3D1/accept");
  });

  it("treats an unparseable 200 as ok-with-unreadable-body, for the engine to refuse", async () => {
    // The transport does not decide what a bad body means — `syncOnce` does, by parsing
    // it against the contract and keeping the rows. Two layers, one decision each.
    const { impl } = stubFetch([new Response("not json", { status: 200 })]);
    const t = new ApiTransport({ baseUrl: "", accessToken: () => "t", fetchImpl: impl });
    expect(await t.postVisits([])).toEqual({ kind: "ok", status: 200, body: null });
  });
});
