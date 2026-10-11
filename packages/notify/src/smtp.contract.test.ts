import { afterEach, describe, expect, it } from "vitest";

import { SmtpSender, type SmtpRelayConfig, type SmtpTransport } from "./smtp.js";
import {
  decodeEncodedWords,
  selfSignedCert,
  startSmtpSink,
  type SmtpSink,
  type SmtpSinkOptions,
} from "./testing-smtp.js";
import type { EndpointConfig, SendOutcome, WebhookPayload } from "./sender.js";

/**
 * The SMTP channel against a real SMTP server.
 *
 * ADR-0001 recorded "no email sender" and gave unverifiability as the reason. That is the
 * claim this file retires: the sink in `testing-smtp.ts` is a real server on loopback, so
 * every assertion below — the reply-code classification above all, which is the part a
 * mock would have let through wrong — is checked against bytes that crossed a socket.
 *
 * No Postgres. The dispatcher's half is covered by notify.contract.test.ts; this is the
 * `ChannelSender` on its own, which is the seam the dispatcher calls through.
 */

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

const MAILBOX: EndpointConfig = {
  id: "e1",
  url: "mailto:ops@example.com",
  secretEnv: "CRM_SMTP_PASSWORD",
};

const CERT = selfSignedCert();
/** Spread rather than passed: under `exactOptionalPropertyTypes` an absent option is not
 * the same as one set to undefined, and the sink declares `tls` as required-if-present. */
const TLS = CERT === null ? {} : { tls: CERT };

describe("the SMTP channel, against a real server", () => {
  let sink: SmtpSink | null = null;

  afterEach(async () => {
    await sink?.close();
    sink = null;
  });

  /**
   * Stands the sink up on an OS-assigned port — not a fixed one — so a concurrent run of
   * this suite cannot collide with it.
   */
  const open = async (opts: SmtpSinkOptions = {}): Promise<SmtpSink> => {
    sink = await startSmtpSink(opts);
    return sink;
  };

  const sendTo = async (
    live: SmtpSink,
    overrides: {
      readonly payload?: Partial<WebhookPayload>;
      readonly relay?: Partial<SmtpRelayConfig>;
      readonly transport?: SmtpTransport;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly timeoutMs?: number;
      readonly endpoint?: Partial<EndpointConfig>;
    } = {},
  ): Promise<SendOutcome> => {
    const sender = new SmtpSender({
      relay: {
        host: "127.0.0.1",
        port: live.port,
        from: "crm@crm.example",
        transport: overrides.transport ?? "plaintext",
        ...overrides.relay,
      },
      env: overrides.env ?? {},
      timeoutMs: overrides.timeoutMs ?? 5_000,
      now: () => Date.UTC(2027, 0, 15, 9, 0, 0),
      // The sink's certificate is self-signed, so it is trusted as a CA rather than by
      // switching verification off: a test that disabled it would prove nothing about the
      // handshake the sender actually performs.
      ...(CERT === null ? {} : { tlsOptions: { ca: [CERT.cert] } }),
    });
    return await sender.send({ ...PAYLOAD, ...overrides.payload }, { ...MAILBOX, ...overrides.endpoint });
  };

  describe("the happy path", () => {
    it("holds a whole conversation and the relay ends up with the message", async () => {
      const live = await open();
      expect(await sendTo(live)).toEqual({ kind: "delivered", status: 250 });

      expect(live.messages).toHaveLength(1);
      const message = live.messages[0]!;
      expect(message.mailFrom).toBe("crm@crm.example");
      expect(message.rcptTo).toEqual(["ops@example.com"]);
      expect(message.headers.subject).toBe("OVERDUE: expired stock");
      expect(message.headers.to).toBe("<ops@example.com>");
      expect(message.headers["x-crm-delivery"]).toBe(PAYLOAD.deliveryId);
      expect(message.body).toContain("Lot LOT-A was due for disposal");
      // EHLO carries the sending domain, which is what the argument is for.
      expect(live.transcript).toContain("EHLO crm.example");
      expect(live.transcript.at(-1)).toBe("QUIT");
    });

    it("attempts no AUTH at all when no username is configured, however much is offered", async () => {
      const live = await open({ advertiseAuth: ["PLAIN", "LOGIN"] });
      expect((await sendTo(live)).kind).toBe("delivered");
      expect(live.transcript.filter((l) => l.startsWith("AUTH"))).toEqual([]);
      // And the secret variable was never read: it is not set in `env` above.
      expect(live.messages[0]!.authMechanism).toBeNull();
    });

    it("sends the message a second time as a retried delivery would, without state carrying over", async () => {
      const live = await open();
      expect((await sendTo(live)).kind).toBe("delivered");
      expect((await sendTo(live)).kind).toBe("delivered");
      expect(live.messages).toHaveLength(2);
      expect(live.messages[1]!.rcptTo).toEqual(["ops@example.com"]);
    });
  });

  /**
   * The `email_recipient` channel (0065), against the same relay and the same class.
   *
   * WHAT IS NEW IS ONLY WHERE THE DESTINATION COMES FROM. Until 0065 it came from the
   * endpoint's own `mailto:` url, frozen by 0049 — so every rep in a tenant was mailed at one
   * address and 0064's `urgent` escalation, whose whole case is reaching somebody who has not
   * opened the app in a week, reached a shared ops mailbox instead of them. Now a delivery on
   * that channel carries the mailbox it was addressed to, resolved when the row was written.
   *
   * ONE CLASS AND TWO CHANNELS, which these tests are the argument for: the conversation, the
   * encoding choice, the AUTH ladder and every refusal are identical, so a second sender class
   * would be a copy of 983 lines differing in one field.
   */
  describe("addressing the recipient rather than the endpoint", () => {
    /** The endpoint row an `email_recipient` delivery actually carries: a marker, not a url. */
    const PER_RECIPIENT: Partial<EndpointConfig> = { url: "mailto:*" };

    it("sends to the delivery's own mailbox, and the relay sees it in RCPT TO", async () => {
      const live = await open();
      expect(
        await sendTo(live, { endpoint: { ...PER_RECIPIENT, toAddress: "grace@example.com" } }),
      ).toEqual({ kind: "delivered", status: 250 });
      // The bytes that crossed the socket, which is the only evidence worth having here: a
      // recorded call would have reported the same object whichever field the sender read.
      expect(live.messages[0]!.rcptTo).toEqual(["grace@example.com"]);
      expect(live.messages[0]!.headers.to).toBe("<grace@example.com>");
    });

    it("sends two deliveries to two mailboxes through one endpoint row", async () => {
      const live = await open();
      for (const to of ["grace@example.com", "omar@example.com"]) {
        expect((await sendTo(live, { endpoint: { ...PER_RECIPIENT, toAddress: to } })).kind).toBe(
          "delivered",
        );
      }
      // The whole point of the channel, as the relay saw it.
      expect(live.messages.map((m) => m.rcptTo)).toEqual([["grace@example.com"], ["omar@example.com"]]);
    });

    it("prefers the delivery's address over an endpoint that has a real mailbox too", async () => {
      const live = await open();
      // Not a configuration this system writes — 0065's CHECK pairs the address with the
      // channel — but the precedence has to be unambiguous in the code rather than in the
      // caller: the address on the row is the one the record says was used.
      expect(
        (await sendTo(live, { endpoint: { url: "mailto:ops@example.com", toAddress: "grace@example.com" } }))
          .kind,
      ).toBe("delivered");
      expect(live.messages[0]!.rcptTo).toEqual(["grace@example.com"]);
    });

    it("dead-letters the marker when there is no address, without opening a socket", async () => {
      const live = await open();
      const outcome = await sendTo(live, { endpoint: PER_RECIPIENT });
      // Reachable only through a bug — 0065's CHECK refuses a row on this channel with no
      // address — so the sentence is written for whoever is reading the log, and it says what
      // the marker IS rather than that `"*"` is not a mailbox, which is true and useless.
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toContain("the destination comes from whoever the notification names");
      expect(live.transcript).toEqual([]);
    });

    it("dead-letters an address the column admitted and this process cannot address", async () => {
      const live = await open();
      // 0065's CHECK is broader than `isMailbox`: it wants an @ and a dotted domain and says
      // nothing about angle brackets. Refusing here rather than handing it to the relay means
      // the verdict says what is wrong with the address instead of quoting somebody else's
      // parser back at an administrator.
      const outcome = await sendTo(live, {
        endpoint: { ...PER_RECIPIENT, toAddress: "<grace@example.com>" },
      });
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toContain("not a mailbox this process can address");
      expect(live.transcript).toEqual([]);
    });

    it("authenticates to the same relay with the same credential", async () => {
      // The channel is the destination and nothing else: one relay, one password, one
      // `secret_env`. A deployment does not configure a second mail server to mail a person.
      const live = await open({ advertiseAuth: ["PLAIN"], requireAuth: true });
      expect(
        (
          await sendTo(live, {
            relay: { username: "crm@crm.example" },
            env: { CRM_SMTP_PASSWORD: "hunter2" },
            endpoint: { ...PER_RECIPIENT, toAddress: "grace@example.com" },
          })
        ).kind,
      ).toBe("delivered");
      expect(live.messages[0]!.authMechanism).toBe("PLAIN");
      expect(live.messages[0]!.rcptTo).toEqual(["grace@example.com"]);
    });

    it("answers to the channel name it was constructed with", () => {
      // How the dispatcher finds it: `NotificationDispatcher` keys its senders by `channel`,
      // so the scheduler registers two instances of this class over one relay config.
      const relay: SmtpRelayConfig = {
        host: "127.0.0.1",
        port: 25,
        from: "crm@crm.example",
        transport: "plaintext",
      };
      expect(new SmtpSender({ relay }).channel).toBe("email");
      expect(new SmtpSender({ relay, channel: "email_recipient" }).channel).toBe("email_recipient");
    });
  });

  describe("AUTH", () => {
    it("authenticates with PLAIN, sending the credentials the relay expects", async () => {
      const live = await open({
        advertiseAuth: ["PLAIN", "LOGIN"],
        credentials: { username: "relay-user", password: "pa55" },
        requireAuth: true,
      });
      const outcome = await sendTo(live, {
        relay: { username: "relay-user" },
        env: { CRM_SMTP_PASSWORD: "pa55" },
      });
      expect(outcome.kind).toBe("delivered");
      const message = live.messages[0]!;
      expect(message.authMechanism).toBe("PLAIN");
      expect(message.authUser).toBe("relay-user");
      expect(message.authPass).toBe("pa55");
      // One round trip: the token rides on the command rather than a 334 challenge.
      expect(live.transcript.filter((l) => l.startsWith("AUTH"))).toHaveLength(1);
    });

    it("falls back to LOGIN's two challenges where that is all the relay offers", async () => {
      const live = await open({
        advertiseAuth: ["LOGIN"],
        credentials: { username: "relay-user", password: "pa55" },
        requireAuth: true,
      });
      const outcome = await sendTo(live, {
        relay: { username: "relay-user" },
        env: { CRM_SMTP_PASSWORD: "pa55" },
      });
      expect(outcome.kind).toBe("delivered");
      expect(live.messages[0]!.authMechanism).toBe("LOGIN");
      expect(live.messages[0]!.authUser).toBe("relay-user");
      expect(live.transcript).toContain("AUTH LOGIN");
      expect(live.transcript).toContain(Buffer.from("relay-user", "utf8").toString("base64"));
    });

    /** 535 is permanent: a wrong password is wrong on the next attempt too. */
    it("dead-letters a rejected credential", async () => {
      const live = await open({
        advertiseAuth: ["PLAIN"],
        credentials: { username: "relay-user", password: "pa55" },
        requireAuth: true,
      });
      const outcome = await sendTo(live, {
        relay: { username: "relay-user" },
        env: { CRM_SMTP_PASSWORD: "wrong" },
      });
      expect(outcome.kind).toBe("dead");
      expect(outcome.status).toBe(535);
      expect(live.messages).toHaveLength(0);
    });

    /**
     * Fail closed. A relay offering no mechanism this client speaks, while a username is
     * configured, almost always means the configuration is pointed at the wrong port — and
     * sending unauthenticated would either be refused or, worse, relayed anonymously.
     */
    it("refuses to send unauthenticated when credentials are configured and nothing is offered", async () => {
      const live = await open({ advertiseAuth: [] });
      const outcome = await sendTo(live, {
        relay: { username: "relay-user" },
        env: { CRM_SMTP_PASSWORD: "pa55" },
      });
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/offers no AUTH mechanism/);
      expect(outcome.error).toMatch(/Refusing to send unauthenticated/);
      expect(live.messages).toHaveLength(0);
    });

    it("dead-letters a mechanism it cannot speak rather than guessing", async () => {
      const live = await open({ advertiseAuth: ["CRAM-MD5", "XOAUTH2"] });
      const outcome = await sendTo(live, {
        relay: { username: "relay-user" },
        env: { CRM_SMTP_PASSWORD: "pa55" },
      });
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/CRAM-MD5, XOAUTH2/);
    });
  });

  /**
   * The classification, against a server that really answers these codes.
   *
   * SMTP draws the line the opposite way round from the intuition that a 4xx is the
   * client's fault: 4xx is transient and must be retried, 5xx is permanent and must
   * dead-letter. Backwards, this either retries a bounced address to the attempt ceiling
   * or throws away a greylisted message — and greylisting is the most common 4xx a real
   * relay shows you.
   */
  describe("reply classification", () => {
    const transient: readonly (readonly [string, number])[] = [
      ["greeting", 421],
      ["ehlo", 421],
      ["mail_from", 450],
      ["rcpt_to", 450],
      ["data", 451],
      ["end_of_data", 452],
    ];

    it.each(transient)("retries a %s answered with %i", async (stage, code) => {
      const live = await open({ failAt: { stage: stage as "greeting", code, text: "4.3.2 try later" } });
      const outcome = await sendTo(live);
      expect(outcome.kind).toBe("retry");
      expect(outcome.status).toBe(code);
      expect(outcome.error).toMatch(new RegExp(`at ${stage}`));
    });

    const permanent: readonly (readonly [string, number])[] = [
      ["ehlo", 502],
      ["mail_from", 550],
      ["rcpt_to", 550],
      ["data", 554],
      ["end_of_data", 552],
    ];

    it.each(permanent)("dead-letters a %s answered with %i", async (stage, code) => {
      const live = await open({ failAt: { stage: stage as "ehlo", code, text: "5.7.1 no" } });
      const outcome = await sendTo(live);
      expect(outcome.kind).toBe("dead");
      expect(outcome.status).toBe(code);
      expect(outcome.error).toMatch(/permanent, so this is dead-lettered/);
    });

    /**
     * A 452 after the dot is the one that matters most: the message was fully transmitted
     * and refused for want of queue space. Retrying it is correct, and the sink proves the
     * message really did arrive before the refusal — so a retry is a genuine duplicate
     * risk, which is why delivery is documented as at-least-once.
     */
    it("retries a message refused after the dot, having already transmitted it", async () => {
      const live = await open({ failAt: { stage: "end_of_data", code: 452, text: "4.2.2 mailbox full" } });
      expect((await sendTo(live)).kind).toBe("retry");
      expect(live.messages).toHaveLength(1);
      expect(live.messages[0]!.body).toContain("Lot LOT-A");
    });

    /** A positive code where another was required: the conversation has lost step. */
    it("dead-letters a relay that answers DATA with 250", async () => {
      const live = await open({ failAt: { stage: "data", code: 250, text: "fine" } });
      const outcome = await sendTo(live);
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/where 354 was required/);
    });

    /** Port 25 is sometimes an HTTP server or a captive proxy. That is not retryable. */
    it("dead-letters a server that is not speaking SMTP at all", async () => {
      const live = await open({ rawGreeting: "HTTP/1.1 400 Bad Request" });
      const outcome = await sendTo(live);
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/is not an SMTP reply line/);
      expect(outcome.error).toMatch(/not speaking SMTP/);
    });

    /** A hung relay must not hold a dispatcher worker; a timeout reads as "not now". */
    it("retries a relay that never answers, rather than waiting on it", async () => {
      const live = await open({ stallAt: { stage: "greeting", ms: 5_000 } });
      const started = Date.now();
      const outcome = await sendTo(live, { timeoutMs: 150 });
      expect(outcome.kind).toBe("retry");
      expect(outcome.error).toMatch(/no greeting reply from the relay within 150ms/);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("dead-letters a 552 that names a message too large for the relay to have accepted", async () => {
      const live = await open({ advertiseSize: 512 });
      const outcome = await sendTo(live);
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/accepts at most 512/);
      // Refused before MAIL FROM: the relay already said it would not take it.
      expect(live.transcript.some((l) => l.startsWith("MAIL"))).toBe(false);
    });
  });

  describe("the DATA payload", () => {
    /**
     * The failure this guards is silent: without the transparency dot the message ends at
     * the lone `.` line and the rest is lost, with a 250 to say it went fine.
     */
    it("dot-stuffs a body whose line is a lone dot, and the relay reads back exactly what was sent", async () => {
      const live = await open();
      const body = ["first line", ".", "after the dot", "..", "last line"].join("\n");
      expect((await sendTo(live, { payload: { body } })).kind).toBe("delivered");

      const message = live.messages[0]!;
      // On the wire the dots are doubled, so the end-of-data terminator never appeared early.
      expect(message.rawData).toContain("\r\n..\r\nafter the dot\r\n...\r\n");
      // And after un-stuffing the relay holds the original, nothing truncated.
      expect(message.body).toContain("first line\r\n.\r\nafter the dot\r\n..\r\nlast line");
      expect(message.body).toContain("Delivery:  11111111-1111-4111-8111-111111111111");
    });

    it("sends an Arabic subject as an encoded word and the body as 8bit where 8BITMIME was offered", async () => {
      const live = await open({ advertise8BitMime: true });
      const outcome = await sendTo(live, {
        payload: { subject: "عاجل: مخزون منتهي الصلاحية", body: "دفعة LOT-A لدى المندوب أحمد" },
      });
      expect(outcome.kind).toBe("delivered");

      const message = live.messages[0]!;
      expect(message.headers.subject).toMatch(/^=\?UTF-8\?B\?/);
      expect(decodeEncodedWords(message.headers.subject ?? "")).toBe("عاجل: مخزون منتهي الصلاحية");
      expect(message.headers["content-transfer-encoding"]).toBe("8bit");
      expect(message.body).toContain("دفعة LOT-A لدى المندوب أحمد");
      // The relay is told the body really is 8-bit, or a conforming one may downgrade it.
      expect(live.transcript).toContain("MAIL FROM:<crm@crm.example> BODY=8BITMIME");
    });

    /** Raw high bytes to a 7-bit relay is exactly how an Arabic body arrives as mojibake. */
    it("base64-encodes the same body for a relay that does not offer 8BITMIME", async () => {
      const live = await open({ advertise8BitMime: false });
      const outcome = await sendTo(live, { payload: { body: "دفعة LOT-A لدى المندوب أحمد" } });
      expect(outcome.kind).toBe("delivered");

      const message = live.messages[0]!;
      expect(message.headers["content-transfer-encoding"]).toBe("base64");
      expect(Buffer.from(message.body.split("\r\n").join(""), "base64").toString("utf8")).toContain(
        "دفعة LOT-A لدى المندوب أحمد",
      );
      expect(live.transcript).toContain("MAIL FROM:<crm@crm.example>");
    });

    /**
     * The recipient's own NAME, over a real socket.
     *
     * The notification text here is pure ASCII; only the footer's `Recipient:` line is
     * not. `chooseEncoding` was asked about `payload.body`, so it answered `7bit`, and the
     * message went out declaring `7bit` while carrying raw 8-bit octets — an RFC violation
     * and precisely the mojibake the function exists to prevent. Asserted against bytes
     * that crossed a socket, because the two assertions that matter are what the HEADER
     * says and what the relay actually received.
     */
    it("picks the encoding from the composed body, so an Arabic rep NAME is carried intact", async () => {
      const live = await open({ advertise8BitMime: true });
      const outcome = await sendTo(live, {
        payload: {
          subject: "OVERDUE: expired stock",
          body: "Lot LOT-A was due for disposal",
          recipient: { repProfileId: PAYLOAD.recipient.repProfileId, displayName: "أحمد الموفق" },
        },
      });
      expect(outcome.kind).toBe("delivered");

      const message = live.messages[0]!;
      expect(message.headers["content-transfer-encoding"]).toBe("8bit");
      expect(message.body).toContain("Recipient: أحمد الموفق");
      expect(live.transcript).toContain("MAIL FROM:<crm@crm.example> BODY=8BITMIME");
    });

    it("base64s the same name for a 7-bit relay, rather than declaring 7bit and lying", async () => {
      const live = await open({ advertise8BitMime: false });
      const outcome = await sendTo(live, {
        payload: {
          body: "Lot LOT-A was due for disposal",
          recipient: { repProfileId: PAYLOAD.recipient.repProfileId, displayName: "أحمد الموفق" },
        },
      });
      expect(outcome.kind).toBe("delivered");
      const message = live.messages[0]!;
      expect(message.headers["content-transfer-encoding"]).toBe("base64");
      expect(Buffer.from(message.body.split("\r\n").join(""), "base64").toString("utf8")).toContain(
        "Recipient: أحمد الموفق",
      );
    });

    it("keeps a subject that contains a CRLF from becoming a header of its own", async () => {
      const live = await open();
      const outcome = await sendTo(live, {
        payload: { subject: "fine\r\nBcc: attacker@example.com" },
      });
      expect(outcome.kind).toBe("delivered");
      const message = live.messages[0]!;
      expect(message.headers.bcc).toBeUndefined();
      expect(message.headers.subject).toBe("fine Bcc: attacker@example.com");
      expect(message.rcptTo).toEqual(["ops@example.com"]);
    });
  });

  describe("TLS", () => {
    /**
     * A notification carries a rep's name, an account id and sometimes a lot number, which
     * is the same reason the webhook URL constraint is HTTPS-only. A relay with no
     * STARTTLS is a refusal, not a downgrade.
     */
    it("refuses to send where STARTTLS was required and not offered", async () => {
      const live = await open({ advertiseStartTls: false });
      const outcome = await sendTo(live, { transport: "starttls" });
      expect(outcome.kind).toBe("dead");
      expect(outcome.error).toMatch(/does not offer STARTTLS/);
      expect(outcome.error).toMatch(/clear text. Refusing to send/);
      expect(live.messages).toHaveLength(0);
    });

    const describeTls = CERT === null ? describe.skip : describe;
    describeTls("against a certificate", () => {
      it("upgrades with STARTTLS, re-greets, and delivers over the encrypted socket", async () => {
        const live = await open({
          advertiseStartTls: true,
          ...TLS,
          advertiseAuth: ["PLAIN"],
          credentials: { username: "relay-user", password: "pa55" },
          requireAuth: true,
        });
        const outcome = await sendTo(live, {
          transport: "starttls",
          relay: { username: "relay-user" },
          env: { CRM_SMTP_PASSWORD: "pa55" },
        });
        expect(outcome).toEqual({ kind: "delivered", status: 250 });

        const message = live.messages[0]!;
        expect(message.overTls).toBe(true);
        // RFC 3207: the handshake discards what was learned in the clear, so the client
        // has to EHLO again — and the credentials only ever crossed the encrypted socket.
        expect(live.transcript.filter((l) => l === "EHLO crm.example")).toHaveLength(2);
        expect(live.transcript.indexOf("STARTTLS")).toBeGreaterThan(0);
        expect(live.transcript.findIndex((l) => l.startsWith("AUTH PLAIN"))).toBeGreaterThan(
          live.transcript.indexOf("STARTTLS"),
        );
      });

      it("talks to an implicit-TLS relay, the port 465 convention, with no upgrade step", async () => {
        const live = await open({ implicitTls: true, ...TLS });
        const outcome = await sendTo(live, { transport: "implicit_tls" });
        expect(outcome.kind).toBe("delivered");
        expect(live.messages[0]!.overTls).toBe(true);
        expect(live.transcript).not.toContain("STARTTLS");
      });

      /** A relay whose certificate does not verify is not a relay to send a notification to. */
      it("retries rather than sending when the certificate does not verify", async () => {
        const live = await open({ advertiseStartTls: true, ...TLS });
        const sender = new SmtpSender({
          relay: { host: "127.0.0.1", port: live.port, from: "crm@crm.example", transport: "starttls" },
          env: {},
          timeoutMs: 5_000,
          // No `ca`, so the self-signed certificate is untrusted — the same shape as a
          // relay presenting a certificate for someone else.
        });
        const outcome = await sender.send(PAYLOAD, MAILBOX);
        expect(outcome.kind).toBe("retry");
        expect(outcome.error).toMatch(/certificate/i);
        expect(live.messages).toHaveLength(0);
      });
    });

    /**
     * The socket is destroyed when the connect times out.
     *
     * `open()` created the socket, raced a timer against `connect`, and on a timeout
     * rejected without closing it: the socket was a local that was never returned, so
     * `conversation` stayed null and `send`'s `finally { conversation?.destroy() }`
     * destroyed nothing. The handle kept the event loop alive — a process could not exit —
     * and in a scheduler that retries a down relay every tick it leaked one descriptor per
     * attempt, each able to complete its connect later and sit against the relay with no
     * reader and no QUIT.
     *
     * Asserted on `process._getActiveHandles()` because the leak is not observable from the
     * outcome: a leaking `open()` and a clean one return the same `retry`.
     */
    describe("a connect that never completes", () => {
      /**
       * Sockets the event loop is still holding open.
       *
       * `destroyed` and not presence: a destroyed socket stays in `_getActiveHandles()`
       * until its close is processed, and it does NOT keep the loop alive — verified by
       * running the same five attempts in a plain node process, which exits 0 with the fix
       * and hangs without it. So the question "was it torn down" is `destroyed`, and the
       * question "does it leak" is whether this count GROWS.
       */
      const liveSockets = (): number =>
        (
          process as unknown as {
            _getActiveHandles: () => readonly { constructor: { name: string }; destroyed?: boolean }[];
          }
        )
          ._getActiveHandles()
          .filter((h) => /Socket$/.test(h.constructor.name) && h.destroyed !== true).length;

      /**
       * 10.255.255.1 is routable-looking and unreachable, so the connect HANGS rather than
       * being refused. That distinction is the test: a refused connect closes its own
       * socket and would prove nothing.
       */
      const unreachable = (timeoutMs: number): SmtpSender =>
        new SmtpSender({
          relay: { host: "10.255.255.1", port: 25, from: "crm@crm.example", transport: "starttls" },
          env: {},
          timeoutMs,
        });

      it("retries AND tears the socket down", async () => {
        const before = liveSockets();
        const outcome = await unreachable(300).send(PAYLOAD, MAILBOX);
        expect(outcome.kind).toBe("retry");
        expect(outcome.error).toMatch(/could not connect to 10\.255\.255\.1:25 within 300ms/);
        expect(liveSockets()).toBe(before);
      });

      it("does not leak one per attempt, which is what a scheduler would do", async () => {
        // The measured shape of the bug: a relay down for an hour with a per-minute tick
        // leaked a descriptor a minute, each still able to complete its connect later and
        // sit against the relay with no reader and no QUIT. Before the fix this counted
        // 1, 2, 3, 4, 5.
        const sender = unreachable(200);
        const before = liveSockets();
        for (let i = 0; i < 5; i += 1) {
          expect((await sender.send(PAYLOAD, MAILBOX)).kind, `attempt ${String(i + 1)}`).toBe("retry");
          expect(liveSockets(), `attempt ${String(i + 1)}`).toBe(before);
        }
      });
    });
  });
});
