#!/usr/bin/env node
import { Pool } from "pg";
import { JwksCache } from "../jwt.js";
import { startApi } from "../server.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
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

  const api = await startApi({
    pool,
    port: Number(process.env["PORT"] ?? "8080"),
    auth: {
      issuer: env("OIDC_ISSUER"),
      audience: env("OIDC_AUDIENCE"),
      jwks: new JwksCache(env("OIDC_JWKS_URL"), async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        return res.json();
      }),
    },
    // One JSON object per line, matching the scheduler. The ERP has no
    // structured logger (report R11), so this is ours to provide.
    onError: (err, ctx) =>
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          correlationId: ctx.correlationId,
          path: ctx.path,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      ),
  });

  console.log(JSON.stringify({ ts: new Date().toISOString(), type: "listening", port: api.port }));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), type: "shutdown", signal }));
    // Stops accepting, lets in-flight requests finish, then drains the pool.
    void api
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(`api failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
