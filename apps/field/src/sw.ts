/// <reference lib="webworker" />

/**
 * The offline shell. Cache the app's own files; never cache the API.
 *
 * That division is the whole design. A stale JS bundle is an inconvenience; a stale
 * ANSWER is a lie — an account list from last week rendered as if it were live, or worse,
 * a cached 200 standing in for a visit the server never received. So `/v1/*` is always
 * network, and when the network is gone the request fails and the app says so, because
 * the app has its own cache with a timestamp on it and can tell the rep how old it is.
 *
 * Cache-first for the shell, so opening the app in a lift is instant and works. The
 * version in the cache name is what retires an old shell: a new bundle gets a new name,
 * the old one is deleted on activate, and nothing serves half of each.
 */
/**
 * `self` is already declared by lib.webworker as a WorkerGlobalScope, so re-declaring it
 * as a ServiceWorkerGlobalScope is an error and declaring it under lib.dom instead
 * quietly degrades every event to a bare `Event` — which typechecks while
 * `event.respondWith` does not exist. One narrowing, named, and the handlers below get
 * their real event types from it.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = "v1";
const SHELL = `crm-field-shell-${VERSION}`;
const SHELL_FILES = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest", "./icon.svg"];

sw.addEventListener("install", (event) => {
  // config.json is deliberately NOT precached: it is deployment configuration, read with
  // `cache: "no-store"`, and a cached copy would pin an app to an old API URL or a
  // retired issuer.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(SHELL_FILES);
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("crm-field-shell-") && name !== SHELL) await caches.delete(name);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Anything that is not this app's own origin and path is the API or a third party:
  // left alone entirely, so no answer is ever served from a cache.
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz" || url.pathname.startsWith("/.well-known/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached !== undefined) {
        // Refresh in the background so the next open has the new bundle, without making
        // this open wait for a network that may not be there.
        void fetch(request)
          .then((fresh) => (fresh.ok ? cache.put(request, fresh.clone()) : undefined))
          .catch(() => undefined);
        return cached;
      }
      try {
        const fresh = await fetch(request);
        if (fresh.ok && url.pathname !== "/config.json") await cache.put(request, fresh.clone());
        return fresh;
      } catch {
        // A navigation with nothing cached: hand back the shell so the app can boot and
        // explain itself, rather than the browser's offline page.
        const fallback = await cache.match("./index.html");
        if (request.mode === "navigate" && fallback !== undefined) return fallback;
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    })(),
  );
});
