/**
 * The endpoint probe: "does this endpoint actually work?", asked by an administrator and
 * answered by the process that can prove it.
 *
 * WHY THE API CANNOT ANSWER IT. An endpoint names an environment VARIABLE, never a secret
 * (0021). The sender that reads that variable runs in the SCHEDULER, which has a different
 * environment, a relay host and an AUTH username the API has never heard of — so an API
 * that checked `process.env` would answer confidently about the wrong process, which is
 * worse than answering nothing. So the scheduler performs the probe and records the
 * verdict; the API reads the row. 0034 is the handover.
 *
 * WHAT A PROBE SENDS, AND WHY THE TWO CHANNELS EARN DIFFERENT WORDS.
 *
 * The honest test of a destination is to reach it, and the dishonest one is to check
 * something cheap and report success. But a probe is also traffic a human did not ask for,
 * so the two channels stop at different points and say which point they stopped at:
 *
 *   * WEBHOOK — a real signed POST to the real URL, carrying a probe envelope that says in
 *     its own body what it is and `x-crm-event: endpoint_probe`, which is deliberately not
 *     a `NotificationKind`, so a receiver switching on the event falls to its default
 *     branch instead of mistaking a probe for a signal. A 2xx has proven the variable holds
 *     a secret, the HMAC verifies, the network path is open and the receiver accepts us.
 *     That is `delivered`, and it is the strongest verdict in the table.
 *
 *   * EMAIL — the full conversation up to and including `RCPT TO`, then `RSET`. That proves
 *     every piece of configuration a send depends on: the relay answers, STARTTLS comes up
 *     and verifies, AUTH succeeds with the password the endpoint's variable names, the
 *     envelope sender is accepted and so is the mailbox. Then it is thrown away, so no
 *     message exists. That is `reachable` — NOT `delivered`, because nothing was delivered,
 *     and a probe that reported success without proving delivery is the one outcome that
 *     would make this feature a liability. The alternative — a real probe email — puts a
 *     message in front of a person who did not ask for one every time an administrator
 *     checks a setting, and buys only the `DATA` phase.
 *
 * WHY THE SMTP CONVERSATION IS HERE AND NOT CALLED INTO. `SmtpSender.converse` is private
 * and unconditionally proceeds from AUTH to `MAIL FROM`, `DATA` and a message: there is no
 * reachable path through it that stops early, so the DATA-less conversation this needs does
 * not exist to be called. Every DECISION is still shared — `classifySmtpReply`,
 * `parseEhloCapabilities`, `chooseAuthMechanism`, `authPlainToken`, `parseMailtoEndpoint`,
 * `isMailbox`, `isLoopbackHost` are all imported from `smtp.ts`, so the two cannot disagree
 * about what a reply code means or which mechanism to pick. What is local is the socket and
 * the reply reader. Exposing the conversation from `smtp.ts` would collapse that, and is
 * named as the follow-up.
 *
 * FAIL CLOSED, EVERYWHERE. A probe that could not be completed is `unknown`: a timeout, a
 * refused connection, a 503 or a 429 from a webhook, a 4xx from a relay, a channel this
 * process has no prober for. None of those are evidence that an endpoint works, and the
 * verdict says so rather than implying otherwise by omission.
 */
import { Buffer } from "node:buffer";
import { connect as netConnect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  classifyStatus,
  signWebhook,
  type FetchLike,
  type SendOutcome,
} from "./sender.js";
import {
  InvalidSmtpRelayError,
  SmtpProtocolError,
  SmtpTimeoutError,
  authPlainToken,
  chooseAuthMechanism,
  classifySmtpReply,
  isLoopbackHost,
  isMailbox,
  parseEhloCapabilities,
  parseMailtoEndpoint,
  type SmtpRelayConfig,
  type SmtpStage,
  type SmtpTransport,
} from "./smtp.js";

/**
 * The four verdicts, weakest-proof last. Mirrors 0034's CHECK; `probe.contract.test.ts`
 * compares the two against `pg_constraint` so the copy cannot drift.
 */
export const PROBE_VERDICTS = ["delivered", "reachable", "refused", "unknown"] as const;
export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

export const PROBE_STATES = ["requested", "in_flight", "complete"] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

/**
 * The event name on the wire. Deliberately NOT a `NotificationKind` — a receiver that
 * switches on `x-crm-event` must not have a branch for this, and adding it to the kind
 * vocabulary would also let an endpoint be filtered to a "kind" nothing ever raises.
 */
export const PROBE_EVENT = "endpoint_probe";

export const DEFAULT_PROBE_COOLDOWN_SECONDS = 120;
export const MAX_PROBE_COOLDOWN_SECONDS = 86_400;

/**
 * Claims before a probe is abandoned as `unknown`.
 *
 * Not a retry ceiling: a probe is never re-sent after an answer, however bad the answer
 * was. This bounds the other case — a scheduler that claimed a probe and died before
 * settling it, which leaves the row `in_flight` with a lease nobody holds.
 */
export const MAX_PROBE_ATTEMPTS = 3;

/** How long a claim is honoured before another pass may take it over. */
export const PROBE_LEASE_MS = 60_000;

export class EndpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointNotFoundError";
  }
}

export class ProbeInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeInFlightError";
  }
}

export class ProbeCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeCooldownError";
  }
}

export class InvalidProbeCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProbeCooldownError";
  }
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export interface ProbeRow {
  readonly id: string;
  /** bigint, as text. The only stable order this table has — see 0034's header. */
  readonly seq: string;
  readonly endpoint_id: string;
  readonly channel: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly state: ProbeState;
  readonly attempts: number;
  readonly verdict: ProbeVerdict | null;
  readonly detail: string | null;
  readonly status: number | null;
  readonly completed_at: string | null;
}

/**
 * `channel` and `enabled` are joined in rather than left to the reader.
 *
 * A verdict is unreadable without the channel — `reachable` means a relay accepted us and
 * `delivered` means a receiver did, and which one a probe could even have earned depends
 * on the channel. `enabled` is here because a `delivered` verdict on a disabled endpoint is
 * true and misleading on its own.
 */
const PROBE_COLUMNS = `p.id, p.seq::text AS seq, p.endpoint_id, e.channel, p.requested_by,
       to_char(p.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
       p.state, p.attempts, p.verdict, p.detail, p.status,
       CASE WHEN p.completed_at IS NULL THEN NULL
            ELSE to_char(p.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS completed_at`;

export interface RequestProbeInput {
  readonly endpointId: string;
  /** The administrator asking. 0034 makes this NOT NULL: a probe is attributable or it does not happen. */
  readonly requestedBy: string;
}

/**
 * Queues a probe. Every refusal below is the database's, translated.
 *
 * The rules are enforced by 0034 rather than here precisely so that this function is not
 * the only thing that honours them — a rule a route applies is a rule the next caller
 * skips, and this store is not the only caller a scheduler could grow.
 */
export async function requestProbe(
  tx: PoolClient,
  tenantId: string,
  input: RequestProbeInput,
): Promise<ProbeRow> {
  let id: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO crm.notification_endpoint_probe (tenant_id, endpoint_id, requested_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, input.endpointId, input.requestedBy],
    );
    id = rows[0]!.id;
  } catch (err) {
    throw translateProbeError(err, input.endpointId);
  }
  // Non-null: the INSERT committed inside this transaction and RLS admits what it wrote.
  return (await probeById(tx, id))!;
}

export async function probeById(tx: PoolClient, id: string): Promise<ProbeRow | null> {
  const { rows } = await tx.query<ProbeRow>(
    `SELECT ${PROBE_COLUMNS}
       FROM crm.notification_endpoint_probe p
       JOIN crm.notification_endpoint e ON e.id = p.endpoint_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The newest probe for an endpoint, answered or not — what an administrator's screen shows.
 *
 * Ordered by `seq`, never by `requested_at`: `now()` is the transaction timestamp, so two
 * probes written in one transaction share it to the microsecond and the newest would be
 * whichever the planner happened to return.
 */
export async function latestProbe(tx: PoolClient, endpointId: string): Promise<ProbeRow | null> {
  const rows = await listProbes(tx, endpointId, 1);
  return rows[0] ?? null;
}

export async function listProbes(
  tx: PoolClient,
  endpointId: string,
  limit = 20,
): Promise<readonly ProbeRow[]> {
  const { rows } = await tx.query<ProbeRow>(
    `SELECT ${PROBE_COLUMNS}
       FROM crm.notification_endpoint_probe p
       JOIN crm.notification_endpoint e ON e.id = p.endpoint_id
      WHERE p.endpoint_id = $1
      ORDER BY p.seq DESC
      LIMIT $2`,
    [endpointId, Math.max(1, Math.min(limit, 100))],
  );
  return rows;
}

export interface ClaimedProbe {
  readonly id: string;
  readonly seq: string;
  readonly tenant_id: string;
  readonly endpoint_id: string;
  readonly channel: string;
  readonly url: string;
  readonly secret_env: string;
  readonly enabled: boolean;
  readonly attempts: number;
  readonly requested_at: string;
}

/**
 * Claims queued probes and renews the lease in the same statement.
 *
 * The same discipline as `claimDue` in `dispatch.ts`: `FOR UPDATE SKIP LOCKED` so two
 * scheduler instances share the work without a lock, the claim recorded before the
 * external call rather than after, and the endpoint joined in so the prober needs no
 * second round trip. `attempts` comes back already incremented, which is what makes the
 * abandonment ceiling readable at the call site.
 *
 * An `in_flight` row older than the lease is re-claimable, because the only way it got
 * there is a process that died holding it.
 */
export async function claimDueProbes(
  tx: PoolClient,
  tenantId: string,
  now: Date,
  workerId: string,
  limit = 10,
  leaseMs: number = PROBE_LEASE_MS,
): Promise<readonly ClaimedProbe[]> {
  const { rows } = await tx.query<ClaimedProbe>(
    `WITH due AS (
       SELECT p.id
         FROM crm.notification_endpoint_probe p
        WHERE p.tenant_id = $1
          AND (
            p.state = 'requested'
            OR (p.state = 'in_flight'
                AND p.claimed_at <= $2::timestamptz - ($5 || ' milliseconds')::interval)
          )
        ORDER BY p.seq
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE crm.notification_endpoint_probe p
          SET state = 'in_flight',
              attempts = p.attempts + 1,
              claimed_at = $2,
              claimed_by = left($4, 200)
        WHERE p.id IN (SELECT id FROM due)
        RETURNING p.id, p.seq, p.tenant_id, p.endpoint_id, p.attempts, p.requested_at
     )
     SELECT c.id, c.seq::text AS seq, c.tenant_id, c.endpoint_id, c.attempts,
            to_char(c.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
            e.channel, e.url, e.secret_env, e.enabled
       FROM claimed c
       JOIN crm.notification_endpoint e ON e.id = c.endpoint_id
      ORDER BY c.seq`,
    [tenantId, now, limit, workerId, leaseMs],
  );
  return rows;
}

/**
 * Writes the answer, once.
 *
 * Returns false when the row was not claimed any more — another pass settled it while this
 * one was on the network. False rather than a throw: the probe HAS an answer, it is just
 * not this one's, and turning that into an error would make a harmless race look like a
 * fault. 0034's settle-once trigger is what guarantees the first answer is the one kept.
 */
export async function recordProbeVerdict(
  tx: PoolClient,
  probeId: string,
  outcome: ProbeOutcome,
  now: Date,
): Promise<boolean> {
  // The CHECK requires a detail between 1 and 2000 characters. An empty one would abort
  // the settlement and leave the probe in flight to be abandoned later, so a verdict with
  // nothing to say still says something.
  const detail = outcome.detail.trim() === "" ? `${outcome.verdict}, with no detail reported` : outcome.detail;
  const { rowCount } = await tx.query(
    `UPDATE crm.notification_endpoint_probe
        SET state = 'complete', verdict = $2, detail = left($3, 2000), status = $4, completed_at = $5
      WHERE id = $1 AND state = 'in_flight'`,
    [probeId, outcome.verdict, detail, outcome.status ?? null, now],
  );
  return rowCount === 1;
}

/**
 * The tenant's cooldown, in seconds. 0 means none.
 *
 * Reads through `crm.notification_policy`, creating the row at its defaults if the tenant
 * has never had one — the same thing `notificationPolicy` does, and for the same reason:
 * the absence of a policy row must read as the defaults rather than as "no policy", or the
 * value a caller sees depends on whether anybody has configured retention.
 */
export async function probeCooldownSeconds(tx: PoolClient, tenantId: string): Promise<number> {
  await tx.query("INSERT INTO crm.notification_policy (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING", [
    tenantId,
  ]);
  const { rows } = await tx.query<{ probe_cooldown_seconds: number }>(
    "SELECT probe_cooldown_seconds FROM crm.notification_policy WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]?.probe_cooldown_seconds ?? DEFAULT_PROBE_COOLDOWN_SECONDS;
}

export async function setProbeCooldownSeconds(
  tx: PoolClient,
  tenantId: string,
  seconds: number,
): Promise<number> {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_PROBE_COOLDOWN_SECONDS) {
    throw new InvalidProbeCooldownError(
      `the probe cooldown must be a whole number of seconds between 0 and ${String(MAX_PROBE_COOLDOWN_SECONDS)}, ` +
        `not ${JSON.stringify(seconds)}. 0 disables it, which is defensible only where the endpoint is not a ` +
        `third party.`,
    );
  }
  await probeCooldownSeconds(tx, tenantId);
  const { rows } = await tx.query<{ probe_cooldown_seconds: number }>(
    `UPDATE crm.notification_policy SET probe_cooldown_seconds = $2, updated_at = now()
      WHERE tenant_id = $1 RETURNING probe_cooldown_seconds`,
    [tenantId, seconds],
  );
  return rows[0]!.probe_cooldown_seconds;
}

/**
 * 0034's refusals, as the sentences a 404 or a 409 can carry.
 *
 * Matched on a stable prefix in the message rather than a constraint name, because these
 * come from `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'` in a trigger, which
 * carries no constraint — the same shape `@crm/territory` and `@crm/callplan` translate.
 * The unique index is matched too: it is the race-free backstop for the outstanding rule
 * and reaches a caller when two requests arrive in the same instant.
 */
function translateProbeError(err: unknown, endpointId: string): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  const message = e.message ?? String(err);

  if (message.includes("probe-foreign-endpoint") || e.code === "23503") {
    return new EndpointNotFoundError(
      `notification endpoint ${endpointId} does not exist in this tenant, so there is nothing to probe`,
    );
  }
  if (message.includes("probe-outstanding") || e.constraint === "uq_notification_endpoint_probe_outstanding") {
    return new ProbeInFlightError(
      `endpoint ${endpointId} already has a probe waiting for an answer; the scheduler settles it within a ` +
        `tick, and a second request would only ask the same question again`,
    );
  }
  if (message.includes("probe-cooldown")) {
    return new ProbeCooldownError(
      // The database's sentence carries the two timestamps and the configured window, and
      // it is the actionable half — an administrator needs to know when they may retry.
      `${message.replace(/^.*probe-cooldown: /, "")}. A probe sends real traffic to the destination, so it is ` +
        `rate-limited per tenant (crm.notification_policy.probe_cooldown_seconds).`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

// ---------------------------------------------------------------------------
// The probers.
// ---------------------------------------------------------------------------

export interface ProbeTarget {
  readonly probeId: string;
  readonly tenantId: string;
  readonly endpointId: string;
  readonly channel: string;
  readonly url: string;
  /** The NAME of the environment variable, exactly as the senders take it. */
  readonly secretEnv: string;
  readonly requestedAt: string;
}

export interface ProbeOutcome {
  readonly verdict: ProbeVerdict;
  readonly detail: string;
  readonly status?: number;
}

export interface ChannelProber {
  readonly channel: string;
  probe(target: ProbeTarget): Promise<ProbeOutcome>;
}

/**
 * What a receiver sees.
 *
 * Nothing in it is a person, an account or a lot — which is the one thing a probe envelope
 * must get right, because it goes to a URL that may be wrong. It is also deliberately NOT
 * shaped like a `WebhookPayload`: a receiver parsing it as a notification finds no `kind`,
 * no `subject` and no `recipient`, so it fails to parse rather than inventing a signal.
 */
export function probeBody(target: ProbeTarget): string {
  return JSON.stringify({
    event: PROBE_EVENT,
    probeId: target.probeId,
    endpointId: target.endpointId,
    tenantId: target.tenantId,
    requestedAt: target.requestedAt,
    note:
      "This is a CRM endpoint probe, not a notification. Nothing has happened and no action is required. " +
      "Answer 2xx to confirm this endpoint is reachable and that the signature verifies.",
  });
}

/** How a `SendOutcome` reads as a probe verdict. Fail closed: a retryable failure proves nothing. */
function verdictOf(outcome: SendOutcome, success: ProbeVerdict): ProbeVerdict {
  if (outcome.kind === "delivered") return success;
  if (outcome.kind === "dead") return "refused";
  return "unknown";
}

export interface WebhookProberOptions {
  readonly fetch: FetchLike;
  /** Reads the secret by variable name. Injected so a test need not mutate process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly channel?: string;
}

export class WebhookProber implements ChannelProber {
  readonly channel: string;

  constructor(private readonly opts: WebhookProberOptions) {
    this.channel = opts.channel ?? "webhook";
  }

  async probe(target: ProbeTarget): Promise<ProbeOutcome> {
    const env = this.opts.env ?? process.env;
    const secret = env[target.secretEnv];
    if (secret === undefined || secret === "") {
      // `refused`, not `unknown`: this IS the answer the administrator came for, and it is
      // a definite one. The sentence is the webhook sender's, so the probe and the dead
      // letter it predicts read the same.
      return {
        verdict: "refused",
        detail:
          `${target.secretEnv} is not set in this process, so a delivery to this endpoint could not be ` +
          `signed. Nothing was sent — refusing to send unsigned.`,
      };
    }

    const body = probeBody(target);
    const timestamp = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

    try {
      const res = await this.opts.fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
          [TIMESTAMP_HEADER]: String(timestamp),
          [DELIVERY_HEADER]: target.probeId,
          [EVENT_HEADER]: PROBE_EVENT,
        },
        body,
        signal: controller.signal,
      });
      let text = "";
      try {
        text = (await res.text()).slice(0, 500);
      } catch {
        text = "";
      }
      const outcome = classifyStatus(res.status, text);
      const verdict = verdictOf(outcome, "delivered");
      return {
        verdict,
        status: res.status,
        detail:
          verdict === "delivered"
            ? `a signed probe POST to ${target.url} was accepted with ${String(res.status)}: the secret in ` +
              `${target.secretEnv} signed it, and the receiver verified and accepted it`
            : (outcome.error ?? `endpoint returned ${String(res.status)}`),
      };
    } catch (err) {
      // Connection refused, DNS, a reset, the abort above. None of it says anything about
      // the configuration, so none of it is allowed to read as a verdict about it.
      return {
        verdict: "unknown",
        detail:
          `the probe POST to ${target.url} did not complete: ${err instanceof Error ? err.message : String(err)}. ` +
          `Nothing was proven either way.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SmtpProberOptions {
  readonly relay: SmtpRelayConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly tlsOptions?: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>;
  readonly now?: () => number;
  readonly channel?: string;
}

/**
 * The email prober: the whole conversation except the message.
 *
 * The constructor refuses the same three things `SmtpSender`'s does, by calling the same
 * predicates. That is not redundancy — the prober is built beside the sender at boot from
 * the same configuration, and a prober that accepted a plaintext relay to a remote host
 * would carry an AUTH password across the network in clear text to find out whether it was
 * correct, which is the exact failure the sender's refusal exists to prevent.
 */
export class SmtpProber implements ChannelProber {
  readonly channel: string;
  private readonly relay: SmtpRelayConfig;
  private readonly transport: SmtpTransport;

  constructor(private readonly opts: SmtpProberOptions) {
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
      throw new InvalidSmtpRelayError(
        `plaintext SMTP is allowed only to a loopback relay, not to ${this.relay.host}. ` +
          `A probe authenticates, so the password would cross the network in clear text.`,
      );
    }
  }

  async probe(target: ProbeTarget): Promise<ProbeOutcome> {
    let to: string;
    try {
      to = parseMailtoEndpoint(target.url);
    } catch (err) {
      // The row says the same thing every time it is read, so this is an answer and not a
      // failure to get one.
      return { verdict: "refused", detail: err instanceof Error ? err.message : String(err) };
    }

    const env = this.opts.env ?? process.env;
    const username = this.relay.username;
    let password: string | undefined;
    if (username !== undefined) {
      password = env[target.secretEnv];
      if (password === undefined || password === "") {
        return {
          verdict: "refused",
          detail:
            `${target.secretEnv} is not set in this process, so the relay ${this.relay.host} cannot be ` +
            `authenticated as ${username}. Nothing was connected to.`,
        };
      }
    }

    const nowMs = this.opts.now?.() ?? Date.now();
    const perWait = this.opts.timeoutMs ?? 10_000;
    const deadlineAt = nowMs + (this.opts.overallTimeoutMs ?? 30_000);
    const tlsOptions = this.opts.tlsOptions ?? {};

    let conn: ProbeConversation | null = null;
    try {
      conn = await this.open(perWait, deadlineAt, tlsOptions);
      return await this.converse(conn, { to, username, password, tlsOptions });
    } catch (err) {
      if (err instanceof SmtpProtocolError) {
        // Permanent, like the sender's `dead`: whatever is on that port will not be
        // speaking SMTP on the next attempt either.
        return { verdict: "refused", detail: `${err.message} — the relay is not speaking SMTP` };
      }
      return {
        verdict: "unknown",
        detail:
          `the probe could not reach ${this.relay.host}:${String(this.relay.port)}: ` +
          `${err instanceof Error ? err.message : String(err)}. Nothing was proven either way.`,
      };
    } finally {
      conn?.destroy();
    }
  }

  private async open(
    perWait: number,
    deadlineAt: number,
    tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>,
  ): Promise<ProbeConversation> {
    const { host, port } = this.relay;
    const socket: Socket | TLSSocket =
      this.transport === "implicit_tls" ? tlsConnect({ ...tlsOptions, host, port }) : netConnect({ host, port });

    try {
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
    } catch (err) {
      // Nothing wraps this socket yet, so the `finally` in `probe` cannot reach it. The
      // sender leaked one descriptor per attempt against a down relay before it did this.
      socket.destroy();
      throw err;
    }
    return new ProbeConversation(socket, perWait, deadlineAt);
  }

  private async converse(
    conn: ProbeConversation,
    ctx: {
      readonly to: string;
      readonly username: string | undefined;
      readonly password: string | undefined;
      readonly tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>;
    },
  ): Promise<ProbeOutcome> {
    const step = async (stage: SmtpStage): Promise<ProbeOutcome | SmtpReply> => {
      const reply = await conn.read(stage);
      const verdict = classifySmtpReply(stage, reply.code, reply.lines.join(" ").trim());
      if (verdict.kind === "delivered") return reply;
      return {
        verdict: verdictOf(verdict, "reachable"),
        detail: verdict.error ?? `relay returned ${String(reply.code)} at ${stage}`,
        ...(verdict.status === undefined ? {} : { status: verdict.status }),
      };
    };

    const greeting = await step("greeting");
    if ("verdict" in greeting) return greeting;

    const ehloName = this.relay.clientName ?? this.relay.from.slice(this.relay.from.lastIndexOf("@") + 1);
    conn.send(`EHLO ${ehloName}`);
    const ehlo = await step("ehlo");
    if ("verdict" in ehlo) return ehlo;
    let caps = parseEhloCapabilities(ehlo.lines);

    if (this.transport === "starttls") {
      if (!caps.startTls) {
        return {
          verdict: "refused",
          detail:
            `${this.relay.host}:${String(this.relay.port)} does not offer STARTTLS, so no notification could ` +
            `cross to it without being in clear text. Nothing was sent, and nothing will be.`,
        };
      }
      conn.send("STARTTLS");
      const ready = await step("starttls");
      if ("verdict" in ready) return ready;
      if (conn.pendingBytes > 0) {
        return {
          verdict: "refused",
          detail: `${this.relay.host} sent data after its STARTTLS reply; refusing to hand a dirty socket to TLS`,
        };
      }
      await conn.upgrade(this.relay.host, ctx.tlsOptions);
      // RFC 3207: everything learned in the clear is discarded. A relay that advertises
      // AUTH only after TLS is the normal case.
      conn.send(`EHLO ${ehloName}`);
      const second = await step("ehlo");
      if ("verdict" in second) return second;
      caps = parseEhloCapabilities(second.lines);
    }

    let authed = "no AUTH was attempted, because no username is configured for this relay";
    if (ctx.username !== undefined && ctx.password !== undefined) {
      const mechanism = chooseAuthMechanism(caps.authMechanisms);
      if (mechanism === null) {
        return {
          verdict: "refused",
          detail:
            `${this.relay.host} offers no AUTH mechanism this client supports ` +
            `(${caps.authMechanisms.length === 0 ? "it advertised none" : caps.authMechanisms.join(", ")}), ` +
            `but a username is configured. A notification could not be sent either.`,
        };
      }
      const refusal = await this.authenticate(conn, step, mechanism, ctx.username, ctx.password);
      if (refusal !== null) return refusal;
      authed = `AUTH ${mechanism} succeeded as ${ctx.username} with the password in the endpoint's variable`;
    }

    // The envelope, and nothing in it. This is the part that makes the verdict worth more
    // than a credential check: a relay that authenticates us and then refuses the envelope
    // sender or the mailbox would have dead-lettered every notification, and AUTH alone
    // would have reported it fine.
    conn.send(`MAIL FROM:<${this.relay.from}>`);
    const mail = await step("mail_from");
    if ("verdict" in mail) return mail;

    conn.send(`RCPT TO:<${ctx.to}>`);
    const rcpt = await step("rcpt_to");
    if ("verdict" in rcpt) return rcpt;

    // RSET before QUIT, so "no message was sent" is explicit in the relay's own log rather
    // than inferred from a session that stopped before DATA. Neither reply is read: the
    // verdict is already earned, and nothing after this may take it away — the same reason
    // the sender swallows everything after its 250.
    try {
      conn.send("RSET");
      await conn.quit();
    } catch {
      /* already answered */
    }

    return {
      verdict: "reachable",
      status: rcpt.code,
      detail:
        `${this.relay.host}:${String(this.relay.port)} accepted the envelope for ${ctx.to} ` +
        `(${String(rcpt.code)} at rcpt_to); ${authed}. The transaction was then reset, so NO message was ` +
        `delivered — this proves the relay, the credentials and the mailbox, not a delivery.`,
    };
  }

  private async authenticate(
    conn: ProbeConversation,
    step: (stage: SmtpStage) => Promise<ProbeOutcome | SmtpReply>,
    mechanism: "PLAIN" | "LOGIN",
    username: string,
    password: string,
  ): Promise<ProbeOutcome | null> {
    if (mechanism === "PLAIN") {
      conn.send(`AUTH PLAIN ${authPlainToken(username, password)}`);
      const reply = await step("auth");
      return "verdict" in reply ? reply : null;
    }

    conn.send("AUTH LOGIN");
    const userChallenge = await step("auth_challenge");
    if ("verdict" in userChallenge) return userChallenge;
    conn.send(Buffer.from(username, "utf8").toString("base64"));
    const passChallenge = await step("auth_challenge");
    if ("verdict" in passChallenge) return passChallenge;
    conn.send(Buffer.from(password, "utf8").toString("base64"));
    const reply = await step("auth");
    return "verdict" in reply ? reply : null;
  }
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * One probe conversation.
 *
 * The listener is attached once and never per read: a relay is free to send its greeting
 * before anyone asks for it, and bytes that arrive while nothing is listening are gone.
 * The reply reader is local because `smtp.ts` keeps its own private — see the header.
 */
class ProbeConversation {
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
        new SmtpTimeoutError(`the probe ran past its overall timeout waiting for ${stage}`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new SmtpTimeoutError(`no ${stage} reply from the relay within ${String(budget)}ms`));
      }, budget);
      this.wake = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /** A complete reply, or null while its last line has not arrived. */
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
        throw new SmtpProtocolError(`${JSON.stringify(line.slice(0, 120))} is not an SMTP reply line`);
      }
      lines.push(match[3] ?? "");
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(offset);
        return { code: Number(match[1]), lines };
      }
    }
  }

  async upgrade(
    host: string,
    tlsOptions: Readonly<Omit<ConnectionOptions, "socket" | "host" | "port">>,
  ): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");

    const secure = tlsConnect({ ...tlsOptions, socket: plain, host });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new SmtpTimeoutError(`the TLS handshake did not complete within ${String(this.perWaitMs)}ms`)),
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
    } catch (err) {
      // `this.socket` is still the plaintext one, so a caller's `destroy()` would not
      // reach this wrapper or its pending handshake. Destroying it takes the plaintext
      // socket with it, which is what a failed handshake wants.
      secure.destroy();
      throw err;
    }

    this.socket = secure;
    // A decoder carried over from the cleartext phase may hold a partial codepoint, which
    // would corrupt the first encrypted reply.
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.failure = null;
    this.closed = false;
    this.attach();
  }

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

// ---------------------------------------------------------------------------
// The runner. The scheduler's half.
// ---------------------------------------------------------------------------

export interface ProbeRunResult {
  readonly claimed: number;
  readonly abandoned: number;
  readonly byVerdict: Readonly<Record<ProbeVerdict, number>>;
}

export interface EndpointProbeRunnerOptions {
  readonly pool: Pool;
  readonly probers: readonly ChannelProber[];
  /** Recorded on the claim, so an abandoned probe names the process that dropped it. */
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

export class EndpointProbeRunner {
  private readonly probers: Map<string, ChannelProber>;

  constructor(private readonly opts: EndpointProbeRunnerOptions) {
    this.probers = new Map(opts.probers.map((p) => [p.channel, p]));
  }

  /**
   * One pass for one tenant.
   *
   * Claim and settle are separate transactions with the network call between them, never
   * one transaction held open across it — the same rule `NotificationDispatcher` follows,
   * and for the same reason: a relay that takes its full timeout would otherwise hold a row
   * lock for thirty seconds and block the next pass.
   */
  async runTenant(tenantId: string): Promise<ProbeRunResult> {
    const now = this.opts.now ?? ((): Date => new Date());
    const client = await this.opts.pool.connect();
    const byVerdict: Record<ProbeVerdict, number> = { delivered: 0, reachable: 0, refused: 0, unknown: 0 };
    let abandoned = 0;

    try {
      const claimed = await withTenantContext(client, tenantId, (tx) =>
        claimDueProbes(
          tx,
          tenantId,
          now(),
          this.opts.workerId,
          this.opts.batchSize ?? 10,
          this.opts.leaseMs ?? PROBE_LEASE_MS,
        ),
      );

      for (const probe of claimed) {
        const outcome = await this.outcomeFor(probe, tenantId);
        if (probe.attempts > MAX_PROBE_ATTEMPTS) abandoned += 1;
        await withTenantContext(client, tenantId, async (tx) => {
          if (await recordProbeVerdict(tx, probe.id, outcome, now())) byVerdict[outcome.verdict] += 1;
        });
      }

      return { claimed: claimed.length, abandoned, byVerdict };
    } finally {
      client.release();
    }
  }

  private async outcomeFor(probe: ClaimedProbe, tenantId: string): Promise<ProbeOutcome> {
    if (probe.attempts > MAX_PROBE_ATTEMPTS) {
      // Checked before the prober so a probe that somehow kills the process it is claimed
      // by cannot be claimed forever. `unknown`, because nobody ever got an answer.
      return {
        verdict: "unknown",
        detail:
          `this probe was claimed ${String(probe.attempts)} times and never answered, so it was abandoned ` +
          `after ${String(MAX_PROBE_ATTEMPTS)}. The process holding it did not settle it; nothing is known ` +
          `about the endpoint.`,
      };
    }

    const prober = this.probers.get(probe.channel);
    if (prober === undefined) {
      // The same voice as the dispatcher's retry reason, because it is the same fault: an
      // operator meeting both messages is meeting one problem, and the registered list is
      // what tells "wrong binary" from "wrong endpoint" apart.
      return {
        verdict: "unknown",
        detail:
          `no prober registered for channel ${probe.channel} in this process — it probes ` +
          `${[...this.probers.keys()].join(", ") || "none"}. The endpoint may be fine; this binary ` +
          `cannot find out, and it cannot send to it either.`,
      };
    }

    const outcome = await prober.probe({
      probeId: probe.id,
      tenantId,
      endpointId: probe.endpoint_id,
      channel: probe.channel,
      url: probe.url,
      secretEnv: probe.secret_env,
      requestedAt: probe.requested_at,
    });

    if (probe.enabled) return outcome;
    // A verdict about a disabled endpoint is true and incomplete on its own: an
    // administrator reading `delivered` would reasonably conclude notifications are
    // arriving there, and none are.
    return {
      ...outcome,
      detail: `${outcome.detail} (this endpoint is disabled, so no notification is routed to it.)`,
    };
  }
}
