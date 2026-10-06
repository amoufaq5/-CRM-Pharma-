// Serves the CRM's JWKS over HTTP for a live operate-server to fetch.
//
// It renders the document with @crm/credential's own `jwksResponse`, not with a
// hand-written object literal, because the thing under test is whether the bytes
// THAT function produces are the bytes the ERP's parser accepts. A literal here
// would verify the test's idea of a JWKS against the ERP and leave the shipped
// renderer untouched.
//
// Usage: node jwks-server.mjs <port> <jwk.json>   (jwk.json: {kid, x})
//        node jwks-server.mjs <port> --empty      (the no-key-published case)
//
// Port 0 binds an ephemeral port and the listening line names the one the kernel
// chose, so a second key set — the stand-in IdP that authenticates humans into the
// CRM's API — needs no third reserved port of its own.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { jwksResponse } from "../../packages/credential/dist/index.js";

const port = Number(process.argv[2]);
const source = process.argv[3];
const keys = source === "--empty" ? [] : [JSON.parse(readFileSync(source, "utf8"))];

let served = 0;

const server = createServer((req, res) => {
  // The fetch count is the evidence the ERP actually came and got the document
  // rather than being handed a key on its own command line. Served rather than
  // only logged, so the driver can assert on it.
  if (req.url === "/__count") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(String(served));
    return;
  }
  if (req.url !== "/.well-known/jwks.json") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
    return;
  }
  served += 1;
  const rendered = jwksResponse(keys);
  res.writeHead(rendered.status, rendered.headers);
  res.end(JSON.stringify(rendered.body));
});

server.listen(port, "127.0.0.1", () => {
  // The BOUND port, not the requested one: with 0 they differ, and the requested
  // one would send every later fetch to a socket nobody is holding.
  const bound = server.address();
  process.stdout.write(
    `jwks listening on ${typeof bound === "object" && bound !== null ? bound.port : port} (${keys.length} key(s))\n`,
  );
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    process.stdout.write(`jwks served ${served} request(s)\n`);
    server.close(() => process.exit(0));
  });
}
