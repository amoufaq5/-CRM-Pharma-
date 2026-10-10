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
| `packages/client/` | The field client's pure layer: the wire schemas, the outbox state machine, the backoff, device-minted ids, and the classifier that decides what a refusal MEANS for a queue. No DOM, no `fetch`, no clock. |
| `apps/field/` | The app a rep uses. A framework-free PWA: IndexedDB outbox, PKCE sign-in, a canvas signature pad, a service worker for the offline shell. Visits and sample disbursements, offline, with the signature the ledger commits to. |
| `deploy/` | Dockerfile, Compose stack, Caddy. One image, three entrypoints, plus a `web` target that serves the app from the same origin — which is why nothing here has CORS. See [`deploy/README.md`](deploy/README.md). |
| `scripts/` | `erp-fixture.sh` (ERP stand-in), `setup-test-db.sh` (contract-test database), `verify-migration-runner.sh` (the runner, against a real Postgres), `verify-client-live.sh` (the app, in a real Chromium, taken offline). |

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

The app, and the checks that drive it:

```bash
pnpm client:build          # the bundle a browser downloads (esbuild; tsc only typechecks)
pnpm client:verify         # the app in a real Chromium, taken offline, against the real API
```

`client:verify` needs a Postgres it can create a database in, and a Chrome or Chromium —
it finds one, or fails saying so. A browser check that skips when there is no browser is
not a check.

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
| `POST /v1/samples/receipts` | confirm stock from a depot — the one route that mirrors to the ERP; the depot must be one the ERP has |
| `POST /v1/samples/disbursements` | a hand-over, with recipient and signature hash |
| `GET\|POST /v1/samples/transfers` | outstanding transfers, either side / send to another rep |
| `GET /v1/samples/transfers/incoming` | material on its way TO the caller — the list an accept acts on |
| `GET /v1/samples/transfer-peers` | who a transfer can be addressed to: active reps in the tenant |
| `POST /v1/samples/transfers/:id/accept` | the receiving rep accepts |
| `GET /v1/samples/transfers/recallable` | material the caller sent that nobody has accepted |
| `POST /v1/samples/transfers/:id/recall` | take it back — **sender only**; a new ledger row, never an edit |
| `GET\|POST /v1/samples/counts` | the rep's cycle counts / open one, under a device-minted id |
| `POST /v1/samples/counts/:id/lines` | one counted lot; keeps the device's own expected figure beside the server's |
| `POST /v1/samples/counts/:id/commit` | one adjustment per difference — **idempotent**, so a lost reply is not a refusal |
| `POST /v1/samples/counts/:id/cancel` | abandon it; the only way out of a count whose line was refused |
| `GET /v1/samples/ledger` | the append-only custody log |
| `POST /v1/sync/disbursements` | offline flush, **per-row** results |
| `POST /v1/call-plans` | create, for self or a supervised rep; then `/targets`, `/products` |
| `POST /v1/call-plans/:id/{submit,approve,return,withdraw,supersede}` | the lifecycle |
| `GET /v1/team` | the roster, through the territory hierarchy |
| `GET /v1/team/call-plans` | the team's plans; `?status=submitted` is the approval queue |
| `GET /v1/team/adherence` | the territory review: one row per rep, **including reps with no plan** |
| `GET /v1/team/samples/exposure` | what each rep holds, ordered by whose count is most overdue |
| `GET /v1/team/samples/expiring` | expiring stock across the team |
| `GET /v1/team/samples/ledger` | one rep's custody log, for an audit |
| `GET /v1/team/visits` | one rep's activity |
| `GET /v1/samples/obligations` | what the caller must dispose of, with the deadline |
| `GET /v1/samples/obligations/:lotId/history` | the whole continuation chain for one lot, with each link's resolution and the ledger movement that discharged it |
| `POST /v1/samples/write-offs` | a destruction or an expiry write-off — **reason required**, and the two kinds stay apart |
| `GET /v1/samples/warehouses` | the depots a return can be addressed to — active only, `?q=` matches code or name |
| `POST /v1/samples/returns` | back to a depot off that list; mirrored to the ERP as a `receipt` |
| `GET /v1/samples/disposal-policy` | the grace period and the promo switch, with who set them and why |
| `GET /v1/samples/disposal-policy/history` | every change to those parameters, newest first — open to every rep, who is measured against them |
| `GET /v1/team/samples/obligations` | the team's outstanding disposals — the chase list |
| `GET /v1/notifications` | the inbox; `?unread=true` filters |
| `GET /v1/notifications/unread-count` | a real count of a real column |
| `POST /v1/notifications/:id/read` | idempotent; keeps the first read timestamp |
| `POST /v1/notifications/read-all` | |
| `GET /v1/erp-writes/failed` | writes the ERP refused permanently — theirs |
| `GET /v1/team/erp-writes/failed` | the team's, for a manager |
| `POST /v1/erp-writes/:id/retry` | queue the same payload again, once the cause is fixed |
| `GET /v1/erp-writes/:id/history` | why it died EACH time, with the shape named: a different cause each attempt, or the same wall twice |
| `GET /v1/admin/erp-writes/deaths` | every recent death in the tenant, orphans included (**administrator**); `?limit=` 1..500 |
| `GET /v1/me/roles` | which administrative roles the caller holds, if any |
| `GET /v1/admin/roles` | the grant log; `?role=`, `?includeEnded=true`, `?on=` |
| `GET /v1/admin/roles/administrators` | who can configure this tenant — readable by every rep |
| `POST /v1/admin/roles` | grant a role (**administrator**); never to oneself |
| `POST /v1/admin/roles/:id/revoke` | end a grant (**administrator**); the grant stays, with an end date |
| `PUT /v1/admin/samples/disposal-policy` | the grace period and the promo switch (**compliance**); a **reason is required** and the change is an append-only record |
| `GET\|POST /v1/admin/notification-endpoints` | where signals are pushed (**administrator**); creating one needs a **reason** and records who |
| `PATCH /v1/admin/notification-endpoints/:id` | thresholds, or `enabled: false`; a **reason is required** and the change is an append-only record; there is no DELETE |
| `GET /v1/admin/notification-endpoints/:id/history` | every amendment to one endpoint, newest first, with both halves of each knob |
| `POST /v1/admin/notification-endpoints/:id/test` | ask the scheduler to probe it; `202`, because it is queued, not answered |
| `GET /v1/admin/notification-endpoints/:id/test` | the verdict the scheduler recorded |
| `GET /v1/admin/notification-endpoints/:id/tests` | the last twenty, newest first |
| `GET\|PUT /v1/admin/notifications/probe-limits` | the probe cooldown and the hourly budget, read and set together (**administrator**) |
| `GET /v1/admin/notifications/retention` | how long inboxes keep things — readable by every rep |
| `PUT /v1/admin/notifications/retention` | the two horizons (**administrator**) |
| `GET /v1/admin/notifications/prune-candidates` | what tonight's prune would take, what it would hold back, and whether it would be refused |
| `GET\|PUT /v1/admin/notifications/prune-guard` | the volume ceiling and its floor (**administrator**) |
| `GET\|PUT /v1/admin/notifications/delivery-retention` | how long the record of a push is kept (**administrator**); 0046's third horizon |
| `GET /v1/admin/notifications/:id/deliveries` | where one signal went, still answering after the notification is pruned |
| `GET /v1/admin/notification-deliveries` | the tenant's recent pushes, newest first by write order; `?limit=` 1..500 |
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

**And a role answers who MAY, not what happened.** 0023's own header named the debt it was
clearing in two clauses: `crm.disposal_policy` and `crm.notification_endpoint` were
"settable by anyone with the application password, **with no record of who changed what**".
The role model answered the first clause and left the second for two years of migrations.
Both are closed now, and by the arrangement migration 0018 already used for a sample
balance: the configuration row is a **projection of an append-only log**, every write names
an author and carries a reason, and a direct `UPDATE` is refused by the database rather than
merely avoided by the code. The disposal policy is 0059; the endpoints are 0060, where what
an endpoint *is* was already frozen for the life of the row (0049) so its author is a frozen
column beside the destination, and only its *tuning* is logged.

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

## Delivery history outlives the inbox

`crm.notification_delivery` used to cascade from `crm.notification`, so the retention period
for an inbox entry was also the retention period for the record that the signal had been
pushed to a third party. It no longer references the notification at all: it **copies** the
four facts that make a push legible on its own — the kind, the severity, when the signal was
raised, and whose data left the tenant — and it has a **third horizon**,
`retain_delivery_days` (730 by default, and forbidden by `CHECK` from being shorter than
`retain_unread_days`, so evidence always outlives the message it is evidence of). Two years
because a delivery record is evidence about a third party's endpoint *and* about a disclosure
of a named employee to it, and that is audited on a different clock from an inbox badge.

**0048 did the same for the other parent**, which 0046 had named as the identical defect
still open: `notification_delivery_endpoint_id_fkey` was `ON DELETE CASCADE`, so deleting an
endpoint erased the record of everything ever sent to it. So the row copies the destination
too — `endpoint_channel` and `endpoint_url`, which 0046 deliberately *joined* on the grounds
that the endpoint was still readable from a live row. That reasoning expired the moment the
row could outlive it. It closes a second thing on the way: `updateEndpoint` refuses to
repoint a url, arguing that doing so would carry the delivery history onto a different
destination — and nothing in the schema said so, so a hand-written `UPDATE` silently
re-attributed every record that endpoint ever had. A copy taken at enqueue time cannot be
re-attributed by anything.

It copies no `subject`, `body` or `payload`, deliberately: the delivery table must not become
a second, longer-retained copy of the inbox, or `retain_delivery_days` silently becomes the
real retention period for notification prose and the two horizons above stop meaning
anything. And it does not copy `secret_env`, because that names an environment variable and
rotating which one an endpoint reads is a legitimate change that must not be frozen per
delivery — which is also why the sender still joins the live endpoint, and therefore why
`claimDue` requires **both** parents to exist before it will claim a row. An orphan of either
kind is settled `dead` with a reason that says which: a missing notification means the
payload cannot be rebuilt, a missing endpoint means the secret cannot be read.

**0049 made the repointing rule a rule** rather than an omission. 0048 described the hole and
could only half-close it: a delivery row now carries its own copy of where it went, so
history written *after* 0048 survives a hand-written `UPDATE` — and every row written before
it still read its destination through the foreign key, so the schema would have held two
indistinguishable populations of delivery records, one of them naming the wrong host.
`channel`, `url` and `secret_env` are frozen for the life of the endpoint by a trigger, the
list is published as a SQL function and asserted against the table's real columns (0047's
shape: a frozen column whose name is misspelled freezes nothing and fails nothing), and
moving a destination is still what `updateEndpoint` always said it was — disable the old
endpoint, create a new one. `secret_env` is in the frozen list even though 0048 argued
rotating it is legitimate, and the distinction is which rotation: pointing an endpoint at a
*different* variable changes which secret signs its pushes, where changing the *value* the
variable holds does not touch the row at all. The knobs — `min_severity`, `kinds`,
`enabled`, `description` — stay turnable, because they change what will be sent and never
what was.

**The same migration gave `kinds` the check it never had.** An endpoint's allow-list was a
bare `text[]`: `['call_plan_submited']` was accepted, matched nothing, and left an endpoint
that was enabled, probe-able and subscribed to silence — the exact dead endpoint 0034's
probe exists to expose, with no probe failure to expose it, because the transport was fine.
`normaliseKinds` had guarded it in TypeScript and said so, ending "this is the guard until
the array has one of its own".

Adding it meant answering an objection 0046 had already raised against a different copy of
the same list: the kind vocabulary has been widened three times (0022, 0029, 0031), each
time by restating all of it, and a fourth copy would have to be widened in lockstep — a
migration that forgot would refuse an administrator the ability to subscribe to a kind the
system was already raising. So the list moved into **`crm.notification_kinds()`** and both
CHECKs call it. Widening is now one `CREATE OR REPLACE FUNCTION`. Narrowing is not, and the
migration says so where someone will read it: replacing the function does not revalidate the
constraints that call it, so removing a kind goes through `DROP CONSTRAINT` + `ADD
CONSTRAINT` as all three widenings did, and the scan names the rows.

`notify_prune` gained a second **phase** rather than a second job: same pass, same
transaction, same ceiling, same floor, same break-glass override — but measured against its
own table, because a share *of the inbox* says nothing about a delete from the delivery
table. The two phases refuse independently, so one mistyped inbox horizon cannot suspend the
other table's retention. Only a `delivered` push is prunable; a `dead` one is kept forever,
because a webhook that permanently failed is the most valuable row in the table.

The table also got `seq`, for the reason `crm.outbox.seq` exists: `created_at` *and*
`next_attempt_at` are both the transaction clock, and `raiseNotification` fans one signal to
every matching endpoint in one transaction — so a dispatch batch had no write order at all,
and both the claim order and the order the sender worked through it were the query plan's.

Reachable over HTTP, which is the half this repo has forgotten five times:
`GET|PUT /v1/admin/notifications/delivery-retention` and
`GET /v1/admin/notifications/:id/deliveries` (which still answers after the notification is
gone, with `notification_present: false`, so a client says "the inbox copy is gone" rather
than rendering a dead link) and `GET /v1/admin/notification-deliveries`. Administrator, not
every rep: a rep whose notification disappeared is entitled to know it was a rule, but a
delivery record is about an endpoint they cannot see.

## Expenses

A rep files a claim; their manager approves it; it is handed to the ERP. The approval graph
is the CRM's (ADR-0001 item 11) because the ERP's own `Expense` workflow is a flat role
check that never reads `Employee.manager_id` — so four-eyes is enforced here or nowhere.

**Four eyes covers the three decisions a person makes — approve, reject and reimburse — and
`post` only when a person does it.** It covered none of them, and the way it failed is worth
keeping: `crm.rep_can_supervise` answers *yes* for the caller themselves, which is correct
for a read (a rep may always see their own work, and it is why one helper serves "mine" and
"my team's"), and every write transition gated on supervision alone. `expense_claim_four_eyes` caught the approve in the database and
`expense_claim_reject_four_eyes` the reject — but `post` and `reimburse` record no actor,
so no constraint could ever have caught those. A rep could hand their own claim to the
ledger and mark it paid. The rule is now in the route, once, for all four, as a 403 that
names which rule was broken rather than a constraint violation with no explanation.

**And what a claim says is frozen once it leaves draft** (0047). The amount, the currency,
the date, the category, the account snapshot, the description and the rep it belongs to are
all fixed from the first transition out — because a claim approved for 120.50 could otherwise
be edited to 1,205.00 and posted, with the approval still on the row, with its approver and
its timestamp, attesting to a number nobody ever saw. Keyed on the state the row was
*already* in rather than write-once, which is what keeps the one legitimate writer legal:
`submitClaim` stamps the account snapshot in the same statement as `draft → submitted`.

A rep who is neither the claimant nor a supervisor gets a **404 naming the claim** —
`no expense claim <id> on your team` — and not the `no rep <id> on your team` the
supervision helper answers with. That sentence handed a caller who held a claim id the
owner's `rep_profile` id, which is the identifier the 404 exists to conceal; every expense
route that reached for the supervision helper had it.

**And `post` is no longer only a route, which weakens the check there to a formality.**
Migration 0031 added the `expense_post` sweep, which hands every approved claim to the ERP
every five minutes with no actor and no four-eyes test — so a claimant who wants their own
claim posted now simply waits. Not exploitable, and worth being precise about why: reaching
`approved` still takes a second person (the route's check and
`expense_claim_four_eyes` both), and `reimburse` has no automated path at all. But the
route's guard on `post` is a dead check a future reader would take for a live guard, and the
honest reading is that four eyes protects the decisions a person makes, not the hand-over a
job performs on their behalf.

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

## Attachments: a signature you can actually produce

A sample disbursement has always committed to its signature's bytes with
`signature_sha256`, and until now there was nowhere for the image to live — so a
disbursement could say a signature was taken, and fix exactly which one, without being able
to produce it. The same was true of `crm.expense_claim.receipt_url`, a URL column with
nothing behind it.

| | |
|---|---|
| `POST\|GET /v1/samples/disbursements/:id/signature` | capture, and every capture for that disbursement |
| `POST /v1/expenses/:id/receipt` | a receipt, optionally superseding one |
| `GET /v1/expenses/:id/receipts` | the whole chain, superseded images included |
| `GET /v1/attachments/:id` | metadata |
| `GET /v1/attachments/:id/content` | the bytes, base64 in a JSON envelope |
| `GET /v1/attachments/:id/access-log` | who has read them |

**The commitment is checked twice, from two directions.** A trigger computes
`sha256` from the **stored octets** and refuses a disagreement with the row's
`content_sha256`; a second trigger compares that digest against the ledger's
`signature_sha256` and refuses a mismatch. So the only image that can ever satisfy a
disbursement's commitment is the one the device captured, and uploading a different one is
a `409 signature-mismatch` — its own problem type, because no retry of those bytes can
succeed and the next step is to look at which capture was sent, not to try again.

**Four eyes deliberately does not apply here, and reaching for it would be the exact
inverse of the bug it was written for.** `requireExpenseApprover` exists because approving,
rejecting, posting and reimbursing decide whether a rep gets paid. Attaching *evidence*
approves nothing and moves no money — and a rep must be able to upload their own receipt
and their own signature capture, which is the whole point. Supervision-including-self is
the correct gate.

**"Missing" and "not yours" are one answer.** Whether a colleague holds a named doctor's
signature is itself information about that colleague's work, so both are 404. The signature
upload route makes the same choice one step earlier and had to avoid an easy mistake:
`requireSupervision` would have been the obvious gate and its message is "no rep *id* on
your team" — which hands a caller who guessed a disbursement id the id of the rep who holds
it. The predicate is reused; the sentence is not.

**No route takes `?on=`.** A write is judged on the day it happened; a *disclosure* is
judged on who is accountable now, or backdating would give the manager who has since left
the district continuing access to its personal data. The store no longer accepts a date at
all.

**No DELETE and no PATCH**, anywhere: all three tables are append-only by trigger, so a
route would advertise an operation that always 409s. A retake supersedes, and both images
stay — so "retaken" and "swapped" remain distinguishable, which is what the chain is for.

**One rule lives in the route and should not.** Nothing in the schema reads
`crm.expense_claim.state`, so the database would let a rep swap the current receipt on an
already-approved claim: the old image survives, but *which* image is the receipt changes
under an approval given against the other one. The route holds it in two tiers — adding a
first receipt is allowed while `draft` or `submitted`, replacing one only in `draft`,
because an approver may be reading receipt A at the moment it becomes B — and that
asymmetry is the whole reason the tiers differ. It belongs in a trigger, because a route is
not where an offline path can be made to honour it; recorded as owed rather than pretended.

## The disposal audit chain

A disposal deadline survives the material leaving custody and coming back. When expired
stock goes out on a transfer and the nightly sweep finds the rep holding none of it, the
obligation resolves as `transferred`; a recall puts it back. Before 0030 the next sweep
raised a **new** obligation with a fresh `discovered_on` and a later `due_by` — so a round
trip bought thirty more days, and two reps bouncing a transfer between them could do it
indefinitely.

The fix is a **continuation row**, not a re-opened one: the resolved obligation is left
byte-for-byte as it was, because "this material left this rep's custody on this date by
transaction X" is an attributed ledger fact that stays true, and the new row inherits
`discovered_on` and `due_by` verbatim while naming the row it continues. A late recall is
therefore born already overdue and escalates on the same sweep, which is the correct
outcome and needed no special case.

That makes the record a chain, and `GET /v1/samples/obligations/:lotId/history` is how it
is read — scoped by supervision, so one route serves "my lot" and "my rep's lot". It
answers the two questions an inspector asks separately: each link's own resolution, and
the **ledger's** word for the movement that discharged it (`transfer_out`, not just
`transferred`), joined from `crm.sample_transaction`. So "the obligation was settled" and
"the stock went away and came back" stay distinguishable.

Ordered by the chain walk, never by time: two obligations written in one transaction — what
a catch-up sweep produces — share `created_at` to the microsecond, because `now()` is the
transaction clock. The walk is the only ordering that exists.

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

It has **never spoken to a production relay**, and to exactly one third-party server.
`scripts/crosscheck-smtp.sh` drives it against **aiosmtpd** — delivery, dot-stuffing, an
RFC 2047 subject that Python's own parser decodes back byte-identical, AUTH, and a wrong
password that goes `dead` rather than retrying forever — which rules out a mistake the
client and our own sink share. Deliberately a cross-check a reviewer or an operator runs
and not a CI gate: making the suite depend on an undeclared Python package would trade a
real verification for a brittle one, so it skips loudly with a zero exit when aiosmtpd
cannot be had. Neither that nor the in-repo sink is Postfix, Exchange or SES, and it does
no DKIM signing. Both are in the ADR's open table.

## Testing an endpoint, and knowing a channel can be sent

**The API cannot tell you whether your endpoint works, and that is a fact about where the
secret lives.** `secret_env` names an environment variable; the sender runs in the
**scheduler**, which reads a different environment. A check in the API would answer
confidently about the wrong one. So the scheduler probes and records the verdict and the API
reads the row: `POST …/test` returns `202`, and the next `notify_dispatch` tick (30s) fills
in the answer.

Four verdicts, each naming only what was proven:

| | |
|---|---|
| `delivered` | a probe message was accepted — a **webhook** got a real signed POST back 2xx |
| `reachable` | the destination accepted us and **nothing was delivered** — **email** walks greeting → EHLO → STARTTLS → AUTH → `MAIL FROM` → `RCPT TO` → **`RSET`** → QUIT |
| `refused` | answered and said no, permanently |
| `unknown` | **fail closed** — a timeout, a refused connection, no prober for the channel |

Email stops before `DATA` on purpose. A real probe email puts a message in front of a person
who did not ask for one every time an administrator checks a setting, and buys only the
`DATA` phase; a bare connect-and-AUTH check is too weak, because a relay that authenticates
and then refuses the mailbox would report as fine. `MAIL FROM` + `RCPT TO` proves the
envelope sender and the mailbox, which is the misconfiguration that actually happens. `RSET`
before `QUIT`, so "no message was sent" is explicit in the relay's own log.

The webhook probe carries `x-crm-event: endpoint_probe` — deliberately **not** a
`NotificationKind`, so a receiver switching on the event falls to its default branch and one
parsing the body finds no `kind`, `subject` or `recipient` to misread. It names no rep,
account or lot, and nothing in a verdict is a secret: `detail` names the *variable*.

The prober and the sender are **one conversation**, not two clients that have to stay in
step by vigilance. `SmtpConversation` is exported from `smtp.ts` as its phases — connect,
`negotiate`, `envelope`, `transmit`, `abandon`, `quit` — with a private constructor and a
private socket, so the prober cannot write a raw byte, cannot read a reply without
`classifySmtpReply` deciding what it means, and cannot reach `DATA` even by mistake:
`transmit` has exactly one caller in the package. Both constructors call one
`assertUsableRelay`, so the From check, the port check and the plaintext-only-to-loopback
rule cannot drift apart — and that last one matters more for a probe, because a probe
*authenticates*, so plaintext to a remote host would put the password on the wire purely to
find out whether it was right.

Four rules sit in the schema rather than the route, so the offline path cannot skip them:
**one outstanding probe per endpoint** (a partial unique index, because a trigger cannot see
another transaction's uncommitted row), a **cooldown per endpoint, of the tenant's chosen
length** (120s by default — each endpoint is a different third party, so a quiet one is not
rationed by a noisy one, which bounds the rate per destination and deliberately says nothing
about the tenant's total), a **total budget per tenant** (120 probes an hour by default,
across every endpoint, because endpoints per tenant are uncapped and the sum of those
per-endpoint rates therefore had no ceiling at all — five endpoints at the default cooldown
already exceed it, and a fifty-endpoint tenant could emit 1,500 an hour), and `requested_at`
**overwritten by the trigger**, because a caller who could supply it could backdate one probe
and make the next legal immediately.

Both numbers are settable over HTTP, as one route. They are two rules, applied in order, that
answer one question — *may I test this endpoint, and when?* — and an administrator who finds
the cooldown too slow is not going to guess that the budget is a different page. `PUT` takes
any subset and reads the current state first, so changing the window does not silently reset
the count; the legal ranges are **not** restated in the route, because the setters own them
and a second copy is a second thing to widen — a test asserts the refusal carries the
schema's own sentence.

Both limits answer `429` and not `409` — this is rate limiting, the state of the system is
fine and only the pace is not — and both messages name the moment a retry becomes legal. The
cooldown is tested first, because "you asked about THIS endpoint two minutes ago" is the
better-aimed sentence and the budget's would otherwise hide it for a whole window. The budget
is counted under a per-tenant advisory lock held to commit, because a count has no partial
unique index available to it and two administrators pressing test at the same moment would
otherwise both pass a check that sees neither other's uncommitted row. One consequence worth
knowing: the retention ring now keeps **at least** the newest twenty per endpoint rather than
exactly twenty, because a row inside the budget window is a row the budget is counting and a
ring that deleted it would hand the slot back — a bound computed from rows cannot also be the
reason those rows are deleted. Before that, with the cooldown set to 0 (which the schema
permits), the ring would have dissolved the budget entirely in the one configuration that has
no other bound.

**And at boot the scheduler says whether it can send what the database asks for.** It
compares the channels on each tenant's enabled endpoints against the senders it registered
and logs `covered`, `dormant` (only disabled endpoints on an unregistered channel — nothing
is late, but enabling one would be) or `unsendable`. It **warns and starts**: the TLS refusal
in `SmtpSender`'s constructor is a statement about this process's own configuration, where
coverage is a statement about tenant data that changes while the process runs — and refusing
to boot would take down the relay drain, the expiry sweep and expense posting for every
tenant because one tenant configured one endpoint this binary cannot serve. Per tenant
necessarily: the table is RLS-forced and boot precedes any tenant context, so a single
cross-tenant `SELECT` returns zero rows — correctly, silently, and reporting every
deployment clean.

**And then again on every dispatch tick, but only when the answer changes.** Coverage is a
statement about tenant data, so a boot-time verdict goes stale the moment an administrator
adds an endpoint: an `email` endpoint created a minute after a webhook-only scheduler
started was not noticed until the next restart. Re-checking per tick is the obvious fix and
the obvious objection is that it is a log line every thirty seconds per tenant — so the
scheduler remembers the last verdict and appends to the `notify_dispatch` summary only on a
transition (`coverage covered -> unsendable: no sender registered for channel email`). A
recovery is reported too. A verdict that cannot be obtained becomes `coverage UNKNOWN: …` in
the line rather than a job failure, because the notifications went out and an unanswerable
diagnostic must not engage the job's backoff. The dedup is per-process, so a restart
re-reports a standing gap through the boot check above — which is the right surface for it.

## Tenant isolation is structural, not just a policy

Every foreign key in `crm.*` into a tenant-scoped table is **composite** —
`(tenant_id, ref_id) → (tenant_id, id)`, **all 44 of them, with none left single-column**,
and with constraint names and every `ON DELETE`, `ON UPDATE`, deferrability and match type
preserved byte for byte (measured against the catalog before and after, not asserted by
eye).

This closes a class, not an instance. **A referential check runs with row security
disabled** — that is what makes foreign keys usable at all — so RLS was never standing
between a row and another tenant's parent. Demonstrated before being fixed: as `crm_app`,
under FORCE RLS, inside `withTenantContext`, a tenant-B `rep_role` naming a tenant-A profile
as `granted_by` inserted and **committed**; and `SELECT count(*)` with no tenant context
returned `0`, because RLS then hides the damage. That is the shipped bug
`crm.revoke_rep_role` had — fixed once, in one function, which is exactly the kind of fix the
next function forgets.

`packages/db/src/composite-fk.contract.test.ts` probes each of the 44 that remain individually, asserting both
`23503` **and** the constraint name, so a CHECK that fired first or a trigger fails the test
rather than passing for it. It carries a `pg_constraint` drift guard too: a table added next
month by someone who does not know this rule fails a test instead of quietly reopening the
class.

0046 and 0048 dropped two of the original 46 — **both** of `crm.notification_delivery`'s —
on retention grounds, and did not weaken the rule: a reference that *exists* in `crm.*` is
still composite, and both tenant guards moved into one `BEFORE INSERT` trigger that resolves
each parent under the caller's own row security. That is **tighter** than the keys it
replaced, because a referential check runs with row security disabled and would have
accepted another tenant's parent as existing, where an invisible row reads as absent. The
drift guard cannot see a column with no reference, so `composite-fk.contract.test.ts`
asserts both replacements live instead, and asserts the absence itself — this is the one
table in `crm.*` with no foreign key at all, which is a choice rather than an oversight.

**The pre-flight those migrations open with has now been seen to work.** A composite key's
bulk `VALIDATE` is an ordinary query, so as `crm_app` with no tenant context it validates
against **zero visible rows** and marks itself valid over a table holding a violation. The
only thing standing between that and a silently-wrong constraint is a `DO` block that asks
the question from inside each registered tenant — and it enumerates `crm.tenant`, which
neither of this repo's setup paths populates, so on every run until now it looped zero times,
applied cleanly, and proved nothing. `scripts/verify-migration-runner.sh` now builds a
database that really leaks: migrations up to 0034, two registered tenants, and the leak this
schema actually shipped once — a tenant-B `rep_role` naming a tenant-A profile through
`granted_by`, which was single-column until 0035 converted it. It asserts the row is visible
inside tenant B and invisible without a context (the pre-flight's whole premise), that the
migration then **refuses** and names the table, the column and the tenant, and — the control
that matters — that the same database migrates all the way once the leak is removed.

## The snapshot refresh tells you when it could not be incremental

`snapshot_incremental` cannot be incremental against `pack-erp-core`, and until recently
nothing said so. **0 of 51 served entities publish `updated_at` as a filterable field**, so
`since` bounds nothing and every pass is a full read of every record — while the one
human-visible log line said `mode=incremental`, because that is what was *asked for*.

The degradation is now carried on the result and named per snapshot in the job's summary:

```
snapshot_incremental  mode=incremental read=4821 upserted=4821 deleted=0 rejected=0
                      UNBOUNDED: product,account published no filterable+sortable
                      updated_at, so `since` bounded nothing and each was read in full;
                      their high-water marks were NOT advanced
```

**And the high-water mark is deliberately not advanced from such a pass** — which matters
more than the log line. A full read walks pages of a view the ERP did not sort (34 of 51
entities publish no sortable field at all), so a keyset walk over it can revisit and skip
rows. The maximum `updated_at` over what was read can therefore sit *above* the newest
record actually stored, and resuming from it would skip the ones that were missed. A
watermark is a promise that everything older is accounted for; an unordered read cannot
make that promise, so none is recorded.

The suite had been asserting the opposite against a fixture more capable than the real
server: `erpServing`'s handler honoured `updated_at[gte]` while serving the captured
schema, which declares it unfilterable — so "resumes incrementally from the stored
high-water mark" passed against a server that cannot exist. The incremental path is now
exercised against an explicitly **augmented** schema, named as not the ERP's, and the real
one gets its own test asserting the degradation. That is the third time this repo has been
bitten by a fixture that was kinder than reality.

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

## When the ERP deletes a tenant, this CRM stops

CrossEngin can now really delete a tenant. Its ADR-0316 to ADR-0320 give a tenant serving
its own activated manifest a Postgres schema of its own, drop that schema on a GDPR
Article 17 deletion, and compose a tombstone from per-subsystem attestations anchored in the
forensic chain — all in one transaction. ADR-0316 says what it was closing: the flow used to
issue a signed `TombstoneRecord` while "every row of the tenant's actual business data
survived", so the tombstone "was not incomplete. It was false, and it was cryptographically
signed."

The CRM holds that tenant's product, rep, account and warehouse snapshots, its queued ERP writes, its
expense claims with their ledger account codes, its notifications and its attachments.
Nothing listened. So the ERP's proof became true about the ERP and false about a system
holding copies of the same personal data — the same defect, one system over, and not one the
ERP can close for us.

**The signal is an affirmative read, never an inference.** `tenant_deletion_watch` (daily)
asks `GET /v1/platform/tenants/{id}/tombstones` and gets one of exactly three answers:

| Verdict | What the ERP said |
|---|---|
| `deleted` | a `tenant_deletion` tombstone naming this tenant — the only thing that stops anything |
| `live` | 200, and no such tombstone. An **affirmative** not-deleted |
| `unknown` | anything else — 403, 404, 503, a timeout, a body we could not parse |

Nothing ever concludes a deletion from an empty entity list, a 401, a timeout, or the
tenant's schema having vanished. The inverse matters as much: an `unknown` is not a quiet
pass. A deployment whose role was never added to the ERP's `--tenant-tombstone-read-role`
gets 403 forever, and a signal that silently never fires is worse than no signal because the
deployment believes it is watching — so every check is recorded in
`crm.tenant_deletion_check` **with its reason**, and the ERP's own 503 says in as many words
"do not treat this as an absence".

**The kind filter is the sharpest line in it.** That route returns both kinds the ERP
stores, and a `data_subject_erasure` tombstone is *one person* exercising Article 17 inside a
tenant that is otherwise entirely alive. Reacting to whatever is in the list would take a
working tenant's whole field force offline the first time an employee asked to be forgotten.
So the classifier filters on kind, and a CHECK on the receipt column refuses the wrong kind
as a second layer — because a rule that lives only in the code that happens to call it is one
refactor from gone.

**Stopping is one word, in the one place that matters.** A confirmed tombstone marks
`crm.tenant.status = 'erp_deleted'`, and the scheduler's `WHERE status = 'active'` is the
single point where it decides whose work to do — so the mark removes the tenant from the ERP
relay, both snapshots, the expiry sweep, notification dispatch and pruning, and the expense
posting, at once rather than in seven places that each remember to ask. The API refuses too,
in `resolvePrincipal`, which every route passes through: `403 tenant-deleted`, its own
problem type rather than a bare `forbidden`, because an offline client holding unsent visits
needs to stop retrying rather than spin on what it reads as transient permissions.

The status cannot be typed without the receipt — a CHECK pairs them, so no `psql` prompt can
quarantine a tenant's field force with one word — and once set it is terminal, with the
evidence write-once. Reinstating a tenant is deliberately a migration, as 0044's lifecycle
escape hatch is.

**And the registry row cannot be deleted, which it could until 0053.** That terminal trigger
was `BEFORE UPDATE`, so a single `DELETE FROM crm.tenant WHERE …` succeeded as `crm_app` and
did three things, all measured before the fix was written: the API **served the tenant again**
(an unlisted tenant is served by design — the fail-open argued above, which is what makes
removing the row an *un-stop* rather than a nuisance); the 0052 erasure receipt was
**orphaned**, since its trigger checks the registry at INSERT and nothing after; and
`TRUNCATE crm.tenant` did it to **every tenant at once**, because a statement-level truncation
fires no row trigger. One statement undid 0050, 0051 and 0052 together.

Three layers, because the three holes are genuinely different and any one left open re-opens
the bypass: the trigger now fires on `DELETE` too (a live tenant's row stays deletable — this
is not a blanket append-only); a `BEFORE TRUNCATE` statement trigger refuses truncation
outright; and `crm.tenant_tombstone.tenant_id` now **references the registry** with
`ON DELETE RESTRICT` — the first foreign key into `crm.tenant` in this schema's history, which
makes the receipt pin the row structurally rather than by trigger. `RESTRICT` and not
`CASCADE`: cascade would make the delete succeed and take the receipts with it, which is the
same bypass with extra steps.

The trigger is the layer doing the work today. The key only pins a tenant that has been
*erased*; the trigger pins one that has been *stopped*, which is every deleted tenant from the
moment the watcher sees the tombstone until somebody runs the erasure — a window that stays
open while the twenty-one undecided dispositions stay undecided.

**It does not erase anything, and that is a decision rather than an omission.** Some of the
CRM's copies may be records a jurisdiction requires us to keep; a deletion that destroys an
expense claim is as wrong as one that keeps everything. Keeping-while-stopped is the half
that is defensible today. The vocabulary for the other half is below.

## What happens to each table, and who decided

**21 of this CRM's 44 tenant-scoped tables have no answer yet, and that is now a fact you can
read rather than a gap nobody mentioned.** Migration 0051 adds `crm.data_disposition`: one row
per tenant-scoped table saying `erase`, `retain` with a lawful basis, or `undecided` with the
question somebody has to answer.

The rule it is built on is CrossEngin's, copied word for word from its ADR-0317:

> Silence is not "none". A subsystem in scope must say what it destroyed, say it found
> nothing, or say it is lawfully keeping it. An absent attestation refuses the tombstone.

That ADR is also exact about why, and it is not what anyone would guess: *"The thing that made
the first tombstone false was not a wrong number — every number in it was whatever the author
typed. It was a subsystem **nobody asked**, whose silence read as nothing to delete."* And on
the cryptography: *"A proof over a scope assembled from nothing is a correct proof of a false
claim."*

So completeness is the only property that matters here, and it is derived from `pg_catalog`
rather than from a list: `crm.undeclared_tenant_tables()` must be empty, the migration refuses
to apply if it is not, and a test fails on the day a new tenant-scoped table arrives without a
decision. **`undecided` is a first-class value** for the same reason — a table with no row is
silence and refuses with "nobody looked at this", where a table marked `undecided` refuses
with the *question*, which is the difference between a bug and an agenda item.

**The obligation codes are the ERP's own spellings**, for the five that overlap:
`tax_records_7y`, `medical_records_10y`, `audit_logs_3y`, `financial_transactions_7y`,
`anti_money_laundering_5y`, and `none`. A deletion recorded on both sides of the boundary
should read as one record rather than two dialects — and because a vocabulary copied by hand
is one that drifts, `verify-live-erp.sh` greps the ERP's own source and fails if a code has
been renamed on either side. Two codes are ours: `deletion_evidence` (the receipt — destroying
the proof of a deletion defeats it) and `drug_sample_custody`, which deliberately carries **no
period** where every ERP code does, because how long a pharma company must keep sample-custody
records is jurisdictional and a number in the code name would make every other deployment
either wrong or forced to misuse it. The period lives in the row's note.

```
crm-erasure plan <tenant-uuid>   what would happen to that tenant's rows
crm-erasure questions            the 19 tables nobody has decided about, with the question
crm-erasure obligations          the vocabulary
```

**A CLI and not a route**, because of a tension 0050 created on purpose: once a tenant is
`erp_deleted` the API refuses every request for it, so the tenant's own API is exactly the
surface that cannot answer questions about its data. That is correct, and it makes this a
platform-operator act in the shape `crm-service-key` already established.

**`plan` produces a plan and never a tombstone.** It refuses on four grounds — the tenant is
not stopped (so the plan is advisory and authorises nothing), a table is undeclared, a table
is declared undecided, or the register names a table that no longer exists — and it exits 1
while any of them hold, so an operator scripting it gets "is this ready" from the exit code.
Row counts are taken in **one** query, because thirty-nine separate counts are thirty-nine
moments and the figures are what a tombstone will eventually commit to by hash. Undecided
tables are deliberately **not** counted: putting "crm.visit: 4,312 rows" in front of somebody
invites the decision this register exists to collect from a lawyer.

The three retained today are `expense_claim` (`financial_transactions_7y` — the case 0050's
header named), and `tenant` plus `tenant_deletion_check`, both `deletion_evidence`, because
erasing them would destroy the only CRM-side proof that the deletion was observed and acted
on. Everything decided as `erase` is either a copy whose source of truth the ERP has already
destroyed, this deployment's own operational state, or a credential.

**No `anonymise` disposition**, and that is a reversal worth stating: the follow-up this
closes named three options, and writing it turned up that no table in this schema wants the
third. A visit naming a doctor is the plausible candidate and it is `undecided`, so choosing
anonymisation for it now would pre-empt the decision the register exists to collect. A
disposition with no row using it and no code implementing it is the "built and unreachable"
this repository keeps finding.

## The erasure, and the receipt that proves it happened

`crm-erasure execute` is **the only thing in this repository that destroys data on purpose**,
and it does the destroying and the proving in **one transaction**. That is ADR-0319's property
and there is no two-step version: a deletion that commits without its proof is unprovable, a
proof that commits without its deletion is false, and no ordering of two transactions avoids
both.

Per table, the receipt says one of exactly three things — ADR-0317's outcomes, with its rule
about which may carry figures:

| Outcome | Means | Carries |
|---|---|---|
| `erased` | rows were destroyed | a count, ≥ 1 |
| `nothing_to_erase` | asked, held nothing | no figures at all |
| `retained` | lawfully kept | a count, an obligation, a note and where it still is |

A `retain` disposition over an **empty** table attests `nothing_to_erase`, not `retained`: the
outcome describes what was found and done, not what the register decided, and "we are lawfully
keeping it" about zero rows reads as evidence and is not.

**Assembly refuses when a table in scope has not attested.** That is the rule the hashes are
worth anything because of. Two hashes: a content manifest over the attestation list, and a
proof over that manifest plus the tenant, the ERP tombstone, the timestamp and both people.
Both are **domain-tagged**, and neither uses `JSON.stringify` — its output depends on property
insertion order, so the same list rebuilt by a later reader could fail to verify. Fields are
written in a fixed order with absent values marked rather than omitted, because omitting them
lets `obligation=null, note="x"` and `obligation="x", note=null` collide.

**Four-eyes, in three places:** the CLI refuses equal `--executed-by`/`--approved-by`,
`assembleTombstone` refuses it, and a CHECK on the table refuses it. Plus
`--yes-destroy-data`, typed out.

**Two guards the foreign-key graph makes mandatory**, and both were found by looking at the
graph rather than reasoning about it:

- **A retained table may not reference an erased one.** For a `RESTRICT` edge the delete would
  be refused — loud, and the transaction rolls back. For a **`CASCADE`** edge it would *destroy
  the retained child*, silently, with no attestation, inside a transaction that then commits a
  signed proof saying those rows were kept. `visit_product → visit` and
  `call_plan_product → call_plan` are both `CASCADE`, so this is the first mistake a
  half-answered register will produce, not a hypothetical.
- **Children are deleted before parents**, computed from the catalog because `rep_profile` is
  the parent of eleven tables. Explicitly, even where a cascade would do it — not for the
  delete's correctness but for the **figures'**: a child removed by its parent's cascade
  reports zero rows erased while its rows are gone, and that zero goes into a hash.

The receipt is **append-only** on both tables, with no exception at all — unlike
`crm.rep_role`, which permits exactly one update because a grant may be revoked. A tombstone
has no second state: its hashes commit to its own contents, so an UPDATE would either break
the proof or, worse because it looks fine, be accompanied by a recomputed hash and produce a
consistent receipt for a claim nobody made. And a receipt may only exist for a tenant the ERP
deleted, citing *that tenant's* ERP tombstone — so a CRM tombstone implies a stopped tenant
implies an ERP tombstone, three facts each refusing to exist without the one behind it.

Ours are `crmtomb_…` where the ERP's are `tomb_…`, deliberately: they are different claims by
different controllers about different data, and the one thing they must never do is look
alike.

**A receipt is not in its own scope**, which it was until 0054. The first version attested
`nothing_to_erase` about `crm.tenant_tombstone` — from inside the transaction that writes a row
into it. The statement was false by the time it committed, and the content hash committed to
it. Run the erasure twice and that table attested `retained, 1`, counting the first receipt,
and was wrong the moment it landed because there were then two. Two signed receipts about one
tenant, disagreeing about one table, for purely structural reasons. Both measured.

The fix is not a new disposition — `retain` under `deletion_evidence` is right for those
tables. It is the **scope**: `is_receipt_store` marks them in the register, and a receipt
neither counts them nor speaks about them. The ERP's own six subsystems do not include its
tombstone store either, so excluding ours is faithful to the mirror. A receipt store also
cannot be dispositioned `erase`, by CHECK: an erasure would destroy the proof of itself, and
that one is arithmetic rather than a jurisdictional judgement a deployment may amend.

**The exclusion is declared on the receipt and inside its hash** — 0051's insight one level in:
a declared "we are deliberately silent about this" is not silence. Without it a reader
comparing 41 register rows to 39 attestations finds a discrepancy with no explanation, and
"the hash covers everything except two things you have to work out" is not a property anybody
can check. The list is sorted and de-duplicated, by CHECK, because a hash over a list whose
order varies is a hash nobody can recompute.

**And the manifest format is versioned, stored and verified by.** Adding the exclusion list
changed the format, and a receipt whose stored hash no longer recomputes is indistinguishable
from a tampered one — so `manifest_version` is written with each receipt, `v1` receipts stay
verifiable forever under the rules they were made with, and the version is inside the hashed
bytes as well as beside them so rewriting the column cannot make a v1 digest verify as v2.
No backfill and no re-signing: re-hashing a stored receipt under a new format would produce one
that verifies and was never signed by the people it names, which is the forgery this whole
subsystem exists to make impossible. A migration is not an exception to that.

## Verified against a running ERP

```bash
PGUSER=… PGHOST=… ./scripts/verify-live-erp.sh
```

Boots a real `operate-server` over a real Postgres, points it at the CRM's own JWKS, and
runs **133 checks**: 90 through the shipped `dist` of `@crm/acl`, `@crm/credential` and
`@crm/relay` as a library, and 43 through the CRM's own `api` and `scheduler` **binaries**,
started as processes exactly as `deploy/docker-compose.yml` starts them. It also syncs the
ERP's warehouses into `crm.warehouse_snapshot` with the shipped `SnapshotRefresher` before
any rep records a receipt — because since 0058 a receipt naming a depot the ERP does not
have is refused at the point of entry, which the gate measures in both directions. The CRM's own
database is dropped and rebuilt from empty each run — it used to
be required to exist already, which made the gate's schema whatever was lying around, and
that is how a check came to fail with `column "seq" does not exist` against a database three
migrations behind. Everything the integration assumes had previously been read out of the ERP's
source and a captured schema; this is the first time a socket answered. The gate
fingerprints every file in the ERP checkout before the run and diffs after — that repo is
read-only this phase and the check proves it.

What it pins, beyond the handshake: all 51 declared slugs route and the naive pluraliser
really is naive (`/v1/opportunitys` serves, `/v1/opportunities` 404s); an unknown filter is
**silently ignored** and a non-sortable sort **silently falls back**, each with a control
proving the test could have failed; `baseline.json` is byte-identical to the live schema;
numeric filters are wrong and ISO dates are the exemption; keyset pagination is complete and
non-repeating; and a full outbox round trip — create, transition, replay, out-of-order.

**Three things we believed turned out to be false**, and they are the reason this gate
exists:

- A duplicate record id does **not** answer 409. It answers `500 write_failed` carrying
  node-postgres's message, so the replay-as-success guarantee rests on the ERP leaking that
  string to clients. Pinned in both directions; in the ADR's open table as a decision.
- The ERP's JWT-vs-header tenant cross-check only fires **when the token carries a usable
  tenant claim**. Our minter's UUID check is what makes that condition hold, which promotes
  it from tidiness to a security control.
- A 422 carries its cause in `fields`, with **no `detail`** — so a rejected write
  dead-lettered with `dead_reason = "validation_failed: write guard refused"` and nothing an
  operator could act on. Invisible offline because every fixture supplied a `detail` the
  real server never sends. Fixed; the reason now names the field.

A fourth, found later and in the same class: **a revived write re-asked under the key the
gateway had already answered.** The in-memory idempotency store keeps a reply's status
without its body, so a replayed 422 came back bodiless and the death history recorded
`rejected: unrecognised_error_shape` where the first episode had the ERP's own sentence — the
operator who pressed retry was told *less* than before they pressed it, and the history
called an identical cause a new one. The `Idempotency-Key` is now per dispatch episode,
`crm-<row id>-r<revive count>`. No offline test could have caught it: the fake ERP answers
every request it is given and has no memory to replay from.

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

**A migration that cannot succeed used to block its own repair, and no longer does.** The
runner halts on the first failure and records nothing, so a database stuck on a defective
file retried it on every deploy and every migration after it — including the one written to
fix that state — was unreachable forever. `0032_prune_floor_cap.sql` was that file: its
clamp is DML on an RLS-FORCEd table with no tenant context, so it updates zero rows, and the
validated `CHECK` two statements later is not blind and refuses. A later migration can now
retire it:

```sql
-- @supersedes: 0032_prune_floor_cap.sql
```

The named file is **recorded without being run** — with its real hash, so editing an applied
migration is refused exactly as before, and a database that *did* run it is untouched. The
declaration lives in the file rather than in a deploy-script list, for the same reason
`@requires: dba` does, and it is validated: a name matching no migration, or one that does
not sort before the declaring file, is refused by `apply` and by `--dry-run`.
`scripts/setup-test-db.sh` honours it too, with a pattern anchored at both ends so a header
that merely *quotes* the syntax — which these headers do to each other constantly — cannot
silently retire a live file there and not in production.

**The warning is printed once, on the deploy that records it, and not again.** Afterwards
the file is an ordinary ledger row and both commands fall silent about it; `--dry-run`
reports it as `would_record_without_running` only while it is still pending. So the only way
to learn that a file in the repository was never executed on an existing database is to read
`crm._migrations` against the directory — which is what `pnpm db:migrate:verify`'s sixth
property does, asserting the record, the matching hash, and the absence of an `applied` line
for it.

```bash
pnpm db:migrate:dry      # what a real run would do; exit 1 if an applied file was edited
pnpm db:migrate          # apply
pnpm db:migrate:verify   # the five properties above, against a throwaway database
```

**Two long-running processes, as on the ERP side.** The API is stateless and scales
freely. The scheduler is multi-instance-safe but one is enough. **It needs a signing key in
production, and with one it works** — this paragraph used to say it "currently refuses to
start, because its ERP credential is not built", which was false and is the kind of false
sentence an operator acts on by not deploying: with `CRM_SIGNING_KEY_FILE` set it boots,
mints short-lived per-tenant Ed25519 service JWTs under the role in
`crm.erp_service_principal`, and drains the outbox — verified against a running
`operate-server` (`docs/LIVE_ERP_VERIFICATION.md` §7). With only `ERP_TOKEN` under
`NODE_ENV=production` it still refuses, deliberately: a static shared secret holding
whatever role the ERP bound it to, on every tenant, is worse than no relay. The outbox is
durable, so queued writes wait rather than being lost.

The container plumbing in `deploy/` **has now been built and run**, and that sentence cost
six weeks to be able to write. It used to say the stack had "not been built or run — the
environment it was authored in has no Docker daemon", and the second half was never
checked: `dockerd` starts in that container, nobody had tried, and the image did not
build. Four independent reasons, each fatal — a manifest layer naming 8 of 16 workspace
packages, an unbuilt `@crm/erasure`, a `pnpm prune --prod` that cannot run without a TTY,
and the same prune emptying every workspace link so the api could not have loaded a single
handler. Every one of them was invisible to reading the file, and to a laptop build, which
inherited the host's own `dist/` because there was no `.dockerignore`.

What runs now, on every push (`pnpm deploy:smoke`, and `deploy-stack` in CI): the image
builds from a clean context; `migrate` refuses a database with no ERP in it, naming the
cause; all 54 migrations apply and a second run is a no-op; the api comes up healthy as
`crm_app`; `/healthz`, the JWKS fail-closed rule and the 401 problem documents answer
correctly; and the scheduler refuses to start without an ERP credential, starts with one,
and signs with exactly the key the api publishes out of the database. `pnpm deploy:image`
replays the same build without a daemon in about thirty seconds.

CI's run on the commit that landed this answered `ok: caddy serves the api over TLS` as
well, on a build of `deploy/Dockerfile` with no deviations — so the edge is exercised too.
Still unexercised: ACME issuance (`DOMAIN=localhost` means Caddy's internal CA, so the
first real deploy is the first real certificate), a real OIDC issuer, and the ERP itself.

**And checking the claim above found CI itself had been red the whole time**, in a
different job, for a reason that has nothing to do with the image: `appPool()` connects as
`crm_app` on purpose, `0001` creates that role without a password, and the official
postgres image requires `scram-sha-256` over TCP — which is how CI connects and a local
socket is not. 32 of 82 test files failed there and **1,073 of 2,117 tests never ran**,
against a tree that is 82/82 green locally. The failure did not look like 1,073 missing
tests: vitest skips the rest of a file after its `beforeAll` fails, and a skipped contract
test reads like a passing one. CI now sets `PGAPPPASSWORD`, and
`scripts/setup-test-db.sh` opens the suite's own connection to prove it works before
declaring the database ready — because a test database the suite cannot authenticate to
does not fail, it hollows out.

That was not the whole of it. With the password fixed the job was still red, and the
failure reproduced nowhere locally — nor could the log be read: every job with a service
container ends by dumping that container's entire log, and `postgres:16` under this suite
writes ~90 KB of expected negative-test errors. The Test step now re-emits its failures as
workflow annotations, which cannot be buried, and the next run named the cause in one
line: `spawnSync rg ENOENT`. Two coverage suites shelled out to **ripgrep**, which a
GitHub runner does not have. `grepRepo` in `packages/db/src/testing.ts` is now the same
scan in Node, and it throws when it matches nothing — because `rg` exited 1 and failed the
test, while returning `[]` would hand a coverage suite an empty producer set and let it
pass vacuously. **83 files / 2,123 tests green on both transports.**

## The app

`apps/field` is the client, and it is a slice rather than the product: **sign in, see my
accounts, record a visit with no network, disburse samples with a signature on glass, hand
material to a colleague and accept theirs, count the bag, write off what has expired, send
stock back to a depot, read the SOP parameters you are measured against — and change them, if
you hold the compliance grant — watch all of it sync, read a refusal.** Roughly 70 of the 106
routes still have no screen — call plans, expenses, notifications, the manager's views, all
of admin.

What it settles is the part that was a guess. Everything built for an offline device —
ids minted before a network exists (0012), `POST /v1/sync/visits` answering per row, the
upsert that makes a replay idempotent, `tenant_deleted` carrying its own problem type so a
queue knows to stop rather than spin — had never been consumed by anything. It is now,
and `pnpm client:verify` proves it the only way that means anything: **248 checks in four
real Chromium profiles — four devices, two reps — taken offline mid-session, against the
real API binary, counting rows in Postgres.** The sequence it drives:

- a visit recorded with the network down lands in IndexedDB, pending, with a device-minted
  v7 id — and **nothing** in `crm.visit`;
- syncing while still offline keeps it and says so;
- the signal returns, the row lands **once**, and its primary key is the id the device
  minted;
- re-sending the same body is accepted again and there is still one row;
- three visits across a round with no signal go up in one batch;
- a visit for an account outside the rep's territory comes back refused, stays on screen
  with the server's own sentence, and is deleted by nobody but a person;
- the app **opens with no network at all**, served by its own service worker, saying how
  stale its cached accounts are rather than implying they are live;
- a disbursement with **no signature is refused at the keyboard**, because the ledger row
  commits to one;
- a stroke **drawn on the canvas with real pointer input** becomes 11 KB of PNG, and the
  disbursement and its signature queue as two rows in a fixed order — the signature held
  back until its disbursement has landed, since the upload route 404s until then;
- both go up on one reconnection, and in SQL `a.content_sha256 = t.signature_sha256`: the
  ledger committed to that digest before the image existed anywhere but a canvas;
- the lot's balance falls from `10.000` to `8.000` by the ledger's own trigger;
- a lot is **handed to a colleague with no signal**: the quantity leaves the balance and
  appears in transit the moment it is queued, cancelling before it is sent puts it straight
  back and writes **nothing** to the ledger, and a transfer of more than the rep carries is
  refused at the keyboard rather than hours later from inside a queue;
- the colleague's **own device** (a second browser profile — separate IndexedDB, separate
  `localStorage`) is shown `3.000 × LOT-FIELD-1 from Ada Lovelace` with the item and the
  expiry, accepts it offline, and syncs: `transfer_in` linked to the `transfer_out`, the
  receiver holding `3.000`, the sender's in-transit clear, and the two balances still
  summing to what was there before;
- the sender takes back a transfer nobody accepted, and the recall is a **new movement**:
  both halves of the round trip stay in the log;
- a **count of the whole bag** is taken with no signal and lands as one document — the
  count, a line per lot, then the commit, in that order, with the commit waiting for every
  line: a commit that went early would write adjustments for the lots that arrived and
  leave the rest unreconciled. Every field starts **empty**, because a form pre-filled with
  the answer is one a tired rep taps through;
- and the count proves the thing the second expected-quantity column exists for: the rep
  counts `4` where the device shows `5`, a receipt of `2` lands from elsewhere while the
  count sits unsent, and the stored line keeps all three figures — counted `4.000`, held
  `7.000`, device-shown `5.000` — so the reviewer sees both the variance against the books
  (`-3.000`) and the one the counter could actually see (`-1.000`). One adjustment of
  `3.000`, linked to the count by a column rather than by prose, and the balance ends at
  exactly what was counted;
- **expired stock leaves custody** with a reason attached. The gate holds expired material
  the only honest way there is — received twenty days ago, fifteen days before the lot
  expired, since a receipt of expired stock is refused with a 409 — lets the **real** nightly
  sweep raise the disposal obligation, disposes of it offline, and then runs the sweep
  **three days late**: the obligation closes as `written_off`, attributed from the ledger,
  and dated **the day the material actually left**. It used to be dated the day the sweep
  noticed, which is the difference between four days early and two days overdue in the one
  field an audit of lateness reads;
- and **a refusal no longer wipes what the rep typed**. Every refusal goes through a render
  that replaces the DOM, so "you are carrying 6, so 99 cannot be written off" used to arrive
  with the reason field blank — on a count form, a number per lot and the note with it;
- **stock goes back to a depot off the ERP's own list** — the one write here the ERP has to
  be told about, since the material re-enters its books. The destination used to be **shown,
  not offered**: with no warehouse list, the only id a device could name without inventing
  one was the depot the lot was received from, so material that arrived by TRANSFER had no
  destination at all and the device offered only a write-off — destroying stock a depot could
  have put back on a shelf. `crm.warehouse_snapshot` (0058) closed that: the open depots are
  offered, the lot's own origin is pre-selected where it has one, nothing is pre-selected
  where it does not, and the server checks the pick against the same list — so a depot that
  does not exist is refused at the keyboard rather than by a dead letter days later. The gate
  proves the case that was impossible: the rep who received her stock from a colleague, with
  no receipt of her own, sends it back to a depot she picked. Each return leaves one
  `StockMovement` for the ERP, and when the gate plays the relay's verdict and kills one, the
  screen names it in the ERP's own words with a retry — because a return the ERP never hears
  about leaves a depot short in its own books while the CRM's record is perfectly correct;
- **the rule everybody is measured against is on the screen, with who set it** — the first
  administrative surface in this app and the first consumer of `GET /v1/me/roles`, a route
  that has carried "so a client can decide which admin screens to show" in its own comment
  since 0023 with nobody reading it. Every rep sees the grace period, the promo switch, and
  the provenance; the holder of the `compliance` grant also gets a form, which cannot be
  submitted without a reason and is **not queued** — a policy change is a decision about a
  tenant-wide rule taken at a desk, not a record of something that happened in a car park,
  and a queued one would take effect whenever a phone next found signal and overwrite a
  colleague's. A rep with no grant is offered nothing and is refused 403 if the screen is
  bypassed;
- a **shared device** refuses to file one rep's work under another's. A rep signing in with
  no network is not handed the previous rep's identity from the cache, and a queue holding
  somebody else's unsent record says so instead of sending it;
- the signal returns **while the signature is being drawn** and the stroke is still there
  afterwards — the same 1,473 dark pixels. `render()` replaces the DOM from thirty-one
  call sites and three of them fire untouched (`online`, `offline`, returning to a
  backgrounded tab), so the canvas, the one part of this app whose content lives only in
  the DOM, used to be wiped mid-signature with no message. It carries its pixels across a
  render now, with `putImageData` rather than a redrawn data URL, because an asynchronous
  restore leaves a pad that is not empty while it is still blank — and the next render
  snapshots the blank;
- and when the ERP deletes the tenant — a tombstone recorded against the registry row,
  which `tenant_erp_deleted_needs_receipt` makes the only way to reach that status — the
  app **stops**, says why in the server's words, holds the queue, disables Sync now, and
  deletes nothing. That chain runs from the ERP's signature to a rep's screen for the
  first time.

Two layers, split the way the rest of this repo splits: `@crm/client` is pure — schemas,
the outbox state machine, the backoff, and `classifyRowOutcome`, which maps every problem
kind the API can answer with onto `retry`, `permanent`, `reauthenticate` or `stop` — and
`apps/field` is the impure sibling that owns IndexedDB, `fetch`, PKCE, the canvas and the
DOM. 158 tests cover the protocol without a browser; the browser run covers what they
cannot.

**The outbox has kinds and dependencies**, because a signature forced it to. A
disbursement's ledger row commits to the digest of the signature, and the image uploads
separately to a route that 404s until that row exists — so the queue drains visits, then
disbursements, then signatures, and a signature is only due once its disbursement has left
the queue. "Left the queue" is the test, not a flag: the queue is the device's whole memory
of what is unsent, so absence is acceptance, and that survives a restart. A dependent whose
prerequisite was refused is refused in the same pass, carrying the parent's own sentence —
otherwise it waits forever behind something that will never land, counted as "waiting to
send" on a screen telling a rep their day has not gone in.

**No framework.** The bundle is zod and the app, for the reason the rest of this repo has
no runtime dependencies: a rep's phone on rural 3G should not download a framework to show
eight accounts and a form.

**One origin.** Caddy serves the app and proxies `/v1` to the API, so the browser never
makes a cross-origin request — which is why neither side has a line of CORS, and why
putting the app on a second host would need one. Which paths belong to the API is declared
once, in `@crm/client`'s `isApiPath`, and used by the service worker and the test harness's
server; the Caddyfile cannot import it, so a test parses its `@api path` matcher and
compares the two.

**The app is ~25 KB gzipped**, all in: 23.4 KB of bundle (most of it zod, which earns its
place by validating every response at the boundary), 1.2 KB of CSS, a 0.6 KB service
worker and 0.5 KB of HTML.

**The paste-a-token login is compiled out of a production bundle**, not disabled by a flag:
`NODE_ENV=production` removes the branch at build time, and `verify-image-build.sh` greps
the built file to prove it. The same rule the scheduler applies to `ERP_TOKEN`, applied
where a mis-copied config file cannot undo it.

Still open: the IdP itself (Security's row in ADR-0001 — the harness signs with a stand-in),
Capacitor packaging, iOS Safari, push instead of polling, and a generated client so the
schemas cannot drift from the server's.

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

**And it refuses a connection that is already inside a transaction**, which is the fourth
fail-closed check and the one found by a test that *passed*. The wrapper issues `BEGIN` and
`COMMIT`; Postgres makes a nested `BEGIN` a no-op with `WARNING 25001`, so the `COMMIT`
ended the **caller's** transaction and their later `ROLLBACK` undid nothing. Migration
0051's contract suite wrapped its mutations in a transaction for isolation, and that
rollback silently committed instead — redeciding nineteen retention dispositions for every
test that ran afterwards, while the suite stayed green because the tests that would have
noticed ran earlier.

It asks node-postgres's `getTransactionStatus()` (`I` idle, `T` in a transaction, `E`
failed), before issuing any statement — including the catalog read for the role check,
because a connection in a failed transaction answers every query with the failure, and the
remedy you need to hear is "roll back", not "your role might bypass RLS". A client that
cannot be asked at all is a hand-written fake with no backend and no transaction to clobber,
so it proceeds; the unit-test fakes answer the question anyway, which is what gives the
guard coverage there as well as live.

**It refuses rather than nesting with a `SAVEPOINT`**, and that is the design decision. The
tenant GUC is set with `is_local = true`, so it lives for the *transaction* — nested, it
would still be set after the inner block returned, and every later statement the caller
believed was unscoped would be silently confined to that tenant, or on a write attributed to
it. Wrong rows instead of a wrong commit. And the guarantee would change meaning: callers
read this function as "my work committed under this tenant's RLS", where nested it could
only promise "staged in somebody else's transaction, which may yet roll it back".

The uncomfortable part is that the mechanism was already written down here.
`ClientAlreadyInTenantContextError` in the expense sweeper describes it exactly — "Postgres
answers a nested `BEGIN` with a warning and the first `COMMIT` would end the caller's
transaction" — and has since that sweep was built. It guarded one caller. The function that
issues the `BEGIN` and the `COMMIT` had no guard at all. Both stay: the sweeper asks whether
`app.current_tenant_id` is set, which is a proxy for "inside a `withTenantContext`
transaction" and answers before any work with a better-aimed sentence; this asks the backend
whether there is *any* open transaction, which catches a caller's own `BEGIN` that no GUC
reveals.

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

Money stays a **string** all the way from the ERP into `NUMERIC`. A value that will not
coerce rejects the record by name — it is never nulled, because a null price makes a product
look free.

**This rule is about the INBOUND direction only, and it was applied outbound twice.** Coming
from the ERP the destination is a `NUMERIC` column of arbitrary precision, so there is
nothing to gain by converting and a wide enough price to lose. Going the other way the
destination is a field the ERP's own schema calls a `decimal`, and
`operate-runtime/src/validation.ts` validates one with `Number(value)` and then stores what it
was **sent**, uncoerced — so the CRM's strings sat in the ERP's numeric fields, correct only
while that validator kept accepting them. `erpDecimal` sends a number and refuses what it
cannot name: `JSON.stringify` writes the shortest decimal that parses back to the same
double, so every value within 15 significant digits crosses exactly, and
`crm.sample_transaction.quantity` — `numeric(16,3)` — has a top band that does not, which is
refused rather than rounded. The live gate asserts `typeof` at the ERP's own storage, because
a check that coerced passed just as happily on `"12.000"`.

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
recipient, so an unread badge is a count rather than "the newest N, probably". The ERP had
the same gap when this was written and closed it in its ADR-0309, which also gave it
per-user quiet hours; the rule stays because it is ours and because the reasoning — *what
is new* and *what have you seen* diverge the instant somebody reads one and reloads — is
what the column exists for, not because the other system lacked it.

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
