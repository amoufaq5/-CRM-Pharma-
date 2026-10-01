import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookSender,
  classifyStatus,
  signWebhook,
  signingMaterial,
  verifyWebhook,
  type FetchLike,
  type WebhookPayload,
} from "./sender.js";

const SECRET = "s3cret-value";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const PAYLOAD: WebhookPayload = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  notificationId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  kind: "disposal_obligation_overdue",
  severity: "urgent",
  subject: "OVERDUE: expired stock",
  body: "Lot LOT-A was due for disposal",
  recipient: { repProfileId: "44444444-4444-4444-8444-444444444444", displayName: "A. Rep" },
  subjectRef: { table: "crm.disposal_obligation", id: "55555555-5555-4555-8555-555555555555" },
  payload: { lotNumber: "LOT-A" },
  createdAt: "2027-01-15T09:00:00.000Z",
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function capturingFetch(status: number, text = "ok"): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve({ status, text: () => Promise.resolve(text) });
  };
  return { fetch, calls };
}

const endpoint = { id: "e1", url: "https://hooks.example.com/abc", secretEnv: "CRM_HOOK_SECRET" };

describe("the signature", () => {
  /**
   * The timestamp is INSIDE the signed material, not merely alongside it. Signing the body
   * alone would let anyone who captured one delivery replay it forever.
   */
  it("commits to the timestamp as well as the body", () => {
    expect(signingMaterial(NOW_S, '{"a":1}')).toBe(`${NOW_S}.{"a":1}`);
    expect(signWebhook(SECRET, NOW_S, "x")).not.toBe(signWebhook(SECRET, NOW_S + 1, "x"));
  });

  it("is an HMAC-SHA256 a receiver can recompute with nothing but the secret", () => {
    const body = JSON.stringify(PAYLOAD);
    const expected = createHmac("sha256", SECRET).update(`${NOW_S}.${body}`, "utf8").digest("hex");
    expect(signWebhook(SECRET, NOW_S, body)).toBe(`sha256=${expected}`);
  });

  it("verifies its own output", () => {
    const body = JSON.stringify(PAYLOAD);
    const sig = signWebhook(SECRET, NOW_S, body);
    expect(verifyWebhook(SECRET, NOW_S, body, sig, { nowSeconds: NOW_S })).toBe(true);
  });

  it("rejects a wrong secret, a changed body and a changed timestamp", () => {
    const body = JSON.stringify(PAYLOAD);
    const sig = signWebhook(SECRET, NOW_S, body);
    expect(verifyWebhook("other", NOW_S, body, sig, { nowSeconds: NOW_S })).toBe(false);
    expect(verifyWebhook(SECRET, NOW_S, `${body} `, sig, { nowSeconds: NOW_S })).toBe(false);
    expect(verifyWebhook(SECRET, NOW_S + 1, body, sig, { nowSeconds: NOW_S })).toBe(false);
  });

  /** The replay window: a captured delivery stops being accepted. */
  it("rejects a signature outside the tolerance window, in either direction", () => {
    const body = "x";
    const sig = signWebhook(SECRET, NOW_S, body);
    expect(verifyWebhook(SECRET, NOW_S, body, sig, { nowSeconds: NOW_S + 299 })).toBe(true);
    expect(verifyWebhook(SECRET, NOW_S, body, sig, { nowSeconds: NOW_S + 301 })).toBe(false);
    // Ahead as well as behind: a clock skewed forward must not widen the window.
    expect(verifyWebhook(SECRET, NOW_S, body, sig, { nowSeconds: NOW_S - 301 })).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifyWebhook(SECRET, NOW_S, "x", "", { nowSeconds: NOW_S })).toBe(false);
    expect(verifyWebhook(SECRET, NOW_S, "x", "sha256=zz", { nowSeconds: NOW_S })).toBe(false);
  });
});

describe("WebhookSender", () => {
  it("posts a signed JSON body with the headers a receiver needs", async () => {
    const { fetch, calls } = capturingFetch(200);
    const sender = new WebhookSender({ fetch, env: { CRM_HOOK_SECRET: SECRET }, now: () => NOW_MS });

    expect(await sender.send(PAYLOAD, endpoint)).toEqual({ kind: "delivered", status: 200 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(endpoint.url);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers[TIMESTAMP_HEADER]).toBe(String(NOW_S));
    expect(call.headers[EVENT_HEADER]).toBe("disposal_obligation_overdue");
    // So a receiver can collapse a duplicate: delivery is at-least-once.
    expect(call.headers[DELIVERY_HEADER]).toBe(PAYLOAD.deliveryId);
    // And the signature verifies against exactly the bytes that were sent.
    expect(
      verifyWebhook(SECRET, Number(call.headers[TIMESTAMP_HEADER]), call.body, call.headers[SIGNATURE_HEADER]!, {
        nowSeconds: NOW_S,
      }),
    ).toBe(true);
    expect(JSON.parse(call.body)).toEqual(PAYLOAD);
  });

  /**
   * A missing secret is dead, not retried — it will still be missing in ten minutes. And
   * sending unsigned instead would be worse than not sending at all.
   */
  it("refuses to send unsigned when the secret variable is absent", async () => {
    const { fetch, calls } = capturingFetch(200);
    const sender = new WebhookSender({ fetch, env: {}, now: () => NOW_MS });
    const outcome = await sender.send(PAYLOAD, endpoint);
    expect(outcome.kind).toBe("dead");
    expect(outcome.error).toMatch(/CRM_HOOK_SECRET is not set/);
    expect(outcome.error).toMatch(/Refusing to send unsigned/);
    expect(calls).toHaveLength(0);
  });

  it("treats an empty secret as absent", async () => {
    const { fetch } = capturingFetch(200);
    const sender = new WebhookSender({ fetch, env: { CRM_HOOK_SECRET: "" } });
    expect((await sender.send(PAYLOAD, endpoint)).kind).toBe("dead");
  });

  it("retries a network failure", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const sender = new WebhookSender({ fetch, env: { CRM_HOOK_SECRET: SECRET } });
    const outcome = await sender.send(PAYLOAD, endpoint);
    expect(outcome.kind).toBe("retry");
    expect(outcome.error).toMatch(/ECONNREFUSED/);
  });
});

describe("classifyStatus", () => {
  it("treats every 2xx as delivered", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classifyStatus(status).kind).toBe("delivered");
    }
  });

  /** "Not now" — the endpoint may be briefly down, and a notification is worth patience. */
  it("retries 408, 429 and every 5xx", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyStatus(status).kind, `${status}`).toBe("retry");
    }
  });

  /**
   * A 4xx says the request was wrong and will be wrong again. Retrying burns attempts and
   * delays the dead-letter that would tell an operator something is misconfigured.
   */
  it("dead-letters other 4xx, saying why retrying would not help", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      const outcome = classifyStatus(status);
      expect(outcome.kind, `${status}`).toBe("dead");
      expect(outcome.error).toMatch(/will not succeed on retry/);
    }
  });

  it("carries a truncated response body into the error, for diagnosis", () => {
    expect(classifyStatus(500, "upstream exploded").error).toMatch(/upstream exploded/);
  });
});
