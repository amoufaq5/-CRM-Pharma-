# ADR-0001: CRM ↔ ERP Integration Architecture

| Field | Value |
|---|---|
| **Status** | **Accepted** (2026-09-28) — all eleven open questions answered 2026-09-26 |
| **Date** | 2026-09-01 (questions resolved 2026-09-26) |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | amoufaq5 |
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
*conditional on*. Resolved 2026-09-26: we build **3-degraded** (decision item 3). See
R17/R18/R19 in the report.

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
   object and is neither superuser nor the ERP migration role**. RLS **plus `FORCE ROW
   LEVEL SECURITY`** on every CRM table, with the ERP's exact policy text so one mental
   model covers both:
   ```sql
   USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
   ```
   The policy text carries **one deliberate divergence**: ours wraps the setting in
   `NULLIF(current_setting('app.current_tenant_id', true), '')`. The ERP's un-guarded form
   raises `invalid input syntax for type uuid: ""` rather than returning no rows on any
   connection that has previously held a tenant context — the normal state of a pooled
   backend after its first request (report R20, verified live). `NULLIF` collapses both
   cases to "no rows", so a forgotten `withTenantContext` fails identically every time.
   Same security, predictable failure.

   `FORCE` is not optional for us and the reason is specific: **a table's owner bypasses
   RLS**, and `crm_app` *owns* `crm.*`. Without `FORCE`, our own application role would
   read every tenant's CRM rows regardless of context — the policy would be decoration.
   Verified live on Postgres 16.13 (see `packages/db/src/rls.contract.test.ts`): an owner
   with tenant-1 context read all 3 rows of a 2-tenant table; under `FORCE` it read 2.

   The ERP does **not** use `FORCE` on its own tables, which is why its isolation depends
   on ownership discipline rather than on the policy. We therefore provision, at minimum:
   `erp_owner` (ERP migrations), `erp_app` (ERP runtime), `crm_app` (CRM runtime, owns
   `crm.*`, `SELECT`-only on the ERP). `crm_app` owning an ERP object is a cross-tenant
   leak, so CI asserts it owns none.

3. **No foreign keys into ERP tables. Integrity is enforced by the ACL plus a scheduled
   orphan check** ("3-degraded", ratified 2026-09-26). The FK design in the Alternatives
   section remains the target if the platform ever moves to `--store pg-columns`, but it
   is not what we build. Two answers force this jointly and independently:
   - The ERP runs `--store pg` (R17): all records live in `meta.operate_entity_records`
     as untyped JSONB, so there are no per-entity tables to reference.
   - `--per-tenant-manifests` is **on** (Q11, R18): even after a `pg-columns` migration,
     custom-manifest tenants would fall back to the JSONB store, making any FK guarantee
     per-tenant rather than per-deployment. Building on a guarantee that holds for only
     some tenants is worse than not claiming it.

   Concretely: CRM columns hold the ERP's `TEXT` record id (`erp_employee_id`,
   `erp_item_id`, `erp_account_id`), **not null**, with a CHECK matching
   `^[A-Za-z0-9_-]{1,200}$`. The ACL validates existence on write. A nightly
   `crm.referential_check` job reports orphans per entity per tenant; a non-zero count
   pages, it does not auto-heal. The honest statement of this ADR's central claim is
   therefore **"our code prevents a second copy of the truth"**, not "the database does".

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
   - **`/v1/meta/schema` is fetched and cached _per tenant_, not once at boot.** Q11 is
     yes, so a tenant on a custom manifest has a different entity set from the boot pack.
     A single global schema cache would be wrong for those tenants. Build-time generation
     covers the boot pack; runtime resolution covers the rest, and an entity the calling
     tenant does not have is a typed "unsupported for this tenant" result, never a crash.
   - **No numeric filtering, sorting or aggregation through the ERP.** On the deployed
     JSONB store every predicate is a text comparison (R19): `?total[gt]=1000` is wrong,
     `?sort=amount` is lexicographic. ISO dates are safe; money and quantities are not.
     Numeric work goes to the snapshot tables in item 8.
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
   | Lead, Opportunity, Quote | **CRM** (Q2) | the whole pipeline; only won deals cross over as `SalesOrder` |
   | Expense claim | **ERP record, CRM approval graph** | CRM routes approval, then drives `submit`/`approve` |
   | Visit, call plan, route, territory, objective, detailing, sample custody, consent, e-signature, attachments, offline sync state | **CRM** | everything |

8. **Typed snapshot tables are the CRM's read path — a correctness requirement, not a
   cache optimisation.** `crm.product_snapshot`, `crm.rep_snapshot` and
   `crm.account_snapshot` are materialised from the ERP with **real column types**
   (`NUMERIC`, `DATE`, `BOOLEAN`), because the ERP cannot answer a numeric query correctly
   (R19) and the CRM cannot add an index to `meta.operate_entity_records` without owning
   it (R16). Every numeric filter, sort, aggregation and offline bundle assembly reads
   these tables.

   They remain **derived, never authoritative**: every row carries the ERP `id` and its
   `updated_at`, refresh is incremental on `updated_at`, no user ever writes one, and a
   full rebuild from the ERP must be one command, exercised in CI. Each table declares a
   staleness budget and exposes its lag; the UI shows "as of" wherever a snapshot value
   drives a decision. This is the one place a physical second copy exists, and it is
   legitimate precisely because it is rebuildable and never the source.

9. **Change detection by polling `updated_at`, not by webhooks.** The ERP has no outbound
   delivery code. Every entity carries `updated_at` from the `auditable` trait, and the
   list API supports `?updated_at[gte]=`, so incremental pull works today. Where lower
   latency is needed, read the ERP tables directly inside the ACL. Do **not** build on
   `--emit-entity-events`: it enqueues rows into `meta.job_runs` (a queue the CRM would
   have to claim from) and it is **best-effort — a sink failure is swallowed so it never
   fails the user's write**, which means events can be lost. Revisit only if the ERP
   implements `meta.webhook_deliveries` — which the platform has now committed to (Q9,
   answered yes). Because it is coming, change detection sits behind a `ChangeSource`
   interface from day one, with `PollingChangeSource` as the only implementation; swapping
   in `WebhookChangeSource` later must not touch a single caller.

10. **The CRM owns identity, and authorises every user-facing read itself.** The ERP
    cannot scope a read to a rep, so it is never asked to. The ACL holds **one ERP service
    credential per tenant**; user-level authorisation happens in the CRM against
    CRM-owned territory and assignment data. A CRM user's JWT is never forwarded to the
    ERP. This also sidesteps two ERP constraints: only the **first** JWT scope is read as
    the principal's role, and the JWKS parser accepts **Ed25519 only** — an RS256 IdP
    would not work.

    **The credential design (Q8, "recommend the optimum for security") is two-tier:**

    | Tier | Purpose | Algorithm | Lifetime |
    |---|---|---|---|
    | **Human → CRM** | a standard OIDC IdP (Entra ID, Auth0, Keycloak — any will do) authenticates people into the CRM | **RS256 is fine** — this token never reaches the ERP | normal session |
    | **CRM → ERP** | the ACL mints its own service JWT per tenant | **Ed25519**, as the ERP's verifier requires | **5–15 minutes** |

    The CRM publishes a JWKS endpoint; the ERP is pointed at it with `--jwks-url` +
    `--jwks-refresh-ms` and the matching `--jwt-issuer` / `--jwt-audience`. The private key
    lives in a KMS or secret manager, never on disk and never in an argument. Rotation is
    publishing a new `kid` beside the old one and retiring the old after one TTL — the ERP
    already refetches on an unknown `kid`, rate-limited, keeping the last good set. The
    single scope in each token is that tenant's ERP service role; the tenant rides in
    `x-tenant-id` and the gateway cross-checks it against the claim.

    **This replaces `--api-key` entirely, and that is the point.** Static API keys are
    passed as argv (visible in `ps`), held in memory, and need a process restart to rotate
    — three properties that make them the weakest credential in the system. Minting our own
    short-lived Ed25519 tokens removes all three, and it means no third-party IdP has to
    support Ed25519 for us to satisfy the ERP's verifier.

    **Built** (`packages/credential/`, migration 0014). Three things the implementation
    learned that this item did not anticipate:

    - **The ERP only checks `exp`, `iss` and `aud` when the claim is present.** A token
      minted without `exp` never expires there and nothing downstream reports it, so
      emitting all three is entirely our responsibility. The minter requires them.
    - **One scope, not a list.** The gateway parses every space-separated scope, but
      `principalFromJwtClaims` takes only `grantedScopes[0]` as the role. A value like
      `sales_rep controller` therefore grants `sales_rep` while reading as deliberate
      least privilege. A CHECK constraint on `crm.erp_service_principal.erp_role` forbids
      whitespace, and the minter refuses it again.
    - **The JWKS endpoint must never serve an empty 200.** `RemoteJwksProvider` keeps its
      cached keys on a non-200 and replaces them with whatever a 200 carries, so an empty
      document disarms every verifier that fetches it. Ours returns 503 instead.

    **"The private key lives in a KMS" needs checking before it is committed to.** The ERP
    accepts EdDSA only, and Ed25519 signing is not universally offered by managed key
    services — Vault's transit engine signs ed25519; several cloud KMS offerings have
    historically exposed only ECDSA and RSA. Confirm against current documentation. The
    signer is therefore an interface with an async `sign` and no way to read the key out,
    so a hosted signer is a swap rather than a redesign; what ships is a local signer
    loading a PEM from a secret at boot, which is weaker and is stated as such.

11. **Rep expense claims post to a SEPARATE Sales & Marketing expense account,
    which can optionally be hooked to a cost centre** (Q6, resolved 2026-09-29).
    Not a cost-centre tag on the ERP's existing expense account, and not per
    campaign — campaign stays a CRM reporting dimension and never reaches the GL.

    This is the ordinary `JournalLine` shape: `ledger_account_id` is required and
    carries the S&M account, `cost_center_id` is optional and carries the
    dimension. The distinction matters because the ERP's `FinanceSettings`
    already has a single `expenseAccountCode`, used for AP bill recognition;
    reusing it would merge rep spend into supplier invoices in the P&L, which is
    the thing a separate account exists to prevent.

    - `crm.expense_account_map` maps the CRM's own (richer) category vocabulary
      to a `LedgerAccount.account_code` of type `expense`, plus an optional
      `CostCenter.code`. **Codes, not record ids** — that is the ERP's own
      convention (`FinanceSettings` holds `account_code` strings and resolves
      them at posting time via `resolveAccountId`), and a code survives the
      record-id churn a JSONB-store reload can cause.
    - The account and cost centre are **snapshotted onto the claim at
      submission**, never looked up at posting time. Re-mapping a category next
      quarter must not retroactively re-attribute a claim that is already
      posted; an accountant reading a journal entry needs it to still mean what
      it meant. Enforced by `expense_claim_snapshot_before_submit`.
    - A NULL cost centre is valid and is the right default until Finance names
      the codes: `JournalLine.cost_center_id` is nullable, so "post to the S&M
      account with no dimension" is a legitimate posting.
    - On `reimburse`, the relay posts a balanced `JournalEntry` — debit the S&M
      account, credit employee payable — carrying `cost_center_id` on each line
      where one is set, then drives the ERP `Expense` transition. The journal
      entry is the attribution; the `Expense` record is the claim.
    - The relay retries into the next open period rather than dead-lettering
      when `lockedDocumentGuard` refuses a closed `FiscalPeriod` — a late claim
      against a closed month is routine, not an error.
    - **The approval graph is the CRM's**, and four-eyes is enforced in the CRM
      schema (`expense_claim_four_eyes`) because nothing downstream will: the
      ERP's `Expense` workflow is a flat role check that never reads
      `Employee.manager_id`, has no amount bands and no separation of duties, so
      the same principal can submit and approve (report R7).
    - Posting needs the `controller` role, so the tenant's ERP service
      credential must hold it. That widens the credential; it is the price of GL
      attribution and should be reviewed as such rather than waved through.

12. **Deploy as separate containers against a shared database.** The CRM API and the
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
    and only if the Q10 triggers fire (see Decisions taken).

**A fourth option, considered and rejected: separate database on the same cluster**
(option (b½)). It keeps operational proximity and a single cluster to run, but a
cross-database FK is impossible in Postgres, so it degrades to option (c)'s correctness
model while keeping option (b)'s shared-fate availability. Worst of both.

## Consequences

**Positive**

- Employees, products, customers and money have exactly one home. Enforced by the ACL and
  audited by the orphan check rather than by Postgres (Q1), but structurally single-homed:
  no CRM table is the source for any of them.
- The mobile read path stays in one database — no HTTP fan-out, no cross-service
  serialisation, one transaction boundary for the outbox.
- Every CRM-originated ERP write passes through the API and therefore through RBAC,
  write-guards, period locks, sequences, audit and the GL write-effects. We inherit the
  ERP's best asset instead of routing around it.
- Independent CI, deploys and scaling. A CRM incident does not take the ERP down.
- One backup and one PITR timeline covering both systems — a restore leaves CRM and ERP
  mutually consistent, which two databases could not promise.
- The ACL is a real seam: if CrossEngin is replaced, moves to schema-per-tenant, or
  migrates to `pg-columns`, the change is bounded to one module.

**Negative**

- **The integrity guarantee is ours, not the database's.** Q1 and Q11 together rule out
  foreign keys (R17, R18), so a CRM row referencing a deleted or non-existent ERP record is
  prevented by ACL validation and *detected* — not prevented — by the nightly orphan check.
  This is the largest single concession in the design, and the honest reading of what
  option (b) still buys: local reads, one backup timeline, one transaction boundary, and
  independent deployment. Not referential integrity.
- **Direct reads are JSONB reads, and we cannot index them.** With the ERP on `--store pg`
  there are no per-entity tables: everything is `document ->> 'field'` against
  `meta.operate_entity_records`, whose only indexes are `(tenant_id, entity)` and the
  unique `(tenant_id, entity, record_id)`. Adding a GIN index would require owning that
  table, which R16 forbids. Option (b)'s "local SQL join" advantage survives as
  *same-database, no-HTTP-hop* — not as *indexed*.
- **Numeric queries against the ERP are wrong, not merely slow** (R19). Every JSONB
  predicate compares as text: `?total[gt]=1000` includes and excludes the wrong rows,
  `?sort=amount` orders `100, 20, 9`, and the keyset cursor paginates that wrong order
  consistently rather than erroring. ISO dates are safe by accident. This is why the typed
  snapshot tables moved from optimisation to requirement (item 8), and it is the strongest
  practical argument for the platform eventually adopting `pg-columns`.
- **The ERP service credential must hold `controller`** to post the expense journal entry
  (item 11) — a broader grant than reading masters needs. Accepted knowingly, flagged for
  security review.
- Shared-fate availability and joint operational decisions on the database.
- The outbox, relay, retry ladder, dead-letter path and lag monitoring are ours to build
  and operate.
- Eventual consistency is user-visible: an order taken offline is not in the ERP until the
  relay drains. The UI must show sync state honestly rather than pretending.
- We inherit the ERP's operational blind spots for anything we call: no `/healthz`, no
  `/metrics`, no tracing, in-memory rate limiting at a flat 10,000, and in-memory
  idempotency that dies on restart (which is why item 6 does not depend on it).

**Neutral**

- The CRM will not use the CrossEngin manifest system, the AI Architect, or the generic
  `operate-web` renderer. That is a deliberate trade: we give up the free admin UI to keep
  schema freedom, non-additive migrations and iteration speed.
- The ERP's `Lead`, `Opportunity` and `Quote` entities go unused (Q2), along with the
  `erp.lead_created` / `erp.quote_sent` job triggers that hang off them. That is not waste
  to reclaim; it is the ERP keeping a capability we have chosen not to use.
- Two audit trails will exist. If pharma compliance requires a tamper-evident record of
  CRM↔ERP writes, the CRM produces it — the ERP's `meta.audit_log` is neither chained nor
  signed (ADR-0279).
- Offline sync, RTL/Arabic, attachments and search are CRM-owned in every option. Option
  (b) neither helps nor hurts here; the ERP's `pwa`, `i18n`, `files` and `search` packages
  are contracts with no runtime and are useful as *specifications to implement against*,
  not as dependencies.

**Reversibility**

- **(b) → (c): cheaper than first estimated, ~1–2 weeks.** 3-degraded leaves no FKs to
  drop, and the typed snapshot tables already hold the master data the mobile path reads.
  What remains is moving the ACL's reference reads from local JSONB queries to HTTP and
  adding reconciliation jobs. Conceding Q1 lowered the exit cost, which cuts both ways:
  much of what structurally distinguished (b) from (c) is gone, and what is left is
  operational — one database, one backup, one transaction boundary. **If the platform
  declines `pg-columns` permanently, Q10 deserves re-examination on those terms.** The ACL
  remains the seam, and keeping this exit open stays a standing constraint on every PR
  that touches it.
- **(b) → (a): expensive, and unattractive.** Re-expressing CRM entities as manifest
  entities inside a repo with no CI and additive-only migrations. We would not do this.
- **(a) → anything: very expensive.** Which is itself an argument against starting at (a).

## Implementation notes

**Sequencing.** All eleven questions are answered (2026-09-26), so nothing below is
blocked. Order matters for the reasons given, not for missing inputs.

1. **Roles and grants first.** `erp_owner`, `erp_app`, `crm_app`. `crm_app` owns `crm.*`,
   has `USAGE` on the ERP schema and `SELECT` on the specific ERP tables the ACL reads,
   and owns nothing of the ERP's. **Write a live cross-tenant read test and put it in CI**
   — RLS is bypassed by the table owner, so this is verified empirically, never by
   inspection.
2. **Capture the ERP's entity-name allow-list as a CI fixture** (Q5). With 3-degraded
   there is no DDL dependency on ERP tables, so this gates correctness rather than schema
   creation: the fixture records which entities the ACL may read and what fields it relies
   on, asserted against `/v1/meta/schema` on every CRM build. Enable PostGIS (Q7) in the
   same pass.
3. **ACL skeleton with generated types.** Fetch `GET /v1/meta/schema`, generate slugs,
   field names, enum values and filterable-field sets, fail the build on drift. Handle both
   error shapes. Never hand-write a slug.
4. **CRM schema**, RLS with the ERP's exact policy text, a `withTenantContext` equivalent
   as the only way in, ERP references as CHECKed `TEXT` columns (no FKs — item 3), and the
   nightly `crm.referential_check` orphan job alongside them, not after them.
5. **Outbox + relay.** `crm.outbox(id, tenant_id, aggregate, payload, target_record_id,
   attempts, next_attempt_at, state)`. Deterministic `crm_<uuidv7>` target ids. Exponential
   backoff with jitter, dead-letter, lag metric. Unique-violation-on-replay = success.
6. **Typed snapshot tables + incremental refresh** on `updated_at`, with a one-command
   full rebuild exercised in CI. These are the read path, not an optimisation (item 8) —
   every numeric filter and sort in the product depends on them, because the ERP cannot
   answer one correctly (R19).
7. Only then: visits, call plans, sample custody, offline sync. **All built** (migrations 0012–0018).

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

## Decisions taken (formerly open questions)

All eleven were answered on 2026-09-26. Recorded here rather than deleted, because the
reasoning behind each constrains what follows.

| # | Question | Answer |
|---|---|---|
| Q1 | Migrate to `--store pg-columns`, or build 3-degraded? | **3-degraded.** No FKs; ACL-enforced integrity plus a nightly orphan check. The FK design stays documented as the target if the platform ever migrates. |
| Q2 | Who owns `Lead` and `Opportunity`? | **The CRM owns the pipeline.** The ERP's `Lead`/`Opportunity`/`Quote` entities go unused by us; only won deals cross over, as `SalesOrder` + `SalesOrderLine`. |
| Q3 | Login → `Employee` mapping? | **A CRM-owned mapping table**, keyed on `employee_number` (the only field immutable by intent), with `work_email` as a reconciliation hint only. |
| Q4 | Samples and promo material? | **CRM custody**, first-class, with lot and expiry. Aggregate issues mirror to the ERP's `StockMovement` when material leaves ERP-controlled stock. **Built** — migrations 0017/0018 and `packages/sample`: the balance is derived from the ledger by a trigger in the same transaction (the thing the ERP's `StockLevel` does not do), transfers are linked with in-transit and acceptance, expiry is judged on the day of the hand-over, and the count document writes adjustments rather than editing a balance. |
| Q5 | Which ERP data may the ACL read directly? | **A named, versioned allow-list, asserted in CRM CI** against the live schema on every build. Note this is now a list of *entity names* read out of `meta.operate_entity_records`, not tables (R17). |
| Q6 | Expense attribution? | **A separate Sales & Marketing expense account, optionally hooked to a cost centre** (refined 2026-09-29 from the first reading). Not a cost-centre tag on the ERP's existing `expenseAccountCode`, and not per campaign. See decision item 11. |
| Q7 | PostGIS on the shared database? | **Yes.** Territories, GPS check-in and route optimisation are CRM-side with real geometry. Removes trigger (iv) from Q10. |
| Q8 | IdP and credential design? | **Two-tier** (decision item 10): any OIDC IdP for human login (RS256 fine), CRM-minted 5–15 minute **Ed25519** service JWTs for ERP calls, published via our own JWKS endpoint, private key in KMS. Retires `--api-key` entirely. |
| Q9 | Will `meta.webhook_deliveries` ship? | **Yes.** We still build polling first (it does not exist yet), behind a `ChangeSource` interface so the swap costs nothing. |
| Q10 | Triggers for moving to option (c)? | **Ratified as proposed**, minus (iv), which Q7 resolved: (i) two ERP-caused CRM outages in a quarter; (ii) CRM write volume forcing pool changes that degrade the ERP; (iii) a residency or regulatory rule requiring physical separation. |
| Q11 | Is `--per-tenant-manifests` on? | **Yes.** Confirms 3-degraded independently of Q1, and forces per-tenant schema resolution in the ACL (decision item 4). |

## Still open

| Question | Owner | Deadline |
|---|---|---|
| **Which `LedgerAccount.account_code` is the S&M expense account per tenant, and does it exist yet?** It must be `account_type = 'expense'` and `is_postable`. Until Finance names it, `crm.expense_account_map` has no rows and no claim can leave draft — deliberately, since posting to a guessed account is worse than blocking. | Finance | _set a date_ |
| Which `CostCenter.code` (if any) to hook per category. Optional by design — NULL posts to the account with no dimension. `CostCenter.segment` has no `functional` value (`operating\|geographic\|product\|service\|other`), so S&M would sit under `operating`. | Finance | _set a date_ |
| Does the CRM need more than one S&M account (e.g. splitting congresses from detailing samples), or does one account with cost-centre and CRM-side category reporting suffice? The map is per-category already, so several accounts cost nothing structurally. | Finance | _set a date_ |
| Which OIDC IdP for human login (Q8 tier 1), and does the CRM service credential holding `controller` (needed for the GL posting in item 11) pass security review? The credential itself is built; the question is whether `controller` per tenant is the right grant, and it is per-tenant configuration (`crm.erp_service_principal`) so narrowing it costs nothing structurally. | Security | _set a date_ |
| Where does the signing key live? Ed25519 signing is not offered by every managed key service and the ERP accepts nothing else, so this is a real constraint rather than a preference. Until it is answered the key is a PEM in a secret, loaded into the scheduler's memory at boot. | Security | _set a date_ |
| Has a CRM-minted token been accepted by a **running** operate-server? The acceptance test transcribes the ERP's verifier (alg, kid, both base64 conversions, which claims it checks) and passes, but no live handshake has happened — no ERP instance was available. | Platform | _set a date_ |
| Staleness budget per snapshot table (item 8) — how old may a product price or a rep roster be on a mobile device before the UI blocks the action rather than warning? | Product | _set a date_ |
| Does the platform have a date for `meta.webhook_deliveries` (Q9)? Affects only when we retire `PollingChangeSource`, not whether we build it. | Platform | _set a date_ |
| Sample custody: may a rep declare their own receipt of stock? `POST /v1/samples/receipts` has the rep confirm it, because no warehouse-side admin surface exists yet. The stronger model is warehouse-initiated issue with rep acknowledgement. What makes the weaker one defensible meanwhile: the ledger is append-only, every correction carries a reason, and the cycle count reconciles against physical stock. | Compliance | _set a date_ |
| A transfer that is never accepted leaves material in `quantity_in_transit` indefinitely. It stays visible (`GET /v1/samples/transfers`) and accounted for, but there is no recall or timeout — the sender cannot take it back, and an adjustment only touches `quantity_on_hand`. | Product | _set a date_ |
| Signature images have nowhere to live. `signature_sha256` commits to what the device captured; the blob needs the object storage report §13 records as absent. Until then a disbursement says a signature was taken and fixes which one, without being able to produce it. | Product | _set a date_ |
| Controlled substances are flagged (`sample_lot.controlled`) and not otherwise handled. Unit-level serial custody is a stricter obligation than this schema discharges. | Compliance | _set a date_ |
| A manager cannot read their team's plans or holdings over HTTP. Every route is scoped to the caller; `crm.managed_territory_ids` answers the supervisory question in SQL and no route asks it yet. | Product | _set a date_ |
| Nothing writes off expired stock automatically. `crm.expiring_sample_holdings` is the query a nightly job would act on and the scheduler has no job for it, so expired material leaves a rep's balance only when someone does it by hand. | Product | _set a date_ |

> The deadlines in the original table (8–26 September) all lapsed before the answers came
> in. They are left blank above rather than back-dated.

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
