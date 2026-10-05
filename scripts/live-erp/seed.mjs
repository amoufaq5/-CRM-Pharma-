// Seeds the fixtures the live checks need, through the ERP's own HTTP API.
//
// Over HTTP and not over SQL, for the same reason the CRM never writes an ERP
// table (README rule 2): a row inserted into `meta.operate_entity_records` by
// hand can be shaped in ways the API would refuse, and then a check that reads it
// back is testing the fixture rather than the server.
//
// Idempotent by construction — every record carries a fixed id, so a re-run hits
// the unique constraint on (tenant_id, entity, record_id) and is treated as
// already present.
import { readFileSync } from "node:fs";

import { LocalEd25519Signer, mintServiceToken } from "../../packages/credential/dist/index.js";

const ERP_BASE = process.env["ERP_BASE_URL"] ?? "http://127.0.0.1:8788";
const TENANT = process.env["LIVE_TENANT_ID"] ?? "11111111-1111-4111-8111-111111111111";
const ISSUER = process.env["LIVE_JWT_ISSUER"] ?? "https://crm.test";
const AUDIENCE = process.env["LIVE_JWT_AUDIENCE"] ?? "https://erp.test";

const signer = LocalEd25519Signer.fromPkcs8Pem(readFileSync(process.env["LIVE_KEY_PEM"], "utf8"));
const { token } = await mintServiceToken(signer, {
  issuer: ISSUER,
  audience: AUDIENCE,
  tenantId: TENANT,
  role: "erp_admin",
  subject: `crm-service:${TENANT}`,
  ttlSeconds: 900,
  nowSeconds: Math.floor(Date.now() / 1000),
});

let created = 0;
let present = 0;

async function put(slug, record) {
  const res = await fetch(`${ERP_BASE}/v1/${slug}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": TENANT,
      "content-type": "application/json",
    },
    body: JSON.stringify(record),
  });
  const text = await res.text();
  if (res.status === 201) {
    created += 1;
    return;
  }
  // The JSONB store surfaces the unique violation as a 500 carrying the driver's
  // message; that is this fixture already being there, not a failure.
  if (/duplicate key/.test(text)) {
    present += 1;
    return;
  }
  process.stderr.write(`seed failed: POST /v1/${slug} ${res.status} ${text.slice(0, 300)}\n`);
  process.exit(1);
}

await put("employees", {
  id: "emp-1",
  employee_number: "E-1",
  given_name: "Ada",
  family_name: "Lovelace",
  work_email: "ada@fixture.test",
  hire_date: "2024-01-01",
  employment_type: "full_time",
  status: "active",
  currency: "USD",
});

// Three cost centres, because the dropped-filter check asks for the LAST code and
// asserts the first row returned is a different one. Two would make "the wrong
// row" and "the only other row" the same observation.
for (const n of [1, 2, 3]) {
  await put("cost-centers", {
    id: `cc-000${n}`,
    code: `CC-00${n}`,
    name: `Centre ${n}`,
    segment: "operating",
    is_active: true,
  });
}

// 9, 20, 100, 1000: the set whose TEXT order (100 < 1000 < 20 < 9) differs from
// its numeric order in both directions, so neither a filter nor a sort can look
// right by accident.
let i = 0;
for (const price of [9, 20, 100, 1000]) {
  i += 1;
  await put("items", {
    id: `itm-${i}`,
    sku: `SKU-${i}`,
    name: `Item ${price}`,
    item_type: "stock",
    unit_of_measure: "each",
    tracking: "none",
    list_price: price,
    currency: "USD",
    status: "active",
  });
}

// Leave requests straddling 2026-02-01, so the ISO-date check has a non-empty
// result on BOTH sides of the boundary. A one-sided check passes against a
// filter that drops everything.
i = 0;
for (const d of ["2025-12-31", "2026-01-05", "2026-02-10", "2026-11-20"]) {
  i += 1;
  await put("leave-requests", {
    id: `lrd-${i}`,
    request_number: `LRD-${i}`,
    employee_id: "emp-1",
    leave_type: "annual",
    start_date: d,
    end_date: d,
    days: 1,
    state: "draft",
  });
}

process.stdout.write(`seeded ${created} record(s), ${present} already present\n`);
