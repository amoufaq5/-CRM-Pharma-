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
| `packages/visit/` | Visits and detailing lines. Offline-first, territory-scoped, immutable once final. |
| `packages/api/` | The HTTP API. JWT auth, one error shape, territory-scoped on every read. |
| `deploy/` | Dockerfile, Compose stack, Caddy. One image, three entrypoints. See [`deploy/README.md`](deploy/README.md). |
| `scripts/` | `erp-fixture.sh` (ERP stand-in), `setup-test-db.sh` (contract-test database), `verify-migration-runner.sh` (the runner, against a real Postgres). |

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

## The API

```bash
PGHOST=… PGDATABASE=… PGUSER=… \
OIDC_ISSUER=… OIDC_AUDIENCE=… OIDC_JWKS_URL=… \
PORT=8080 pnpm api
```

`GET /healthz` is public. Everything else needs `Authorization: Bearer <token>` and resolves
the caller through `crm.rep_profile.subject` — a genuine token from the right IdP is **not**
authorisation on its own.

| | |
|---|---|
| `GET /v1/me` | the rep, their territories, their account count |
| `GET /v1/accounts` | **their** accounts; `?on=YYYY-MM-DD` for a historical view |
| `GET /v1/products` | catalogue from the typed snapshot; `?minPrice`/`?maxPrice` are numerically correct |
| `GET\|POST /v1/visits` | list own / record (upsert by device-minted id) |
| `POST /v1/visits/:id/transition` | lifecycle |
| `POST /v1/visits/:id/notes` | the one edit a final visit allows |
| `POST /v1/sync/visits` | offline flush, **per-row** results |

Every error is RFC 9457 `application/problem+json` — one shape, no exceptions. The ERP
emits two on the same API, and a client that handles only one misreads the other.

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

## Deploying

[`deploy/README.md`](deploy/README.md) is the operator's copy. The three things worth
knowing before reading it:

**The ERP goes first.** One database (ADR-0001 option b), and the CRM grants itself
`SELECT` on `meta.operate_entity_records`, so that table has to exist before the CRM's
first migration. `0001` checks and fails with a message naming the real cause.

**The migration runner switches roles, and that is load-bearing.** It connects as the
admin for the two DBA files — `CREATE ROLE`, `CREATE EXTENSION` — then `SET ROLE crm_app`
for the rest, so the tables come out owned by the role that is *subject* to RLS. Getting
this wrong is silent: migration `0010` did, once.

```bash
pnpm db:migrate:dry      # what a real run would do; exit 1 if an applied file was edited
pnpm db:migrate          # apply
pnpm db:migrate:verify   # the four properties above, against a throwaway database
```

**Two long-running processes, as on the ERP side.** The API is stateless and scales
freely. The scheduler is multi-instance-safe but one is enough — and in production it
currently refuses to start, because its ERP credential (short-lived per-tenant Ed25519
service JWTs, ADR-0001 item 10) is not built and a static shared secret holding
`controller` on every tenant is worse than no relay. The outbox is durable, so queued
writes wait rather than being lost.

The container plumbing in `deploy/` has **not been built or run** — the environment it was
authored in has no Docker daemon. The migration runner it invokes was verified end to end
against a live Postgres 16.

## Rules that are not negotiable

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

**7. Record ids for anything a device creates come from the device.** A rep works with no
signal; the id is minted offline so a retried sync collapses into the same row instead of
duplicating a call report. Same guarantee the outbox relies on.

**8. A visit is authorised against the date it happened, not today.** An account that moved
territory in July must not invalidate June's visit, nor hand it to whoever holds the
account now. This is what effective-dated territories are for.

**9. Snapshots need a periodic full sweep, not just incremental refresh.** The ERP keeps no
tombstones, so polling `updated_at` can never observe a deletion. Only a full sweep
reconciles; `last_full_sweep_at` is tracked separately so a snapshot that has only ever
been refreshed incrementally is visible as such.
