import { readFileSync } from "node:fs";
import type { Pool } from "pg";

import { ServiceCredential, type MintEvent } from "./credential.js";
import { PostgresServiceKeyRegistry } from "./key-registry.js";
import { PostgresServiceRoleSource } from "./role-source.js";
import { LocalEd25519Signer } from "./signer.js";
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "./token.js";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export class CredentialConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialConfigError";
  }
}

export type CredentialConfig =
  | {
      readonly kind: "signing";
      readonly privateKeyPem: string;
      readonly issuer: string;
      readonly audience: string;
      readonly ttlSeconds: number;
    }
  | { readonly kind: "static"; readonly token: string };

/**
 * Decides which credential the environment is asking for, and refuses the
 * combinations that would be a security problem.
 *
 * Separated from the wiring so the rules can be tested without a database. The
 * rules themselves:
 *
 *   - A signing key means the real credential. It takes precedence over
 *     ERP_TOKEN, so an environment that still carries a leftover static token
 *     does not silently keep using it.
 *   - ERP_TOKEN alone works only outside production. A single static bearer token
 *     shared across tenants, carrying whatever role the ERP bound it to, is the
 *     weakest credential in the system; it is fine against a throwaway ERP and
 *     not fine against real tenants.
 *   - Neither is a hard failure. A process that starts without a credential just
 *     accumulates failures on the first ERP call, which is harder to read than a
 *     refusal at boot.
 */
export function resolveCredentialConfig(env: EnvLike, readFile = defaultReadFile): CredentialConfig {
  const production = (env["NODE_ENV"] ?? "development") === "production";
  const pem = signingKeyPem(env, readFile);

  if (pem !== null) {
    const issuer = required(env, "CRM_TOKEN_ISSUER");
    const audience = required(env, "ERP_TOKEN_AUDIENCE");
    const ttlSeconds = ttl(env);
    return { kind: "signing", privateKeyPem: pem, issuer, audience, ttlSeconds };
  }

  const staticToken = env["ERP_TOKEN"];
  if (staticToken !== undefined && staticToken !== "") {
    if (production) {
      throw new CredentialConfigError(
        "ERP_TOKEN is a development-only static credential and must not be used in production. " +
          "Set CRM_SIGNING_KEY_PEM (or CRM_SIGNING_KEY_FILE) to mint short-lived per-tenant " +
          "Ed25519 service tokens instead (ADR-0001 item 10).",
      );
    }
    return { kind: "static", token: staticToken };
  }

  throw new CredentialConfigError(
    "no ERP credential is configured. Set CRM_SIGNING_KEY_PEM or CRM_SIGNING_KEY_FILE " +
      "(with CRM_TOKEN_ISSUER and ERP_TOKEN_AUDIENCE), or ERP_TOKEN outside production.",
  );
}

function signingKeyPem(env: EnvLike, readFile: (path: string) => string): string | null {
  const inline = env["CRM_SIGNING_KEY_PEM"];
  const path = env["CRM_SIGNING_KEY_FILE"];
  if (inline !== undefined && inline !== "" && path !== undefined && path !== "") {
    // Refusing rather than picking is the point: which one is live decides which
    // key signs, and getting it wrong produces 401s with no other symptom.
    throw new CredentialConfigError(
      "CRM_SIGNING_KEY_PEM and CRM_SIGNING_KEY_FILE are both set; remove one. " +
        "Guessing which is intended would decide which key signs.",
    );
  }
  if (inline !== undefined && inline !== "") return inline;
  if (path !== undefined && path !== "") {
    try {
      return readFile(path);
    } catch (err) {
      throw new CredentialConfigError(
        `CRM_SIGNING_KEY_FILE ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function required(env: EnvLike, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new CredentialConfigError(
      `${name} is required when a signing key is configured. It must match the ERP's ` +
        `${name === "CRM_TOKEN_ISSUER" ? "--jwt-issuer" : "--jwt-audience"} exactly, ` +
        `or the ERP rejects every token.`,
    );
  }
  return v;
}

function ttl(env: EnvLike): number {
  const raw = env["ERP_TOKEN_TTL_SECONDS"];
  if (raw === undefined || raw === "") return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
    throw new CredentialConfigError(
      `ERP_TOKEN_TTL_SECONDS must be an integer in [${MIN_TTL_SECONDS}, ${MAX_TTL_SECONDS}]; got ${raw}`,
    );
  }
  return n;
}

export interface BuiltCredential {
  /** Satisfies `TenantCredential`; hand it straight to `ErpClient`. */
  readonly credential: { token(tenantId: string): Promise<string> };
  readonly kind: "signing" | "static";
  /** Null for the static credential. */
  readonly kid: string | null;
  /** A condition worth logging that is not worth refusing to start over. */
  readonly warning: string | null;
}

export interface BuildCredentialOptions {
  readonly pool: Pool;
  readonly env?: EnvLike;
  readonly onMint?: (event: MintEvent) => void;
  readonly readFile?: (path: string) => string;
}

/**
 * Builds the ERP credential a process should use, and verifies at BOOT that the
 * key it holds is one the ERP will accept.
 *
 * That check is the reason this is async and takes a pool. A signer whose key is
 * not in `crm.service_key` — because it was never published, or was retired —
 * mints tokens every verifier rejects with `credential_not_found`. From the far
 * side of an HTTP call that is indistinguishable from the ERP being misconfigured,
 * so it is worth catching here, where the cause is still legible.
 */
export async function buildServiceCredential(opts: BuildCredentialOptions): Promise<BuiltCredential> {
  const env = opts.env ?? process.env;
  const config = resolveCredentialConfig(env, opts.readFile ?? defaultReadFile);

  if (config.kind === "static") {
    return {
      credential: { token: (): Promise<string> => Promise.resolve(config.token) },
      kind: "static",
      kid: null,
      warning:
        "using the static ERP_TOKEN credential. Development only — it is shared across tenants, " +
        "carries whatever role the ERP bound it to, and cannot be rotated without a restart.",
    };
  }

  const signer = LocalEd25519Signer.fromPkcs8Pem(config.privateKeyPem);
  const check = await new PostgresServiceKeyRegistry({ pool: opts.pool }).checkSignerKey(signer.kid);

  const credential = new ServiceCredential({
    signer,
    roles: new PostgresServiceRoleSource({ pool: opts.pool }),
    issuer: config.issuer,
    audience: config.audience,
    ttlSeconds: config.ttlSeconds,
    ...(opts.onMint !== undefined ? { onMint: opts.onMint } : {}),
  });

  return { credential, kind: "signing", kid: signer.kid, warning: check.warning };
}
