// Drives the CRM's two SHIPPED BINARIES — `packages/api/dist/bin/api.js` and
// `packages/scheduler/dist/bin/scheduler.js` — against the running
// operate-server, and asserts what the processes did.
//
// WHY THIS EXISTS. `drive.mjs` imports the CRM's dist as a LIBRARY: it builds its
// own `OutboxRelay`, hands it a `ServiceCredential` it assembled itself, and calls
// `drainTenant` by hand. Everything that file proves is true of code the binaries
// import, and says nothing about the binaries — which are where the credential is
// resolved from the environment, where the per-tenant loop lives, where the ERP
// role is read out of `crm.erp_service_principal`, and where the one line an
// operator ever sees about a drain is written. ADR-0001's open table said exactly
// that: "the CRM's own `api` and `scheduler` binaries were not driven at the live
// ERP. The relay was driven directly."
//
// WHAT THE SHELL OWNS AND WHAT THIS FILE OWNS. The shell starts and stops both
// processes, exactly as it already does for operate-server and the JWKS endpoint,
// so a check that fails here cannot leak a listener — the trap is the only thing
// allowed to be responsible for that. This file never spawns a server. It makes
// HTTP requests, reads the CRM's and the ERP's state, and parses the log files the
// shell captured.
//
// Usage: node drive-binaries.mjs <phase> <workdir>
//   api-write    the API binary, authenticated, up to the outbox row it writes
//   drain        what the scheduler binary did with that row, and its log lines
//   role-setup   queues a second row for §12 (no assertions)
//   role         the ERP role came from the tenant's row, not the environment
//
// Each phase appends its own count to <workdir>/counts so the shell can report one
// total, and exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import pg from "pg";

import { LocalEd25519Signer, mintServiceToken } from "../../packages/credential/dist/index.js";
import { withTenantContext } from "../../packages/db/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const PHASE = process.argv[2];
const WORK = process.argv[3];
if (PHASE === undefined || WORK === undefined) {
  process.stderr.write("usage: drive-binaries.mjs <api-write|drain|role-setup|role> <workdir>\n");
  process.exit(2);
}

const ERP_BASE = process.env["ERP_BASE_URL"] ?? "http://127.0.0.1:8788";
const API_BASE = process.env["CRM_API_BASE_URL"];
const TENANT = process.env["LIVE_TENANT_ID"];
const ISSUER = process.env["LIVE_JWT_ISSUER"];
const AUDIENCE = process.env["LIVE_JWT_AUDIENCE"];
const KEY_PEM = process.env["LIVE_KEY_PEM"];
const KID = process.env["LIVE_KID"];
const ERP_ROLE = process.env["LIVE_ERP_ROLE"] ?? "erp_admin";

const STATE = `${WORK}/binaries.json`;

let failures = 0;
let checks = 0;

function ok(msg) {
  checks += 1;
  process.stdout.write(`ok: ${msg}\n`);
}

function fail(msg) {
  checks += 1;
  failures += 1;
  process.stdout.write(`FAIL: ${msg}\n`);
}

function expect(cond, msg, evidence) {
  if (cond) ok(evidence === undefined ? msg : `${msg} — ${evidence}`);
  else fail(evidence === undefined ? msg : `${msg} — got ${evidence}`);
}

function section(title) {
  process.stdout.write(`\n--- ${title} ---\n`);
}

function note(msg) {
  process.stdout.write(`    ${msg}\n`);
}

function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}

function saveState(patch) {
  writeFileSync(STATE, `${JSON.stringify({ ...loadState(), ...patch }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  host: process.env["CRM_PGHOST"] ?? process.env["PGHOST"] ?? "/var/run/postgresql",
  database: process.env["CRM_PGDATABASE"],
  user: process.env["CRM_PGUSER"] ?? "crm_app",
  password: process.env["CRM_PGPASSWORD"] ?? "crm_app",
  max: 4,
});

async function inCrm(fn) {
  const conn = await pool.connect();
  try {
    return await withTenantContext(conn, TENANT, fn);
  } finally {
    conn.release();
  }
}

/** A service token for READING the ERP back, through the shipped minter. */
async function erpToken() {
  const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(KEY_PEM, "utf8"));
  const { token } = await mintServiceToken(signer, {
    issuer: ISSUER,
    audience: AUDIENCE,
    tenantId: TENANT,
    role: "erp_admin",
    subject: `crm-service:${TENANT}`,
    ttlSeconds: 900,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  return token;
}

async function body(res) {
  const text = await res.text();
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    return text;
  }
}

async function erpGet(path) {
  const res = await fetch(`${ERP_BASE}${path}`, {
    headers: { authorization: `Bearer ${await erpToken()}`, "x-tenant-id": TENANT },
  });
  return { status: res.status, body: await body(res) };
}

/** A request to the CRM's OWN API binary. */
async function api(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.tenant !== undefined ? { "x-tenant-id": init.tenant } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: await body(res), contentType: res.headers.get("content-type") ?? "" };
}

/**
 * An IdP-issued human token.
 *
 * Through `human-token.mjs`, the same script the shell uses, so there is one
 * definition of what a login token looks like rather than two that can drift.
 */
function humanToken(args = []) {
  return execFileSync(process.execPath, [`${HERE}/human-token.mjs`, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

/** Reads a captured log file as the sequence of JSON objects it claims to be. */
function logLines(path) {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const parsed = [];
  const unparseable = [];
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (typeof v !== "object" || v === null || Array.isArray(v)) unparseable.push(line);
      else parsed.push(v);
    } catch {
      unparseable.push(line);
    }
  }
  return { lines, parsed, unparseable };
}

const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/** Records a receipt through the API, returning the ids its mirror will use. */
async function receiptThroughApi(token, quantity) {
  const movementId = randomUUID();
  const res = await api("/v1/samples/receipts", {
    method: "POST",
    token,
    body: {
      id: movementId,
      lotId: loadState().lotId,
      quantity,
      occurredAt: new Date().toISOString(),
      erpWarehouseId: "wh-1",
    },
  });
  return { movementId, targetRecordId: `crm-sm-${movementId}`, res };
}

async function outboxRow(targetRecordId) {
  return inCrm(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, entity, operation, target_record_id, state, attempts, payload,
              erp_response, dead_reason, last_error
         FROM crm.outbox WHERE tenant_id = $1 AND target_record_id = $2`,
      [TENANT, targetRecordId],
    );
    return rows[0];
  });
}

// ===========================================================================
// Every phase runs inside this try. An exception used to abort the phase
// mid-flight: the remaining checks were then neither `ok` nor `FAIL`, the count
// line was never printed, and nothing was appended to `counts` — so the gate's
// total quietly shrank while the shell reported only "reported failures". A
// throw is now a failure like any other, named and counted, and the count is
// written in the `finally` so the total is never short.
try {
if (PHASE === "api-write") {
  section("10. the API binary, authenticated against a JWKS, writing the only thing it writes");

  // 10a. Readiness, and not a formality: `/healthz` answers 503 `degraded` when the
  // process is connected as a role that bypasses RLS, and `withTenantContext`
  // refuses such a connection — so a 200 here is the binary's own statement that
  // every tenant-scoped route below CAN be served.
  const health = await api("/healthz");
  expect(
    health.status === 200 && health.body?.status === "ok",
    "the API binary reports itself ready, so it is connected as a role that does not bypass RLS",
    `${health.status} ${JSON.stringify(health.body)}`,
  );

  // 10b. The control for every acceptance below.
  const anon = await api("/v1/me");
  expect(
    anon.status === 401,
    "an unauthenticated GET /v1/me is refused 401, so acceptance below means something",
    String(anon.status),
  );

  // 10c. ADR-0001 item 10's two credential tiers "never mix", and here is the live
  // consequence: the Ed25519 key the ERP trusts for our service tokens does not
  // open our own API, because the two publish different key sets. Nothing in
  // production can produce this token — the scheduler holds that key and never
  // calls the API — which is why it is worth proving the door is shut.
  const crossTier = await api("/v1/me", { token: humanToken(["--service-key"]) });
  expect(
    crossTier.status === 401 && /no key|unknown/i.test(JSON.stringify(crossTier.body)),
    "a token signed by the ERP-facing SERVICE key is refused by the CRM's API — the two tiers do not mix",
    `${crossTier.status} ${JSON.stringify(crossTier.body).slice(0, 140)}`,
  );

  // 10d. The real handshake: an IdP token, verified against a JWKS this process
  // fetched over HTTP, resolved to a rep through `crm.rep_profile`.
  const token = humanToken();
  const me = await api("/v1/me", { token });
  expect(
    me.status === 200 && me.body?.displayName === "Ada Lovelace",
    "an IdP-signed token is verified against the fetched JWKS and resolves to a rep",
    `${me.status} ${JSON.stringify(me.body).slice(0, 160)}`,
  );
  expect(
    me.status === 200 && me.body?.erpEmployeeId === "emp-1",
    "and the principal carries the rep's ERP Employee id, the mapping ADR-0001 Q3 exists for",
    `erpEmployeeId=${JSON.stringify(me.body?.erpEmployeeId)}`,
  );

  // 10e. CONTROL for 10d: a cryptographically identical token for a subject with no
  // `rep_profile` row must get nothing. Without it, "the token was accepted" is
  // consistent with an API that accepts anything its IdP signed.
  const stranger = await api("/v1/me", { token: humanToken(["nobody-at-all"]) });
  expect(
    stranger.status === 403,
    "the same IdP signing a subject who is not a rep in this tenant gets 403, not a session",
    `${stranger.status} ${JSON.stringify(stranger.body).slice(0, 120)}`,
  );

  // 10f. The tenant fallback. `resolvePrincipal` takes the tenant from the claim
  // when the IdP issues one and from the header otherwise, and the header path is
  // the one nothing had driven through the binary.
  const viaHeader = await api("/v1/me", { token: humanToken(["rep-ada", "--no-tenant-claim"]), tenant: TENANT });
  expect(
    viaHeader.status === 200 && viaHeader.body?.repProfileId === me.body?.repProfileId,
    "a token with no tenant claim resolves the same rep from x-tenant-id",
    `${viaHeader.status} rep=${viaHeader.body?.repProfileId}`,
  );

  // 10g. THE JWKS THE ERP ACTUALLY VERIFIES AGAINST, served by the API binary out of
  // `crm.service_key`. Everything earlier in this gate was served by
  // `jwks-server.mjs`, a harness script calling `jwksResponse` directly. This is
  // the deployed arrangement: the API publishes the key set from the database and
  // holds no private key at all.
  const jwks = await api("/.well-known/jwks.json");
  const keys = Array.isArray(jwks.body?.keys) ? jwks.body.keys : [];
  expect(
    jwks.status === 200 && keys.some((k) => k.kid === KID && k.kty === "OKP" && k.crv === "Ed25519"),
    "the API binary publishes the service key set from crm.service_key, as the ERP would fetch it",
    `${jwks.status} kids=${keys.map((k) => k.kid).join(",")}`,
  );
  expect(
    keys.length > 0 && keys.every((k) => k.d === undefined && typeof k.x === "string"),
    "and no private half is in that document — a compromised API still cannot mint a token",
    `members=${[...new Set(keys.flatMap((k) => Object.keys(k)))].join(",")}`,
  );

  // 10h. THE ONE WRITE THAT CROSSES THE BOUNDARY. `POST /v1/samples/receipts` is the
  // only route in the API that writes `crm.outbox`: material leaving the warehouse
  // is the one sample movement the ERP needs to know about, and the mirrored
  // `StockMovement` is enqueued in the same transaction as the receipt.
  const { targetRecordId, res: receipt } = await receiptThroughApi(token, "12.000");
  expect(
    receipt.status === 201 && receipt.body?.erpMirrorEnqueued === true,
    "POST /v1/samples/receipts records the movement and enqueues its ERP mirror in one transaction",
    `${receipt.status} enqueued=${receipt.body?.erpMirrorEnqueued} state=${receipt.body?.erpMirror?.state}`,
  );

  const queued = await outboxRow(targetRecordId);
  expect(
    queued !== undefined &&
      queued.entity === "StockMovement" &&
      queued.operation === "create" &&
      queued.state === "pending",
    "and the queued row addresses the ERP entity by the CRM's own deterministic record id",
    `${queued?.entity}/${queued?.operation} target=${queued?.target_record_id} state=${queued?.state}`,
  );
  expect(
    queued?.payload?.movement_type === "issue",
    "with the inversion right: the CRM's receipt is the ERP's issue, the same event from the other side of the door",
    `movement_type=${queued?.payload?.movement_type} quantity=${queued?.payload?.quantity}`,
  );

  // 10i. THE FINDING, MADE INTO A CHECK. Nothing in the API reaches the ERP: it
  // constructs no `ErpClient`, opens no socket to it, and every read it serves
  // comes from a `crm.*` snapshot. So the boundary is crossed asynchronously, by
  // the scheduler, and until the scheduler runs the ERP has never heard of this
  // movement. If this ever answers 200, some route has grown a synchronous ERP
  // call and §11's chain stops proving what it says it proves.
  const notYet = await erpGet(`/v1/stock-movements/${targetRecordId}`);
  expect(
    notYet.status === 404,
    "the ERP has not heard of it yet — no API route crosses the boundary synchronously",
    `GET /v1/stock-movements/${targetRecordId} = ${notYet.status}`,
  );

  saveState({ targetRecordId, outboxId: queued?.id ?? null });
}

// ===========================================================================
if (PHASE === "drain") {
  section("11. the scheduler binary boots as production does, and drains that row to the live ERP");

  const state = loadState();
  const out = logLines(`${WORK}/sched.out`);

  // 11a. THE CREDENTIAL BOOT IS THE REAL ONE. The process read a PKCS#8 PEM from
  // the path `CRM_SIGNING_KEY_FILE` names — where deploy/docker-compose.yml mounts
  // it — checked the kid against `crm.service_key` itself, and built a signing
  // credential. Nothing handed it a token.
  const credential = out.parsed.find((l) => l.type === "credential");
  expect(
    credential?.kind === "signing" && credential?.kid === KID,
    "the scheduler built a SIGNING credential at boot from the key file, not a static token",
    `kind=${credential?.kind} kid=${credential?.kid}`,
  );

  // 11b. And the role in the token is the one `crm.erp_service_principal` holds for
  // THIS tenant, resolved by `PostgresServiceRoleSource` through
  // `withTenantContext` as crm_app. §12 is the control for it.
  const minted = out.parsed.filter((l) => l.type === "token_minted");
  const mint = minted[0];
  expect(
    mint !== undefined && mint.tenantId === TENANT && mint.role === ERP_ROLE && typeof mint.kid === "string",
    "it minted a per-tenant token under the ERP role resolved from crm.erp_service_principal",
    `mints=${minted.length} tenant=${mint?.tenantId} role=${mint?.role} kid=${mint?.kid}`,
  );
  expect(
    typeof mint?.jti === "string" && typeof mint?.expiresAt === "string",
    "and the mint event carries the jti and the expiry an operator correlates a 401 with",
    `jti=${mint?.jti} expiresAt=${mint?.expiresAt}`,
  );
  // The mint event is the one log line in the system that is ABOUT a bearer
  // credential, so it is the one place a token could leak into a log shipper.
  const leaked = out.lines.filter((l) => JWT_SHAPE.test(l));
  expect(
    leaked.length === 0,
    "and the token itself is in no log line — a bearer credential must not reach a log",
    `lines carrying a JWT shape=${leaked.length}${leaked.length > 0 ? ` first=${leaked[0].slice(0, 80)}` : ""}`,
  );

  // 11c. THE DRAIN, END TO END, WITH NOTHING DRIVING THE RELAY BY HAND. The row was
  // written by the API binary in §10; the shell started the scheduler and waited
  // for its own `relay_drain` tick; this is what that tick did.
  const row = await outboxRow(state.targetRecordId);
  expect(
    row?.state === "delivered",
    "the row the API queued reached `delivered` on the scheduler's own timer",
    `state=${row?.state} attempts=${row?.attempts} error=${row?.last_error ?? row?.dead_reason ?? "-"}`,
  );
  expect(
    row?.erp_response !== null && row?.erp_response?.id === state.targetRecordId,
    "and the ERP's own response is persisted on it",
    JSON.stringify(row?.erp_response)?.slice(0, 110),
  );

  const landed = await erpGet(`/v1/stock-movements/${state.targetRecordId}`);
  expect(
    landed.status === 200 &&
      landed.body?.movement_type === "issue" &&
      Number(landed.body?.quantity) === 12 &&
      landed.body?.warehouse_id === "wh-1",
    "the mirrored StockMovement is at the live ERP, built by the CRM and sent by the scheduler",
    `${landed.status} type=${landed.body?.movement_type} qty=${landed.body?.quantity} wh=${landed.body?.warehouse_id}`,
  );
  expect(
    typeof landed.body?.reason === "string" && landed.body.reason.includes("lot LOT-LIVE-1"),
    "carrying the lot in `reason`, the only place the ERP's StockMovement can hold it",
    JSON.stringify(landed.body?.reason),
  );

  // 11d. THE LOG LINE IS THE OPERATOR'S ONLY VIEW OF A DRAIN. There is no metrics
  // sink in this system: if this line changes shape or loses a counter, nobody
  // finds out from a failing test — they find out from not noticing an incident.
  expect(
    out.unparseable.length === 0 && out.parsed.length > 0,
    "every line the scheduler wrote to stdout is one JSON object, parseable by a log shipper",
    `lines=${out.lines.length} objects=${out.parsed.length} unparseable=${out.unparseable.length}` +
      (out.unparseable.length > 0 ? ` first=${out.unparseable[0].slice(0, 90)}` : ""),
  );
  expect(
    out.parsed.every((l) => typeof l.ts === "string" && typeof l.type === "string"),
    "and each carries a timestamp and a type, so a line can be found and filtered",
    `without ts/type=${out.parsed.filter((l) => typeof l.ts !== "string" || typeof l.type !== "string").length}`,
  );

  const drains = out.parsed.filter((l) => l.type === "job_ok" && l.job === "relay_drain");
  const drain = drains[0];
  const FIELDS = ["claimed", "delivered", "retried", "dead", "alarmed", "unattributed", "pending", "oldest"];
  const missing = FIELDS.filter((f) => !new RegExp(`\\b${f}=`).test(drain?.detail ?? ""));
  expect(
    drain !== undefined && missing.length === 0,
    "the relay_drain summary names every counter a human reads",
    `ticks=${drains.length} missing=${missing.join(",") || "none"} detail=${JSON.stringify(drain?.detail)}`,
  );
  expect(
    /\bdelivered=[1-9]/.test(drains.map((d) => d.detail).join(" ")),
    "and one of those ticks reports the delivery, so the line agrees with the database",
    drains
      .map((d) => d.detail)
      .join(" | ")
      .slice(0, 200),
  );
  expect(
    typeof drain?.tenantId === "string" && typeof drain?.durationMs === "number",
    "attributed to the tenant it drained, with its duration — the per-tenant loop, not a global one",
    `tenantId=${drain?.tenantId} durationMs=${drain?.durationMs}`,
  );

  // 11e. The same process also READ the ERP. `snapshot_full` runs through the
  // scheduler's own `SnapshotRefresher`, so the catalogue the API serves below was
  // put there by this binary out of the live server.
  const snaps = out.parsed.filter((l) => l.type === "job_ok" && l.job === "snapshot_full");
  const products = await inCrm(async (tx) => {
    const { rows } = await tx.query(
      `SELECT erp_item_id, list_price::text AS list_price FROM crm.product_snapshot
        WHERE tenant_id = $1 ORDER BY erp_item_id`,
      [TENANT],
    );
    return rows;
  });
  expect(
    snaps.length > 0 && products.length === 4,
    "the same process filled crm.product_snapshot from the live ERP in the same tick",
    `snapshot_full ticks=${snaps.length} rows=${products.length} prices=${products.map((p) => p.list_price).join(",")}`,
  );
  expect(
    /UNBOUNDED/.test(snaps.map((s) => s.detail).join(" ")),
    "and said out loud that `since` bounded nothing, because pack-erp-core declares no filterable updated_at",
    (snaps[0]?.detail ?? "").slice(0, 150),
  );

  // 11f. WHY packages/sync EXISTS, demonstrated across both binaries and the live
  // server in one line. The ERP compares `list_price` as TEXT — §4 of this gate
  // measures `?list_price[gte]=1000` returning 1000, 20 and 9 — and the API answers
  // the same question off the typed snapshot the scheduler just wrote.
  const erpNumeric = await erpGet("/v1/items?list_price[gte]=1000");
  const apiNumeric = await api("/v1/products?minPrice=1000", { token: humanToken() });
  const erpPrices = (erpNumeric.body?.data ?? []).map((r) => String(r.list_price));
  const apiPrices = (apiNumeric.body?.data ?? []).map((r) => String(r.list_price));
  expect(
    erpPrices.length === 3 && apiPrices.length === 1 && apiPrices[0].startsWith("1000"),
    "the ERP answers `>= 1000` with three rows and the CRM's API with one — the snapshot is typed",
    `ERP=[${erpPrices.join(",")}] API=[${apiPrices.join(",")}]`,
  );
}

// ===========================================================================
if (PHASE === "role-setup") {
  // No assertions: this only queues the row §12 measures, and it does it through
  // the same API route §10 used, so the row's provenance is the shipped one.
  const { targetRecordId, res } = await receiptThroughApi(humanToken(), "3.000");
  if (res.status !== 201) {
    process.stderr.write(`role-setup: POST /v1/samples/receipts answered ${res.status}\n`);
    process.exit(1);
  }
  saveState({ viewerTargetRecordId: targetRecordId });
  note(`queued ${targetRecordId} for the erp_viewer control`);
}

// ===========================================================================
if (PHASE === "role") {
  section("12. CONTROL: the ERP role in the token is the tenant's row, not the process's environment");

  const state = loadState();
  const out = logLines(`${WORK}/sched2.out`);
  const err = logLines(`${WORK}/sched2.err`);

  // The environment of this run is byte-identical to §11's. The only thing that
  // changed is one column of one row in `crm.erp_service_principal`. Were the role
  // read from anywhere else — an env var, a default, a constant — this run would
  // behave exactly like the last one.
  const mint = out.parsed.find((l) => l.type === "token_minted");
  expect(
    mint?.role === "erp_viewer",
    "with the tenant's row flipped to erp_viewer and nothing else changed, the token carries erp_viewer",
    `role=${mint?.role} tenant=${mint?.tenantId}`,
  );

  const row = await outboxRow(state.viewerTargetRecordId);
  expect(
    row?.state === "dead" && (row?.dead_reason ?? "").startsWith("forbidden:"),
    "and the live ERP refuses the create, so the row dies as a configuration fault instead of retrying forever",
    `state=${row?.state} dead_reason=${JSON.stringify(row?.dead_reason)}`,
  );
  const stillAbsent = await erpGet(`/v1/stock-movements/${state.viewerTargetRecordId}`);
  expect(
    stillAbsent.status === 404,
    "the record is not at the ERP, so the refusal was the ERP's and not a mislabelled success",
    `${stillAbsent.status}`,
  );

  // The per-ROW event, which exists in a deployed process only because the binary
  // wires `onEvent` into `OutboxRelay`. No aggregate can reconstruct which write
  // will never land, and this line is where an operator reads it.
  const deadLine = err.parsed.find((l) => l.type === "relay_dead" && l.targetRecordId === state.viewerTargetRecordId);
  expect(
    deadLine !== undefined && /forbidden/.test(deadLine.reason ?? ""),
    "and the binary logs the dead ROW on stderr, naming the write that will never reach the ERP",
    `line=${JSON.stringify(deadLine ?? null)?.slice(0, 190)}`,
  );
  // The same property for stderr, minus the node runtime's own notices. Those are
  // written by the interpreter before the binary's first line and are not the
  // binary's to format; counted and named rather than quietly dropped, because an
  // exclusion nobody can see is how a log line stops being checked.
  const runtimeNotices = err.unparseable.filter((l) => /^\(node:\d+\)/.test(l));
  const unformatted = err.unparseable.length - runtimeNotices.length;
  expect(
    unformatted === 0,
    "with every line the binary wrote to stderr a JSON object too, so the two streams ship together",
    `lines=${err.lines.length} nodeNotices=${runtimeNotices.length} unformatted=${unformatted}` +
      (unformatted > 0 ? ` first=${err.unparseable.find((l) => !/^\(node:\d+\)/.test(l)).slice(0, 90)}` : ""),
  );
}

// ===========================================================================
} catch (err) {
  fail(`phase ${PHASE} threw before it finished — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (checks > 0) process.stdout.write(`\n${checks} checks, ${failures} failure(s) in phase ${PHASE}\n`);
  appendFileSync(`${WORK}/counts`, `${checks} ${failures}\n`);
  await pool.end();
}
process.exit(failures === 0 ? 0 : 1);
