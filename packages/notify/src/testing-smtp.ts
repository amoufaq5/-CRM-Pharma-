/**
 * A minimal SMTP server, so the SMTP sender can be verified rather than asserted.
 *
 * ADR-0001 recorded "no email sender" with unverifiability as the reason: an SMTP client
 * could not be exercised from an environment with no reachable mail server, and the ERP's
 * eighteen declared providers with one implementation show where unverifiable senders end
 * up. That reason was wrong — the server is the part you can write. This sink speaks
 * enough of RFC 5321 to hold a real conversation, records exactly what arrived, and can be
 * told to answer any stage with a chosen reply code, which is what makes the 4xx/5xx
 * classification tests real instead of mocked.
 *
 * It is a test double and nothing else: no queue, no relaying, no spool, and it keeps
 * every message in memory.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { createServer as createTlsServer, TLSSocket } from "node:tls";

/** The points in the conversation a test can make fail, named as the client sees them. */
export const SINK_STAGES = [
  "greeting",
  "ehlo",
  "starttls",
  "auth",
  "mail_from",
  "rcpt_to",
  "data",
  "end_of_data",
] as const;
export type SinkStage = (typeof SINK_STAGES)[number];

export interface SinkFailure {
  readonly stage: SinkStage;
  readonly code: number;
  readonly text?: string;
}

export interface SinkCredentials {
  readonly username: string;
  readonly password: string;
}

export interface SmtpSinkOptions {
  readonly host?: string;
  /** 0 — the default — lets the OS pick, so concurrent runs cannot collide on a port. */
  readonly port?: number;
  readonly serverName?: string;
  readonly advertiseStartTls?: boolean;
  readonly advertise8BitMime?: boolean;
  /** Mechanisms for the EHLO `AUTH` line. An empty array omits the line entirely. */
  readonly advertiseAuth?: readonly string[];
  readonly advertiseSize?: number;
  /** Refuse MAIL FROM with 530 until the client has authenticated. */
  readonly requireAuth?: boolean;
  readonly credentials?: SinkCredentials;
  readonly tls?: { readonly key: string; readonly cert: string };
  /** TLS from the first byte — the port 465 convention — rather than an upgrade. */
  readonly implicitTls?: boolean;
  /**
   * Answer the connection with this line instead of a reply, for the case a port 25 is
   * really an HTTP server or a proxy. The client should call that dead, not retry it.
   */
  readonly rawGreeting?: string;
  readonly failAt?: SinkFailure;
  /** Wait this long before answering a stage — the only way to exercise a read timeout. */
  readonly stallAt?: { readonly stage: SinkStage; readonly ms: number };
}

export interface ReceivedMessage {
  readonly mailFrom: string;
  readonly rcptTo: readonly string[];
  /** The DATA payload exactly as it came off the wire, dot-stuffing included. */
  readonly rawData: string;
  /** The same payload with the transparency dot removed, i.e. what was actually sent. */
  readonly data: string;
  /** Lower-cased header names, continuation lines unfolded. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly overTls: boolean;
  readonly authMechanism: string | null;
  readonly authUser: string | null;
  readonly authPass: string | null;
}

export interface SmtpSink {
  readonly host: string;
  readonly port: number;
  /** Every command line the client sent, in order, across all connections. */
  readonly transcript: readonly string[];
  readonly messages: readonly ReceivedMessage[];
  close(): Promise<void>;
}

export async function startSmtpSink(opts: SmtpSinkOptions = {}): Promise<SmtpSink> {
  const host = opts.host ?? "127.0.0.1";
  const transcript: string[] = [];
  const messages: ReceivedMessage[] = [];
  const sockets = new Set<Socket>();

  const handle = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A sink that throws on a client vanishing mid-conversation would turn every
    // deliberate failure test into an unhandled error.
    socket.on("error", () => undefined);
    void new SinkSession(socket, opts, transcript, messages).run();
  };

  const tls = opts.tls;
  const server: Server =
    opts.implicitTls === true && tls !== undefined
      ? createTlsServer({ key: tls.key, cert: tls.cert }, (socket) => handle(socket))
      : createServer(handle);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  return {
    host,
    port: (server.address() as AddressInfo).port,
    transcript,
    messages,
    close: async (): Promise<void> => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class SinkSession {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private inData = false;
  private data = "";
  private mailFrom: string | null = null;
  private rcptTo: string[] = [];
  private authMechanism: string | null = null;
  private authUser: string | null = null;
  private authPass: string | null = null;
  private loginExpecting: "username" | "password" | null = null;
  private overTls: boolean;

  constructor(
    socket: Socket,
    private readonly opts: SmtpSinkOptions,
    private readonly transcript: string[],
    private readonly messages: ReceivedMessage[],
  ) {
    this.socket = socket;
    this.overTls = socket instanceof TLSSocket;
  }

  async run(): Promise<void> {
    this.attach();
    const raw = this.opts.rawGreeting;
    if (raw !== undefined) {
      this.write(raw);
      return;
    }
    await this.answer("greeting", 220, `${this.serverName()} ESMTP sink`);
  }

  private serverName(): string {
    return this.opts.serverName ?? "sink.test";
  }

  /**
   * Decodes with a StringDecoder rather than `socket.setEncoding`, for two reasons: a
   * UTF-8 body can be split across chunks mid-codepoint, and a socket left in string mode
   * must not be handed to the TLS layer, which needs the raw handle.
   */
  private attach(): void {
    const decoder = new StringDecoder("utf8");
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += decoder.write(chunk);
      void this.pump();
    });
  }

  /**
   * Answers a stage, honouring the `failAt` and `stallAt` overrides.
   *
   * Returns false when the stage was overridden to fail, so a caller can decline to
   * advance its state — a 550 on RCPT TO must not leave the recipient recorded.
   */
  private async answer(stage: SinkStage, code: number, text: string): Promise<boolean> {
    const stall = this.opts.stallAt;
    if (stall !== undefined && stall.stage === stage) {
      await new Promise<void>((resolve) => setTimeout(resolve, stall.ms));
    }
    const fail = this.opts.failAt;
    if (fail !== undefined && fail.stage === stage) {
      this.write(`${fail.code} ${fail.text ?? "refused by the sink"}`);
      return false;
    }
    this.write(`${code} ${text}`);
    return true;
  }

  private write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  private async pump(): Promise<void> {
    for (;;) {
      if (this.inData) {
        if (!this.consumeData()) return;
        continue;
      }
      const nl = this.buffer.indexOf("\r\n");
      if (nl === -1) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 2);
      const upgraded = await this.command(line);
      if (upgraded) return;
    }
  }

  /** Returns true when the socket was replaced by a TLS one, which restarts the loop. */
  private async command(line: string): Promise<boolean> {
    this.transcript.push(line);

    if (this.loginExpecting !== null) {
      const decoded = Buffer.from(line, "base64").toString("utf8");
      if (this.loginExpecting === "username") {
        this.authUser = decoded;
        this.loginExpecting = "password";
        this.write("334 UGFzc3dvcmQ6");
        return false;
      }
      this.authPass = decoded;
      this.loginExpecting = null;
      await this.finishAuth();
      return false;
    }

    const verb = (line.split(/[ :]/, 1)[0] ?? "").toUpperCase();
    switch (verb) {
      case "EHLO":
        await this.ehlo();
        return false;
      case "HELO":
        await this.answer("ehlo", 250, this.serverName());
        return false;
      case "STARTTLS":
        return await this.starttls();
      case "AUTH":
        await this.auth(line);
        return false;
      case "MAIL":
        if (this.opts.requireAuth === true && this.authMechanism === null) {
          this.write("530 5.7.0 Authentication required");
          return false;
        }
        if (await this.answer("mail_from", 250, "2.1.0 Ok")) {
          this.mailFrom = extractPath(line);
        }
        return false;
      case "RCPT":
        if (this.mailFrom === null) {
          this.write("503 5.5.1 MAIL first");
          return false;
        }
        if (await this.answer("rcpt_to", 250, "2.1.5 Ok")) {
          this.rcptTo.push(extractPath(line));
        }
        return false;
      case "DATA":
        if (this.rcptTo.length === 0) {
          this.write("503 5.5.1 RCPT first");
          return false;
        }
        if (await this.answer("data", 354, "End data with <CR><LF>.<CR><LF>")) {
          this.inData = true;
          this.data = "";
        }
        return false;
      case "RSET":
        this.reset();
        this.write("250 2.0.0 Ok");
        return false;
      case "NOOP":
        this.write("250 2.0.0 Ok");
        return false;
      case "QUIT":
        this.write(`221 2.0.0 ${this.serverName()} closing connection`);
        this.socket.end();
        return false;
      default:
        this.write(`500 5.5.2 Unrecognised command: ${verb}`);
        return false;
    }
  }

  private async ehlo(): Promise<void> {
    const stall = this.opts.stallAt;
    if (stall !== undefined && stall.stage === "ehlo") {
      await new Promise<void>((resolve) => setTimeout(resolve, stall.ms));
    }
    const fail = this.opts.failAt;
    if (fail !== undefined && fail.stage === "ehlo") {
      this.write(`${fail.code} ${fail.text ?? "refused by the sink"}`);
      return;
    }

    const lines: string[] = [this.serverName()];
    lines.push(`SIZE ${this.opts.advertiseSize ?? 10_485_760}`);
    if (this.opts.advertise8BitMime !== false) lines.push("8BITMIME");
    // STARTTLS is not offered once the connection already is TLS, which is what a real
    // server does and what the client's second EHLO has to cope with.
    if (this.opts.advertiseStartTls === true && !this.overTls) lines.push("STARTTLS");
    const mechanisms = this.opts.advertiseAuth ?? [];
    if (mechanisms.length > 0) lines.push(`AUTH ${mechanisms.join(" ")}`);
    lines.push("ENHANCEDSTATUSCODES");

    for (const [i, text] of lines.entries()) {
      this.write(`250${i === lines.length - 1 ? " " : "-"}${text}`);
    }
  }

  private async starttls(): Promise<boolean> {
    const tls = this.opts.tls;
    if (tls === undefined) {
      this.write("454 4.7.0 TLS not available");
      return false;
    }
    if (!(await this.answer("starttls", 220, "2.0.0 Ready to start TLS"))) return false;
    if (this.buffer !== "") {
      // The client pipelined past STARTTLS, which would mean plaintext bytes handed to the
      // TLS layer. A real server drops the connection; so does this one.
      this.socket.destroy();
      return true;
    }

    const plain = this.socket;
    plain.removeAllListeners("data");
    const secure = new TLSSocket(plain, { isServer: true, key: tls.key, cert: tls.cert });
    secure.on("error", () => undefined);
    this.socket = secure;
    this.overTls = true;
    // RFC 3207: the TLS handshake discards everything negotiated in the clear, so the
    // client must EHLO again and the session starts from nothing.
    this.reset();
    this.authMechanism = null;
    this.authUser = null;
    this.authPass = null;
    this.attach();
    return true;
  }

  private async auth(line: string): Promise<void> {
    const parts = line.split(" ").filter((p) => p !== "");
    const mechanism = (parts[1] ?? "").toUpperCase();
    if (mechanism === "PLAIN") {
      this.authMechanism = "PLAIN";
      const token = parts[2];
      if (token === undefined) {
        this.write("334 ");
        return;
      }
      // SASL PLAIN is NUL authzid / NUL authcid / NUL passwd, so an empty leading field
      // is normal and the split has three parts of which the first is empty.
      const decoded = Buffer.from(token, "base64").toString("utf8").split("\0");
      this.authUser = decoded[1] ?? null;
      this.authPass = decoded[2] ?? null;
      await this.finishAuth();
      return;
    }
    if (mechanism === "LOGIN") {
      this.authMechanism = "LOGIN";
      this.loginExpecting = "username";
      this.write("334 VXNlcm5hbWU6");
      return;
    }
    this.write(`504 5.5.4 Unrecognised authentication type: ${mechanism}`);
  }

  private async finishAuth(): Promise<void> {
    const expected = this.opts.credentials;
    if (
      expected !== undefined &&
      (this.authUser !== expected.username || this.authPass !== expected.password)
    ) {
      this.authMechanism = null;
      this.write("535 5.7.8 Authentication credentials invalid");
      return;
    }
    await this.answer("auth", 235, "2.7.0 Authentication successful");
  }

  /** Returns false when more bytes are needed to reach the end-of-data terminator. */
  private consumeData(): boolean {
    this.data += this.buffer;
    this.buffer = "";

    // A message whose first line is "." produces a payload that IS the terminator, so the
    // leading case has to be checked separately from the embedded one.
    const terminator = this.data.startsWith(".\r\n") ? 0 : this.data.indexOf("\r\n.\r\n");
    if (terminator === -1) return false;

    const raw = terminator === 0 ? "" : this.data.slice(0, terminator);
    const rest = this.data.slice(terminator === 0 ? 3 : terminator + 5);
    this.inData = false;
    this.data = "";
    this.buffer = rest;

    const unstuffed = raw
      .split("\r\n")
      .map((l) => (l.startsWith(".") ? l.slice(1) : l))
      .join("\r\n");
    const split = unstuffed.indexOf("\r\n\r\n");
    this.messages.push({
      mailFrom: this.mailFrom ?? "",
      rcptTo: [...this.rcptTo],
      rawData: raw,
      data: unstuffed,
      headers: parseHeaders(split === -1 ? unstuffed : unstuffed.slice(0, split)),
      body: split === -1 ? "" : unstuffed.slice(split + 4),
      overTls: this.overTls,
      authMechanism: this.authMechanism,
      authUser: this.authUser,
      authPass: this.authPass,
    });

    const fail = this.opts.failAt;
    if (fail !== undefined && fail.stage === "end_of_data") {
      this.write(`${fail.code} ${fail.text ?? "refused by the sink"}`);
    } else {
      this.write("250 2.0.0 Ok: queued as sink-1");
    }
    this.reset();
    return true;
  }

  private reset(): void {
    this.mailFrom = null;
    this.rcptTo = [];
    this.inData = false;
    this.data = "";
  }
}

function extractPath(line: string): string {
  const angled = /<([^>]*)>/.exec(line);
  if (angled !== null) return angled[1] ?? "";
  const colon = line.indexOf(":");
  return colon === -1 ? "" : (line.slice(colon + 1).trim().split(" ")[0] ?? "");
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let current: string | null = null;
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && current !== null) {
      // Unfolding joins on the fold point without the CRLF; RFC 2047 then discards the
      // whitespace between two adjacent encoded words, which is why a folded subject can
      // be decoded at all.
      headers[current] = `${headers[current] ?? ""}${line.replace(/^[ \t]+/, " ")}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    current = line.slice(0, colon).toLowerCase();
    headers[current] = line.slice(colon + 1).trimStart();
  }
  return headers;
}

/**
 * Decodes RFC 2047 encoded words — the receiving half of the subject encoder.
 *
 * Here for the same reason `verifyWebhook` sits next to the signer: a test that decoded
 * with the encoder's own helpers would pass whatever the encoder did. This is an
 * independent reader, so agreement between the two means something.
 */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)[ \t\r\n]+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, kind: string, text: string) => {
      const bytes =
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_q, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
              "binary",
            );
      return bytes.toString(charset.toLowerCase() === "utf-8" ? "utf8" : "latin1");
    });
}

/**
 * A throwaway self-signed certificate for the STARTTLS tests, via the openssl binary.
 *
 * `node:crypto` can make a key pair but cannot issue an X.509 certificate, and the brief
 * forbids a new dependency, so this shells out. It returns null where openssl is absent
 * rather than failing the suite: the TLS-upgrade tests then skip and say so, which is
 * honest, where a hard failure would make an unrelated environment look broken.
 *
 * The SAN carries IP:127.0.0.1 so the client can verify the certificate properly with
 * `ca`, instead of the test turning verification off and proving nothing.
 */
export function selfSignedCert(): { key: string; cert: string } | null {
  let dir: string | null = null;
  try {
    // Two files, not /dev/stdout twice: openssl opens the output path for each of the key
    // and the certificate, and the second open of a pipe fails outright.
    dir = mkdtempSync(join(tmpdir(), "crm-smtp-sink-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout", keyPath, "-out", certPath,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch {
    return null;
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}
