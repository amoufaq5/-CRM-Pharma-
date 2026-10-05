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
| `packages/scheduler/` | The background process. Drives the relay, the refresher and the expiry sweep per tenant, on a timer. |
| `packages/territory/` | Territories, rep assignment, supervision, and the row-level scoping the ERP cannot do. |
| `packages/visit/` | Visits and detailing lines. Offline-first, territory-scoped, immutable once final. |
| `packages/api/` | The HTTP API. JWT auth, one error shape, territory-scoped on every read. |
| `packages/notify/` | Notifications: the in-app inbox, HMAC-signed webhooks, the dispatcher. |
| `packages/credential/` | The ERP service credential: Ed25519 signing, the JWKS, the key lifecycle, per-tenant roles. |
| `packages/callplan/` | Cycles, call plans and adherence. Four-eyed approval, frozen once approved. |
| `packages/sample/` | Sample and promo-material custody: lots, expiry, balances, transfers, counts, the ERP mirror. |
| `packages/role/` | The administrative roles: dated grants, four eyes, and the guard against locking a tenant out. |
| `packages/expense/` | Expense claims: the lifecycle, the category-to-account map, and the ERP posting. Refuses until Finance maps the category. |
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
| `GET /v1/cycles` | planning periods; `?on=` for the one covering a date |
| `GET /v1/call-plans` | **their** plans; `/:id` adds targets and products |
| `GET /v1/call-plans/:id/adherence` | planned vs actual, per target and in summary |
| `GET /v1/samples/holdings` | what they are carrying, by lot |
| `GET /v1/samples/expiring` | what is about to go out of date in their bag |
| `POST /v1/samples/receipts` | confirm stock from a warehouse — the one route that mirrors to the ERP |
| `POST /v1/samples/disbursements` | a hand-over, with recipient and signature hash |
| `GET\|POST /v1/samples/transfers` | outstanding transfers / send to another rep |
| `POST /v1/samples/transfers/:id/accept` | the receiving rep accepts |
| `GET /v1/samples/transfers/recallable` | material the caller sent that nobody has accepted |
| `POST /v1/samples/transfers/:id/recall` | take it back — **sender only**; a new ledger row, never an edit |
| `GET /v1/samples/ledger` | the append-only custody log |
| `POST /v1/sync/disbursements` | offline flush, **per-row** results |
| `POST /v1/call-plans` | create, for self or a supervised rep; then `/targets`, `/products` |
| `POST /v1/call-plans/:id/{submit,approve,return,withdraw,supersede}` | the lifecycle |
| `POST /v1/samples/counts` | open a count — self or supervised; then `/lines`, `/commit` |
| `GET /v1/team` | the roster, through the territory hierarchy |
| `GET /v1/team/call-plans` | the team's plans; `?status=submitted` is the approval queue |
| `GET /v1/team/adherence` | the territory review: one row per rep, **including reps with no plan** |
| `GET /v1/team/samples/exposure` | what each rep holds, ordered by whose count is most overdue |
| `GET /v1/team/samples/expiring` | expiring stock across the team |
| `GET /v1/team/samples/ledger` | one rep's custody log, for an audit |
| `GET /v1/team/visits` | one rep's activity |
| `GET /v1/samples/obligations` | what the caller must dispose of, with the deadline |
| `POST /v1/samples/write-offs` | a destruction or an expiry write-off, with a reason |
| `POST /v1/samples/returns` | back to a warehouse; mirrored to the ERP as a `receipt` |
| `GET /v1/samples/disposal-policy` | the tenant's grace period, read-only |
| `GET /v1/team/samples/obligations` | the team's outstanding disposals — the chase list |
| `GET /v1/notifications` | the inbox; `?unread=true` filters |
| `GET /v1/notifications/unread-count` | a real count of a real column |
| `POST /v1/notifications/:id/read` | idempotent; keeps the first read timestamp |
| `POST /v1/notifications/read-all` | |
| `GET /v1/erp-writes/failed` | writes the ERP refused permanently — theirs |
| `GET /v1/team/erp-writes/failed` | the team's, for a manager |
| `POST /v1/erp-writes/:id/retry` | queue the same payload again, once the cause is fixed |
| `GET /v1/me/roles` | which administrative roles the caller holds, if any |
| `GET /v1/admin/roles` | the grant log; `?role=`, `?includeEnded=true`, `?on=` |
| `GET /v1/admin/roles/administrators` | who can configure this tenant — readable by every rep |
| `POST /v1/admin/roles` | grant a role (**administrator**); never to oneself |
| `POST /v1/admin/roles/:id/revoke` | end a grant (**administrator**); the grant stays, with an end date |
| `PUT /v1/admin/samples/disposal-policy` | the grace period and the promo switch (**compliance**) |
| `GET\|POST /v1/admin/notification-endpoints` | where signals are pushed (**administrator**) |
| `PATCH /v1/admin/notification-endpoints/:id` | thresholds, or `enabled: false`; there is no DELETE |
| `GET /v1/admin/notifications/retention` | how long inboxes keep things — readable by every rep |
| `PUT /v1/admin/notifications/retention` | the two horizons (**administrator**) |
| `GET /v1/admin/notifications/prune-candidates` | what tonight's prune would take, what it would hold back, and whether it would be refused |
| `GET\|PUT /v1/admin/notifications/prune-guard` | the volume ceiling and its floor (**administrator**) |
| `POST\|DELETE /v1/admin/notifications/prune-guard/override` | open or close a bounded, attributed window past the ceiling |
| `GET\|POST /v1/expenses` | own claims (`?state=` repeats) / file one |
| `POST /v1/expenses/:id/submit` | snapshots the S&M account in force now; **refused if the category is unmapped** |
| `POST /v1/expenses/:id/{approve,reject}` | the approver must supervise the claimant and not be them |
| `POST /v1/expenses/:id/{post,reimburse}` | hand it to the ERP, then record the reimbursement |
| `GET /v1/expenses/:id/erp` | where the claim's ERP writes have got to |
| `GET /v1/admin/expense-accounts` | the map, plus the categories reps claim against that nothing can post |
| `PUT\|DELETE /v1/admin/expense-accounts/:category` | map a category, or deactivate it (**administrator**) |

Every error is RFC 9457 `application/problem+json` — one shape, no exceptions. The ERP
emits two on the same API, and a client that handles only one misreads the other.

## Roles

Most routes are scoped to the caller, and the team routes to whoever they supervise. The
handful of routes that configure a *tenant* need something else, because supervision is the
wrong gate: a district manager reads their team's numbers and must not be able to change the
SOP parameter those numbers are measured against.

So there are two roles, held by nobody implicitly, each a **dated grant** on a rep profile:

| | |
|---|---|
| `administrator` | configures the tenant: notification endpoints, inbox retention and its volume guard, the expense category-to-account map, and who holds roles |
| `compliance` | the SOP parameters reps are held to: the disposal grace period, the promo auto-write-off switch |

The split is not arbitrary. A `compliance` parameter is one reps are **measured against**;
an `administrator` one is a statement about the system itself. Retention is the second
kind — the regulated facts a notification refers to live in their own tables and a prune
never touches them.

Four rules, all of them in the database (`db/migrations/0023_roles.sql`), so a route cannot
forget one:

- **Nobody grants themselves a role, and nobody revokes their own.** Together these mean a
  tenant needs two administrators to stay administrable.
- **One live grant of a role per rep**, enforced by an exclusion constraint over the date
  range — so "when did they get this" always has one answer.
- **A grant is history.** It can be ended; it cannot be edited or deleted. A revocation
  records who and when, and the row stays in the log.
- **A tenant can never be left with no administrator.** Revoking the last one is refused, and
  so is suspending them — a suspended profile holds no role, so HR and security are the same
  door. There is no API path back from an empty role set, which is why both are closed.

The **first administrator of a tenant is inserted in SQL**, by whoever runs the migrations.
That is not a gap: a grant cannot name its own holder as grantor, so a closed system has to
be started from outside it.

```sql
INSERT INTO crm.rep_role (tenant_id, rep_profile_id, role, granted_by, valid_from, grant_reason)
VALUES ('<tenant>', '<the administrator>', 'administrator', '<anyone else>', CURRENT_DATE,
        'bootstrap');
```

A role is resolved once per request, with the principal, **as of today** — never as of a
`?on=` parameter, which several reads honour. A revoked role is gone on the caller's next
request.

## Inbox retention

`crm.notification` used to grow forever. It is now bounded by a per-tenant policy with
**two** horizons, and a nightly `notify_prune` job:

| | default | why two |
|---|---|---|
| `retain_read_days` | 30 | a read notification has done its job |
| `retain_unread_days` | 365 | an unread one has **not**, and deleting it deletes a message nobody saw |

A CHECK forbids the unread horizon from being the shorter of the two, so `read=90,
unread=7` is refused rather than silently losing exactly the notifications that still
mattered.

**An open subject survives either horizon.** A notification is a *copy* of a signal — the
obligation, the dead letter, the transfer and the plan all live in their own tables and a
prune never touches them. So pruning loses an inbox entry, never a fact; and a
notification about something **unfinished** is not old news, however old it is:

- a disposal obligation still `open` or `overdue`
- an ERP write still `dead`
- material still in transit (a `transfer_out` with no acceptance against it)
- a call plan still `submitted`, waiting on an approver
- …or any notification whose webhook push is still pending, in flight or dead

`crm.notification_subject_open` is the one place that decides, with a branch per producing
table. A table it has no branch for reads as **not** open and prunes normally — the
deliberate opposite of fail-closed, because the failure being fixed is unbounded growth
and "keep forever when unsure" would bring it back silently. The job counts those
instead, so a missing branch shows up in its own summary:

```
notify_prune  deletedRead=2 deletedUnread=0 keptSubjectOpen=1 keptDeliveryUnsettled=0
              unknownSubjects=1 more=false retainRead=30d retainUnread=200d
```

**And a pass that would take too much is refused outright.** `prune_max_share_percent`
(25% by default) is a ceiling on the share of the inbox one pass may delete; over it, the
pass deletes *nothing* and says why, because a half-applied prune is still irreversible and
leaves nobody able to tell whether the number in front of them is the whole mistake. A
share rather than a row cap on purpose: the failure being defended against is a horizon
wrong by an order of magnitude, and that looks the same at 800 rows and at two million,
where any absolute cap protects one size and fails the other. `prune_guard_floor_rows`
(100) is the count below which the ratio is noise and the guard stays quiet — **capped at
1,000**, because the floor is the left operand of the guard's `AND` and therefore
short-circuits the ceiling entirely. It shipped capped at a million, which made one
unattributed `PUT` a permanent, non-expiring bypass that was not even reported as an
override. A pass the floor lets through now says so in its own words:

```
notify_prune  … share=71.43%/25% prunable=150 inbox=210
              FLOOR-WAIVED: 150 notification(s) is 71.43% of the inbox, over the 25%
              ceiling, but at or under the 200-row floor … — the pass ran
```

Past the ceiling only by a **window**: `POST /v1/admin/notifications/prune-guard/override`
takes `hours` with no default, names who opened it, is capped at seven days, and expires on
its own. A boolean would be set once for one night's reason and outlive it silently,
leaving the next horizon typo unguarded.

Each pass is also capped at 50,000 rows and reports `more`, so a tenant turning retention
on after a year of growth drains over a few nights rather than in one long transaction.
That cap is a throttle, not a refusal — and the guard is measured against what the pass
*wants*, not what tonight would take, or a two-million-row inbox with a one-day horizon
would propose 2.5% every night and empty itself in forty passes unchallenged.
`GET /v1/admin/notifications/prune-candidates` answers "what would tonight take" before
anything is deleted.

## Expenses

A rep files a claim; their manager approves it; it is handed to the ERP. The approval graph
is the CRM's (ADR-0001 item 11) because the ERP's own `Expense` workflow is a flat role
check that never reads `Employee.manager_id` — so four-eyes is enforced here or nowhere.

**Four eyes covers all four decisions — approve, reject, post and reimburse.** It did not,
and the way it failed is worth keeping: `crm.rep_can_supervise` answers *yes* for the
caller themselves, which is correct for a read (a rep may always see their own work, and it
is why one helper serves "mine" and "my team's"), and every write transition gated on
supervision alone. `expense_claim_four_eyes` caught the approve in the database and
`expense_claim_reject_four_eyes` the reject — but `post` and `reimburse` record no actor,
so no constraint could ever have caught those. A rep could hand their own claim to the
ledger and mark it paid. The rule is now in the route, once, for all four, as a 403 that
names which rule was broken rather than a constraint violation with no explanation.

**A rejection names who made it.** `rejected_by` and `rejected_at`, under their own
four-eyes CHECK — it was the one decision in the lifecycle that left no record of its
author.

**Submitting is refused while Finance has not mapped the category.** That is the designed
behaviour, not a gap: `crm.expense_account_map` names the Sales & Marketing
`LedgerAccount.account_code` each category posts to, and posting to a guessed account
mis-states the P&L far more expensively than a claim that will not leave draft. The refusal
is a 409 naming the category and the table, and
`GET /v1/admin/expense-accounts` returns the categories reps are already claiming against
that nothing can post — the Finance to-do list, as a number to watch reach zero.

The account is **snapshotted at submit**, so re-mapping a category next quarter cannot
re-attribute a claim already submitted.

What posts today is the ERP `Expense` record, carrying the account and cost centre in its
description. **The `JournalEntry` does not post**, for three reasons that are Finance's and
Security's rather than ours — no code→record-id path for `LedgerAccount`, no
employee-reimbursements-payable account anywhere in either system, and one ERP scope that
cannot both create an `Expense` and write the GL. All three are in ADR-0001's open table
with what would close them. Guessing the credit side would dead-letter the write and raise
`erp_write_failed` at a rep for a misconfiguration they cannot fix.

## Notifications: the email channel

Two senders, both real. **Webhook** HMAC-signs a POST. **Email** speaks SMTP over
`node:net`/`node:tls` with no dependency — STARTTLS required by default and refused at
construction rather than per send, so a relay configured without TLS fails the scheduler at
boot instead of dead-lettering every message; AUTH PLAIN and LOGIN; RFC 2047 subjects,
because this product's locales include Arabic and a raw 8-bit header is a real bug here.

The classification is the part worth knowing: **4xx retries, 5xx dead-letters**, and a
positive reply at the wrong stage dead-letters because the conversation has lost step.
Backwards, that is either a bounced address retried forever or a greylist — a 4xx, and
extremely common — thrown away.

**The channel is reachable end to end, and that is newer than the sender.** For a while it
was not: `createEndpoint` wrote `'webhook'` as a literal, so migration 0029 could widen the
CHECK to admit `email` and nothing above SQL could name it — and nothing constructed
`SmtpSender` outside the tests. Both halves are closed. `POST
/v1/admin/notification-endpoints` takes a required `channel` with **no default** (the url
shape is channel-dependent, so a caller that does not know which channel it means does not
know whether its url is valid either), and the scheduler builds the sender at boot when
`SMTP_HOST` is set — which is what makes the TLS refusal above a real gate rather than an
unreachable constructor. With `SMTP_HOST` unset an `email` endpoint **retries** with a
readable reason naming the channels this process does register; it used to dead-letter,
which destroyed every notification routed to a correctly configured endpoint whose sender
the running binary happened not to have.

The encoding is chosen from the **composed** message, not from the notification text. The
footer carries the recipient's own name, so an Arabic rep receiving an English notification
produced a body with high bytes in it while the message declared `7bit` — an RFC violation
and exactly the mojibake the check exists to prevent. Verified against a real SMTP
conversation: an ASCII body for `أحمد الموفق` goes out as `8bit` with the name intact, and
`base64` to a relay that does not offer 8BITMIME.

It has **never spoken to a real mail server**: it is verified end to end against a sink
written alongside it, which is faithful to RFC 5321/3207/4616 as far as it goes and is not
Postfix. It does no DKIM signing. Both are in the ADR's open table.

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

It needs a credential for the ERP. In production that is a CRM-minted Ed25519 service
token; `ERP_TOKEN` is a development-only static credential and the process refuses to start
with it under `NODE_ENV=production`.

## The ERP credential

The CRM signs its own ERP-facing token. Two tiers that never mix (ADR-0001 item 10): any
OIDC provider for humans into the CRM (RS256 is fine — that token never reaches the ERP),
and a short-lived Ed25519 service token per tenant for the CRM into the ERP.

```bash
pnpm key generate          # prints the private PEM once, publishes the public half
pnpm key activate <kid>    # refuses until the JWKS has had time to propagate
pnpm key list
pnpm key kid-of < key.pem  # which kid a PEM signs under
```

The ERP is pointed at `https://<host>/.well-known/jwks.json` with a matching `--jwt-issuer`
and `--jwt-audience`. Only the scheduler holds the signing key; the API publishes the JWKS
from the database and has no private key at all, so it could not mint a token if it were
compromised. `deploy/README.md` has the rotation procedure.

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

**1. `crm_app` owns nothing of the ERP's, and the application never connects as a
privileged role.** A table's owner bypasses row-level security — verified, not assumed
(`packages/db/src/rls.contract.test.ts`). Ownership separation *is* the isolation
guarantee for ERP data. A superuser bypasses RLS even under `FORCE`, so connecting as one
turns every policy in the schema into decoration.

That second half used to be documentation. It is now enforced: `withTenantContext` asks
the server which role its statements will run under and **refuses** a role that is
`SUPERUSER` or `BYPASSRLS`, so a `PGUSER=postgres` fails loudly instead of silently
serving every tenant's rows. `GET /healthz` reports the same thing as `503 degraded`,
naming the role — a rollout that would have gone live and then 500ed never goes live.
The contract tests connect as `crm_app` for the same reason, which is what makes their
tenant-isolation assertions mean anything.

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

**10. The JWKS endpoint returns 503, never an empty 200.** The ERP keeps its last good key
set when a fetch fails and *replaces* it with whatever a 200 carries — so a 200 holding
`{"keys":[]}` disarms every verifier that fetched it and 401s every subsequent call. When
there is nothing to publish, the safe answer is to fail the request.

**11. A service token carries exactly one scope.** The ERP reads only the first
space-separated scope as the principal's role and discards the rest, so
`scope: "sales_rep controller"` grants `sales_rep` while reading as though it granted both.
Refused by a CHECK constraint on the role and again by the minter.

**12. A key is published before it signs, and retired only after its tokens expire.** Both
waits are enforced by the registry rather than written down, because neither failure is
visible when you cause it — each surfaces later as a 401 that looks like an auth bug rather
than a rotation mistake.

**13. A sample balance is derived from its movements, never kept alongside them.** The ERP
has `StockMovement` and `StockLevel` and nothing connecting them — grepping the workspace
for `quantity_on_hand` outside the pack declaration returns zero hits, so posting a movement
does not change a level. Here a trigger applies the movement to the balance in the same
transaction, a movement that would drive it negative aborts, and the balance cannot be
written directly at all. That is the difference between recorded and accountable.

**14. The custody ledger is append-only, and an expiry is judged on the day of the
hand-over.** A mistake is corrected by an adjustment carrying a reason, which leaves both
in the log. `occurred_at`, not `now()`: a sync three days later must not retroactively
invalidate a hand-over that was legitimate when it happened, nor legitimise one that was
not.

**15. A drug sample lot must have an expiry, and a hand-over must have a signature.** Both
are CHECK constraints. Lot tracking exists to answer "was it in date"; in an audit, "we
cannot say" is the same answer as "no". The signature is stored as a sha256 of what the
device captured — there is no object storage yet, so the hash commits to an image that has
nowhere to live, which is weaker than holding it and stronger than a boolean.

**16. Only the aggregate crosses into the ERP.** A rep receiving stock mirrors one
`StockMovement` — and note the inversion: the CRM's `receipt` is the ERP's `issue`, the same
event from the other side of the warehouse door. Disbursements, transfers, destructions and
adjustments happen inside custody and are invisible there; mirroring them would
double-count. The lot and expiry go into `reason` as text because `StockMovement` has
nowhere else to put them.

**17. An approved call plan is frozen, and approval is four-eyed *and* authorised.** If "we
planned three calls" can be edited after the calls happened, adherence measures nothing — so
a change is a new plan that supersedes the old one and both stay in the record. The approver
is neither the rep nor the submitter, and must actually manage the rep's territory: four
eyes says "someone else", the territory hierarchy says "the right someone else".

**18. Coverage and attainment are reported separately.** Coverage is "did we reach them at
all"; attainment is "did we call as often as we said", capped per target. Reporting only the
second is how a field force looks fully compliant while a third of its customers were never
seen.

**19. "Whose data may I read?" has one definition, in SQL.** `crm.rep_can_supervise`
answers it for every team route. RLS is no help — a manager and a peer's rep are in the
same tenant, so the policy admits both rows and this predicate is the only thing between
them. A route that forgets it leaks; a route that uses it cannot. Scoping happens *inside*
the query, never by filtering afterwards on a rep id the caller supplied.

**20. Supervision follows the hierarchy, not co-location, and it is dated.** A rep
assigned `primary` to the same territory as another is a colleague, not a supervisor.
And a manager who took over a district in October supervises whoever held its territories
on the date asked about — which is what makes last quarter's numbers readable after
anyone changes job.

**21. "My team" excludes me; "may I read this" includes me.** Two functions, each named
for the question it answers. A manager in their own roster makes every count off by one;
a manager who cannot read their own records is absurd. Collapsing them into one would
force every caller to remember which semantics it had.

**22. A rep with no plan appears in the rollup, with nulls.** "Who has not got a plan
this cycle" is the first question a territory review asks, and an inner join would answer
it by omitting them — the team would look fully covered because the gaps were not in the
result set.

**23. The expiry sweep does not write off a drug sample, and that is the design.** At 3am
the carton is still in the rep's bag. A job that removed it from the balance would make
the system assert the stock is gone when it is not, and the question an inspector asks is
"where did these expired units actually go?" — to which "a scheduled job stopped counting
them" is worse than an untidy balance, because it reads like an answer. So the sweep
raises a dated obligation and chases it; the material leaves custody when a person records
a destruction or a return. Promotional material is different, and is treated differently:
auto write-off is available for it, per tenant, opt-in, and never reaches a drug sample.

**24. A resolution is attributed from the ledger, not declared.** The sweep sees a holding
at zero and reads the last decreasing movement to say *how* — destroyed, returned, written
off, transferred, adjusted — and records which transaction it was. Stock that vanished with
nothing to explain it stays **open** and is counted as unattributed, because closing it
with a guessed reason would put a fabricated disposal in the record.

**25. Expired stock cannot be received into custody.** If the warehouse sends it, the rep
does not take custody — the warehouse takes it back. Accepting a transfer of expired stock
*is* allowed: material already in custody has to be somewhere, and refusing the acceptance
would strand it in transit with nobody accountable.

**26. A notification is raised in the same transaction as the thing it is about.** There is
no state where a disposal obligation exists and nobody was told, nor one where someone was
told about an obligation that rolled back. In-app delivery *is* the row; the webhook call
is queued and made later, because an external call must never sit inside a business
transaction.

**27. Read state is a column, not an approximation.** `read_at` per notification per
recipient, so an unread badge is a count. The ERP has no per-user read state and
approximates "unread" by recency, which goes wrong the moment someone reads on two devices.

**28. A webhook signature commits to the timestamp as well as the body.** Signing the body
alone lets anyone who captured one delivery replay it forever. `verifyWebhook` ships
alongside the sender so the receiving end has a reference rather than a reimplementation,
and the tests verify against it — so both halves are known to agree. A missing secret
dead-letters the delivery rather than sending unsigned.

**29. Three channels, all real; SMS, push and voice are a seam and nothing more.** The
ERP's notification package declares 6 channels and 18 providers and has a working
implementation for one of them, a gap that sat in its ADRs for releases. Working channels
are worth more than declared ones, so this ships in-app, webhook — verified against a real
HTTP server that checks the signature — and email, verified against a real SMTP
conversation, and says plainly that nothing else is built.

**A channel is not shipped until it is reachable from a route and constructed by a
process.** That is the second half of this rule and it was learned the hard way: email had
~1,400 lines, a migration widening the CHECK to admit it, a README paragraph and an ADR
item, and for one commit it could be configured only in psql and sent by nobody — a
shipped, documented channel that did not exist. "Both senders are real" was true of the
code and false of the system.

**30. A write the ERP refuses permanently is not allowed to fail quietly.** The rep's app
already showed it as recorded — because in the CRM it is — so the only half that failed is
the half they cannot see, and they would otherwise find out at month end. A dead letter now
notifies the rep urgently and their manager as a warning, in the same transaction as the
state change. Where the producing table cannot be mapped to a rep, that is **counted**, not
glossed over: the row still appears in the listing, precisely because nobody was told.

**31. A dead letter has a way back.** Most reasons a write dies permanently — a missing
ledger account, a permission not granted, a parent record that did not exist yet — are fixed
on the ERP side, after which the queued intent is still valid. `retry` re-sends the **same
payload**, resets the attempt count because the cause was fixed, and keeps `dead_reason` so
"died, tried again, died again" reads differently from a fresh failure. It is not an edit,
and a payload that was wrong will die again with `revive_count` to say so.
