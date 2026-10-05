# ERP schema baseline

`baseline.json` is a captured `GET /v1/meta/schema` from a real `operate-server`
serving `pack-erp-core` — **51 entities**. It exists so CI can run the drift check
without reaching a live server, and so a change in the ERP's served shape arrives
as a reviewable diff rather than as a filter that quietly starts returning the
wrong rows.

The first version of this file was hand-written and covered two entities. That is
worth saying because of what it cost: it declared `updated_at` filterable and
sortable on every entity, and six `PollingChangeSource` tests passed for the life
of the project against code that throws `UnsupportedFilterError` for every entity
the real ERP serves. **No entity the ERP serves declares `updated_at` at all.** A
fixture that is not a capture is a second opinion about reality, and the tests
believe it.

## Refreshing it

Three steps, and the middle one is the one that gets missed:

```bash
# 1. Regenerate the types from the live server.
ERP_BASE_URL=… ERP_TENANT_ID=… ERP_TOKEN=… pnpm --filter @crm/acl erp:codegen

# 2. Re-capture the baseline itself, so CI's drift gate sees what you saw.
ERP_BASE_URL=… ERP_TENANT_ID=… ERP_TOKEN=… \
  curl -fsS -H "authorization: Bearer $ERP_TOKEN" -H "x-tenant-id: $ERP_TENANT_ID" \
  "$ERP_BASE_URL/v1/meta/schema" | jq -S . > packages/acl/schema/baseline.json

# 3. Regenerate from the baseline, so the committed bytes are the ones CI compares.
pnpm --filter @crm/acl erp:codegen:baseline

# then commit both, with the diff reviewed.
pnpm --filter @crm/acl erp:codegen:check   # the gate CI runs
```

Step 3 used to be load-bearing for a worse reason: the generated header named the
file it was produced from, so a live `erp:codegen` and the baseline gate emitted
different bytes for an identical schema and `--check` reported DRIFT while printing
two identical `SCHEMA_SHA256` values. The header no longer carries provenance —
the hash is the input's identity — so a live refresh and a baseline refresh now
produce the same file when the schema matches. Step 3 remains in the list because
it is free and it is what the gate compares.

**Read the diff, do not just accept it.** The dangerous change is a field leaving
`filterableFields`: the ERP ignores a non-filterable filter param silently rather
than rejecting it, so every query relying on that filter starts returning *more*
rows than it asked for, with no error anywhere.

## What the capture actually says

Three measured facts the CRM is built around. Each is a property of the ERP, not a
choice of ours, and each one broke something before it was known:

- **`updated_at` is served on nothing.** 0 of 51 entities declare it; 0 expose it
  as filterable. So there is no incremental polling against `pack-erp-core` at
  all. `PollingChangeSource` asks the schema and reports
  `mode: "full_sweep"` rather than sending a filter the ERP would drop — a silent
  fallback would recreate the ERP's own dropped-filter bug one layer up.
- **34 of 51 entities have no sortable fields whatsoever**, so a `sort` on them
  falls back to the view's default order without saying so. Keyset pagination over
  an unsorted view can revisit and skip rows.
- **`CostCenter.code` is not filterable** — only `parent_id` and `manager_id` are.
  Asking for `?code[eq]=CC-SM` therefore returns the tenant's first cost centre
  and looks like a hit. This is why `packages/expense/src/posting.ts` refuses to
  build a `JournalEntry`: a cost centre resolved this way is silently the wrong
  one. `LedgerAccount.account_code`, by contrast, *is* filterable, so the debit
  account alone could be resolved over the API.

`baseline.json` is captured per tenant. With `--per-tenant-manifests` enabled a
tenant on a custom manifest is served a different entity set, so this file
represents the **boot pack** — the common case — and is not a claim about every
tenant. The client resolves each tenant's real schema at runtime.
