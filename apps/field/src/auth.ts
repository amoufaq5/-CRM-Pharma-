/**
 * OIDC authorization code + PKCE, in the browser, with no library.
 *
 * PKCE rather than a client secret because there is no secret a device can keep: an app
 * shipped to a phone or served as a PWA is a public client, and anything embedded in it
 * is readable by whoever holds the device. The code verifier is generated per login,
 * never leaves the device, and the authorization server will only exchange the code for
 * the verifier that hashes to the challenge it was given.
 *
 * What is deliberately NOT here: a password field. The API verifies a JWT against a JWKS
 * (RS256 or EdDSA) and never sees a credential, so this redirects to the issuer and back.
 * Which issuer is still ADR-0001's open question for Security; everything below is
 * issuer-agnostic and reads its endpoints from discovery.
 */
import { z } from "zod";

export const Discovery = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type Discovery = z.infer<typeof Discovery>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().int().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export interface AuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  /** Sent as the API's audience where the issuer supports it (Auth0, Entra). */
  readonly audience?: string | undefined;
}

export interface Session {
  readonly accessToken: string;
  /** Epoch ms. A token with no `expires_in` is treated as short-lived rather than
   * eternal: assuming the optimistic case here means every request after expiry is a
   * 401, and the queue pays for it. */
  readonly expiresAt: number;
  readonly refreshToken?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly subject?: string | undefined;
}

const VERIFIER_KEY = "crm.pkce.verifier";
const STATE_KEY = "crm.pkce.state";

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomVerifier(random: (into: Uint8Array) => void = (b) => crypto.getRandomValues(b)): string {
  const bytes = new Uint8Array(32);
  random(bytes);
  return base64Url(bytes);
}

/** S256, which is the only challenge method worth sending: `plain` offers no protection. */
/**
 * `Pick<…, "digest">` rather than `SubtleCrypto`, because the whole type does not travel:
 * Node's `webcrypto.subtle` and the DOM's declare different overloads (Ed25519 among
 * them) and are not assignable to each other. The function digests; that is all it needs
 * to be handed, and it lets a test pass Node's implementation without a cast.
 */
export type Digester = Pick<SubtleCrypto, "digest">;

export async function challengeFor(verifier: string, subtle: Digester = crypto.subtle): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery failed: HTTP ${response.status}`);
  return Discovery.parse(await response.json());
}

export interface AuthStorage {
  get(key: string): string | null;
  set(key: string, value: string): void
  remove(key: string): void;
}

/** `sessionStorage` by default: a verifier must not outlive the tab that made it. */
export function sessionStorageAuth(): AuthStorage {
  return {
    get: (k) => {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        /* a private window with storage blocked still gets to attempt a login */
      }
    },
    remove: (k) => {
      try {
        sessionStorage.removeItem(k);
      } catch {
        /* nothing to undo */
      }
    },
  };
}

export async function beginLogin(
  config: AuthConfig,
  deps: {
    readonly storage: AuthStorage;
    readonly fetchImpl?: typeof fetch | undefined;
    readonly random?: ((into: Uint8Array) => void) | undefined;
    readonly subtle?: Digester | undefined;
  },
): Promise<string> {
  const discovery = await discover(config.issuer, deps.fetchImpl ?? fetch);
  const verifier = randomVerifier(deps.random ?? ((b) => crypto.getRandomValues(b)));
  const state = randomVerifier(deps.random ?? ((b) => crypto.getRandomValues(b)));
  deps.storage.set(VERIFIER_KEY, verifier);
  deps.storage.set(STATE_KEY, state);

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await challengeFor(verifier, deps.subtle ?? crypto.subtle));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.audience !== undefined) url.searchParams.set("audience", config.audience);
  return url.toString();
}

export interface CallbackParams {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
  readonly errorDescription?: string | undefined;
}

export function readCallback(search: string): CallbackParams {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: CallbackParams = {
    ...(q.get("code") !== null ? { code: q.get("code") as string } : {}),
    ...(q.get("state") !== null ? { state: q.get("state") as string } : {}),
    ...(q.get("error") !== null ? { error: q.get("error") as string } : {}),
    ...(q.get("error_description") !== null ? { errorDescription: q.get("error_description") as string } : {}),
  };
  return out;
}

export async function completeLogin(
  config: AuthConfig,
  params: CallbackParams,
  deps: { readonly storage: AuthStorage; readonly fetchImpl?: typeof fetch | undefined; readonly now?: (() => number) | undefined },
): Promise<Session> {
  if (params.error !== undefined) {
    throw new Error(`the identity provider refused the login: ${params.errorDescription ?? params.error}`);
  }
  if (params.code === undefined) throw new Error("the callback carried no authorization code");

  const expectedState = deps.storage.get(STATE_KEY);
  // A mismatched state is the CSRF case: somebody else's code arriving at this redirect.
  // Refused outright rather than exchanged.
  if (expectedState === null || params.state !== expectedState) {
    throw new Error("the callback state did not match the one this device sent");
  }
  const verifier = deps.storage.get(VERIFIER_KEY);
  if (verifier === null) throw new Error("no PKCE verifier for this login — start again");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });

  const discovery = await discover(config.issuer, deps.fetchImpl ?? fetch);
  const response = await (deps.fetchImpl ?? fetch)(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const described = typeof payload === "object" && payload !== null && "error_description" in payload ? String((payload as { error_description: unknown }).error_description) : `HTTP ${response.status}`;
    throw new Error(`the token exchange failed: ${described}`);
  }
  const token = TokenResponse.parse(payload);

  deps.storage.remove(VERIFIER_KEY);
  deps.storage.remove(STATE_KEY);

  const now = (deps.now ?? Date.now)();
  // 60 seconds short, so a request is not sent with a token that expires in flight.
  const lifetime = token.expires_in ?? 300;
  return {
    accessToken: token.access_token,
    expiresAt: now + Math.max(0, lifetime - 60) * 1000,
    ...(token.refresh_token !== undefined ? { refreshToken: token.refresh_token } : {}),
    ...claimsOf(token.access_token),
  };
}

/**
 * The tenant and subject out of the access token, WITHOUT verifying it.
 *
 * Reading an unverified token is safe for exactly this: deciding which tenant header to
 * send and whose name to show. Nothing here grants anything — the API verifies the
 * signature itself and every row is behind RLS — so a forged token read here buys an
 * attacker a wrong label on their own screen and a 401 from the server.
 */
export function claimsOf(accessToken: string): { tenantId?: string; subject?: string } {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload: unknown = JSON.parse(atob((parts[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")));
    if (typeof payload !== "object" || payload === null) return {};
    const record = payload as Record<string, unknown>;
    const tenant = record["tenant"] ?? record["tenant_id"];
    return {
      ...(typeof tenant === "string" ? { tenantId: tenant } : {}),
      ...(typeof record["sub"] === "string" ? { subject: record["sub"] } : {}),
    };
  } catch {
    return {};
  }
}

export function isExpired(session: Session, now: number): boolean {
  return session.expiresAt <= now;
}
