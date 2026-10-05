import { describe, expect, it } from "vitest";
import { generateTypes } from "./codegen.js";
import { ERP_SCHEMA_FIXTURE } from "./fixtures.js";
import type { UiSchema } from "./ui-schema.js";

describe("generateTypes", () => {
  const result = generateTypes(ERP_SCHEMA_FIXTURE);

  it("emits an interface per entity with the id and required/optional fields", () => {
    expect(result.source).toContain("export interface Item {");
    expect(result.source).toContain("readonly id: string;");
    expect(result.source).toContain("readonly sku: string;");
    // list_price is optional in the schema, so optional here.
    expect(result.source).toMatch(/readonly list_price\?: string \| number;/);
  });

  it("types a numeric field as `string | number`, not `number`", () => {
    // Honest rather than convenient: the JSONB store does no coercion on read,
    // so a NUMERIC written as a string comes back as a string. Claiming `number`
    // would hide exactly the coercion problem that makes ERP numeric filters
    // wrong, and push it into application code.
    expect(result.source).toContain("readonly amount: string | number;");
  });

  it("turns an enum into a literal union", () => {
    expect(result.source).toContain('readonly status: "draft" | "active" | "discontinued";');
  });

  it("annotates classification, references and server-generated fields", () => {
    expect(result.source).toMatch(/standard_cost.*classification: commercial_sensitive/);
    expect(result.source).toMatch(/account_id.*-> Account/);
  });

  it("records the server's slug — including the naive plural", () => {
    expect(result.source).toContain('slug: "opportunitys"');
  });

  it("records numeric fields explicitly, so a caller can see what is unsafe to range-filter", () => {
    // The real `Item` has five numeric fields, not the two the hand-written fixture
    // claimed. Every one of them is unsafe to range-filter on the deployed store.
    expect(result.source).toMatch(
      /Item: \{[\s\S]*?numericFields: \["standard_cost", "list_price", "reorder_point", "reorder_quantity", "weight_kg"\]/,
    );
  });

  it("records each entity's filterable, sortable and transition sets", () => {
    // As served: `name` IS filterable and `updated_at` is served on no entity at all.
    expect(result.source).toContain(
      'filterable: ["sku", "name", "item_type", "category", "list_price", "status"]',
    );
    expect(result.source).toContain(
      'transitions: ["advance_to_qualification", "advance_to_proposal", ' +
        '"advance_to_negotiation", "win", "lose"]',
    );
  });

  it("emits a transition union only for entities that have one", () => {
    // Five transitions, not the two the hand-written fixture claimed — the three
    // `advance_to_*` stages were missing from it entirely.
    expect(result.source).toContain(
      'readonly Opportunity: "advance_to_qualification" | "advance_to_proposal" | ' +
        '"advance_to_negotiation" | "win" | "lose";',
    );
    expect(result.source).not.toMatch(/readonly Item: .*;\n\};/);
  });

  it("marks the file generated so nobody edits it by hand", () => {
    expect(result.source.startsWith("// GENERATED FILE — DO NOT EDIT.")).toBe(true);
  });

  it("is deterministic — same schema, same bytes", () => {
    expect(generateTypes(ERP_SCHEMA_FIXTURE).source).toBe(result.source);
  });

  it("sorts entities so map ordering cannot cause spurious drift", () => {
    const reversed: UiSchema = { ...ERP_SCHEMA_FIXTURE, entities: [...ERP_SCHEMA_FIXTURE.entities].reverse() };
    expect(generateTypes(reversed).schemaSha256).toBe(result.schemaSha256);
  });

  it("ignores generatedAt, which changes on every request", () => {
    const later: UiSchema = { ...ERP_SCHEMA_FIXTURE, generatedAt: "2099-01-01T00:00:00.000Z" };
    // Otherwise every single codegen run would look like drift and the check
    // would be trained away as noise.
    expect(generateTypes(later).schemaSha256).toBe(result.schemaSha256);
  });

  it("CHANGES the hash when a field is added — the drift signal CI watches", () => {
    const drifted: UiSchema = {
      ...ERP_SCHEMA_FIXTURE,
      entities: ERP_SCHEMA_FIXTURE.entities.map((e) =>
        e.name === "Item"
          ? { ...e, fields: [...e.fields, { name: "gtin", label: "GTIN", input: "text" as const, required: false }] }
          : e,
      ),
    };
    expect(generateTypes(drifted).schemaSha256).not.toBe(result.schemaSha256);
  });

  it("CHANGES the hash when a field stops being filterable", () => {
    const drifted: UiSchema = {
      ...ERP_SCHEMA_FIXTURE,
      entities: ERP_SCHEMA_FIXTURE.entities.map((e) =>
        e.name === "Item" ? { ...e, filterableFields: ["sku"] } : e,
      ),
    };
    // The dangerous drift: a filter we send would start being silently ignored,
    // widening every result set that relies on it.
    expect(generateTypes(drifted).schemaSha256).not.toBe(result.schemaSha256);
  });
});
