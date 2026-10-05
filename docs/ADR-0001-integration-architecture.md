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


13. **Administrative authority is a dated GRANT, not a column and not supervision.**
    Decision item 10 put user-level authorisation in the CRM, and until now that meant
    exactly two things: *is this your record* and *do you supervise this rep*. Both are
    answers about a rep's own work. Neither can govern a **tenant-wide parameter**, and two
    increments in a row proved it by declining to build an admin write route at all —
    `crm.disposal_policy` (0020) and `crm.notification_endpoint` (0021) were settable only
    at a psql prompt, which means settable by anyone holding the application password, with
    no record of who changed what.

    **Two roles, held by nobody implicitly:** `administrator` configures the tenant (where
    its signals are pushed, and who holds roles); `compliance` owns the SOP parameters reps
    are measured against (the disposal grace period, the promo auto-write-off switch). The
    list is a CHECK constraint, not a lookup table — a role nothing checks is worse than no
    role, so adding one should require a migration *and* the route that honours it.

    **A grant, because the question an auditor asks is dated.** "Who was the compliance
    officer when this obligation went overdue" cannot be answered by a column on
    `rep_profile`; `crm.rep_role` is effective-dated like territory assignment (0010), with
    `granted_by` / `granted_at` / `revoked_by` / `revoked_at` and reasons on both ends. The
    row is the audit trail, so it is append-only: a grant may be *ended*, never edited or
    deleted, and the one permitted UPDATE is a revocation from unrevoked to revoked.

    **Supervision is deliberately not accepted in its place.** A district manager is the
    most privileged principal the CRM had before this, and a tenant-wide SOP parameter is
    precisely what they must not change — their own team is measured against it. The two
    predicates (`crm.rep_can_supervise`, `crm.rep_has_role`) stay separate and no route
    takes either for the other.

    **Four eyes, and the lockout that follows from it.** Nobody grants themselves a role and
    nobody revokes their own. That is the same rule as a call-plan approval (0015), and it
    has a consequence worth stating plainly: a tenant with no administrator **cannot be
    given one through the API**, because a grant cannot name its own holder as grantor. So
    the last administrator leaving is a one-way door, and both ways through it are closed in
    the database — revoking the last administrator is refused, and so is taking their
    profile off `active`, since `crm.rep_has_role` requires an active profile and HR is
    therefore the same door as security. A one-day gap is refused too: an
    administrator-less day is a locked-out day, and the remedy is to date the successor's
    grant from the same day rather than accept the gap.

    **The first administrator of a tenant is inserted in SQL**, by whoever runs the
    migrations. Not a gap — a closed system has to be started from outside it, and an API
    that could mint its own first administrator would be a way in.

    **Built** (`packages/role/`, migration 0023, `requireRole` in `@crm/api`). Five things
    the implementation learned:

    - **`valid_to = valid_from` must be allowed.** It is an *empty* half-open range: a grant
      made and revoked the same day, which is the normal shape of correcting a mistake
      within the hour. Refusing it would force the corrector to backdate the revocation or
      delete the row, and deleting it is what the append-only trigger exists to prevent.
      Because an empty `daterange` overlaps nothing, the exclusion constraint keeps ignoring
      it, so the correction does not block a fresh grant the same day. Both halves were
      verified live.
    - **A revocation must be clamped INTO the grant's window, not written over it.** Written
      the obvious way — `valid_to = GREATEST(on_date, valid_from)` — revoking a lapsed
      interim appointment after its end date would hand it the extra months back.
    - **Tenant scoping cannot be left to RLS here, and the test suite cannot catch that.**
      The first `crm.revoke_rep_role` matched on the grant id alone. The API contract suite
      connects as `postgres`, a superuser, which bypasses row-level security even under
      `FORCE` — so the call succeeded and a rep of one tenant ended a grant in another. The
      fix is the convention every other store already follows (`AND tenant_id = $n`), and
      the policy is the backstop rather than the check. Confirmed afterwards against the
      real `api` binary running as `crm_app`, where RLS *is* in force and the answer is 404.
    - **The lockout guard answers before the four-eyes CHECK.** `BEFORE UPDATE` row triggers
      run ahead of constraint evaluation, so an administrator who is the only one and tries
      to revoke their own grant gets the 409 lockout refusal, not the 403 self-revoke one.
      Both are correct; the order is pinned by a test, because a client that only ever saw
      the 409 would report the wrong reason. Reaching the 409 *legitimately* over HTTP takes
      a future-dated revocation that outlives the caller's own grant — an interim
      administrator scheduling the permanent one's departure.
    - **A `COALESCE` omitted from one date comparison emptied the whole listing.** With no
      `asOf`, `r.valid_from <= $4::date` was NULL, the filter was NULL, and the live grant
      list came back empty — indistinguishable from "nobody holds a role". Every function in
      0023 defaults to `CURRENT_DATE`; the one query that did not, lied.

    Roles are resolved **once per request, with the principal, as of today** — never as of a
    `?on=` parameter, which several reads honour. A date on the path that authorises a write
    is a date somebody eventually passes from a query string.

14. **The application role is enforced at runtime, not merely configured.** Decision item
    2 made ownership and role separation the isolation guarantee, and `deploy/README.md`
    has always said what happens if an application process connects as the admin: "every
    query would see every tenant's rows and every RLS policy in the schema would be
    decoration." That sentence was true, load-bearing, and checked by nothing.

    `withTenantContext` — already the only sanctioned way to reach a `crm.*` table — now
    asks the server which role its statements will actually run under and **refuses** a
    role that is `SUPERUSER` or `BYPASSRLS`. It reads `current_user`, so it follows a
    `SET ROLE` rather than reporting whatever the connection was opened with, and it
    fails closed on a role the catalog has no row for. `GET /healthz` reports the same
    condition as `503 degraded` naming the role, so an orchestrator never sends traffic
    to a deployment that cannot serve a single tenant request.

    **The cost is the design.** Asking the catalog for the role's attributes in the same
    statement as `set_config` measured ~82 µs per transaction against a live cluster —
    too much to pay on every request. Asking only for `current_user` is free. So the
    attributes are looked up separately and cached **by role name**, once per distinct
    name per process: keyed on the name rather than on the client, because a connection's
    role changes under `SET ROLE` and a per-client cache would answer for whichever role
    it saw first. Warm, the guard is free within measurement noise (median ~3 µs over
    interleaved rounds of 2,000 transactions).

    **What the contract suite was proving, and was not.** The API suite handed the ADMIN
    pool to `startApi`, so every route in it ran as a superuser and row-level security was
    switched off for the whole suite. Three more suites did the same for the scheduler,
    the outbox relay, the snapshot refresher, the service-credential boot and the
    per-tenant ERP role source. The worst case was `role-source.contract.test.ts`, whose
    fixture inserted `crm.erp_service_principal` rows **with no tenant context at all** —
    something only a privileged connection can do — and then asserted that each tenant
    "never" sees the other's role. That assertion was about a `WHERE` clause on data
    written outside any policy. All of these now connect as `crm_app` and seed through
    `withTenantContext`, and `appPool()` in `@crm/db/testing` is the one place that choice
    is made, with the reason attached.

    **Verified** by deliberately putting the misconfiguration back: pointing the API
    suite's pool at the admin role again fails 97 of its 113 tests immediately, so the
    blind spot cannot return quietly. Then live, through the real binaries against a real
    Postgres — as `crm_app`, `/healthz` 200 and `/v1/me` 200; as the admin role,
    `/healthz` 503 naming the role and the remedy, `/v1/me` 500 with a generic body and
    the full reason in the structured log, and the scheduler reporting `tick_error` per
    tenant rather than doing the work with RLS off.

    One thing worth recording about what this does NOT do: it would not have caught the
    cross-tenant write in item 13. That defect relied on no tenant predicate at all, and
    with RLS genuinely in force the policy stops it — which is the point. The guard makes
    RLS *apply*; the explicit `AND tenant_id = $n` in every store is the second layer. The
    suite now exercises both instead of neither.


15. **An inbox has two retention horizons, and an unfinished subject outlives both.**
    `crm.notification` grew without bound — every signal the CRM had ever raised stayed in
    the table, read by an index that grew with it. ADR-0001 recorded this twice, both
    times with the same blocker: a retention period is a tenant's decision and there was
    no principal to restrict the setting to. Item 13 answered that half.

    **Two horizons, not one** (`crm.notification_policy`, migration 0024): 30 days for a
    read notification, 365 for an unread one. A read notification has done its job; an
    unread one has NOT, and deleting it deletes a message nobody ever saw. A CHECK forbids
    the unread horizon from being the shorter of the two, so `read=90, unread=7` is refused
    rather than quietly losing exactly the notifications that still mattered — and it is
    enforced on a PARTIAL update too, because raising only the read horizon above the
    stored unread one is the same mistake arriving from the other side.

    **What makes pruning safe at all** is that a notification is a COPY of a signal. The
    obligation, the dead letter, the transfer and the plan live in their own tables and a
    prune never touches them, so it loses an inbox entry and never a fact.

    **What makes it correct** is the exemption that follows from that: a notification about
    something UNFINISHED is not old news, however old it is. `crm.notification_subject_open`
    decides, with one branch per producing table — an obligation still `open` or `overdue`,
    an ERP write still `dead`, a `transfer_out` with no acceptance recorded against it, a
    call plan still `submitted`. Each branch is tested with BOTH answers, because a
    predicate that always says "open" and one that always says "closed" both pass a
    one-sided test. A webhook push still pending, in flight or dead holds a notification
    back too: `crm.notification_delivery` cascades from this row, so pruning would erase
    the evidence that a push failed along with the thing it failed to push.

    **An unknown subject table prunes, and is counted.** That is deliberately the opposite
    of fail-closed, and the reasoning is specific to what is being fixed: the failure here
    IS unbounded growth, so "keep forever when unsure" would reintroduce it silently for
    any kind whose producer forgot a branch. The job reports `unknownSubjects` instead —
    the same trade `crm.outbox_recipient` (0022) makes with its unattributed rows, where
    the alternative to counting it is never finding out.

    **Capped at 50,000 rows a pass**, reporting `moreRemaining`. A tenant turning retention
    on after a year of growth has a backlog, and deleting all of it in one transaction
    holds a snapshot open for as long as it takes; the job runs again tomorrow. Oldest
    first, so a capped pass is not an arbitrary slice.

    **The role is `administrator`, not `compliance`**, and the compliance officer is
    explicitly refused. The disposal policy next door is `compliance` because it is an SOP
    parameter reps are measured against; retention is a statement about the system's own
    storage and no rep's performance turns on it. That the regulated facts survive a prune
    is what makes the split defensible rather than a coin toss. Reading it is open to every
    rep, like the disposal policy: a rep whose notification disappeared is entitled to know
    it was a rule and not a bug.

    Also landed, as the insurance item 14 asked for: a schema test that **no `crm` function
    is `SECURITY DEFINER`** and no `crm` view is owned by a role that bypasses RLS. Item
    14's guard asks which role a CONNECTION runs under, which is the wrong question for a
    definer function — it runs as its owner, so one owned by a privileged role would read
    every tenant's rows whoever called it, and the guard would have said yes. Verified by
    adding such a function on purpose and watching the test name it. The new
    `crm.notification_prune_candidates` view is owned by `crm_app`, which is subject to the
    policies, and its tenant scoping was checked live rather than reasoned about.

    **Verified** live: the retention routes through the real `api` binary as `crm_app` (a
    rep reads the policy and is refused the write; the administrator shortens the unread
    horizon to 200 days; `unread < read` comes back 422 with its sentence intact; the
    candidate listing shows `open=true` on the dead-ERP-write row and `unknown=true` on a
    made-up subject table), and then the job through the real `scheduler` binary, which
    reported `deletedRead=2 deletedUnread=0 keptSubjectOpen=1 keptDeliveryUnsettled=0
    unknownSubjects=1 more=false retainRead=30d retainUnread=200d` — picking up the 200-day
    horizon set over HTTP minutes earlier, which is the two halves proving they are wired
    to each other.

16. **A transfer can be taken back, and the ledger says so twice.** A `transfer_out`
    moved material out of the sender's `quantity_on_hand` and into their
    `quantity_in_transit`, where it stayed forever if the receiver never accepted — the
    sender had no way to retrieve it and an adjustment only touches `on_hand`. The recall
    (migration 0025) is a NEW ledger kind, never an edit: the material went out and came
    back, and both halves stay in the log. `crm.sample_effect` is still the one place
    direction is decided.

    **Exactly one terminal event per transfer**, and the symmetry is the point: an
    accepted transfer cannot be recalled, a recalled one cannot be accepted, and the
    refusal names which event already happened and when — the sender needs to know the
    material is somebody else's now. A partial recall is refused, because the remainder
    would be stranded with no second terminal event able to clear it.

    **Only the sender may recall**, since it is their transit balance the recall draws
    down; a receiver refusing delivery is a different act and is not built. That refusal
    is a **403**, not the 404 the supervision helpers return, because an outstanding
    transfer is already visible to both reps and hiding it from the one who can see it
    buys nothing.

    **An expired or withdrawn lot is deliberately NOT refused** — the same reasoning 0020
    gives for not refusing a `transfer_in`. Material already in custody has to be
    somewhere, and refusing the only exit from transit strands it with nobody accountable,
    which is the bug being fixed. A withdrawn lot is the likeliest reason to recall.

    **And the receiver is told** (`sample_transfer_recalled`, migration 0029).
    `transferOut` told them material was waiting; after a recall that notification names
    stock in somebody else's bag, and a rep who goes looking for it has been sent on an
    errand by us. The correction is raised in the same transaction as the ledger row.

17. **A prune may be refused for taking too much, and the way past it expires.** Item 15
    shipped with its own objection recorded: a prune is irreversible, so the two horizons
    were the only thing between a tenant and a deleted inbox, and an administrator who
    means to type 365 and types 1 loses a year of unread messages that night.

    The guard (migration 0026) is a **share** — 25% of the inbox by default — not an
    absolute row cap. The choice is the design: a cap of 5,000 stops a tenant with two
    million notifications from ever running a legitimate steady-state prune, and a cap of
    500,000 lets a tenant with 800 lose all 800 unnoticed. The failure being defended
    against is a horizon wrong by an order of magnitude, and that failure has the same
    signature at every scale — it takes most of the inbox at once, where a correct nightly
    prune takes a day's worth. An absolute number appears anyway, as a **floor**
    (`prune_guard_floor_rows`, 100): beneath about a hundred rows the ratio is noise, and
    a guard that refuses nightly becomes a nag operators learn to override by reflex.

    **It refuses wholesale and deletes nothing.** A half-applied prune is still
    irreversible and leaves the operator unable to tell whether the number in front of
    them is the whole mistake or a slice of it.

    **Measured against what the pass WANTS, not what tonight would take.** The 50,000-row
    batch cap is a throttle; judging the guard on the batched number would let a
    two-million-row inbox with a one-day horizon propose 2.5% every night, pass every
    night, and empty itself in forty passes with no refusal ever logged. A pass that hits
    the batch cap is normal; a pass that trips the guard is not.

    **The override is a window, not a flag**, and that distinction is the whole value. A
    boolean — or a `force` option on the job — gets set once for one night's reason and
    then outlives the reason, silently, leaving the next horizon typo unguarded. This one
    names who opened it, expires on its own, is capped at seven days by a CHECK, and takes
    an `hours` argument with no default, because a caller that must say how long is a
    caller that has thought about how long. Every pass it admits reports `overridden`.

    The ceiling stops at 99: a ceiling that permits 100% is not a ceiling, and stored as a
    number it would read like a configured value rather than a disabled guard.

18. **The outbox has a monotonic sequence, and the claim order is now observable.** Two
    rows enqueued in one transaction shared `created_at` to the microsecond, so
    `ORDER BY next_attempt_at, created_at` did not order them — a create and the
    transition acting on it could be dispatched either way round.

    What the sequence guarantees and what it does not is the useful part. It gives a total
    order WITHIN one transaction, which is the actual problem. It does **not** make the
    order gap-free — a rolled-back enqueue burns a value permanently, and so does an
    `ON CONFLICT DO NOTHING` collapse, because the column default is evaluated before the
    unique index is consulted — so nothing may read `seq` as a count. And ACROSS
    transactions it is allocation order, not commit order: a lower `seq` can become
    visible later and be claimed by a later drain. The `retry_ordering` classification
    therefore **stays**, as the backstop for the case the sequence does not fix.

    **The sequence alone would have fixed nothing**, which is the finding worth keeping:
    `UPDATE … WHERE id IN (SELECT … ORDER BY …) RETURNING` does not return rows in the
    subquery's order, it returns them in the order the update's scan found them. The claim
    is now a sorted SELECT over a data-modifying CTE, and that is the half that is
    actually observable.

19. **A 409 from the ERP is not one thing, and reading it as success was dropping
    writes.** `classify` treated every `kind === "conflict"` as `already_delivered` —
    correct for the duplicate target id it was written for, and wrong for the other thing
    the ERP answers 409 to: `invalid_transition`, which means the write did not land and
    never touched the record. The outbox row was marked delivered and the transition
    silently lost, leaving the CRM and the ERP disagreeing about a record's state with
    nothing anywhere reporting it.

    Found by reading, not by a failing test, while building the expense posting — which is
    the kind of multi-row transition chain that makes it bite. Now classified as
    `retry_ordering`, for the same reason a 404 on a transition is: the sibling write that
    moves the record into the right state is very likely still queued behind. If the state
    is genuinely unreachable, the attempt cap ends it and the dead-letter alarm puts it in
    front of a human, which is where a disagreement no retry can settle belongs. Pinned by
    tests that were confirmed to fail against the old classification.

20. **Email is a real channel now, and the reason it was not is worth recording as
    wrong.** This ADR carried "no email or SMS sender" as open, with the justification
    that an SMTP client "could not be verified from here and the ERP's own stack shows
    where unverifiable senders end up". The first half was simply false: a minimal SMTP
    sink is a few hundred lines, and writing one makes the client verifiable end to end.
    The lesson is not about email — it is that "cannot be verified" deserves a second look
    before it becomes a reason not to build something.

    No new dependency (`node:net`, `node:tls`). The classification is the heart of it:
    4xx retries, 5xx dead-letters, and a positive code at the wrong stage is dead because
    the conversation has lost step. Getting that backwards means either a bounced address
    retried forever or a greylist — extremely common, and a 4xx — thrown away. TLS is
    required by default and refused in the CONSTRUCTOR rather than per send, so a relay
    configured without it fails the scheduler at boot instead of dead-lettering
    everything; certificate verification is genuinely exercised, with an untrusted
    certificate yielding a retry and nothing sent. Subjects are RFC 2047 encoded, because
    this product's locales include Arabic and a raw 8-bit header is a real bug here.

    Migration 0029 was needed before any of it could be configured: `channel` admitted
    only `'webhook'`, so the channel had no legal value. The url shape is now per channel
    rather than a flat disjunction — the flat version would have accepted a webhook
    pointed at a mailbox and an email endpoint pointed at an HTTPS host, two
    configurations with no sender and no error.

21. **Expense claims are built end to end, and the Finance dependency is now a single
    row.** `crm.expense_account_map` and `crm.expense_claim` had existed since migration
    0006 with not one line of TypeScript. `packages/expense` is the lifecycle
    (`draft → submitted → approved → posted → reimbursed`, with `rejected` from
    `submitted`), the account map, and the outbox payload.

    The behaviour the whole design rests on: **submitting a claim whose category has no
    active mapping is refused**, with a sentence naming the category, the table, and the
    `LedgerAccount.account_code` Finance must supply. That refusal reached clients as a
    **500 "an unexpected error occurred"** until it was caught in live verification —
    every one of the package's twelve errors fell through, because the structural test in
    `problems.test.ts` did not cover the new package. It does now, which is the fix that
    matters: the test exists precisely to catch a new domain package, and it only works if
    the package is in its list.

    The account is **snapshotted at submit**, not read at posting time, so re-mapping a
    category next quarter cannot re-attribute a claim already submitted. Two guards sit in
    TypeScript rather than SQL because Postgres will not provide them, both verified
    against the live cluster: `'NaN'::numeric(14,2) > 0` is TRUE, so 0006's
    `CHECK (amount > 0)` admits a NaN that would poison every `sum(amount)`; and
    `'us'::char(3) = 'us '` is TRUE, so `currency` pads rather than refusing.

    **The journal entry is NOT posted**, and the reasons are in the Still-open table
    rather than worked around. An `Expense` record posts and carries the account and cost
    centre in its description so the manual journal entry is readable off it. Item 11 says
    the entry posts "on reimburse"; 0006's `idx_expense_claim_unsent` and the existence of
    a `posted` state before `reimbursed` both say approve→post, and the schema is right —
    the GL recognises the expense when it is approved, not when cash leaves. That text
    wants reconciling.

22. **Test files are typechecked now, and were not before.** Every package excludes
    `src/**/*.test.ts` from `tsc` — correctly, so tests are not emitted into `dist` — and
    vitest transpiles without typechecking. The consequence went unnoticed for the whole
    life of the project: not one of ~1,100 tests was ever typechecked, in a codebase whose
    stated discipline is strict TypeScript with no `any`.

    What it hid, found the hour the gate was written: `outcome.test.ts` typed its ErpError
    `kind` through `Parameters<typeof ErpError>`. A class is not callable, so that fails
    its constraint and the parameter collapsed to `never` — meaning the test that proves
    ERP write-guard codes are told apart by CODE and not by status was providing no type
    safety at all on the codes. `scheduler.contract.test.ts` had the same mistake via
    `typeof X.prototype.constructor`. Both passed at runtime; both were lying about what
    they checked. `pnpm typecheck:tests` is now a CI gate, and it caught two more real
    violations in code written the same day, including one of this session's own.

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
7. Only then: visits, call plans, sample custody, offline sync. **All built** (migrations 0012–0019), with the manager-facing views over them.

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
| **Which `LedgerAccount.account_code` is the S&M expense account per tenant?** Unchanged as a question and now the ONLY thing standing between a rep and a filed claim: `packages/expense` is built, and submitting a claim whose category has no active `crm.expense_account_map` row is refused with a 409 naming the category, the table and what Finance must supply. One row per category is the whole unblock. | Finance | _set a date_ |
| **The JournalEntry still cannot be posted, for three reasons beyond the account code.** (a) `JournalLine.ledger_account_id` is a record REFERENCE and the CRM holds a code; ADR item 11 says it is "resolved at posting time via `resolveAccountId`", but that is a private function inside the ERP's `write-effects.ts` and is not on the HTTP API, and `packages/sync` projects no `LedgerAccount`, so no code→id path exists today. That is a hole in item 11's reasoning, not an omission in the code. (b) There is no employee-reimbursements-payable account anywhere in either system: `FinanceSettings` has `apAccountCode` (supplier AP control) and `cashAccountCode`, and crediting either mis-states something — AP would carry an employee liability with no `Bill` behind it, cash would assert money moved before it did. (c) One ERP scope cannot do both halves: `Expense.create` excludes `controller` while GL writes require it, so a tenant wanting both must grant `erp_admin`, which is wider than item 11's security note contemplated. The `Expense` record posts today and carries the account and cost centre in its description so the manual journal entry is readable off it. | Finance + Security | _set a date_ |
| Which `CostCenter.code` (if any) to hook per category. Optional by design — NULL posts to the account with no dimension. `CostCenter.segment` has no `functional` value (`operating\|geographic\|product\|service\|other`), so S&M would sit under `operating`. | Finance | _set a date_ |
| Does the CRM need more than one S&M account (e.g. splitting congresses from detailing samples), or does one account with cost-centre and CRM-side category reporting suffice? The map is per-category already, so several accounts cost nothing structurally. | Finance | _set a date_ |
| Which OIDC IdP for human login (Q8 tier 1), and does the CRM service credential holding `controller` (needed for the GL posting in item 11) pass security review? The credential itself is built; the question is whether `controller` per tenant is the right grant, and it is per-tenant configuration (`crm.erp_service_principal`) so narrowing it costs nothing structurally. | Security | _set a date_ |
| Where does the signing key live? Ed25519 signing is not offered by every managed key service and the ERP accepts nothing else, so this is a real constraint rather than a preference. Until it is answered the key is a PEM in a secret, loaded into the scheduler's memory at boot. | Security | _set a date_ |
| Has a CRM-minted token been accepted by a **running** operate-server? The acceptance test transcribes the ERP's verifier (alg, kid, both base64 conversions, which claims it checks) and passes, but no live handshake has happened — no ERP instance was available. | Platform | _set a date_ |
| Staleness budget per snapshot table (item 8) — how old may a product price or a rep roster be on a mobile device before the UI blocks the action rather than warning? | Product | _set a date_ |
| Does the platform have a date for `meta.webhook_deliveries` (Q9)? Affects only when we retire `PollingChangeSource`, not whether we build it. | Platform | _set a date_ |
| Sample custody: may a rep declare their own receipt of stock? `POST /v1/samples/receipts` has the rep confirm it, because no warehouse-side admin surface exists yet. The stronger model is warehouse-initiated issue with rep acknowledgement. What makes the weaker one defensible meanwhile: the ledger is append-only, every correction carries a reason, and the cycle count reconciles against physical stock. | Compliance | _set a date_ |
| Signature images have nowhere to live. `signature_sha256` commits to what the device captured; the blob needs the object storage report §13 records as absent. Until then a disbursement says a signature was taken and fixes which one, without being able to produce it. | Product | _set a date_ |
| Controlled substances are flagged (`sample_lot.controlled`) and not otherwise handled. Unit-level serial custody is a stricter obligation than this schema discharges. | Compliance | _set a date_ |
| `crm.outbox_recipient` maps three producing tables to a rep (sample movements, visits, expense claims) and returns NULL for anything else. A new producer needs a branch added — deliberately a visible act in a diff rather than an inference — and until then its dead letters are unattributed: counted by the relay, listed with a null rep, and reachable only through SQL. | Platform | _set a date_ |
| A dead letter keeps only its LATEST reason. `revive_count` says a row has died more than once but not why each time. A per-attempt history belongs in its own table if one is ever needed, not in more columns on `crm.outbox`. | Platform | _set a date_ |
| Nothing picks up `ALTER ROLE crm_app BYPASSRLS` on a running system. The privilege verdict is cached per role NAME for the life of the process, because asking the catalog costs ~82 µs and asking it on every transaction is the wrong trade. A restart notices; so does `/healthz` in a new process. Altering the role is a superuser action on a role the deployment creates `NOSUPERUSER NOBYPASSRLS`, so the exposure is an operator deliberately widening their own application role. | Platform | _set a date_ |
| Deleting a notification takes its `crm.notification_delivery` rows with it, by the `ON DELETE CASCADE` migration 0021 wrote. So the retention period for a notification is also the retention period for the record of where that signal was pushed — which is coherent (the policy says the tenant no longer keeps this) but means delivery history cannot be retained longer than the notification it describes. Separating them needs the delivery rows to stop depending on the notification row. | Platform | _set a date_ |
| A recall can reset a disposal deadline, and now one party can do it alone. If a rep's expired stock reaches zero by `transfer_out`, the sweep resolves the obligation as `transferred`; a recall puts the stock back and the next sweep raises a NEW obligation with a fresh `discovered_on` and `due_by`. Two reps could already achieve this by bouncing a transfer between them — the recall makes it unilateral. The fix is in 0020's territory: re-open the resolved obligation rather than raise a new one, or key the deadline to the lot's expiry rather than to discovery. | Compliance | _set a date_ |
| The SMTP sender has never spoken to a real mail server. It is verified end to end against a sink written alongside it — reply classification at every stage, dot-stuffing, RFC 2047 subjects, STARTTLS with certificate verification, AUTH PLAIN and LOGIN — and the sink is faithful to RFC 5321/3207/4616 as far as it goes, but it is not Postfix, Exchange or SES. Untested in the wild: PIPELINING, a relay that enforces SIZE rather than advertising it, reply codes outside the ranges covered, and whether a given provider accepts `8bit`. It also does no DKIM signing, which is not claimed anywhere. | Platform | _set a date_ |
| No route and no scheduler job calls `postClaim`; a human does, through `POST /v1/expenses/{id}/post`. Deliberate — `idx_expense_claim_unsent` ("approved, not yet handed over") only means anything if posting is a separate act — but it means an approved claim sits until somebody presses the button. A sweeper over `unpostedApprovedClaims` would want a new `scheduled_job` kind. | Product | _set a date_ |
| `crm.expense_claim` has no `rejected_by` / `rejected_at`, so WHO rejected a claim is not recorded. Overloading `approved_by` was rejected as a fix: a rejecter stored in a column named `approved_by` reads as an approval to every query that does not know better, the four-eyes CHECK's own wording included. It wants two columns and a migration. | Compliance | _set a date_ |
| `packages/acl/schema/baseline.json` holds TWO entities — `Item` and `Opportunity`. `Expense`, `JournalEntry`, `JournalLine`, `LedgerAccount` and `CostCenter` are all absent, so the expense payloads are typed by hand against the ERP's manifest rather than against generated code, and `posting.test.ts` names every field so a typo fails a test rather than a request. The same is already true of `StockMovement` in the sample mirror. Re-capturing the baseline against a server serving the full `pack-erp-core` would close it; rule 3 is not violated, because that rule is about paths and filters and this write resolves its slug from the tenant's live `/v1/meta/schema`. | Platform | _set a date_ |
| `crm.notification_subject_open` has a branch per producing table and nothing enforces that the set of branches matches the set of producers. A new producer that sets `subject_table` without adding a branch prunes at the normal horizon; the job's `unknownSubjects` count is the only signal, and only after the fact. The same shape as `crm.outbox_recipient` (0022) and open for the same reason — a test that derives the producer list from the code would have to parse it. | Platform | _set a date_ |
| A role grant's `granted_by` / `revoked_by` are plain FKs to `crm.rep_profile (id)`, as every rep-profile reference in this schema is. Nothing but RLS and the explicit tenant match stops one naming a profile in another tenant. A composite `(tenant_id, id)` FK would close it structurally, and changing the convention for one table would be worse than leaving it stated here. | Platform | _set a date_ |
| Roles cover the two administrative surfaces that exist (`crm.disposal_policy`, `crm.notification_endpoint`) and nothing else. `crm.cycle`, `crm.territory`, `crm.territory_assignment`, `crm.sample_lot` and `crm.expense_account_map` are still SQL-only — not oversight: each needs a decision about *which* role owns it, and inventing roles ahead of the routes that honour them is how a permission model becomes decoration. | Product | _set a date_ |
| There is no `GET /v1/admin/notification-endpoints/:id/test` — no way for an administrator to confirm that the environment variable their endpoint names actually holds a secret. The API cannot answer it: the sender runs in the **scheduler** process and reads a different environment, so a check in the API would report confidently about the wrong one. A test-send route would have to be driven by the scheduler, or the verdict recorded by it and read here. | Platform | _set a date_ |

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
