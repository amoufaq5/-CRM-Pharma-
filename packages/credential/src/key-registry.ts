import type { Pool } from "pg";

import { jwkThumbprint, type PublishedKey } from "./jwk.js";
import { MAX_TTL_SECONDS } from "./token.js";

export type ServiceKeyStatus = "published" | "active" | "retired";

export interface ServiceKeyRow {
  readonly kid: string;
  readonly publicJwkX: string;
  readonly status: ServiceKeyStatus;
  readonly publishedAt: Date;
  readonly activatedAt: Date | null;
  readonly demotedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly note: string | null;
}

export class KeyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyRegistryError";
  }
}

/**
 * How long a newly published key must be visible in the JWKS before it may start
 * signing.
 *
 * The ERP caches the key set for 5 minutes by default and refreshes on a poller.
 * It does refetch when it meets an unknown kid — rate-limited to once per 10
 * seconds — so activating early is usually survivable rather than fatal. "Usually"
 * is the problem: that refetch can fail, and a failed refetch keeps the stale set,
 * which turns a rotation into a 401 storm with no self-healing until the next
 * successful poll. Waiting out one cache period costs nothing and removes the
 * window entirely.
 */
export const DEFAULT_PROPAGATION_SECONDS = 360;

export class KeyNotPropagatedError extends KeyRegistryError {
  constructor(kid: string, waitedSeconds: number, requiredSeconds: number) {
    super(
      `key ${kid} was published ${waitedSeconds}s ago; it may not sign until ${requiredSeconds}s have passed. ` +
        `Verifiers cache the JWKS, and signing with a key they have not fetched yet produces 401s ` +
        `(credential_not_found) for every request until their next successful refresh.`,
    );
    this.name = "KeyNotPropagatedError";
  }
}

export class KeyStillTrustedError extends KeyRegistryError {
  constructor(kid: string, sinceSeconds: number, requiredSeconds: number) {
    super(
      `key ${kid} stopped signing ${sinceSeconds}s ago; it may not be retired until ${requiredSeconds}s have passed. ` +
        `Tokens it signed are valid for up to the token TTL, and retiring it removes it from the JWKS — ` +
        `which would invalidate tokens already in flight.`,
    );
    this.name = "KeyStillTrustedError";
  }
}

/**
 * The published key set, and the lifecycle rules around it.
 *
 * Three states, and the two transitions that matter are both time-gated:
 *
 *   published --(activate: only after the JWKS has propagated)--> active
 *   active    --(demoted by the next activation)-->               published
 *   published --(retire: only after every token it signed expired)--> retired
 *
 * Both gates exist because the failure they prevent is invisible at the moment you
 * cause it: nothing goes wrong when you activate a key too early or retire one too
 * soon — it goes wrong on the next ERP call, as a 401, which reads like an auth
 * bug rather than a rotation mistake.
 *
 * Platform-wide, not tenant-scoped: one key set signs for every tenant, and what
 * confines a token to a tenant is its `tenant_id` claim.
 */
export class PostgresServiceKeyRegistry {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(opts: { readonly pool: Pool; readonly now?: () => Date }) {
    this.pool = opts.pool;
    this.now = opts.now ?? ((): Date => new Date());
  }

  /** Publishes a public key. Idempotent on kid, so a repeated rotation step is safe. */
  async publish(publicJwkX: string, note?: string): Promise<string> {
    const kid = jwkThumbprint(publicJwkX);
    await this.pool.query(
      `INSERT INTO crm.service_key (kid, public_jwk_x, status, published_at, note)
       VALUES ($1, $2, 'published', $3, $4)
       ON CONFLICT (kid) DO NOTHING`,
      [kid, publicJwkX, this.now(), note ?? null],
    );
    return kid;
  }

  /**
   * Promotes a published key to the signing key, demoting the incumbent.
   *
   * One transaction: a window with two active keys would break the "at most one"
   * index, and a window with none would leave the scheduler unable to find a key.
   */
  async activate(kid: string, opts: { readonly propagationSeconds?: number } = {}): Promise<void> {
    const required = opts.propagationSeconds ?? DEFAULT_PROPAGATION_SECONDS;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ status: ServiceKeyStatus; published_at: Date }>(
        `SELECT status, published_at FROM crm.service_key WHERE kid = $1 FOR UPDATE`,
        [kid],
      );
      const row = rows[0];
      if (row === undefined) throw new KeyRegistryError(`no key ${kid}`);
      if (row.status === "retired") {
        throw new KeyRegistryError(`key ${kid} is retired; retirement is terminal — generate a new key`);
      }
      if (row.status === "active") {
        await client.query("COMMIT");
        return; // already the signing key
      }

      const now = this.now();
      const waited = Math.floor((now.getTime() - row.published_at.getTime()) / 1000);
      if (waited < required) throw new KeyNotPropagatedError(kid, waited, required);

      await client.query(
        `UPDATE crm.service_key SET status = 'published', demoted_at = $1 WHERE status = 'active'`,
        [now],
      );
      await client.query(
        `UPDATE crm.service_key SET status = 'active', activated_at = $1, demoted_at = NULL WHERE kid = $2`,
        [now, kid],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Removes a key from the JWKS. Terminal.
   *
   * `tokenTtlSeconds` is the longest a token signed by this key can still be
   * valid; the default is the maximum the minter will ever issue, so the caller
   * has to opt into a shorter wait rather than accidentally getting one.
   */
  async retire(kid: string, opts: { readonly tokenTtlSeconds?: number } = {}): Promise<void> {
    const required = opts.tokenTtlSeconds ?? MAX_TTL_SECONDS;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        status: ServiceKeyStatus;
        activated_at: Date | null;
        demoted_at: Date | null;
      }>(`SELECT status, activated_at, demoted_at FROM crm.service_key WHERE kid = $1 FOR UPDATE`, [kid]);
      const row = rows[0];
      if (row === undefined) throw new KeyRegistryError(`no key ${kid}`);
      if (row.status === "retired") {
        await client.query("COMMIT");
        return;
      }
      if (row.status === "active") {
        throw new KeyRegistryError(
          `key ${kid} is the signing key. Activate its replacement first — retiring the only ` +
            `signing key stops every ERP call.`,
        );
      }

      const now = this.now();
      // A key that never signed has nothing in flight to protect.
      if (row.activated_at !== null) {
        const since = Math.floor((now.getTime() - (row.demoted_at ?? row.activated_at).getTime()) / 1000);
        if (since < required) throw new KeyStillTrustedError(kid, since, required);
      }

      await client.query(`UPDATE crm.service_key SET status = 'retired', retired_at = $1 WHERE kid = $2`, [now, kid]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** What the JWKS endpoint publishes: everything not retired, newest first. */
  async verifiableKeys(): Promise<readonly PublishedKey[]> {
    const { rows } = await this.pool.query<{ kid: string; public_jwk_x: string }>(
      `SELECT kid, public_jwk_x FROM crm.service_key
        WHERE status <> 'retired'
        ORDER BY published_at DESC, kid`,
    );
    return rows.map((r) => ({ kid: r.kid, x: r.public_jwk_x }));
  }

  async activeKey(): Promise<ServiceKeyRow | null> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT kid, public_jwk_x, status, published_at, activated_at, demoted_at, retired_at, note
         FROM crm.service_key WHERE status = 'active'`,
    );
    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  async list(): Promise<readonly ServiceKeyRow[]> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT kid, public_jwk_x, status, published_at, activated_at, demoted_at, retired_at, note
         FROM crm.service_key ORDER BY published_at DESC, kid`,
    );
    return rows.map(toRow);
  }

  /**
   * The boot check: is this signer's key one the ERP will accept?
   *
   * A signer whose key is absent or retired produces tokens that every verifier
   * rejects with `credential_not_found`. That is indistinguishable at the call
   * site from the ERP being misconfigured, and it is worth a dozen 401s less than
   * refusing to start. A key that is published but not active is allowed through
   * with a warning: it is in the JWKS, so its tokens verify — this is the ordinary
   * state of a process still running from before a rotation.
   */
  async checkSignerKey(kid: string): Promise<{ readonly ok: true; readonly warning: string | null }> {
    const { rows } = await this.pool.query<{ status: ServiceKeyStatus }>(
      `SELECT status FROM crm.service_key WHERE kid = $1`,
      [kid],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new KeyRegistryError(
        `the signing key ${kid} is not in crm.service_key, so it is not published in the JWKS. ` +
          `Every token it signs would be rejected with credential_not_found. ` +
          `Publish it (crm-service-key publish) before starting.`,
      );
    }
    if (row.status === "retired") {
      throw new KeyRegistryError(
        `the signing key ${kid} is retired and no longer published in the JWKS. ` +
          `Load the current key, or generate and activate a new one.`,
      );
    }
    return {
      ok: true,
      warning:
        row.status === "published"
          ? `the signing key ${kid} is published but not active; its tokens verify, but a rotation is in progress`
          : null,
    };
  }
}

interface RawRow {
  kid: string;
  public_jwk_x: string;
  status: ServiceKeyStatus;
  published_at: Date;
  activated_at: Date | null;
  demoted_at: Date | null;
  retired_at: Date | null;
  note: string | null;
}

function toRow(r: RawRow): ServiceKeyRow {
  return {
    kid: r.kid,
    publicJwkX: r.public_jwk_x,
    status: r.status,
    publishedAt: r.published_at,
    activatedAt: r.activated_at,
    demotedAt: r.demoted_at,
    retiredAt: r.retired_at,
    note: r.note,
  };
}
