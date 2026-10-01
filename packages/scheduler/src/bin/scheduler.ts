#!/usr/bin/env node
import { Pool } from "pg";
import { ErpClient, type FetchLike } from "@crm/acl";
import { buildServiceCredential } from "@crm/credential";
import { OutboxRelay } from "@crm/relay";
import { SnapshotRefresher } from "@crm/sync";

import { Scheduler, type SchedulerEvent } from "../scheduler.js";

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

  const workerId = `${process.env["HOSTNAME"] ?? "local"}-${process.pid}`;
  const scheduler = new Scheduler({
    pool,
    relay: new OutboxRelay({ pool, client, workerId }),
    refresher: new SnapshotRefresher({ pool, client }),
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
