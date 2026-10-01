# Deploying the CRM

Three processes and a TLS edge:

| | kind | what it does |
|---|---|---|
| `migrate` | one-shot | brings the `crm` schema up to date, then exits 0 |
| `api` | long-running | the HTTP API reps and the web client talk to |
| `scheduler` | long-running | drains the outbox to the ERP, refreshes snapshots |
| `caddy` | long-running | automatic HTTPS in front of `api` |

All three run the **same image** with different entrypoints, so what is tested is
what ships.

> **Status.** The Dockerfile, compose file and Caddyfile in this directory have
> **not been built or run** — the development container these were authored in has
> no Docker daemon. The migration runner they invoke *was* verified end to end
> against a live Postgres 16 (ownership, RLS forcing, idempotence, refusal of an
> edited migration). Treat the container plumbing as unexercised until someone
> runs `docker compose build` once.

## The one ordering constraint: the ERP goes first

ADR-0001 chose a shared database. The CRM reads ERP master data over SQL from the
same database and grants itself `SELECT` on `meta.operate_entity_records`, so that
table has to exist before the CRM's first migration runs.

Migration `0001` checks for it and fails with a message naming the real cause,
because the alternative is a deploy dying on `schema "meta" does not exist`
thirty lines later and sending whoever is on call hunting in the wrong place.

So: **run the ERP's `crossengin apply` against this database before `migrate`.**
For local work, `scripts/setup-test-db.sh` builds a faithful stand-in instead.

## Two database identities

This is the isolation guarantee, not a convention.

| role | used by | why |
|---|---|---|
| `POSTGRES_USER` (admin) | `migrate` only | `CREATE ROLE`, `CREATE EXTENSION` — things `crm_app` cannot and must not do |
| `crm_app` | `api`, `scheduler` | owns `crm.*`, holds `SELECT` on exactly one ERP table |

A table's **owner bypasses row-level security** — verified, not assumed
(`packages/db/src/rls.contract.test.ts`). If an application process connected as
the admin, every query would see every tenant's rows and every RLS policy in the
schema would be decoration. A **superuser bypasses RLS even under `FORCE`**, so
`crm_app` is explicitly `NOSUPERUSER NOBYPASSRLS`.

The migration runner enforces the same split internally: it connects as the
admin, runs the two DBA files, then `SET ROLE crm_app` before the application
migrations so the tables come out owned by the right role. That bug has happened
once already — migration `0010` created an extension, which made it a DBA file,
which left its tables owned by `postgres`. The runner now does it rather than
trusting a deploy script to remember.

The compose file hardcodes `PGUSER: crm_app` for `api` and `scheduler`; it is not
an `.env` knob, so it cannot be set wrong.

## First deploy

```bash
cd deploy
cp .env.example .env     # then fill it in — nothing in it works as shipped
$EDITOR .env

# 1. the ERP must already be in this database (see above)
# 2. build once, then let compose order the rest
docker compose build
docker compose up -d
```

`migrate` is gated on `db` being healthy, and both app services are gated on
`migrate` exiting 0 (`service_completed_successfully`). A failed migration
therefore stops the deploy instead of starting an API against a half-built
schema.

Check it:

```bash
docker compose logs migrate     # one JSON object per line; ends with {"type":"done"}
curl -fsS https://$DOMAIN/healthz
```

`/healthz` queries the database, so a 200 means the API can actually serve — not
merely that the process started.

### Using the ERP's existing Postgres

The bundled `db` service exists for local work. In a real deployment the database
is the ERP's, already running:

1. Delete the `db` service and the `db-data` volume from `docker-compose.yml`.
2. Remove the `depends_on: db` from `migrate`.
3. Point `PGHOST`/`PGPORT`/`POSTGRES_DB` at the ERP's cluster.

Nothing else changes. The CRM adds a schema to that database; it does not get one
of its own.

## Every subsequent deploy

```bash
docker compose build
docker compose run --rm migrate node packages/db/dist/bin/migrate.js --dry-run
docker compose up -d
```

The dry run changes nothing and reports what a real run would do. It exits **1**
if an already-applied migration file has been edited — the runner refuses those
rather than silently re-running or silently skipping, so finding out before the
deploy window is better than during it. Fix forward with a new numbered file; do
not edit history.

The two DBA migrations run on **every** deploy, by design: the ledger that would
track them is created by one of them. That makes idempotence a requirement, not a
courtesy, and the runner's failure message says so.

## Secrets

`deploy/.env` is gitignored and is the only place secrets live in this setup.
Two properties worth keeping if you move to a secret manager:

- **`CRM_APP_PASSWORD` is applied by the migration runner**, via `ALTER ROLE`.
  Rotation is: change the value, re-run `migrate`, restart `api` and `scheduler`.
  The password is never written into a committed file, and `escapeLiteral` handles
  one containing a quote (`ALTER ROLE` takes no bind parameters, so the literal
  has to be inlined — hand-rolled quote doubling there is exactly how that
  becomes an injection).
- **Admin credentials are only ever given to `migrate`.** Do not reuse them for
  the app services to save a variable.

## The ERP credential is the open gap

`api` is complete: `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` point at any
OIDC provider, RS256 included, and a valid token is still not authorisation — the
API resolves `sub` through `crm.rep_profile`, and a subject with no profile gets
403 rather than a default role.

`scheduler` is **not** complete. It needs a credential to call the ERP, and the
decision taken under ADR-0001 Q8 was CRM-minted short-lived (5–15 minute)
per-tenant Ed25519 service JWTs from a key in a KMS. That is not built. What
exists is `ERP_TOKEN`, a static token, and the process **refuses to start with it
when `NODE_ENV=production`** — which is the compose default.

So out of the box in production the scheduler will not start, and that is
deliberate: a single static secret carrying `controller` on every tenant is worse
than no relay at all. The outbox is durable, so queued writes wait rather than
being lost. To run the scheduler against a development ERP, set `ERP_TOKEN` **and**
`SCHEDULER_NODE_ENV=development`.

## Provisioning a tenant

Two inserts, by hand for now — there is no admin surface yet.

```sql
-- 1. the CRM's own tenant registry. Not RLS-protected and holds no tenant data
--    (reading which tenants exist cannot require having already chosen one).
--    tenant_id must be the ERP's tenant id: it is the value every RLS policy
--    compares against and every ERP call is scoped by.
INSERT INTO crm.tenant (tenant_id, display_name)
VALUES ('<erp tenant uuid>', 'Acme Pharma');

-- 2. one rep profile per login. employee_number is the join key to the ERP
--    Employee — the only field immutable by intent. subject is the OIDC `sub`.
SET ROLE crm_app;
SELECT set_config('app.current_tenant_id', '<erp tenant uuid>', false);
INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
VALUES ('<erp tenant uuid>', '<oidc sub>', 'EMP-0001', 'A. Rep');
```

Scheduled jobs need no provisioning: the scheduler creates missing rows at their
default cadence on every tick, so a tenant added by hand — or a job added by a
later release — starts running without a backfill.

## Operating it

**Logs** are one JSON object per line on stdout from all three processes, ready
for a shipper whenever one appears. The ERP has no structured logger at all
(report R11), so this is the CRM's to provide.

**Shutdown** is graceful. The scheduler finishes the tick in flight before
exiting, so a deploy never kills a half-drained outbox mid-dispatch. Give it a
real `stop_grace_period` if ticks get long.

**Scaling.** `api` is stateless; run as many as you like behind Caddy. `scheduler`
is safe to run more than once — `claimDueJobs` advances `next_run_at` inside the
claim and the outbox claim uses `FOR UPDATE SKIP LOCKED` — but one is enough
until the outbox lag says otherwise.

**What to watch.** `crm.outbox` depth and oldest `next_run_at` (writes to the ERP
are backing up), `crm.snapshot_freshness.last_full_sweep_at` (a snapshot that has
only ever been refreshed incrementally cannot have observed a deletion — the ERP
keeps no tombstones), and `consecutive_failures` on `crm.scheduled_job`.

**Backups are the ERP's.** One database, one backup. Note that the CRM holds data
the ERP has no copy of — visits, territories, assignment history — so a restore
that rolls the ERP back rolls the CRM back with it, and an outbox entry already
delivered to the ERP may be replayed. That replay is safe: the relay mints the ERP
record id itself and the ERP is unique on `(tenant_id, entity, record_id)`.

## The API must not be published directly

`api` is on `expose`, not `ports`. It trusts the `Authorization` header and
nothing else — no IP allow-listing, no mTLS — so TLS terminating at Caddy is what
makes that trust reasonable. Moving it to `ports` to "test something quickly" puts
an unencrypted bearer-token API on the internet.

`ERP_BASE_URL` has the same property from the other side: `operate-server` is an
admin surface and belongs on a private network.
