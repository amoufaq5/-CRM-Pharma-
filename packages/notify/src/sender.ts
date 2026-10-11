import { createHmac, timingSafeEqual } from "node:crypto";

import type { NotificationKind, Severity } from "./kinds.js";

/**
 * The channel seam, and the webhook channel behind it.
 *
 * `ChannelSender` exists so a channel can be added without redesign, and TWO are now
 * built: this one and `smtp.ts`. Neither is a stub, which is the whole policy — the ERP's
 * notification package declares eighteen providers across six channels and implements
 * exactly one of them, and the gap sat in its ADRs for releases. A seam with working
 * implementations behind it is worth more than a count of declared providers; SMS, push
 * and voice are still unbuilt and still named as unbuilt rather than declared.
 *
 * The webhook sender is the one that matters operationally: an incoming-webhook URL is how
 * Slack, Teams and PagerDuty are actually fed. Email is for the recipient who has no
 * such URL, which is most reps.
 */

export interface WebhookPayload {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly tenantId: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly subject: string;
  readonly body: string;
  readonly recipient: { readonly repProfileId: string; readonly displayName: string };
  readonly subjectRef: { readonly table: string | null; readonly id: string | null };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface SendOutcome {
  readonly kind: "delivered" | "retry" | "dead";
  readonly status?: number;
  readonly error?: string;
}

export interface ChannelSender {
  readonly channel: string;
  send(payload: WebhookPayload, endpoint: EndpointConfig): Promise<SendOutcome>;
}

export interface EndpointConfig {
  readonly id: string;
  readonly url: string;
  /** The NAME of the environment variable holding the HMAC secret, never the secret. */
  readonly secretEnv: string;
  /**
   * The mailbox THIS delivery was addressed to, for the `email_recipient` channel (0065).
   *
   * On the config object rather than on the payload because it is a property of the
   * destination and not of the signal: `WebhookPayload` is the body that goes out on the wire
   * to a webhook receiver, and a rep's mailbox has no business in it. Resolved when the
   * delivery row was created and copied onto it, so what is sent is what the record says was
   * sent — never re-resolved at send time, where an address changed in between would make the
   * row a lie.
   *
   * Undefined on every other channel, where `url` is the destination.
   */
  readonly toAddress?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export const SIGNATURE_HEADER = "x-crm-signature";
export const TIMESTAMP_HEADER = "x-crm-timestamp";
export const DELIVERY_HEADER = "x-crm-delivery";
export const EVENT_HEADER = "x-crm-event";

/**
 * The bytes a signature commits to: `<unix seconds>.<body>`.
 *
 * The timestamp is inside the signed material, not merely alongside it. Signing the body
 * alone would let anyone who captured one delivery replay it forever; this way a receiver
 * can reject anything older than its tolerance and the attacker cannot move the clock
 * without invalidating the signature. Same construction the ERP uses for its own webhook
 * HMAC, for the same reason.
 */
export function signingMaterial(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(signingMaterial(timestampSeconds, body), "utf8").digest("hex")}`;
}

/**
 * Verifies a signature the way a receiver should.
 *
 * Exported because it is the half this system does not run, and shipping it means the
 * receiving end has a reference rather than a reimplementation — and because the tests
 * verify against it, so the two halves are known to agree.
 *
 * Compared with `timingSafeEqual`: a byte-by-byte comparison leaks where the first
 * difference is, which over enough attempts recovers a signature.
 */
export function verifyWebhook(
  secret: string,
  timestampSeconds: number,
  body: string,
  presented: string,
  opts: { readonly nowSeconds?: number; readonly toleranceSeconds?: number } = {},
): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > tolerance) return false;

  const expected = Buffer.from(signWebhook(secret, timestampSeconds, body), "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface WebhookSenderOptions {
  readonly fetch: FetchLike;
  /** Reads the secret by variable name. Injected so a test need not mutate process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class WebhookSender implements ChannelSender {
  readonly channel = "webhook";
  private readonly opts: WebhookSenderOptions;

  constructor(opts: WebhookSenderOptions) {
    this.opts = opts;
  }

  async send(payload: WebhookPayload, endpoint: EndpointConfig): Promise<SendOutcome> {
    const env = this.opts.env ?? process.env;
    const secret = env[endpoint.secretEnv];
    if (secret === undefined || secret === "") {
      // Dead, not retried: a missing secret is a configuration fault that will still be
      // missing in ten minutes, and sending unsigned instead would be worse than not
      // sending at all.
      return {
        kind: "dead",
        error:
          `${endpoint.secretEnv} is not set in this process, so the delivery cannot be signed. ` +
          `Refusing to send unsigned.`,
      };
    }

    const body = JSON.stringify(payload);
    const timestamp = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

    try {
      const res = await this.opts.fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
          [TIMESTAMP_HEADER]: String(timestamp),
          // So a receiver can dedup. Delivery is at-least-once: a response that is lost
          // on the way back is indistinguishable from one that never arrived, so the
          // retry is correct and the duplicate is the receiver's to collapse.
          [DELIVERY_HEADER]: payload.deliveryId,
          [EVENT_HEADER]: payload.kind,
        },
        body,
        signal: controller.signal,
      });
      return classifyStatus(res.status, await safeText(res));
    } catch (err) {
      // Network failure, DNS, timeout. Retryable: the endpoint may be briefly down, and a
      // notification is worth a few minutes of patience.
      return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * What a status code means for a retry.
 *
 * The distinction that matters: a 4xx says the request was wrong and will be wrong again,
 * so retrying it burns attempts and delays the dead-letter that would tell an operator
 * something is misconfigured. 408, 429 and 5xx say "not now". 410 Gone is the one 4xx a
 * receiver uses deliberately to retire an endpoint, so it is honoured immediately.
 */
export function classifyStatus(status: number, detail = ""): SendOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered", status };
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", status, error: `endpoint returned ${status}${detail === "" ? "" : `: ${detail}`}` };
  }
  return {
    kind: "dead",
    status,
    error:
      `endpoint returned ${status}${detail === "" ? "" : `: ${detail}`} — ` +
      `a 4xx will not succeed on retry, so this is dead-lettered for an operator to look at`,
  };
}
