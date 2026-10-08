// Serves apps/field/dist and proxies the API, from ONE origin.
//
// This is what `deploy/Caddyfile` does in production, and it is not a convenience for the
// test: same-origin is the reason this client needs no CORS and the API has none. A
// harness that served the app on a second port would be verifying an arrangement nobody
// deploys, and would pass while the real one failed on a preflight.
//
// Usage: node serve.mjs <dist-dir> <api-base-url> [port]
//        prints `serving on <port>` once listening.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "apps/field/dist");
const apiBase = (process.argv[3] ?? "").replace(/\/$/, "");
const port = Number(process.argv[4] ?? 0);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

// The same split the Caddyfile makes: these prefixes are the API, everything else is the
// app's own files.
const isApi = (path) => path.startsWith("/v1/") || path === "/healthz" || path.startsWith("/.well-known/");

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Collapse repeated slashes before routing. `//v1/accounts` is the same resource as
    // `/v1/accounts` to any real proxy, and treating it as an app path served the shell
    // — a 200 of HTML where the API would have answered 401, which is exactly the shape
    // of mistake this harness exists to catch.
    const path = url.pathname.replace(/\/{2,}/g, "/");

    if (isApi(path)) {
      if (apiBase === "") {
        res.writeHead(502).end("no API base url given to the static server");
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (["host", "connection", "content-length"].includes(k)) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      try {
        const upstream = await fetch(`${apiBase}${path}${url.search}`, {
          method: req.method,
          headers,
          ...(body.length > 0 ? { body } : {}),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      } catch (err) {
        res.writeHead(502).end(String(err));
      }
      return;
    }

    const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
    const file = join(dist, rel);
    if (!file.startsWith(dist)) {
      res.writeHead(403).end("no");
      return;
    }
    try {
      await stat(file);
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        // The service worker must be allowed to control the root scope.
        ...(rel === "sw.js" ? { "service-worker-allowed": "/" } : {}),
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      // A single-page app: anything unknown is the shell, so a deep link works.
      try {
        const shell = await readFile(join(dist, "index.html"));
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" }).end(shell);
      } catch {
        res.writeHead(404).end("not found");
      }
    }
  })();
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`serving on ${typeof address === "object" && address !== null ? address.port : port}`);
});
