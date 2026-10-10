# Live ERP verification

ADR-0001's open table carried one question that invalidated the standing of
everything else in the CRM→ERP path:

> Has a CRM-minted token been accepted by a **running** operate-server? The
> acceptance test transcribes the ERP's verifier (alg, kid, both base64
> conversions, which claims it checks) and passes, but no live handshake has
> happened — no ERP instance was available.

**It has now. The answer is yes**, and so is the answer to every other assumption
on that path except one, which was wrong in a way nothing offline could have
caught.

Reproduce with `./scripts/verify-live-erp.sh`. It boots a real `operate-server`
against a throwaway database and then does two things with it: it drives the
**shipped `dist`** of `@crm/acl`, `@crm/credential`, `@crm/db` and `@crm/relay`
at it as a library (90 assertions, §1–§6), and it starts the CRM's own **`api`
and `scheduler` binaries as processes** and lets them do the work (34 assertions,
§7 below). **124 assertions in total**, every one of them over code that deploys.
The script's header says what it does not prove; read that before quoting a pass
from it.

## The invocation that worked

```
node apps/operate-server/dist/bin/operate-server.js \
  --pack erp-core \
  --store pg \
  --per-tenant-manifests \
  --port 8788 \
  --jwks-url http://127.0.0.1:8799/.well-known/jwks.json \
  --jwks-refresh-ms 30000 \
  --jwt-issuer https://crm.test \
  --jwt-audience https://erp.test
```

with `PGHOST`/`PGUSER`/`PGDATABASE` pointing at a database the ERP's own
`crossengin-pg apply` had migrated (840 statements, 0 failures, 140 tables in
schema `meta` — the 139 of `META_TABLES` plus the applier's own
`_meta_migrations`).

Two things about this command are load-bearing and were chosen, not defaulted:

- **`--store pg`.** The deployed store (ADR-0001 R17), where every filter is a
  text comparison on `document ->> 'field'`. The whole of README rule 4 depends
  on it and §4 below measures it.
- **No `--api-key`.** The CRM's JWKS is the *only* way into this server, so a
  passing handshake cannot be an opaque dev token getting in by another door. An
  unauthenticated `GET /v1/items` is asserted to 401 before anything else runs,
  so "the token was accepted" is not a sentence about a server that
  authenticates nobody.

Two environment notes. `pg_uuidv7` is not available on this cluster, so the
database gets `deploy/supabase/00-uuidv7.sql` first — the managed-Postgres
fallback the ERP documents and its applier's precondition explicitly accepts, not
a workaround of ours. And **the ERP runs in its own database here**, so
ADR-0001 option (b)'s single-database arrangement is *not* what was tested: the
CRM's `SELECT` grant on `meta.operate_entity_records` is still the stand-in from
`scripts/erp-fixture.sh`, and only the HTTP path to the ERP is live.

`/home/user/CrossEngin` was read, built, run and pointed at a throwaway database.
Nothing in it was written: the script fingerprints 2,492 ERP source files before
the run and diffs the manifest afterwards, and `git status --porcelain` in that
checkout is empty.

## 1. The credential handshake — the headline

| | |
|---|---|
| A CRM-minted Ed25519 service token is accepted by a running `operate-server` | **confirmed** |
| The ERP fetches the key over HTTP from the CRM's JWKS endpoint | **confirmed** (2 fetches recorded by the endpoint itself) |
| The document `jwksResponse()` renders is one the ERP's parser accepts | **confirmed** |
| With nothing to publish, the endpoint answers 503 and not an empty 200 | **confirmed** against the running endpoint |
| A token signed by an unpublished key is refused | **confirmed** — 401 `credential_not_found` |
| A wrong `iss` is refused | **confirmed** — 401 `issuer_mismatch` |
| A wrong `aud` is refused | **confirmed** — 401 `audience_mismatch` |
| An `x-tenant-id` disagreeing with the `tenant_id` claim is refused | **confirmed** — 401 `tenant_mismatch` |
| The token's single scope binds an ERP role | **confirmed** — `erp_viewer` lists (200) and cannot create (403) |

The whole chain ran through the production path: `LocalEd25519Signer` over a
generated PKCS#8 PEM, the tenant's role resolved from `crm.erp_service_principal`
by `PostgresServiceRoleSource` through `withTenantContext` as `crm_app`,
`ServiceCredential` minting and caching, `ErpClient` sending. The `kid` is the
RFC 7638 thumbprint the shipped `jwkThumbprint` derives.

**The negative controls are the point.** The first run of this script reported
four of these as passing when they were not: `mintServiceToken` returns a
`MintedServiceToken`, not a string, and three checks were sending
`Bearer [object Object]`. Every one was refused — for `credential_malformed`,
which is "that was not a JWT", not "that issuer is wrong". The checks now assert
the *reason* as well as the status, so that exact vacuous pass cannot return.

### The one thing that turned out false here

ADR-0001 item 10 says "the tenant rides in `x-tenant-id` and the gateway
cross-checks it against the claim", and `client.ts` calls the header
load-bearing. Live, the precedence is the other way round and the cross-check is
**conditional**:

- With **no** `x-tenant-id` at all, the request succeeds and the tenant comes
  from the token's `tenant_id` claim. The header is optional, not load-bearing.
- With a token carrying **no `tenant_id` claim**, the ERP accepts it and
  `x-tenant-id` **alone** selects the tenant:

  ```
  # a validly signed CRM token with iss/aud/exp/nbf/scope and no tenant_id
  $ curl -H "authorization: Bearer $NO_TENANT_CLAIM" \
         -H "x-tenant-id: 11111111-1111-4111-8111-111111111111" .../v1/cost-centers
  200 {"data":[{"id":"cc-0001", … }]}
  ```

This is the same shape as the three claim checks the CRM already documents — the
ERP only verifies the claims that are *present* — extended to the tenant. The
consequence is that one holder of a signing key plus a header could read any
tenant.

**The CRM is not exposed to it, and the reason is a single check.**
`mintServiceToken` refuses a `tenantId` that is not a UUID, so the CRM cannot
produce a token of that shape. That check was previously tidiness; it is now a
load-bearing security control, and the gate asserts it next to the gap it covers.
**The defect is the ERP's** (`apps/operate-server/src/principals.ts` sets
`tenantId: null` for a non-UUID claim and the gateway then has nothing to compare
the header against) and per the brief it was **not** fixed here. ADR item 10's
sentence should be corrected to say the claim is authoritative *when present*.

## 2. Slug resolution

| | |
|---|---|
| All 51 schema-declared slugs resolve to a live route | **confirmed** (no 404s) |
| The ACL's fallback pluraliser reproduces the server's slug for all 51 entities, mistakes included | **confirmed** |
| `Opportunity` → `/v1/opportunitys`, and `/v1/opportunities` is a 404 | **confirmed** |
| `Currency` → `/v1/currencys`, and `/v1/currencies` is a 404 | **confirmed** |

README rule 3 is real, exactly as written. A hand-written English plural is a
404 from the gateway, which `classify` dead-letters on a create as a stale slug —
so getting this wrong costs a silently dropped write, not an obvious failure.

The check asserts **"not 404"** rather than "200", and that distinction found
something: **`WhtCertificate` is routed but its `access` lists are empty on all
five operations**, so no role can list, read, create, update or delete it. It
answers 403 to every principal there is. The gate pins that a 403 slug is always
one the schema shows nobody may list, so a genuinely wrong path can never hide
behind it. An ERP-side observation, reported and not acted on.

## 3. The dropped filter and the dropped sort

Everything the ACL is built around holds, and each claim has a control beside it.

| | |
|---|---|
| `?code[eq]=CC-003` on `CostCenter` returns **every** row, with a 200 | **confirmed** — 3 of 3 |
| …and `data[0]` is `CC-001`, the wrong centre, so it reads as a hit | **confirmed** |
| An entirely invented parameter (`?nosuchfield=…`) is ignored, not rejected | **confirmed** |
| CONTROL: `?manager_id[eq]=nobody-at-all`, which *is* declared, returns 0 rows | **confirmed** — the drop is selective |
| `?sort=code&order=desc` on `CostCenter` falls back to the default order, 200 | **confirmed** — identical to unsorted |
| CONTROL: `?sort=sku&order=desc` on `Item`, which *is* declared, reverses the list | **confirmed** — the fallback is selective |

The two controls are not decoration. Without them, "every filter returns every
row" and "no sort ever reorders" would satisfy this section while meaning
something entirely different and much worse.

### The three measured facts in `packages/acl/schema/README.md`

All three are true of a live server.

| | |
|---|---|
| **0 of 51** entities declare `updated_at`; **0** expose it as filterable | **confirmed** |
| **34 of 51** entities expose no sortable field at all | **confirmed** |
| `CostCenter`'s only filterable fields are `parent_id` and `manager_id` | **confirmed** |

And `packages/acl/schema/baseline.json` is **byte-identical** to what this server
serves once `generatedAt` is removed. The committed capture is a capture. Given
that the first version of that file was hand-written and declared `updated_at`
filterable on every entity — which is how six `PollingChangeSource` tests passed
for the project's whole life against code that would have thrown — this is worth
having as a gate rather than as a belief.

One nuance the schema does not show, and the dangerous one: **every record
carries `updated_at` in its payload** even though no schema declares it. The
trait really does write the column; `buildUiSchema` reads the manifest's `fields`
rather than `resolvedFields`, so it is never declared. So
`?updated_at[gte]=2099-01-01T00:00:00Z` returns **everything** with a 200, and a
poller reading the data would see a plausible timestamp on every row it was handed
and conclude its watermark had bounded the read.

### The ACL refuses the right things, and only those

| | |
|---|---|
| `assertFilterable("CostCenter","code","eq")` throws `UnsupportedFilterError` | **confirmed** |
| `assertSortable("CostCenter","code")` throws | **confirmed** |
| `assertFilterable("Item","list_price","gte")` throws — declared-filterable, but a number | **confirmed** |
| `assertSortable("Item","list_price")` throws — declared-sortable, but a number | **confirmed** |
| CONTROL: `LeaveRequest.start_date` with `gte`, and `Item.sku` as a sort, are **accepted** | **confirmed** |

### `PollingChangeSource`

Driven at the live schema: `supportsIncremental("Item")` is `false` and a
`changesSince(…, "2099-01-01T00:00:00.000Z")` returns `mode: "full_sweep"` with
records in it. It asks the schema and falls back loudly, as designed; the
watermark bounded nothing and the batch says so. ADR-0001's "no incremental
polling is possible against `pack-erp-core` at all" is confirmed live.

## 4. Numbers are text; ISO-8601 dates are the exemption

README rule 4, measured. Fixture prices are 9, 20, 100 and 1000 — a set whose
text order (`100 < 1000 < 20 < 9`) differs from its numeric order in both
directions, so neither a filter nor a sort can look right by accident.

| | |
|---|---|
| `?list_price[gte]=1000` returns `[1000, 20, 9]` | **confirmed** — two wrong rows |
| `?sort=list_price&order=asc` returns `[100, 1000, 20, 9]` | **confirmed** — lexicographic |
| `?start_date[gte]=2026-02-01` and `[lt]` partition the set correctly, both non-empty | **confirmed** |
| Keyset pagination over a sortable view: `listAll` in pages of 2 walks every row, none repeated or skipped | **confirmed** |

`packages/sync` is justified. So is the CRM's refusal to read a number from the
ERP.

## 5. Error shapes

Both shapes are real, on the same API, and `toErpError` normalises every live
body correctly.

| Live case | Status | Content type | → kind / code |
|---|---|---|---|
| Bad token | 401 | `application/problem+json` | `unauthenticated` / `authentication_required` |
| Unknown route | 404 | `application/problem+json` | `not_found` / `not_found` |
| RBAC refusal | 403 | `application/json` | `forbidden` / `forbidden` |
| Missing record | 404 | `application/json` | `not_found` / `not_found` |
| Transition on a missing record | 404 | `application/json` | `not_found` / `not_found` |

Not one live body fell through to `unrecognised_error_shape`.

Two shapes the live server emits that the offline fixtures did not anticipate:

- **`{"error":"tenant_required","detail":"request principal has no tenant"}` at
  401, in the *handler* shape** rather than problem+json. It maps to
  `kind: "tenant_required"`, which `classify` does not name, so it reaches the
  catch-all and retries. That is the right outcome by a different route than
  `err.kind === "unauthenticated"`, and it only arises with no token at all,
  which the relay never sends. **No defect; recorded so the path is known.**
- **A non-string `detail`.** `json(400, { error: "invalid_settings", detail:
  parsed.error.issues })` in `admin-handlers.ts` puts an *array* in `detail`, and
  `HandlerErrorSchema` requires a string — so that body fails both parses and
  becomes `unrecognised_error_shape` / `kind: "unknown"`, which `classify`
  retries to the attempt cap for a request that will never be accepted. **Not
  reachable from the outbox today** (tenant settings and job-invoke are the only
  emitters, and the relay touches neither), so it is left alone rather than
  widened on an unverified path. It belongs in the ADR's open table.

## 6. The outbox round trip

Real `crm.outbox` rows, drained by `OutboxRelay` as `crm_app` through
`withTenantContext`, against the live ERP.

| | |
|---|---|
| A `create` lands at the ERP under the CRM's own `target_record_id` | **confirmed** — row `delivered`, `GET` returns it |
| The ERP's response is persisted on the outbox row | **confirmed** |
| A `transition:submit` moves the live record `draft → submitted` | **confirmed** |
| An out-of-order `transition:approve` is **not** marked delivered | **confirmed** — stays `pending`, `dead_reason` null |
| …and classifies as `retry_ordering`, not `already_delivered` | **confirmed** |
| …and keeps the ERP's own sentence on the row | **confirmed** — `'approve' cannot fire from 'draft'` |
| A redelivery whose target id is already at the ERP settles `already_delivered` | **confirmed** |
| …and the ERP holds exactly **one** record, not two | **confirmed** |
| A payload the ERP validates away dead-letters rather than retrying to the cap | **confirmed** |

**The 409 fix from the previous increment is correct.** It was made by reading
the ERP's source; this is the first time it has been seen. The live body is
exactly what it was written against:

```
HTTP/1.1 409
{"error":"invalid_transition","detail":"'approve' cannot fire from 'draft'","allowedFrom":["submitted"]}
```

`classify` reads `err.code === "invalid_transition"` **before** its
`kind === "conflict"` branch, so it yields `retry_ordering`. Had the old
classification still been in place, the row would have been marked delivered and
the transition silently lost.

### What the replay classification actually rests on — and it is not the 409

ADR-0001 item 6 says "treat a unique violation on replay as success", and
`classify` has a `kind === "conflict"` branch written for exactly that. **The
live server does not answer 409 for a duplicate record id.** It answers:

```
HTTP/1.1 500
{"error":"write_failed","detail":"duplicate key value violates unique constraint
 \"operate_entity_records_tenant_entity_record_key\""}
```

`toErpError` reads that as `kind: "unavailable"`, `code: "write_failed"` — not a
conflict. The only thing that rescues the classification is the `ALREADY_EXISTS`
regex over `detail`. Verified in both directions and pinned by the gate: with the
driver message present it classifies `already_delivered`; with the identical
status and code and the message removed it classifies `retry_transient`.

So the CRM's idempotency guarantee currently depends on the ERP **leaking
node-postgres's error text verbatim to the client**. The behaviour is right today
and the mechanism is not the one the ADR describes. If the ERP ever stops
leaking that string — which is ordinary hardening, and the kind of change nobody
would think to tell us about — a write that *did* land would be retried to the
attempt cap and then dead-lettered, raising `erp_write_failed` at a rep for a
write the ERP already holds. **Left open deliberately**: closing it means either
asking the platform for a stable code (the right fix, and not mine to make) or
having the relay re-`GET` the target id on an ambiguous 500 to decide, which is a
design change rather than a defect fix. Both belong in ADR-0001's open table.

### The same-process retry takes a different path again

A retry of the same outbox row sends the same `Idempotency-Key` — today
`crm-<row id>-r<revive count>`, and at the time of this run `crm-<row id>` — and
within one ERP process lifetime that hits the gateway's in-memory idempotency
store, which answers **201 with an empty body**. `ErpClient.request` returns
`null` for it without throwing, so the relay marks the row delivered — correct,
but via a third mechanism, and `erp_response` is `null` rather than the record.
Pinned by the gate so it is known rather than discovered.

So a replay resolves three different ways depending on timing, and only the
middle one is the one the ADR names:

| Situation | ERP answers | Relay outcome |
|---|---|---|
| Same row, same ERP process | 201, empty body (in-memory idempotency) | `delivered` |
| Same target id, ERP restarted or a fresh key | 500 `write_failed` + driver text | `already_delivered` |
| 409 `conflict_idempotency_mismatch` | the branch `classify` was written for | `already_delivered` |

The third was not reproduced live.

## 7. The two binaries, driven as processes

Everything in §1–§6 drives the CRM's `dist` as a **library**: the harness builds
its own `OutboxRelay`, hands it a `ServiceCredential` it assembled itself, and
calls `drainTenant`. ADR-0001's open table named what that leaves untested, in
these words:

> The CRM's own `api` and `scheduler` binaries were not driven at the live ERP.
> The relay was driven directly. The scheduler's per-tenant loop, its credential
> boot and its refusal to start on `ERP_TOKEN` under `NODE_ENV=production` are
> all still verified only against the fixture.

Both binaries now run as processes against the same live `operate-server`, and the
chain they complete is the real one end to end:

```
POST /v1/samples/receipts  →  crm.outbox (StockMovement/create, pending)
      (api.js, human JWT)          │
                                   │  scheduler.js, its own relay_drain tick,
                                   │  its own Ed25519 token, the tenant's own role
                                   ▼
                        POST /v1/stock-movements at the live ERP  →  delivered
```

Nothing in §7 calls `drainTenant`, mints a service token for the scheduler, or
resolves a role on its behalf. The shell starts and stops the processes — the same
pattern, and the same `trap`, the ERP and the JWKS endpoint already used — and
`scripts/live-erp/drive-binaries.mjs` only makes requests, reads state and parses
the log files the shell captured.

### The invocation, and what in it is load-bearing

```
# the API, with a stand-in IdP in front of it
PGUSER=crm_app PGDATABASE=crm_live1 PORT=0 \
OIDC_ISSUER=https://idp.test OIDC_AUDIENCE=https://crm.test/api \
OIDC_JWKS_URL=http://127.0.0.1:<ephemeral>/.well-known/jwks.json \
  node packages/api/dist/bin/api.js

# the scheduler, variable for variable as deploy/docker-compose.yml runs it
PGUSER=crm_app PGDATABASE=crm_live1 \
NODE_ENV=production ERP_BASE_URL=http://127.0.0.1:8788 \
CRM_SIGNING_KEY_FILE=<work>/key.pem \
CRM_TOKEN_ISSUER=https://crm.test ERP_TOKEN_AUDIENCE=https://erp.test \
TICK_INTERVAL_MS=1000 \
  node packages/scheduler/dist/bin/scheduler.js
```

- **`NODE_ENV=production` and no `ERP_TOKEN`.** The compose file defaults
  `SCHEDULER_NODE_ENV` to `production`, so this is the deployed arrangement and
  not a relaxed one. §7e asserts the refusal that arrangement implies.
- **`CRM_SIGNING_KEY_FILE`, not `CRM_SIGNING_KEY_PEM`.** The path form is what
  compose mounts at `/run/secrets`, and it is the one the boot reads from disk.
- **`TICK_INTERVAL_MS=1000`.** The knob the binary already reads, used rather than
  sleeping blindly: the gate waits, bounded, on the process's **own**
  `relay_drain` line. A hang fails; it does not hang.
- **`PORT=0` for the API.** The binary logs the port it actually bound, so the
  gate needs no fourth reserved socket and a stale listener cannot be mistaken for
  this one.
- **A second key set for the IdP.** ADR-0001 item 10's two tiers "never mix", so
  the human tier is given a different Ed25519 key, published in a different key
  set, from the service key the ERP trusts. §7b's negative control is the live
  form of that sentence.
- **`crm.service_key` is populated through the shipped registry.**
  `buildServiceCredential` refuses to start a process whose kid is not in that
  table, so the key the JWKS endpoint has been serving since §1 is published and
  activated through `PostgresServiceKeyRegistry` (with
  `--propagation-seconds 0`, the override the shipped CLI offers, because the ERP
  has already fetched this key set).

### a. The API binary, authenticated, writing the only thing it writes

| | |
|---|---|
| `GET /healthz` answers `200 ok`, so the process is connected as a role that does **not** bypass RLS | **confirmed** |
| An unauthenticated `GET /v1/me` is refused 401 | **confirmed** |
| An IdP-signed token is verified against the JWKS the binary **fetched over HTTP** and resolves to a rep | **confirmed** — `displayName: "Ada Lovelace"` |
| …carrying `erpEmployeeId`, the `crm.rep_profile` mapping ADR-0001 Q3 exists for | **confirmed** — `emp-1` |
| CONTROL: the same IdP signing a subject with no `rep_profile` row gets **403**, not a session | **confirmed** |
| A token with no `tenant` claim resolves the same rep from `x-tenant-id` | **confirmed** |
| `POST /v1/samples/receipts` records the movement and enqueues its ERP mirror in one transaction | **confirmed** — `201`, `erpMirrorEnqueued: true` |
| …as `StockMovement`/`create` under the CRM's own `crm-sm-<movement id>` | **confirmed**, `state: pending` |
| …with the inversion right: the CRM's `receipt` is the ERP's `issue` | **confirmed** |

`/healthz` is not a formality here. `withTenantContext` refuses a connection whose
role is `SUPERUSER` or `BYPASSRLS`, so a 200 is the binary's own statement that
every tenant-scoped route below *can* be served. Pointed at `PGUSER=postgres` it
answers exactly what README rule 1 says it answers:

```
503 {"status":"degraded","detail":"connected as postgres, which bypasses
     row-level security — connect as crm_app"}
```

### b. The two credential tiers do not mix, live

A token signed with the **ERP-facing service key** is refused by the CRM's own API:

```
401 {"detail":"unknown_key: no key 0EewNz9IuZsQgA6jthwt8ca4pWZMNTsepP0GfzyeVW8 …"}
```

Nothing in production can produce that token — the scheduler holds that key and
never calls the API — which is precisely why it is worth proving the door is shut
rather than assuming it. Pointed at the service key set instead of the IdP's, the
API accepts it and the check goes red, so the check is measuring the key set and
not the shape of the token.

The complementary half: **the API publishes the key set the ERP verifies against**,
out of `crm.service_key`, over its own socket.

| | |
|---|---|
| `GET /.well-known/jwks.json` from the API publishes the active kid as `kty=OKP, crv=Ed25519` | **confirmed** |
| and no private half (`d`) is in the document | **confirmed** — members are `kty,crv,kid,x,use,alg` |

Everything earlier in this gate was served by `jwks-server.mjs`, a harness script
calling `jwksResponse` directly. This is the deployed arrangement: the API
publishes from the database and holds no private key at all, so a compromised API
could not mint a token.

### c. No API route crosses the boundary synchronously — pinned as a check

The brief asked for an API route that genuinely reaches the ERP. **There is none,
and that is the design.** `packages/api/src/` imports nothing from `@crm/acl`,
constructs no `ErpClient`, and makes exactly one outbound HTTP call in the whole
package — `fetch(url)` for the IdP's JWKS in `bin/api.ts`. Every read it serves
comes from a `crm.*` snapshot; the only write that leaves the CRM is an
`crm.outbox` row.

So the boundary is crossed **asynchronously, by the scheduler**, and the gate pins
that rather than papering over it:

```
ok: the ERP has not heard of it yet — no API route crosses the boundary
    synchronously — GET /v1/stock-movements/crm-sm-acd4f040-… = 404
```

If that ever answers 200, some route has grown a synchronous ERP call and the
chain in §7d stops proving what it says it proves.

### d. The scheduler binary: the credential boot, the loop, the drain

| | |
|---|---|
| It built a **signing** credential at boot from the file `CRM_SIGNING_KEY_FILE` names | **confirmed** — `kind=signing`, kid matches the published key |
| It minted a per-tenant token under the ERP role resolved from `crm.erp_service_principal` | **confirmed** — `role=erp_admin`, `tenant=1111…1111` |
| …with the jti and expiry an operator correlates a 401 with | **confirmed** |
| …and the token itself is in **no** log line | **confirmed** — 0 lines of 22 carry a JWT shape |
| The row the API queued reached `delivered` on the scheduler's own timer | **confirmed** — `attempts=1` |
| …with the ERP's own response persisted on it | **confirmed** |
| The mirrored `StockMovement` is at the live ERP | **confirmed** — `issue`, `12.000`, `wh-1` |
| …carrying the lot in `reason`, the only place the ERP's `StockMovement` can hold it | **confirmed** — `"CRM sample receipt: lot LOT-LIVE-1 exp 2027-10-06 (drug_sample)"` |
| It stops cleanly on `SIGTERM`, logging `shutdown`, draining the tick in flight | **confirmed** — exit 0 |

**The credential boot is the half nobody had seen work.** It is not a token handed
to the process: it reads a PKCS#8 PEM off disk, derives the RFC 7638 thumbprint,
asks `crm.service_key` whether that kid is published, builds a
`PostgresServiceRoleSource` over the pool, and resolves the tenant's ERP role
through `withTenantContext` as `crm_app`. Pointed at the unpublished rogue key the
gate generates for §1's negative control, the real refusal fires against the real
database and the process never starts:

```
scheduler failed to start: the signing key tcxVJg9v072hIncwEkGOh2ZfDDRvFBwzvdP-agIkcgU
is not in crm.service_key, so it is not published in the JWKS. Every token it signs
would be rejected with credential_not_found. Publish it (crm-service-key publish)
before starting.
```

**The log line is the operator's only view of a drain.** There is no metrics sink
in this system, so a line that quietly changes shape is a line nobody notices
changing. The gate reads the process's actual stdout:

| | |
|---|---|
| Every line on stdout is one JSON object a log shipper can parse | **confirmed** — 22 of 22 |
| …each carrying a `ts` and a `type` | **confirmed** |
| The `relay_drain` summary names every counter a human reads | **confirmed** — `claimed delivered retried dead alarmed unattributed pending oldest` |
| …and the numbers agree with the database | **confirmed** — `delivered=1` |
| …attributed to the tenant it drained, with its duration — the per-tenant loop, not a global one | **confirmed** |

```
{"ts":"…","type":"job_ok","tenantId":"1111…1111","job":"relay_drain",
 "durationMs":208,"detail":"claimed=1 delivered=1 retried=0 dead=0 alarmed=0
 unattributed=0 pending=0 oldest=-s"}
```

The same tick also **read** the ERP, through the scheduler's own
`SnapshotRefresher`, which closes a loop neither binary could close alone:

| | |
|---|---|
| `crm.product_snapshot` was filled from the live ERP by this process | **confirmed** — 4 rows, `9.00 20.00 100.00 1000.00` |
| …and the line says out loud that `since` bounded nothing | **confirmed** — `UNBOUNDED: product,rep,account published no filterable+sortable updated_at` |
| **`?list_price[gte]=1000` at the ERP returns 3 rows; `?minPrice=1000` at the CRM's API returns 1** | **confirmed** — `ERP=[1000,20,9] API=[1000.00]` |

That last line is why `packages/sync` exists, measured across both binaries and
the live server in one assertion: the ERP compares the number as text (§4), the
CRM's API answers the same question off the typed snapshot the scheduler just
wrote, and only one of them is right.

### e. The two negative controls

**The ERP role comes from the tenant's row, not the process's environment.** The
second scheduler run's environment is byte-identical to the first. The only change
is one column of one row:

| | |
|---|---|
| With `crm.erp_service_principal.erp_role` flipped to `erp_viewer`, the token carries `erp_viewer` | **confirmed** |
| …the live ERP refuses the create, so the row **dies** rather than retrying forever | **confirmed** — `dead_reason = "forbidden: principal's effective roles do not grant 'create' on 'StockMovement'"` |
| …and the record is not at the ERP, so the refusal was the ERP's | **confirmed** — 404 |
| …and the binary logs the dead **row** on stderr, naming the write that will never land | **confirmed** |

That last one only exists in a deployed process because the binary wires `onEvent`
into `OutboxRelay`. No aggregate can reconstruct which write will never land:

```
{"ts":"…","type":"relay_dead","outboxId":"842af9ce-…","tenantId":"1111…1111",
 "entity":"StockMovement","operation":"create","targetRecordId":"crm-sm-4b0e…",
 "reason":"forbidden: principal's effective roles do not grant 'create' on 'StockMovement'"}
```

**It refuses to start on a static `ERP_TOKEN` under `NODE_ENV=production`.** A
process-start decision, so it is asserted on the exit status and the sentence, not
on a return value — and with no `CRM_SIGNING_KEY_FILE` in the environment, because
a signing key takes precedence over `ERP_TOKEN` by design and leaving one set
would make the check pass for the wrong reason.

| | |
|---|---|
| It exits **non-zero** | **confirmed** — 1 |
| …naming the cause (`ERP_TOKEN is a development-only static credential`) and the remedy (`CRM_SIGNING_KEY_PEM`) | **confirmed** |
| …and it is a refusal, not a hang | **confirmed** — the gate fails a 124 from `timeout` by name |
| COMPLEMENT: the same binary and the same `ERP_TOKEN` **do** start outside production | **confirmed** — `{"type":"credential","kind":"static","kid":null}` |
| …with the development-only warning on stderr, not silently | **confirmed** |

The complement is the half that makes the section mean anything: without it, this
passes just as well against a binary that cannot start at all. The `-ne 124` guard
earns its place too — removing `NODE_ENV=production` makes the process run until
`timeout` kills it, which satisfies "exited non-zero" while proving the opposite.

### f. Every process is shut down, on both paths

A leaked listener is the failure that disguises itself: the next run fails on
"something is already listening on 127.0.0.1:8788", four steps from the cause. The
`trap` covers the failing path and names each process it kills; §14 covers the
**passing** path, which the trap never exercises, and it examines only this run's
own pids — another agent's scheduler on the same host is not this gate's business.

### What this run falsified

**Nothing about the two binaries.** They did exactly what `README.md` and ADR-0001
say they do, on the first run that reached them. Four beliefs died in earlier
rounds of this gate — a 409 that is really a 500, a tenant cross-check that is
conditional, a 422 with no `detail`, an idempotency replay that told the operator
less than before they pressed retry — and it is worth saying plainly that this
round killed none of that kind. The credential boot, the per-tenant loop, the role
resolution, the production refusal and the log line were all right as written, and
"it worked first try" is information: the one part of the integration that had
never been executed as a process turned out to need no changes at all.

Two things did die, and both were in the **gate**, which is the next most useful
place for a belief to die:

- **A case's instrumented ERP client was seeing another case's traffic.** §6(v)
  asserts that an ambiguous 500 on a *transition* reads nothing back, and it
  failed:

  ```
  FAIL: an ambiguous 500 on a TRANSITION reads nothing back — existence is not
        the question there
        — got writes=1 recordReads=["/v1/leave-requests/crm-lr-muvyaod0-i"]
  ```

  The read it saw is `…-i`, which is §6(iv)'s row, not its own. §6(iv) leaves that
  row `pending` deliberately, the first retry's full-jitter backoff is
  `random(0, 1000)ms`, and `drainTenant` claims every **due** row of the tenant —
  so the earlier row was retried through the later case's client and its probe was
  attributed to the transition. The rule was never broken; the harness reported it
  broken, which is the same disagreement between harness and reality as the four
  deaths above, pointing the other way. A gate that fails while the code is
  correct is worse than no gate, because the first assumption is that the code
  changed. Fixed twice over: the §6(iv) row is parked an hour out before anything
  else drains, and the assertion is scoped to reads of **its own** target, so no
  future row can resurrect it. Four consecutive runs green.

- **A throw inside a phase shrank the check count silently.** Found while proving
  the new checks can fail: pointing the API at `PGUSER=postgres` made
  `drive-binaries.mjs`'s own `withTenantContext` refuse, the phase died on an
  unhandled rejection, and the remaining checks were neither `ok` nor `FAIL`. The
  shell still failed the run, so nothing passed that should not have — but the
  total was under-reported, and a count that can shrink is a count nobody can read
  as coverage. Each phase now runs inside a `try`, a throw is a named failure like
  any other, and the count is written in a `finally`.

### How each new check was shown to fail

Every assertion in §7 was watched going red, by breaking the thing it measures and
restoring it. The breakages, and what each one reddened:

| Breakage | Checks it turned red |
|---|---|
| The scheduler is never started; the drain phase runs anyway | 14 of §7d's 16 — credential, mint ×2, delivered, `erp_response`, the ERP record ×2, stdout-objects, the summary ×3, the snapshot ×2, the numeric comparison |
| A plain-text line, a JWT-shaped line and a `pending=` counter removed from the captured stdout | the remaining 4 — stdout-objects, `ts`/`type`, the summary's counters, the token-leak check |
| `erp_role` left at `erp_admin` instead of being flipped | 4 of §7e's 5 — the minted role, the dead row, the ERP's 404, the `relay_dead` line |
| A non-JSON line appended to the scheduler's captured stderr | the 5th — stderr-is-JSON |
| The API connected as `PGUSER=postgres` | 6 of §7a — `/healthz`, `/v1/me` ×2, the 403 control, the header fallback, the receipt |
| `OIDC_JWKS_URL` pointed at the **service** key set | 8 of §7a/§7b — the cross-tier refusal, the IdP handshake ×2, the 403 control, the fallback, the receipt, the queued row ×2 |
| `crm.service_key` emptied before the API starts; the anonymous probe aimed at a `public: true` route; the mirror POSTed to the ERP before §7c looks | 4 — the JWKS ×2, the 401 control, the no-synchronous-crossing check |
| `CRM_SIGNING_KEY_FILE` pointed at the unpublished rogue key | the boot wait — `the scheduler's own relay_drain tick: the process exited first` |
| `SIGKILL` instead of `SIGTERM` | the clean-stop check — exit 137 |
| `NODE_ENV` dropped from the refusal run / added to the complement | both §7e production checks |
| The API deliberately not killed before §14 | `a process this gate started is still running: 6450` |
| A `kid` edited to disagree with its own key material | `publish-key.mjs` exits 1: `publish derived kid 9bBh8…, but the JWKS publishes not-the-thumbprint` |

## The defect found and fixed

**A 422 dead-lettered with no reason a human could act on.**

The ERP answers a rejected write with `{error: "validation_failed", fields:
[{field, code, message}]}` and **no `detail`** (`operate-runtime/src/
handlers.ts:326`). `HandlerErrorSchema` is `{error, detail?}`, so `fields` was
dropped, `ErpError.detail` was `undefined`, and `classify` produced:

```
dead_reason = "validation_failed: write guard refused"
```

The relay dead-letters a 422 — correctly, no retry can fix a malformed payload —
so `dead_reason` is the whole of what a human gets, and it is what README rule 31
and ADR item 31's "way back" depend on. It said nothing.

**Invisible offline, and for a specific reason:** every fixture in
`problems.test.ts` supplied `detail: "x"`. The live server never does. This is
the defect class the brief asked about — a check that passes while the behaviour
is broken — and it survived because the fixture and the server disagreed.

The failure, first:

```
FAIL: and the dead reason names the FIELD the ERP rejected, so it can be fixed
      — got "validation_failed: write guard refused"
```

The fix, in `packages/acl/src/problems.ts`: a lenient `describeFieldErrors`
reads the `fields` array and `toErpError` uses it when the handler sent no
`detail`. Parsed **separately** from `HandlerErrorSchema` and leniently, which is
the part that matters — as a required member, an ERP that changed the `fields`
shape would make the whole body unrecognisable, turning a precisely classified
422 into `unrecognised_error_shape`, which `classify` retries. A body this cannot
read keeps whatever `detail` it had. Seven tests cover it, including that
unreadable-`fields` case.

Shown failing against the unfixed mapper:

```
× carries the rejected field into detail when the handler sent no detail
  → expected undefined to be 'request_number is required'
× joins several field errors, so a dead letter names every one
  → expected undefined to be 'sku is required; status must be one o…'
```

and live, after:

```
ok: and the dead reason names the FIELD the ERP rejected, so it can be fixed
    — "validation_failed: request_number is required"
```

## The second defect found and fixed: a retry that told the operator less

Added in §6i, which reads the death HISTORY the trigger writes rather than the
queue row — and found that the gateway's in-memory idempotency store, already
known to answer a replay **with the status and without the body**, was corrupting
the one record that exists to answer "is pressing retry worth anything".

The run that found it, verbatim:

```
FAIL: the second death is reported as a REPEAT of the first — the ERP said the
      same thing twice
      — got entries=2 repeat=false
        first="validation_failed: request_number is required"
        second="rejected: unrecognised_error_shape"
```

Same outbox row, same payload, same server, two deaths — and the second one does
not say what the first said. `idempotencyKeyFor` was `crm-<row id>`, fixed for the
life of the row, so a **revived** write re-asked under the key the gateway had
already answered. The replay came back 422 with no body, failed both error parses,
and the history recorded the CRM's failure to read an answer in place of the ERP's
sentence. Two consequences, and the second is worse than the first:

- the operator who pressed retry was told **less** than before they pressed it;
- `is_repeat_of_previous` called an identical cause a new one, which is the exact
  question `crm.outbox_dead_letter` was built to answer, answered backwards. A
  history that says "different cause each time" is a history that says "keep
  retrying".

The fix is one line of key derivation and a paragraph saying why:
`crm-<row id>-r<revive count>`. Stable **within** an episode, so a worker that
died after sending and before settling is still deduped by the gateway; distinct
**across** episodes, because a revive is a request for the ERP's answer *now*, on
the premise that the cause was fixed, and replaying the old answer makes that
unanswerable. Nothing is risked: if the earlier attempt actually landed, the
collision is on the record id the CRM minted itself and settles as
`already_delivered` — which §6h proves against this same server with the driver
message stripped out. The key only ever saved a round trip.

**Why no offline test could have caught it.** The fake ERP answers every request
it is given; it has no idempotency store, so it cannot replay. The behaviour only
exists where a real gateway remembers a key across two requests, which is the same
property §6's three-way replay table is about. This is the fourth time in this
repo that "the fixture was kinder than reality" has been the defect class, and the
first time it was the ERP's *memory* rather than its schema or its words.

After the fix, on the same server:

```
ok: the second death carries the ERP's OWN sentence again, not the CRM's failure
    to read a replayed answer
    — first="validation_failed: request_number is required"
      second="validation_failed: request_number is required"
ok: so the summary reads as the button being pressed instead of the cause being
    fixed — always=true never=false distinct=1
```

## What is left open

- **The replay classification depends on a leaked driver string** (§6). The
  highest-value item here. Needs either a stable ERP code for a duplicate record
  id, or a relay that re-reads the target on an ambiguous 500.
- **A non-string `detail` becomes `unrecognised_error_shape`** (§5). Unreachable
  from the outbox today; widening it on an unverified path would be the same
  mistake as the hand-written baseline.
- **The ERP's tenant cross-check is conditional on the claim being present**
  (§1). An ERP-side gap. The CRM's defence is `mintServiceToken`'s UUID check,
  now asserted. ADR item 10's wording needs correcting.
- **`WhtCertificate` is routed with empty access lists** (§2). Nobody can reach
  it. ERP-side.
- **The custom-manifest path is not exercised.** `--per-tenant-manifests` was on,
  but the tenant has no activated manifest, so it fell back to the boot pack. A
  tenant on a custom manifest has a different entity set (ADR-0001 Q11) and
  nothing here tests `UnknownEntityError`, a divergent slug set, or a
  per-tenant schema cache serving two different shapes at once.
- **Option (b)'s single database is not exercised.** The ERP has its own database
  here, so cross-schema reads, the `crm_app` `SELECT` grant on the real
  `meta.operate_entity_records`, and the shared-fate properties are untested.
- ~~**The CRM's own `api` and `scheduler` binaries were not driven at the live
  ERP.**~~ **Closed by §7.** Both run as processes now, the credential boot is the
  real one, and the drain happens on the scheduler's own tick. What is still open
  *within* that:
  - **One tenant, one instance, one tick.** The per-tenant loop is exercised with
    exactly one tenant in `crm.tenant`, so nothing here shows two tenants isolated
    from each other inside one tick, and nothing shows two scheduler instances
    sharing the work — `claimDueJobs` advances `next_run_at` inside the claim and
    `FOR UPDATE SKIP LOCKED` is meant to make that safe, which is a concurrency
    claim no single-instance run can test.
  - **The jobs other than `relay_drain` and the snapshots are only observed, not
    asserted.** `expiry_sweep`, `notify_prune`, `notify_dispatch` and
    `expense_post` all run in the first tick against the live database and are
    seen to succeed; the gate asserts nothing about what they did, because the
    rows they act on are not seeded. `expense_post` in particular is the one job
    that writes the GL, and the Finance questions below still gate it.
  - **`relay_drain`'s own cadence is nudged, not waited out.** The second
    scheduler run has its `next_run_at` pulled back to `now()` rather than the
    gate spending the job's 30s window; the tick itself still happens on the
    process's loop, through `claimDueJobs`, but the *schedule* is not what is
    under test there.
  - **The API's write path is exercised at one route.** `POST
    /v1/samples/receipts` is the only API route that writes `crm.outbox`, so it is
    the whole of the boundary — but `/v1/samples/returns`, the mirror in the other
    direction (`return_to_warehouse` → the ERP's `receipt`), is not driven, and
    neither is `POST /v1/erp-writes/:id/retry`.
  - **The IdP is a stand-in signing EdDSA.** `verifyJwt` supports RS256
    specifically because Entra, Auth0, Cognito and Keycloak default to it, and no
    live run has ever handed it an RS256 token. Covered offline by `jwt.test.ts`
    and nowhere else.
- **Nothing about TLS, a proxy, concurrency, or key rotation under live traffic.**
  The JWKS is plain HTTP on loopback and one key is published for the run.
- **No GL path.** `Expense`, `JournalEntry` and the period-lock retry were not
  driven; ADR-0001's Finance questions still gate them.

## A collision worth recording

The working tree is shared with four other agents. `packages/relay/src/
attempt-history.contract.test.ts` and `db/migrations/0036_ordering_and_
attempt_history.sql` landed during this work and 35 of that file's tests fail
against a contract-test database that has not had 0036 applied. Not touched, and
not this work's doing: excluding that one file, `packages/acl` and
`packages/relay` are 154/154 green, `npx tsc --build --force` is clean, and
`./scripts/typecheck-tests.sh` reports `ok: acl`, `ok: credential` and
`ok: relay`. The only test-typecheck failure in the workspace is in
`packages/storage`, another agent's new package.

# The deployment stack, built and run

*2026-10-07. Reproduce with `pnpm deploy:smoke` (needs a Docker daemon) or
`pnpm deploy:image` (does not).*

The question that prompted this was "is it ready to be deployed, and where do I
host it", and answering it honestly meant reading `deploy/` again. Every document
in it carried the same sentence — the stack has **never been built or run**, no
Docker daemon has been available in any session that touched this repo — and the
first half followed from the second, which nobody had checked.

**`dockerd` starts fine in this container.** It took one command. What the first
real `docker build` then showed is that the image could not be built at all, and
had not been buildable since the day `deploy/` landed.

## The four defects

Each is independently fatal, and each was invisible to reading the file.

**1. The manifest layer named 8 of the 16 workspace packages.** `deploy/Dockerfile`
copies the `package.json` files, installs, then copies sources — the ordering that
makes a source-only change reuse the dependency layer. The list was never
complete: `callplan`, `credential`, `erasure`, `expense`, `notify`, `role`,
`sample` and `storage` were absent. A package not present when pnpm runs is not an
importer, so it gets no `node_modules` of its own, and the build step died:

```
packages/notify/src/dispatch.ts(2,35): error TS2307: Cannot find module '@crm/db'
packages/credential/src/credential.ts(1,39): error TS2307: Cannot find module '@crm/acl'
tsc exit=2   # 102 .js emitted; no packages/api/dist/bin/api.js at all
```

The compose file was impeccable, and it named an entrypoint that could not exist.

**2. `@crm/erasure` was built by nothing.** It is absent from the root
`tsconfig.json`'s references, and the root `build` script is `tsc --build`, which
builds references and nothing else. So the GDPR Article 17 executor and the
tombstone signer — the previous two increments — compiled only when someone ran
`pnpm --filter @crm/erasure build` by hand. The package typechecks, its tests pass
(vitest transpiles from source), it declares a `crm-erasure` bin, and no gate
anywhere asked whether that bin exists.

**3. `pnpm prune --prod` cannot run in a docker build.** Excluding dev
dependencies rewrites `node_modules`, pnpm 10 asks before doing that, and with no
TTY it refuses outright:

```
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY  Aborted removal of modules directory due to no TTY
```

A docker build has no TTY. The step could never have succeeded.

**4. And had it succeeded, the image could not have served a request.** In a
workspace, prune empties every importer's `node_modules` and relinks only the
root. Measured: `packages/api/node_modules/@crm` holds 12 links before, and is
**empty** after. The api would have died on its first import:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@crm/callplan'
  imported from /app/packages/api/dist/handlers/routes.js
```

`pnpm -r prune` is not a thing — exit 1, dev dependencies left in place. The fix
is a second `pnpm install --frozen-lockfile --prod --ignore-scripts`, which keeps
the promise the prune was there for (nothing is re-resolved; the lockfile is read
again and obeyed) and leaves all 12 links in place with typescript and vitest
gone.

## Why six weeks of CI never said a word

There was no `.dockerignore`. `COPY packages/ packages/` therefore landed the
host's `packages/*/dist`, `packages/*/tsconfig.tsbuildinfo` and
`packages/*/node_modules` on top of what pnpm had just installed. `tsc --build`
read a buildinfo written on the host, concluded every project was up to date, and
emitted nothing — and the image still worked, because `dist/` had arrived in the
same `COPY`. An image built on a developer's machine shipped artifacts compiled on
that machine, from whatever their tree happened to contain, and its own build step
was decorative. Only a clean context shows the truth, and the only clean context
was CI, which was not building.

That is the shape worth remembering: **the three defects in the build were hidden
by a fourth property that made local builds succeed for the wrong reason.** Every
check that existed was a check on the text of the files.

## What now runs

| | what | needs a daemon |
|---|---|---|
| `pnpm deploy:verify` | ten static properties, `docker compose config` among them | no |
| `pnpm deploy:image` | replays both Dockerfile stages, then runs the entrypoints out of the runtime stage's file set | no |
| `pnpm deploy:smoke` | builds the image and brings the stack up against a real Postgres | yes |

`verify-image-build.sh` *interprets* `deploy/Dockerfile` — it parses the COPY and
RUN steps and replays them, and a step it cannot interpret is a failure rather
than a skip. A paraphrase would have been written from the same wrong list and
agreed with it. It assembles the context from `git ls-files`, so working-tree
edits are included and nothing `.gitignore` covers can appear, which is the same
guarantee `.dockerignore` now gives the real build. Each stage gets its own
directory, so the runtime stage has exactly what its COPY lines give it — which is
the only way defect 4 becomes visible.

## The run

```
--- 1. build the image from a clean context ---
ok: image built
--- 3. the database, and a migration that must refuse ---
ok: database healthy
ok: migrate refuses without the ERP, naming the cause
--- 4. the ERP stand-in, then the real migration ---
ok: 53 migrations applied
ok: a second run applies nothing
--- 5. the api, as crm_app ---
ok: api healthy (and therefore connected as a role RLS applies to)
ok: healthz 200, jwks 503 with nothing published, 401 problem documents on a real route
--- 6. the scheduler: refuses without a credential, runs with one ---
ok: refuses to start with no credential, saying which variables to set
ok: scheduler running, signing with zheYxcWUS-b7wCfHkHt2aDB-nM82n_RXaC1JlJyVuGE
ok: the api publishes exactly the key the scheduler holds
```

Things in that transcript that had never happened before:

- **migration `0001`'s ERP precondition refused a real deploy.** Until now it was
  tested in SQL. In a container it produces the message an operator will actually
  read, naming `meta.operate_entity_records` and what to run first, instead of a
  deploy dying on `schema "meta" does not exist` thirty lines later.
- **The api came up healthy**, and healthy is a stronger claim than it looks:
  `/healthz` asks the database what role the connection runs as and answers 503
  for the table owner. The compose file's two identities — admin for `migrate`,
  `crm_app` for everything else — are the isolation guarantee, and this is where
  they stop being an assertion.
- **The JWKS answered 503 with nothing published, not an empty key set.** The
  first version of the smoke script asserted 200 there and failed. The script was
  what was wrong: the rule is in `routes.ts`, and the reason is the ERP's refresh
  logic, which keeps its last good key set on any non-200 and replaces it on a
  200. An empty document would silently disarm every verifier that fetched it. The
  script now asserts the refusal.
- **The credential worked across two containers and a database.** The scheduler
  holds the private key and refuses to boot without one; the api publishes the
  public half out of `crm.service_key` and holds no private key at all. The smoke
  test asserts the kid the scheduler logs is the kid the api serves — so a
  compromised api still cannot mint an ERP token.
- **The scheduler's refusal is quiet enough to leave running.** With
  `restart: unless-stopped` and no credential it crash-loops, but Docker's restart
  backoff grows: 9 restarts in the first 22 seconds, 10 by 52. It fails closed,
  says which variables to set, and does not flood.

## What is still not proven

- **ACME, though the edge itself now is.** Docker Hub answered `429 Too Many
  Requests` to every anonymous pull of `caddy:2` in this sandbox, so step 7 was
  skipped here with `CRM_SMOKE_SKIP_CADDY=1`, which prints that it was skipped,
  because an unexplained skip is a lie. CI has no such limit, and the run on the
  commit that landed this answered `ok: caddy serves the api over TLS` on a build
  of `deploy/Dockerfile` with no deviations at all — so the proxy and the
  certificate path are exercised. What is not is **issuance**: `DOMAIN=localhost`
  means Caddy's internal CA, so the first real deploy is the first time ACME, a
  real domain and a real certificate happen together.
- **The build in this sandbox needed two deviations**, both printed by the script
  and neither committed: the proxy's CA inside the build (a sandbox that
  re-terminates TLS, else pnpm cannot reach the registry) and a digest for the
  base image (the same 429). CI passes neither, so CI builds `deploy/Dockerfile`
  byte for byte.
- **A real OIDC issuer.** `OIDC_*` points at `your-idp.example.com`; every
  request in the smoke run is a 401 by design. The authenticated path is covered
  by §7 of this document against a stand-in IdP, and by the contract tests.
- **The ERP.** `ERP_BASE_URL` points at a host that does not exist in the smoke
  run, so the outbox has nothing to drain into. §1–§7 above cover that path
  against a real `operate-server`.
- **Nothing about load, concurrency across replicas, or a restart under traffic.**

## And then CI, which had been red the whole time

The section above says six weeks of CI went over an unbuildable image. Checking
that claim — by reading the actual runs, which the work had not done, because it
read the files instead — found it was wrong in the more interesting direction.

`deploy-stack` was green. **`build-and-test` was failing, on every run.**

```
FATAL:  password authentication failed for user "crm_app"
DETAIL:  User "crm_app" has no password assigned.
        Connection matched pg_hba.conf line 128: "host all all all scram-sha-256"
```

Reproduced exactly, now that a daemon is available, by running the suite against
the same `postgres:16` image over TCP rather than the local unix socket:

| | over a socket (local) | over TCP (CI) |
|---|---|---|
| test files | 82 passed | **32 failed**, 50 passed |
| tests | 2,117 passed | 17 failed, 1,027 passed, **1,073 skipped** |

`appPool()` connects as `crm_app` deliberately — the API suite once ran as the
admin, so RLS was off for all of it, and `crm.revoke_rep_role` ended one tenant's
grant from another tenant with every test green. But `0001` creates the role with
`CREATE ROLE crm_app LOGIN` and no password: invisible under peer auth on a
socket, fatal under `scram-sha-256` over TCP.

**The number that matters is 1,073, not 17.** After a `beforeAll` fails, vitest
reports the rest of the file as skipped, and a skipped contract test looks exactly
like a passing one in a summary line. The suite never said "1,073 tests did not
run". It said "17 failed", and 17 failures in a red job that nobody opened is
indistinguishable from flake.

Fixed in two places, because a password is forgettable: CI sets `PGAPPPASSWORD`,
and `scripts/setup-test-db.sh` applies it and then **opens the suite's own
connection** with exactly what `appPool()` would use, refusing to finish if it
cannot — naming the socket-versus-TCP distinction in the error, since that is the
whole of it. Verified: the same container over TCP now runs **82 files / 2,117
tests green**, and with `PGAPPPASSWORD` unset the setup stops with the reason
instead of building a database the suite would skip against.

Nothing about the two defects is related. What is related is the habit: item 23
came of never running `docker build`, and this came of never reading a CI run.

### The second cause, which the annotations named in one line

Fixing the password left the job red, and the failure reproduced nowhere: not
over a socket, not over TCP against the same `postgres:16` image, not with
`CI=true` and `PGHOST=localhost`. 82 files / 2,117 tests green in all three.

Reading the log was not an option either, and that is worth recording as its own
finding: **every job with a service container ends by dumping that container's
entire log**, and `postgres:16` under this suite writes ~90 KB of expected
negative-test errors — `ERROR: new row violates row-level security policy`, which
is a test *passing*. Checking the residual failure meant 92,834 characters of
that and not one line of vitest. So the Test step now re-emits its failures as
workflow **annotations**, which have their own endpoint and cannot be buried by a
sidecar. The next run named the cause in one line:

```
FAIL packages/notify/src/subject-coverage.contract.test.ts
  → spawnSync rg ENOENT
```

**Two coverage suites shelled out to ripgrep.** A GitHub runner has none. They
scanned the repository for every `subjectTable` argument in non-test source and
for every `CREATE TABLE crm.attachment` in `db/migrations`, and they worked only
on a machine with `rg` installed — a test whose verdict depends on a binary
nobody declared.

Installing ripgrep in the workflow would have fixed the symptom. Instead the
dependency is gone: `grepRepo` in `packages/db/src/testing.ts` is the same scan
in Node, emitting ripgrep's `path:line:text` so both call sites parse it
unchanged. **It throws when it matches nothing**, and that is the whole design
rather than an edge case: `rg` exits 1 on no match, which made `execFileSync`
throw and the test fail, while a Node version returning `[]` would hand a
coverage suite an empty producer set and let it pass vacuously — green, claiming
coverage it never checked. Scanning zero files throws for the same reason.
`packages/db/src/testing.test.ts` pins both refusals, the `node_modules`/`dist`
skip, and that a `/g` pattern does not skip lines through a stale `lastIndex`.

Two things caught themselves on the way:

- the new helper's own doc comment contained the literal token `subjectTable:`,
  and the notify suite — which greps non-test source for exactly that — failed on
  it. The test was right; the comment now names it without the colon and says
  why;
- `grepRepo({ dir: "." })` prefixed every path with `./`, so a caller matching
  `rel === "package.json"` saw nothing. Normalised in the helper, pinned by a
  test, and found by writing the test rather than by using it.

**83 files / 2,123 tests green on both transports.** The suite grew by one file
and six tests, all of them about the harness.

# The client, in a real browser, taken offline

*2026-10-08. Reproduce with `pnpm client:verify` (needs a Postgres and a Chrome).*

ADR-0001's open table carried one row longer than any other, in capitals: **THERE IS NO
CLIENT**. Everything the CRM had built for a device was a guess about a consumer that did
not exist — ids minted before the network (0012), `POST /v1/sync/visits` answering per
row, the upsert that makes a replay idempotent, `tenant_deleted` given its own problem
type specifically so "an offline client holding a queue of unsent visits" would stop
rather than spin. Nothing had ever held such a queue.

`scripts/verify-client-live.sh` stands up a throwaway database with the ERP stand-in and
all 54 migrations, a stand-in IdP publishing a JWKS, the CRM's **own `api` binary**
verifying tokens against it, and a static server that serves the app and proxies `/v1`
from one origin — `deploy/Caddyfile`'s arrangement, reproduced rather than assumed. Then
it drives a real Chromium over the DevTools Protocol, with no test framework: Node 22
ships a WebSocket client, and `Network.emulateNetworkConditions {offline: true}` is the
one capability that matters here.

**41 checks, 0 failures.** The sequence, in one session:

```
ok: an unauthenticated device is offered a sign-in, not a blank screen
ok: the API's /v1/accounts reaches the screen, in the rep's own territory and the server's order
ok: the app says it is offline
ok: a visit is recorded with no network, and the screen says it is on the device — not filed
ok: the visit is in IndexedDB, which is what survives the tab being killed
ok: the id was minted on the device as a v7 UUID (01a11cde-b6ef-7470-81bc-417d853301df)
ok: and NOTHING is in crm.visit yet — the queue is the only copy
ok: syncing while offline reports it could not reach the server, and keeps the row
ok: exactly one row in crm.visit
ok: and its primary key is the id the DEVICE minted, which is what makes a replay idempotent
ok: re-sending an already-accepted visit is accepted again
ok: and there is STILL one row — the upsert by device id holds
ok: three visits queue up across a round with no signal
ok: and all three land in one batch when the signal returns
ok: the server's own words are on screen (rep … did not cover account acc-not-mine on …)
ok: the refused row is KEPT as rejected, not dropped — a visit that happened is not deleted by a 403
ok: the app opens with NO network, served by its own service worker
ok: with how old it is stated, rather than implied to be live
ok: the page threw no uncaught errors throughout
```

```
ok: the ERP's tombstone is recorded against the tenant, which is the only way to reach that status
ok: the app says syncing has STOPPED, rather than showing a spinner forever
ok: and says why, in the server's words (… has been deleted at the ERP …)
ok: and that nothing on the device has been thrown away
ok: the queue is blocked on the device, not drained and not dropped
ok: Sync now is disabled, so a rep cannot be told to keep trying something that cannot work
```

That last block is the whole deletion chain, end to end, for the first time: the ERP signs
a tombstone, 0050's watcher marks the registry row, the API refuses every request for that
tenant with `tenant_deleted`, and the client — the part that had never existed — stops
rather than spinning. `problems.ts` asked for precisely that behaviour when it gave the
kind its own problem type: *"an offline client holding a queue of unsent visits needs to
stop retrying and say so rather than spin on a refusal it reads as transient
permissions."* Something now holds such a queue, and it stops.

Worth noting what refused the first attempt at that fixture:
`tenant_erp_tombstone_id_shape`, because it wrote `tomb-live-1` where the constraint
requires `^tomb_[A-Za-z0-9_-]{12,40}$`. The receipt requirement is not decorative even in
a harness.

And from outside the app, as the admin so RLS cannot flatter the result: **4 visits, 4
distinct device-minted v7 ids, no duplicates**, every one attributed to the caller the
token named rather than anything the body claimed.

## Three defects it found, none of which a unit test would have

**1. "Sync now" did nothing, for up to half an hour.** One failed attempt backs a row off
15 seconds, doubling to thirty minutes. The rep regains signal, sees "online", presses
the button — and nothing happens, because `dueEntries` correctly answers that nothing is
due. A button that does nothing is worse than no button. The fix is `reviveDue`: both a
connectivity transition and an explicit request are new information that the backoff's
premise has gone, so the wait is void for *pending* rows and untouched for refused ones,
which are not waiting on a network. The run went from timing out here to `1 sent`.

**2. A queue entry whose key was not its own visit id was immortal.** The server echoes
the id it was sent (the body's); `applySyncResults` folds on the entry's key; if they
differ the two never meet, so the row is re-sent on every drain, never accepted, never
rejected, and reported nowhere. `enqueueVisit` cannot produce it — the entry id *is* the
record id — but an older build or a hand-edited store can, and a test fixture did while
testing something else. Now refused before anything is sent, visibly, by
`rejectUnreconcilable`.

**3. The image built the app's manifest but not its sources.** `COPY packages/` with no
`COPY apps/`: pnpm linked the workspace correctly from the manifest, `tsc --build` passed,
and the bundle step had nothing to bundle. Caught by `verify-image-build.sh` before Docker
ever ran it — the replay script added yesterday, catching its first defect in a Dockerfile
edit made today.

## Three existing gates caught the new packages on their first day

Worth recording, because this is what they were built for:

- **`verify-deploy-stack.sh` property 8** — "in the workspace, not copied into the image:
  apps/field, packages/client". The manifest-layer check, written the day the image turned
  out not to build, catching the same class of omission on a brand-new package.
- **`verify-deploy-stack.sh` property 10** — `@crm/client` was missing from the root
  `tsconfig.json`, so `tsc --build` never built it and the app bundled a **stale** `dist`.
  That is exactly how `@crm/erasure` had been uncompiled for a week.
- **`problems.test.ts`'s package audit** — "@crm/client is in the workspace but neither in
  AUDITED nor in EXCLUDED". It is excluded, with the reason: it is the *other end* of that
  file, consuming the problem kinds `toProblem` produces, and it declares no error class
  because a client that threw on a refusal could not queue it.

A fourth, `scripts/typecheck-tests.sh`, caught a `: void` arrow returning a value in a
test written an hour earlier. Which in turn exposed that the **app's** typecheck was in no
CI job at all: `pnpm typecheck` was `tsc --build`, which builds the root tsconfig's
references, and an app is not one. It now runs the app's own typecheck too — both
projects, including the service worker's, which needs `lib.webworker` alone because
declaring `self` under `lib.dom` degrades every ServiceWorker event to a bare `Event` and
typechecks green while `event.respondWith` does not exist.

## What this does not prove

- **A real identity provider.** The token is minted by the same harness stand-in §10 uses.
  The PKCE implementation is tested against RFC 7636's own vector, and no live issuer has
  ever answered it.
- **Most of the product.** Roughly 71 of the 106 routes have no screen.
- **Any browser but Chromium**, and iOS Safari is the one that matters most for a field
  app. No Capacitor wrapper, no device under memory pressure, no push.
- **A real ERP behind the outbox.** `ERP_BASE_URL` points nowhere in this run; §1–§7 cover
  that path.

## Samples, and a signature drawn on glass

*2026-10-08, same script. `pnpm client:verify` is 63 checks at this point, and 117 once
transfers landed (below).*

The disbursement is the act at the centre of a pharma field visit and the one with legal
weight, and it is the first thing in this repo that needed the outbox to be more than a
list. `DisbursementBody.signatureSha256` is required, so the **ledger commits to the
digest** of bytes the device captured; the image goes up separately, to a route that
answers 404 until that ledger row exists. One disbursement at a clinic desk with no signal
is therefore two queued rows in a fixed order.

What the browser run now drives:

```
ok: the rep's own stock reaches the screen from /v1/samples/holdings
ok: with the balance the ledger's trigger computed (10.000 on hand · expires 2027-10-08)
ok: a disbursement with no signature is refused at the keyboard, not queued
ok: a stroke drawn with pointer events leaves ink on the canvas (1473 dark pixels)
ok: the signature survives a re-render triggered by regaining signal (1473 dark pixels)
ok: with a signature it is saved on the device, and the screen says both halves are queued
ok: two rows are queued for one disbursement, not one
ok: the disbursement carries the digest of a signature that has not been uploaded yet
ok: with the PNG itself on the device (15420 base64 chars)
ok: and the database has neither
ok: the lot's balance falls on the device while offline (8.000 on hand)
ok: one disbursement in crm.sample_transaction
ok: with real bytes behind it (11564 bytes)
ok: and its stored bytes hash to exactly what the ledger committed to
```

And from outside the app:

```
ok: the stored signature hashes to exactly what the ledger committed to before it was uploaded
ok: and the holding fell from 10 to 8, by the ledger's own trigger
```

That second-to-last line is one SQL join —
`a.content_sha256 = t.signature_sha256` — and it is the whole commitment: the ledger row
was written before the image existed anywhere but a canvas, and the blob trigger recomputed
the digest from the stored bytes. If they ever differ the API answers `signature_mismatch`,
which is permanent, so equality is not a nicety.

**The rep's stock was granted through the real receipt route**, not inserted. Holdings are
maintained by 0018's triggers, so a fixture writing `sample_holding` directly would be
verifying its own arithmetic; `POST /v1/samples/receipts` is how a rep gets material, and
the harness checks the trigger agreed (`10.000`).

### The check that was added last, and failed

`the signature survives a re-render triggered by regaining signal` dispatches the
browser's own `online` event with a stroke on the canvas, waits for the drain the handler
starts, and counts dark pixels again. It was written because `render()` replaces the DOM
from thirty-one call sites and three of them fire with nobody touching the screen — and
the canvas is the one part of this app whose content is not in state. It reported `0 dark
pixels` on the implementation written to satisfy it: that one snapshotted a data URL and
redrew it through an `Image`, which decodes asynchronously, so the restored pad was *not
empty* while still blank and the second render of the reconnection (the handler renders,
then drains, and the drain renders again) snapshotted the blank over the strokes. Carrying
`ImageData` and restoring with `putImageData` is synchronous and pixel-exact, which is why
the count after the re-render is the same 1,473 rather than merely non-zero.

### Three harness mistakes, each of which named a real property

- **The first stroke drew nothing.** `Input.dispatchMouseEvent` takes VIEWPORT
  coordinates, and the signature pad sits below a header, an outbox summary and a form — so
  the events landed on whatever happened to be at those coordinates. It read as "CDP mouse
  events do not reach a pointer handler", which a four-line probe disproved in one run
  (1449 dark pixels on a bare canvas). The driver scrolls the element into view first, and
  refuses to draw if it is still not fully in the viewport. A rep scrolls to it too.
- **The samples step was written after the tenant-deletion step.** `erp_deleted` is
  terminal — 0050 made it a status and 0053 made it unreachable in reverse — so nothing
  after it can sync anything. The order of the script is now part of its meaning: every
  check that needs a working tenant runs before the one that deletes it.
- **The screen printed `8` where the server prints `8.000`.** The optimistic local
  decrement used `String(10 - 2)`, putting two spellings of one `numeric(16,3)` on the same
  screen. `toFixed(3)` matches the column's own form, which is also the form the server
  sends.

## Transfers, and the two things a shared phone breaks

*2026-10-08, same script, now driving TWO browsers. `pnpm client:verify` is 117 checks.*

A transfer is the first act in this product that needs two people, and one device signed in
as one rep cannot prove it: the sending half and the receiving half are different routes
scoped to different reps, and in between the material is in neither rep's hands — it is in
`quantity_in_transit`, which is what the whole chapter is really about. So the run launches
a second Chromium with its own profile: its own IndexedDB and its own `localStorage`, which
is a second DEVICE. A second tab would have shared both and proved nothing.

What the run drives, in order, with the ledger checked at every step:

```
ok: the picker offers one colleague (["Grace Hopper · E-2"])
ok: and never the departed rep
ok: and never the sender
ok: a transfer of more than the rep is carrying is refused at the keyboard, and queues nothing
ok: and the form survives the refusal, so the rep can correct the quantity rather than start again
ok: the quantity leaves the balance as soon as it is queued (6.000 on hand · 2.000 in transit)
ok: cancelling an unsent transfer puts it straight back on the balance
ok: nothing reached the ledger, because nothing ever left
ok: one transfer_out in crm.sample_transaction
ok: the sender's balance moved from on-hand into IN TRANSIT, by the ledger's trigger
ok: and the receiver holds nothing yet, because nobody has accepted it
ok: the receiver is shown what it is and who sent it, not a pair of ids
ok: and NOT waiting for it, because it is already on the server
ok: one transfer_in in crm.sample_transaction
ok: and the sender's in-transit is clear — the total across both reps never changed
ok: a new sign-in with no network does not inherit the previous rep's identity from the cache
ok: and once it can ask, it says plainly that it is holding somebody else's record
ok: and pressing Sync as the other rep sends nothing of hers
ok: one transfer_recall in crm.sample_transaction
ok: and the material is back on the sender's balance, out of transit
```

And the arithmetic from outside the app, which is the assertion that matters most:

```
ok: the sender's balance is 10 received, 2 disbursed, 3 transferred away — 5 on hand, none in transit
ok: and the receiver holds exactly what she accepted, on her own balance
ok: and the two balances still sum to the 8 that were left after the disbursement
ok: every transfer the run made has its one terminal event — an acceptance or a recall
```

### The two defects a shared device exposed

Neither was visible to any unit test, and the second was found by the first one's test
timing out.

- **The queue belongs to a device; the record belongs to a person.** Every write route
  attributes a record to the caller in the token, so a second rep signing in on a shared
  phone would have drained the first rep's unsent rows under their own name — a false
  custody record for a drug-sample hand-over, naming a real person, undetectable
  downstream. Rows carry `createdBy` now, only the signed-in rep's rows are sent, and the
  rest are held: not sent, not deleted, and said out loud on screen.
- **The cache belongs to a person too.** After a sign-in with no network `/v1/me` never
  answers, and the app carried on with the PREVIOUS rep's identity — their name in the
  header, their stock on screen, and the id that would have been stamped on anything the
  new rep recorded. A session now records which rep it turned out to be, the cache is
  adopted only when the two agree, and a session that has never reached the server adopts
  nothing and says so.

### Three things the gate taught us about itself

- A fixture that injects a raw IndexedDB row had to start carrying `createdBy`, or the row
  it was testing was simply never sent — the new rule held it, exactly as designed.
- "The queue is empty" is never true: §8's refused out-of-territory visit is deliberately
  kept for a person to look at.
- A transfer can be queued AND on the server at the same time, because a reply lost after
  the row was written leaves it pending for a retry. An assertion about what the screen
  offers has to wait for the steady state instead of catching it mid-drain — one run caught
  the first version doing exactly that.

## Counting the bag, where the bag is

*2026-10-09, same script. `pnpm client:verify` is 148 checks.*

A count is the one custody document whose whole purpose is to happen away from a desk, and
it is the first thing in this app that is a DOCUMENT rather than a movement: four routes,
three of them addressed to an id the device had to mint before there was anywhere to send
it. 0056 is what made that possible — a device-minted count id, an idempotent commit, and a
`count_id` on the adjustments so a repeated commit can answer with the same number.

The run arranges the case the second expected-quantity column exists for: **something moves
while the count is in the bag.**

```
ok: every count field starts EMPTY, so nothing is confirmed by tapping through
ok: with the balance shown beside it instead (device shows 5.000 · expires 2027-10-09)
ok: a count with an impossible quantity is refused at the keyboard, and queues nothing
ok: and a count with nothing filled in writes off nothing — a blank field is not a zero
ok: one count queues THREE rows: the document, a line, and the commit
ok: the line is keyed by (count, lot), the way the server keys its row
ok: and carries what the DEVICE showed, not only what was counted
ok: and the COMMIT waits for the document AND every line
ok: the screen shows what was counted, because that is what the ledger will say
ok: and a second count cannot be started while this one is unsent
ok: a receipt lands from somewhere else while the count sits unsent on the device
ok: one row in crm.sample_count
ok: under the id the DEVICE minted, which is what let the line be addressed at all
ok: committed, because the commit went last and after every line
ok: holding what the rep counted                        (4.000)
ok: the balance the SERVER held when the line arrived    (7.000)
ok: and the balance the DEVICE had shown them           (5.000)
ok: so the reviewer sees the variance against what was held   (-3.000)
ok: AND the variance the counter could actually see           (-1.000)
ok: one adjustment in the ledger, not an edit to a balance
ok: linked to the count that found it, structurally rather than in prose
ok: and the balance is exactly what the rep counted
```

The `2` between the two variances is the receipt. One column could not have said that, and
letting the device overwrite the server's figure would have hidden it — send expected equal
to counted and the ledger still writes the real adjustment while the reviewer sees a clean
count.

From outside the app, two assertions that matter more than the rest:

```
ok: the count committed with all three figures kept: counted 4, server held 7, device had shown 5
ok: and every balance still equals the sum of its movements — the count adjusted, it did not edit
```

### What the guards caught, within the hour

- **`count_id` was written single-column** and the composite-key contract refused it: a
  reference into a tenant-scoped table is stopped from naming another tenant's row by RLS
  alone, and referential checks bypass RLS. The registry then demanded a live probe proving
  the key refuses an adjustment citing another tenant's count, which it now has.
- **Two fixtures deleted `sample_count` before `sample_transaction`** and the new key
  stopped them — the ordering hazard made visible. The production erasure was never at
  risk: it derives its order from the live FK graph and refuses a retained child of an
  erased parent, naming the edge.
- **The strict test typecheck caught `entry.body.id`** on a union where a count line's body
  has no id at all, which is the same fact that made `rejectUnreconcilable` need to learn
  the difference between a body that carries an id and one that cannot.

## Expired stock, and the date a disposal was recorded on

*2026-10-09, same script. `pnpm client:verify` is 178 checks.*

Expired stock in a rep's bag is the most common sample-audit finding there is, and the
write-off is the only thing that ends it. Two things make this chapter worth reading.

**There is no honest way to hold expired stock through the API**, so the gate does what
reality does. 0020 refuses a receipt of expired material outright — a warehouse that ships
it takes it back — so the run receives the lot TWENTY DAYS AGO, fifteen days before it
expired, through the same route with the same refusals in force, and then proves the rule it
is relying on:

```
ok: stock received while it was still in date goes stale in the bag
ok: while receiving it TODAY is refused — that is what makes the back-dated one honest
ok: the sweep raises one disposal obligation ({"expiredHoldings":1,"opened":1,...)
```

The obligation is raised by the **real** `sweepExpiredStock`, the function the scheduler
calls nightly. One the gate wrote itself would prove nothing about the one a rep sees.

**Then the sweep runs three days late**, which is the case migration 0057 exists for:

```
ok: the rep is shown what they must dispose of (LOT-STALE-1 · itm-live-2)
ok: with how much of it they are carrying
ok: and the deadline, in days rather than a date to work out
ok: the form opened from a disposal obligation defaults to EXPIRED, not destroyed
ok: and the quantity starts empty: this is the screen that records material no longer existing
ok: a write-off with no reason is refused at the keyboard, and queues nothing
ok: a refusal does not wipe what the rep already typed
ok: the obligation says it has been dealt with rather than showing a deadline
ok: one write-off in crm.sample_transaction
ok: and the stock is out of custody
ok: the obligation is still open until the sweep confirms it from the ledger
ok: the late sweep closes the obligation ({"resolved":1,...)
ok: attributed from the LEDGER — written off, not guessed
ok: and dated the day the material actually left, not the day the sweep noticed
ok: which is inside the deadline it was given
```

### The two defects this chapter found

- **A disposal was recorded on the day the sweep noticed.** `resolved_on` was the cron job's
  clock while the resolving movement — right there, already read for attribution — carried
  the date it happened. Seven-day grace, destroyed on day three, swept on day nine: recorded
  as two days overdue when it was four days early, with the ledger saying one thing and the
  obligation another. 0057 takes the movement's own date, bounded by the sweep's so a fast
  device clock cannot date a disposal next week.
- **A refusal wiped what the rep had typed.** Every refusal renders, and a render replaces
  the DOM: "you are carrying 6, so 99 cannot be written off" arrived with the reason field
  blank, and the reason is the only record of why regulated material no longer exists. On a
  count form it is a number per lot plus the note, all of it gone to one mistyped digit.
  Both earlier gates had hidden it by re-filling every field after every refusal. The form's
  values now survive a render, and the run asserts it in both places.

## Back to the warehouse, and the first write the ERP must hear about

*2026-10-09, same script. `pnpm client:verify` is 201 checks.*

Every other movement this client records is CRM-only: the material had already left the
warehouse, so the ERP's balance was already right. A return puts it back, which is why the
route mirrors it as a `StockMovement` — and why "accepted" stops meaning "finished".

```
ok: the return offers a depot to pick
ok: the open depots the ERP told us about, and no third option
ok: and the depot this lot came from is pre-selected, so the common case is unchanged
ok: a return of more than the rep holds is refused at the keyboard
ok: the queued return carries the quantity
ok: and the depot, which the form had pre-selected from the lot's own origin
ok: one return_to_warehouse in crm.sample_transaction
ok: addressed to the depot it came from
ok: and the stock has left the rep's balance
ok: one ERP write was enqueued for it — a StockMovement the warehouse needs
ok: waiting for the relay, which this harness does not run
ok: and the quantity as a NUMBER, not the text Postgres hands over
```

Then the gate plays the relay's verdict — marking that row dead, labelled as the fixture it
is, since this harness runs no relay — and the screen has to account for it:

```
ok: the rep is told WHAT the ERP never heard about            (StockMovement create)
ok: in the ERP's own words rather than as an error code       (…warehouse wh-live-1 is closed for receipts)
ok: with something they can do about it
ok: pressing it puts the write back in the queue, with the same payload
ok: and counts that somebody has already asked once           (revive_count 1)
```

And from outside the app:

```
ok: both returns left a StockMovement for the ERP — the first queued again after its death and counted as retried once
ok: the rep who got her stock by transfer still has no depot in her own history, and sent it back to one she picked from the list
```

### Two findings, one of them in the app's own error message

- **"The server's reply did not match the contract this app was built against"** was what a
  rep saw when the network dropped between two of the three reference reads. That sentence
  sends somebody hunting a version mismatch which does not exist. A request that failed is
  not a contract mismatch, and the two are now separate messages. Found because the wrong
  one kept overwriting a gate assertion at random.
- **The ERP's vocabulary is the inverse of the CRM's.** A return mirrors as
  `movement_type: receipt` — stock arriving at a warehouse — while a CRM *receipt* mirrors
  as `issue`. An assertion written against every `StockMovement` found four rows and the
  wrong quantity, which is the sort of thing a scoped assertion catches and a loose one
  silently averages over.

### Two gate races, both passing by luck until now

A loop that waited for IndexedDB to be empty and then read the DOM was racing the repaint
that reflects it; and a `waitFor` on a button that already existed for another lot was true
before the refresh it was meant to wait for. Neither was a product defect, and both made one
look intermittent — which is worse than a hard failure.

## A warehouse is a place

*2026-10-09, same script, plus `./scripts/verify-live-erp.sh`. `pnpm client:verify` is 221
checks; the live-ERP gate is 129.*

The chapter above left two things open and they were the same thing. Material a colleague
handed over has no receipt of its own, so `last_received_from` is null and the device had no
destination it could name — the only exit was a write-off of stock a depot could have put
back on a shelf. And `POST /v1/samples/receipts` accepted any `erp_warehouse_id` of the right
SHAPE, because the CRM modelled no warehouses, so an invented id was written here and refused
by the ERP days later from inside the relay queue. `crm.warehouse_snapshot` (0058) answers
both.

**This one is proven against a real `operate-server`, not a fixture.** The ERP is seeded with
three warehouses through its own HTTP API, and the CRM pulls them in with the shipped
`SnapshotRefresher` — the same class the scheduler's `snapshot_full` job calls:

```
ok: synced 3 warehouse(s) from the live ERP: DEPOT-1=active DEPOT-2=active DEPOT-X=closed
```

Then, at the live server, through the API binary:

```
ok: a receipt from a depot the ERP does not have is refused at the point of entry, not by a
    dead letter                        (422 no ERP warehouse wh-invented in this tenant's list)
ok: and one the ERP says is closed is a conflict — a well-formed request the depot's own
    state refuses                      (409 warehouse DEPOT-X is closed, not active)
ok: and neither refusal left a movement or a mirror behind — the check runs before the insert
```

And through the scheduler binary, which is what keeps the list current in production:

```
ok: and crm.warehouse_snapshot too — the scheduler is what keeps a return's destinations
    current                            (DEPOT-1=active DEPOT-2=active DEPOT-X=closed)
```

**The case that was impossible, in a third browser profile.** A rep who received every unit
she holds by transfer, with no receipt of her own, returns it:

```
ok: the receiving rep has no receipt of her own — every unit she holds arrived by transfer
ok: the same two open depots are offered to her
ok: with NOTHING pre-selected, because no depot has a claim to be the default
ok: and the screen says why she has to pick
ok: a return with no depot chosen is refused at the keyboard
ok: and the quantity she typed is still in the box
ok: the queued return carries the depot SHE picked, not the one the lot's history names
ok: two returns in the ledger for this run
ok: and the second is addressed to a depot that never sent this material anywhere —
    which was impossible before the list existed
ok: and she still has no receipt of her own — the depot list is what made the return
    possible, not a backdated history
ok: and every depot named by a movement in this run is one the ERP's own list has
```

### What the existing guards caught

- **`refreshAll` was enumerating the snapshot names a second time** — `["product", "rep",
  "account"]`, hard-coded beside the projection registry. A fourth snapshot could be
  declared, projected, migrated and tested and still never be refreshed, because the only
  job that drives all of them had its own list. Now derived from `PROJECTIONS`, with a test
  pinning the order. The one real defect in existing code this increment found, and writing
  the fourth snapshot is what found it.
- **0051's retention register went red within the minute.** Five of its assertions fail when
  a tenant-scoped table has no disposition, because silence is not `none` — so the new table
  arrived with its decision (`erase`, for the reason the other three snapshots carry: a copy
  of ERP master data we were only ever a cache for).
- **Not a foreign key, and the sweep is why.** A composite FK from the ledger into the
  snapshot was the first thing to reach for; it would break `deleteStale` the moment a depot
  closed and vanished upstream — `RESTRICT` pins the row and the refresh fails, `CASCADE`
  deletes custody history, `SET NULL` violates `sample_tx_warehouse_fields`. The rule is a
  check at the moment of the write, so a movement keeps its destination for ever.

### What is still not built

The depot list is only as fresh as the snapshot — one opened five minutes ago is not yet
addressable, one closed five minutes ago is still offered, and `crm.snapshot_freshness`
carries the age with no screen showing it. A receipt still has no screen at all, so nobody
picks a depot for one. A count covers only the lots the device has cached. The depot picker
and the peer picker are both a plain select of the first 500 rows; both routes take a `?q=`
filter and no screen uses it yet. Roughly 71 of the 106 routes have no screen.

## A policy change is a record

*2026-10-09, same script. `pnpm client:verify` is 248 checks.*

0023's header named the debt it was clearing in two clauses: `crm.disposal_policy` was
"settable only by someone with a psql prompt — which in practice means settable by anyone
with the application password, **with no record of who changed what**". It built the role
model and answered the first. The write was still `UPDATE crm.disposal_policy SET grace_days
= 7`, which moves a timestamp and records nothing — so a deadline loosened last Tuesday by
somebody who has since lost the role read exactly like one that had stood for a year.

0059 makes the policy row a projection of an append-only log, which is 0018's own arrangement
between a holding and the custody ledger. The three properties that matter are all the
database refusing something, and all three were measured against a real Postgres before any
screen existed:

```
ok: refuses a direct UPDATE of the policy, which is what makes the log the record
ok: refuses an upsert that smuggles the change into its DO UPDATE clause
ok: is append-only: a change cannot be edited or deleted afterwards
ok: stamps the previous value itself, so the log cannot be made to lie
ok: creates the policy at the defaults and refuses a policy created at a value nobody set
ok: still allows the policy row to be deleted, because a tenant erasure must
```

**In the browser**, the first administrative screen this app has had — and the first consumer
of `GET /v1/me/roles`, which has carried "so a client can decide which admin screens to show"
in its own comment since 0023 with nobody reading it:

```
ok: the rep is shown the deadline they are held to        (30 day(s) to dispose of expired stock)
ok: and told nobody has changed it — printed as itself, not as a blank where a name would go
ok: and the compliance officer is offered the change — the roles route decides, not a guess
ok: the form opens on what is in force rather than on empty boxes
ok: a change with no reason is refused at the keyboard
ok: and the typed grace period is still in the box
ok: with nothing recorded, so a refused change leaves no trace to explain away
ok: carrying what the grace period WAS — stamped by the database, not claimed by the client
ok: attributed to the officer in the token, never to a name in the body
ok: the UPDATE this write used to be is refused by the database
ok: with the history reading as a change rather than as a value   (30 → 7 day(s))
```

And the rep who may not:

```
ok: a rep with no grant sees the same rule
ok: and who set it, because it is the rule she is measured against
ok: but is offered no way to change it
ok: and the server refuses her even when the screen is bypassed — the grant is the rule,
    not the button                                                (403, naming `compliance`)
```

### What the guards and the gate caught

- **A `FOR EACH ROW` trigger cannot refuse an UPDATE that matches nothing.** The first draft
  of the direct-UPDATE test ran against a tenant whose policy row had been deleted by the
  fixture, so the statement matched zero rows, no row trigger fired, and the test passed
  while proving the opposite of its own name.
- **A defect I introduced while fixing a smaller one.** The form is opened on the LIVE
  values, because an officer deciding from a screen that says thirty days while a colleague
  moved it to seven an hour ago is reasoning about a rule that is not in force. The first
  version opened the form and refreshed behind it — and a refresh re-renders, so anybody who
  started typing in the beat before it landed had their input discarded: the exact defect
  `formDraft` was built to prevent, reintroduced by the thing meant to make the form
  accurate. The read now happens strictly before the form exists.
- **A fourth wait on something already true**, and the gate has now caught this shape three
  times. The policy section renders either way — "this device has not been told the tenant's
  disposal policy yet" until the read answers — so waiting on the heading was true before
  the fetch that fills it. It passed on the officer's screen by luck and failed on the other
  rep's, which is the honest outcome.
- **0051's register demanded a decision for the new table** before anything else would pass,
  and the honest answer is `undecided` with the question written out: the record that a named
  employee changed a regulated deadline follows whatever is decided for `disposal_obligation`
  and has to be decided *with* it, because retaining either alone leaves a record nobody can
  read. Twenty undecided dispositions now, not nineteen.
- **The composite-key guard refused the new reference** until it was `(tenant_id, changed_by)`
  and had a live cross-tenant probe, as it has for every reference since 0035.

### What is still not built

The promo auto-write-off switch is the one setting here that lets a job take material off a
balance, and nothing guards it beyond the role and the log — four eyes is the obvious
candidate and is not built. The device shows the last five changes with no way to page
further. Roughly 70 of the 106 routes have no screen.

## Who opened this route out of the tenant

*2026-10-10, `./scripts/verify-live-erp.sh`. The live-ERP gate is 133 checks.*

0023's header named two tables, and the chapter above closed the first. This is the second,
and the more consequential: a disposal policy is a number reps are measured against, while an
endpoint is where a notification GOES — and 0021 is explicit that one "carries a rep's name,
an account id and sometimes a lot number". Adding a row to `crm.notification_endpoint` opens
a route out of the tenant for exactly that, and the row recorded when it was created and
nothing about by whom.

Driven through the API BINARY at a running `operate-server`, because the claim being measured
is that the author comes from the TOKEN and not from the body — which is only true of the
route:

```
ok: an endpoint created with no reason is refused — a route out of the tenant that nobody
    signed for                                                                       (422)
ok: and one that does names the rep in the token, never a name in the body
    (201 created_by=1b9661f7 reason=ops asked for overdue disposals in their…)
ok: turning the signals off is a record with both halves, not an UPDATE that moves a
    timestamp                                            (200 true->false by Ada Lovelace)
ok: and an endpoint typed at a psql prompt with no author is refused by the database itself
```

That last line is the one 0023's header is actually about. This harness's psql runs as the
SUPERUSER — it bypasses row-level security and owns everything — and the refusal still lands,
because a trigger is not a permission.

### The shape, and why it is not one mechanism

Two kinds of fact, so two mechanisms. What an endpoint IS — channel, url, secret_env — has
been frozen for the life of the row since 0049, because a delivery record names the
destination it went to; a frozen fact is row data rather than an event, so the creation's
author and reason join it as columns and 0049's existing freeze covers them. How an endpoint
is TUNED changes over time, so `min_severity`, `kinds`, `enabled` and `description` are a
projection of an append-only log, the same arrangement 0018 uses for a holding over the
custody ledger.

```
ok: records who opened the route and why, and hands both back
ok: refuses an endpoint that names nobody, from raw SQL
ok: refuses to let the creation record be rewritten, in its own words
ok: records an amendment with both halves of every knob
ok: tells a cleared allow-list apart from one nobody mentioned
ok: refuses a direct amendment, which is what makes the log the record
ok: refuses an amendment that changes nothing rather than recording it
ok: is append-only: an amendment cannot be edited or deleted afterwards
```

### What this cost, and what it caught

- **Extending a frozen list exposed a flaw in reusing its message.** 0049's refusal explains
  a destination — "has delivery records naming url = …, so it cannot become …" — and
  measured against a `created_by` rewrite it sends an operator hunting through delivery
  records for a problem that is not there. One list, one trigger, two sentences now.
- **Eight suites inserted endpoint rows directly and seven wiped them.** All of them now
  attribute the row and retire the log first, through two shared helpers rather than eight
  copies — because seven copies of a trigger-disable is how one ends up missing the
  re-enable. Two tests got stronger on the way: the kinds-vocabulary check now arrives by
  the amendment path, which is the only way an allow-list changes at all.
- **A latent defect the churn exposed, unrelated to any of this.** The expense-store suite
  and the notification-retention suite seeded their reps with the same three uuids in
  DIFFERENT tenants. `crm.rep_profile.id` is a global primary key, so whichever ran first
  created them in its tenant and the other got `ON CONFLICT DO NOTHING`, no row, and a
  foreign-key failure on a rep it believed it had seeded. Which suite won depended on file
  order: flaky by construction, and passing on luck for as long as both files existed.

### What is still not built

There is no screen, and the line is principled: the disposal policy is on the device because
every rep is measured against it, while an endpoint list is the third parties a tenant talks
to and belongs in an admin console that does not exist. `crm.notification_policy`,
`crm.notification_prune_guard` and `crm.expense_account_map` are the same shape of
configuration with the same gap — and three bespoke logs is the point at which this should
become one mechanism rather than a fourth copy.

## A configuration change is a record

*2026-10-10, `pnpm client:verify` (272 checks) and `npx vitest run` (97 files / 2,473
tests). The live-ERP gate is unchanged at 133 — nothing here touches the ERP.*

The chapter above ended by naming the condition for building this: "three bespoke logs is the
point at which this should become one mechanism rather than a fourth copy." The third instance
turned out to be two tables — `crm.notification_policy` and `crm.expense_account_map` — so
0061 is the mechanism. One append-only `crm.config_change`, attached with one statement, and
the thing worth verifying live is not the table but the **trigger**: the refusal is a `RAISE`
from a function reading a transaction-local setting, the exemption is a lookup in `pg_attrdef`
with the default cast to the column's own type, and `changed_columns` is computed by comparing
two `jsonb` images of a row. Not one of those can be observed against a fake connection.

It also works the opposite way round from the two logs before it. 0059 and 0060 use
**projection** — the log is the only write path, a direct `UPDATE` is refused outright. This
uses **observation** — the row is written normally and an `AFTER` trigger records what moved,
refusing the write when nobody has said who is making it. Same guarantee, one trigger per
table instead of one apparatus per table, and no store function's signature changes.

### In the browser, through the API, because there is no form

The notification horizons are among the ~70 routes with no screen, so the gate drives the
mechanism rather than a form. The sequence matters and is the whole of what is asserted:

```
ok: reading the probe limits provisions the tenant's policy row              (200)
ok: the row is there                                                           (1)
ok: and nothing was recorded, because a row holding only what a migration declared
    is not a decision anybody made                                             (0)
ok: an UPDATE nobody has signed is refused by the database
    (ERROR: config-change-unattributed: a change to crm.notification_policy must…)
ok: with nothing recorded, so a refused change leaves no trace to explain away (0)
ok: the administrator's signed change is accepted                            (200)
ok: two records for one request — the honest unit is the action, not the statement
ok: both under the one sentence the request carried
ok: attributed to the administrator in the TOKEN — the body never named her
ok: carrying what the cooldown WAS, read from the row rather than claimed
    ({"probe_cooldown_seconds": 120, …})
ok: a request that changes nothing is accepted                               (200)
ok: and recorded nowhere, so the log a reader relies on to be short stays short (2)
ok: both records are on screen                                                 (2)
ok: rendered as the change it was, column name and all
    (probe_cooldown_seconds: 120 → 600 · probe_budget_max_probes: 120 → 40 …)
ok: a rep with no administrator grant gets no configuration-history section at all
ok: and the server refuses her even when the screen is bypassed               (403)
```

Three of those are the ones that cannot be faked. The unsigned `UPDATE` goes through psql as
the **superuser** — bypassing row-level security, owning everything — and the refusal still
lands, because a trigger is not a permission. The `120` in the `before` is the column default
the row was provisioned at and no part of the request mentioned it, so the log's previous
value is the database's rather than the writer's claim. And **one request lands two records**,
because `PUT /v1/admin/notifications/probe-limits` calls two store functions over one row —
which is why attribution is scoped to a block rather than consumed by the first write.

### One assertion sequenced rather than assumed, the same defect two migrations apart

The unsigned-`UPDATE` check passed on its first run having updated nothing. A `FOR EACH ROW`
trigger cannot refuse an `UPDATE` that matches zero rows, and `crm.notification_policy` is
provisioned lazily, so the tenant had no policy row yet. The gate now reads the probe limits
first — which both provisions the row and asserts the exemption background code depends on —
and only then tries the write.

This is exactly the defect the disposal-policy chapter recorded about its own suite. It was
written down, and it happened again anyway, in a different harness. The honest lesson is that
a refusal test needs a row to refuse, and the only way to know there is one is to put it there
in the same breath and count it.

### What the database taught, against a test written expecting the other answer

A `now()` default **is** exempt from attribution; a `gen_random_uuid()` one is not. The rule
compares the stored value against the declared default evaluated now, and `now()` is the
transaction clock — so inside the inserting transaction it re-derives to exactly the value the
column holds, which is precisely what the exemption asks. The scratch-table test was written
expecting a refusal and the database was right. `gen_random_uuid()` never re-derives, so it
reads as chosen and demands an author; a `clock_timestamp()` default would behave the same
way. The failure mode is always a refusal asking who, never a silent exemption.

```
ok: finds nothing chosen in a row holding every declared default
ok: finds the column that differs from its declared default
ok: counts a column with no default as chosen only while it holds a value
ok: whose default cannot be re-derived is never exempt — the rule fails closed
ok: with a transaction-clock default is exempt, because the default re-derives
ok: refuses to attach to a table with no primary key
ok: is idempotent, so a table re-attached is still recorded once per write
```

Those run against **scratch tables**, and that is a deliberate choice rather than convenience:
the two production tables cannot pose any of those questions. Neither has a column with a
volatile default, neither lacks a primary key, and `crm.notification_policy` keys on
`tenant_id` alone — so a suite using only them would be asserting each generic rule against
the one case it happens to meet today. The scratch tables carry `crm.data_disposition` rows
and force row-level security while they exist, because two suites derive their claim from the
live catalog and relying on `fileParallelism: false` is the "it happens to be set" reasoning
this repository has been bitten by before.

### One CI failure that was not this change, and the control that said so

The first run of this commit failed the browser job, and the failure was the FIRST browser
of the run never printing a DevTools URL inside the launcher's thirty-second window —
before any of this increment's code ran. The log carried three
`Failed to connect to the bus: Could not parse server address` lines five seconds apart,
which read exactly like the cause, and the obvious fix was the set of Chrome flags that
stop it reaching for a session bus.

Those flags are not in the fix, because a control run says they are not the cause: Chrome
prints the same three lines on a perfectly healthy start, launching in **140 ms**, with the
same malformed `DBUS_SESSION_BUS_ADDRESS` set deliberately. The whole fix is the timeout —
thirty seconds is simply too tight for a cold Chrome on a runner sharing a disk with a
Postgres container, and a launch window a healthy start can lose to is a gate that fails
for a reason nobody can act on.

This is the same mistake as a flake declared without a root cause, one step earlier: noise
that appears next to a failure is not evidence about the failure. It cost one control run to
tell them apart, and the comment in `scripts/client/cdp.mjs` says so, so the flags are not
added by the next person who reads that log.

### What this cost, and what it caught

- **The guard found two writers no reading of the routes had turned up.**
  `setProbeCooldownSeconds` and `setProbeBudget` also write `crm.notification_policy`. They
  surfaced as a refusal the moment the trigger was attached — the mechanism paying for itself
  before it shipped, because a bespoke fourth log would have covered the writers somebody
  remembered.
- **The no-op refusal was wrong, and a fixture said so.** The first design refused a write
  that moved nothing, copying 0059 and 0060. The expense sweeper's fixture re-upserts
  identical mappings and broke immediately — and it was right to: `PUT
  /v1/admin/expense-accounts/:category` is an upsert, and refusing "make sure this maps to
  6200" because it already does makes an idempotent route non-idempotent. A no-op is now not
  recorded and not refused; the universal half is kept, the opinionated half belongs to the
  route.
- **Eleven suites write configuration, and each now signs.** Where the subject is something
  else, the suite's own tenant helper is wrapped once rather than thirty call sites being
  edited — the signature there is a precondition for writing configuration, not the thing
  under test. Where the subject IS the table, the suite signs with its own named rep and
  asserts on the log. `wipeConfigChanges` joins `wipeEndpoints` as a shared teardown helper,
  because the log names its author `ON DELETE RESTRICT` and five suites delete their reps.
- **The composite-key registry demanded a live cross-tenant probe**, as it has for every key
  since 0035, and the probe is the one case no production path can reach: the log is written
  by a trigger that reads its author from a setting, so nothing ever inserts into it directly.
  The constraint still has to be composite — a referential check runs with row security off,
  so a single-column key would let one tenant's record name a rep in another.
- **0051's register refused the table until it carried a decision**, taking the undecided
  count to 22 of 45 tenant-scoped tables.

### What is still not built

- **Two arrangements now live in the schema.** 0059 and 0060 keep their typed logs on purpose
  — a history a screen renders wants columns, and both of their shapes are already served over
  HTTP — but the rule for choosing between them lives in 0061's header rather than anywhere a
  reader looks first.
- **`crm.config_change`'s own retention disposition is `undecided`**, and the question is real
  rather than paperwork: the log records which ledger account a category posted to, and
  `crm.expense_claim` is retained for seven years under `financial_transactions_7y` with its
  account snapshot. A retained claim whose mapping history was erased is a posting nobody can
  explain.
- **The screen shows five and cannot page**, and takes neither the `table` nor a column
  filter although the route takes the first. For a tenant that changes its settings twice a
  year that is the right size; for one that tunes a prune guard weekly it is not.
- **Nothing is four-eyed.** Item 32's open note still stands for the promo auto-write-off
  switch, and it stands here too: an administrator can re-point an expense category to any
  ledger account alone, and the only thing stopping a quiet redirection of a tenant's spend is
  that the log will say who did it.
