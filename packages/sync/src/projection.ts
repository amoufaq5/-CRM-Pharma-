import {
  coerceCountry,
  coerceDate,
  coerceDecimal,
  coerceRecordId,
  coerceRequiredRecordId,
  coerceRequiredText,
  coerceText,
  coerceTimestamp,
} from "./coerce.js";

export type SnapshotName = "product" | "rep" | "account";

/**
 * One snapshot's contract: which ERP entity feeds it, which table it fills, and
 * how an ERP record becomes a typed row.
 *
 * `project` is written by hand per snapshot rather than derived from
 * `/v1/meta/schema`. That is deliberate. Deriving it would silently absorb an
 * ERP field rename as "the column is now always null", whereas a hand-written
 * projection fails at the coercion that no longer finds its field. The generated
 * types (`@crm/acl` codegen) and the schema drift gate cover the other half:
 * they make a rename visible at build time.
 */
export interface SnapshotProjection {
  readonly name: SnapshotName;
  readonly entity: string;
  readonly table: string;
  /** The snapshot's own key column holding the ERP record id. */
  readonly idColumn: string;
  readonly columns: readonly string[];
  project(record: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export const PRODUCT_PROJECTION: SnapshotProjection = {
  name: "product",
  entity: "Item",
  table: "crm.product_snapshot",
  idColumn: "erp_item_id",
  columns: [
    "erp_item_id",
    "sku",
    "name",
    "item_type",
    "unit_of_measure",
    "category",
    "barcode",
    "list_price",
    "standard_cost",
    "currency",
    "reorder_point",
    "status",
    "erp_updated_at",
  ],
  project(r) {
    return {
      erp_item_id: coerceRequiredRecordId("id", r["id"]),
      sku: coerceRequiredText("sku", r["sku"]),
      name: coerceRequiredText("name", r["name"]),
      item_type: coerceText("item_type", r["item_type"]),
      unit_of_measure: coerceText("unit_of_measure", r["unit_of_measure"]),
      category: coerceText("category", r["category"]),
      barcode: coerceText("barcode", r["barcode"]),
      // The whole reason these tables exist: typed, exact, and filterable.
      list_price: coerceDecimal("list_price", r["list_price"]),
      standard_cost: coerceDecimal("standard_cost", r["standard_cost"]),
      currency: coerceText("currency", r["currency"]),
      reorder_point: coerceDecimal("reorder_point", r["reorder_point"]),
      status: coerceText("status", r["status"]),
      erp_updated_at: coerceTimestamp("updated_at", r["updated_at"]),
    };
  },
};

export const REP_PROJECTION: SnapshotProjection = {
  name: "rep",
  entity: "Employee",
  table: "crm.rep_snapshot",
  idColumn: "erp_employee_id",
  columns: [
    "erp_employee_id",
    "employee_number",
    "given_name",
    "family_name",
    "work_email",
    "department_id",
    "manager_id",
    "position_id",
    "status",
    "employment_type",
    "hire_date",
    "erp_updated_at",
  ],
  project(r) {
    return {
      erp_employee_id: coerceRequiredRecordId("id", r["id"]),
      employee_number: coerceRequiredText("employee_number", r["employee_number"]),
      given_name: coerceText("given_name", r["given_name"]),
      family_name: coerceText("family_name", r["family_name"]),
      // PII. Mirrored because the rep roster and the login mapping need it, and
      // for no other purpose. Nothing here carries national_id, date_of_birth or
      // annual_salary: the ERP classifies those pii/commercial_sensitive, the
      // CRM has no use for them, and a field not copied cannot leak.
      work_email: coerceText("work_email", r["work_email"]),
      department_id: coerceRecordId("department_id", r["department_id"]),
      manager_id: coerceRecordId("manager_id", r["manager_id"]),
      position_id: coerceRecordId("position_id", r["position_id"]),
      status: coerceText("status", r["status"]),
      employment_type: coerceText("employment_type", r["employment_type"]),
      hire_date: coerceDate("hire_date", r["hire_date"]),
      erp_updated_at: coerceTimestamp("updated_at", r["updated_at"]),
    };
  },
};

export const ACCOUNT_PROJECTION: SnapshotProjection = {
  name: "account",
  entity: "Account",
  table: "crm.account_snapshot",
  idColumn: "erp_account_id",
  columns: [
    "erp_account_id",
    "name",
    "legal_name",
    "status",
    "industry",
    "billing_email",
    "country",
    "erp_updated_at",
  ],
  project(r) {
    return {
      erp_account_id: coerceRequiredRecordId("id", r["id"]),
      name: coerceRequiredText("name", r["name"]),
      legal_name: coerceText("legal_name", r["legal_name"]),
      status: coerceText("status", r["status"]),
      industry: coerceText("industry", r["industry"]),
      billing_email: coerceText("billing_email", r["billing_email"]),
      country: coerceCountry("country", r["country"]),
      erp_updated_at: coerceTimestamp("updated_at", r["updated_at"]),
    };
  },
};

export const PROJECTIONS: readonly SnapshotProjection[] = [
  PRODUCT_PROJECTION,
  REP_PROJECTION,
  ACCOUNT_PROJECTION,
];

export function projectionFor(name: SnapshotName): SnapshotProjection {
  const found = PROJECTIONS.find((p) => p.name === name);
  if (found === undefined) throw new Error(`unknown snapshot ${JSON.stringify(name)}`);
  return found;
}
