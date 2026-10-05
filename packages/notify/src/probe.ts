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
 * ONE SMTP CONVERSATION, NOT TWO. `SmtpConversation` in `smtp.ts` is the only socket,
 * reply reader and TLS upgrade in this package, and this prober drives it: the greeting,
 * EHLO, STARTTLS, its second EHLO, AUTH and the envelope are its `negotiate` and
 * `envelope`, and what is local here is `RSET`, `QUIT` and the vocabulary of a verdict.
 * This file used to hold a second copy of that plumbing, which is the duplication a probe
 * can least afford: the two copies would have to keep agreeing about what a multi-line
 * reply is and when a timeout must destroy its socket, and a probe that drifted from the
 * sender would report `reachable` for a relay the sender cannot use — the exact inversion
 * of what the probe is for. The relay refusals are `assertUsableRelay`, for the same
 * reason.
 *
 * FAIL CLOSED, EVERYWHERE. A probe that could not be completed is `unknown`: a timeout, a
 * refused connection, a 503 or a 429 from a webhook, a 4xx from a relay, a channel this
 * process has no prober for. None of those are evidence that an endpoint works, and the
 * verdict says so rather than implying otherwise by omission.
 */
import type { ConnectionOptions } from "node:tls";

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
  SmtpConversation,
  SmtpProtocolError,
  assertUsableRelay,
  parseMailtoEndpoint,
  type SmtpRelayConfig,
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

/**
 * The rep a probe is attributed to is not in this tenant.
 *
 * Its own class rather than `EndpointNotFoundError`, for the reason 0030 gave for not
 * overloading `approved_by` with a rejecter: a refusal that names the wrong noun sends the
 * reader looking for a problem they do not have. Reachable since 0037 made
 * `requested_by` a composite `(tenant_id, id)` reference — before that a cross-tenant rep
 * satisfied the foreign key, because a referential check runs with row security disabled.
 */
export class ProbeRequesterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeRequesterNotFoundError";
  }
}

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

  // The trigger's sentence first, because it runs BEFORE the constraint and is the one a
  // caller normally gets. A bare 23503 is the backstop, and since 0037 it must be
  // discriminated: both of this table's references are composite `(tenant_id, …)`, so a
  // `requested_by` naming a rep in another tenant now raises the same code as a foreign
  // endpoint and was being reported as a missing endpoint — sending an administrator to
  // look at the endpoint they had just successfully selected.
  if (message.includes("probe-foreign-endpoint")) {
    return new EndpointNotFoundError(
      `notification endpoint ${endpointId} does not exist in this tenant, so there is nothing to probe`,
    );
  }
  if (e.code === "23503") {
    if (e.constraint === "notification_endpoint_probe_requested_by_fkey") {
      return new ProbeRequesterNotFoundError(
        `the rep profile asking for this probe does not exist in this tenant, so the probe could not be ` +
          `attributed — and 0034 makes a probe attributable or it does not happen`,
      );
    }
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
 * A protocol refusal, as a verdict.
 *
 * `verdictOf` does the fail-closed mapping — a 5xx is `refused`, a 4xx is `unknown`,
 * because a greylist proves nothing — and the sentence is the sender's own, from
 * `classifySmtpReply` or from `negotiate`, so a probe and the dead letter it predicts read
 * the same.
 */
function refusalVerdict(outcome: SendOutcome): ProbeOutcome {
  return {
    verdict: verdictOf(outcome, "reachable"),
    detail: outcome.error ?? "the relay refused, without saying where",
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
  };
}

/**
 * The email prober: the sender's own conversation, stopped before the message.
 *
 * It drives `SmtpConversation` from `smtp.ts`, so there is exactly one answer to "what
 * does this client do when the relay says X". What is here is only what makes this a probe
 * rather than a send: `RSET` where the sender has `DATA`, and a verdict where it has a
 * `SendOutcome`.
 */
export class SmtpProber implements ChannelProber {
  readonly channel: string;
  private readonly relay: SmtpRelayConfig;
  private readonly transport: SmtpTransport;

  constructor(private readonly opts: SmtpProberOptions) {
    this.channel = opts.channel ?? "email";
    this.relay = opts.relay;
    // The same three refusals `SmtpSender` makes, out of the same function — and the
    // plaintext one matters more here than there, which is why it is argued where a reader
    // of either class will meet it.
    this.transport = assertUsableRelay(opts.relay);
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

    let conn: SmtpConversation | null = null;
    try {
      conn = await SmtpConversation.connect({
        relay: this.relay,
        transport: this.transport,
        perWaitMs: this.opts.timeoutMs ?? 10_000,
        deadlineAt: nowMs + (this.opts.overallTimeoutMs ?? 30_000),
        tlsOptions: this.opts.tlsOptions ?? {},
      });

      const session = await conn.negotiate(password);
      if ("kind" in session) return refusalVerdict(session);

      // The envelope, and nothing in it. This is what makes the verdict worth more than a
      // credential check: a relay that authenticates us and then refuses the envelope
      // sender or the mailbox would have dead-lettered every notification, and AUTH alone
      // would have reported it fine.
      const envelope = await conn.envelope(to);
      if ("kind" in envelope) return refusalVerdict(envelope);

      // `abandon` is RSET, and the conversation stops there: no DATA, so no message
      // exists. Neither reply is read — the verdict is already earned and nothing after
      // this may take it away.
      try {
        conn.abandon();
        await conn.quit();
      } catch {
        /* already answered */
      }

      const authed =
        session.auth === null
          ? "no AUTH was attempted, because no username is configured for this relay"
          : `AUTH ${session.auth.mechanism} succeeded as ${session.auth.username} with the password in ` +
            `the endpoint's variable`;
      return {
        verdict: "reachable",
        status: envelope.code,
        detail:
          `${this.relay.host}:${String(this.relay.port)} accepted the envelope for ${to} ` +
          `(${String(envelope.code)} at rcpt_to); ${authed}. The transaction was then reset, so NO message ` +
          `was delivered — this proves the relay, the credentials and the mailbox, not a delivery.`,
      };
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
