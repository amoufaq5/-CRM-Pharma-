/**
 * The email channel: a real SMTP client over `node:net` and `node:tls`.
 *
 * ADR-0001 left email unbuilt and gave unverifiability as the reason — no reachable mail
 * server from here, and the ERP's eighteen declared providers with one implementation as
 * the warning about writing senders you cannot exercise. The reason does not hold: the
 * server is the half you can write, so `testing-smtp.ts` is a real SMTP sink and every
 * claim below is checked against it, including the reply-code classification, which is
 * the part a mock would have let through wrong.
 *
 * No new dependency, deliberately: this package's runtime deps are `pg` and `@crm/db`, and
 * an SMTP client is four verbs and a reply parser. Nodemailer would be a larger surface
 * than the thing it does.
 *
 * Two splits worth knowing before reading:
 *
 * - **The relay is process configuration; the mailbox is tenant data.** A relay host, port
 *   and AUTH username are infrastructure, configured where `PGHOST` and `ERP_BASE_URL`
 *   are. An endpoint row says only *where this tenant's signals go*, so its `url` is a
 *   `mailto:`. Repointing a relay is then a restart, not a migration over every row.
 * - **The password comes from the environment by name.** `endpoint.secretEnv` holds the
 *   NAME of the variable, exactly as it does for the webhook HMAC secret, and a missing
 *   variable is dead rather than retried for the same reason: it will still be missing in
 *   ten minutes, and the alternative — connecting and authenticating with nothing — is
 *   worse than not sending.
 */
import { Buffer } from "node:buffer";
import { connect as netConnect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

import type { ChannelSender, EndpointConfig, SendOutcome, WebhookPayload } from "./sender.js";

/**
 * Where in the conversation a reply came from.
 *
 * Carried into every error message because an SMTP code alone is ambiguous: 550 at
 * `rcpt_to` is a bad address and 550 at `end_of_data` is a rejected message, and an
 * operator reading a dead letter needs to know which.
 */
export const SMTP_STAGES = [
  "greeting",
  "ehlo",
  "starttls",
  "auth_challenge",
  "auth",
  "mail_from",
  "rcpt_to",
  "data",
  "end_of_data",
] as const;
export type SmtpStage = (typeof SMTP_STAGES)[number];

/** The positive reply codes that let a stage proceed. Anything else is negative. */
export const SMTP_EXPECTED: Readonly<Record<SmtpStage, readonly number[]>> = {
  greeting: [220],
  ehlo: [250],
  starttls: [220],
  auth_challenge: [334],
  auth: [235],
  mail_from: [250],
  rcpt_to: [250, 251],
  data: [354],
  // 250 here, and only here, means the message was accepted.
  end_of_data: [250],
};

export type SmtpTransport = "starttls" | "implicit_tls" | "plaintext";

export class InvalidSmtpRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSmtpRelayError";
  }
}

export class InvalidMailEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMailEndpointError";
  }
}

/** The server is not speaking SMTP. Dead: it will not speak it on the next attempt either. */
export class SmtpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpProtocolError";
  }
}

/** A wait ran out. Retryable — indistinguishable from a relay that is briefly overloaded. */
export class SmtpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpTimeoutError";
  }
}

/**
 * What a reply code means for a retry, mirroring `classifyStatus` in sender.ts.
 *
 * SMTP draws the line the protocol itself draws, and it is the opposite way round from the
 * intuition that a 4xx is the client's fault: a 4xx is a *transient* negative reply — a
 * greylist, a full queue, a rate limit — and the sender is explicitly invited to try the
 * same message again. A 5xx is permanent. Getting this backwards is not a tidiness
 * problem: it either retries a bounced address until the attempt ceiling and dead-letters
 * it with the wrong reason, or it throws away a greylisted message, and greylisting is the
 * single most common 4xx a real relay will show you.
 *
 * A positive code at the wrong stage is dead rather than retried. It means the
 * conversation has lost step with the server, and replaying the same sequence loses step
 * again — the one thing a retry cannot fix.
 */
export function classifySmtpReply(stage: SmtpStage, code: number, text = ""): SendOutcome {
  const detail = text === "" ? "" : `: ${text}`;
  if (SMTP_EXPECTED[stage].includes(code)) return { kind: "delivered", status: code };
  if (code >= 400 && code < 500) {
    return {
      kind: "retry",
      status: code,
      error: `relay returned ${code} at ${stage}${detail} — a 4xx is a transient negative reply, so this is retried`,
    };
  }
  if (code >= 500 && code < 600) {
    return {
      kind: "dead",
      status: code,
      error: `relay returned ${code} at ${stage}${detail} — a 5xx is permanent, so this is dead-lettered for an operator to look at`,
    };
  }
  return {
    kind: "dead",
    status: code,
    error:
      `relay returned ${code} at ${stage}${detail}, where ${SMTP_EXPECTED[stage].join(" or ")} was required — ` +
      `the conversation is out of step and repeating it would be too`,
  };
}

/** Normalises to CRLF first, so dot-stuffing cannot be fooled by a bare LF. */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * The transparency dot (RFC 5321 §4.5.2).
 *
 * The end of DATA is the five octets `\r\n.\r\n`, so a body line that is a lone `.` ends
 * the message there and everything after it is silently lost — the message is truncated,
 * not rejected, which is why this is the failure mode worth a test of its own. A leading
 * dot on any line gets a second one, and the receiver removes it.
 */
export function dotStuff(data: string): string {
  return toCrlf(data)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

const ENCODED_WORD_OVERHEAD = "=?UTF-8?B??=".length;
/** 75 is the RFC 2047 ceiling for one encoded word; base64 only lands on 4-char groups. */
const ENCODED_WORD_PAYLOAD = Math.floor((75 - ENCODED_WORD_OVERHEAD) / 4) * 4;
const ENCODED_WORD_BYTES = (ENCODED_WORD_PAYLOAD / 4) * 3;

/**
 * RFC 2047 encoding for a header value, and header-injection defence.
 *
 * Rep names and account names here are routinely Arabic, and a header is 7-bit: a raw
 * 8-bit subject is mojibake at best and a rejected message at worst, so this is a real
 * bug in this product rather than a standards nicety.
 *
 * CR, LF and tab are collapsed to a space *before* the ASCII test, so a subject that
 * happens to contain a newline cannot inject a header of its own. Base64 rather than
 * quoted-printable because Arabic quoted-printable is almost entirely escapes, which
 * overflows the 75-octet word limit far sooner.
 */
export function encodeHeaderValue(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(flat) && !flat.includes("=?")) return flat;

  const words: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const codepoint of flat) {
    const width = Buffer.byteLength(codepoint, "utf8");
    // Split on codepoint boundaries: a word that ends mid-sequence decodes to a
    // replacement character, and the two halves never rejoin.
    if (bytes + width > ENCODED_WORD_BYTES && chunk.length > 0) {
      words.push(chunk.join(""));
      chunk = [];
      bytes = 0;
    }
    chunk.push(codepoint);
    bytes += width;
  }
  if (chunk.length > 0) words.push(chunk.join(""));

  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/** The SASL PLAIN token: NUL authzid, NUL authcid, NUL password, base64'd (RFC 4616). */
export function authPlainToken(username: string, password: string): string {
  return Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");
}

/**
 * PLAIN over LOGIN wherever both are offered: one round trip instead of three, and LOGIN
 * is a de-facto mechanism that was never specified. Neither offered returns null, and the
 * caller decides what that means — which depends on whether credentials were configured.
 */
export function chooseAuthMechanism(offered: readonly string[]): "PLAIN" | "LOGIN" | null {
  const upper = offered.map((m) => m.toUpperCase());
  if (upper.includes("PLAIN")) return "PLAIN";
  if (upper.includes("LOGIN")) return "LOGIN";
  return null;
}

export interface EhloCapabilities {
  readonly startTls: boolean;
  readonly eightBitMime: boolean;
  readonly authMechanisms: readonly string[];
  readonly maxSize: number | null;
}

/**
 * Reads the EHLO extension lines. The first line is the server's greeting, not a keyword.
 *
 * `AUTH=PLAIN LOGIN` is accepted alongside `AUTH PLAIN LOGIN` because a generation of
 * servers shipped the `=` form and some are still in front of corporate mail.
 */
export function parseEhloCapabilities(lines: readonly string[]): EhloCapabilities {
  let startTls = false;
  let eightBitMime = false;
  let maxSize: number | null = null;
  const authMechanisms: string[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/).filter((p) => p !== "");
    const keyword = (parts[0] ?? "").toUpperCase();
    if (keyword === "STARTTLS") startTls = true;
    else if (keyword === "8BITMIME") eightBitMime = true;
    else if (keyword === "SIZE") {
      const n = Number(parts[1]);
      if (Number.isSafeInteger(n) && n > 0) maxSize = n;
    } else if (keyword === "AUTH" || keyword.startsWith("AUTH=")) {
      if (keyword.startsWith("AUTH=")) authMechanisms.push(keyword.slice(5));
      authMechanisms.push(...parts.slice(1).map((m) => m.toUpperCase()));
    }
  }
  return { startTls, eightBitMime, authMechanisms, maxSize };
}

const ADDRESS = /^[^\s<>@,;:"]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function isMailbox(address: string): boolean {
  return ADDRESS.test(address) && address.length <= 254;
}

/**
 * The endpoint URL for this channel: `mailto:` and one mailbox.
 *
 * One, not a list. `SendOutcome` is a single verdict, and two recipients can produce two
 * different ones — a 550 for a closed mailbox and a 250 for the other — with nowhere to
 * record the difference. A second destination is a second endpoint row, which also gets
 * it its own severity threshold and kind filter.
 */
export function parseMailtoEndpoint(url: string): string {
  const prefix = "mailto:";
  if (!url.toLowerCase().startsWith(prefix)) {
    throw new InvalidMailEndpointError(
      `an email endpoint URL must be a mailto:, not ${JSON.stringify(url.slice(0, 60))}`,
    );
  }
  const withoutQuery = url.slice(prefix.length).split("?")[0] ?? "";
  const address = decodeURIComponent(withoutQuery).trim();
  if (address.includes(",")) {
    throw new InvalidMailEndpointError(
      `${JSON.stringify(address)} names more than one mailbox; one endpoint is one destination, ` +
        `because one delivery has one outcome`,
    );
  }
  if (!isMailbox(address)) {
    throw new InvalidMailEndpointError(`${JSON.stringify(address)} is not a usable mailbox`);
  }
  return address;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare === "::1" ||
    /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(bare)
  );
}

export interface SmtpRelayConfig {
  readonly host: string;
  readonly port: number;
  /**
   * `starttls` (the default) upgrades a plaintext connection and refuses to continue if it
   * cannot. `implicit_tls` is TLS from the first byte, the 465 convention. `plaintext`
   * never encrypts and is accepted only for a loopback relay.
   */
  readonly transport?: SmtpTransport;
  readonly from: string;
  /** Configured only when the relay wants AUTH. Absent means no AUTH is attempted. */
  readonly username?: string;
  /** The EHLO argument. Defaults to the domain of `from`, which is what it should be. */
  readonly clientName?: string;
}

export interface SmtpSenderOptions {
  readonly relay: SmtpRelayConfig;
  /** Reads the password by variable name. Injected so a test need not mutate process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Per network wait. Default 10s, matching the webhook sender. */
  readonly timeoutMs?: number;
  /**
   * For the whole conversation. Default 60s. A per-wait timeout alone can be reset forever
   * by a server that answers one line every nine seconds, which would pin a dispatcher
   * worker for as long as it cared to.
   */
  readonly overallTimeoutMs?: number;
  readonly now?: () => number;
  readonly tlsOptions?: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>;
  /** The channel name this sender answers to, for when the column spells it differently. */
  readonly channel?: string;
}

export interface MessageOptions {
  readonly from: string;
  readonly to: string;
  readonly nowMs: number;
  readonly encoding: "7bit" | "8bit" | "base64";
}

/**
 * How to carry the body.
 *
 * `8bit` keeps UTF-8 as it is, but only where the relay said 8BITMIME — handing raw
 * high bytes to a 7-bit relay is exactly how an Arabic body arrives as mojibake. Base64
 * is also the answer for a line over the 998-octet limit of RFC 5321: wrapping would be
 * an edit to someone's notification text, and base64 carries it unchanged.
 */
export function chooseEncoding(
  body: string,
  caps: { readonly eightBitMime: boolean },
): "7bit" | "8bit" | "base64" {
  const lines = toCrlf(body).split("\r\n");
  const longLine = lines.some((l) => Buffer.byteLength(l, "utf8") > 998);
  if (longLine) return "base64";
  const ascii = !/[^\x00-\x7f]/.test(body);
  if (ascii) return "7bit";
  return caps.eightBitMime ? "8bit" : "base64";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** RFC 5322 §3.3, always in UTC: `+0000`, not the obsolete `GMT` that `toUTCString` emits. */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAYS[d.getUTCDay()]!}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]!} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

function wrapBase64(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * The message, headers and all.
 *
 * `payload.payload` — the structured facts a webhook receiver parses — is deliberately
 * left out. A human reads this one, and the lot number or account id that matters is
 * already in the notification body; a JSON blob under it is noise that also widens what
 * leaves the system by email.
 */
export function buildMessage(payload: WebhookPayload, opts: MessageOptions): string {
  const body = toCrlf(
    [
      payload.body,
      "",
      `Severity:  ${payload.severity}`,
      `Signal:    ${payload.kind}`,
      `Recipient: ${payload.recipient.displayName}`,
      ...(payload.subjectRef.table === null
        ? []
        : [`Record:    ${payload.subjectRef.table} ${payload.subjectRef.id ?? "(none)"}`]),
      `Raised:    ${payload.createdAt}`,
      `Delivery:  ${payload.deliveryId}`,
      "",
      "Sent by the CRM. Replies are not read.",
    ].join("\n"),
  );

  const headers: readonly (readonly [string, string])[] = [
    ["From", `<${opts.from}>`],
    ["To", `<${opts.to}>`],
    ["Subject", encodeHeaderValue(payload.subject)],
    ["Date", rfc5322Date(opts.nowMs)],
    // The delivery id, so a relay's logs and a dead letter name the same thing. Delivery
    // is at-least-once, as it is for the webhook channel, so this is also what a receiver
    // would collapse a duplicate on.
    ["Message-ID", `<${payload.deliveryId}@${domainOf(opts.from)}>`],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="utf-8"'],
    ["Content-Transfer-Encoding", opts.encoding],
    // Stops a vacation autoresponder answering a robot, and stops the loop that follows.
    ["Auto-Submitted", "auto-generated"],
    ["X-CRM-Delivery", payload.deliveryId],
    ["X-CRM-Event", payload.kind],
  ];

  const block = headers.map(([name, value]) => `${name}: ${value}`).join("\r\n");
  return `${block}\r\n\r\n${opts.encoding === "base64" ? wrapBase64(body) : body}`;
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * One SMTP conversation.
 *
 * Replies are accumulated by a listener that is always attached, never one added per read:
 * a server is free to send the greeting before anyone asks for it, and bytes that arrive
 * while nothing is listening would be gone.
 */
class SmtpConversation {
  private socket: Socket | TLSSocket;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private failure: Error | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(
    socket: Socket | TLSSocket,
    private readonly perWaitMs: number,
    private readonly deadlineAt: number,
  ) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      this.wake?.();
    });
    this.socket.on("error", (err: Error) => {
      this.failure = err;
      this.wake?.();
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }

  send(line: string): void {
    this.socket.write(Buffer.from(`${line}\r\n`, "utf8"));
  }

  sendRaw(text: string): void {
    this.socket.write(Buffer.from(text, "utf8"));
  }

  async read(stage: SmtpStage): Promise<SmtpReply> {
    for (;;) {
      const reply = this.take();
      if (reply !== null) return reply;
      if (this.failure !== null) throw this.failure;
      if (this.closed) {
        throw new Error(`the relay closed the connection while the ${stage} reply was outstanding`);
      }
      await this.waitForBytes(stage);
    }
  }

  private waitForBytes(stage: SmtpStage): Promise<void> {
    const remaining = this.deadlineAt - Date.now();
    const budget = Math.min(this.perWaitMs, remaining);
    if (budget <= 0) {
      return Promise.reject(
        new SmtpTimeoutError(`the conversation ran past its overall timeout waiting for ${stage}`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new SmtpTimeoutError(`no ${stage} reply from the relay within ${budget}ms`));
      }, budget);
      this.wake = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /** A complete reply, or null while the last line has not arrived. */
  private take(): SmtpReply | null {
    const lines: string[] = [];
    let offset = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\r\n", offset);
      if (nl === -1) return null;
      const line = this.buffer.slice(offset, nl);
      offset = nl + 2;
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (match === null) {
        throw new SmtpProtocolError(
          `${JSON.stringify(line.slice(0, 120))} is not an SMTP reply line`,
        );
      }
      lines.push(match[3] ?? "");
      // A hyphen after the code continues the reply; a space, or nothing, ends it.
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(offset);
        return { code: Number(match[1]), lines };
      }
    }
  }

  /**
   * Hands the plaintext socket to TLS and starts reading the encrypted stream.
   *
   * The decoder is replaced along with the listener: the old one may hold a partial
   * codepoint from the cleartext phase, which would corrupt the first encrypted reply.
   */
  async upgrade(
    host: string,
    tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>,
  ): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");

    const secure = tlsConnect({ ...tlsOptions, socket: plain, host });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmtpTimeoutError(`the TLS handshake did not complete within ${this.perWaitMs}ms`)),
        Math.max(1, Math.min(this.perWaitMs, this.deadlineAt - Date.now())),
      );
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.socket = secure;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.failure = null;
    this.closed = false;
    this.attach();
  }

  /**
   * Says goodbye and waits for the close, briefly.
   *
   * `end` rather than `write` then `destroy`: a destroy discards whatever has not flushed,
   * so the relay would log an aborted connection for every message it had just accepted.
   * The wait is capped because the message is already queued and nothing after this can
   * change that.
   */
  async quit(): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(done, Math.min(1_000, this.perWaitMs));
      this.socket.once("close", done);
      this.socket.end(Buffer.from("QUIT\r\n", "utf8"));
    });
  }

  destroy(): void {
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

export class SmtpSender implements ChannelSender {
  readonly channel: string;
  private readonly relay: SmtpRelayConfig;
  private readonly transport: SmtpTransport;

  /**
   * Transport is checked here rather than at send time, so a relay configured without TLS
   * fails the process at boot. The webhook sender's analogous refusal is per-delivery
   * because its secret is per-endpoint; this one is one statement about one process, and a
   * scheduler that will never be allowed to send should not start and then dead-letter
   * every notification it is handed.
   */
  constructor(private readonly opts: SmtpSenderOptions) {
    this.channel = opts.channel ?? "email";
    this.relay = opts.relay;
    this.transport = opts.relay.transport ?? "starttls";

    if (!isMailbox(this.relay.from)) {
      throw new InvalidSmtpRelayError(`${JSON.stringify(this.relay.from)} is not a usable From address`);
    }
    if (!Number.isInteger(this.relay.port) || this.relay.port < 1 || this.relay.port > 65_535) {
      throw new InvalidSmtpRelayError(`${String(this.relay.port)} is not a port`);
    }
    if (this.transport === "plaintext" && !isLoopbackHost(this.relay.host)) {
      // Same line the webhook URL constraint draws, for the same reason: a notification
      // carries a rep's name, an account id and sometimes a lot number, and none of that
      // goes over plaintext to another host. Loopback traffic never leaves the machine, so
      // the exception is narrow enough to buy a local sink to test against — and it is
      // narrow in the only way that matters, the destination, not a boolean an operator
      // can flip for the whole process.
      throw new InvalidSmtpRelayError(
        `plaintext SMTP is allowed only to a loopback relay, not to ${this.relay.host}. ` +
          `A notification carries a rep's name and an account id; use starttls or implicit_tls.`,
      );
    }
  }

  async send(payload: WebhookPayload, endpoint: EndpointConfig): Promise<SendOutcome> {
    let to: string;
    try {
      to = parseMailtoEndpoint(endpoint.url);
    } catch (err) {
      // Dead: the row will say the same thing on the next attempt.
      return { kind: "dead", error: err instanceof Error ? err.message : String(err) };
    }

    const env = this.opts.env ?? process.env;
    const username = this.relay.username;
    let password: string | undefined;
    if (username !== undefined) {
      password = env[endpoint.secretEnv];
      if (password === undefined || password === "") {
        // Checked before the socket, so a misconfigured process never opens a connection
        // it cannot finish. Dead for the same reason the webhook sender's missing HMAC
        // secret is dead: it will still be missing in ten minutes.
        return {
          kind: "dead",
          error:
            `${endpoint.secretEnv} is not set in this process, so the relay cannot be authenticated as ` +
            `${username}. Refusing to connect.`,
        };
      }
    }

    const nowMs = this.opts.now?.() ?? Date.now();
    const perWait = this.opts.timeoutMs ?? 10_000;
    const deadlineAt = nowMs + (this.opts.overallTimeoutMs ?? 60_000);
    const tlsOptions = this.opts.tlsOptions ?? {};

    let conversation: SmtpConversation | null = null;
    try {
      conversation = await this.open(perWait, deadlineAt, tlsOptions);
      return await this.converse(conversation, payload, { to, username, password, nowMs, tlsOptions });
    } catch (err) {
      if (err instanceof SmtpProtocolError) {
        return { kind: "dead", error: `${err.message} — the relay is not speaking SMTP` };
      }
      // Connection refused, DNS, a reset, a timeout, a TLS handshake failure. Retryable:
      // the relay may be briefly down, and a notification is worth a few minutes.
      return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
    } finally {
      conversation?.destroy();
    }
  }

  private async open(
    perWait: number,
    deadlineAt: number,
    tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>,
  ): Promise<SmtpConversation> {
    const { host, port } = this.relay;
    const socket: Socket | TLSSocket =
      this.transport === "implicit_tls"
        ? tlsConnect({ ...tlsOptions, host, port })
        : netConnect({ host, port });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmtpTimeoutError(`could not connect to ${host}:${String(port)} within ${perWait}ms`)),
        Math.max(1, Math.min(perWait, deadlineAt - Date.now())),
      );
      const settle = (err?: Error): void => {
        clearTimeout(timer);
        socket.removeListener("error", settle);
        if (err === undefined) resolve();
        else reject(err);
      };
      socket.once(this.transport === "implicit_tls" ? "secureConnect" : "connect", () => settle());
      socket.once("error", settle);
    });

    return new SmtpConversation(socket, perWait, deadlineAt);
  }

  private async converse(
    conn: SmtpConversation,
    payload: WebhookPayload,
    ctx: {
      readonly to: string;
      readonly username: string | undefined;
      readonly password: string | undefined;
      readonly nowMs: number;
      readonly tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>;
    },
  ): Promise<SendOutcome> {
    const step = async (stage: SmtpStage): Promise<SendOutcome | SmtpReply> => {
      const reply = await conn.read(stage);
      const verdict = classifySmtpReply(stage, reply.code, reply.lines.join(" ").trim());
      return verdict.kind === "delivered" ? reply : verdict;
    };

    const greeting = await step("greeting");
    if ("kind" in greeting) return greeting;

    const ehloName = this.relay.clientName ?? domainOf(this.relay.from);
    conn.send(`EHLO ${ehloName}`);
    const ehlo = await step("ehlo");
    if ("kind" in ehlo) return ehlo;
    let caps = parseEhloCapabilities(ehlo.lines);

    if (this.transport === "starttls") {
      if (!caps.startTls) {
        // Fail closed. The alternative is to carry the rep's name and the account id in
        // clear text to another host, which is the thing the transport rule exists to stop.
        return {
          kind: "dead",
          error:
            `${this.relay.host}:${String(this.relay.port)} does not offer STARTTLS, so this message would ` +
            `cross the network in clear text. Refusing to send.`,
        };
      }
      conn.send("STARTTLS");
      const ready = await step("starttls");
      if ("kind" in ready) return ready;
      if (conn.pendingBytes > 0) {
        // Bytes after the 220 would be plaintext the TLS layer never sees — either a
        // broken relay or someone injecting ahead of the handshake. Neither is sendable.
        return {
          kind: "dead",
          error: `${this.relay.host} sent data after its STARTTLS reply; refusing to hand a dirty socket to TLS`,
        };
      }
      await conn.upgrade(this.relay.host, ctx.tlsOptions);

      // RFC 3207: everything learned in the clear is discarded, extension list included —
      // a relay that only advertises AUTH after TLS is the normal case, not the exception.
      conn.send(`EHLO ${ehloName}`);
      const second = await step("ehlo");
      if ("kind" in second) return second;
      caps = parseEhloCapabilities(second.lines);
    }

    if (ctx.username !== undefined && ctx.password !== undefined) {
      const mechanism = chooseAuthMechanism(caps.authMechanisms);
      if (mechanism === null) {
        return {
          kind: "dead",
          error:
            `${this.relay.host} offers no AUTH mechanism this client supports ` +
            `(${caps.authMechanisms.length === 0 ? "it advertised none" : caps.authMechanisms.join(", ")}), ` +
            `but a username is configured. Refusing to send unauthenticated as ${ctx.username}.`,
        };
      }
      const authed = await this.authenticate(conn, step, mechanism, ctx.username, ctx.password);
      if (authed !== null) return authed;
    }

    const encoding = chooseEncoding(payload.body, caps);
    const message = buildMessage(payload, {
      from: this.relay.from,
      to: ctx.to,
      nowMs: ctx.nowMs,
      encoding,
    });
    const sizeBytes = Buffer.byteLength(message, "utf8");
    if (caps.maxSize !== null && sizeBytes > caps.maxSize) {
      // Dead rather than attempted: the relay has already said it will refuse, and the
      // message will be the same size next time.
      return {
        kind: "dead",
        error: `the message is ${String(sizeBytes)} bytes and ${this.relay.host} accepts at most ${String(caps.maxSize)}`,
      };
    }

    // BODY=8BITMIME is how the relay is told the body really is 8-bit; without it a
    // conforming relay may downgrade or refuse what `chooseEncoding` just decided to send
    // raw. It is only ever appended when the extension was advertised.
    conn.send(`MAIL FROM:<${this.relay.from}>${encoding === "8bit" ? " BODY=8BITMIME" : ""}`);
    const mail = await step("mail_from");
    if ("kind" in mail) return mail;

    conn.send(`RCPT TO:<${ctx.to}>`);
    const rcpt = await step("rcpt_to");
    if ("kind" in rcpt) return rcpt;

    conn.send("DATA");
    const data = await step("data");
    if ("kind" in data) return data;

    conn.sendRaw(`${dotStuff(message).replace(/(\r\n)+$/, "")}\r\n.\r\n`);
    const accepted = await step("end_of_data");
    if ("kind" in accepted) return accepted;

    // The message is queued the moment that 250 arrives. QUIT is courtesy, and anything
    // that goes wrong in it must not turn a delivered notification into a retry that
    // sends it a second time.
    try {
      await conn.quit();
    } catch {
      /* already delivered */
    }
    return { kind: "delivered", status: accepted.code };
  }

  private async authenticate(
    conn: SmtpConversation,
    step: (stage: SmtpStage) => Promise<SendOutcome | SmtpReply>,
    mechanism: "PLAIN" | "LOGIN",
    username: string,
    password: string,
  ): Promise<SendOutcome | null> {
    if (mechanism === "PLAIN") {
      conn.send(`AUTH PLAIN ${authPlainToken(username, password)}`);
      const reply = await step("auth");
      return "kind" in reply ? reply : null;
    }

    conn.send("AUTH LOGIN");
    const userChallenge = await step("auth_challenge");
    if ("kind" in userChallenge) return userChallenge;
    conn.send(Buffer.from(username, "utf8").toString("base64"));
    const passChallenge = await step("auth_challenge");
    if ("kind" in passChallenge) return passChallenge;
    conn.send(Buffer.from(password, "utf8").toString("base64"));
    const reply = await step("auth");
    return "kind" in reply ? reply : null;
  }
}
