// GENERATED FILE — DO NOT EDIT.
//
// Produced by @crm/acl codegen from GET /v1/meta/schema (schema/baseline.json).
// Regenerate with: pnpm erp:codegen
//
// Hand-writing any of this is a bug waiting to happen. The ERP's pluraliser is
// naive (Opportunity -> /v1/opportunitys), an unknown filter param is silently
// ignored rather than rejected, and a non-sortable sort quietly falls back to the
// view's default. Each failure is invisible and widens the result set.

export const SCHEMA_SHA256 = "440a8f077f622871db06bdaa86f4fd64bf3f6a851284ee3c68ea16c5f4f9823c";

/** Item — Supply Chain & Inventory. Served at `/v1/items`. */
export interface Item {
  readonly id: string;
  readonly sku: string; // unique
  readonly name: string;
  readonly status: "draft" | "active" | "discontinued"; // server-defaulted on create
  readonly list_price?: string | number;
  readonly standard_cost?: string | number; // classification: commercial_sensitive
  readonly updated_at: string; // server-defaulted on create
}

/** Opportunity — Sales & CRM. Served at `/v1/opportunitys`. */
export interface Opportunity {
  readonly id: string;
  readonly name: string;
  readonly account_id: string; // -> Account
  readonly amount: string | number; // classification: commercial_sensitive
  readonly stage: "prospecting" | "qualification" | "proposal" | "negotiation" | "won" | "lost"; // server-defaulted on create
  readonly updated_at: string; // server-defaulted on create
}

/** The server's own answer for each entity — slugs, and what may be filtered or sorted. */
export const ERP_ENTITY_META = {
  Item: {
    slug: "items",
    stateField: null,
    filterable: ["sku", "status", "list_price", "updated_at"] as const,
    sortable: ["sku", "name", "status", "list_price", "updated_at"] as const,
    searchable: ["sku", "name"] as const,
    transitions: [] as const,
    numericFields: ["list_price", "standard_cost"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
  Opportunity: {
    slug: "opportunitys",
    stateField: "stage",
    filterable: ["stage", "account_id", "amount", "updated_at"] as const,
    sortable: ["name", "stage", "amount", "updated_at"] as const,
    searchable: ["name"] as const,
    transitions: ["win", "lose"] as const,
    numericFields: ["amount"] as const, // range filters and sorts on these are WRONG on --store pg (R19)
  },
} as const;

export type ErpEntityName = keyof typeof ERP_ENTITY_META;

export const ERP_ENTITY_NAMES = ["Item", "Opportunity"] as const;

/** Entities carrying a lifecycle, and the transitions each accepts. */
export type ErpTransition = {
  readonly Opportunity: "win" | "lose";
};
