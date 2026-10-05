import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool, testPool, TENANT_API as TENANT, TENANT_API_OTHER as OTHER } from "@crm/db/testing";

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

/**
 * `appPool()`, not `testPool()`: this pool is handed to code that opens its OWN
 * connections, and those inherit the pool's role. The admin pool would run every one of
 * them as a superuser, which bypasses row-level security even under `FORCE` — so a
 * missing tenant predicate would be invisible to this whole suite. One was.
 * See the comment on `appPool` in `@crm/db/testing`.
 */

describe("the API, end to end", () => {
  let p: Pool;
  let admin: PoolClient;
  let api: RunningApi;
  let baseUrl = "";
  let rep = "";
  let otherRep = "";
  let manager = "";
  let region = "";
  let auh = "";
  let dxb = "";

  beforeAll(async () => {
    p = appPool();
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
    // Role grants come out FIRST, for both tenants, before any rep_profile is deleted.
    // `revoked_by` is a plain FK to crm.rep_profile (the convention everywhere in this
    // schema), so a grant in one tenant can reference a profile in another — which a
    // cross-tenant leak, since fixed, actually produced here. Clearing per tenant inside
    // the loop below would then fail on the first tenant's profiles.
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        await tx.query("ALTER TABLE crm.rep_role DISABLE TRIGGER USER");
        await tx.query("DELETE FROM crm.rep_role WHERE tenant_id = $1", [t]);
        await tx.query("ALTER TABLE crm.rep_role ENABLE TRIGGER USER");
      });
    }
    for (const t of [TENANT, OTHER]) {
      await withTenantContext(admin, t, async (tx) => {
        // Call plans and the sample ledger both refuse deletion by design (0016, 0018)
        // and both reference rep_profile with ON DELETE RESTRICT, so the fixture has to
        // disable those guards explicitly and in dependency order.
        for (const table of ["crm.call_plan", "crm.call_plan_target", "crm.call_plan_product",
                             "crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        // Notifications reference rep_profile with ON DELETE RESTRICT, and obligations
        // reference the lot the same way, so both go before their targets.
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [t]);
        // Per-tenant policy rows are STATE, not fixtures: leaving one behind made the
        // "documented defaults" test below pass on a fresh database and fail on the
        // second run against the same one.
        await tx.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [t]);
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
        // Before rep_profile: `crm.expense_claim` references it (and `approved_by` /
        // `rejected_by` reference it too), all ON DELETE RESTRICT.
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [t]);
        await tx.query("DELETE FROM crm.expense_account_map WHERE tenant_id = $1", [t]);
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
         VALUES ($1,'idp|rep1','E1','Rep One','rec_e1'), ($1,'idp|rep2','E2','Rep Two',NULL),
                ($1,'idp|mgr','E3','The Manager',NULL)
         RETURNING id`,
        [TENANT],
      );
      [rep, otherRep, manager] = reps.rows.map((r) => r.id) as [string, string, string];
      // A region above both territories, so the manager reaches both reps through the
      // hierarchy rather than by being assigned to each.
      const terrs = await tx.query<{ id: string }>(
        `INSERT INTO crm.territory (tenant_id, code, name)
         VALUES ($1,'GULF','Gulf region'), ($1,'AUH','Abu Dhabi'), ($1,'DXB','Dubai') RETURNING id`,
        [TENANT],
      );
      [region, auh, dxb] = terrs.rows.map((r) => r.id) as [string, string, string];
      await tx.query("UPDATE crm.territory SET parent_id = $1 WHERE id IN ($2,$3)", [region, auh, dxb]);
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary','2026-01-01'), ($1,$4,$5,'primary','2026-01-01'),
                ($1,$6,$7,'manager','2026-01-01')`,
        [TENANT, auh, rep, dxb, otherRep, region, manager],
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

    /**
     * Readiness, not just liveness. A process connected as a privileged role answers
     * `SELECT 1` perfectly and 500s every tenant-scoped request, because
     * `withTenantContext` refuses that connection — so a health check that only pings
     * the database would send a broken rollout live behind a green tick.
     *
     * Started on its own pool so the suite's own API is untouched.
     */
    it("reports NOT ready when connected as a role that bypasses RLS", async () => {
      const privileged = testPool();
      const misconfigured = await startApi({
        pool: privileged,
        auth: { issuer: ISSUER, audience: AUDIENCE, jwks: KEYS },
        onError: () => undefined,
      });
      try {
        const res = await fetch(`http://127.0.0.1:${misconfigured.port}/healthz`);
        const body = (await res.json()) as { status: string; detail: string };
        expect(res.status).toBe(503);
        expect(body.status).toBe("degraded");
        // Names the role, because /healthz is read by the operator who can change it.
        expect(body.detail).toContain("postgres");
        expect(body.detail).toContain("crm_app");
      } finally {
        await misconfigured.close();
        await privileged.end();
      }
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

    /**
     * `occurredAt` is a parameter because a receipt of ALREADY-expired stock is refused
     * (0020): to put expired material in a bag the fixture has to receive it before the
     * expiry, which is also the only way it happens in reality.
     */
    const receipt = (
      lotId: string,
      quantity: number,
      occurredAt = "2026-10-01T08:00:00.000Z",
    ): Promise<{ status: number; body: Record<string, unknown> }> =>
      call("POST", "/v1/samples/receipts", {
        body: { id: randomUUID(), lotId, quantity, occurredAt, erpWarehouseId: "rec_wh1" },
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
      expect((await receipt(good, 10)).status).toBe(201);
      // Received while still in date; it goes stale in the bag.
      expect((await receipt(expired, 10, "2026-08-01T08:00:00.000Z")).status).toBe(201);

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

    it("refuses a receipt of already-expired stock", async () => {
      // If the warehouse sends expired stock the rep does not take custody of it — the
      // warehouse takes it back. Accepting the record would raise a disposal obligation
      // for material that should never have arrived.
      const dead = await aLot("2026-09-01");
      const res = await receipt(dead, 5, "2026-10-01T08:00:00.000Z");
      expect(res.status).toBe(409);
      expect(res.body.type).toContain("/errors/lot-expired");
    });

    describe("disposal obligations", () => {
      /**
       * The sweep is the scheduler's job; here it is called directly so the route can be
       * tested against a real obligation rather than a fabricated row.
       */
      const sweep = async (asOf: string): Promise<void> => {
        const { sweepExpiredStock } = await import("@crm/sample");
        await withTenantContext(admin, TENANT, (tx) =>
          sweepExpiredStock(tx, TENANT, { asOf: new Date(`${asOf}T02:00:00Z`) }),
        );
      };

      const expiredInBag = async (repId: string, quantity: number): Promise<string> => {
        const lotId = await aLot("2026-09-30");
        if (repId === rep) {
          expect((await receipt(lotId, quantity, "2026-08-01T08:00:00.000Z")).status).toBe(201);
        } else {
          expect(
            (
              await call("POST", "/v1/samples/receipts", {
                auth: token({ sub: "idp|rep2", tenant: TENANT }),
                body: {
                  id: randomUUID(),
                  lotId,
                  quantity,
                  occurredAt: "2026-08-01T08:00:00.000Z",
                  erpWarehouseId: "rec_wh1",
                },
              })
            ).status,
          ).toBe(201);
        }
        return lotId;
      };

      it("lists what the caller must dispose of, with the deadline", async () => {
        const lotId = await expiredInBag(rep, 10);
        await sweep("2026-10-10");

        const res = await call("GET", "/v1/samples/obligations?on=2026-10-10");
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].lot_id).toBe(lotId);
        expect(res.body.data[0].due_by).toBe("2026-11-09");
        expect(res.body.data[0].days_overdue).toBe(-30);
        expect(res.body.data[0].quantity_on_hand).toBe("10.000");
      });

      it("closes the obligation once a destruction is recorded", async () => {
        const lotId = await expiredInBag(rep, 10);
        await sweep("2026-10-10");

        const destroyed = await call("POST", "/v1/samples/write-offs", {
          body: {
            id: randomUUID(),
            lotId,
            quantity: 10,
            occurredAt: "2026-10-15T09:00:00.000Z",
            kind: "destruction",
            reason: "destroyed at depot, witnessed by QA",
          },
        });
        expect(destroyed.status).toBe(201);

        await sweep("2026-10-16");
        expect((await call("GET", "/v1/samples/obligations?on=2026-10-16")).body.data).toEqual([]);
      });

      it("refuses a write-off with no reason", async () => {
        const lotId = await expiredInBag(rep, 5);
        const res = await call("POST", "/v1/samples/write-offs", {
          body: {
            id: randomUUID(),
            lotId,
            quantity: 5,
            occurredAt: "2026-10-15T09:00:00.000Z",
            kind: "destruction",
          },
        });
        expect(res.status).toBe(422);
      });

      it("returns stock to the warehouse and mirrors it to the ERP", async () => {
        const lotId = await expiredInBag(rep, 10);
        await withTenantContext(admin, TENANT, async (tx) => {
          await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
        });

        const returned = await call("POST", "/v1/samples/returns", {
          body: {
            id: randomUUID(),
            lotId,
            quantity: 10,
            occurredAt: "2026-10-15T09:00:00.000Z",
            erpWarehouseId: "rec_wh1",
            reason: "expired, returned for central disposal",
          },
        });
        expect(returned.status).toBe(201);
        expect(returned.body.erpMirrorEnqueued).toBe(true);

        await withTenantContext(admin, TENANT, async (tx) => {
          const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
            "SELECT payload FROM crm.outbox WHERE tenant_id = $1",
            [TENANT],
          );
          expect(rows).toHaveLength(1);
          // Stock re-entering ERP inventory is an ERP `receipt` — the mirror inverts in
          // the other direction from a rep receipt.
          expect(rows[0]!.payload["movement_type"]).toBe("receipt");
        });
      });

      it("shows a manager the team's outstanding disposals and a peer nothing", async () => {
        await expiredInBag(rep, 10);
        await expiredInBag(otherRep, 4);
        await sweep("2026-10-10");

        const mgrView = await call("GET", "/v1/team/samples/obligations?on=2026-10-10", {
          auth: token({ sub: "idp|mgr", tenant: TENANT }),
        });
        expect(mgrView.status).toBe(200);
        expect(mgrView.body.data).toHaveLength(2);
        expect(mgrView.body.data[0].display_name).toBeTypeOf("string");

        // A rep manages nobody, so the team view is empty — not their own row.
        expect((await call("GET", "/v1/team/samples/obligations?on=2026-10-10")).body.data).toEqual([]);
      });

      /**
       * The continuation chain, read over HTTP.
       *
       * Built by driving the real thing rather than fabricating rows: receive expired
       * stock, sweep (one obligation), transfer it out, sweep while it is in transit (the
       * obligation resolves as `transferred`), recall it, sweep again (a CONTINUATION, not
       * a fresh obligation). The intervening sweep is the whole point — a recall BETWEEN
       * two sweeps resolves nothing, because `transfer_out` moves the quantity to
       * `quantity_in_transit` and neither rep holds it on hand, so a test whose dates
       * drifted would stop exercising the bug and still pass.
       */
      it("serves the whole obligation chain, with the ledger's word for each resolution", async () => {
        const lotId = await expiredInBag(rep, 10);
        await sweep("2026-10-10");

        const sent = await call("POST", "/v1/samples/transfers", {
          body: {
            id: randomUUID(),
            lotId,
            quantity: 10,
            occurredAt: "2026-10-11T08:00:00.000Z",
            toRepProfileId: otherRep,
          },
        });
        expect(sent.status).toBe(201);
        // In transit: the sender holds nothing on hand, so the obligation resolves.
        await sweep("2026-10-12");

        const recalled = await call("POST", `/v1/samples/transfers/${sent.body.id}/recall`, {
          body: { id: randomUUID(), occurredAt: "2026-10-13T08:00:00.000Z", reason: "sent in error" },
        });
        expect(recalled.status).toBe(201);
        await sweep("2026-10-14");

        const res = await call("GET", `/v1/samples/obligations/${lotId}/history`);
        expect(res.status).toBe(200);
        const chain = res.body.data as readonly Record<string, unknown>[];
        expect(chain).toHaveLength(2);
        expect(chain.map((r) => r["status"])).toEqual(["resolved", "open"]);
        expect(chain.map((r) => r["sequence_number"])).toEqual([1, 2]);

        // The resolved link keeps the ledger's own word for what discharged it — not just
        // "transferred", which is the obligation's view, but the movement kind.
        expect(chain[0]!["resolution"]).toBe("transferred");
        expect(chain[0]!["resolving_transaction_kind"]).toBe("transfer_out");
        expect(chain[0]!["resolving_transaction_id"]).toBe(sent.body.id);

        // And the live link inherited the deadline rather than earning a later one. This
        // is the assertion the whole continuation design exists for: leaving and coming
        // back must not buy time.
        expect(chain[1]!["continues_obligation_id"]).toBe(chain[0]!["id"]);
        expect(chain[1]!["due_by"]).toBe(chain[0]!["due_by"]);
        expect(chain[1]!["discovered_on"]).toBe(chain[0]!["discovered_on"]);
      });

      it("lets a manager read a rep's chain, and a peer read nothing", async () => {
        const lotId = await expiredInBag(rep, 10);
        await sweep("2026-10-10");

        const mgrView = await call("GET", `/v1/samples/obligations/${lotId}/history?repProfileId=${rep}`, {
          auth: token({ sub: "idp|mgr", tenant: TENANT }),
        });
        expect(mgrView.status).toBe(200);
        expect(mgrView.body.data).toHaveLength(1);

        // 404, not 403: whether another rep has an expired lot is information about their
        // compliance record, and `otherRep` manages nobody.
        const peer = await call("GET", `/v1/samples/obligations/${lotId}/history?repProfileId=${rep}`, {
          auth: token({ sub: "idp|rep2", tenant: TENANT }),
        });
        expect(peer.status).toBe(404);
      });

      it("answers an empty chain for a lot with no obligation, rather than 404ing", async () => {
        // A lot the rep holds and that is not expired has no history, and that is a fact
        // about it — distinct from a lot they may not see, which is the 404 above.
        const lotId = await aLot();
        expect((await receipt(lotId, 5)).status).toBe(201);
        const res = await call("GET", `/v1/samples/obligations/${lotId}/history`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      });

      it("serves the tenant's disposal policy read-only", async () => {
        const res = await call("GET", "/v1/samples/disposal-policy");
        expect(res.status).toBe(200);
        expect(res.body.grace_days).toBe(30);
        expect(res.body.auto_writeoff_promo).toBe(false);
        // No write route: these are SOP parameters and there is no compliance role to
        // restrict a write to.
        expect((await call("PUT", "/v1/samples/disposal-policy", { body: { graceDays: 1 } })).status).toBe(405);
      });
    });

    it("shows the ledger, newest first", async () => {
      const lotId = await aLot();
      await receipt(lotId, 10);
      const res = await call("GET", "/v1/samples/ledger");
      expect(res.status).toBe(200);
      expect(res.body.data[0].kind).toBe("receipt");
    });
  });

  describe("the call plan lifecycle over HTTP", () => {
    let cycleId = "";

    const aCycle = async (): Promise<string> => {
      let id = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on, status)
           VALUES ($1,'LC','Lifecycle','2026-10-01','2026-12-31','active') RETURNING id`,
          [TENANT],
        );
        id = c.rows[0]!.id;
      });
      return id;
    };

    const mgr = (): string => token({ sub: "idp|mgr", tenant: TENANT });

    beforeEach(async () => {
      cycleId = await aCycle();
    });

    it("runs draft → submitted → approved, with the manager approving", async () => {
      const created = await call("POST", "/v1/call-plans", { body: { cycleId } });
      expect(created.status).toBe(201);
      const planId = created.body.id as string;

      const target = await call("POST", `/v1/call-plans/${planId}/targets`, {
        body: { erpAccountId: "acct_auh", targetCalls: 2, segment: "A" },
      });
      expect(target.status).toBe(201);

      const products = await call("PUT", `/v1/call-plans/${planId}/products`, {
        body: { products: [{ erpItemId: "rec_i1", keyMessage: "first line" }, { erpItemId: "rec_i2" }] },
      });
      expect(products.status).toBe(200);
      // Positions come from the array order, so a gap or a duplicate is inexpressible.
      expect(products.body.data.map((pr: { position: number }) => pr.position)).toEqual([1, 2]);

      expect((await call("POST", `/v1/call-plans/${planId}/submit`, { body: {} })).body.status).toBe("submitted");

      // The rep cannot approve their own plan — four-eyes, enforced in the schema.
      const selfApprove = await call("POST", `/v1/call-plans/${planId}/approve`, { body: {} });
      expect(selfApprove.status).toBe(403);

      const approved = await call("POST", `/v1/call-plans/${planId}/approve`, {
        auth: mgr(),
        body: { note: "agreed" },
      });
      expect(approved.status).toBe(200);
      expect(approved.body.approved_by).toBe(manager);
    });

    /**
     * A peer rep is refused by `crm.rep_can_supervise`, before any lifecycle rule runs.
     * Without it the database would still refuse on four-eyes grounds, but only because
     * the approver happened not to be the submitter — which is not the same guarantee.
     */
    it("refuses a peer rep's approval with a 404, not a lifecycle error", async () => {
      const planId = (await call("POST", "/v1/call-plans", { body: { cycleId } })).body.id as string;
      await call("POST", `/v1/call-plans/${planId}/submit`, { body: {} });
      const res = await call("POST", `/v1/call-plans/${planId}/approve`, {
        auth: token({ sub: "idp|rep2", tenant: TENANT }),
        body: {},
      });
      expect(res.status).toBe(404);
    });

    it("lets a manager build a plan for a rep they supervise", async () => {
      const created = await call("POST", "/v1/call-plans", {
        auth: mgr(),
        body: { cycleId, repProfileId: rep },
      });
      expect(created.status).toBe(201);
      expect(created.body.rep_profile_id).toBe(rep);

      // The manager submitted it, so the approval must come from someone else again.
      const planId = created.body.id as string;
      await call("POST", `/v1/call-plans/${planId}/submit`, { auth: mgr(), body: {} });
      const res = await call("POST", `/v1/call-plans/${planId}/approve`, { auth: mgr(), body: {} });
      expect(res.status).toBe(403);
    });

    it("refuses building a plan for a rep the caller does not supervise", async () => {
      const res = await call("POST", "/v1/call-plans", { body: { cycleId, repProfileId: otherRep } });
      expect(res.status).toBe(404);
    });

    it("refuses editing an approved plan, and supersedes instead", async () => {
      const planId = (await call("POST", "/v1/call-plans", { body: { cycleId } })).body.id as string;
      await call("POST", `/v1/call-plans/${planId}/targets`, {
        body: { erpAccountId: "acct_auh", targetCalls: 2 },
      });
      await call("POST", `/v1/call-plans/${planId}/submit`, { body: {} });
      await call("POST", `/v1/call-plans/${planId}/approve`, { auth: mgr(), body: {} });

      const frozen = await call("POST", `/v1/call-plans/${planId}/targets`, {
        body: { erpAccountId: "acct_auh", targetCalls: 3 },
      });
      expect(frozen.status).toBe(409);
      expect(frozen.body.type).toContain("/errors/plan-final");

      const superseded = await call("POST", `/v1/call-plans/${planId}/supersede`, { body: {} });
      expect(superseded.status).toBe(201);
      expect(superseded.body.replacement.revision).toBe(2);
      // The replacement inherited the target and is editable again.
      const replacement = superseded.body.replacement.id as string;
      expect((await call("GET", `/v1/call-plans/${replacement}`)).body.targets).toHaveLength(1);
      expect(
        (await call("DELETE", `/v1/call-plans/${replacement}/targets/${
          (await call("GET", `/v1/call-plans/${replacement}`)).body.targets[0].id
        }`)).status,
      ).toBe(204);
    });

    it("sends a submitted plan back for rework", async () => {
      const planId = (await call("POST", "/v1/call-plans", { body: { cycleId } })).body.id as string;
      await call("POST", `/v1/call-plans/${planId}/submit`, { body: {} });
      const returned = await call("POST", `/v1/call-plans/${planId}/return`, { auth: mgr(), body: {} });
      expect(returned.body.status).toBe("draft");
      expect((await call("POST", `/v1/call-plans/${planId}/withdraw`, { body: {} })).body.status).toBe("withdrawn");
    });
  });

  describe("manager views", () => {
    const mgr = (): string => token({ sub: "idp|mgr", tenant: TENANT });

    const aPlanFor = async (repId: string, cycleId: string): Promise<string> => {
      let id = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const pl = await tx.query<{ id: string }>(
          `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id) VALUES ($1,$2,$3) RETURNING id`,
          [TENANT, cycleId, repId],
        );
        id = pl.rows[0]!.id;
      });
      return id;
    };

    const aCycle = async (): Promise<string> => {
      let id = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on, status)
           VALUES ($1,'MV','Manager view','2026-10-01','2026-12-31','active') RETURNING id`,
          [TENANT],
        );
        id = c.rows[0]!.id;
      });
      return id;
    };

    it("lists the team through the hierarchy", async () => {
      const res = await call("GET", "/v1/team", { auth: mgr() });
      expect(res.status).toBe(200);
      expect(res.body.data.map((m: { rep_profile_id: string }) => m.rep_profile_id).sort()).toEqual(
        [rep, otherRep].sort(),
      );
      expect(res.body.data[0].territory_codes).toBeInstanceOf(Array);
    });

    /**
     * "You supervise nobody" is a fact about the hierarchy, not a refusal — so an
     * ordinary rep gets an empty list rather than a 403, and nothing about anyone else's
     * team leaks either way.
     */
    it("returns an empty team for a rep who manages nobody", async () => {
      const res = await call("GET", "/v1/team");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("shows the team's plans and filters to the approval queue", async () => {
      const cycleId = await aCycle();
      const planA = await aPlanFor(rep, cycleId);
      await aPlanFor(otherRep, cycleId);

      const all = await call("GET", `/v1/team/call-plans?cycle=${cycleId}`, { auth: mgr() });
      expect(all.body.data).toHaveLength(2);
      expect(all.body.data[0].display_name).toBeTypeOf("string");

      await withTenantContext(admin, TENANT, async (tx) => {
        await tx.query(
          "UPDATE crm.call_plan SET status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$1",
          [planA, rep],
        );
      });
      const queue = await call("GET", `/v1/team/call-plans?cycle=${cycleId}&status=submitted`, { auth: mgr() });
      expect(queue.body.data.map((pl: { id: string }) => pl.id)).toEqual([planA]);
    });

    it("gives a rep no team plans at all", async () => {
      const cycleId = await aCycle();
      await aPlanFor(otherRep, cycleId);
      expect((await call("GET", `/v1/team/call-plans?cycle=${cycleId}`)).body.data).toEqual([]);
    });

    /**
     * The row with nulls is the point. "Who has not got a plan this cycle" is the first
     * question a territory review asks, and omitting those reps would answer it by
     * making the team look fully covered.
     */
    it("rolls adherence up per rep, including a rep with no plan", async () => {
      const cycleId = await aCycle();
      const planA = await aPlanFor(rep, cycleId);
      await withTenantContext(admin, TENANT, async (tx) => {
        await tx.query(
          `INSERT INTO crm.call_plan_target (tenant_id, call_plan_id, erp_account_id, target_calls)
           VALUES ($1,$2,'acct_auh',2)`,
          [TENANT, planA],
        );
        await tx.query(
          `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
           VALUES (gen_random_uuid(),$1,$2,'acct_auh','completed','2026-10-05T09:00:00Z')`,
          [TENANT, rep],
        );
      });

      const res = await call("GET", `/v1/team/adherence?cycle=${cycleId}`, { auth: mgr() });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);

      const withPlan = res.body.data.find((r: { rep_profile_id: string }) => r.rep_profile_id === rep);
      expect(withPlan.actual_calls).toBe(1);
      expect(withPlan.attainment_pct).toBe("50.0");

      const withoutPlan = res.body.data.find((r: { rep_profile_id: string }) => r.rep_profile_id === otherRep);
      expect(withoutPlan.call_plan_id).toBeNull();
      expect(withoutPlan.targets).toBeNull();
    });

    it("requires a cycle for the adherence rollup rather than guessing one", async () => {
      const res = await call("GET", "/v1/team/adherence", { auth: mgr() });
      expect(res.status).toBe(422);
      expect(res.body.errors.cycle).toBe("required");
    });

    describe("custody oversight", () => {
      const stock = async (repId: string, expiry: string, qty: number): Promise<void> => {
        await withTenantContext(admin, TENANT, async (tx) => {
          const lot = await tx.query<{ id: string }>(
            `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
             VALUES ($1,'rec_i1',$2,$3,'drug_sample') RETURNING id`,
            [TENANT, `LOT-${repId.slice(0, 8)}-${expiry}`, expiry],
          );
          await tx.query(
            `INSERT INTO crm.sample_transaction
               (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
             VALUES (gen_random_uuid(),$1,$2,$3,'receipt',$4,'rec_wh1','2026-10-01T08:00:00Z')`,
            [TENANT, lot.rows[0]!.id, repId, qty],
          );
        });
      };

      it("reports expiring stock across the whole team", async () => {
        await stock(rep, "2026-11-15", 5);
        await stock(otherRep, "2026-11-20", 3);
        await stock(rep, "2027-11-20", 9);

        const res = await call("GET", "/v1/team/samples/expiring?withinDays=60&on=2026-10-01", { auth: mgr() });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        // Soonest first, and each row names the rep holding it.
        expect(res.body.data[0].expiry_date).toBe("2026-11-15");
        expect(res.body.data[0].display_name).toBeTypeOf("string");
      });

      it("gives a rep only their own expiring stock through the team route", async () => {
        await stock(otherRep, "2026-11-20", 3);
        expect((await call("GET", "/v1/team/samples/expiring?on=2026-10-01")).body.data).toEqual([]);
      });

      /**
       * Ordered by whose bag has gone longest without a count, nulls first: the count
       * document only earns its keep if someone can see whose count is overdue.
       */
      it("reports exposure per rep, uncounted first", async () => {
        await stock(rep, "2026-11-15", 5);
        await stock(otherRep, "2026-12-15", 7);
        await withTenantContext(admin, TENANT, async (tx) => {
          await tx.query("UPDATE crm.sample_holding SET last_counted_at = now() WHERE rep_profile_id = $1", [rep]);
        });

        const res = await call("GET", "/v1/team/samples/exposure?on=2026-10-01", { auth: mgr() });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].rep_profile_id).toBe(otherRep);
        expect(res.body.data[0].last_counted_at).toBeNull();
        expect(res.body.data[0].units_on_hand).toBe("7.000");
        expect(res.body.data[1].last_counted_at).not.toBeNull();
      });

      it("shows one rep's custody ledger to their manager and to nobody else", async () => {
        await stock(rep, "2026-11-15", 5);
        const ok = await call("GET", `/v1/team/samples/ledger?rep=${rep}`, { auth: mgr() });
        expect(ok.status).toBe(200);
        expect(ok.body.data[0].kind).toBe("receipt");

        const peer = await call("GET", `/v1/team/samples/ledger?rep=${rep}`, {
          auth: token({ sub: "idp|rep2", tenant: TENANT }),
        });
        expect(peer.status).toBe(404);
      });

      it("shows one rep's visits to their manager", async () => {
        await withTenantContext(admin, TENANT, async (tx) => {
          await tx.query(
            `INSERT INTO crm.visit (id, tenant_id, rep_profile_id, erp_account_id, status, occurred_at)
             VALUES (gen_random_uuid(),$1,$2,'acct_auh','completed','2026-10-05T09:00:00Z')`,
            [TENANT, rep],
          );
        });
        const res = await call("GET", `/v1/team/visits?rep=${rep}`, { auth: mgr() });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect((await call("GET", `/v1/team/visits?rep=${rep}`, { auth: token({ sub: "idp|rep2", tenant: TENANT }) })).status).toBe(404);
      });
    });

    describe("supervised cycle counts", () => {
      it("records a manager's count of a rep's bag and commits the variance", async () => {
        let lotId = "";
        await withTenantContext(admin, TENANT, async (tx) => {
          const lot = await tx.query<{ id: string }>(
            `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
             VALUES ($1,'rec_i1','LOT-COUNT','2027-12-31','drug_sample') RETURNING id`,
            [TENANT],
          );
          lotId = lot.rows[0]!.id;
          await tx.query(
            `INSERT INTO crm.sample_transaction
               (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
             VALUES (gen_random_uuid(),$1,$2,$3,'receipt',20,'rec_wh1','2026-10-01T08:00:00Z')`,
            [TENANT, lotId, rep],
          );
        });

        const count = await call("POST", "/v1/samples/counts", {
          auth: mgr(),
          body: { repProfileId: rep, countedAt: "2026-10-20T09:00:00.000Z", note: "supervised" },
        });
        expect(count.status).toBe(201);
        // The difference between a self-count and a supervised one stays in the data,
        // because a self-count is the weaker evidence.
        expect(count.body.counted_by).toBe(manager);
        expect(count.body.rep_profile_id).toBe(rep);

        const countId = count.body.id as string;
        const line = await call("POST", `/v1/samples/counts/${countId}/lines`, {
          auth: mgr(),
          body: { lotId, countedQuantity: 17 },
        });
        expect(line.body.expected_quantity).toBe("20.000");

        const detail = await call("GET", `/v1/samples/counts/${countId}`, { auth: mgr() });
        expect(detail.body.lines[0].variance).toBe("-3.000");

        const committed = await call("POST", `/v1/samples/counts/${countId}/commit`, { auth: mgr(), body: {} });
        expect(committed.body.adjustments).toBe(1);

        // The balance moved through the ledger, not by an edit.
        const ledger = await call("GET", `/v1/team/samples/ledger?rep=${rep}`, { auth: mgr() });
        expect(ledger.body.data[0].kind).toBe("adjustment_out");
        expect(ledger.body.data[0].reason).toMatch(/cycle count/);
      });

      it("refuses to count a rep the caller does not supervise", async () => {
        const res = await call("POST", "/v1/samples/counts", {
          body: { repProfileId: otherRep, countedAt: "2026-10-20T09:00:00.000Z" },
        });
        expect(res.status).toBe(404);
      });

      it("lets a rep open a self-count, recorded as such", async () => {
        const res = await call("POST", "/v1/samples/counts", {
          body: { countedAt: "2026-10-20T09:00:00.000Z" },
        });
        expect(res.status).toBe(201);
        expect(res.body.rep_profile_id).toBe(rep);
        expect(res.body.counted_by).toBe(rep);
        expect((await call("POST", `/v1/samples/counts/${res.body.id as string}/cancel`, { body: {} })).status).toBe(204);
      });

      it("hides a count of someone else's bag behind a 404", async () => {
        const count = await call("POST", "/v1/samples/counts", {
          auth: mgr(),
          body: { repProfileId: rep, countedAt: "2026-10-20T09:00:00.000Z" },
        });
        const res = await call("GET", `/v1/samples/counts/${count.body.id as string}`, {
          auth: token({ sub: "idp|rep2", tenant: TENANT }),
        });
        expect(res.status).toBe(404);
      });
    });
  });

  describe("the inbox", () => {
    const mgr = (): string => token({ sub: "idp|mgr", tenant: TENANT });

    /** Raised through the real producer rather than an inserted row. */
    const aSubmittedPlan = async (): Promise<void> => {
      let cycleId = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on, status)
           VALUES ($1,'IB','Inbox','2026-10-01','2026-12-31','active') RETURNING id`,
          [TENANT],
        );
        cycleId = c.rows[0]!.id;
      });
      const plan = await call("POST", "/v1/call-plans", { body: { cycleId } });
      await call("POST", `/v1/call-plans/${plan.body.id as string}/submit`, { body: {} });
    };

    it("serves the caller's notifications with an unread count", async () => {
      await aSubmittedPlan();

      // The manager was told; the rep who submitted it was not.
      const theirs = await call("GET", "/v1/notifications", { auth: mgr() });
      expect(theirs.status).toBe(200);
      expect(theirs.body.data).toHaveLength(1);
      expect(theirs.body.data[0].kind).toBe("call_plan_submitted");
      expect((await call("GET", "/v1/notifications/unread-count", { auth: mgr() })).body.count).toBe(1);

      expect((await call("GET", "/v1/notifications")).body.data).toEqual([]);
      expect((await call("GET", "/v1/notifications/unread-count")).body.count).toBe(0);
    });

    it("marks one read, idempotently, and filters to unread", async () => {
      await aSubmittedPlan();
      const id = (await call("GET", "/v1/notifications", { auth: mgr() })).body.data[0].id as string;

      expect((await call("POST", `/v1/notifications/${id}/read`, { auth: mgr(), body: {} })).status).toBe(204);
      expect((await call("GET", "/v1/notifications/unread-count", { auth: mgr() })).body.count).toBe(0);
      // Reading again is success: a client retrying must not get an error.
      expect((await call("POST", `/v1/notifications/${id}/read`, { auth: mgr(), body: {} })).status).toBe(204);

      expect((await call("GET", "/v1/notifications?unread=true", { auth: mgr() })).body.data).toEqual([]);
      expect((await call("GET", "/v1/notifications", { auth: mgr() })).body.data).toHaveLength(1);
    });

    /** A 404, not a 403: whether a notification exists is information about someone's work. */
    it("hides another rep's notification behind a 404", async () => {
      await aSubmittedPlan();
      const id = (await call("GET", "/v1/notifications", { auth: mgr() })).body.data[0].id as string;
      const res = await call("POST", `/v1/notifications/${id}/read`, { body: {} });
      expect(res.status).toBe(404);
      expect(res.body.type).toContain("/errors/not-found");
    });

    it("marks everything read and reports how many", async () => {
      await aSubmittedPlan();
      const res = await call("POST", "/v1/notifications/read-all", { auth: mgr(), body: {} });
      expect(res.body.marked).toBe(1);
      expect((await call("POST", "/v1/notifications/read-all", { auth: mgr(), body: {} })).body.marked).toBe(0);
    });

    it("reaches the receiving rep when material is transferred to them", async () => {
      let lotId = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const l = await tx.query<{ id: string }>(
          `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
           VALUES ($1,'rec_i1','LOT-INBOX','2027-12-31','drug_sample') RETURNING id`,
          [TENANT],
        );
        lotId = l.rows[0]!.id;
      });
      await call("POST", "/v1/samples/receipts", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 10,
          occurredAt: "2026-10-01T08:00:00.000Z",
          erpWarehouseId: "rec_wh1",
        },
      });
      await call("POST", "/v1/samples/transfers", {
        body: {
          id: randomUUID(),
          lotId,
          quantity: 4,
          occurredAt: "2026-10-06T08:00:00.000Z",
          toRepProfileId: otherRep,
        },
      });

      const theirs = await call("GET", "/v1/notifications", {
        auth: token({ sub: "idp|rep2", tenant: TENANT }),
      });
      expect(theirs.body.data).toHaveLength(1);
      expect(theirs.body.data[0].kind).toBe("sample_transfer_awaiting_acceptance");
    });
  });

  describe("writes the ERP refused", () => {
    const mgr = (): string => token({ sub: "idp|mgr", tenant: TENANT });

    /** A real producer and a real dead-lettered outbox row behind it. */
    const aDeadWrite = async (repId: string): Promise<string> => {
      let outboxId = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const claim = await tx.query<{ id: string }>(
          `INSERT INTO crm.expense_claim (tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
           VALUES ($1,$2,'detailing',40.00,'AED','2026-10-05') RETURNING id`,
          [TENANT, repId],
        );
        const row = await tx.query<{ id: string }>(
          `INSERT INTO crm.outbox
             (tenant_id, entity, operation, payload, target_record_id, source_table, source_id,
              state, attempts, dead_at, dead_reason)
           VALUES ($1,'Expense','create','{}'::jsonb,$2,'crm.expense_claim',$3,
                   'dead', 1, now(), 'ERP refused: ledger account 6200 does not exist')
           RETURNING id`,
          [TENANT, `crm_dead_${Math.random().toString(36).slice(2, 10)}`, claim.rows[0]!.id],
        );
        outboxId = row.rows[0]!.id;
      });
      return outboxId;
    };

    const cleanup = async (): Promise<void> => {
      await withTenantContext(admin, TENANT, async (tx) => {
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
      });
    };

    it("lists the caller's failed writes with the reason", async () => {
      const id = await aDeadWrite(rep);
      try {
        const res = await call("GET", "/v1/erp-writes/failed");
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(id);
        expect(res.body.data[0].dead_reason).toMatch(/ledger account 6200/);
        expect(res.body.data[0].revive_count).toBe(0);
        // And not another rep's.
        expect((await call("GET", "/v1/erp-writes/failed", {
          auth: token({ sub: "idp|rep2", tenant: TENANT }),
        })).body.data).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("shows a manager the team's, and a peer rep nothing", async () => {
      await aDeadWrite(rep);
      try {
        expect((await call("GET", "/v1/team/erp-writes/failed", { auth: mgr() })).body.data).toHaveLength(1);
        expect((await call("GET", "/v1/team/erp-writes/failed")).body.data).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    /**
     * Retrying re-sends the SAME payload, which is the useful thing once the ERP side has
     * been fixed — and useless if the payload itself is wrong, in which case it dies again
     * and the revive count says so.
     */
    it("queues a failed write again and reports the revive count", async () => {
      const id = await aDeadWrite(rep);
      try {
        const res = await call("POST", `/v1/erp-writes/${id}/retry`, { body: {} });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ queued: true, reviveCount: 1 });

        await withTenantContext(admin, TENANT, async (tx) => {
          const { rows } = await tx.query<{ state: string; attempts: number; revived_by: string }>(
            "SELECT state, attempts, revived_by FROM crm.outbox WHERE id = $1",
            [id],
          );
          expect(rows[0]!.state).toBe("pending");
          expect(rows[0]!.attempts).toBe(0);
          expect(rows[0]!.revived_by).toBe(rep);
        });

        // No longer dead, so it is gone from the list and a second retry conflicts.
        expect((await call("GET", "/v1/erp-writes/failed")).body.data).toEqual([]);
        expect((await call("POST", `/v1/erp-writes/${id}/retry`, { body: {} })).status).toBe(404);
      } finally {
        await cleanup();
      }
    });

    it("lets a manager retry a supervised rep's write", async () => {
      const id = await aDeadWrite(rep);
      try {
        expect((await call("POST", `/v1/erp-writes/${id}/retry`, { auth: mgr(), body: {} })).status).toBe(200);
      } finally {
        await cleanup();
      }
    });

    it("hides another rep's failed write behind a 404", async () => {
      const id = await aDeadWrite(rep);
      try {
        const res = await call("POST", `/v1/erp-writes/${id}/retry`, {
          auth: token({ sub: "idp|rep2", tenant: TENANT }),
          body: {},
        });
        expect(res.status).toBe(404);
        expect(res.body.type).toContain("/errors/not-found");
      } finally {
        await cleanup();
      }
    });

    /**
     * A row whose producer cannot be attributed to a rep is deliberately unreachable here:
     * nobody was notified about it either, and an operator reaches it through the SQL
     * listing. Making it retryable by anyone would be the wrong way to close that gap.
     */
    it("refuses to retry an unattributable write", async () => {
      let id = "";
      await withTenantContext(admin, TENANT, async (tx) => {
        const row = await tx.query<{ id: string }>(
          `INSERT INTO crm.outbox
             (tenant_id, entity, operation, payload, target_record_id, source_table, source_id,
              state, dead_at, dead_reason)
           VALUES ($1,'Item','create','{}'::jsonb,$2,'crm.unmapped_thing',gen_random_uuid(),
                   'dead', now(), 'ERP refused')
           RETURNING id`,
          [TENANT, `crm_orphan_${Math.random().toString(36).slice(2, 10)}`],
        );
        id = row.rows[0]!.id;
      });
      try {
        expect((await call("POST", `/v1/erp-writes/${id}/retry`, { auth: mgr(), body: {} })).status).toBe(404);
      } finally {
        await cleanup();
      }
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
      const isolated = appPool();
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
  /**
   * Administration (0023).
   *
   * The reason these routes exist at all: before the role model, `crm.disposal_policy`
   * and `crm.notification_endpoint` were settable only at a psql prompt, which meant
   * settable by anyone holding the application password with no record of who changed
   * what. So the tests that matter here are the refusals — a rep with no grant, and a
   * MANAGER with a full team, must both be turned away from a tenant-wide parameter.
   */
  /**
   * The expense claim lifecycle over HTTP, and the four-eyes rule on all four decisions.
   *
   * These routes had no coverage here at all, which is how the hole below shipped:
   * `rep_can_supervise` answers YES for the caller themselves — correct for a read, where a
   * rep may always see their own work — and all four write transitions gated on supervision
   * alone. `expense_claim_four_eyes` caught the approve in the database; `post` and
   * `reimburse` record no actor, so nothing downstream could catch those. A rep could hand
   * their own claim to the ledger and mark it paid.
   */
  describe("expense claims", () => {
    const mapCategory = async (): Promise<void> => {
      await withTenantContext(admin, TENANT, (tx) =>
        tx.query(
          `INSERT INTO crm.expense_account_map
             (tenant_id, crm_category, erp_ledger_account_code, is_active)
           VALUES ($1, 'client_meal', '6100', true)`,
          [TENANT],
        ),
      );
    };

    const mgrToken = (): string => token({ sub: "idp|mgr" });

    /** A claim filed by `rep` and submitted, which is where every decision starts. */
    const submitted = async (): Promise<string> => {
      await mapCategory();
      const created = await call("POST", "/v1/expenses", {
        body: { crmCategory: "client_meal", amount: "120.50", currency: "AED", incurredOn: "2026-09-01" },
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect((await call("POST", `/v1/expenses/${id}/submit`)).status).toBe(200);
      return id;
    };

    it("files, submits, approves, posts and reimburses — with two different people", async () => {
      const id = await submitted();
      // The manager supervises `rep` through the region, and is not the claimant.
      const approved = await call("POST", `/v1/expenses/${id}/approve`, { auth: mgrToken() });
      expect(approved.status).toBe(200);
      expect(approved.body.state).toBe("approved");
      expect(approved.body.approved_by).toBe(manager);

      const posted = await call("POST", `/v1/expenses/${id}/post`, { auth: mgrToken() });
      expect(posted.status).toBe(200);
      expect(posted.body.claim.state).toBe("posted");

      const paid = await call("POST", `/v1/expenses/${id}/reimburse`, { auth: mgrToken() });
      expect(paid.status).toBe(200);
      expect(paid.body.claim.state).toBe("reimbursed");
    });

    /**
     * The hole, on each of the four decisions.
     *
     * 403 and not the 404 every other scoped record gets: the caller IS the claimant, so
     * pretending the claim does not exist tells them something they know to be false, and
     * there is nothing left to conceal from the person whose money it is.
     */
    it("refuses the claimant their own approve and reject, in the route", async () => {
      const id = await submitted();
      for (const verb of ["approve", "reject"] as const) {
        const res = await call("POST", `/v1/expenses/${id}/${verb}`);
        expect(res.status, verb).toBe(403);
        // The 403 was already there for these two — `expense_claim_four_eyes` and 0030's
        // `expense_claim_reject_four_eyes` produce one — but with no explanation, because
        // a constraint violation does not know what the caller was trying to do. The route
        // is where a refusal can say which rule was broken.
        expect(JSON.stringify(res.body), verb).toMatch(/by the rep who filed it/);
      }
    });

    /**
     * The half nothing downstream could catch, and the reason the rule belongs in the route.
     *
     * `post` and `reimburse` record no actor — there is no `posted_by` column for a CHECK
     * to compare — so until this check existed a rep who had been legitimately approved
     * could hand their own claim to the ledger and mark it paid, alone. These two asserted
     * 200 before the fix.
     */
    it("refuses the claimant their own post and reimburse, which no CHECK can", async () => {
      const id = await submitted();
      expect((await call("POST", `/v1/expenses/${id}/approve`, { auth: mgrToken() })).status).toBe(200);
      for (const verb of ["post", "reimburse"] as const) {
        const res = await call("POST", `/v1/expenses/${id}/${verb}`);
        expect(res.status, verb).toBe(403);
        expect(JSON.stringify(res.body), verb).toMatch(/by the rep who filed it/);
      }
      // And the claim did not move — nothing was enqueued to the ERP either.
      await withTenantContext(admin, TENANT, async (tx) => {
        const { rows } = await tx.query<{ state: string }>(
          "SELECT state FROM crm.expense_claim WHERE id = $1",
          [id],
        );
        expect(rows[0]!.state).toBe("approved");
        const { rows: out } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.outbox WHERE tenant_id = $1 AND source_id = $2",
          [TENANT, id],
        );
        expect(Number(out[0]!.n)).toBe(0);
      });
    });

    it("records who rejected a claim, and when", async () => {
      const id = await submitted();
      const rejected = await call("POST", `/v1/expenses/${id}/reject`, { auth: mgrToken() });
      expect(rejected.status).toBe(200);
      expect(rejected.body.state).toBe("rejected");
      // 0030. Before it, a rejection was a state with no actor and no timestamp — the one
      // decision in the lifecycle that left no record of who made it.
      expect(rejected.body.rejected_by).toBe(manager);
      expect(rejected.body.rejected_at).not.toBeNull();
      expect(rejected.body.approved_at).toBeNull();
    });

    it("still refuses a decision from someone outside the claimant's line", async () => {
      // Four eyes is not the only rule: `otherRep` is neither the claimant nor a
      // supervisor, and gets the 404 that every other cross-rep read gets, because whether
      // another rep's claim exists is information about their spending.
      const id = await submitted();
      const res = await call("POST", `/v1/expenses/${id}/approve`, { auth: token({ sub: "idp|rep2" }) });
      expect(res.status).toBe(404);
    });

    it("refuses to submit while Finance has mapped no account for the category", async () => {
      const created = await call("POST", "/v1/expenses", {
        body: { crmCategory: "unmapped_thing", amount: "10.00", currency: "AED", incurredOn: "2026-09-01" },
      });
      expect(created.status).toBe(201);
      const res = await call("POST", `/v1/expenses/${created.body.id}/submit`);
      // The designed refusal, and the behaviour the whole design turns on — not a 500.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("refuses an amount of zero on the characters, not on a float", async () => {
      for (const amount of ["0", "0.00", "00.0"]) {
        const res = await call("POST", "/v1/expenses", {
          body: { crmCategory: "client_meal", amount, currency: "AED", incurredOn: "2026-09-01" },
        });
        expect(res.status, amount).toBe(422);
      }
      // And the smallest real amount is accepted, which is what the test above would also
      // pass if the check were simply "refuse everything".
      await mapCategory();
      const ok = await call("POST", "/v1/expenses", {
        body: { crmCategory: "client_meal", amount: "0.01", currency: "AED", incurredOn: "2026-09-01" },
      });
      expect(ok.status).toBe(201);
    });

    it("reports the claim's ERP writes in the order they were enqueued", async () => {
      const id = await submitted();
      expect((await call("POST", `/v1/expenses/${id}/approve`, { auth: mgrToken() })).status).toBe(200);
      expect((await call("POST", `/v1/expenses/${id}/post`, { auth: mgrToken() })).status).toBe(200);
      expect((await call("POST", `/v1/expenses/${id}/reimburse`, { auth: mgrToken() })).status).toBe(200);
      const erp = await call("GET", `/v1/expenses/${id}/erp`);
      expect(erp.status).toBe(200);
      // `create` before `reimburse`, by `seq` — 0027's sequence, not a `created_at` that
      // two rows written in one transaction share to the microsecond.
      expect(erp.body.data.map((r: { operation: string }) => r.operation)).toEqual([
        "create",
        "transition:reimburse",
      ]);
    });

    it("advertises the ERP's own code length, not a longer one", async () => {
      // The route validated these at 64 while the store refused anything over 32, which is
      // the ERP's real `maxLength` on LedgerAccount.account_code and CostCenter.code. Both
      // ended in a 422; the route just promised a contract the layer behind it rejected.
      await withTenantContext(admin, TENANT, (tx) =>
        tx.query("DELETE FROM crm.rep_role WHERE tenant_id = $1", [TENANT]),
      );
      const id = await withTenantContext(admin, TENANT, (tx) =>
        tx.query(
          `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from)
           VALUES ($1,$2,'administrator',$3,CURRENT_DATE) RETURNING id`,
          [TENANT, rep, manager],
        ),
      );
      expect(id.rows).toHaveLength(1);
      const res = await call("PUT", "/v1/admin/expense-accounts/client_meal", {
        body: { erpLedgerAccountCode: "6".repeat(33) },
      });
      expect(res.status).toBe(422);
    });
  });

  describe("administration", () => {
    const repToken = token({ sub: "idp|rep1" });
    const mgrToken = token({ sub: "idp|mgr" });

    /** Grants in SQL, as the first administrator of a tenant always must be (0023). */
    const grant = async (
      who: () => string,
      role: "administrator" | "compliance",
      by: () => string,
      validTo: string | null = null,
      validFrom: string | null = null,
    ): Promise<string> => {
      const { rows } = await withTenantContext(admin, TENANT, (tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, valid_to)
           VALUES ($1,$2,$3,$4,COALESCE($6::date, CURRENT_DATE),$5::date) RETURNING id`,
          [TENANT, who(), role, by(), validTo, validFrom],
        ),
      );
      return rows[0]!.id;
    };

    it("tells the caller which roles they hold", async () => {
      expect((await call("GET", "/v1/me/roles")).body.roles).toEqual([]);
      await grant(() => rep, "compliance", () => manager);
      expect((await call("GET", "/v1/me/roles")).body.roles).toEqual(["compliance"]);
    });

    describe("the disposal policy", () => {
      it("is readable by every rep, because every rep is held to it", async () => {
        const res = await call("GET", "/v1/samples/disposal-policy");
        expect(res.status).toBe(200);
        expect(res.body.grace_days).toBe(30);
      });

      it("refuses a write from a rep with no role — 403, not 404", async () => {
        const res = await call("PUT", "/v1/admin/samples/disposal-policy", { body: { graceDays: 7 } });
        expect(res.status).toBe(403);
        expect(res.body.detail).toContain("compliance");
        // 403 and not the 404 the supervision routes return: the resource is the
        // tenant's own configuration, which every rep can already read, so hiding it
        // would only send a lapsed officer hunting for a typo.
        expect(res.body.type).toMatch(/\/forbidden$/);
      });

      /**
       * The refusal this role model exists to make possible. A district manager with a
       * full team is the most privileged principal the CRM had before 0023, and a
       * tenant-wide SOP parameter is exactly what they must not be able to change —
       * their own team is measured against it.
       */
      it("refuses a write from a manager who supervises a whole region", async () => {
        const roster = await call("GET", "/v1/team", { auth: mgrToken });
        expect(roster.body.data.length).toBeGreaterThan(0);
        const res = await call("PUT", "/v1/admin/samples/disposal-policy", {
          body: { graceDays: 7 },
          auth: mgrToken,
        });
        expect(res.status).toBe(403);
      });

      it("accepts a write from the compliance officer", async () => {
        await grant(() => rep, "compliance", () => manager);
        const res = await call("PUT", "/v1/admin/samples/disposal-policy", {
          body: { graceDays: 14, autoWriteoffPromo: true },
          auth: repToken,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ grace_days: 14, auto_writeoff_promo: true });
        expect((await call("GET", "/v1/samples/disposal-policy")).body.grace_days).toBe(14);
      });

      it("refuses a grace period outside the range the SOP allows", async () => {
        await grant(() => rep, "compliance", () => manager);
        expect((await call("PUT", "/v1/admin/samples/disposal-policy", { body: { graceDays: 400 } })).status).toBe(422);
      });

      it("refuses an empty change rather than reporting a no-op as success", async () => {
        await grant(() => rep, "compliance", () => manager);
        expect((await call("PUT", "/v1/admin/samples/disposal-policy", { body: {} })).status).toBe(422);
      });

      it("does not accept the administrator role in place of compliance", async () => {
        await grant(() => rep, "administrator", () => manager);
        expect((await call("PUT", "/v1/admin/samples/disposal-policy", { body: { graceDays: 7 } })).status).toBe(403);
      });
    });

    describe("notification endpoints", () => {
      it("refuses to even list them without the administrator role", async () => {
        expect((await call("GET", "/v1/admin/notification-endpoints")).status).toBe(403);
      });

      it("creates, lists and disables one", async () => {
        await grant(() => rep, "administrator", () => manager);
        const created = await call("POST", "/v1/admin/notification-endpoints", {
          body: {
            channel: "webhook",
            url: "https://hooks.example.test/crm",
            secretEnv: "CRM_OPS_WEBHOOK_SECRET",
            minSeverity: "urgent",
            kinds: ["erp_write_failed"],
            description: "ops channel",
          },
        });
        expect(created.status).toBe(201);
        expect(created.body.min_severity).toBe("urgent");
        expect(created.body.secret_env).toBe("CRM_OPS_WEBHOOK_SECRET");

        const listed = await call("GET", "/v1/admin/notification-endpoints");
        expect(listed.body.data).toHaveLength(1);

        const patched = await call("PATCH", `/v1/admin/notification-endpoints/${created.body.id}`, {
          body: { enabled: false },
        });
        expect(patched.status).toBe(200);
        expect(patched.body.enabled).toBe(false);
        // There is no DELETE: crm.notification_delivery cascades from this row, so
        // removing an endpoint would erase the record of everything sent to it.
        expect((await call("DELETE", `/v1/admin/notification-endpoints/${created.body.id}`)).status).toBe(405);
      });

      it("refuses a plaintext destination, as a 422 that says why", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/notification-endpoints", {
          body: { channel: "webhook", url: "http://hooks.example.test/crm", secretEnv: "CRM_OPS_WEBHOOK_SECRET" },
        });
        // 422 and not 500. This assertion was `>= 400` and the refusal was in fact an
        // untranslated CHECK violation surfacing as "an unexpected error occurred" — which
        // turned one of the schema's most deliberate rules into a bug report.
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).toContain("does not travel in the clear");
      });

      it("refuses a secret VALUE where an environment variable NAME belongs", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/notification-endpoints", {
          body: { channel: "webhook", url: "https://hooks.example.test/crm", secretEnv: "hunter2-actual-secret" },
        });
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).toContain("environment variable");
      });

      it("refuses a kind that does not exist, which would make the endpoint silently dead", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/notification-endpoints", {
          body: {
            channel: "webhook",
            url: "https://hooks.example.test/crm",
            secretEnv: "CRM_OPS_WEBHOOK_SECRET",
            kinds: ["everything_please"],
          },
        });
        expect(res.status).toBe(422);
      });

      /**
       * The email channel, reachable from the route it was always supposed to be reachable
       * from.
       *
       * `createEndpoint` wrote `'webhook'` as a LITERAL, so 0029 could widen the CHECK to
       * admit `email` and the only way to use it was psql — a shipped, documented channel
       * with ~1,400 lines behind it that nothing above SQL could name.
       */
      it("creates an email endpoint, and holds it to the mailto: shape", async () => {
        await grant(() => rep, "administrator", () => manager);
        const created = await call("POST", "/v1/admin/notification-endpoints", {
          body: {
            channel: "email",
            url: "mailto:ops@example.test",
            secretEnv: "CRM_SMTP_PASSWORD",
            minSeverity: "urgent",
          },
        });
        expect(created.status).toBe(201);
        expect(created.body.channel).toBe("email");
        expect(created.body.url).toBe("mailto:ops@example.test");

        // Per-channel, not a flat disjunction: an https url is valid for a webhook and
        // invalid for email, and 0029 checks the PAIR precisely so neither mismatch can be
        // stored with no sender and no error.
        const wrongUrl = await call("POST", "/v1/admin/notification-endpoints", {
          body: { channel: "email", url: "https://hooks.example.test/crm", secretEnv: "CRM_SMTP_PASSWORD" },
        });
        expect(wrongUrl.status).toBeGreaterThanOrEqual(400);
        expect(wrongUrl.status).toBeLessThan(500);

        const mailboxAsWebhook = await call("POST", "/v1/admin/notification-endpoints", {
          body: { channel: "webhook", url: "mailto:ops@example.test", secretEnv: "CRM_OPS_WEBHOOK_SECRET" },
        });
        expect(mailboxAsWebhook.status).toBeGreaterThanOrEqual(400);
        expect(mailboxAsWebhook.status).toBeLessThan(500);
      });

      it("refuses a channel nothing sends, naming the ones it does", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/notification-endpoints", {
          body: { channel: "carrier_pigeon", url: "https://hooks.example.test/crm", secretEnv: "CRM_OPS_WEBHOOK_SECRET" },
        });
        expect(res.status).toBe(422);
      });

      it("has no default channel: an omitted one is a 422, not a webhook", async () => {
        // A default would leave the next channel as unreachable as email was, and the url
        // shape is channel-dependent, so a caller that does not know which channel it
        // means does not know whether its url is valid either.
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/notification-endpoints", {
          body: { url: "https://hooks.example.test/crm", secretEnv: "CRM_OPS_WEBHOOK_SECRET" },
        });
        expect(res.status).toBe(422);
      });

      it("404s a PATCH to an endpoint that is not there", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("PATCH", "/v1/admin/notification-endpoints/e8000000-0000-4000-8000-00000000000f", {
          body: { enabled: false },
        });
        expect(res.status).toBe(404);
      });
    });

    describe("notification retention", () => {
      it("is readable by every rep, with the documented defaults", async () => {
        const res = await call("GET", "/v1/admin/notifications/retention");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ retain_read_days: 30, retain_unread_days: 365 });
      });

      it("refuses a write without the administrator role", async () => {
        const res = await call("PUT", "/v1/admin/notifications/retention", { body: { retainReadDays: 7 } });
        expect(res.status).toBe(403);
        expect(res.body.detail).toContain("administrator");
      });

      /**
       * Administrator rather than compliance, and the compliance officer does NOT get it.
       * The disposal policy next door is the other way round — the split is the point:
       * one is an SOP parameter reps are measured against, the other is a statement about
       * the system's own storage.
       */
      it("does not accept the compliance role in place of administrator", async () => {
        await grant(() => rep, "compliance", () => manager);
        expect((await call("PUT", "/v1/admin/notifications/retention", { body: { retainReadDays: 7 } })).status).toBe(403);
      });

      it("sets the horizons for an administrator", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("PUT", "/v1/admin/notifications/retention", {
          body: { retainReadDays: 14, retainUnreadDays: 180 },
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ retain_read_days: 14, retain_unread_days: 180 });
        expect((await call("GET", "/v1/admin/notifications/retention")).body.retain_read_days).toBe(14);
      });

      it("refuses an unread horizon shorter than the read one, as a 422", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("PUT", "/v1/admin/notifications/retention", {
          body: { retainReadDays: 90, retainUnreadDays: 7 },
        });
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).toContain("sooner than a read one");
      });

      it("refuses an empty change rather than reporting a no-op as success", async () => {
        await grant(() => rep, "administrator", () => manager);
        expect((await call("PUT", "/v1/admin/notifications/retention", { body: {} })).status).toBe(422);
      });

      it("lists prune candidates for an administrator and nobody else", async () => {
        expect((await call("GET", "/v1/admin/notifications/prune-candidates")).status).toBe(403);
        await grant(() => rep, "administrator", () => manager);
        const res = await call("GET", "/v1/admin/notifications/prune-candidates");
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      });

      /**
       * The override's attribution is built from two unbounded `text` columns and the
       * column it lands in is capped at 200 characters.
       *
       * A long display name or a long OIDC subject therefore failed the CHECK and the
       * operator was told the override "must name who granted it" — true of the empty
       * string, not of theirs, and nothing they could act on. The subject survives whole
       * because it is the half that identifies the grantor; the name gives way, with an
       * ellipsis so a reader can see something was dropped.
       */
      it("fits a long display name into the override's attribution instead of failing", async () => {
        await grant(() => rep, "administrator", () => manager);
        const long = "Ä".repeat(400);
        await withTenantContext(admin, TENANT, (tx) =>
          tx.query("UPDATE crm.rep_profile SET display_name = $2 WHERE id = $1", [rep, long]),
        );
        const res = await call("POST", "/v1/admin/notifications/prune-guard/override", {
          body: { hours: 2 },
        });
        expect(res.status).toBe(200);
        const by = res.body.prune_guard_override_by as string;
        expect(by.length).toBeLessThanOrEqual(200);
        // The subject is intact and the name is what was shortened.
        expect(by).toContain("<idp|rep1>");
        expect(by).toContain("…");
      });
    });

    describe("granting and revoking over HTTP", () => {
      it("lets any rep see who the administrators are", async () => {
        await grant(() => manager, "administrator", () => rep);
        const res = await call("GET", "/v1/admin/roles/administrators");
        expect(res.status).toBe(200);
        expect(res.body.data.map((h: { display_name: string }) => h.display_name)).toEqual(["The Manager"]);
      });

      it("refuses a grant from a rep who is not an administrator", async () => {
        expect(
          (await call("POST", "/v1/admin/roles", { body: { repProfileId: otherRep, role: "compliance" } })).status,
        ).toBe(403);
      });

      it("grants, lists and revokes, keeping the ended grant", async () => {
        await grant(() => rep, "administrator", () => manager);
        const created = await call("POST", "/v1/admin/roles", {
          body: { repProfileId: otherRep, role: "compliance", reason: "took over SOPs" },
        });
        expect(created.status).toBe(201);
        expect(created.body.rep_display_name).toBe("Rep Two");
        expect(created.body.granted_by_name).toBe("Rep One");

        const live = await call("GET", "/v1/admin/roles?role=compliance");
        expect(live.body.data).toHaveLength(1);

        const revoked = await call("POST", `/v1/admin/roles/${created.body.id}/revoke`, {
          body: { reason: "changed duties" },
        });
        expect(revoked.status).toBe(200);
        expect(revoked.body.revoke_reason).toBe("changed duties");

        expect((await call("GET", "/v1/admin/roles?role=compliance")).body.data).toHaveLength(0);
        const all = await call("GET", "/v1/admin/roles?role=compliance&includeEnded=true");
        expect(all.body.data).toHaveLength(1);
        expect(all.body.data[0].in_force).toBe(false);
      });

      it("refuses a self-grant with a 403, from the database's own rule", async () => {
        await grant(() => rep, "administrator", () => manager);
        const res = await call("POST", "/v1/admin/roles", {
          body: { repProfileId: rep, role: "compliance" },
        });
        expect(res.status).toBe(403);
        expect(res.body.detail).toContain("cannot grant themselves");
      });

      it("refuses an unknown role with a 422", async () => {
        await grant(() => rep, "administrator", () => manager);
        expect(
          (await call("POST", "/v1/admin/roles", { body: { repProfileId: otherRep, role: "root" } })).status,
        ).toBe(422);
      });

      /**
       * The lockout refusal, with its own problem type so a client can say "appoint a
       * successor first" and offer the form rather than showing a bare 409.
       *
       * Reaching it over HTTP takes a FUTURE-DATED revocation, and that is not a
       * contrivance: an administrator cannot revoke their own grant, and revoking
       * somebody else's always leaves the caller, so the only way an administrator can
       * empty the role is to end another one on a date their own grant no longer covers.
       * An interim administrator scheduling the permanent one's departure past the end
       * of their own term is exactly that, and the database refuses it.
       */
      it("refuses to revoke the last administrator, with an actionable problem type", async () => {
        // The caller's own grant lapses on 1 November; the manager's does not lapse.
        await grant(() => rep, "administrator", () => manager, "2026-11-01");
        const theirs = await grant(() => manager, "administrator", () => rep);

        // Ending it today is fine — the caller is still an administrator today.
        const fine = await call("POST", `/v1/admin/roles/${theirs}/revoke`, { body: { on: "2026-10-20" } });
        expect(fine.status).toBe(200);

        // Ending it in December is not: by then the caller's grant has lapsed too and the
        // tenant would have nobody who could appoint anyone.
        // Re-appointed from the day after the first grant ended, so the two do not overlap.
        const again = await grant(() => manager, "administrator", () => rep, null, "2026-10-20");
        const res = await call("POST", `/v1/admin/roles/${again}/revoke`, { body: { on: "2026-12-01" } });
        expect(res.status).toBe(409);
        expect(res.body.type).toMatch(/\/last-administrator$/);
        expect(res.body.detail).toContain("successor");
      });

      /**
       * Needs a second administrator to reach the four-eyes rule at all: BEFORE UPDATE
       * triggers run before CHECK constraints, so with only one administrator the
       * lockout guard answers first and the refusal is a 409 rather than this 403. Both
       * answers are correct; the order is worth pinning down, because a client that only
       * ever saw the 409 would report the wrong reason.
       */
      it("refuses a self-revoke", async () => {
        const mine = await grant(() => rep, "administrator", () => manager);
        await grant(() => manager, "administrator", () => rep);
        const res = await call("POST", `/v1/admin/roles/${mine}/revoke`);
        expect(res.status).toBe(403);
        expect(res.body.detail).toContain("cannot revoke their own");
      });

      /**
       * The tenant is matched in SQL, not left to RLS — and this test is why. The API
       * pool in this suite connects as `postgres`, a superuser, which BYPASSES row-level
       * security even under FORCE. The first version of crm.revoke_rep_role scoped on the
       * grant id alone, and this call succeeded: a rep of one tenant ended a grant in
       * another, leaving a `revoked_by` pointing across the tenant boundary.
       */
      it("404s a grant id from another tenant", async () => {
        await grant(() => rep, "administrator", () => manager);
        const foreign = await withTenantContext(admin, OTHER, async (tx) => {
          const reps = await tx.query<{ id: string }>(
            `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
             VALUES ($1,'idp|other-a','OA','Other A'), ($1,'idp|other-b','OB','Other B') RETURNING id`,
            [OTHER],
          );
          const [a, b] = reps.rows.map((r) => r.id) as [string, string];
          const g = await tx.query<{ id: string }>(
            `INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from)
             VALUES ($1,$2,'compliance',$3,CURRENT_DATE) RETURNING id`,
            [OTHER, a, b],
          );
          return g.rows[0]!.id;
        });
        expect((await call("POST", `/v1/admin/roles/${foreign}/revoke`)).status).toBe(404);
      });
    });
  });
});
