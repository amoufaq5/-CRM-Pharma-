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
against a throwaway database and drives the **shipped `dist`** of `@crm/acl`,
`@crm/credential`, `@crm/db` and `@crm/relay` at it — 59 assertions, every one
of them over code that deploys. The script's header says what it does not prove;
read that before quoting a pass from it.

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

A retry of the same outbox row sends the same `Idempotency-Key` (`crm-<row id>`),
and within one ERP process lifetime that hits the gateway's in-memory idempotency
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
- **The CRM's own `api` and `scheduler` binaries were not driven at the live
  ERP.** The relay was driven directly. The scheduler's per-tenant loop, its
  credential boot and its refusal to start on `ERP_TOKEN` under
  `NODE_ENV=production` are all still verified only against the fixture.
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
