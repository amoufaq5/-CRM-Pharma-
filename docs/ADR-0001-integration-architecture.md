# ADR-0001: CRM ↔ ERP Integration Architecture

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | `docs/ERP_INTEGRATION_REPORT.md`; CrossEngin ADR-0002 (Multi-Tenancy Model, *Proposed*), ADR-0078 (operate-runtime serving), ADR-0279 (tenant-scope audit), ADR-0283 (emitter reconciliation) |

## Context

We are building a pharma field-force CRM. It must integrate with **CrossEngin**
(`../CrossEngin`), an existing AI-native multi-tenant ERP platform: 82 packages, 3 apps,
139 platform Postgres tables, ~239k lines of TypeScript, ~9,285 tests, no CI.

The full survey is in `docs/ERP_INTEGRATION_REPORT.md`. The findings that constrain this
decision:

**What the ERP is genuinely good at.** A hand-written, deterministic Postgres migration
applier. Uniform row-level security (`tenant_id = current_setting('app.current_tenant_id',
true)::UUID`) on every tenant-scoped table, entered through a `withTenantContext`
transaction wrapper. A column-mapped entity store that emits **real typed tables with
composite tenant-scoped foreign keys** — `(tenant_id, <ref>_id) REFERENCES
<target>(tenant_id, id)`, with reference columns deliberately `TEXT` so this type-checks.
A double-entry GL that actually posts: recognition with per-`TaxCode` breakdown, credit
notes, bills, payment application, realised and unrealised FX, period locks, posted-entry
immutability, unbalanced-journal refusal. Document-numbering sequences. A durable
Postgres job queue with claim/lease that is safe across workers. A manifest-compiled REST
surface with keyset pagination, typed filters, trigram search and projection pushdown.
Manifest-driven RBAC with classification-driven, fail-closed response redaction.

**What it cannot do, that a field-force CRM is made of.**

- **No identity.** It verifies Ed25519 JWTs and matches static in-memory API keys. It
  issues no tokens, has no login endpoint, and `meta.users` / `meta.user_tenant_membership`
  are read by exactly one module (notification recipients) — not by authentication.
  There is **no link from any login to an `Employee` record**.
- **No row-level authorisation.** `RbacGrant.abac` is parsed, `rbacCheck` returns
  `requiresAbac`, and **nothing consumes it**. Any `sales_rep` token can list every
  `Lead`, `Account`, `Opportunity` and `Invoice` in the tenant. "My accounts" is
  inexpressible.
- **No outbound events.** `meta.webhook_endpoints` and `meta.webhook_deliveries` are
  fully specified tables with a complete delivery state machine and **no code that writes
  or delivers them**. No broker, no `LISTEN`/`NOTIFY`, no CDC writer.
- **No lot, expiry, serial or custody model**, and **nothing keeps `StockLevel`
  consistent with `StockMovement`** — grep returns zero hits for either outside the pack
  declaration. `Warehouse` has no owner field of any kind.
- **No therapeutic taxonomy.** No ATC, INN, molecule, strength, dosage form, Rx/OTC
  schedule, marketing authorisation or shelf life. One free-text `category`. No pack/UoM
  hierarchy.
- **Contracts without runtimes** for the four things a mobile CRM needs most: `files`
  (attachments), `search`, `pwa` (IndexedDB outbox, background sync, conflict strategies),
  and `i18n`/RTL — `packages/i18n` is complete and consumed by no application;
  `app/layout.tsx` is hard-coded `<html lang="en">` with no `dir`.
- **Idempotency and rate limiting are in-memory in the deployed binary.** Postgres
  implementations exist in `api-gateway-pg`; `apps/operate-server` never wires them.
- **No CI** (`.github/` does not exist), no `/healthz`, no `/metrics`, no tracing
  exporter, and `meta.audit_log` is neither chained nor signed (ADR-0279).

**Two facts that shape the options directly.**

1. The ERP's implemented tenancy is **shared-schema + RLS**, not the schema-per-tenant
   ADR-0002 describes. Its entity tables live in one schema in one database with
   `tenant_id` columns and composite `(tenant_id, id)` primary keys. A second schema in
   the same database can therefore hold **declarable, enforced foreign keys into ERP
   tables**. This is not true of any cross-database arrangement.
2. `resolveRecordId` **accepts a client-supplied `id`** matching `^[A-Za-z0-9_-]{1,200}$`,
   and every entity is unique on `(tenant_id, entity, record_id)` (JSONB store) or
   `(tenant_id, id)` (column store). Deterministic client-minted ids give us idempotent
   writes that do not depend on the ERP's broken idempotency store.

**And one fact that qualifies the first.** Fact 1 describes the **column store**
(`--store pg-columns`). **Every deployment artifact in the repo runs `--store pg` — the
JSONB store** — where all records of all entities of all tenants live in one
`meta.operate_entity_records` table with the business data in an untyped `document JSONB`
column. There are no per-entity tables and therefore nothing to point a foreign key at.
`deploy/docker-compose.yml` and `deploy/docker-compose.ai.yml` pass `--store pg` as
hardcoded list items with no env override; `deploy/VERCEL-SUPABASE.md` documents the same;
the dev script and the CLI both default to `memory`. Nothing deploys `pg-columns`.

Worse, `pg-columns` is not merely unused, it is **new**: ADR-0283 (2026-08-26, Accepted,
the second-newest ADR in the repo) records that `pack-erp-core` **booted on `pg-columns`
for the first time** in that change — before it, the flagship pack died at startup on
`gin_trgm_ops does not accept data type character` (a `country_code` → `CHAR(2)` field),
and any manifest that gained a field bricked the server on restart. The column store is
days old in usable form, has never been deployed, and has no CI behind it.

This does not change the recommendation, but it changes what the recommendation is
*conditional on*, and it is now the first thing to resolve. See R17/R18 in the report.

**The stated prior.** The CRM is a system of engagement with a very different write
pattern from the ERP — high-frequency, mobile-originated, offline-tolerant, mostly its own
data — but it must never hold a second copy of the truth for employees, products, or
money. Option (b) is the presumed answer. The instruction was to argue against it if the
code says otherwise. **The code does not say otherwise. It says (b), more strongly than
expected.** But it also says (b) is not sufficient on its own, and the reasons matter more
than the label.

## Decision

**Adopt option (b): a separate CRM service with its own Postgres schema in the same
database cluster and the same database as the ERP, with an anti-corruption layer (ACL) for
reads and a transactional outbox for writes.**

Concretely, and these specifics are the decision, not commentary on it:

1. **Separate repository, separate service, separate deployable.** The CRM is not a
   CrossEngin package and does not join its pnpm workspace. It has its own CI (which the
   ERP lacks), its own release cadence, and its own runtime.

2. **`crm` schema in the ERP's database**, owned by a **`crm_app` role that owns no ERP
   object and is neither superuser nor the ERP migration role**. RLS on every CRM table,
   with the ERP's exact policy text so one mental model covers both:
   ```sql
   USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
   ```
   This is load-bearing: **a table's owner bypasses RLS**, verified empirically and
   documented in the ERP's `CLAUDE.md`. Ownership discipline *is* the isolation guarantee.
   Provision at minimum: `erp_owner` (migrations), `erp_app` (ERP runtime),
   `crm_app` (CRM runtime, owns `crm.*`, `SELECT`-only on ERP tables).

3. **Foreign keys from `crm.*` into ERP tables, using the ERP's composite shape** —
   **conditional on the ERP moving to `--store pg-columns`, which it has not (R17):**
   ```sql
   -- entity tables land in `public` when --schema is omitted, not `meta`
   FOREIGN KEY (tenant_id, employee_id) REFERENCES public.employee (tenant_id, id)
   FOREIGN KEY (tenant_id, item_id)     REFERENCES public.item     (tenant_id, id)
   FOREIGN KEY (tenant_id, account_id)  REFERENCES public.account  (tenant_id, id)
   ```
   All `ON DELETE RESTRICT`. This is the mechanism that makes "never a second copy of the
   truth" **enforced by Postgres rather than promised in a design doc**, and it is
   available only in this option.

   **On the JSONB store this is impossible** — there are no per-entity tables. If the
   platform will not move to `pg-columns`, fall back to **3-degraded**: CRM columns hold
   the ERP's `TEXT` record id with **no FK**, integrity is enforced by the ACL on write
   and by a scheduled referential-integrity check that reports orphans, and the ADR's
   central claim weakens from "the database prevents a second copy of the truth" to "our
   code does". That is still better than option (c) — local reads and one backup timeline
   survive — but it is a materially weaker position and should be recorded as such rather
   than glossed. **Q1 decides which of 3 or 3-degraded we build.**

4. **Read path: an anti-corruption layer, always.** No CRM feature code touches an ERP
   table or endpoint directly. The ACL is one module exposing CRM-shaped domain types
   (`Rep`, `Product`, `Customer`, `CreditStatus`) over ERP records. Inside it:
   - Direct **read-only SQL** against ERP tables for hot mobile paths (product catalogue,
     rep roster, account list) — same transaction, same RLS context, no HTTP hop.
   - The **HTTP API** for anything with business logic behind it, and for every write.
   - **Types generated from `GET /v1/meta/schema` at build time**, with the build failing
     on drift. Slugs, filterable fields and enum values are derived, never hand-written:
     the pluraliser is naive (`/v1/opportunitys`, `/v1/currencys`) and an unknown filter
     param is **silently dropped**, so a mistyped filter widens the result set instead of
     erroring.
   - Both ERP error shapes handled — RFC 9457 `application/problem+json` from the gateway,
     bare `{error, detail}` from handlers.

5. **Write path: CRM-local transaction + outbox, never a cross-schema write.** The CRM
   **never writes ERP tables directly**, even though the database permits it. A rep action
   commits to `crm.*` and appends to `crm.outbox` in one transaction; a relay drains the
   outbox and calls the ERP's HTTP API, so every ERP invariant runs — RBAC, write-guards,
   period locks, GL write-effects, sequences, audit. Bypassing the API to write GL-relevant
   rows would silently defeat the double-entry engine, which is the ERP's single most
   valuable asset.

6. **Idempotency by deterministic client-minted ids.** The relay derives a stable
   `crm_<uuidv7>` record id per outbox row and sends it as the record's `id`, plus an
   `Idempotency-Key` header. Dedup then rests on the ERP's `(tenant_id, entity, record_id)`
   unique constraint — a durable database guarantee — not on the ERP's in-memory
   idempotency store, which dies on restart and does not span instances. Treat a unique
   violation on replay as success.

7. **Ownership boundary, written down once and enforced in review.**

   | Domain | System of record | CRM holds |
   |---|---|---|
   | Employee, Department, Position, manager line | **ERP** | FK + a CRM-owned `rep_profile` (territory, targets, device, login mapping) |
   | Item, PriceList, TaxCode, Currency | **ERP** | FK + a CRM-owned `product_profile` (ATC, INN, molecule, strength, form, brand family, detailing priority, sample-eligible) |
   | Account, Contact | **ERP** | FK + CRM-owned engagement attributes (segment, potential, call frequency, HCP speciality, KOL tier) |
   | Invoice, Payment, Bill, JournalEntry, GL, FiscalPeriod | **ERP** | read-only, never written except through documented transitions |
   | SalesOrder, Quote | **ERP** | CRM originates via API; ERP owns the record |
   | Lead, Opportunity | **decision required — Q2** | see Open questions |
   | Expense claim | **ERP record, CRM approval graph** | CRM routes approval, then drives `submit`/`approve` |
   | Visit, call plan, route, territory, objective, detailing, sample custody, consent, e-signature, attachments, offline sync state | **CRM** | everything |

8. **Read replication for the mobile path, as a derived cache with a stated staleness
   budget.** `crm.product_snapshot` and `crm.rep_snapshot` are materialised from ERP tables
   for offline bundle assembly. They are **caches, not sources**: every row carries the ERP
   `id` and its `updated_at`, refresh is incremental on `updated_at`, and a full rebuild
   from ERP tables must be a one-command operation that is exercised in CI. This is the
   one place a physical second copy exists, and it is legitimate precisely because it is
   rebuildable, never authoritative, and never written by a user.

9. **Change detection by polling `updated_at`, not by webhooks.** The ERP has no outbound
   delivery code. Every entity carries `updated_at` from the `auditable` trait, and the
   list API supports `?updated_at[gte]=`, so incremental pull works today. Where lower
   latency is needed, read the ERP tables directly inside the ACL. Do **not** build on
   `--emit-entity-events`: it enqueues rows into `meta.job_runs` (a queue the CRM would
   have to claim from) and it is **best-effort — a sink failure is swallowed so it never
   fails the user's write**, which means events can be lost. Revisit only if the ERP
   implements `meta.webhook_deliveries` (Q9).

10. **The CRM owns identity, and authorises every user-facing read itself.** The ERP
    cannot scope a read to a rep, so it is never asked to. The ACL holds **one ERP service
    credential per tenant**; user-level authorisation happens in the CRM against
    CRM-owned territory and assignment data. A CRM user's JWT is never forwarded to the
    ERP. This also sidesteps two ERP constraints: only the **first** JWT scope is read as
    the principal's role, and the JWKS parser accepts **Ed25519 only** — an RS256 IdP
    would not work.

11. **Deploy as separate containers against a shared database.** The CRM API and the
    ERP `operate-server` are independent processes with independent restarts and
    independent scaling. `operate-server` must stay long-running (its schedulers are
    in-process); the CRM read path can scale horizontally on its own.

## Alternatives considered

- **Option (a): extend the CrossEngin repo directly as new modules.**
  - **Pros:** One transaction spans CRM and ERP writes — no outbox, no eventual
    consistency, no relay to operate. Real FKs everywhere by default. Full reuse of the
    kernel, RBAC, redaction, the job queue and the GL. A new entity in the manifest gets
    typed tables, REST CRUD, lifecycle transitions **and a working admin UI** for free —
    `buildUiSchema` drives `apps/operate-web` generically, which is a genuinely
    substantial gift. One deployment, one migration story, no cross-service auth.
  - **Cons:** No CI exists, so every CRM change is validated by a several-minute manual
    `pnpm -r build && typecheck && test` across 82 packages, plus the manual live-Postgres
    verification `CLAUDE.md` insists on. The CRM inherits the ERP's release cadence and
    its blast radius: a CRM bug takes down the ERP process, because they are the same
    process. The manifest/column-store model cannot express what the CRM needs — schema
    migration is **additive only** (a removed field's column is never dropped, a changed
    type never altered, ADR-0283), and the CRM's write pattern is high-churn iteration.
    Offline sync, conflict resolution, RTL, attachments and geospatial work would all have
    to be built *inside* a codebase whose stated conventions (zod contracts, layered
    purity, an ADR per increment, no `--no-verify`) are excellent for a slow-moving
    platform and hostile to weekly product iteration. And the mobile read path could not
    scale independently of the ERP at all.
  - **Why not:** Velocity and blast radius, decisively. Also a correctness trap: the ERP's
    RBAC has **no row-level scoping**, so CRM entities added to the manifest would inherit
    tenant-wide visibility for every role. Making "my accounts" work would mean
    implementing ABAC enforcement in the ERP's `rbacCheck` — a platform change with
    platform-wide consequences, undertaken to ship a CRM feature. That is the tail wagging
    the dog. The free admin UI is real and it is not worth this.

- **Option (b): separate service, separate schema, same database cluster; ACL for reads,
  outbox for writes.** *(selected)*
  - **Pros:** The only option where "never a second copy of the truth" is **enforced by
    Postgres**, via composite `(tenant_id, id)` FKs into ERP tables — a CRM visit row
    cannot reference a deleted employee or a non-existent product. Reference reads for the
    mobile path are local SQL joins, no HTTP hop, no serialisation, no availability
    coupling on the read side. Independent deploys, independent CI, independent scaling,
    blast radius bounded to the CRM process. The outbox gives durable, replayable,
    idempotent writes that still pass through every ERP invariant. One backup, one restore,
    one PITR timeline covering both systems — which matters when a restore has to leave
    CRM and ERP mutually consistent.
  - **Cons:** Shared database is shared fate for **availability** (an ERP-side lock storm,
    a long migration, or connection exhaustion hurts the CRM) and for **operations**
    (upgrades, failover and connection-pool sizing become joint decisions). Cross-schema
    FKs create a real coupling: an ERP schema change that renames or drops a referenced
    table breaks CRM DDL, and the ERP has no CI to catch it. Reading ERP tables directly
    couples us to physical layout, which ADR-0002 (*Proposed*) would change if
    schema-per-tenant were ever implemented. Writes are still eventually consistent, so
    the outbox, its retries, its dead-letter path and its lag monitoring are real
    engineering we own.
  - **Why chosen:** It is the only option that gets referential integrity for
    employees, products and money **as a database constraint** rather than as a
    convention, while keeping the CRM's velocity, deployability and blast radius
    independent. The direct-read escape hatch also compensates precisely for the ERP's
    two worst integration gaps — no outbound events and no row-level authorisation — at
    zero latency cost.

- **Option (c): fully separate service and database, syncing via API and events.**
  - **Pros:** Maximum isolation. Independent scaling, independent backup and restore, free
    choice of engine and extensions (PostGIS for territories, pgvector for detailing
    search — neither of which the ERP's database has). Immune to ERP lock contention and
    connection exhaustion. Portable if CrossEngin is ever replaced.
  - **Cons:** **It forces exactly the thing the prior forbids.** With no shared database
    there is no FK, so employee, product and customer references become replicated rows
    the CRM must keep fresh — a second copy of the truth, maintained by us, with drift as
    the default failure mode. Worse, **the ERP cannot push**: `meta.webhook_endpoints` and
    `meta.webhook_deliveries` have no delivery code, there is no broker and no CDC writer,
    so "syncing via events" is not available. The real shape would be polling
    `?updated_at[gte]=` across every master entity, forever, with reconciliation jobs, a
    drift dashboard and an on-call runbook. Every mobile bundle assembly becomes N HTTP
    round-trips or a hit against a stale local mirror. Two backup timelines mean a restore
    can leave CRM and ERP inconsistent with no constraint to catch it.
  - **Why not:** It buys isolation we do not currently need with correctness we cannot
    afford to lose. Its one genuine advantage — engine and extension freedom, which the
    CRM does need for PostGIS — is obtainable more cheaply (see Consequences). Revisit if
    and only if the triggers in Open questions Q10 fire.

**A fourth option, considered and rejected: separate database on the same cluster**
(option (b½)). It keeps operational proximity and a single cluster to run, but a
cross-database FK is impossible in Postgres, so it degrades to option (c)'s correctness
model while keeping option (b)'s shared-fate availability. Worst of both.

## Consequences

**Positive**

- Employees, products, customers and money have exactly one home, and Postgres enforces
  it. The strongest available answer to the stated prior.
- The mobile read path is a local SQL join, not an HTTP fan-out — the difference between
  a fast offline bundle and a slow one.
- Every CRM-originated ERP write passes through the API and therefore through RBAC,
  write-guards, period locks, sequences, audit and the GL write-effects. We inherit the
  ERP's best asset instead of routing around it.
- Independent CI, deploys and scaling. A CRM incident does not take the ERP down.
- One backup and one PITR timeline covering both systems.
- The ACL is a real seam: if CrossEngin is ever replaced, or moves to schema-per-tenant,
  the change is bounded to one module.

**Negative**

- **`--store pg-columns` is a hard requirement for the full decision, and it is not met
  today.** Verified: every deployment artifact runs `--store pg`, hardcoded, with no env
  override (R17). On the JSONB store item 3 collapses entirely. Migrating means
  backfilling every existing record from `meta.operate_entity_records` into typed tables —
  **no migration tool for this exists** — and adopting a code path that first booted
  `pack-erp-core` successfully six days ago (ADR-0283) and has never run in production.
  If the answer to Q1 is no, we build **3-degraded** and this ADR's integrity claim is
  weakened accordingly. **This blocks all CRM schema work.**
- **`--per-tenant-manifests` makes the guarantee per-tenant rather than per-deployment.**
  Even on `pg-columns`, a tenant serving a custom manifest falls back to the JSONB store
  (`node.ts:1023–1031`) because column plans are derived from the boot manifest. Such a
  tenant has no typed tables and no FKs, and nothing signals which regime a given tenant
  is in. Either that flag stays off wherever the CRM runs, or the CRM tolerates both — and
  tolerating both means building 3-degraded anyway (R18).
- Shared-fate availability and joint operational decisions on the database.
- Cross-schema FKs couple CRM DDL to ERP physical layout, in a repo with no CI. We must
  run our own contract test against a real ERP schema on every CRM build.
- The outbox, relay, retry ladder, dead-letter path and lag monitoring are ours to build
  and operate.
- Eventual consistency is user-visible: an order taken offline is not in the ERP until the
  relay drains. The UI must show sync state honestly rather than pretending.
- **PostGIS is not installed** and the field-type map already emits `geography(POINT)` for
  `geo_point`. If the CRM schema needs PostGIS, enabling it on the shared database is a
  joint decision (Q7). It is an extension in the same database, not a second database, so
  this is a conversation and not a blocker — and it is the main reason option (c) is worth
  re-examining if the answer is no.
- We inherit the ERP's operational blind spots for anything we call: no `/healthz`, no
  `/metrics`, no tracing, in-memory rate limiting at a flat 10,000.

**Neutral**

- The CRM will not use the CrossEngin manifest system, the AI Architect, or the generic
  `operate-web` renderer. That is a deliberate trade: we give up the free admin UI to keep
  schema freedom, non-additive migrations and iteration speed.
- Two audit trails will exist. If pharma compliance requires a tamper-evident record of
  CRM↔ERP writes, the CRM produces it — the ERP's `meta.audit_log` is neither chained nor
  signed (ADR-0279).
- Offline sync, RTL/Arabic, attachments and search are CRM-owned in every option. Option
  (b) neither helps nor hurts here; the ERP's `pwa`, `i18n`, `files` and `search` packages
  are contracts with no runtime and are useful as *specifications to implement against*,
  not as dependencies.

**Reversibility**

- **(b) → (c): moderate, ~2–4 weeks.** Drop the cross-schema FKs, promote
  `crm.product_snapshot` / `crm.rep_snapshot` from cache to replicated master, move
  reference reads in the ACL from SQL to HTTP, and add reconciliation jobs. The ACL is the
  seam that makes this bounded — which is why it is mandatory from day one rather than a
  refactor we promise ourselves later. **Designing the ACL so this escape hatch stays open
  is a standing constraint on every PR that touches it.**
- **(b) → (a): expensive, and unattractive.** Re-expressing CRM entities as manifest
  entities inside a repo with no CI and additive-only migrations. We would not do this.
- **(a) → anything: very expensive.** Which is itself an argument against starting at (a).

## Implementation notes

**Sequencing.** Q1 (`pg-columns`) and Q3 (Employee↔login) both block schema work. Nothing
below starts until they are answered.

1. **Roles and grants first.** `erp_owner`, `erp_app`, `crm_app`. `crm_app` owns `crm.*`,
   has `USAGE` on the ERP schema and `SELECT` on the specific ERP tables the ACL reads,
   and owns nothing of the ERP's. **Write a live cross-tenant read test and put it in CI**
   — RLS is bypassed by the table owner, so this is verified empirically, never by
   inspection.
2. **Resolve Q1 before writing any DDL.** The ERP is on `--store pg` today, so as things
   stand there is no table to reference. If it moves to `pg-columns`, capture the live
   schema (table names — `snake_case`, singular — column names, `(tenant_id, id)` PKs, and
   the containing schema, which is `public` unless `--schema` is passed) as a fixture the
   CRM's CI asserts against on every build. If it does not move, build 3-degraded and add
   the orphan-check job to the plan.
3. **ACL skeleton with generated types.** Fetch `GET /v1/meta/schema`, generate slugs,
   field names, enum values and filterable-field sets, fail the build on drift. Handle both
   error shapes. Never hand-write a slug.
4. **CRM schema + FKs**, RLS with the ERP's exact policy text, `withTenantContext`
   equivalent as the only way in.
5. **Outbox + relay.** `crm.outbox(id, tenant_id, aggregate, payload, target_record_id,
   attempts, next_attempt_at, state)`. Deterministic `crm_<uuidv7>` target ids. Exponential
   backoff with jitter, dead-letter, lag metric. Unique-violation-on-replay = success.
6. **Snapshots + incremental refresh** on `updated_at`, with a one-command full rebuild
   exercised in CI.
7. Only then: visits, call plans, sample custody, offline sync.

**API details that will bite** (all evidenced in the report):

- `x-tenant-id` is load-bearing — a JWT principal's tenant comes from the header, and the
  gateway cross-checks it against the token.
- List envelope is `{ data: [...], page: { limit, nextCursor } }`; read/create/update
  return the bare record; delete returns `204`.
- Pagination is keyset, `?cursor=`, `?limit=` capped at 500. Not offset.
- Filters: `?f=v` or `?f[eq|ne|gt|gte|lt|lte|in|contains]=v`. FK fields and lifecycle
  `stateField` are filterable by default. **Unknown params are silently ignored** — assert
  on result shape, never assume a filter applied.
- Transitions are `POST /v1/<resource>/{id}/<transition>` and are role-gated only.
- `GET /v1/meta/aging` gives AR/AP buckets for rep credit checks (finance roles only).

**Explicitly out of scope for the ERP, owned by the CRM:** identity and session,
territory and assignment, row-level authorisation, offline outbox and conflict resolution,
attachments and object storage, e-signature capture, lot/expiry/custody for samples,
therapeutic taxonomy, geospatial, RTL and Arabic, CRM observability and CI.

**Explicitly forbidden:** writing ERP tables directly from the CRM; minting an `Item`,
`Employee` or `Account` in the CRM; forwarding a CRM user's JWT to the ERP; copying
salary, GL or invoice amounts into CRM tables; depending on `--emit-entity-events` as a
delivery guarantee; any CRM role owning an ERP table.

## Open questions

| # | Question | Owner | Deadline |
|---|---|---|---|
| Q1 | **Answered — the ERP is on `--store pg` (JSONB), in every deployment artifact, hardcoded.** Cross-schema FKs are impossible as things stand, and `pg-columns` first booted `pack-erp-core` on 2026-08-26 (ADR-0283) with no production use and no CI. The open question is now the decision, not the fact: **will the platform migrate to `pg-columns` (accepting a JSONB→typed-table backfill for which no tool exists, on a days-old code path), or do we build 3-degraded with ACL-enforced integrity and an orphan-check job?** **Blocks all schema work.** | Platform + Eng leadership | 2026-09-08 |
| Q2 | Who owns `Lead` and `Opportunity`? The ERP already models both with full lifecycles, but they carry `owner_id → Employee` with **no row-level scoping**, so the ERP cannot show a rep only their own. Options: CRM owns pipeline and pushes only won deals as `SalesOrder`; or ERP owns it and the CRM filters client-side. Affects the data model and the offline bundle. | Product + Platform | 2026-09-12 |
| Q3 | What is the authoritative mapping from a CRM login to an ERP `Employee`? Nothing in the ERP links them. Candidates: `work_email`, `employee_number`, or a CRM-owned mapping table (recommended). Which is stable across rehire, transfer and email change? **Blocks all rep-scoped work.** | Platform + HR | 2026-09-08 |
| Q4 | Where do samples and promo material live? Recommendation from the report: CRM-owned custody with lot and expiry, mirroring aggregate issues to `StockMovement`. Is a regulator likely to demand that ERP inventory be the sample system of record? If so, the ERP needs lot/expiry/custody built first, which is a platform project. | Compliance + Product | 2026-09-19 |
| Q5 | Which ERP tables may the ACL read directly, and is that list contractual? Direct reads are the performance case for option (b) but couple us to physical layout in a repo with no CI. Proposal: a named, versioned allow-list asserted in CRM CI. | Platform | 2026-09-15 |
| Q6 | Do rep expense claims need cost-centre, campaign or account attribution? `Expense` has no `cost_center_id`, no lines, no advances, and **never posts to the GL**. If attribution is required, we either post manual `JournalEntry` rows with `cost_center_id` per line (reconciliation burden) or the ERP grows an expense posting effect (platform work). | Finance | 2026-09-19 |
| Q7 | Can PostGIS be enabled on the shared database? Territories, GPS check-in and route optimisation want it; the ERP's field-type map already emits `geography(POINT)` but no deployment installs the extension. A "no" is the strongest argument for revisiting option (c). | Platform + DBA | 2026-09-15 |
| Q8 | Which IdP mints the ERP service credentials, and does it support **Ed25519**? The JWKS parser accepts `kty=OKP, crv=Ed25519` **only** — an RS256 IdP silently yields zero usable keys. Also: static `--api-key` values are passed as argv (visible in `ps`) and require a restart to rotate. What is the rotation story? | Platform + Security | 2026-09-12 |
| Q9 | Will the platform implement `meta.webhook_deliveries`? The tables and state machine exist with no code. If it ships, the CRM can move from polling to push and the sync story improves materially. If it will not ship this year, we design for polling and stop waiting. | Platform | 2026-09-26 |
| Q10 | What are the agreed triggers for moving to option (c)? Proposal, to be ratified now rather than argued during an incident: (i) two ERP-caused CRM outages in a quarter; (ii) CRM write volume forcing connection-pool changes that degrade the ERP; (iii) a residency or regulatory rule requiring physical separation; (iv) PostGIS refused (Q7) *and* geospatial proving load-bearing. | Eng leadership | 2026-09-26 |
| Q11 | Is `--per-tenant-manifests` on, or planned, wherever the CRM will run? If yes, the FK guarantee is per-tenant rather than per-deployment (R18) and we build 3-degraded regardless of Q1's outcome. | Platform | 2026-09-08 |

## References

- `docs/ERP_INTEGRATION_REPORT.md` — the full survey this ADR rests on. Read §13 (Risks
  and gaps) before reviewing this decision.
- `../CrossEngin/CLAUDE.md` — the accurate current state of the ERP. The ERP's
  `README.md` is badly stale (claims 51 packages / 119 tables / 5,768 tests / 1 app;
  actual 82 / 139 / ~9,285 / 3).
- `../CrossEngin/packages/kernel/src/bootstrap/meta-schema.ts` — the 139-table catalog.
- `../CrossEngin/packages/operate-runtime/src/compile.ts` — manifest → live API.
- `../CrossEngin/packages/operate-runtime-pg/src/{entity-ddl,column-plan,tenant-context}.ts`
  — composite FKs, RLS context, additive migration.
- `../CrossEngin/packages/operate-runtime/src/write-effects.ts` — the GL engine.
- `../CrossEngin/apps/operate-server/src/{principals,cli}.ts` — auth model and deployment flags.
- CrossEngin ADR-0002 (Multi-Tenancy Model) — **still *Proposed*, and does not describe the
  running system**: it specifies schema-per-tenant; the code is shared-schema + RLS.
- CrossEngin ADR-0279 (tenant-scope audit), ADR-0283 (emitter reconciliation),
  ADR-0284 (dead entity emitter removal).
- RFC 9457 — Problem Details for HTTP APIs.
- Martin Fowler / Eric Evans — anti-corruption layer; transactional outbox pattern.
