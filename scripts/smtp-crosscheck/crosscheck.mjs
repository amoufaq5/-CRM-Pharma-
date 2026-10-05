// Cross-check the CRM's SMTP client against aiosmtpd — an INDEPENDENT server.
//
// WHY. `smtp.contract.test.ts` verifies the client against `testing-smtp.ts`, a sink in
// the same package written by the same hand. That is the right default — it needs no
// dependency and runs in CI — but it cannot see a mistake the client and the sink make
// TOGETHER, which is a real class of bug for a wire protocol and was called out as a
// limitation when the sender landed.
//
// aiosmtpd is a maintained third-party implementation with no knowledge of our
// assumptions: it parses the message, un-stuffs the dots itself, and Python's `email`
// module decodes the RFC 2047 subject. So the checks below are the OTHER
// implementation's verdict on our output, not ours.
//
// Not a vitest test, because it needs a Python package this repo does not declare and CI
// must not depend on one. `scripts/crosscheck-smtp.sh` runs it and skips cleanly when the
// dependency is absent — the same arrangement the TLS tests use for openssl.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SmtpSender } from "../../packages/notify/dist/smtp.js";

const PY = process.env.SMTP_CROSSCHECK_PYTHON ?? "python3";
const SRV = new URL("server.py", import.meta.url).pathname;

function startServer(args = []) {
  const p = spawn(PY, [SRV, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const messages = [];
  let buf = "";
  const ready = new Promise((res, rej) => {
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.port !== undefined) res(o.port);
        if (o.message !== undefined) messages.push(o.message);
      }
    });
    p.stderr.on("data", (d) => { if (/Traceback/.test(d.toString())) rej(new Error(d.toString())); });
    setTimeout(() => rej(new Error("server did not report a port")), 10000);
  });
  return { proc: p, ready, messages };
}

const payload = (over = {}) => ({
  deliveryId: randomUUID(), notificationId: randomUUID(), tenantId: randomUUID(),
  kind: "disposal_obligation_overdue", severity: "urgent",
  subject: "Expired stock still in your bag", body: "Lot LOT-7 expired on 2026-01-31.",
  recipient: { repProfileId: randomUUID(), displayName: "Omar the Rep" },
  subjectRef: { table: "crm.disposal_obligation", id: randomUUID() },
  payload: { lotNumber: "LOT-7" }, createdAt: new Date().toISOString(), ...over,
});
const endpoint = { id: randomUUID(), url: "mailto:ops@example.test", secretEnv: "CRM_SMTP_PASSWORD" };

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ---- 1. a plain send against an independent server -------------------------
{
  const s = startServer();
  const port = await s.ready;
  const sender = new SmtpSender({
    relay: { host: "127.0.0.1", port, transport: "plaintext", from: "crm@example.test" },
    env: {},
  });
  const out = await sender.send(payload(), endpoint);
  await new Promise((r) => setTimeout(r, 300));
  check("delivered to aiosmtpd", out.kind === "delivered", `outcome=${out.kind} ${out.error ?? ""}`);
  const m = s.messages[0];
  check("the server received exactly one message", s.messages.length === 1, `got ${s.messages.length}`);
  check("envelope sender and recipient are right",
    m?.mail_from === "crm@example.test" && m?.rcpt_tos?.[0] === "ops@example.test",
    `${m?.mail_from} -> ${JSON.stringify(m?.rcpt_tos)}`);
  check("the body survived", (m?.raw ?? "").includes("Lot LOT-7 expired on 2026-01-31."));
  s.proc.kill();
}

// ---- 2. dot-stuffing, judged by the other implementation -------------------
{
  const s = startServer();
  const port = await s.ready;
  const sender = new SmtpSender({
    relay: { host: "127.0.0.1", port, transport: "plaintext", from: "crm@example.test" }, env: {},
  });
  const body = ["before", ".", "after the dot", "..", "trailer that must survive"].join("\n");
  const out = await sender.send(payload({ body }), endpoint);
  await new Promise((r) => setTimeout(r, 300));
  const raw = s.messages[0]?.raw ?? "";
  check("dot-stuffed send accepted", out.kind === "delivered", out.error ?? "");
  // aiosmtpd un-stuffs on its own. If the client stuffed wrongly the message would have
  // been truncated at the lone dot and the trailer would be missing.
  check("a lone '.' line did not truncate the message", raw.includes("trailer that must survive"));
  // Judged IN CONTEXT, not by "a dot appears somewhere": the body must read back as the
  // exact five lines that went in. aiosmtpd un-stuffed them, so this is the other
  // implementation's verdict on our stuffing, which is the entire point of this script.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const at = lines.indexOf("before");
  const roundTripped = lines.slice(at, at + 5);
  check("the five body lines round-trip through the other implementation exactly",
    JSON.stringify(roundTripped) === JSON.stringify(["before", ".", "after the dot", "..", "trailer that must survive"]),
    JSON.stringify(roundTripped));
  s.proc.kill();
}

// ---- 3. an Arabic subject, decoded by the other implementation -------------
{
  const s = startServer();
  const port = await s.ready;
  const sender = new SmtpSender({
    relay: { host: "127.0.0.1", port, transport: "plaintext", from: "crm@example.test" }, env: {},
  });
  const subject = "عاجل: مخزون منتهي الصلاحية";
  const out = await sender.send(payload({ subject }), endpoint);
  await new Promise((r) => setTimeout(r, 300));
  const raw = s.messages[0]?.raw ?? "";
  check("non-ASCII subject accepted", out.kind === "delivered", out.error ?? "");
  check("subject went out RFC 2047 encoded, not raw 8-bit", /=\?UTF-8\?B\?/i.test(raw));
  // Decode it the way a real MUA would, with Python's own email parser.
  const { spawnSync } = await import("node:child_process");
  const dec = spawnSync(PY, ["-c", `
import sys, email
from email.header import decode_header, make_header
m = email.message_from_string(sys.stdin.read())
print(str(make_header(decode_header(m['Subject']))))`], { input: raw, encoding: "utf8" });
  check("Python's email parser decodes the subject back exactly",
    dec.stdout.trim() === subject, JSON.stringify(dec.stdout.trim()));
  s.proc.kill();
}

// ---- 4. AUTH LOGIN against the other implementation ------------------------
{
  const s = startServer(["--auth"]);
  const port = await s.ready;
  const good = new SmtpSender({
    relay: { host: "127.0.0.1", port, transport: "plaintext", from: "crm@example.test", username: "crmuser" },
    env: { CRM_SMTP_PASSWORD: "s3cret-pass" },
  });
  const out = await good.send(payload(), endpoint);
  await new Promise((r) => setTimeout(r, 300));
  check("AUTH succeeds and the message lands", out.kind === "delivered" && s.messages.length === 1,
    `outcome=${out.kind} ${out.error ?? ""}`);

  const bad = new SmtpSender({
    relay: { host: "127.0.0.1", port, transport: "plaintext", from: "crm@example.test", username: "crmuser" },
    env: { CRM_SMTP_PASSWORD: "wrong" },
  });
  const outBad = await bad.send(payload(), endpoint);
  check("a wrong password is DEAD, not retried forever", outBad.kind === "dead",
    `outcome=${outBad.kind} ${outBad.error ?? ""}`);
  s.proc.kill();
}

// ---- 5. a missing secret must not open a socket ----------------------------
{
  const sender = new SmtpSender({
    relay: { host: "127.0.0.1", port: 1, transport: "plaintext", from: "crm@example.test", username: "crmuser" },
    env: {},
  });
  const out = await sender.send(payload(), endpoint);
  check("a missing password is dead before any connection", out.kind === "dead",
    `outcome=${out.kind} ${out.error ?? ""}`);
}

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed against aiosmtpd`);
process.exit(failed.length === 0 ? 0 : 1);
