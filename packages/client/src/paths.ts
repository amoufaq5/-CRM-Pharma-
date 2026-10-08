/**
 * Which paths are the API's, declared ONCE.
 *
 * Four things need this answer and three of them are code: the service worker, which must
 * never cache an API response; the harness's static server, which proxies them; the
 * Caddyfile, which does the same in production; and anything else that routes. Three
 * copies of a prefix list is three chances for one of them to be wrong, and the one that
 * matters most is the service worker — a stale bundle is an inconvenience, a stale ANSWER
 * is a lie, and the lie is silent.
 *
 * REPEATED SLASHES ARE COLLAPSED FIRST, and that is not pedantry. `apiBaseUrl: "/"` is a
 * plausible thing for an operator to write for "same origin, at the root", and it makes
 * every request `//v1/accounts` — which a `startsWith("/v1/")` check misses. The service
 * worker would then treat API responses as app files and cache them. The harness's own
 * static server had the same hole and answered 200 with the app shell where the API would
 * have answered 401, which is how this was noticed.
 *
 * The Caddyfile cannot import this, being Caddy configuration, so a test compares the two
 * rather than trusting them to agree.
 */
export const API_PATH_PREFIXES = ["/v1/", "/.well-known/"] as const;
export const API_PATHS_EXACT = ["/healthz"] as const;

/** `//v1//accounts` and `/v1/accounts` are the same resource to any proxy. */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/");
}

export function isApiPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    API_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    API_PATHS_EXACT.some((exact) => path === exact)
  );
}
