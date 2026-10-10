# Deploying the CRM

Three processes and a TLS edge:

| | kind | what it does |
|---|---|---|
| `migrate` | one-shot | brings the `crm` schema up to date, then exits 0 |
| `api` | long-running | the HTTP API reps and the web client talk to |
| `scheduler` | long-running | drains the outbox to the ERP, refreshes snapshots |
| `caddy` | long-running | automatic HTTPS, the field client's files, and the proxy to `api` |

The first three run the **same image** with different entrypoints, so what is tested is
what ships. `caddy` is the same Dockerfile's `web` target: caddy:2 plus the field client's
bundle, produced by that build stage from the committed sources — so the files a browser
downloads cannot drift from the API they call.

**One origin is load-bearing, not tidiness.** The app is served from this host and calls
`/v1/...` on this host, so the browser never makes a cross-origin request — which is why
neither the app nor the API contains a line of CORS. Serving the app from a second host
would need one.

> **Status.** The stack **has been built and run** — image, migrations, api,
> scheduler, and a real Postgres — and that is new as of 2026-10-07. Everything in
> this directory spent six weeks marked "not built, no Docker daemon available",
> and the second half of that was never checked. `dockerd` starts fine in the
> container these files were written in. Nobody had tried. The image did not
> build, in four independent and individually fatal ways, and every one of them
> was invisible both to reading the file and to a build on a laptop.
>
> Reproduce it with `pnpm deploy:smoke` (needs a daemon; it builds the image and
> brings the stack up), or `pnpm deploy:image` for the thirty-second version that
> replays the build without one. CI runs all three layers on every push.

## What is and is not verified here

Three scripts, in increasing cost, and it is worth knowing which one answers what.

**`pnpm deploy:verify`** — ten static properties, no daemon needed.
`docker compose config` is client-side and does real work: it resolves the anchors
and merges, expands every `${VAR}`, and fails on an unknown key or a dangling
service reference. On top of that:

- the compose file resolves against the committed `.env.example`, and every
  `${VAR}` without a default is documented there (a variable added to compose and
  forgotten in the example is the most likely real failure);
- `api` and `scheduler` run as `crm_app`, never the admin;
- neither serves before `migrate` completes successfully, and `caddy` waits for
  `api` to be healthy;
- no image floats on `latest`, and the runtime image is not root;
- only the `scheduler` can be given the ERP signing key;
- **the Dockerfile's manifest layer lists every workspace package**, derived from
  `pnpm-workspace.yaml` rather than by hand;
- **`.dockerignore` keeps the host's `node_modules`, `dist/` and `*.tsbuildinfo`
  out of the build context**;
- **the root `tsconfig.json` references every package with sources**, so the
  image's single `tsc --build` cannot silently skip one.

The last three exist because of what the first seven missed. They are cheap and
they are not sufficient: all seven passed for six weeks over an image that could
not build.

**`pnpm deploy:image`** — replays both stages of the Dockerfile without Docker,
against a context assembled from tracked files only, and then runs the
entrypoints out of the runtime stage's file set. It *interprets* the Dockerfile
rather than restating it, because a restatement would have been written from the
same wrong list. Thirty seconds, no daemon, and it catches all four of the
defects below.

**`pnpm deploy:smoke`** — builds the image and brings the stack up against a real
Postgres. What it proves, each of which had never run before:

- the image builds from a clean context;
- `migrate` **refuses** a database with no ERP in it, naming the real cause (the
  `0001` precondition, previously tested only in SQL);
- with the ERP stand-in present, all 54 migrations apply, and a second run
  applies nothing;
- the api comes up **healthy**, which includes "connected as a role row-level
  security applies to" — so the compose file's two identities are proven, not
  asserted;
- `/healthz` answers 200, the JWKS answers **503 rather than an empty key set**
  when nothing is published, and a real route answers 401 with an RFC 9457
  problem document;
- the scheduler refuses to start with no ERP credential and starts with one, and
  **the api publishes exactly the key the scheduler signs with** — the credential
  design working across two containers and a database.

What is still unexercised: ACME (the edge is tested against `DOMAIN=localhost`
with Caddy's internal CA), a real OIDC issuer, and the ERP itself. All three are
someone else's host.

### The four defects, since the shape of them is the lesson

| | what | why nothing caught it |
|---|---|---|
| 1 | the manifest layer copied 8 of the 16 workspace `package.json` files, so the other eight were not pnpm importers, got no `node_modules`, and `tsc --build` failed with TS2307 on `@crm/db` from inside `packages/notify` | nothing compared that list to the workspace |
| 2 | `@crm/erasure` was not a root `tsconfig` reference, so `tsc --build` never built it — the GDPR Article 17 executor and the tombstone signer were missing from the image, and from `pnpm build` | it typechecks, its tests pass, and nothing asks whether it is compiled |
| 3 | `pnpm prune --prod` rewrites `node_modules` and asks first, refusing outright with no TTY. A docker build has none, so the step could never have succeeded | only running it says so |
| 4 | and had it run, prune empties every workspace importer's `node_modules` and relinks only the root, so the api would have died on `Cannot find package '@crm/callplan'` at its first import | only running the result says so |

The reason all four survived: no `.dockerignore`, so `COPY packages/ packages/`
landed the host's `dist/` and `tsconfig.tsbuildinfo` on top of what pnpm had just
installed. `tsc` then found every project up to date, emitted nothing, and the
image shipped artifacts compiled on a developer's machine. A laptop build looked
correct; only a clean one — which is to say, only CI, which was not building —
would have shown the truth.

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

**This is enforced at runtime, not just configured.** `withTenantContext` — the
only sanctioned way to reach a `crm.*` table — asks the server which role its
statements will run under and refuses a role that is `SUPERUSER` or `BYPASSRLS`.
So a wrong `PGUSER` does not quietly widen every query:

| | as `crm_app` | as the admin role |
|---|---|---|
| `GET /healthz` | `200 {"status":"ok"}` | `503 degraded`, naming the role and the fix |
| any tenant request | served | `500`, with the reason in the structured log |
| a `scheduler` tick | runs | `tick_error` per tenant, no work done |

The 503 is the one that matters operationally, and the compose file now acts on it:
`caddy` waits for the `api` service to be **healthy**, not merely started, so a
misconfigured deployment never takes traffic. It gated on `service_started` when
that paragraph was first written — the claim was ahead of the configuration, and
`scripts/verify-deploy-stack.sh` now asserts the gate so it cannot drift back.
The role name appears in `/healthz` and in the log — both read by the operator who
can change it — and never in a request response, which a tenant can read.

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
cp .env.example .env     # then fill it in
$EDITOR .env
# Precisely which values must be real, since "nothing works as shipped" was too
# strong and an operator acts on that kind of sentence: with the placeholders
# untouched, db, migrate and api come up and /healthz answers 200 (deploy:smoke
# does exactly this). The two that must be real are OIDC_* — without a reachable
# issuer every request is a 401 — and the scheduler's signing key, without which
# it refuses to start and says so. The passwords should obviously not stay
# `change-me-*`.

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

## The ERP credential

Two tiers, and they never mix (ADR-0001 item 10).

**Humans into the CRM** — `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` point at any
OIDC provider, RS256 included. A valid token is still not authorisation: the API resolves
`sub` through `crm.rep_profile`, and a subject with no profile gets 403 rather than a
default role. A human's token is never forwarded to the ERP.

**The CRM into the ERP** — the CRM signs its own short-lived Ed25519 service token, one per
tenant. This is what replaces `--api-key`, whose three weaknesses it removes: the token is
not in argv, it lives ten minutes rather than forever, and rotating it is a database row
plus a secret rather than an ERP restart.

Who holds what:

| | signing key | JWKS |
|---|---|---|
| `scheduler` | yes — the only process with it | — |
| `api` | **no** | publishes it from `crm.service_key` |

The API cannot mint a token even if it is compromised, because it has no private key and
the registry has no column that could hold one (asserted in
`packages/db/src/schema.contract.test.ts`).

### Setting it up

```bash
# 1. generate. Prints the private PEM ONCE and publishes its public half.
pnpm key generate --note "initial"

# 2. put the PEM where the scheduler will read it
install -m 0600 /dev/stdin deploy/secrets/crm-signing-key.pem   # paste it
#   then in deploy/.env: CRM_SIGNING_KEY_FILE=/run/secrets/crm-signing-key.pem

# 3. make it the signing key. Refuses until the JWKS has had time to propagate.
pnpm key activate <kid>

# 4. point the ERP at us
#   operate-server --jwks-url https://$DOMAIN/.well-known/jwks.json \
#                  --jwks-refresh-ms 60000 \
#                  --jwt-issuer "$CRM_TOKEN_ISSUER" \
#                  --jwt-audience "$ERP_TOKEN_AUDIENCE"
```

`CRM_TOKEN_ISSUER` and `ERP_TOKEN_AUDIENCE` must match those two ERP flags **exactly**. The
ERP checks `iss` and `aud` only when the claim is present — which it always is in a token we
mint — so a mismatch is a clean 401 rather than something subtle.

Each tenant also needs a row saying which ERP role its service principal holds; see
**Provisioning a tenant** below. There is no default, deliberately.

### Rotating the key

Four steps, and the order is the whole point:

```bash
pnpm key generate --note "rotation $(date +%F)"   # enters the JWKS as `published`
# wait — `activate` enforces this, it is not advice
pnpm key activate <new kid>                        # old one drops to `published`
# install the new PEM, restart the scheduler
pnpm key retire <old kid>                          # once its tokens have expired
```

Both waits are enforced by the registry rather than documented and hoped for, because
neither failure is visible when you cause it:

- **Activating too early** means signing with a key verifiers have not fetched. Every
  request 401s with `credential_not_found` until a refresh succeeds — and a failed refresh
  keeps the stale set, so it does not necessarily self-heal.
- **Retiring too early** removes a key from the JWKS while tokens it signed are still
  valid, so requests that were authorised a minute ago start failing.

Between steps 3 and 4 the old key is still in the JWKS, which is what makes this a rotation
rather than an outage: a scheduler that has not restarted yet keeps working.

`pnpm key list` shows every key and its state. `pnpm key kid-of < key.pem` prints the kid a
PEM signs under — for checking that the secret an environment holds is the key its registry
row names, which is the mismatch nothing else explains.

The scheduler verifies this at boot and refuses to start if its key is absent or retired. A
key that is merely `published` starts with a warning: its tokens verify, and that is the
ordinary state of a process still running from before a rotation.

### Revoking a tenant's access

```sql
UPDATE crm.erp_service_principal SET enabled = false WHERE tenant_id = '…';
```

Minting stops within one role-cache window. Note what this does **not** do: a token already
issued stays valid at the ERP until it expires. There is no revocation list — that is the
trade a ten-minute lifetime buys, and the reason the TTL is minutes rather than hours. To
cut access immediately, retire the key (and accept that it cuts every tenant).

### Running without it

`ERP_TOKEN` is a static development credential, ignored entirely when a signing key is set.
The scheduler refuses to start with it when `NODE_ENV=production`; set
`SCHEDULER_NODE_ENV=development` to use it against a throwaway ERP.

## Provisioning a tenant

Four inserts, by hand. The fourth is permanent, not a stopgap: it bootstraps the role model,
and bootstrapping it from outside the API is the point.

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

```sql
-- 3. which ERP role this tenant's CRM service principal holds. NO DEFAULT: a
--    tenant with no row here cannot get a token, which is the right failure.
--    Exactly one role, and a space in it is refused by a CHECK — the ERP reads
--    only the FIRST space-separated scope as the role, so 'sales_rep controller'
--    would grant sales_rep while reading as though it granted both.
INSERT INTO crm.erp_service_principal (tenant_id, erp_role)
VALUES ('<erp tenant uuid>', 'controller');
```

`controller` is what the GL posting in ADR-0001 item 11 needs. A tenant the CRM only reads
from can hold something narrower — the role is per tenant precisely because each tenant's
manifest declares its own.

```sql
-- 4. the tenant's FIRST administrator. This one cannot be done over the API, ever:
--    a grant may not name its own holder as grantor (four eyes), so an empty role
--    set has no way to fill itself. granted_by is any other rep profile in the
--    tenant — it records who asked for it, and it must not be the holder.
INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
VALUES ('<erp tenant uuid>', '<the administrator>', 'administrator', '<anyone else>',
        CURRENT_DATE, 'bootstrap');
```

**Appoint a second administrator from the first one's session**, before anyone goes on leave.
Nobody can revoke their own grant, so a tenant with one administrator cannot replace them
through the API; the database refuses to revoke the last one or to suspend their profile, so
the tenant stays usable — but fixing it then needs a psql prompt again. With two, the role
is self-sustaining.

Everything else an administrator needs is over HTTP: `POST /v1/admin/roles` to appoint the
compliance officer, `PUT /v1/admin/samples/disposal-policy` for the SOP parameters,
`POST /v1/admin/notification-endpoints` for the webhooks below, and
`PUT /v1/admin/notifications/retention` for how long inboxes keep things.

Scheduled jobs need no provisioning: the scheduler creates missing rows at their
default cadence on every tick, so a tenant added by hand — or a job added by a
later release — starts running without a backfill. `notify_prune` arrived that
way, and on a tenant with a long-standing inbox its first few nights will each
report `more=true` while the backlog drains 50,000 rows at a time. Ask
`GET /v1/admin/notifications/prune-candidates` first if you want to see what it
will take before it takes it.

## Notifications

Two channels. **In-app** needs no configuration: a notification is a row, written by
whatever raised it, and `GET /v1/notifications` serves it. **Webhook** pushes an HMAC-signed
POST at a URL — one of these into Slack, Teams or PagerDuty is how an overdue regulated
disposal reaches someone who is not looking at the app.

An administrator configures one over HTTP — the SQL below is the same thing by hand, for a
tenant that has no administrator yet:

```http
POST /v1/admin/notification-endpoints
{"channel":"webhook","url":"https://hooks.slack.com/services/…",
 "secretEnv":"CRM_HOOK_OPS_SECRET","minSeverity":"warning","description":"ops channel",
 "reason":"ops asked for overdue disposals in their on-call channel"}
```

```sql
INSERT INTO crm.notification_endpoint
  (tenant_id, channel, url, secret_env, min_severity, description,
   created_by, created_reason)
VALUES ('<tenant uuid>', 'webhook', 'https://hooks.slack.com/services/…',
        'CRM_HOOK_OPS_SECRET', 'warning', 'ops channel',
        '<the rep_profile id of whoever decided this>',
        'why this route exists, in at least ten characters');
```

**`reason` is not optional and the author is not yours to choose.** Adding an endpoint opens
a route out of the tenant for records carrying a rep's name and an account id, so since 0060
the database refuses one that names nobody; over HTTP the author comes from the token, and
from a psql prompt it has to be supplied. `description` says what the endpoint is for and
can be amended; `created_reason` says why the route was opened at all and is frozen with the
destination.

**Changing one afterwards is an INSERT, not an UPDATE.** `min_severity`, `kinds`, `enabled`
and `description` are a projection of `crm.notification_endpoint_change`, so a direct UPDATE
is refused and every amendment carries an author and a reason —
`PATCH /v1/admin/notification-endpoints/:id` does it, `GET …/:id/history` reads it back, and
`enabled: false` is how an endpoint stops.

`secret_env` is the NAME of an environment variable, never the secret — the same discipline
as the service signing key. Put the value in `deploy/.env`, give it to the **scheduler**
(the only process that sends), and the sender signs with it. A missing variable
dead-letters the delivery rather than sending unsigned.

`min_severity` defaults to `warning`, which keeps routine `info` events (a call plan
approved) out of a paging channel. `kinds` is NULL for everything, or an allow-list — and the
API checks an allow-list against the real vocabulary, because `kinds` is a bare `text[]` with
no CHECK and an endpoint filtered to a kind that does not exist receives nothing at all.

Notifications do not accumulate forever: a nightly `notify_prune` job enforces a
per-tenant retention policy (two horizons — shorter for read, longer for unread),
and never prunes one whose subject is still unfinished or whose webhook push has
not settled. README.md has the rules; `PUT /v1/admin/notifications/retention`
sets the numbers. Deleting a notification takes its `crm.notification_delivery`
rows with it by cascade, so a retention period is also the retention period for
the record of where that signal was pushed.

An endpoint is retired with `PATCH /v1/admin/notification-endpoints/:id` and
`{"enabled":false}`. **There is no delete**, by design: `crm.notification_delivery`
references the endpoint `ON DELETE CASCADE`, so removing one would erase the record of
everything ever sent to it. The URL and `secret_env` are not editable either — repointing an
endpoint in place would carry its delivery history onto a different destination. Moving a
destination is: disable the old one, create a new one.

What a receiver must do: recompute `HMAC-SHA256(secret, "<x-crm-timestamp>.<raw body>")`,
compare it with `x-crm-signature` in constant time, and reject anything whose timestamp is
outside a few minutes. `verifyWebhook` in `@crm/notify` is the reference. Delivery is
at-least-once, so collapse duplicates on `x-crm-delivery`.

Dead letters: `SELECT * FROM crm.notification_delivery WHERE state = 'dead'`. A 4xx dies on
the first attempt (it will not succeed on retry); 408, 429 and 5xx retry eight times over
roughly twenty minutes.

There is no email or SMS sender. `ChannelSender` in `@crm/notify` is the seam, and nothing
was written against it deliberately: a provider client could not be verified from the
environment this was built in, and the ERP's own notification package shows where
unverifiable senders end up — eighteen declared providers, one implementation. A webhook
covers the paging case today. ADR-0001 records it as open.

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
keeps no tombstones), `consecutive_failures` on `crm.scheduled_job`, a 503 from
`/.well-known/jwks.json` (no key published — every ERP call is about to fail),
`crm.notification_delivery` in state `dead` (someone is not being told something),
`crm.disposal_obligation` in state `overdue` (expired stock still in a bag), and
`crm.outbox` in state `dead` — a rep's write the ERP refused permanently. The relay now
notifies the rep and their manager when one appears, and the `unattributed` count in its log
line is the case where it could not work out whose write it was.

**A dead letter is recoverable.** Most causes are configuration on the ERP side; once fixed,
`POST /v1/erp-writes/:id/retry` (or `SELECT crm.revive_outbox_letter(id, rep)`) queues the
same payload again with the attempt count reset. It is not an edit — a payload that was
wrong will die again, and `revive_count` will say so.

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
