#!/usr/bin/env node
import { Pool } from "pg";
import { ErpClient, type FetchLike } from "@crm/acl";
import { buildServiceCredential } from "@crm/credential";
import {
  EndpointProbeRunner,
  NotificationDispatcher,
  SmtpProber,
  SmtpSender,
  WebhookProber,
  WebhookSender,
  checkChannelCoverage,
  type ChannelProber,
  type ChannelSender,
  type FetchLike as NotifyFetch,
  type SmtpRelayConfig,
  type SmtpTransport,
} from "@crm/notify";
import { OutboxRelay } from "@crm/relay";
import { SnapshotRefresher } from "@crm/sync";

import { Scheduler, type SchedulerEvent } from "../scheduler.js";
import { activeTenants } from "../store.js";

/**
 * The CRM's background process: drains the outbox to the ERP and keeps the
 * snapshot tables current.
 *
 * Long-running by necessity, exactly as `operate-server` is on the ERP side —
 * its schedulers are in-process too. Serverless can host the CRM's API but not
 * this.
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

const SMTP_TRANSPORTS: readonly SmtpTransport[] = ["starttls", "implicit_tls", "plaintext"];

/**
 * The email sender, when one is configured.
 *
 * `SMTP_HOST` is the switch: absent means this process sends webhooks only, and an `email`
 * endpoint row dead-letters with a readable reason. Present means the sender is built HERE,
 * at boot, so its constructor refusals — a From that is not a mailbox, a port that is not a
 * port, plaintext to anywhere but loopback — stop the process instead of being discovered
 * one dead notification at a time. That refusal was unreachable until this function
 * existed: nothing outside the tests had ever called the constructor.
 *
 * The password is NOT read here. It is read per delivery, from the variable each endpoint
 * row names in `secret_env`, so two tenants relaying through the same host with different
 * credentials need no second process.
 */
function buildMailRelay(): SmtpRelayConfig | null {
  const host = process.env["SMTP_HOST"];
  if (host === undefined || host === "") return null;

  const transport = process.env["SMTP_TRANSPORT"];
  if (transport !== undefined && !SMTP_TRANSPORTS.includes(transport as SmtpTransport)) {
    throw new Error(`SMTP_TRANSPORT must be one of ${SMTP_TRANSPORTS.join(", ")}, not ${JSON.stringify(transport)}`);
  }
  const port = Number(process.env["SMTP_PORT"] ?? (transport === "implicit_tls" ? "465" : "587"));
  const relay: SmtpRelayConfig = {
    host,
    port,
    from: env("SMTP_FROM"),
    ...(transport !== undefined ? { transport: transport as SmtpTransport } : {}),
    // Absent means no AUTH is attempted at all, which is the only sane reading of "no
    // username": attempting AUTH with an empty one would fail every send identically.
    ...(process.env["SMTP_USERNAME"] !== undefined ? { username: process.env["SMTP_USERNAME"] } : {}),
    ...(process.env["SMTP_CLIENT_NAME"] !== undefined ? { clientName: process.env["SMTP_CLIENT_NAME"] } : {}),
  };
  return relay;
}

const SMTP_TIMEOUT = (): { timeoutMs?: number } =>
  process.env["SMTP_TIMEOUT_MS"] !== undefined ? { timeoutMs: Number(process.env["SMTP_TIMEOUT_MS"]) } : {};

function log(event: SchedulerEvent): void {
  // One JSON object per line: greppable, and ready for a log shipper whenever
  // the CRM grows one. The ERP has no structured logger at all (report R11), so
  // this is ours to provide.
  const line = { ts: new Date().toISOString(), ...event };
  const stream = event.type === "job_error" || event.type === "tick_error" ? console.error : console.log;
  stream(JSON.stringify(line));
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: env("PGHOST", "/var/run/postgresql"),
    database: env("PGDATABASE"),
    user: env("PGUSER"),
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: Number(process.env["PG_POOL_MAX"] ?? "10"),
  });

  /**
   * The ERP credential (ADR-0001 item 10).
   *
   * Built before anything else starts, and it verifies at boot that the signing key
   * is published in the JWKS the API serves — a key that is absent or retired mints
   * tokens the ERP rejects with credential_not_found, which from here looks exactly
   * like the ERP being misconfigured.
   *
   * The mint event deliberately carries the kid, role and jti and NOT the token:
   * the token is a bearer credential and must not reach a log line.
   */
  const built = await buildServiceCredential({
    pool,
    onMint: (e) =>
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          type: "token_minted",
          tenantId: e.tenantId,
          kid: e.kid,
          role: e.role,
          jti: e.jti,
          expiresAt: new Date(e.expiresAtSeconds * 1000).toISOString(),
        }),
      ),
  });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "credential",
      kind: built.kind,
      kid: built.kid,
    }),
  );
  if (built.warning !== null) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "warning", detail: built.warning }));
  }

  const client = new ErpClient({
    baseUrl: env("ERP_BASE_URL"),
    credential: built.credential,
    fetch: globalThis.fetch as unknown as FetchLike,
  });

  // One relay config, two consumers. The sender and the prober must agree about the host,
  // the transport and the From, or a probe would report on a relay the sender never uses.
  const mailRelay = buildMailRelay();
  const senders: readonly ChannelSender[] = [
    new WebhookSender({ fetch: globalThis.fetch as unknown as NotifyFetch }),
    ...(mailRelay === null ? [] : [new SmtpSender({ relay: mailRelay, ...SMTP_TIMEOUT() })]),
  ];
  const probers: readonly ChannelProber[] = [
    new WebhookProber({ fetch: globalThis.fetch as unknown as NotifyFetch }),
    ...(mailRelay === null ? [] : [new SmtpProber({ relay: mailRelay, ...SMTP_TIMEOUT() })]),
  ];
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), type: "senders", channels: senders.map((x) => x.channel) }),
  );

  /**
   * Does every endpoint in the database have a sender in THIS process? (0034)
   *
   * Said once, at boot, because that is when an operator is looking. It does NOT refuse to
   * start, and that is the decision: the TLS refusal in `SmtpSender`'s constructor is a
   * statement about this process's own configuration with no legitimate counter-example,
   * whereas coverage is a statement about tenant data that changes while the process runs
   * — an administrator can create an email endpoint a minute after a webhook-only
   * scheduler booted. And the blast radius is inverted: refusing to start takes down the
   * relay drain, the expiry sweep and expense posting for EVERY tenant because one tenant
   * configured one endpoint this binary cannot serve. A late notification is a late
   * notification; a scheduler that will not start means a rep's write never reaches the
   * ERP.
   *
   * Per tenant, necessarily: `crm.notification_endpoint` is RLS-forced and boot happens
   * before any tenant context exists, so a single cross-tenant SELECT returns zero rows
   * — correctly, and silently, which would report every deployment clean.
   */
  const coverageClient = await pool.connect();
  let tenantIds: readonly string[];
  try {
    tenantIds = (await activeTenants(coverageClient)).map((t) => t.tenant_id);
  } finally {
    coverageClient.release();
  }
  const coverage = await checkChannelCoverage(pool, tenantIds, senders);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "channel_coverage",
      verdict: coverage.verdict,
      registered: coverage.registered,
      tenants: coverage.tenantsChecked,
      unreadable: coverage.unreadable,
      summary: coverage.summary,
    }),
  );
  for (const line of coverage.lines) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "warning", detail: line }));
  }

  const workerId = `${process.env["HOSTNAME"] ?? "local"}-${process.pid}`;
  const scheduler = new Scheduler({
    pool,
    relay: new OutboxRelay({ pool, client, workerId }),
    refresher: new SnapshotRefresher({ pool, client }),
    // Both senders read each endpoint's secret from the environment by name, so nothing
    // secret is in the database and the process needs no configuration beyond the
    // variables those endpoints point at.
    notifications: new NotificationDispatcher({ pool, senders }),
    endpointProbes: new EndpointProbeRunner({ pool, probers, workerId }),
    ...(process.env["TICK_INTERVAL_MS"] !== undefined
      ? { tickIntervalMs: Number(process.env["TICK_INTERVAL_MS"]) }
      : {}),
    onEvent: log,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // a second Ctrl-C must not race the first
    shuttingDown = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), type: "shutdown", signal }));
    // Waits for the tick in flight, so a deploy never kills a half-drained
    // outbox mid-dispatch.
    void scheduler
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(JSON.stringify({ ts: new Date().toISOString(), type: "started", workerId }));
  scheduler.start();
}

main().catch((err: unknown) => {
  console.error(`scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
