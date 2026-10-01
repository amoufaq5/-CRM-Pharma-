#!/usr/bin/env node
import { Pool } from "pg";

import { ed25519Jwk, fromBase64url } from "../jwk.js";
import { DEFAULT_PROPAGATION_SECONDS, PostgresServiceKeyRegistry } from "../key-registry.js";
import { generateServiceKeyPair } from "../signer.js";
import { MAX_TTL_SECONDS } from "../token.js";

/**
 * Key management for the ERP service credential.
 *
 *   crm-service-key list
 *   crm-service-key generate [--note <text>]   mint a keypair, publish the public half
 *   crm-service-key activate <kid>             promote it to the signing key
 *   crm-service-key retire <kid>               drop it from the JWKS (terminal)
 *
 * ROTATION IS FOUR STEPS AND THE ORDER IS THE POINT:
 *
 *   1. generate            — the new public key enters the JWKS as `published`.
 *                            Store the printed PEM in the secret manager.
 *   2. wait                — until every verifier has refetched the JWKS. `activate`
 *                            enforces this; it is not advice.
 *   3. activate <new kid>  — the new key becomes the signing key and the old one
 *                            drops back to `published`, still in the JWKS. Restart
 *                            the scheduler with the new PEM. Tokens signed with the
 *                            old key keep verifying throughout, which is what makes
 *                            this a rotation rather than an outage.
 *   4. retire <old kid>    — once every token the old key signed has expired.
 *                            `retire` enforces that too.
 */
function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

const USAGE = `crm-service-key <command>

  list                        show every key and its state
  generate [--note <text>]    generate a keypair and publish the public half
  activate <kid>              make it the signing key (enforces JWKS propagation)
  retire <kid>                remove it from the JWKS (enforces token expiry)

  --propagation-seconds <n>   override the activate wait (default ${DEFAULT_PROPAGATION_SECONDS})
  --token-ttl-seconds <n>     override the retire wait (default ${MAX_TTL_SECONDS})
`;

function numericFlag(argv: readonly string[], name: string): number | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a non-negative integer`);
  return n;
}

function stringFlag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const pool = new Pool({
    host: env("PGHOST", "/var/run/postgresql"),
    database: env("PGDATABASE"),
    user: env("PGUSER"),
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 1,
  });
  const registry = new PostgresServiceKeyRegistry({ pool });

  try {
    switch (command) {
      case "list": {
        const keys = await registry.list();
        for (const k of keys) {
          log({
            type: "key",
            kid: k.kid,
            status: k.status,
            publishedAt: k.publishedAt.toISOString(),
            activatedAt: k.activatedAt?.toISOString() ?? null,
            demotedAt: k.demotedAt?.toISOString() ?? null,
            retiredAt: k.retiredAt?.toISOString() ?? null,
            note: k.note,
          });
        }
        if (keys.length === 0) {
          log({
            type: "empty",
            detail:
              "no keys published. The JWKS endpoint returns 503 until one exists, and the " +
              "scheduler refuses to start.",
          });
        }
        return 0;
      }

      case "generate": {
        const generated = generateServiceKeyPair();
        const kid = await registry.publish(generated.jwk.x, stringFlag(argv, "note"));
        // stdout, once, and nowhere else. Not logged, not stored, and the registry
        // has no column that could hold it.
        process.stdout.write(
          `\n#### PRIVATE KEY — store this in the secret manager now; it is shown once ####\n` +
            `#### kid: ${kid}\n\n${generated.privateKeyPem}\n` +
            `#### end private key ####\n\n`,
        );
        log({
          type: "published",
          kid,
          status: "published",
          next: `wait for the JWKS to propagate, then: crm-service-key activate ${kid}`,
        });
        return 0;
      }

      case "activate": {
        const kid = argv[1];
        if (kid === undefined) throw new Error("activate needs a kid");
        const propagationSeconds = numericFlag(argv, "propagation-seconds");
        await registry.activate(kid, {
          ...(propagationSeconds !== undefined ? { propagationSeconds } : {}),
        });
        log({ type: "activated", kid, next: "restart the scheduler with this key's PEM" });
        return 0;
      }

      case "retire": {
        const kid = argv[1];
        if (kid === undefined) throw new Error("retire needs a kid");
        const tokenTtlSeconds = numericFlag(argv, "token-ttl-seconds");
        await registry.retire(kid, { ...(tokenTtlSeconds !== undefined ? { tokenTtlSeconds } : {}) });
        log({ type: "retired", kid });
        return 0;
      }

      /**
       * Prints the kid a PEM on stdin would sign under, without touching the
       * database. For checking that the secret an environment holds is the key its
       * registry row names — the mismatch that produces 401s nothing else explains.
       */
      case "kid-of": {
        const pem = await readStdin();
        const { LocalEd25519Signer } = await import("../signer.js");
        log({ type: "kid", kid: LocalEd25519Signer.fromPkcs8Pem(pem).kid });
        return 0;
      }

      /** Recomputes a kid from a JWK `x`, for verifying a row by hand. */
      case "kid-of-x": {
        const x = argv[1];
        if (x === undefined) throw new Error("kid-of-x needs a base64url public key");
        log({ type: "kid", kid: ed25519Jwk(fromBase64url(x)).kid });
        return 0;
      }

      default:
        console.error(`unknown command ${command}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await pool.end();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: "failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  },
);
