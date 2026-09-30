# ERP schema baseline

`baseline.json` is a captured `GET /v1/meta/schema` from the ERP. It exists so CI
can run the drift check without reaching a live server, and so a change in the
ERP's served shape arrives as a reviewable diff rather than as a filter that
quietly starts returning the wrong rows.

The workflow when the ERP changes:

```bash
ERP_BASE_URL=… ERP_TENANT_ID=… ERP_TOKEN=… pnpm erp:codegen   # refresh from live
# then re-capture the baseline and commit both, with the diff reviewed
```

**Read the diff, do not just accept it.** The dangerous change is a field
leaving `filterableFields`: the ERP ignores a non-filterable filter param
silently rather than rejecting it, so every query relying on that filter starts
returning *more* rows than it asked for, with no error anywhere.

`baseline.json` is captured per tenant. With `--per-tenant-manifests` enabled a
tenant on a custom manifest is served a different entity set, so this file
represents the **boot pack** — the common case — and is not a claim about every
tenant. The client resolves each tenant's real schema at runtime.
