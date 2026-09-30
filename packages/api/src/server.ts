import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Pool } from "pg";

import { buildRouter, type HandlerDeps } from "./handlers/routes.js";
import { JwksCache, verifyJwt, type JwksKey } from "./jwt.js";
import { resolvePrincipal, type Principal } from "./principal.js";
import { unauthenticated } from "./problems.js";
import { dispatch, type RequestContext } from "./router.js";

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  /** A JWKS endpoint, or a fixed key set for tests and for an offline deployment. */
  readonly jwks: JwksCache | readonly JwksKey[];
  readonly now?: () => number;
}

export interface ApiServerOptions extends HandlerDeps {
  readonly auth: AuthConfig;
  readonly onError?: (err: unknown, ctx: { correlationId: string; path: string }) => void;
}

function bearer(headers: RequestContext<null>["headers"]): string {
  const raw = headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^Bearer /i.test(value)) {
    throw unauthenticated("expected an Authorization: Bearer <token> header");
  }
  return value.slice(7).trim();
}

/**
 * Builds the request handler: verify the token, resolve the rep, dispatch.
 *
 * The two steps are separate on purpose. Verification proves the token is
 * genuine; resolution decides whether that identity is a rep in this tenant, and
 * refuses a suspended one. A genuine token from the right IdP is NOT by itself
 * authorisation — which is the entire reason the CRM authorises rather than
 * delegating to the ERP, whose row-level scoping does not exist (report R2).
 */
export function buildRequestListener(options: ApiServerOptions) {
  const router = buildRouter(options);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await dispatch<Principal>(req, res, {
      router,
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      authenticate: async (ctx) => {
        const token = bearer(ctx.headers);

        // The kid is read from the unverified header ONLY to select a key. Its
        // claims are still untrusted until the signature checks out.
        const kid = ((): string | undefined => {
          try {
            const header = JSON.parse(
              Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
            ) as { kid?: unknown };
            return typeof header.kid === "string" ? header.kid : undefined;
          } catch {
            return undefined;
          }
        })();

        const keys =
          options.auth.jwks instanceof JwksCache
            ? await options.auth.jwks.get(kid)
            : options.auth.jwks;

        let claims;
        try {
          claims = verifyJwt(token, {
            issuer: options.auth.issuer,
            audience: options.auth.audience,
            keys,
            ...(options.auth.now !== undefined ? { now: options.auth.now } : {}),
          });
        } catch (err) {
          // The reason is echoed because it is diagnostic, not sensitive: a
          // client that cannot tell an expired token from a wrong audience will
          // retry the wrong thing forever.
          throw unauthenticated((err as Error).message);
        }

        const header = ctx.headers["x-tenant-id"];
        const tenantHint = Array.isArray(header) ? (header[0] ?? null) : (header ?? null);

        const client = await options.pool.connect();
        try {
          return await resolvePrincipal(client, claims, tenantHint);
        } finally {
          client.release();
        }
      },
    });
  };
}

export interface RunningApi {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startApi(options: ApiServerOptions & { port?: number }): Promise<RunningApi> {
  const listener = buildRequestListener(options);
  const server = createServer((req, res) => {
    void listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve())),
      ),
  };
}

export type { Pool };
