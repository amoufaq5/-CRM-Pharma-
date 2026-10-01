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
        // Call plans and the sample ledger both refuse deletion by design (0016, 0018)
        // and both reference rep_profile with ON DELETE RESTRICT, so the fixture has to
        // disable those guards explicitly and in dependency order.
        for (const table of ["crm.call_plan", "crm.call_plan_target", "crm.call_plan_product",
                             "crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        await tx.query("DELETE FROM crm.sample_count_line WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.sample_count WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.call_plan_target WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.call_plan_product WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.call_plan WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.cycle WHERE tenant_id = $1", [t]);
        for (const table of ["crm.call_plan", "crm.call_plan_target", "crm.call_plan_product",
                             "crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
        }
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

  describe("GET /.well-known/jwks.json", () => {
    /**
     * The endpoint the ERP fetches to verify our service tokens.
     *
     * The 503 case is the one that matters. The ERP keeps its last good key set on
     * a non-200 and REPLACES it with whatever a 200 carries — so a 200 with an empty
     * `keys` array would disarm every verifier that fetched it, and every subsequent
     * ERP call would 401 until a later refresh happened to succeed.
     */
    it("returns 503 rather than an empty key set when no key is published", async () => {
      await admin.query("DELETE FROM crm.service_key");
      const res = await call("GET", "/.well-known/jwks.json", { auth: null, tenant: null });
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('"keys"');
    });

    it("publishes every non-retired key, unauthenticated and cacheable", async () => {
      const { generateServiceKeyPair, PostgresServiceKeyRegistry } = await import("@crm/credential");
      const registry = new PostgresServiceKeyRegistry({ pool: p });
      await admin.query("DELETE FROM crm.service_key");
      const a = generateServiceKeyPair();
      await registry.publish(a.jwk.x);

      const res = await call("GET", "/.well-known/jwks.json", { auth: null, tenant: null });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/jwk-set+json");
      // Deliberately overrides the API's blanket no-store: a JWKS is public keys,
      // identical for every caller, and the ERP refetches on an unknown kid anyway.
      expect(res.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: a.kid, x: a.jwk.x });
      await admin.query("DELETE FROM crm.service_key");
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

  describe("call plans", () => {
    const aPlan = async (): Promise<{ cycleId: string; planId: string }> => {
      let cycleId = "";
      let planId = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on, status)
           VALUES ($1,'Q4','Q4 2026','2026-10-01','2026-12-31','active') RETURNING id`,
          [TENANT],
        );
        cycleId = c.rows[0]!.id;
        const pl = await tx.query<{ id: string }>(
          `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id) VALUES ($1,$2,$3) RETURNING id`,
          [TENANT, cycleId, rep],
        );
        planId = pl.rows[0]!.id;
        await tx.query(
          `INSERT INTO crm.call_plan_target (tenant_id, call_plan_id, erp_account_id, target_calls, segment)
           VALUES ($1,$2,'acct_auh',2,'A')`,
          [TENANT, planId],
        );
        await tx.query(
          `INSERT INTO crm.call_plan_product (tenant_id, call_plan_id, erp_item_id, position)
           VALUES ($1,$2,'rec_i1',1)`,
          [TENANT, planId],
        );
      });
      return { cycleId, planId };
    };

    it("lists the cycles and the one covering a date", async () => {
      await aPlan();
      const all = await call("GET", "/v1/cycles");
      expect(all.status).toBe(200);
      expect(all.body.data).toHaveLength(1);
      const on = await call("GET", "/v1/cycles?on=2026-11-15");
      expect(on.body.data[0].code).toBe("Q4");
    });

    it("returns the caller's own plan with its targets and products", async () => {
      const { planId } = await aPlan();
      const res = await call("GET", `/v1/call-plans/${planId}`);
      expect(res.status).toBe(200);
      expect(res.body.targets).toHaveLength(1);
      expect(res.body.products[0].erp_item_id).toBe("rec_i1");
    });

    /**
     * A 404, not a 403: whether a plan exists is itself information about another rep's
     * territory. The ERP leaks exactly this class of thing by having no row-level
     * scoping at all (report R2).
     */
    it("hides another rep's plan behind a 404", async () => {
      let foreignPlan = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on)
           VALUES ($1,'Q4b','Q4 other','2026-10-01','2026-12-31') RETURNING id`,
          [TENANT],
        );
        const pl = await tx.query<{ id: string }>(
          `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id) VALUES ($1,$2,$3) RETURNING id`,
          [TENANT, c.rows[0]!.id, otherRep],
        );
        foreignPlan = pl.rows[0]!.id;
      });
      const res = await call("GET", `/v1/call-plans/${foreignPlan}`);
      expect(res.status).toBe(404);
      expect(res.body.type).toContain("/errors/not-found");
      // And it is not in the caller's list either.
      expect((await call("GET", "/v1/call-plans")).body.data).toHaveLength(0);
    });

    it("reports adherence with both coverage and attainment", async () => {
      const { planId } = await aPlan();
      await withTenantContext(admin, TENANT, async (tx) => {
        await tx.query(
          `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
           VALUES (gen_random_uuid(),$1,$2,'acct_auh','completed','2026-10-05T09:00:00Z')`,
          [TENANT, rep],
        );
      });
      const res = await call("GET", `/v1/call-plans/${planId}/adherence`);
      expect(res.status).toBe(200);
      expect(res.body.targets[0].actual_calls).toBe(1);
      expect(res.body.targets[0].met).toBe(false);
      expect(res.body.summary.coverage_pct).toBe("100.0");
      expect(res.body.summary.attainment_pct).toBe("50.0");
    });
  });

  describe("sample custody", () => {
    let lotSeq = 0;
    const aLot = async (expiry = "2027-12-31"): Promise<string> => {
      let id = "";
      lotSeq += 1;
      await withTenantContext(admin, TENANT, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
           VALUES ($1,'rec_i1',$3,$2,'drug_sample') RETURNING id`,
          [TENANT, expiry, `LOT-API-${lotSeq}`],
        );
        id = r.rows[0]!.id;
      });
      return id;
    };

    const receipt = (lotId: string, quantity: number): Promise<{ status: number; body: Record<string, unknown> }> =>
      call("POST", "/v1/samples/receipts", {
        body: {
          id: randomUUID(),
          lotId,
          quantity,
          occurredAt: "2026-10-01T08:00:00.000Z",
          erpWarehouseId: "rec_wh1",
        },
      });

    /**
     * The receipt is the one movement that crosses into ERP stock, so it is the one
     * route that writes the outbox — in the same transaction.
     */
    it("records a receipt and enqueues the mirrored StockMovement", async () => {
      const lotId = await aLot();
      const res = await receipt(lotId, 40);
      expect(res.status).toBe(201);
      expect(res.body.erpMirrorEnqueued).toBe(true);

      await withTenantContext(admin, TENANT, async (tx) => {
        const { rows } = await tx.query<{ entity: string; payload: Record<string, unknown> }>(
          "SELECT entity, payload FROM crm.outbox WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.entity).toBe("StockMovement");
        // The CRM's receipt is the ERP's issue: the same event from the other side of
        // the warehouse door.
        expect(rows[0]!.payload["movement_type"]).toBe("issue");
      });

      const holdings = await call("GET", "/v1/samples/holdings");
      expect(holdings.body.data[0].quantity_on_hand).toBe("40.000");
    });

    it("records a disbursement and does NOT mirror it", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const res = await call("POST", "/v1/samples/disbursements", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 2,
          occurredAt: "2026-10-05T09:00:00.000Z",
          erpAccountId: "acct_auh",
          recipientName: "Dr Ada",
          signatureSha256: "a".repeat(64),
        },
      });
      expect(res.status).toBe(201);

      await withTenantContext(admin, TENANT, async (tx) => {
        const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM crm.outbox WHERE tenant_id = $1", [
          TENANT,
        ]);
        // One row, from the receipt. The hand-over is invisible to the ERP because the
        // material already left its warehouse; mirroring it would double-count.
        expect(Number(rows[0]!.n)).toBe(1);
      });
      expect((await call("GET", "/v1/samples/holdings")).body.data[0].quantity_on_hand).toBe("8.000");
    });

    it("refuses a disbursement with no signature, as a validation problem", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const res = await call("POST", "/v1/samples/disbursements", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 1,
          occurredAt: "2026-10-05T09:00:00.000Z",
          erpAccountId: "acct_auh",
          recipientName: "Dr Ada",
        },
      });
      expect(res.status).toBe(422);
      expect(res.body.type).toContain("/errors/validation-failed");
    });

    it("refuses a disbursement to an account outside the caller's territory", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const res = await call("POST", "/v1/samples/disbursements", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 1,
          occurredAt: "2026-10-05T09:00:00.000Z",
          erpAccountId: "acct_dxb",
          recipientName: "Dr Ada",
          signatureSha256: "a".repeat(64),
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("reports what is about to expire and nothing that is not", async () => {
      const soon = await aLot("2026-11-15");
      await receipt(soon, 5);
      const res = await call("GET", "/v1/samples/expiring?withinDays=60&on=2026-10-01");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].days_remaining).toBe(45);

      const narrow = await call("GET", "/v1/samples/expiring?withinDays=10&on=2026-10-01");
      expect(narrow.body.data).toHaveLength(0);
    });

    it("moves material to another rep and back through the transfer routes", async () => {
      const lotId = await aLot();
      await receipt(lotId, 20);
      const sent = await call("POST", "/v1/samples/transfers", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 5,
          occurredAt: "2026-10-06T08:00:00.000Z",
          toRepProfileId: otherRep,
        },
      });
      expect(sent.status).toBe(201);

      const holdings = (await call("GET", "/v1/samples/holdings")).body.data[0];
      expect(holdings.quantity_on_hand).toBe("15.000");
      expect(holdings.quantity_in_transit).toBe("5.000");

      expect((await call("GET", "/v1/samples/transfers")).body.data).toHaveLength(1);

      // The other rep accepts it, with their own token.
      const accepted = await call("POST", `/v1/samples/transfers/${sent.body.id}/accept`, {
        auth: token({ sub: "idp|rep2", tenant: TENANT }),
        body: { id: randomUUID(), occurredAt: "2026-10-07T08:00:00.000Z" },
      });
      expect(accepted.status).toBe(201);
      expect((await call("GET", "/v1/samples/transfers")).body.data).toHaveLength(0);
    });

    /**
     * The offline flush. One bad row must not reject the rest of a rep's day.
     */
    it("flushes a batch of disbursements with per-row results", async () => {
      const good = await aLot();
      const expired = await aLot("2026-09-01");
      await receipt(good, 10);
      await receipt(expired, 10);

      const res = await call("POST", "/v1/sync/disbursements", {
        body: {
          disbursements: [
            {
              id: randomUUID(),
              lotId: good,
              quantity: 1,
              occurredAt: "2026-10-05T09:00:00.000Z",
              erpAccountId: "acct_auh",
              recipientName: "Dr Ada",
              signatureSha256: "a".repeat(64),
            },
            {
              id: randomUUID(),
              lotId: expired,
              quantity: 1,
              occurredAt: "2026-10-05T09:00:00.000Z",
              erpAccountId: "acct_auh",
              recipientName: "Dr Ada",
              signatureSha256: "b".repeat(64),
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected).toBe(1);
      expect(res.body.results[0].ok).toBe(true);
      expect(res.body.results[1].ok).toBe(false);
      expect(res.body.results[1].error).toMatch(/expired/);
    });

    it("is idempotent on a replayed batch", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const row = {
        id: randomUUID(),
        lotId,
        quantity: 3,
        occurredAt: "2026-10-05T09:00:00.000Z",
        erpAccountId: "acct_auh",
        recipientName: "Dr Ada",
        signatureSha256: "a".repeat(64),
      };
      await call("POST", "/v1/sync/disbursements", { body: { disbursements: [row] } });
      const replay = await call("POST", "/v1/sync/disbursements", { body: { disbursements: [row] } });
      expect(replay.body.accepted).toBe(1);
      // Deducted once, not twice. The device-minted id is what makes that true.
      expect((await call("GET", "/v1/samples/holdings")).body.data[0].quantity_on_hand).toBe("7.000");
    });

    it("shows the ledger, newest first", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const res = await call("GET", "/v1/samples/ledger");
      expect(res.status).toBe(200);
      expect(res.body.data[0].kind).toBe("receipt");
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
