import { describe, expect, it } from "vitest";

import {
  InvalidMailEndpointError,
  InvalidSmtpRelayError,
  SMTP_EXPECTED,
  SMTP_STAGES,
  SmtpSender,
  authPlainToken,
  buildMessage,
  chooseAuthMechanism,
  chooseEncoding,
  classifySmtpReply,
  dotStuff,
  encodeHeaderValue,
  isLoopbackHost,
  isMailbox,
  parseEhloCapabilities,
  parseMailtoEndpoint,
  rfc5322Date,
  toCrlf,
} from "./smtp.js";
import { decodeEncodedWords } from "./testing-smtp.js";
import type { WebhookPayload } from "./sender.js";

const NOW_MS = 1_800_000_000_000;

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

const RELAY = { host: "127.0.0.1", port: 2525, from: "crm@crm.example", transport: "plaintext" } as const;

describe("classifySmtpReply", () => {
  it("lets every stage proceed on its own positive code, and on nothing else below 400", () => {
    for (const stage of SMTP_STAGES) {
      expect(SMTP_EXPECTED[stage].length, stage).toBeGreaterThan(0);
      for (const code of SMTP_EXPECTED[stage]) {
        expect(code, stage).toBeLessThan(400);
        expect(classifySmtpReply(stage, code).kind, `${stage}/${String(code)}`).toBe("delivered");
      }
    }
    // 251 is a forwarded recipient, and only RCPT TO may see it.
    expect(classifySmtpReply("rcpt_to", 251).kind).toBe("delivered");
    expect(classifySmtpReply("mail_from", 251).kind).toBe("dead");
  });

  /**
   * The heart of it, and the way round that is easy to get wrong: in SMTP a 4xx is the
   * TRANSIENT reply — a greylist, a full queue, a rate limit — and the sender is invited
   * to send the same message again.
   */
  it("retries every 4xx, at every stage", () => {
    for (const stage of SMTP_STAGES) {
      for (const code of [421, 450, 451, 452, 454, 471]) {
        const outcome = classifySmtpReply(stage, code);
        expect(outcome.kind, `${stage}/${String(code)}`).toBe("retry");
        expect(outcome.status).toBe(code);
      }
    }
    expect(classifySmtpReply("end_of_data", 452).error).toMatch(/transient negative reply, so this is retried/);
  });

  it("dead-letters every 5xx, at every stage", () => {
    for (const stage of SMTP_STAGES) {
      for (const code of [500, 502, 530, 535, 550, 552, 554]) {
        const outcome = classifySmtpReply(stage, code);
        expect(outcome.kind, `${stage}/${String(code)}`).toBe("dead");
        expect(outcome.status).toBe(code);
      }
    }
    expect(classifySmtpReply("end_of_data", 554).error).toMatch(/permanent, so this is dead-lettered/);
  });

  /**
   * A positive code at the wrong stage is dead, not retried: the conversation has lost
   * step with the server and replaying the same sequence loses step again. And the stage
   * is in every message because a bare code is ambiguous — 550 at RCPT TO is a bad
   * address, 550 after DATA is a rejected message.
   */
  it("dead-letters a positive reply at the wrong stage, and names the stage and the relay's text", () => {
    const outcome = classifySmtpReply("data", 250);
    expect(outcome.kind).toBe("dead");
    expect(outcome.error).toMatch(/where 354 was required/);
    expect(outcome.error).toMatch(/out of step/);
    expect(classifySmtpReply("rcpt_to", 550, "5.1.1 no such user").error).toMatch(/at rcpt_to.*5\.1\.1 no such user/);
    expect(classifySmtpReply("end_of_data", 550).error).toMatch(/at end_of_data/);
  });
});

describe("dot-stuffing", () => {
  /**
   * The end of DATA is `\r\n.\r\n`, so a body line that is a lone `.` ends the message
   * there and everything after it is lost — truncated, not refused, which is why this gets
   * a test rather than a comment.
   */
  it("doubles a lone dot line, so the message is not truncated at it", () => {
    expect(dotStuff("before\r\n.\r\nafter")).toBe("before\r\n..\r\nafter");
    expect(dotStuff("before\r\n.\r\nafter")).not.toContain("\r\n.\r\n");
  });

  it("doubles any leading dot and leaves every other dot alone, so un-stuffing is exact", () => {
    expect(dotStuff(".hidden\r\n.config\r\nplain")).toBe("..hidden\r\n..config\r\nplain");
    expect(dotStuff("..\r\nx")).toBe("...\r\nx");
    expect(dotStuff("a.b\r\nend.")).toBe("a.b\r\nend.");
  });

  it("normalises to CRLF first, so a bare LF cannot smuggle a dot line past it", () => {
    expect(dotStuff("before\n.\nafter")).toBe("before\r\n..\r\nafter");
    expect(toCrlf("a\r\nb\nc\rd")).toBe("a\r\nb\r\nc\r\nd");
  });
});

describe("header encoding", () => {
  /**
   * Rep and account names here are routinely Arabic. A raw 8-bit header is mojibake at
   * best and a refused message at worst, so this is a real bug in this product. ASCII is
   * left alone because an encoded word nobody needs is just a subject nobody can read in
   * a log.
   */
  it("leaves ASCII alone and encodes anything else, round-tripping through an independent decoder", () => {
    expect(encodeHeaderValue("OVERDUE: expired stock")).toBe("OVERDUE: expired stock");
    const encoded = encodeHeaderValue("مخزون منتهي الصلاحية");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    for (const subject of ["مخزون منتهي الصلاحية", "عاجل: دفعة LOT-A", "Überfällig", "期限切れ"]) {
      expect(decodeEncodedWords(encodeHeaderValue(subject))).toBe(subject);
    }
  });

  /** A word that ends mid-sequence decodes to a replacement character, and never rejoins. */
  it("folds into words of at most 75 octets without splitting a UTF-8 codepoint", () => {
    const long = `عاجل ${"مخزون منتهي الصلاحية ".repeat(12)}`.trim();
    const encoded = encodeHeaderValue(long);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeEncodedWords(encoded)).toBe(long);

    const run = "ا".repeat(200);
    expect(decodeEncodedWords(encodeHeaderValue(run))).toBe(run);
    expect(decodeEncodedWords(encodeHeaderValue(run))).not.toContain("�");
  });

  /** A subject with a newline in it would otherwise inject a header of its own. */
  it("collapses CR, LF and tab before deciding anything, so a header cannot be injected", () => {
    const encoded = encodeHeaderValue("harmless\r\nBcc: attacker@example.com");
    expect(encoded).toBe("harmless Bcc: attacker@example.com");
    expect(encoded).not.toMatch(/[\r\n]/);
  });

  it("encodes a value that merely looks like an encoded word, so it decodes back to itself", () => {
    const encoded = encodeHeaderValue("=?UTF-8?B?bm90IG1pbmU=?=");
    expect(encoded).not.toBe("=?UTF-8?B?bm90IG1pbmU=?=");
    expect(decodeEncodedWords(encoded)).toBe("=?UTF-8?B?bm90IG1pbmU=?=");
  });
});

describe("AUTH", () => {
  /** SASL PLAIN is NUL authzid, NUL authcid, NUL password — the leading NUL is not a typo. */
  it("builds the PLAIN token with an empty authzid, in UTF-8", () => {
    const token = authPlainToken("relay-user", "pa55");
    expect(Buffer.from(token, "base64").toString("utf8")).toBe("\0relay-user\0pa55");
    expect(token).toBe(Buffer.from("\u0000relay-user\u0000pa55", "utf8").toString("base64"));
    expect(Buffer.from(authPlainToken("u", "pä55"), "base64").toString("utf8")).toBe("\0u\0pä55");
  });

  /** PLAIN first: one round trip instead of three, and LOGIN was never specified. */
  it("prefers PLAIN, falls back to LOGIN, and returns null for anything else", () => {
    expect(chooseAuthMechanism(["LOGIN", "PLAIN"])).toBe("PLAIN");
    expect(chooseAuthMechanism(["plain"])).toBe("PLAIN");
    expect(chooseAuthMechanism(["LOGIN"])).toBe("LOGIN");
    expect(chooseAuthMechanism([])).toBeNull();
    expect(chooseAuthMechanism(["CRAM-MD5", "GSSAPI", "XOAUTH2"])).toBeNull();
  });
});

describe("parseEhloCapabilities", () => {
  it("reads STARTTLS, 8BITMIME, SIZE and the AUTH mechanisms", () => {
    expect(
      parseEhloCapabilities(["relay.example says hello", "SIZE 20480000", "8BITMIME", "STARTTLS", "AUTH PLAIN LOGIN"]),
    ).toEqual({ startTls: true, eightBitMime: true, maxSize: 20_480_000, authMechanisms: ["PLAIN", "LOGIN"] });
  });

  /**
   * The first line is the server's greeting, not a keyword — a greeting that mentions an
   * extension must not be read as offering it. `AUTH=` is the legacy spelling a generation
   * of servers shipped, and some are still in front of corporate mail.
   */
  it("ignores the greeting line and accepts the legacy AUTH= spelling", () => {
    expect(parseEhloCapabilities(["STARTTLS is not offered here"]).startTls).toBe(false);
    expect(parseEhloCapabilities(["hi", "AUTH=LOGIN PLAIN"]).authMechanisms).toEqual(
      expect.arrayContaining(["LOGIN", "PLAIN"]),
    );
  });

  it("reports nothing for a bare server, and ignores a SIZE it cannot read", () => {
    expect(parseEhloCapabilities(["bare.example"])).toEqual({
      startTls: false,
      eightBitMime: false,
      maxSize: null,
      authMechanisms: [],
    });
    expect(parseEhloCapabilities(["hi", "SIZE", "SIZE lots"]).maxSize).toBeNull();
  });
});

describe("the endpoint URL", () => {
  it("takes one mailbox out of a mailto:, ignoring case and any query string", () => {
    expect(parseMailtoEndpoint("mailto:ops@example.com")).toBe("ops@example.com");
    expect(parseMailtoEndpoint("MAILTO:Ops@Example.com")).toBe("Ops@Example.com");
    expect(parseMailtoEndpoint("mailto:ops@example.com?subject=ignored")).toBe("ops@example.com");
    expect(parseMailtoEndpoint("mailto:ops%40example.com")).toBe("ops@example.com");
  });

  /** One endpoint is one destination, because one delivery has one outcome. */
  it("refuses a list of recipients, and says why", () => {
    expect(() => parseMailtoEndpoint("mailto:a@example.com,b@example.com")).toThrow(InvalidMailEndpointError);
    expect(() => parseMailtoEndpoint("mailto:a@example.com,b@example.com")).toThrow(/one delivery has one outcome/);
  });

  it("refuses a non-mailto URL and anything that would break out of the angle brackets", () => {
    for (const bad of [
      "https://hooks.example.com/abc",
      "smtp://relay.example/ops@example.com",
      "mailto:",
      "mailto:nobody",
      "mailto:a b@example.com",
      "mailto:<a@b.com>",
      "mailto:a@",
    ]) {
      expect(() => parseMailtoEndpoint(bad), bad).toThrow(InvalidMailEndpointError);
    }
    expect(isMailbox("ops@example.com")).toBe(true);
    expect(isMailbox("ops@example.com\r\nRCPT TO:<x@y.com>")).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback and nothing that leaves the machine", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["10.0.0.1", "smtp.example.com", "127.0.0.1.evil.com", "0.0.0.0", "128.0.0.1"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("chooseEncoding", () => {
  /** Raw high bytes to a 7-bit relay is exactly how an Arabic body arrives as mojibake. */
  it("sends UTF-8 as 8bit only where the relay said 8BITMIME, and base64 otherwise", () => {
    expect(chooseEncoding("plain text", { eightBitMime: true })).toBe("7bit");
    expect(chooseEncoding("دفعة منتهية", { eightBitMime: true })).toBe("8bit");
    expect(chooseEncoding("دفعة منتهية", { eightBitMime: false })).toBe("base64");
  });

  /** Wrapping would be an edit to someone's notification text; base64 carries it unchanged. */
  it("falls back to base64 for a line over the 998-octet limit, even in ASCII", () => {
    expect(chooseEncoding("x".repeat(999), { eightBitMime: true })).toBe("base64");
    expect(chooseEncoding(`short\n${"x".repeat(1200)}`, { eightBitMime: true })).toBe("base64");
  });
});

describe("buildMessage", () => {
  const message = (
    overrides: Partial<WebhookPayload> = {},
    encoding: "7bit" | "8bit" | "base64" = "7bit",
  ): string =>
    buildMessage(
      { ...PAYLOAD, ...overrides },
      { from: "crm@crm.example", to: "ops@example.com", nowMs: NOW_MS, encoding },
    );

  it("writes the headers a relay and a mail client need, in CRLF", () => {
    const out = message();
    expect(out).toContain("From: <crm@crm.example>\r\n");
    expect(out).toContain("To: <ops@example.com>\r\n");
    expect(out).toContain("Subject: OVERDUE: expired stock\r\n");
    expect(out).toContain(`Date: ${rfc5322Date(NOW_MS)}\r\n`);
    expect(out).toContain('Content-Type: text/plain; charset="utf-8"\r\n');
    expect(out).toContain("Content-Transfer-Encoding: 7bit\r\n");
    // A bare LF is not a line ending in SMTP.
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  /**
   * The Message-ID is the delivery id, so a relay's logs and a dead letter name the same
   * thing. `Auto-Submitted` stops a vacation autoresponder answering a robot, and stops
   * the loop that follows.
   */
  it("identifies the delivery, and marks itself auto-generated", () => {
    const out = message();
    expect(out).toContain(`Message-ID: <${PAYLOAD.deliveryId}@crm.example>\r\n`);
    expect(out).toContain(`X-CRM-Delivery: ${PAYLOAD.deliveryId}\r\n`);
    expect(out).toContain("X-CRM-Event: disposal_obligation_overdue\r\n");
    expect(out).toContain("Auto-Submitted: auto-generated\r\n");
  });

  it("separates the body with one blank line and carries the facts a human needs", () => {
    const out = message();
    const split = out.indexOf("\r\n\r\n");
    expect(out.slice(split + 4)).toMatch(/^Lot LOT-A was due for disposal/);
    expect(out).toContain("Severity:  urgent");
    expect(out).toContain("Recipient: A. Rep");
    expect(out).toContain("Record:    crm.disposal_obligation 55555555-5555-4555-8555-555555555555");
    // The webhook channel carries `payload` for a machine to parse; a human reading this
    // one already has the lot number in the body.
    expect(out).not.toContain("lotNumber");
    expect(message({ subjectRef: { table: null, id: null } })).not.toContain("Record:");
  });

  it("encodes an Arabic subject and leaves the body as UTF-8 under 8bit", () => {
    const out = message({ subject: "مخزون منتهي الصلاحية", body: "دفعة LOT-A" }, "8bit");
    expect(decodeEncodedWords(/Subject: (.*)\r\n/.exec(out)?.[1] ?? "")).toBe("مخزون منتهي الصلاحية");
    expect(out).toContain("دفعة LOT-A");
  });

  it("base64-wraps the body at 76 columns when that is the encoding", () => {
    const out = message({ body: "x".repeat(400) }, "base64");
    const body = out.slice(out.indexOf("\r\n\r\n") + 4);
    for (const line of body.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(body.split("\r\n").join(""), "base64").toString("utf8")).toContain("x".repeat(400));
  });
});

describe("rfc5322Date", () => {
  /** `toUTCString` emits the obsolete `GMT`; RFC 5322 wants a numeric offset. */
  it("formats in UTC with a numeric offset", () => {
    expect(rfc5322Date(Date.UTC(2027, 0, 15, 9, 4, 5))).toBe("Fri, 15 Jan 2027 09:04:05 +0000");
    expect(rfc5322Date(NOW_MS)).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  });
});

describe("the SmtpSender constructor", () => {
  /**
   * Transport is checked at construction, not at send time: a relay configured without TLS
   * should fail the process at boot rather than start and dead-letter every notification
   * it is handed. The webhook sender's analogous refusal is per-delivery only because its
   * secret is per-endpoint.
   */
  it("refuses plaintext to anywhere but loopback, and defaults to requiring TLS", () => {
    expect(() => new SmtpSender({ relay: { ...RELAY, host: "smtp.example.com" } })).toThrow(InvalidSmtpRelayError);
    expect(() => new SmtpSender({ relay: { ...RELAY, host: "smtp.example.com" } })).toThrow(/only to a loopback relay/);
    // No transport named: starttls, so the same host is fine.
    expect(
      () => new SmtpSender({ relay: { host: "smtp.example.com", port: 587, from: "crm@crm.example" } }),
    ).not.toThrow();
  });

  it("allows plaintext to loopback, which is what makes a local sink testable", () => {
    expect(() => new SmtpSender({ relay: RELAY })).not.toThrow();
    expect(() => new SmtpSender({ relay: { ...RELAY, host: "localhost" } })).not.toThrow();
  });

  it("refuses a From address or a port it could not use", () => {
    expect(() => new SmtpSender({ relay: { ...RELAY, from: "not-an-address" } })).toThrow(InvalidSmtpRelayError);
    expect(() => new SmtpSender({ relay: { ...RELAY, port: 0 } })).toThrow(InvalidSmtpRelayError);
    expect(() => new SmtpSender({ relay: { ...RELAY, port: 70_000 } })).toThrow(InvalidSmtpRelayError);
  });

  it("answers to a channel name the column may spell differently", () => {
    expect(new SmtpSender({ relay: RELAY }).channel).toBe("email");
    expect(new SmtpSender({ relay: RELAY, channel: "smtp" }).channel).toBe("smtp");
  });
});

describe("SmtpSender.send, before it reaches a socket", () => {
  /** Port 9 is discard: if either check below did not come first, the test would hang. */
  const unreachable = { ...RELAY, port: 9 };
  const mailbox = { id: "e1", url: "mailto:ops@example.com", secretEnv: "CRM_SMTP_PASSWORD" };

  it("dead-letters an endpoint URL it cannot use, without connecting", async () => {
    const sender = new SmtpSender({ relay: unreachable });
    const outcome = await sender.send(PAYLOAD, { ...mailbox, url: "https://hooks.example.com/x" });
    expect(outcome.kind).toBe("dead");
    expect(outcome.error).toMatch(/must be a mailto:/);
  });

  /**
   * Same rule as the webhook sender's missing HMAC secret: a configuration fault that will
   * still be a fault in ten minutes, and the alternative — connecting and authenticating
   * with nothing — is worse than not sending.
   */
  it("dead-letters a missing or empty password variable, without connecting", async () => {
    const missing = new SmtpSender({ relay: { ...unreachable, username: "relay-user" }, env: {} });
    const outcome = await missing.send(PAYLOAD, mailbox);
    expect(outcome.kind).toBe("dead");
    expect(outcome.error).toMatch(/CRM_SMTP_PASSWORD is not set/);
    expect(outcome.error).toMatch(/Refusing to connect/);

    const empty = new SmtpSender({
      relay: { ...unreachable, username: "relay-user" },
      env: { CRM_SMTP_PASSWORD: "" },
    });
    expect((await empty.send(PAYLOAD, mailbox)).kind).toBe("dead");
  });

  it("retries a relay that is not listening", async () => {
    const sender = new SmtpSender({ relay: { ...RELAY, port: 1 }, timeoutMs: 2_000 });
    const outcome = await sender.send(PAYLOAD, mailbox);
    expect(outcome.kind).toBe("retry");
    expect(outcome.status).toBeUndefined();
  });
});
