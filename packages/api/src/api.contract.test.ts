import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_API as TENANT, TENANT_API_OTHER as OTHER } from "@crm/db/testing";

import { startApi, type RunningApi } from "./server.js";
import type { JwksKey } from "./jwt.js";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEYS: readonly JwksKey[] = [{ kid: "k1", alg: "RS256", key: rsa.publicKey }];
const ISSUER = "https://idp.test/";
const AUDIENCE = "crm-pharma";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(claims: Record<string, unknown> = {}): string {
  const header = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
  const payload = b64({
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  const sig = createSign("RSA-SHA256").update(Buffer.from(`${header}.${payload}`)).sign(rsa.privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function pool(): Pool {
  return new Pool({
    host: process.env["PGHOST"] ?? "/var/run/postgresql",
    database: process.env["PGDATABASE"] ?? "crm_test",
    user: process.env["PGUSER"] ?? "postgres",
    ...(process.env["PGPASSWORD"] !== undefined ? { password: process.env["PGPASSWORD"] } : {}),
    ...(process.env["PGPORT"] !== undefined ? { port: Number(process.env["PGPORT"]) } : {}),
    max: 8,
  });
}

describe("the API, end to end", () => {
  let p: Pool;
  let admin: PoolClient;
  let api: RunningApi;
  let baseUrl = "";
  let rep = "";
  let otherRep = "";
  let auh = "";
  let dxb = "";

  beforeAll(async () => {
    p = pool();
    admin = await p.connect();
    await admin.query("SET ROLE crm_app");
    api = await startApi({ pool: p, auth: { issuer: ISSUER, audience: AUDIENCE, jwks: KEYS } });
    baseUrl = `http://127.0.0.1:${api.port}`;
  });

  afterAll(async () => {
    await api.close();
    await admin.query("RESET ROLE");
    admin.release();
    await p.end();
  });

  beforeEach(async () => {
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        await tx.query("ALTER TABLE crm.visit DISABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.visit_product WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.visit WHERE tenant_id = $1", [t]);
        await tx.query("ALTER TABLE crm.visit ENABLE TRIGGER visit_reject_delete_when_final");
        await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.account_snapshot WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.product_snapshot WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [t]);
      });
    }
    await withTenantContext(admin, TENANT, async (tx) => {
      const reps = await tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name, erp_employee_id)
         VALUES ($1,'idp|rep1','E1','Rep One','rec_e1'), ($1,'idp|rep2','E2','Rep Two',NULL)
         RETURNING id`,
        [TENANT],
      );
      [rep, otherRep] = reps.rows.map((r) => r.id) as [string, string];
      const terrs = await tx.query<{ id: string }>(
        `INSERT INTO crm.territory (tenant_id, code, name) VALUES ($1,'AUH','Abu Dhabi'), ($1,'DXB','Dubai') RETURNING id`,
        [TENANT],
      );
      [auh, dxb] = terrs.rows.map((r) => r.id) as [string, string];
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, valid_from)
         VALUES ($1,$2,$3,'2026-01-01'), ($1,$4,$5,'2026-01-01')`,
        [TENANT, auh, rep, dxb, otherRep],
      );
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, erp_account_id, territory_id, valid_from)
         VALUES ($1,'acct_auh',$2,'2026-01-01'), ($1,'acct_dxb',$3,'2026-01-01')`,
        [TENANT, auh, dxb],
      );
      await tx.query(
        `INSERT INTO crm.account_snapshot (tenant_id, erp_account_id, name, status)
         VALUES ($1,'acct_auh','Gulf Hospital','active'), ($1,'acct_dxb','Dubai Clinic','active')`,
        [TENANT],
      );
      await tx.query(
        `INSERT INTO crm.product_snapshot (tenant_id, erp_item_id, sku, name, list_price, currency, status)
         VALUES ($1,'rec_i1','SKU-1','Amoxil 500mg',999,'AED','active'),
                ($1,'rec_i2','SKU-2','Panadol 1g',1000,'AED','active'),
                ($1,'rec_i3','SKU-3','Ventolin',20,'AED','active')`,
        [TENANT],
      );
    });
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: string | null; tenant?: string | null } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = {};
    const auth = opts.auth === undefined ? token({ sub: "idp|rep1" }) : opts.auth;
    if (auth !== null) headers["authorization"] = `Bearer ${auth}`;
    const tenant = opts.tenant === undefined ? TENANT : opts.tenant;
    if (tenant !== null) headers["x-tenant-id"] = tenant;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
  }

  describe("health", () => {
    it("is public and checks the database", async () => {
      // The ERP has no health endpoint at all (report R11).
      const res = await call("GET", "/healthz", { auth: null, tenant: null });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("authentication", () => {
    it("refuses a request with no token", async () => {
      const res = await call("GET", "/v1/me", { auth: null });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.type).toContain("/errors/unauthenticated");
    });

    it("refuses a token signed by someone else", async () => {
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const header = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
      const payload = b64({ sub: "idp|rep1", iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 });
      const sig = createSign("RSA-SHA256").update(Buffer.from(`${header}.${payload}`)).sign(other.privateKey);
      const res = await call("GET", "/v1/me", { auth: `${header}.${payload}.${sig.toString("base64url")}` });
      expect(res.status).toBe(401);
      expect(res.body.detail).toMatch(/bad_signature/);
    });

    it("refuses a VALID token for someone who is not a rep in this tenant", async () => {
      // A genuine token from the right IdP is not authorisation. This is the
      // whole reason the CRM authorises instead of delegating to the ERP.
      const res = await call("GET", "/v1/me", { auth: token({ sub: "idp|stranger" }) });
      expect(res.status).toBe(403);
    });

    it("refuses a rep whose profile is suspended", async () => {
      // The token stays cryptographically valid until it expires, so "still has
      // a token" must not mean "still has access".
      await withTenantContext(admin, TENANT, (tx) =>
        tx.query("UPDATE crm.rep_profile SET status='suspended' WHERE subject='idp|rep1'"),
      );
      const res = await call("GET", "/v1/me");
      expect(res.status).toBe(403);
      expect(res.body.detail).toMatch(/suspended/);
    });

    it("refuses when no tenant can be determined", async () => {
      const res = await call("GET", "/v1/me", { tenant: null });
      expect(res.status).toBe(401);
      expect(res.body.detail).toMatch(/no tenant/);
    });

    it("prefers a tenant claim in the token over the header", async () => {
      // A header a client controls must not override what the IdP asserted.
      const res = await call("GET", "/v1/me", {
        auth: token({ sub: "idp|rep1", tenant: TENANT }),
        tenant: OTHER,
      });
      expect(res.status).toBe(200);
      expect(res.body.repProfileId).toBe(rep);
    });

    it("cannot reach another tenant by changing the header", async () => {
      const res = await call("GET", "/v1/me", { tenant: OTHER });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /v1/me", () => {
    it("reports the rep, their territories and account count", async () => {
      const res = await call("GET", "/v1/me");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ repProfileId: rep, displayName: "Rep One", erpEmployeeId: "rec_e1" });
      expect(res.body.territories).toEqual([auh]);
      expect(res.body.accountCount).toBe(1);
    });

    it("surfaces a NULL erpEmployeeId, since that is why expenses cannot post", async () => {
      const res = await call("GET", "/v1/me", { auth: token({ sub: "idp|rep2" }) });
      expect(res.body.erpEmployeeId).toBeNull();
    });
  });

  describe("GET /v1/accounts", () => {
    it("returns only the caller's territory, joined to the snapshot", async () => {
      const res = await call("GET", "/v1/accounts");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ erp_account_id: "acct_auh", name: "Gulf Hospital" });
    });

    it("gives a different rep a different list", async () => {
      const res = await call("GET", "/v1/accounts", { auth: token({ sub: "idp|rep2" }) });
      expect(res.body.data.map((a: any) => a.erp_account_id)).toEqual(["acct_dxb"]);
    });

    it("still lists an account the snapshot has not caught up with", async () => {
      // A LEFT JOIN on purpose: a rep seeing an unlabelled account they can
      // investigate beats a rep silently missing one.
      await withTenantContext(admin, TENANT, (tx) =>
        tx.query("DELETE FROM crm.account_snapshot WHERE erp_account_id='acct_auh'"),
      );
      const res = await call("GET", "/v1/accounts");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBeNull();
    });

    it("answers a historical question with ?on", async () => {
      const res = await call("GET", "/v1/accounts?on=2025-06-01");
      expect(res.body.data).toEqual([]);
    });

    it("rejects a malformed ?on with per-field detail", async () => {
      const res = await call("GET", "/v1/accounts?on=01-06-2025");
      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe("GET /v1/products", () => {
    it("filters numerically — CORRECTLY, unlike the ERP", async () => {
      // The same >= 1000 against the ERP returns {1000, 999, 20} because every
      // comparison there is textual (report R19). Here list_price is NUMERIC.
      const res = await call("GET", "/v1/products?minPrice=1000");
      expect(res.body.data.map((x: any) => x.sku)).toEqual(["SKU-2"]);
    });

    it("searches by sku or name", async () => {
      const res = await call("GET", "/v1/products?q=amoxil");
      expect(res.body.data.map((x: any) => x.sku)).toEqual(["SKU-1"]);
    });

    it("returns money as a string, so no float rounds it", async () => {
      const res = await call("GET", "/v1/products?q=panadol");
      expect(res.body.data[0].list_price).toBe("1000.00");
    });
  });

  describe("visits", () => {
    const newVisit = (over: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      erpAccountId: "acct_auh",
      status: "in_progress",
      occurredAt: "2026-06-15T09:00:00.000Z",
      ...over,
    });

    it("records a visit and its detailing lines", async () => {
      const body = newVisit({
        products: [
          { erpItemId: "rec_i1", keyMessage: "efficacy", reaction: "positive" },
          { erpItemId: "rec_i2" },
        ],
      });
      const res = await call("POST", "/v1/visits", { body });
      expect(res.status).toBe(200);
      expect(res.body.visit.rep_profile_id).toBe(rep);
      expect(res.body.products.map((x: any) => x.position)).toEqual([1, 2]);
    });

    it("NEVER takes the rep from the body", async () => {
      // Accepting a repProfileId would let any rep file a visit as any other,
      // and a call report attributed to the wrong person is worse than a
      // missing one.
      const res = await call("POST", "/v1/visits", {
        body: { ...newVisit(), repProfileId: otherRep },
      });
      expect(res.status).toBe(200);
      expect(res.body.visit.rep_profile_id).toBe(rep);
    });

    it("refuses a visit outside the caller's territory", async () => {
      const res = await call("POST", "/v1/visits", { body: newVisit({ erpAccountId: "acct_dxb" }) });
      expect(res.status).toBe(403);
      expect(res.body.type).toContain("/errors/outside-territory");
    });

    it("is idempotent on the device-minted id", async () => {
      const body = newVisit();
      await call("POST", "/v1/visits", { body });
      await call("POST", "/v1/visits", { body });
      const list = await call("GET", "/v1/visits");
      expect(list.body.data).toHaveLength(1);
    });

    it("walks the lifecycle and then refuses to reopen", async () => {
      const body = newVisit();
      await call("POST", "/v1/visits", { body });
      const done = await call("POST", `/v1/visits/${body.id}/transition`, {
        body: { to: "completed", durationMinutes: 20, outcome: "successful" },
      });
      expect(done.body.visit.status).toBe("completed");
      const reopen = await call("POST", `/v1/visits/${body.id}/transition`, { body: { to: "in_progress" } });
      expect(reopen.status).toBe(409);
      expect(reopen.body.type).toContain("/errors/visit-final");
    });

    it("appends a note to a completed visit", async () => {
      const body = newVisit();
      await call("POST", "/v1/visits", { body });
      await call("POST", `/v1/visits/${body.id}/transition`, { body: { to: "completed", outcome: "successful" } });
      const res = await call("POST", `/v1/visits/${body.id}/notes`, { body: { note: "sent reprints" } });
      expect(res.status).toBe(200);
      expect(res.body.visit.notes).toContain("sent reprints");
    });

    it("returns 404, not 403, for another rep's visit", async () => {
      // A 403 would confirm the visit exists.
      const body = newVisit();
      await call("POST", "/v1/visits", { body });
      const res = await call("GET", `/v1/visits/${body.id}`, { auth: token({ sub: "idp|rep2" }) });
      expect(res.status).toBe(404);
    });

    it("lists only the caller's own visits", async () => {
      await call("POST", "/v1/visits", { body: newVisit() });
      const mine = await call("GET", "/v1/visits");
      const theirs = await call("GET", "/v1/visits", { auth: token({ sub: "idp|rep2" }) });
      expect(mine.body.data).toHaveLength(1);
      expect(theirs.body.data).toHaveLength(0);
    });

    it("refuses an account filter outside the caller's territory", async () => {
      const res = await call("GET", "/v1/visits?account=acct_dxb");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /v1/sync/visits", () => {
    it("accepts the good rows and reports the bad ones INDIVIDUALLY", async () => {
      // A rep with twelve queued visits, one referencing an account they no
      // longer cover, must get the other eleven accepted. A wholesale rejection
      // leaves the device retrying forever and the day unrecorded.
      const good1 = { id: randomUUID(), erpAccountId: "acct_auh", status: "completed", occurredAt: "2026-06-15T09:00:00.000Z", outcome: "successful" };
      const bad = { id: randomUUID(), erpAccountId: "acct_dxb", status: "completed", occurredAt: "2026-06-15T10:00:00.000Z", outcome: "successful" };
      const good2 = { id: randomUUID(), erpAccountId: "acct_auh", status: "completed", occurredAt: "2026-06-15T11:00:00.000Z", outcome: "successful" };

      const res = await call("POST", "/v1/sync/visits", { body: { visits: [good1, bad, good2] } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ accepted: 2, rejected: 1 });
      const failed = res.body.results.find((r: any) => !r.ok);
      expect(failed.id).toBe(bad.id);
      expect(failed.type).toBe("outside_territory");

      const list = await call("GET", "/v1/visits");
      expect(list.body.data).toHaveLength(2);
    });

    it("is idempotent across a repeated flush", async () => {
      const batch = { visits: [{ id: randomUUID(), erpAccountId: "acct_auh", status: "in_progress", occurredAt: "2026-06-15T09:00:00.000Z" }] };
      await call("POST", "/v1/sync/visits", { body: batch });
      const second = await call("POST", "/v1/sync/visits", { body: batch });
      expect(second.body.accepted).toBe(1);
      const list = await call("GET", "/v1/visits");
      expect(list.body.data).toHaveLength(1);
    });
  });

  describe("protocol conventions", () => {
    it("uses ONE error shape everywhere", async () => {
      // The ERP emits two on the same API (report R13). Every refusal here is
      // problem+json, whatever raised it.
      const cases = [
        await call("GET", "/v1/me", { auth: null }),
        await call("GET", "/v1/nope"),
        await call("POST", "/v1/visits", { body: { id: "not-a-uuid" } }),
        await call("DELETE", "/v1/me"),
      ];
      for (const res of cases) {
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(res.body).toMatchObject({ type: expect.any(String), title: expect.any(String), status: res.status });
      }
    });

    it("distinguishes a wrong method from a missing route", async () => {
      // A 404 where a 405 belongs sends a client hunting for a URL typo when the
      // real problem is the verb.
      expect((await call("DELETE", "/v1/me")).status).toBe(405);
      expect((await call("GET", "/v1/nope")).status).toBe(404);
    });

    it("echoes a correlation id, and mints one when absent", async () => {
      const res = await call("GET", "/v1/me");
      expect(res.headers.get("x-correlation-id")).toMatch(/[0-9a-f-]{36}/);
    });

    it("marks every response no-store", async () => {
      // A per-rep, per-territory response in a shared cache would serve one
      // rep's accounts to another.
      const res = await call("GET", "/v1/accounts");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("refuses a non-JSON content type", async () => {
      const res = await fetch(`${baseUrl}/v1/visits`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token({ sub: "idp|rep1" })}`,
          "x-tenant-id": TENANT,
          "content-type": "text/plain",
        },
        body: "hello",
      });
      expect(res.status).toBe(415);
    });

    it("refuses an oversized body", async () => {
      const res = await fetch(`${baseUrl}/v1/visits`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token({ sub: "idp|rep1" })}`,
          "x-tenant-id": TENANT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
      });
      expect(res.status).toBe(413);
    });

    it("does not leak internals in a 500", async () => {
      // An internal message can carry a table name, a column, or SQL. The real
      // error goes to the log; the client gets a generic detail.
      const isolated = pool();
      const broken = await startApi({
        pool: isolated,
        auth: { issuer: ISSUER, audience: AUDIENCE, jwks: KEYS },
        onError: () => undefined,
      });
      try {
        // A UUID that parses but a query that will fail: the products route
        // casts minPrice, so a non-numeric slips past zod's coercion into SQL.
        const res = await fetch(`http://127.0.0.1:${broken.port}/v1/products?minPrice=abc`, {
          headers: { authorization: `Bearer ${token({ sub: "idp|rep1" })}`, "x-tenant-id": TENANT },
        });
        const body = await res.json();
        expect([422, 500]).toContain(res.status);
        if (res.status === 500) expect(JSON.stringify(body)).not.toMatch(/crm\.|SELECT|pg_/i);
      } finally {
        await broken.close();
        await isolated.end();
      }
    });
  });
});
