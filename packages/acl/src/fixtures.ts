import type { UiSchema } from "./ui-schema.js";

/**
 * A stand-in for `GET /v1/meta/schema` shaped exactly like `pack-erp-core`'s,
 * including the quirks that matter: the naive plural (`Opportunity` ->
 * `opportunitys`), numeric fields that cannot be range-filtered on the deployed
 * store, and a lifecycle with real transitions.
 */
export const ERP_SCHEMA_FIXTURE: UiSchema = {
  generatedAt: "2026-09-30T00:00:00.000Z",
  roles: [
    { name: "erp_admin", label: "ERP Administrator" },
    { name: "sales_rep", label: "Sales Representative" },
  ],
  entities: [
    {
      name: "Item",
      slug: "items",
      label: "Items",
      singular: "Item",
      module: "Supply Chain & Inventory",
      access: {
        list: ["erp_admin", "sales_rep"],
        read: ["erp_admin", "sales_rep"],
        create: ["erp_admin"],
        update: ["erp_admin"],
        delete: ["erp_admin"],
      },
      fields: [
        { name: "sku", label: "Sku", input: "text", required: true, unique: true },
        { name: "name", label: "Name", input: "text", required: true },
        {
          name: "status",
          label: "Status",
          input: "select",
          required: true,
          enumValues: ["draft", "active", "discontinued"],
          defaulted: true,
        },
        { name: "list_price", label: "List Price", input: "number", required: false },
        {
          name: "standard_cost",
          label: "Standard Cost",
          input: "number",
          required: false,
          classification: "commercial_sensitive",
        },
        { name: "updated_at", label: "Updated At", input: "datetime", required: true, defaulted: true },
      ],
      listColumns: ["sku", "name", "status"],
      sortableFields: ["sku", "name", "status", "list_price", "updated_at"],
      filterableFields: ["sku", "status", "list_price", "updated_at"],
      searchableFields: ["sku", "name"],
      stateField: null,
      transitions: [],
    },
    {
      // The naive pluraliser's most visible casualty. Hand-writing `/v1/opportunities`
      // here would 404, which is exactly why slugs are read from the server.
      name: "Opportunity",
      slug: "opportunitys",
      label: "Opportunitys",
      singular: "Opportunity",
      module: "Sales & CRM",
      access: {
        list: ["erp_admin", "sales_rep"],
        read: ["erp_admin", "sales_rep"],
        create: ["sales_rep"],
        update: ["sales_rep"],
        delete: ["erp_admin"],
      },
      fields: [
        { name: "name", label: "Name", input: "text", required: true },
        { name: "account_id", label: "Account", input: "reference", required: true, referenceTarget: "Account" },
        { name: "amount", label: "Amount", input: "number", required: true, classification: "commercial_sensitive" },
        {
          name: "stage",
          label: "Stage",
          input: "select",
          required: true,
          enumValues: ["prospecting", "qualification", "proposal", "negotiation", "won", "lost"],
          defaulted: true,
        },
        { name: "updated_at", label: "Updated At", input: "datetime", required: true, defaulted: true },
      ],
      listColumns: ["name", "stage", "amount"],
      sortableFields: ["name", "stage", "amount", "updated_at"],
      filterableFields: ["stage", "account_id", "amount", "updated_at"],
      searchableFields: ["name"],
      stateField: "stage",
      transitions: [
        {
          name: "win",
          label: "Win",
          operationId: "opportunity.win",
          stateField: "stage",
          from: ["negotiation"],
          to: "won",
          roles: ["sales_rep"],
        },
        {
          name: "lose",
          label: "Lose",
          operationId: "opportunity.lose",
          stateField: "stage",
          from: ["prospecting", "qualification", "proposal", "negotiation"],
          to: "lost",
          roles: ["sales_rep"],
        },
      ],
    },
  ],
};
