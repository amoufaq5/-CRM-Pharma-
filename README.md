# CRM Pharma

A pharma field-force CRM — a **system of engagement** over the CrossEngin ERP.

It holds visits, call plans, territories, sample custody and offline sync. It holds **no
copy of the truth** for employees, products or money: those live in the ERP and are reached
through an anti-corruption layer.

Read [`docs/ADR-0001-integration-architecture.md`](docs/ADR-0001-integration-architecture.md)
before changing anything structural, and
[`docs/ERP_INTEGRATION_REPORT.md`](docs/ERP_INTEGRATION_REPORT.md) for what the ERP can and
cannot do (20 recorded risks; §13 is the important part).

## Shape

| Path | What |
|---|---|
| `db/migrations/` | Numbered SQL. `0001`/`0002` are DBA steps (cluster roles, `CREATE EXTENSION`); the rest run as `crm_app`. |
| `packages/db/` | Tenant context, migration runner, and the **contract tests** that assert isolation against a real Postgres. |
| `packages/acl/` | The anti-corruption layer: the ERP HTTP client, generated types, error normalisation, the `ChangeSource` seam. |
| `packages/acl/schema/` | A captured `/v1/meta/schema`, so CI can check for drift without a live ERP. |
| `packages/relay/` | The outbox relay: claim, dispatch, classify, settle. Multi-worker safe, with leases. |
| `packages/sync/` | Snapshot refresh: strict coercion into typed columns, incremental + full sweep. |
| `packages/scheduler/` | The background process. Drives the relay and the refresher per tenant, on a timer. |
| `packages/territory/` | Territories, rep assignment, and the row-level scoping the ERP cannot do. |
| `scripts/setup-test-db.sh` | Brings a database to the state the contract tests expect. |

## Running it

```bash
pnpm install
pnpm typecheck

# Contract tests need a real Postgres — that is the point of them.
export PGHOST=/var/run/postgresql PGUSER=postgres PGDATABASE=crm_test
createdb crm_test && ./scripts/setup-test-db.sh
pnpm test
```

CI runs exactly this against a `postgres:16` service container on every push.

## The background process

```bash
PGHOST=… PGDATABASE=… PGUSER=… ERP_BASE_URL=… ERP_TOKEN=… pnpm scheduler
```

Long-running by necessity — the same constraint `operate-server` has on the ERP side, since
its schedulers are in-process too. Serverless can host the CRM's API but not this.

Tenants come from `crm.tenant`, the CRM's **own** registry: `crm_app` holds `SELECT` on
exactly one ERP table, and widening that for a tenant list would break the allow-list
discipline. It also reflects reality — the CRM serves a subset of ERP tenants, with
scheduling knobs the ERP has no concept of.

`ERP_TOKEN` is a development-only static credential and the process refuses to start with
it under `NODE_ENV=production`.

## Three rules that are not negotiable

**1. `crm_app` owns nothing of the ERP's.** A table's owner bypasses row-level security —
verified, not assumed (`packages/db/src/rls.contract.test.ts`). Ownership separation *is*
the isolation guarantee for ERP data. A superuser bypasses RLS even under `FORCE`, so the
application never connects as one. Both are asserted in CI.

**2. Never write an ERP table over SQL.** Writes go through the ERP's HTTP API via the
outbox, so its RBAC, write-guards, period locks, sequences, audit and double-entry GL
effects all still run. The database permits a direct write; the design does not.

Retries are safe because the relay mints the ERP record id itself and the ERP is unique on
`(tenant_id, entity, record_id)` — a durable constraint. Not because of the
`Idempotency-Key` header, whose store is in-memory in the deployed binary, dies on restart
and does not span instances.

**3. Never hand-write a resource path or a filter.** Both come from the server's own
`/v1/meta/schema`, via generated types. The ERP's pluraliser is naive (`Opportunity` →
`/v1/opportunitys`), and an unknown filter param is *silently dropped* rather than
rejected — so a mistyped filter returns more rows, not an error. `pnpm erp:codegen:check`
gates this in CI.

**4. Never read a number from the ERP.** The deployed ERP runs `--store pg`, where every
filter and sort is a *text* comparison: `?total[gte]=1000` returns 999, and `?sort=amount`
orders 100, 20, 9. Numeric filters, sorts and aggregations read the typed snapshot tables.
Pinned by test, so it cannot quietly become folklore.

Money stays a **string** all the way from the ERP into `NUMERIC`. float64 cannot represent
`1234567890.12`, and a rounded price in a typed column reads as authoritative. A value that
will not coerce rejects the record by name — it is never nulled, because a null price makes
a product look free.

**5. Authorisation for "my accounts" lives here, in SQL.** The ERP has no row-level
scoping at all — `requiresAbac` is computed and discarded, so any role sees every row in
the tenant. `crm.visible_account_ids(rep, on_date)` is the one definition, in the database
so every caller gets the same answer. Reimplementing it per caller is how it starts
disagreeing with itself.

**6. Assignments are effective-dated, never overwritten.** The ERP has no effective dating
anywhere, so a reassignment erases who held a customer when the order landed — the question
every commission dispute asks. Territory and account assignments keep their history, and a
database exclusion constraint makes overlapping coverage impossible rather than something a
nightly report finds.

**7. Snapshots need a periodic full sweep, not just incremental refresh.** The ERP keeps no
tombstones, so polling `updated_at` can never observe a deletion. Only a full sweep
reconciles; `last_full_sweep_at` is tracked separately so a snapshot that has only ever
been refreshed incrementally is visible as such.
