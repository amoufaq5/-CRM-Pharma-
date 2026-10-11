#!/usr/bin/env node
/**
 * A real SMTP server on loopback, for the live gate, in a process of its own.
 *
 * WHY A SEPARATE PROCESS. The gate's subject is the DEPLOYED scheduler binary, which is a
 * different process from this script — so the relay it connects to has to be reachable over
 * TCP rather than be an object in the same heap. That is also what makes the evidence worth
 * having: the bytes cross a socket between two processes, and what lands here is what the
 * binary actually sent.
 *
 * The sink is `@crm/notify`'s own (`testing-smtp.ts`), imported from `dist` rather than
 * through the package barrel because that module is deliberately not re-exported — it is a
 * test double, and the one test helper this repo publishes does it through its own subpath.
 * Reaching into `dist` from a gate script is the honest way to use it without making it part
 * of the public surface.
 *
 * Prints one JSON line with the port it bound, so the shell can read it rather than guess —
 * the port is OS-assigned (0) so a concurrent run cannot collide. On SIGTERM it writes
 * everything it received to the file named on the command line and exits 0, which is how the
 * gate inspects the mail after the binary has stopped.
 *
 * Usage: node scripts/live-erp/smtp-sink.mjs <messages.json>
 */
import { writeFileSync } from "node:fs";

import { startSmtpSink } from "../../packages/notify/dist/testing-smtp.js";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: smtp-sink.mjs <messages.json>");
  process.exit(2);
}

// PLAINTEXT ON LOOPBACK, which `assertUsableRelay` permits and permits only here: a
// plaintext relay to a remote host is refused at construction, because a notification
// carries a rep's name and an account id. 8BITMIME is advertised so a non-ASCII display
// name goes out as 8bit rather than base64, which keeps what lands here readable.
//
// AUTH IS DEMANDED when credentials are in the environment, rather than merely offered. The
// difference is the whole reason to ask for it in a gate: a sink that offers AUTH and accepts
// an unauthenticated MAIL FROM would pass whether or not the binary read the secret the
// endpoint names, which is the plumbing under test.
const user = process.env["SINK_AUTH_USER"];
const pass = process.env["SINK_AUTH_PASS"];
const auth =
  user === undefined || pass === undefined
    ? {}
    : { advertiseAuth: ["PLAIN"], requireAuth: true, credentials: { username: user, password: pass } };
const sink = await startSmtpSink({ advertise8BitMime: true, ...auth });

const dump = () => {
  writeFileSync(
    out,
    JSON.stringify(
      {
        port: sink.port,
        transcript: sink.transcript,
        messages: sink.messages.map((m) => ({
          mailFrom: m.mailFrom,
          rcptTo: m.rcptTo,
          subject: m.headers["subject"] ?? null,
          to: m.headers["to"] ?? null,
          deliveryId: m.headers["x-crm-delivery"] ?? null,
          body: m.body,
        })),
      },
      null,
      2,
    ),
  );
};

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    dump();
    void sink.close().then(() => process.exit(0));
  });
}

console.log(JSON.stringify({ type: "smtp_sink_listening", host: sink.host, port: sink.port }));
