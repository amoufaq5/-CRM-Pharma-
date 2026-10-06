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
| `GET /v1/samples/obligations/:lotId/history` | the whole continuation chain for one lot, with each link's resolution and the ledger movement that discharged it |
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
| `GET /v1/erp-writes/:id/history` | why it died EACH time, with the shape named: a different cause each attempt, or the same wall twice |
| `GET /v1/admin/erp-writes/deaths` | every recent death in the tenant, orphans included (**administrator**); `?limit=` 1..500 |
| `GET /v1/me/roles` | which administrative roles the caller holds, if any |
| `GET /v1/admin/roles` | the grant log; `?role=`, `?includeEnded=true`, `?on=` |
| `GET /v1/admin/roles/administrators` | who can configure this tenant — readable by every rep |
| `POST /v1/admin/roles` | grant a role (**administrator**); never to oneself |
| `POST /v1/admin/roles/:id/revoke` | end a grant (**administrator**); the grant stays, with an end date |
| `PUT /v1/admin/samples/disposal-policy` | the grace period and the promo switch (**compliance**) |
| `GET\|POST /v1/admin/notification-endpoints` | where signals are pushed (**administrator**) |
| `PATCH /v1/admin/notification-endpoints/:id` | thresholds, or `enabled: false`; there is no DELETE |
| `POST /v1/admin/notification-endpoints/:id/test` | ask the scheduler to probe it; `202`, because it is queued, not answered |
| `GET /v1/admin/notification-endpoints/:id/test` | the verdict the scheduler recorded |
| `GET /v1/admin/notification-endpoints/:id/tests` | the last twenty, newest first |
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

It has **never spoken to a real mail server**: it is verified end to end against a sink
written alongside it, which is faithful to RFC 5321/3207/4616 as far as it goes and is not
Postfix. It does no DKIM signing. Both are in the ADR's open table.

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

`packages/db/src/composite-fk.contract.test.ts` probes all 46 individually, asserting both
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

## Verified against a running ERP

```bash
PGUSER=… PGHOST=… ./scripts/verify-live-erp.sh
```

Boots a real `operate-server` over a real Postgres, points it at the CRM's own JWKS, and
runs **124 checks**: 90 through the shipped `dist` of `@crm/acl`, `@crm/credential` and
`@crm/relay` as a library, and 34 through the CRM's own `api` and `scheduler` **binaries**,
started as processes exactly as `deploy/docker-compose.yml` starts them. The CRM's own
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
