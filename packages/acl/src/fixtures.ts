import { createRequire } from "node:module";

import { UiSchemaSchema, type UiSchema } from "./ui-schema.js";

/**
 * The served schema, for tests — SLICED FROM THE COMMITTED BASELINE rather than written
 * by hand.
 *
 * WHY IT IS NOT HAND-WRITTEN ANY MORE. It was, and it drifted, and the drift hid a real
 * defect for the life of the project. The hand-written version declared `updated_at` as a
 * field on `Item` and `Opportunity` and listed it in both `filterableFields` and
 * `sortableFields`. A real `operate-server` serving `pack-erp-core` declares it on **none
 * of its 51 entities** and makes it filterable on none of them, because `buildUiSchema`
 * reads the manifest's own `fields` rather than `resolvedFields`, so the `auditable`
 * trait's columns are never published.
 *
 * The consequence was not that a test was slightly wrong. `PollingChangeSource` is built
 * entirely on `?updated_at[gte]=`, and its six tests passed — against this fixture —
 * while the same code throws `UnsupportedFilterError` for every entity against the real
 * server. The suite was asserting against the stand-in, and the stand-in was the thing
 * that was wrong. The old fixture's `generatedAt` was a round `2026-09-30T00:00:00.000Z`,
 * which is the tell: it was never a capture.
 *
 * So the fixture is now derived from `schema/baseline.json`, which `pnpm
 * erp:codegen:check` already gates against the live ERP. A fixture that cannot encode a
 * schema the ERP has never served cannot hide this class of bug again — and it costs
 * nothing, because the baseline is a real capture of the same two entities plus 49 more.
 *
 * Parsed through `UiSchemaSchema` on the way out, so a malformed baseline fails here
 * rather than somewhere downstream with a confusing message.
 */
const require_ = createRequire(import.meta.url);

/** The whole captured schema: 51 entities, as the ERP really serves them. */
export const ERP_SCHEMA_FULL: UiSchema = UiSchemaSchema.parse(
  require_("../schema/baseline.json"),
);

/**
 * The two entities the tests were written around, kept as a narrow fixture so a failure
 * names a small schema rather than a 7,000-line one.
 *
 * Three entities, each carrying a quirk the tests need and none of them invented:
 *
 * - **`Item`** — `list_price` is numeric AND filterable, which is the live example of the
 *   range-operator refusal (report R19). Its filterable and sortable sets are identical.
 * - **`Opportunity`** — the naive plural (`opportunitys`), five lifecycle transitions
 *   (the hand-written fixture claimed two), and `sortableFields: []`, which is true of 34
 *   of the ERP's 51 entities and was invisible before.
 * - **`Expense`** — the only one of the three with a FILTERABLE DATE (`incurred_on`), so
 *   the "ISO-8601 range filters are safe as text" exemption has a real subject. It had
 *   none before: the old fixture used `updated_at`, which the ERP does not serve.
 */
export const FIXTURE_ENTITIES = ["Item", "Opportunity", "Expense"] as const;

export const ERP_SCHEMA_FIXTURE: UiSchema = {
  ...ERP_SCHEMA_FULL,
  entities: ERP_SCHEMA_FULL.entities.filter((e) =>
    (FIXTURE_ENTITIES as readonly string[]).includes(e.name),
  ),
};
