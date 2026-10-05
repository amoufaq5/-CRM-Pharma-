// Drives the CRM's own ACL, credential and relay code against a RUNNING
// operate-server, and reports what the integration's assumptions actually do.
//
// Everything here imports the SHIPPED dist of @crm/acl, @crm/credential and
// @crm/relay. Nothing reimplements a token, a slug, a filter or a classification
// for the purpose of the test. That is the whole point: the open question in
// ADR-0001 is not "can an Ed25519 JWT be verified" — it is "does the code we
// deploy satisfy the server we deploy against", and a check that mints its own
// token or builds its own query string answers a different question.
//
// Every assertion below pairs the claim with a CONTROL that fails if the
// mechanism is simply inert. A dropped filter returning every row proves nothing
// unless a declared filter is shown to remove rows; a sort that silently falls
// back proves nothing unless a declared sort is shown to reorder.
import { readFileSync } from "node:fs";

import pg from "pg";

import {
  ErpClient,
  PollingChangeSource,
  UnsupportedFilterError,
  resourceSlug,
  toErpError,
} from "../../packages/acl/dist/index.js";
import {
  LocalEd25519Signer,
  PostgresServiceRoleSource,
  ServiceCredential,
  mintServiceToken,
} from "../../packages/credential/dist/index.js";
import { withTenantContext } from "../../packages/db/dist/index.js";
import { OutboxRelay, classify, enqueueOutbox } from "../../packages/relay/dist/index.js";

const ERP_BASE = process.env["ERP_BASE_URL"] ?? "http://127.0.0.1:8788";
const JWKS_BASE = process.env["JWKS_BASE_URL"] ?? "http://127.0.0.1:8799";
const TENANT = process.env["LIVE_TENANT_ID"] ?? "11111111-1111-4111-8111-111111111111";
const ISSUER = process.env["LIVE_JWT_ISSUER"] ?? "https://crm.test";
const AUDIENCE = process.env["LIVE_JWT_AUDIENCE"] ?? "https://erp.test";
const KEY_PEM = process.env["LIVE_KEY_PEM"];
const ROGUE_PEM = process.env["LIVE_ROGUE_PEM"];

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

/**
 * Signs a token with NO `tenant_id` claim.
 *
 * Hand-assembled on purpose: `mintServiceToken` refuses one, and that refusal is
 * exactly the control being measured. Nothing else in this file builds a token by
 * hand, and nothing in the CRM can produce this shape.
 */
async function mintUnsafeNoTenant(withSigner) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "EdDSA", typ: "JWT", kid: withSigner.kid });
  const body = enc({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "no-tenant-claim",
    scope: "erp_admin",
    iat: now,
    nbf: now - 30,
    exp: now + 600,
  });
  const sig = await withSigner.sign(new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${Buffer.from(sig).toString("base64url")}` };
}

/** A raw request, for the cases whose point is what the SERVER does with a path the client would refuse to build. */
async function raw(path, token, init = {}) {
  const res = await fetch(`${ERP_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.tenant === null ? {} : { "x-tenant-id": init.tenant ?? TENANT }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" };
}

const pool = new pg.Pool({
  host: process.env["CRM_PGHOST"] ?? "/var/run/postgresql",
  user: process.env["CRM_PGUSER"] ?? "crm_app",
  password: process.env["CRM_PGPASSWORD"] ?? "crm_app",
  database: process.env["CRM_PGDATABASE"] ?? "crm_live1",
  max: 4,
});

// ---------------------------------------------------------------------------
// 1. The credential handshake — ADR-0001's open question.
// ---------------------------------------------------------------------------
section("1. a CRM-minted Ed25519 token, accepted by a running operate-server");

const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(KEY_PEM, "utf8"));
const roles = new PostgresServiceRoleSource({ pool });
const credential = new ServiceCredential({ signer, roles, issuer: ISSUER, audience: AUDIENCE });

const client = new ErpClient({
  baseUrl: ERP_BASE,
  credential,
  // The ERP client's FetchLike is narrower than the global fetch (it returns a
  // `text()` + `headers.get()` shape), and a real Response satisfies it.
  fetch: (url, init) => fetch(url, init),
});

const jwksBefore = Number((await (await fetch(`${JWKS_BASE}/__count`)).text()).trim());

let schema;
try {
  schema = await client.schema(TENANT);
  ok(`GET /v1/meta/schema accepted the CRM's service token (${schema.schema.entities.length} entities served)`);
} catch (err) {
  fail(`the live ERP REFUSED the CRM's service token: ${err instanceof Error ? err.message : String(err)}`);
  process.stdout.write("\nthe handshake is the premise of every other check; stopping here\n");
  await pool.end();
  process.exit(1);
}

const jwksAfter = Number((await (await fetch(`${JWKS_BASE}/__count`)).text()).trim());
expect(
  jwksAfter > jwksBefore || jwksBefore > 0,
  "the ERP fetched the key over HTTP from the CRM's JWKS endpoint",
  `${jwksAfter} fetch(es) recorded`,
);

// The negative controls. Without these a passing handshake is consistent with a
// server that accepts any bearer string at all.
const { token: rogueToken } = await mintServiceToken(LocalEd25519Signer.fromPkcs8Pem(readFileSync(ROGUE_PEM, "utf8")), {
  issuer: ISSUER,
  audience: AUDIENCE,
  tenantId: TENANT,
  role: "erp_admin",
  subject: `crm-service:${TENANT}`,
  ttlSeconds: 600,
  nowSeconds: Math.floor(Date.now() / 1000),
});
const rogue = await raw("/v1/items?limit=1", rogueToken);
expect(
  rogue.status === 401 && !String(rogue.body?.detail ?? "").includes("credential_malformed"),
  "a token signed by a key the JWKS does not publish is refused on its unknown kid",
  `${rogue.status} ${JSON.stringify(rogue.body?.detail ?? rogue.body)}`,
);

const goodToken = await credential.token(TENANT);

for (const [label, bad] of [
  ["issuer", { issuer: "https://not-the-crm.test" }],
  ["audience", { audience: "https://not-the-erp.test" }],
]) {
  const { token: t } = await mintServiceToken(signer, {
    issuer: ISSUER,
    audience: AUDIENCE,
    tenantId: TENANT,
    role: "erp_admin",
    subject: `crm-service:${TENANT}`,
    ttlSeconds: 600,
    nowSeconds: Math.floor(Date.now() / 1000),
    ...bad,
  });
  const res = await raw("/v1/items?limit=1", t);
  // The reason matters as much as the status. `credential_malformed` means the
  // bearer string was not a JWT at all, which is what a harness bug looks like —
  // three of these checks passed for exactly that reason before the mint call was
  // destructured correctly, and that is the shape of a vacuous pass.
  expect(
    res.status === 401 && !String(res.body?.detail ?? "").includes("credential_malformed"),
    `a wrong ${label} is refused, and for a claim reason rather than a malformed token`,
    `${res.status} ${JSON.stringify(res.body?.detail)}`,
  );
}

const mismatch = await raw("/v1/items?limit=1", goodToken, { tenant: "22222222-2222-4222-8222-222222222222" });
expect(
  mismatch.status === 401 && String(mismatch.body?.detail) === "tenant_mismatch",
  "an x-tenant-id that disagrees with the token's tenant_id claim is refused",
  `${mismatch.status} ${JSON.stringify(mismatch.body?.detail)}`,
);

// How the tenant is actually resolved, which ADR-0001 item 10 states only half of
// ("the tenant rides in x-tenant-id and the gateway cross-checks it against the
// claim"). Live, the CLAIM is authoritative and the header is optional…
const noHeader = await raw("/v1/cost-centers", goodToken, { tenant: null });
expect(
  noHeader.status === 200 && noHeader.body.data.length > 0,
  "with no x-tenant-id at all the tenant comes from the token's claim, and the read succeeds",
  `${noHeader.status}, ${noHeader.body?.data?.length} rows`,
);

// …but the cross-check only fires when the claim is PRESENT. A validly signed
// token with no tenant_id claim is accepted and the header alone picks the
// tenant — the same "only checks the claims that are there" pattern the CRM
// already records for exp/iss/aud. This is an ERP-side gap, reported and not
// worked around; what follows is the CRM's side of the defence.
const { token: noTenantClaim } = await mintUnsafeNoTenant(signer);
const headerOnly = await raw("/v1/cost-centers", noTenantClaim, { tenant: TENANT });
expect(
  headerOnly.status === 200,
  "OBSERVED (ERP gap): a token with NO tenant_id claim is accepted and x-tenant-id alone selects the tenant",
  `${headerOnly.status} ${JSON.stringify(headerOnly.body).slice(0, 70)}`,
);

// So the minter's tenant check is not tidiness — it is the only thing between one
// signing key and every tenant's data. Asserted here, next to the gap it covers.
let minterRefused = null;
try {
  await mintServiceToken(signer, {
    issuer: ISSUER,
    audience: AUDIENCE,
    tenantId: "",
    role: "erp_admin",
    subject: "x",
    ttlSeconds: 600,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
} catch (err) {
  minterRefused = err;
}
expect(
  minterRefused !== null && /tenant_id must be a UUID/.test(minterRefused.message),
  "and @crm/credential REFUSES to mint a token without a UUID tenant — the CRM's half of that gap",
  minterRefused === null ? "it MINTED one" : minterRefused.message.slice(0, 60),
);

// ADR-0001 item 10 / README rule 11: the ERP reads the FIRST scope as the role.
// Proving the single scope actually binds a role means showing the role matters.
const { token: viewerToken } = await mintServiceToken(signer, {
  issuer: ISSUER,
  audience: AUDIENCE,
  tenantId: TENANT,
  role: "erp_viewer",
  subject: `crm-service:${TENANT}`,
  ttlSeconds: 600,
  nowSeconds: Math.floor(Date.now() / 1000),
});
const viewerList = await raw("/v1/cost-centers?limit=1", viewerToken);
const viewerWrite = await raw("/v1/cost-centers", viewerToken, {
  method: "POST",
  body: { id: "cc-viewer", code: "CC-V", name: "V", segment: "operating", is_active: true },
});
expect(
  viewerList.status === 200 && viewerWrite.status === 403,
  "the token's single scope binds an ERP role (erp_viewer lists but cannot create)",
  `list=${viewerList.status} create=${viewerWrite.status}`,
);

// ---------------------------------------------------------------------------
// 2. Slug resolution — README rule 3.
// ---------------------------------------------------------------------------
section("2. every slug the ACL resolves is a path the server serves");

const entities = schema.schema.entities;
// 404 is the only failing answer here. A 403 proves the route matched and RBAC
// then refused it, which is the distinction that matters: the client's job is to
// get the path right, and `classify` dead-letters a 404 on a create as a stale
// slug while a 403 is a credential problem. Collapsing them would hide the one
// entity that answers 403 to every role there is — see the next check.
const slugMisses = [];
const slugForbidden = [];
for (const e of entities) {
  const res = await raw(`/v1/${e.slug}?limit=1`, goodToken);
  if (res.status === 404) slugMisses.push(`${e.name} -> /v1/${e.slug}`);
  else if (res.status === 403) slugForbidden.push(e.name);
}
expect(
  slugMisses.length === 0,
  `all ${entities.length} schema-declared slugs resolve to a live route`,
  slugMisses.join("; ") || "no 404s",
);

// Found live and not predicted by anything in the CRM: WhtCertificate is routed
// and has an EMPTY access list on all five operations, so no role can reach it.
const noAccess = entities.filter((e) => e.access.list.length === 0).map((e) => e.name);
expect(
  slugForbidden.every((name) => noAccess.includes(name)),
  "every slug that answers 403 is one the schema shows nobody may list, so it is RBAC and not a bad path",
  `403: [${slugForbidden.join(",")}] ; empty list access: [${noAccess.join(",")}]`,
);

const slugFnMisses = entities.filter((e) => resourceSlug(e.name) !== e.slug).map((e) => `${e.name}: ${resourceSlug(e.name)} != ${e.slug}`);
expect(
  slugFnMisses.length === 0,
  "the ACL's fallback pluraliser reproduces the server's slug for every entity, mistakes included",
  slugFnMisses.join("; ") || "exact on all",
);

for (const [entity, english] of [
  ["Opportunity", "opportunities"],
  ["Currency", "currencies"],
]) {
  const declared = schema.slugFor(entity);
  const guessed = await raw(`/v1/${english}?limit=1`, goodToken);
  const real = await raw(`/v1/${declared}?limit=1`, goodToken);
  expect(
    guessed.status === 404 && real.status === 200,
    `${entity}: the English plural 404s and the server's naive /${declared} is the live path`,
    `/${english}=${guessed.status} /${declared}=${real.status}`,
  );
}

// ---------------------------------------------------------------------------
// 3. The dropped filter and the dropped sort — the reason the ACL exists.
// ---------------------------------------------------------------------------
section("3. a filter the ERP does not recognise is silently ignored, not rejected");

const CC = "cost-centers";
const all = await raw(`/v1/${CC}`, goodToken);
const allCodes = all.body.data.map((r) => r.code).sort();
expect(allCodes.length >= 3, "fixture: at least three cost centres exist", allCodes.join(","));

const dropped = await raw(`/v1/${CC}?code%5Beq%5D=${encodeURIComponent(allCodes.at(-1))}`, goodToken);
const droppedCodes = dropped.body.data.map((r) => r.code);
expect(
  dropped.status === 200 && droppedCodes.length === allCodes.length,
  "CostCenter.code is not filterable: ?code[eq]=… returns EVERY row with a 200",
  `asked for ${allCodes.at(-1)}, got ${droppedCodes.length}/${allCodes.length} rows`,
);
expect(
  droppedCodes[0] !== allCodes.at(-1),
  "and the first row is the WRONG cost centre, so a caller reading data[0] sees a plausible hit",
  `data[0].code=${droppedCodes[0]}, asked for ${allCodes.at(-1)}`,
);

const bogus = await raw(`/v1/${CC}?nosuchfield=whatever`, goodToken);
expect(
  bogus.status === 200 && bogus.body.data.length === allCodes.length,
  "an entirely invented query parameter is ignored rather than rejected",
  `${bogus.status}, ${bogus.body.data.length} rows`,
);

// THE CONTROL. Without it, "every filter returns every row" would pass this
// section while meaning filtering is broken outright rather than selectively.
const honoured = await raw(`/v1/${CC}?manager_id%5Beq%5D=nobody-at-all`, goodToken);
expect(
  honoured.status === 200 && honoured.body.data.length === 0,
  "CONTROL: a filter the schema DOES declare removes rows, so the drop above is selective",
  `manager_id[eq]=nobody-at-all -> ${honoured.body.data.length} rows`,
);

const noSort = (await raw(`/v1/${CC}`, goodToken)).body.data.map((r) => r.code);
const badSort = (await raw(`/v1/${CC}?sort=code&order=desc`, goodToken)).body.data.map((r) => r.code);
expect(
  JSON.stringify(badSort) === JSON.stringify(noSort),
  "a sort on a non-sortable field falls back to the view's default order, with a 200",
  `sort=code&order=desc gave ${badSort.join(",")}; unsorted gives ${noSort.join(",")}`,
);

const skuAsc = (await raw(`/v1/items?sort=sku&order=asc`, goodToken)).body.data.map((r) => r.sku);
const skuDesc = (await raw(`/v1/items?sort=sku&order=desc`, goodToken)).body.data.map((r) => r.sku);
expect(
  JSON.stringify(skuDesc) === JSON.stringify([...skuAsc].reverse()) && skuAsc.length > 1,
  "CONTROL: a sort the schema DOES declare reorders, so the fallback above is selective",
  `asc=${skuAsc.join(",")} desc=${skuDesc.join(",")}`,
);

section("3b. the three measured facts packages/acl/schema/README.md is built on");

const withUpdatedAt = entities.filter((e) => e.fields.some((f) => f.name === "updated_at"));
const filterableUpdatedAt = entities.filter((e) => e.filterableFields.includes("updated_at"));
expect(
  withUpdatedAt.length === 0 && filterableUpdatedAt.length === 0,
  `no entity serves updated_at (0 of ${entities.length} declare it, 0 expose it as filterable)`,
  `declared=${withUpdatedAt.length} filterable=${filterableUpdatedAt.length}`,
);

// The dangerous half of that fact: the DATA carries updated_at even though the
// schema does not, so an incremental poller would look right and filter nothing.
const future = await raw(`/v1/${CC}?updated_at%5Bgte%5D=2099-01-01T00%3A00%3A00Z`, goodToken);
const carriesUpdatedAt = all.body.data.every((r) => typeof r.updated_at === "string");
expect(
  carriesUpdatedAt && future.status === 200 && future.body.data.length === allCodes.length,
  "every record CARRIES updated_at while no schema declares it, so ?updated_at[gte]=2099 returns everything",
  `rows carry updated_at=${carriesUpdatedAt}, future filter -> ${future.body.data.length}/${allCodes.length} rows`,
);

const unsortable = entities.filter((e) => e.sortableFields.length === 0);
expect(
  unsortable.length === 34,
  `34 of ${entities.length} entities expose no sortable field at all`,
  `${unsortable.length} of ${entities.length}`,
);

const ccFilterable = schema.entity("CostCenter").filterableFields;
expect(
  !ccFilterable.includes("code") && ccFilterable.includes("parent_id") && ccFilterable.includes("manager_id"),
  "CostCenter's only filterable fields are parent_id and manager_id — code is not among them",
  ccFilterable.join(","),
);

section("3c. the ACL refuses before sending what the ERP would silently mishandle");

function refusal(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

const ccFilterRefusal = refusal(() => schema.assertFilterable("CostCenter", "code", "eq"));
expect(
  ccFilterRefusal instanceof UnsupportedFilterError,
  "assertFilterable refuses CostCenter.code rather than sending a filter the server drops",
  ccFilterRefusal === null ? "it was ACCEPTED" : ccFilterRefusal.constructor.name,
);

const ccSortRefusal = refusal(() => schema.assertSortable("CostCenter", "code"));
expect(
  ccSortRefusal instanceof UnsupportedFilterError,
  "assertSortable refuses CostCenter.code rather than accepting a silent fallback",
  ccSortRefusal === null ? "it was ACCEPTED" : ccSortRefusal.constructor.name,
);

const numericRefusal = refusal(() => schema.assertFilterable("Item", "list_price", "gte"));
expect(
  numericRefusal instanceof UnsupportedFilterError,
  "assertFilterable refuses a range operator on Item.list_price (a declared-filterable NUMBER)",
  numericRefusal === null ? "it was ACCEPTED" : numericRefusal.message.slice(0, 60),
);

const numericSortRefusal = refusal(() => schema.assertSortable("Item", "list_price"));
expect(
  numericSortRefusal instanceof UnsupportedFilterError,
  "assertSortable refuses Item.list_price (a declared-sortable NUMBER)",
  numericSortRefusal === null ? "it was ACCEPTED" : numericSortRefusal.message.slice(0, 60),
);

// And the ACL must not refuse what the ERP gets right, or it is just a wall.
const dateAccepted = refusal(() => schema.assertFilterable("LeaveRequest", "start_date", "gte"));
const textSortAccepted = refusal(() => schema.assertSortable("Item", "sku"));
expect(
  dateAccepted === null && textSortAccepted === null,
  "CONTROL: an ISO-date range filter and a text sort are ACCEPTED, so the refusals are targeted",
  `start_date[gte]=${dateAccepted === null ? "accepted" : "refused"} sort=sku ${textSortAccepted === null ? "accepted" : "refused"}`,
);

// ---------------------------------------------------------------------------
// 4. Numbers are text and ISO dates are the exemption — README rule 4.
// ---------------------------------------------------------------------------
section("4. the ERP compares numbers as text; ISO-8601 dates are the exemption");

const gte1000 = await raw("/v1/items?list_price%5Bgte%5D=1000", goodToken);
const returnedPrices = gte1000.body.data.map((r) => r.list_price);
const wrongRows = returnedPrices.filter((p) => p < 1000);
expect(
  wrongRows.length > 0,
  "?list_price[gte]=1000 returns records BELOW 1000 — the comparison is textual, not numeric",
  `returned ${JSON.stringify(returnedPrices)}; wrong: ${JSON.stringify(wrongRows)}`,
);

const sorted = (await raw("/v1/items?sort=list_price&order=asc", goodToken)).body.data.map((r) => r.list_price);
const numericallySorted = [...sorted].sort((a, b) => a - b);
const lexicographically = [...sorted].sort((a, b) => String(a).localeCompare(String(b)));
expect(
  JSON.stringify(sorted) !== JSON.stringify(numericallySorted) &&
    JSON.stringify(sorted) === JSON.stringify(lexicographically),
  "?sort=list_price orders lexicographically, not numerically",
  `${JSON.stringify(sorted)} (numeric order would be ${JSON.stringify(numericallySorted)})`,
);

const after = (await raw("/v1/leave-requests?start_date%5Bgte%5D=2026-02-01", goodToken)).body.data.map((r) => r.start_date);
const before = (await raw("/v1/leave-requests?start_date%5Blt%5D=2026-02-01", goodToken)).body.data.map((r) => r.start_date);
expect(
  after.length > 0 &&
    before.length > 0 &&
    after.every((d) => d >= "2026-02-01") &&
    before.every((d) => d < "2026-02-01"),
  "an ISO-8601 date range IS chronologically correct, and both sides are non-empty",
  `gte: ${after.sort().join(",")} | lt: ${before.sort().join(",")}`,
);

section("4b. keyset pagination pages a sortable view completely and without repeats");

const seen = [];
for await (const row of client.listAll(TENANT, "Item", { sort: { field: "sku" }, limit: 2 })) {
  seen.push(row.sku);
}
const direct = (await raw("/v1/items?limit=500", goodToken)).body.data.map((r) => r.sku).sort();
expect(
  new Set(seen).size === seen.length && JSON.stringify([...seen].sort()) === JSON.stringify(direct),
  "listAll walks every page via the cursor, no row repeated or skipped",
  `paged ${seen.length} in pages of 2 (${seen.join(",")}); one shot gives ${direct.length}`,
);

section("4c. PollingChangeSource against the live schema");

// The claim this pins: PollingChangeSource ASKS the schema and falls back
// loudly, rather than sending an `updated_at` filter the ERP would drop. Six of
// its tests passed for the life of the project against a hand-written fixture
// that declared `updated_at` filterable on every entity — the worst vacuous pass
// this repo has had. This is the same question put to a real server.
const poller = new PollingChangeSource({ client, pageSize: 50 });
const supportsItem = await poller.supportsIncremental(TENANT, "Item");
const batch = await poller.changesSince(TENANT, "Item", "2099-01-01T00:00:00.000Z");
expect(
  supportsItem === false && batch.mode === "full_sweep",
  "no entity supports incremental polling, so a poll reports mode=full_sweep rather than filtering",
  `supportsIncremental=${supportsItem} mode=${batch.mode}`,
);
expect(
  batch.records.length > 0,
  "and the full sweep really returns records despite a `since` far in the future — the watermark bounded nothing",
  `${batch.records.length} record(s) for since=2099-01-01`,
);
expect(
  batch.records.every((r) => typeof r.updatedAt === "string" && r.updatedAt !== ""),
  "every swept record carries an updated_at the CRM can store, even though the schema declares none",
  `${batch.records.length}/${batch.records.length} with a timestamp`,
);

// ---------------------------------------------------------------------------
// 5. Both error shapes.
// ---------------------------------------------------------------------------
section("5. both ERP error shapes, normalised by the shipped mapper");

// A REAL 409, which needs a real record: firing `approve` on a draft is the one
// way to get `invalid_transition` out of the handler. The first version of this
// probe POSTed a transition to a record id that does not exist, which answers 404
// — so it was labelled "handler 409" while duplicating the missing-record check
// above it, and passed. A gate whose whole purpose is to say what was actually
// verified must not carry a label its own evidence contradicts.
const shapeStamp = Date.now().toString(36);
const shapeLrId = `crm-lr-${shapeStamp}-shape`;
await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: {
    id: shapeLrId,
    request_number: `RT-${shapeStamp}-S`,
    employee_id: "emp-1",
    leave_type: "sick",
    start_date: "2026-08-01",
    end_date: "2026-08-02",
    days: 2,
    state: "draft",
  },
});
const realConflict = await raw(`/v1/leave-requests/${shapeLrId}/approve`, goodToken, {
  method: "POST",
  body: {},
});

const shapes = [
  ["gateway 401, bad token", await raw("/v1/items", "not.a.jwt"), "unauthenticated", "authentication_required"],
  ["gateway 404, unknown route", await raw("/v1/no-such-thing", goodToken), "not_found", "not_found"],
  ["handler 403, RBAC", viewerWrite, "forbidden", "forbidden"],
  ["handler 404, missing record", await raw("/v1/leave-requests/nope-999", goodToken), "not_found", "not_found"],
  ["handler 409, a transition that cannot fire", realConflict, "conflict", "invalid_transition"],
];
expect(
  realConflict.status === 409,
  "the 409 probe really got a 409 — not the 404 a non-existent record would give",
  `status=${realConflict.status} body=${JSON.stringify(realConflict.body)?.slice(0, 90)}`,
);
for (const [label, res, kind, code] of shapes) {
  const e = toErpError(res.status, res.body);
  expect(
    e.kind === kind && e.code === code && e.code !== "unrecognised_error_shape",
    `${label} (${res.status}, ${res.contentType.split(";")[0]}) normalises to ${kind}/${code}`,
    `kind=${e.kind} code=${e.code}`,
  );
}

const problemBodies = shapes.filter(([, r]) => r.contentType.includes("problem+json")).length;
const handlerBodies = shapes.length - problemBodies;
expect(
  problemBodies > 0 && handlerBodies > 0,
  "the live server really does emit BOTH shapes on the same API",
  `${problemBodies} application/problem+json, ${handlerBodies} bare {error,detail}`,
);

// ---------------------------------------------------------------------------
// 6. The outbox round trip, through packages/relay against the live ERP.
// ---------------------------------------------------------------------------
section("6. a real outbox round trip: create, transition, replay, out-of-order");

const events = [];
const relay = new OutboxRelay({
  pool,
  client,
  workerId: "live-erp-verify",
  onEvent: (e) => events.push(e),
});

async function enqueue(input) {
  const conn = await pool.connect();
  try {
    return await withTenantContext(conn, TENANT, (tx) => enqueueOutbox(tx, TENANT, input));
  } finally {
    conn.release();
  }
}

async function outboxState(id) {
  const conn = await pool.connect();
  try {
    return await withTenantContext(conn, TENANT, async (tx) => {
      const { rows } = await tx.query(
        `SELECT state, attempts, last_error, dead_reason, erp_response FROM crm.outbox WHERE id = $1`,
        [id],
      );
      return rows[0];
    });
  } finally {
    conn.release();
  }
}

const stamp = Date.now().toString(36);
const srcId = () => crypto.randomUUID();

// 6a. create
const createId = `crm-lr-${stamp}-a`;
const created = await enqueue({
  entity: "LeaveRequest",
  operation: "create",
  payload: {
    request_number: `RT-${stamp}-A`,
    employee_id: "emp-1",
    leave_type: "annual",
    start_date: "2026-06-01",
    end_date: "2026-06-03",
    days: 3,
    state: "draft",
  },
  targetRecordId: createId,
  sourceTable: "crm.visit",
  sourceId: srcId(),
});
await relay.drainTenant(TENANT);
let row = await outboxState(created.id);
const liveCreated = await raw(`/v1/leave-requests/${createId}`, goodToken);
expect(
  row.state === "delivered" && liveCreated.status === 200 && liveCreated.body.state === "draft",
  "a create dispatched by the relay lands at the live ERP under the CRM's own record id",
  `outbox=${row.state}, GET /v1/leave-requests/${createId} = ${liveCreated.status} state=${liveCreated.body?.state}`,
);
expect(
  row.erp_response !== null && row.erp_response.id === createId,
  "the ERP's response is persisted on the outbox row",
  JSON.stringify(row.erp_response)?.slice(0, 90),
);

// 6b. transition, in order
const submitted = await enqueue({
  entity: "LeaveRequest",
  operation: "transition:submit",
  payload: {},
  targetRecordId: createId,
  sourceTable: "crm.visit",
  sourceId: srcId(),
});
await relay.drainTenant(TENANT);
row = await outboxState(submitted.id);
const afterSubmit = await raw(`/v1/leave-requests/${createId}`, goodToken);
expect(
  row.state === "delivered" && afterSubmit.body.state === "submitted",
  "a lifecycle transition dispatched by the relay moves the live ERP record",
  `outbox=${row.state}, ERP state=${afterSubmit.body?.state}`,
);

// 6c. OUT OF ORDER. The 409 fix from last increment, seen for the first time.
const ooId = `crm-lr-${stamp}-b`;
await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: {
    id: ooId,
    request_number: `RT-${stamp}-B`,
    employee_id: "emp-1",
    leave_type: "sick",
    start_date: "2026-07-01",
    end_date: "2026-07-02",
    days: 2,
    state: "draft",
  },
});
const outOfOrder = await enqueue({
  entity: "LeaveRequest",
  operation: "transition:approve",
  payload: {},
  targetRecordId: ooId,
  sourceTable: "crm.visit",
  sourceId: srcId(),
});
events.length = 0;
await relay.drainTenant(TENANT);
row = await outboxState(outOfOrder.id);
const retryEvent = events.find((e) => e.type === "retry" && e.row.id === outOfOrder.id);
expect(
  row.state === "pending" && row.dead_reason === null,
  "an out-of-order transition is NOT marked delivered — the row stays pending for a later drain",
  `state=${row.state} dead_reason=${JSON.stringify(row.dead_reason)}`,
);
expect(
  retryEvent !== undefined && retryEvent.outcome.kind === "retry_ordering",
  "the ERP's 409 invalid_transition classifies as retry_ordering, not already_delivered",
  retryEvent === undefined ? `events: ${events.map((e) => e.type).join(",")}` : retryEvent.outcome.kind,
);
expect(
  typeof row.last_error === "string" && row.last_error.includes("cannot fire from"),
  "and the ERP's own sentence is kept on the row, so the queue says why it is waiting",
  JSON.stringify(row.last_error)?.slice(0, 110),
);

// 6d. REPLAY. A row whose deterministic target id is already at the ERP — the
// state a relay is in after a settle it never got to write. A fresh outbox id is
// used so the gateway's in-memory idempotency store cannot short-circuit it: the
// point is the DATABASE unique constraint, which is the only durable guarantee
// (ADR-0001 item 6).
const dupId = `crm-lr-${stamp}-c`;
await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: {
    id: dupId,
    request_number: `RT-${stamp}-C`,
    employee_id: "emp-1",
    leave_type: "annual",
    start_date: "2026-08-01",
    end_date: "2026-08-02",
    days: 2,
    state: "draft",
  },
});
const replay = await enqueue({
  entity: "LeaveRequest",
  operation: "create",
  payload: {
    request_number: `RT-${stamp}-C`,
    employee_id: "emp-1",
    leave_type: "annual",
    start_date: "2026-08-01",
    end_date: "2026-08-02",
    days: 2,
    state: "draft",
  },
  targetRecordId: dupId,
  sourceTable: "crm.visit",
  sourceId: srcId(),
});
events.length = 0;
await relay.drainTenant(TENANT);
row = await outboxState(replay.id);
expect(
  row.state === "delivered" && events.some((e) => e.type === "already_delivered" && e.row.id === replay.id),
  "a redelivery whose target id already exists at the ERP settles as already_delivered",
  `state=${row.state} events=${events.map((e) => e.type).join(",")}`,
);

const dupCount = (await raw(`/v1/leave-requests?limit=500`, goodToken)).body.data.filter(
  (r) => r.request_number === `RT-${stamp}-C`,
).length;
expect(dupCount === 1, "and the ERP holds exactly ONE record, not two", `${dupCount} record(s)`);

// 6e. The same-process retry hits the gateway's in-memory idempotency store
// instead of the unique constraint. Worth pinning separately because it answers
// with an EMPTY 201 body, which a client that trusts the response would misread.
const idemBody = {
  id: `crm-lr-${stamp}-d`,
  request_number: `RT-${stamp}-D`,
  employee_id: "emp-1",
  leave_type: "unpaid",
  start_date: "2026-09-01",
  end_date: "2026-09-02",
  days: 2,
  state: "draft",
};
const first = await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: idemBody,
  headers: { "idempotency-key": `crm-${stamp}-idem` },
});
const second = await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: idemBody,
  headers: { "idempotency-key": `crm-${stamp}-idem` },
});
expect(
  first.status === 201 && second.status === 201 && second.body === null,
  "a replay carrying the same Idempotency-Key answers 201 with an EMPTY body (the gateway's in-memory store)",
  `first=${first.status} second=${second.status} body=${JSON.stringify(second.body)}`,
);

// 6f. A permanently-bad payload must dead-letter with a reason an operator can act on.
const badId = `crm-lr-${stamp}-e`;
const bad = await enqueue({
  entity: "LeaveRequest",
  // `request_number` omitted: a required field, so the ERP answers 422 with its
  // `fields` array and no `detail`.
  payload: { employee_id: "emp-1", leave_type: "annual", start_date: "2026-10-01", end_date: "2026-10-02", days: 1, state: "draft" },
  operation: "create",
  targetRecordId: badId,
  sourceTable: "crm.visit",
  sourceId: srcId(),
});
events.length = 0;
await relay.drainTenant(TENANT);
row = await outboxState(bad.id);
expect(
  row.state === "dead",
  "a payload the ERP validates away dead-letters rather than retrying to the cap",
  `state=${row.state}`,
);
expect(
  typeof row.dead_reason === "string" && /request_number/.test(row.dead_reason),
  "and the dead reason names the FIELD the ERP rejected, so it can be fixed",
  JSON.stringify(row.dead_reason),
);

// 6g. WHAT the replay classification actually rests on.
//
// ADR-0001 item 6 says "treat a unique violation on replay as success", and
// `classify` has a `kind === "conflict"` branch written for it. The live server
// does NOT answer 409: it answers 500 `write_failed` carrying node-postgres's
// message verbatim, and the only thing that rescues the classification is the
// ALREADY_EXISTS regex over `detail`. That makes a successfully delivered write
// depend on the ERP leaking a driver string — so the dependency is asserted here
// rather than left as a happy accident.
const dupProbe = await raw("/v1/leave-requests", goodToken, {
  method: "POST",
  body: { id: dupId, request_number: `RT-${stamp}-C`, employee_id: "emp-1", leave_type: "annual", start_date: "2026-08-01", end_date: "2026-08-02", days: 2, state: "draft" },
});
const dupErr = toErpError(dupProbe.status, dupProbe.body);
expect(
  dupProbe.status === 500 && dupErr.kind !== "conflict",
  "a duplicate record id answers 500 write_failed, NOT the 409 conflict the classifier's own branch expects",
  `${dupProbe.status} kind=${dupErr.kind} code=${dupErr.code}`,
);
expect(
  classify({ error: dupErr, isTransition: false }).kind === "already_delivered",
  "it still classifies as already_delivered — via the duplicate-key text in detail",
  classify({ error: dupErr, isTransition: false }).kind,
);
const stripped = toErpError(dupProbe.status, { error: dupProbe.body.error });
expect(
  classify({ error: stripped, isTransition: false }).kind === "retry_transient",
  "and WITHOUT that text the identical status and code classify as a retry — so an ERP that stopped leaking the driver message would report a delivered write as dead at the attempt cap",
  classify({ error: stripped, isTransition: false }).kind,
);

// The outbox is a work queue, not a ledger: its rows exist to be settled, and the
// assertions above have already read each one's settled state. Removing this
// run's rows keeps a second run from claiming the first run's still-pending
// out-of-order row and satisfying an assertion with it.
const cleanup = await pool.connect();
try {
  const removed = await withTenantContext(cleanup, TENANT, async (tx) => {
    const { rowCount } = await tx.query(`DELETE FROM crm.outbox WHERE tenant_id = $1 AND target_record_id LIKE $2`, [
      TENANT,
      `crm-lr-${stamp}-%`,
    ]);
    return rowCount ?? 0;
  });
  ok(`cleaned up ${removed} outbox row(s) this run created`);
} finally {
  cleanup.release();
}

// ---------------------------------------------------------------------------
section("summary");
process.stdout.write(`${checks} checks, ${failures} failure(s)\n`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
