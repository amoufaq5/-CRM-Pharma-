import type { TenantCredential } from "@crm/acl";

import type { ServiceRoleSource } from "./role-source.js";
import type { ServiceKeySigner } from "./signer.js";
import { DEFAULT_TTL_SECONDS, mintServiceToken, MIN_TTL_SECONDS, ServiceTokenError } from "./token.js";

/**
 * How long before expiry a cached token is replaced.
 *
 * Must comfortably exceed the ERP client's own request timeout (15s), or a token
 * handed out at the edge of the margin could expire while the request it was
 * minted for is still in flight — producing an `expired_token` 401 on a token that
 * was valid when it was issued, which is a maddening thing to debug.
 */
export const DEFAULT_REFRESH_MARGIN_SECONDS = 60;
export const MIN_REFRESH_MARGIN_SECONDS = 30;

export interface ServiceCredentialOptions {
  readonly signer: ServiceKeySigner;
  readonly roles: ServiceRoleSource;
  /** Must equal the ERP's `--jwt-issuer`. */
  readonly issuer: string;
  /** Must equal the ERP's `--jwt-audience`. */
  readonly audience: string;
  readonly ttlSeconds?: number;
  readonly refreshMarginSeconds?: number;
  /** Overridden per tenant by `crm.erp_service_principal.subject`. */
  readonly subjectPrefix?: string;
  readonly now?: () => number;
  readonly onMint?: (event: MintEvent) => void;
}

export interface MintEvent {
  readonly tenantId: string;
  readonly kid: string;
  readonly role: string;
  readonly jti: string;
  readonly expiresAtSeconds: number;
}

/** The default JWT `sub` prefix; the tenant id is appended. */
export const DEFAULT_SUBJECT_PREFIX = "crm-service";

/**
 * The CRM's ERP credential: one short-lived Ed25519 service token per tenant,
 * minted on demand and cached until shortly before it expires.
 *
 * This is what replaces `--api-key` (ADR-0001 item 10). A static API key is passed
 * as argv — visible in `ps` — held in memory for the process's life, and rotated
 * only by restarting the ERP. All three go away here: the token lives minutes, the
 * key that signs it never appears in an argument, and rotation is a database row
 * plus a new secret.
 *
 * It satisfies `TenantCredential` structurally, which is why it can be handed
 * straight to `ErpClient`. The import is for the compile-time check, not for
 * behaviour.
 */
export class ServiceCredential implements TenantCredential {
  private readonly opts: ServiceCredentialOptions;
  private readonly ttl: number;
  private readonly margin: number;
  private readonly subjectPrefix: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, { readonly token: string; readonly expiresAtSeconds: number }>();
  /** One mint per tenant at a time: a burst of ERP calls must not mint a token each. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(opts: ServiceCredentialOptions) {
    this.opts = opts;
    this.ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.margin = opts.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    this.subjectPrefix = opts.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX;
    this.now = opts.now ?? ((): number => Date.now());

    if (this.margin < MIN_REFRESH_MARGIN_SECONDS) {
      throw new ServiceTokenError(
        `refreshMarginSeconds must be at least ${MIN_REFRESH_MARGIN_SECONDS}; got ${this.margin}. ` +
          `A margin below the ERP client's request timeout lets a token expire mid-request.`,
      );
    }
    // A margin at or above the TTL would re-mint on every call, which is not an
    // error the type system can catch and is very easy to configure by accident
    // while tuning the TTL down.
    if (this.margin >= this.ttl) {
      throw new ServiceTokenError(
        `refreshMarginSeconds (${this.margin}) must be less than ttlSeconds (${this.ttl}), ` +
          `or every call mints a new token`,
      );
    }
    if (this.ttl < MIN_TTL_SECONDS) {
      throw new ServiceTokenError(`ttlSeconds must be at least ${MIN_TTL_SECONDS}; got ${this.ttl}`);
    }
  }

  async token(tenantId: string): Promise<string> {
    const key = tenantId.toLowerCase();
    const nowSeconds = Math.floor(this.now() / 1000);

    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAtSeconds - this.margin > nowSeconds) return cached.token;

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const minting = this.mint(key, tenantId, nowSeconds).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, minting);
    return minting;
  }

  private async mint(key: string, tenantId: string, nowSeconds: number): Promise<string> {
    // Resolved per mint rather than per process: disabling a tenant's row takes
    // effect within one token lifetime, with no restart.
    const resolved = await this.opts.roles.roleFor(tenantId);
    const minted = await mintServiceToken(this.opts.signer, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      tenantId,
      role: resolved.role,
      subject: resolved.subject ?? `${this.subjectPrefix}:${tenantId}`,
      ttlSeconds: this.ttl,
      nowSeconds,
    });
    this.cache.set(key, { token: minted.token, expiresAtSeconds: minted.expiresAtSeconds });
    this.opts.onMint?.({
      tenantId,
      kid: minted.kid,
      role: resolved.role,
      jti: minted.jti,
      expiresAtSeconds: minted.expiresAtSeconds,
    });
    return minted.token;
  }

  /**
   * Drops cached tokens.
   *
   * Note what this does NOT do: a token already issued stays valid at the ERP until
   * it expires. There is no revocation list — that is the trade short lifetimes buy,
   * and the reason the TTL is minutes rather than hours.
   */
  forget(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId.toLowerCase());
  }

  /** Cached tenants and their expiries, for the scheduler's status log. */
  cached(): ReadonlyArray<{ readonly tenantId: string; readonly expiresAtSeconds: number }> {
    return [...this.cache.entries()].map(([tenantId, v]) => ({ tenantId, expiresAtSeconds: v.expiresAtSeconds }));
  }
}
