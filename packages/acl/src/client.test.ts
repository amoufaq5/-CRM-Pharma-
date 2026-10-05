import { describe, expect, it, vi } from "vitest";
import { ErpClient, parseListPage, type FetchLike, type TenantCredential } from "./client.js";
import { ErpError } from "./problems.js";
import { UnknownEntityError, UnsupportedFilterError } from "./ui-schema.js";
import { ERP_SCHEMA_FIXTURE } from "./fixtures.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Records every request and replies from a queue of canned responses. */
function harness(
  responses: Array<{ status: number; body: unknown }> = [],
): { client: ErpClient; calls: Call[]; enqueue: (status: number, body: unknown) => void } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    if (url.endsWith("/v1/meta/schema")) {
      return Promise.resolve(response(200, ERP_SCHEMA_FIXTURE));
    }
    const next = queue.shift() ?? { status: 200, body: { data: [], page: { nextCursor: null } } };
    return Promise.resolve(response(next.status, next.body));
  };
  const credential: TenantCredential = { token: () => Promise.resolve("ed25519-token") };
  return {
    client: new ErpClient({ baseUrl: "https://erp.example/", credential, fetch: fetchImpl }),
    calls,
    enqueue: (status, body) => queue.push({ status, body }),
  };
}

function response(status: number, body: unknown) {
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("auth and transport", () => {
  it("sends the bearer token and the load-bearing x-tenant-id header", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Item");
    const req = calls.at(-1)!;
    expect(req.headers["authorization"]).toBe("Bearer ed25519-token");
    // The gateway derives a JWT principal's tenant from this header and
    // cross-checks it against the token claim. Omitting it is a 401.
    expect(req.headers["x-tenant-id"]).toBe(TENANT);
  });

  it("accepts both the gateway's and the handler's content types", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Item");
    expect(calls.at(-1)!.headers["accept"]).toContain("application/problem+json");
  });

  it("normalises an HTML proxy page into a typed error rather than a SyntaxError", async () => {
    const { client, enqueue } = harness();
    enqueue(502, "<html>Bad Gateway</html>");
    await expect(client.list(TENANT, "Item")).rejects.toMatchObject({
      name: "ErpError",
      kind: "unavailable",
      code: "unrecognised_error_shape",
    });
  });

  it("maps the handler's bare {error} shape as readily as RFC 9457", async () => {
    const { client, enqueue } = harness();
    enqueue(403, { error: "forbidden", detail: "role may not list" });
    await expect(client.list(TENANT, "Item")).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("schema-derived slugs", () => {
  it("uses the server's naive plural, not the English one", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Opportunity");
    // `/v1/opportunities` would 404. This is the whole reason slugs are derived.
    expect(calls.at(-1)!.url).toContain("/v1/opportunitys");
    expect(calls.at(-1)!.url).not.toContain("/v1/opportunities");
  });

  it("fetches the schema once and reuses it within the TTL", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Item");
    await client.list(TENANT, "Item");
    await client.list(TENANT, "Opportunity");
    expect(calls.filter((c) => c.url.endsWith("/v1/meta/schema"))).toHaveLength(1);
  });

  it("de-duplicates concurrent schema fetches", async () => {
    const { client, calls } = harness();
    await Promise.all([
      client.list(TENANT, "Item"),
      client.list(TENANT, "Item"),
      client.list(TENANT, "Opportunity"),
    ]);
    expect(calls.filter((c) => c.url.endsWith("/v1/meta/schema"))).toHaveLength(1);
  });

  it("caches per tenant, because per-tenant manifests serve different entity sets", async () => {
    const { client, calls } = harness();
    const other = "22222222-2222-4222-8222-222222222222";
    await client.list(TENANT, "Item");
    await client.list(other, "Item");
    expect(calls.filter((c) => c.url.endsWith("/v1/meta/schema"))).toHaveLength(2);
  });

  it("refuses an entity this tenant is not served", async () => {
    const { client } = harness();
    await expect(client.list(TENANT, "PerishableLot")).rejects.toThrow(UnknownEntityError);
  });
});

describe("filter validation — refusing what the ERP would mishandle", () => {
  it("refuses a non-filterable field instead of sending it", async () => {
    // The ERP silently DROPS an unknown filter param, so the query comes back
    // wider than asked for. Sending and hoping is the bug.
    const { client, calls } = harness();
    const before = calls.length;
    // `description` is a real `Item` field and is NOT in its filterableFields. It used to
    // be `name` here, which the hand-written fixture wrongly made unfilterable — the real
    // schema does allow filtering on `name`, so that assertion was testing nothing.
    await expect(
      client.list(TENANT, "Item", { filters: [{ field: "description", value: "x" }] }),
    ).rejects.toThrow(UnsupportedFilterError);
    // Only the schema fetch happened; the list request was never made.
    expect(calls.filter((c) => c.url.includes("/v1/items"))).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(before - 1);
  });

  it("refuses a range filter on a numeric field, naming the snapshot table", async () => {
    const { client } = harness();
    await expect(
      client.list(TENANT, "Item", { filters: [{ field: "list_price", op: "gte", value: "1000" }] }),
    ).rejects.toThrow(/TEXT comparison|crm\.\*_snapshot/);
  });

  it("allows EQUALITY on a numeric field — only ranges are affected", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Item", { filters: [{ field: "list_price", op: "eq", value: "10" }] });
    expect(queryOf(calls.at(-1)!.url).get("list_price")).toBe("10");
  });

  it("allows a range filter on a DATE — ISO-8601 sorts chronologically as text", async () => {
    // The accident that makes a date range sound on the deployed store, where every
    // comparison is textual. `Expense.incurred_on` is the subject because it is one of
    // the nine filterable date fields the ERP actually serves; this test used
    // `Item.updated_at`, which the ERP serves on no entity at all — so for the life of
    // the project it proved the exemption against a field that does not exist.
    const { client, calls } = harness();
    await client.list(TENANT, "Expense", {
      filters: [{ field: "incurred_on", op: "gte", value: "2026-09-01" }],
    });
    expect(queryOf(calls.at(-1)!.url).get("incurred_on[gte]")).toBe("2026-09-01");
  });

  it("refuses sorting by a numeric field", async () => {
    const { client } = harness();
    await expect(
      client.list(TENANT, "Item", { sort: { field: "list_price" } }),
    ).rejects.toThrow(/lexicographically/);
  });

  it("refuses sorting by a non-sortable field", async () => {
    const { client } = harness();
    await expect(
      client.list(TENANT, "Opportunity", { sort: { field: "account_id" } }),
    ).rejects.toThrow(UnsupportedFilterError);
  });
});

describe("query building", () => {
  it("renders operators, in-lists, search, projection and limit", async () => {
    const { client, calls } = harness();
    // Sorted by `incurred_on` on `Expense` rather than `updated_at` on `Opportunity`:
    // `Opportunity.sortableFields` is EMPTY in the real schema (true of 34 of the ERP's
    // 51 entities), so there is nothing legal to sort it by, and `updated_at` is served
    // on nothing.
    await client.list(TENANT, "Expense", {
      filters: [{ field: "state", op: "in", value: ["approved", "reimbursed"] }],
      sort: { field: "incurred_on", direction: "desc" },
      search: "  acme  ",
      fields: ["id", "category"],
      limit: 25,
    });
    const q = queryOf(calls.at(-1)!.url);
    expect(q.get("state[in]")).toBe("approved,reimbursed");
    expect(q.get("sort")).toBe("incurred_on");
    expect(q.get("order")).toBe("desc");
    expect(q.get("q")).toBe("acme");
    expect(q.get("fields")).toBe("id,category");
    expect(q.get("limit")).toBe("25");
  });

  it("clamps limit to the ERP's ceiling rather than letting the server do it silently", async () => {
    const { client, calls } = harness();
    await client.list(TENANT, "Item", { limit: 5000 });
    expect(queryOf(calls.at(-1)!.url).get("limit")).toBe("500");
  });
});

describe("pagination", () => {
  it("follows the keyset cursor across pages", async () => {
    const { client, enqueue, calls } = harness();
    enqueue(200, { data: [{ id: "a" }, { id: "b" }], page: { nextCursor: "cur1" } });
    enqueue(200, { data: [{ id: "c" }], page: { nextCursor: null } });

    const seen: string[] = [];
    for await (const rec of client.listAll<{ id: string }>(TENANT, "Item")) seen.push(rec.id);

    expect(seen).toEqual(["a", "b", "c"]);
    expect(queryOf(calls.at(-1)!.url).get("cursor")).toBe("cur1");
  });

  it("treats an empty-string cursor as the end, not as a cursor", async () => {
    expect(parseListPage({ data: [], page: { nextCursor: "" } }).nextCursor).toBeNull();
  });

  it("throws on a malformed list body rather than reporting zero records", async () => {
    // A snapshot refresh that reads "zero records" from a broken response would
    // silently empty the table. Loud beats empty.
    const { client, enqueue } = harness();
    enqueue(200, { unexpected: true });
    await expect(client.list(TENANT, "Item")).rejects.toThrow(/malformed_list_response/);
  });
});

describe("writes", () => {
  it("sends a client-minted id and an Idempotency-Key on create", async () => {
    const { client, enqueue, calls } = harness();
    enqueue(201, { id: "crm_abc", sku: "X" });
    await client.create(TENANT, "Item", { id: "crm_abc", sku: "X" }, "key-1");
    const req = calls.at(-1)!;
    expect(req.method).toBe("POST");
    expect(req.headers["idempotency-key"]).toBe("key-1");
    // Dedup rests on the ERP's (tenant_id, entity, record_id) unique constraint,
    // a durable guarantee, not on the header's in-memory store.
    expect(JSON.parse(req.body!)).toMatchObject({ id: "crm_abc" });
  });

  it("returns null rather than throwing when a get 404s", async () => {
    const { client, enqueue } = harness();
    enqueue(404, { error: "not_found" });
    expect(await client.get(TENANT, "Item", "missing")).toBeNull();
  });

  it("posts a lifecycle transition at the server's slug", async () => {
    const { client, enqueue, calls } = harness();
    enqueue(200, { id: "o1", stage: "won" });
    await client.transition(TENANT, "Opportunity", "o1", "win");
    expect(calls.at(-1)!.url).toContain("/v1/opportunitys/o1/win");
  });

  it("refuses an unknown transition locally instead of sending a doomed request", async () => {
    // A bad transition name is a 404 from the gateway, indistinguishable from a
    // missing record — which would send the relay into a retry loop for
    // something that can never succeed.
    const { client, calls } = harness();
    await expect(client.transition(TENANT, "Opportunity", "o1", "reopen")).rejects.toThrow(
      /has no transition "reopen".*win, lose/s,
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("url-encodes an id so a path-traversing id cannot reshape the route", async () => {
    const { client, enqueue, calls } = harness();
    enqueue(200, { id: "x" });
    await client.get(TENANT, "Item", "a/../../admin");
    expect(calls.at(-1)!.url).toContain("a%2F..%2F..%2Fadmin");
  });
});

describe("timeouts", () => {
  it("fails a hung request as a retryable error", async () => {
    vi.useFakeTimers();
    try {
      const credential: TenantCredential = { token: () => Promise.resolve("t") };
      const fetchImpl: FetchLike = (url) =>
        url.endsWith("/v1/meta/schema")
          ? Promise.resolve(response(200, ERP_SCHEMA_FIXTURE))
          : new Promise(() => {});
      const client = new ErpClient({
        baseUrl: "https://erp.example",
        credential,
        fetch: fetchImpl,
        timeoutMs: 50,
      });
      const pending = client.list(TENANT, "Item");
      const assertion = expect(pending).rejects.toMatchObject({
        kind: "unavailable",
        code: "client_timeout",
      });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      // Retryable, so the relay backs off rather than dead-lettering.
      await pending.catch((e: ErpError) => expect(e.retryable).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });
});
