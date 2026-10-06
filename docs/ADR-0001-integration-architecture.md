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

   **Corrected 2026-10-05, from the live gate.** The `Idempotency-Key` is per dispatch
   EPISODE, not per row: `crm-<row id>-r<revive count>`. A fixed-per-row key meant a
   revived write re-asked under a key the gateway had already answered, and that store
   keeps a reply's status without its body — so a second 422 arrived bodiless, failed both
   error parses, and the death history recorded `rejected: unrecognised_error_shape` where
   the first episode had the ERP's own sentence. The operator who pressed retry was told
   less than before they pressed it, and `is_repeat_of_previous` called an identical cause a
   new one. A revive asks what the ERP says NOW; it has to ask in its own name. Safe
   because, exactly as this item says, the dedup that matters is the record-id constraint:
   a write that already landed collides on the id and settles `already_delivered`, proved
   live with the driver message stripped (`docs/LIVE_ERP_VERIFICATION.md` §6i).

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

    **Correction (2026-10-05), from a live run — see `docs/LIVE_ERP_VERIFICATION.md`.**
    That cross-check is **conditional on the claim being present**. The gateway's test is
    `authTenant !== null && headerTenant !== null && authTenant !== headerTenant`
    (`api-gateway-runtime/src/auth.ts`), and `principals.ts` sets the principal's tenant to
    `null` for a `tenant_id` claim that is absent or not a UUID — so a validly signed token
    carrying no usable tenant claim is accepted with `x-tenant-id` **alone** selecting the
    tenant. One signing key plus a header then reads any tenant. Verified live: 200 with
    the correct rows, and 200 again with no header at all (falling back to the claim).

    So the claim is authoritative **when present**, and what guarantees it is present is on
    OUR side: `mintServiceToken` refuses a non-UUID `tenantId`. That check was written as
    tidiness — its own comment says the ERP "sets the principal's tenant to NULL and the
    request proceeds without one" — and it is now a load-bearing security control. It must
    not be relaxed, and the live gate asserts it beside the gap it covers.

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
      schema (`expense_claim_four_eyes`, and `expense_claim_reject_four_eyes`
      since 0030) because nothing downstream will: the ERP's `Expense` workflow
      is a flat role check that never reads `Employee.manager_id`, has no amount
      bands and no separation of duties, so the same principal can submit and
      approve (report R7).
    - **"In the schema" is not enough on its own, and finding out why cost a
      shipped hole.** A CHECK can only compare columns the table has, so it
      covers `approve` and `reject` — which record an actor — and cannot cover
      `post` or `reimburse`, which do not. Those two gated on supervision alone,
      and `crm.rep_can_supervise` answers yes for the caller themselves, so a rep
      could hand their own claim to the ledger and mark it paid. The rule now
      lives in the route for all four, which is also where a refusal can say
      which rule was broken; the CHECKs stay as the backstop under it.
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

    **Correction (2026-10-05): 0029 was necessary and not sufficient, and this item said
    otherwise.** It claimed the channel could now be configured. It could not.
    `createEndpoint` wrote `'webhook'` as a LITERAL in its INSERT, so no route could name
    the channel 0029 had just legalised, and nothing outside the tests ever called
    `new SmtpSender` — so the boot-time TLS refusal this item makes a point of was
    unreachable, and a row inserted by hand produced permanently dead deliveries. Three
    independent gaps, each of which had to close for the channel to exist:
    `createEndpoint` now takes a required `channel` with no default; the scheduler builds
    the sender at boot when `SMTP_HOST` is set, and reports the channels it registered on
    its first log line; and a delivery for a channel this process has no sender for
    RETRIES with a readable reason instead of dead-lettering, because a missing sender is a
    fact about the binary and not about the destination.

    One more thing this item got wrong by implication. The encoding was chosen from
    `payload.body` while the message was built from a composed body that also carries the
    recipient's `displayName` — so the Arabic case it makes a point of handling was the
    case it got wrong: an English notification to a rep named in Arabic went out declaring
    `7bit` over raw 8-bit octets. Verified now against a real SMTP conversation driven by
    the real scheduler binary: `8bit` with the name intact where 8BITMIME is offered,
    `base64` where it is not.

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
   backoff with jitter, dead-letter, lag metric. Unique-violation-on-replay = success —
   but **not via a 409**, which is what this said and what `classify`'s own
   `kind === "conflict"` branch expects. The live server answers a duplicate record id
   `500 {"error":"write_failed","detail":"duplicate key value violates unique constraint …"}`,
   because `operate-runtime/src/handlers.ts` forwards `e.message` verbatim. That normalises
   to `unavailable`, so only the `ALREADY_EXISTS` regex over `detail` rescues it. See the
   open table: the guarantee currently rests on the ERP leaking node-postgres's message to
   clients.
6. **Typed snapshot tables + incremental refresh** on `updated_at`, with a one-command
   full rebuild exercised in CI. These are the read path, not an optimisation (item 8) —
   every numeric filter and sort in the product depends on them, because the ERP cannot
   answer one correctly (R19).
7. Only then: visits, call plans, sample custody, offline sync. **All built** (migrations 0012–0019), with the manager-facing views over them.

**API details that will bite** (all evidenced in the report):

- `x-tenant-id` is load-bearing — a JWT principal's tenant comes from the header, and the
  gateway cross-checks it against the token **only when the token carries a usable tenant
  claim**. See the correction in item 10: our minter's UUID check is what makes that
  condition hold.
- List envelope is `{ data: [...], page: { limit, nextCursor } }`; read/create/update
  return the bare record; delete returns `204`.
- Pagination is keyset, `?cursor=`, `?limit=` capped at 500. Not offset.
- Filters: `?f=v` or `?f[eq|ne|gt|gte|lt|lte|in|contains]=v`. FK fields and lifecycle
  `stateField` are filterable by default. **Unknown params are silently ignored** — assert
  on result shape, never assume a filter applied.
- Transitions are `POST /v1/<resource>/{id}/<transition>` and are role-gated only.
- `GET /v1/meta/aging` gives AR/AP buckets for rep credit checks (finance roles only).

**Rules that came out of an adversarial review of what had already shipped** (2026-10-05).
Each one is here because the code and the prose beside it disagreed, which is the failure
mode this repo is most exposed to — documentation is load-bearing here, so a comment that
has gone stale is a defect, not untidiness.

- **A reflexive predicate is right for reads and wrong for privileged writes.**
  `crm.rep_can_supervise(x, x)` is true, deliberately: it is what lets one helper serve
  "my record" and "my team's record", and a manager who could not read their own work
  would be absurd. It also meant every expense write transition — approve, reject, post,
  reimburse — admitted the claimant. Two were caught downstream by a four-eyes CHECK; the
  other two record no actor, so no constraint could ever have caught them. The lesson is
  not "add a check": it is that a predicate's correctness depends on the question being
  asked of it, and a helper named for one question must not be reused for the other.
- **A refusal computed from one value must be applied to the value actually sent.** The
  SMTP encoding was chosen from `payload.body` and the message was built from a composed
  body that also carries the recipient's name — so an Arabic rep receiving an English
  notification got `Content-Transfer-Encoding: 7bit` over raw 8-bit octets. The fix is not
  a wider check but one function producing what the other measures.
- **A channel is not shipped until a route can configure it and a process constructs it.**
  Email had the sender, the migration widening the CHECK, the README paragraph and the ADR
  item, and for one commit it was reachable only from psql and sent by nobody.
  `createEndpoint` wrote `'webhook'` as a literal and nothing outside the tests called
  `new SmtpSender`. "Both senders are real" was true of the code and false of the system.
- **A knob that short-circuits a guard is that guard's override, whatever it is called.**
  `prune_guard_floor_rows` is the left operand of the guard's `AND`, capped at a million,
  settable by the same role that opens the override window — but naming nobody, expiring
  never, and not reported as an override. 0026's own header spends four paragraphs
  explaining why an override must be a window, and then shipped one that was not.
- **A socket is a resource even when the function that created it never returns it.**
  `open()` raced a timer against `connect` and, on timeout, rejected without destroying
  the socket — which the caller's `finally` could not reach, because there was no
  conversation to wrap it in. One leaked descriptor per retry in a long-running scheduler,
  each able to complete its connect later and sit against the relay with no reader.
- **A test that needs an interleaving must produce it, not race for it.** The sweeper's
  concurrency test ran two sweeps with `Promise.all` and asserted the loser reported a
  skip; it failed about one run in five, correctly, because whether the loser SEES the
  claim depends on commit order. The deterministic version uses the database as the
  synchronisation point — a one-shot trigger on `crm.outbox` moves the second claim at the
  moment the first claim's row is written — and the real race is asserted only on what is
  genuinely invariant under it.
- **A generated file must not record where it was generated from.** The codegen header
  interpolated its source, which is a live URL on `erp:codegen` and a file path on
  `erp:codegen:baseline`, so the drift gate reported DRIFT while printing two identical
  schema hashes. The input's identity is the hash; which machine ran the generator is a
  fact about the commit, not about the types.

**A validated constraint can be added without having looked** (0035, 2026-10-05). The
plan was to let a composite foreign key refuse pre-existing cross-tenant data and fail the
migration loudly, following 0029's argument that "a constraint that is never validated is a
constraint that does not hold". Measured, that is false here. Postgres validates a new FK
with one `LEFT JOIN` over the two tables, and that is an **ordinary query** — so `crm_app`,
which owns these tables under FORCE ROW LEVEL SECURITY and holds no tenant context during a
migration, validated against **zero visible rows** and marked all 38 constraints
`convalidated = true` with a known bad row still in the table. The identical statement as
superuser refused it instantly. Per-row referential checks *do* bypass RLS, which is why
every later INSERT is correctly refused; the bulk validation does not.

So 0035 opens with a pre-flight that looks properly: it walks `crm.tenant` (the RLS-exempt
registry), derives the reference list from `pg_constraint` rather than from its own
intentions, and asks **from inside each tenant**, where RLS becomes the asset — a child row
of tenant T is visible and a parent elsewhere is not, so a cross-tenant reference shows up
as a child whose parent cannot be found. Three approaches that do not work are recorded in
the migration header so nobody retries them: a plain scan as `crm_app` sees nothing;
`SET row_security = off` is an **error** under FORCE, not a bypass; and
`NO FORCE ROW LEVEL SECURITY` for the duration would work and is refused on principle,
because it opens the exact hole that file exists to close, in the one file whose worst
failure is leaving it open.

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
| **The JournalEntry still cannot be posted, for three reasons beyond the account code.** (a) `JournalLine.ledger_account_id` is a record REFERENCE and the CRM holds a code. ADR item 11 says it is "resolved at posting time via `resolveAccountId`", which is a private function inside the ERP's `write-effects.ts` and is not on the HTTP API — a hole in item 11's reasoning. **Corrected 2026-10-05 from the captured schema:** `LedgerAccount.account_code` IS filterable, so the DEBIT account can be resolved over the ordinary API; an earlier version of this row said no code→id path existed at all and that was wrong. What remains true is that `packages/sync` projects no `LedgerAccount`, so the resolution would be a synchronous ERP read on the posting path. The COST CENTRE is the harder half and the reason this stays closed: `CostCenter`'s only filterable fields are `parent_id` and `manager_id` — `code` is not among them — and the ERP drops an unrecognised filter silently, so `?code[eq]=CC-SM` returns the tenant's first cost centre and looks like a hit. (b) There is no employee-reimbursements-payable account anywhere in either system: `FinanceSettings` has `apAccountCode` (supplier AP control) and `cashAccountCode`, and crediting either mis-states something — AP would carry an employee liability with no `Bill` behind it, cash would assert money moved before it did. (c) One ERP scope cannot do both halves: `Expense.create` excludes `controller` while GL writes require it, so a tenant wanting both must grant `erp_admin`, which is wider than item 11's security note contemplated. The `Expense` record posts today and carries the account and cost centre in its description so the manual journal entry is readable off it. | Finance + Security | _set a date_ |
| Which `CostCenter.code` (if any) to hook per category. Optional by design — NULL posts to the account with no dimension. `CostCenter.segment` has no `functional` value (`operating\|geographic\|product\|service\|other`), so S&M would sit under `operating`. | Finance | _set a date_ |
| Does the CRM need more than one S&M account (e.g. splitting congresses from detailing samples), or does one account with cost-centre and CRM-side category reporting suffice? The map is per-category already, so several accounts cost nothing structurally. | Finance | _set a date_ |
| Which OIDC IdP for human login (Q8 tier 1), and does the CRM service credential holding `controller` (needed for the GL posting in item 11) pass security review? The credential itself is built; the question is whether `controller` per tenant is the right grant, and it is per-tenant configuration (`crm.erp_service_principal`) so narrowing it costs nothing structurally. | Security | _set a date_ |
| Where does the signing key live? Ed25519 signing is not offered by every managed key service and the ERP accepts nothing else, so this is a real constraint rather than a preference. Until it is answered the key is a PEM in a secret, loaded into the scheduler's memory at boot. | Security | _set a date_ |
| Staleness budget per snapshot table (item 8) — how old may a product price or a rep roster be on a mobile device before the UI blocks the action rather than warning? | Product | _set a date_ |
| Does the platform have a date for `meta.webhook_deliveries` (Q9)? Affects only when we retire `PollingChangeSource`, not whether we build it. | Platform | _set a date_ |
| Sample custody: may a rep declare their own receipt of stock? `POST /v1/samples/receipts` has the rep confirm it, because no warehouse-side admin surface exists yet. The stronger model is warehouse-initiated issue with rep acknowledgement. What makes the weaker one defensible meanwhile: the ledger is append-only, every correction carries a reason, and the cycle count reconciles against physical stock. | Compliance | _set a date_ |
| Controlled substances are flagged (`sample_lot.controlled`) and not otherwise handled. Unit-level serial custody is a stricter obligation than this schema discharges. | Compliance | _set a date_ |
| `crm.outbox_recipient` maps three producing tables to a rep (sample movements, visits, expense claims) and returns NULL for anything else. A new producer needs a branch added — deliberately a visible act in a diff rather than an inference — and until then its dead letters are unattributed: counted by the relay, listed with a null rep, and reachable only through SQL. | Platform | _set a date_ |
| A dead letter keeps only its LATEST reason. `revive_count` says a row has died more than once but not why each time. A per-attempt history belongs in its own table if one is ever needed, not in more columns on `crm.outbox`. | Platform | _set a date_ |
| Nothing picks up `ALTER ROLE crm_app BYPASSRLS` on a running system. The privilege verdict is cached per role NAME for the life of the process, because asking the catalog costs ~82 µs and asking it on every transaction is the wrong trade. A restart notices; so does `/healthz` in a new process. Altering the role is a superuser action on a role the deployment creates `NOSUPERUSER NOBYPASSRLS`, so the exposure is an operator deliberately widening their own application role. | Platform | _set a date_ |
| Deleting a notification takes its `crm.notification_delivery` rows with it, by the `ON DELETE CASCADE` migration 0021 wrote. So the retention period for a notification is also the retention period for the record of where that signal was pushed — which is coherent (the policy says the tenant no longer keeps this) but means delivery history cannot be retained longer than the notification it describes. Separating them needs the delivery rows to stop depending on the notification row. | Platform | _set a date_ |
| The SMTP sender has never spoken to a real mail server. It is verified end to end against a sink written alongside it — reply classification at every stage, dot-stuffing, RFC 2047 subjects, STARTTLS with certificate verification, AUTH PLAIN and LOGIN — and the sink is faithful to RFC 5321/3207/4616 as far as it goes, but it is not Postfix, Exchange or SES. Untested in the wild: PIPELINING, a relay that enforces SIZE rather than advertising it, reply codes outside the ranges covered, and whether a given provider accepts `8bit`. It also does no DKIM signing, which is not claimed anywhere. | Platform | _set a date_ |
| Roles cover the two administrative surfaces that exist (`crm.disposal_policy`, `crm.notification_endpoint`) and nothing else. `crm.cycle`, `crm.territory`, `crm.territory_assignment`, `crm.sample_lot` and `crm.expense_account_map` are still SQL-only — not oversight: each needs a decision about *which* role owns it, and inventing roles ahead of the routes that honour them is how a permission model becomes decoration. | Product | _set a date_ |
| **The disposal deadline is carried per (rep, lot), so a FIRST hand-off between two cooperating reps can still move the material's effective deadline.** Closed as of 0030 for the unilateral recall path and for any pair that has each held the lot once: the sweep now asks `crm.disposal_carry_forward` and inserts a CONTINUATION obligation inheriting `discovered_on` and `due_by` verbatim, naming the row it continues. What is left open is deliberate and pinned by a test — a genuine hand-over to a rep who has never held the lot starts that rep's own grace period, because holding someone to a deadline they were never given is the mirror image of the bug. Closing it means deciding that an obligation attaches to the MATERIAL rather than to a person, which changes what the table means. | Compliance | _set a date_ |
| **`crm.outbox.created_at` is the transaction clock, and only the outbox has a `seq` to fall back on.** 0027 added one there after proving the tie; `crm.disposal_obligation` has nothing equivalent, so two obligations written in one transaction — which a catch-up sweep does — cannot be ordered at all. `disposal_obligation_chain` sidesteps it by walking `continues_obligation_id` recursively from the root rather than ordering by time, bounded at 10,000 so a hand-edited cycle fails short instead of hanging. `crm.open_disposal_obligations` would have the same problem if it ever needed a stable order. | Platform | _set a date_ |
| **The prune guard's floor is capped at 1,000 rows (0032), which is a judgement and not a derivation.** The floor short-circuits the share ceiling, so an uncapped one is a permanent unattributed bypass — it shipped capped at a million. 1,000 is ten times the default and bounds what a misconfigured floor can cost to a number an operator can read and recover from, and a pass the floor lets through is now reported as `FLOOR-WAIVED` rather than reading like an ordinary pass. What nobody has decided is whether the right number for a two-million-row inbox is the same as for an eight-hundred-row one; the honest answer may be that the floor should be a share too. | Product | _set a date_ |
| **No incremental polling is possible against `pack-erp-core` at all.** Measured from the captured baseline: 0 of 51 entities declare `updated_at` and 0 expose it as filterable. `PollingChangeSource` asks the schema and returns `mode: "full_sweep"` rather than sending a filter the ERP would silently drop, so every snapshot refresh is a full read of every entity. That is correct and expensive, and it is the strongest argument for Q9's `meta.webhook_deliveries` that exists — the alternative is the platform adding `updated_at` to the pack's filterable sets. | Platform | _set a date_ |
| **34 of 51 entities expose no sortable fields**, so a `sort` on them silently falls back to the view's default order. Keyset pagination over an unordered view can revisit and skip rows, which means a paged full sweep of those entities is not provably complete. Nothing in the CRM pages them today; the snapshot refresher reads the entities that do sort. Worth knowing before anything new pages one. | Platform | _set a date_ |
| **A channel with no sender in the running process now RETRIES rather than dead-letters**, which is right (a missing sender is a fact about the binary, not the destination, and the notification is deliverable the moment a process that has the channel takes a tick) and bounded (`markRetry` gives up at `MAX_ATTEMPTS`). But it means a channel nobody ever registers burns five attempts per delivery before dead-lettering, and nothing warns an operator that their endpoint's channel is unsendable until the first delivery is already late. A boot-time check against the distinct channels in `crm.notification_endpoint` would say it once, at the right moment. | Platform | _set a date_ |
| **The CRM's idempotency guarantee rests on the ERP leaking a driver message to clients.** A redelivery of a write that already landed must read as success, or the relay retries to the cap and raises `erp_write_failed` at a rep for a write that is fine. The live server answers a duplicate record id `500 {"error":"write_failed","detail":"duplicate key value violates unique constraint …"}` — `handlers.ts` forwards `e.message` verbatim — which normalises to `unavailable`, not `conflict`, so `classify`'s own conflict branch never fires and only the `ALREADY_EXISTS` regex over `detail` saves it. Pinned in both directions by the live gate: with the driver text, `already_delivered`; same status and code with the text removed, `retry_transient`. **If the platform ever stops leaking that string — which it should — this breaks silently and in the expensive direction.** Closing it means asking for a stable error code, or having the relay re-`GET` the target record on an ambiguous 500; the second is a design change, not a defect fix, so it is a decision rather than a task. | Platform + us | _set a date_ |
| **The ERP's JWT-vs-header tenant cross-check is conditional on the claim being present** (item 10's correction). A validly signed token with no usable `tenant_id` claim is accepted with `x-tenant-id` alone selecting the tenant, so one signing key plus a header reads any tenant. ERP-side defect, reported and deliberately not fixed — `/home/user/CrossEngin` is read-only this phase. We are not exposed because `mintServiceToken` refuses a non-UUID tenant, which means that check is now a security control and must be treated as one. | Platform | _set a date_ |
| **A replay resolves three different ways depending on timing, and the ADR names only one.** Within one ERP process lifetime the same `Idempotency-Key` returns `201` with an **empty body** (the gateway's in-memory store), so `ErpClient` returns null and `erp_response` is stored null; after a restart the same replay hits the unique violation above; and a genuine first delivery returns the record. All three are handled, none is wrong, and nothing documented that there were three. **Extended 2026-10-05:** that store answers a FAILURE the same way — status without body — which is how a revived row's second refusal became `unrecognised_error_shape` instead of the ERP's sentence (item 6's correction). A key per episode means a revive no longer takes the first path; a retry inside one episode still does, deliberately. | Platform | _set a date_ |
| **A non-string `detail` fails both error parses.** `invalid_settings` puts an array in `detail`, which satisfies neither `HandlerErrorSchema` nor the problem-details shape, so it normalises to `unrecognised_error_shape` — which classifies as a transient retry and would burn the attempt cap. Unreachable from the outbox today (no outbox operation can provoke it), which is why the mapper was not widened on an unverified path. Worth closing the moment anything can reach it. | Platform | _set a date_ |
| **`WhtCertificate` is routed by the ERP with empty `access` lists on all five operations**, so no role can reach it and it 403s to everybody. Found while asserting that all 51 declared slugs route. ERP-side, reported not acted on. It matters to us only if withholding-tax certificates ever enter the CRM's read set; recorded so nobody debugs it twice. | Platform | _set a date_ |
| **Both halves closed, and the row that claimed the first one early is worth keeping.** An earlier version said `attempt-history.ts` was reachable while `attemptHistory`, `recentDeaths` and `summariseAttemptHistory` were exported from the barrel and called by no route, no job and no other package — the fourth built-and-unreachable in this repo, in the row written to close the third. `GET /v1/erp-writes/:id/history` and `GET /v1/admin/erp-writes/deaths` now reach both reads, and the per-row route deliberately does not authorise through `deadLetter`, whose `state = 'dead'` predicate would make a history unreadable the moment a revive succeeded. The receipt claim-state rule is now a trigger too (0040, `crm.attachment_validate_receipt_claim_state`), so an offline sync path and a psql prompt meet it; the route keeps the rule as the source of a readable 409, and SKIPS it for a byte-identical replay, because `putAttachment`'s retry path writes nothing and the route was stricter than the database it fronts on the one path built to be repeated. | us | **closed 2026-10-05** |
| **`crm.disposal_obligation`'s layout-invariance test could not keep its own premise.** 0036 gives the table a `seq`, and `open_disposal_obligations` now orders by it, so a tie no longer resolves by whatever the heap scan returned. Proving invariance by forcing a heap move does not work in a shared table: an UPDATE relocates a tuple only when its page is full, which depends on dead tuples left by whichever suite ran first — it passed alone and failed in the full suite, reporting its own precondition. Replaced with the deterministic form of the same property (the answer equals `seq` order, on the arrangement where scan order can disagree). The weaker claim is deliberate: "invariant under an arbitrary physical rearrangement" is not testable from inside a transaction, and a test that says so is better than one that pretends. | us | _set a date_ |
| **A protocol refusal now reads to a probe in the sender's words.** Collapsing the two SMTP conversations into one (`SmtpConversation`, exported from `smtp.ts` as PHASES with a private constructor and a private socket) means a no-STARTTLS or no-AUTH-mechanism refusal ends "Refusing to send" even in a probe row, where nothing was ever going to be sent. Arguably an improvement — it names what the sender will do, which is the question the probe exists to answer — and recorded because it is a sentence an operator reads. The sender's own no-STARTTLS wording changed from "this message would cross the network in clear text" to "anything sent to it would", because the shared sentence must be true of a conversation with no message in it. | us | _set a date_ |
| **The channel-coverage check ran once at boot; it now runs per dispatch tick and reports only the TRANSITION.** The gap was real — an `email` endpoint created a minute after a webhook-only scheduler started was not noticed until the next restart, its deliveries retrying with a readable reason and nobody told. The reason this row said "recorded rather than chosen" was the objection, not the gap: a check per tick is a log line every thirty seconds per tenant, and a line that is always there is a line nobody reads. So the Scheduler remembers the last verdict per tenant and appends to the `notify_dispatch` summary only when it changes — a deployment that boots covered and stays covered says nothing more, the tick that notices an unsendable channel says so once with the reason, and a recovery is reported too because that is also news. Absent is treated as `covered`, so a deployment that boots unsendable is told by the boot check and not again. The check is injected as a function, so the Scheduler depends on the answer rather than on how it is obtained, and a failure to ASK is swallowed into the line (`coverage UNKNOWN: …`) rather than engaging the job's failure backoff — the same rule the probe runner already follows, for the same reason: the notifications went out. What it costs, stated: the dedup is per-process, so a restart re-reports a standing gap through the boot check, which is the right surface for it. | us | **closed 2026-10-06** |
| **A probe's history is bounded at twenty per endpoint and is not an audit record.** The ring trims on insert, so "who tested this endpoint last March" is unanswerable by design. Stated because the alternative — a horizon — needs a scheduled job somebody still has to wire, which is how this schema grows its next open item. | Platform | _set a date_ |
| **A row whose `tenant_id` is absent from `crm.tenant` is invisible to 0035's pre-flight**, because nothing can enumerate it: no table references the registry. Such a row is a defect in its own right, and writes are closed structurally either way. Giving every tenant-scoped table an FK to `crm.tenant` would close it and is a much larger change. | Platform | _set a date_ |
| **`crm.tenant` is empty in a test database, so 0035/0037's pre-flight scanned nothing — now exercised, and it works.** The `DO` block is the only thing standing between a composite key's blind bulk `VALIDATE` and a silently-wrong constraint, and it enumerates `crm.tenant`, which neither setup path populates: it looped zero times on every run and proved nothing. `scripts/verify-migration-runner.sh` now builds a database that really leaks — migrations to 0034, two registered tenants, and the leak this schema shipped once (a tenant-B `rep_role` naming a tenant-A profile through `granted_by`, single-column until 0035) — and asserts the row is visible inside tenant B and invisible without a context, that the migration refuses and names the table, the column and the tenant, and that the same database migrates once the leak is gone. Removing the leak needed `DISABLE TRIGGER USER`, because `crm.rep_role` is append-only: a leaked grant cannot be cleaned up in place, which is itself why 0035 refuses rather than repairing. What stays open is the narrower gap the migration's own header names: a row whose `tenant_id` is not in `crm.tenant` is still unscanned, because nothing can enumerate it. | us | **closed 2026-10-06** |
| **Two referencing-side indexes are not tenant-prefixed**: `idx_attachment_supersedes (supersedes_attachment_id)` and `idx_notification_endpoint_probe_history (endpoint_id, seq DESC)`. Neither was before 0037 either, so nothing got slower, and 0035's rule stands — adding indexes inside a tenant-scoping migration is a different change wearing its clothes. If a `RESTRICT` check on `crm.attachment` ever shows up in a plan, these are the two to look at. | Platform | _set a date_ |
| **Nothing bounds a tenant's total outbound probe volume.** The cooldown is per endpoint, which is the right scope (each endpoint is a different third party and a quiet one should not be rationed by a noisy one) — but endpoints per tenant are uncapped, so three endpoints means three probes back to back inside one cooldown window. Each is one signed POST or one SMTP envelope walk, so the ceiling is low and the exposure is an administrator-only route; the bound belongs in the schema beside the cooldown if it is ever wanted, not in the route. | Platform | _set a date_ |
| **A `CHECK`'s validation scan sees every row; a `FOREIGN KEY`'s bulk validation and a `UNIQUE INDEX` do not.** Three forms of one rule now, all learned the hard way here, and worth carrying together because a migration author needs the set. 0035: adding a composite FK as `crm_app` under FORCE ROW LEVEL SECURITY validates against ZERO visible rows and marks itself `convalidated = true` over a table holding a violation — so it needs a pre-flight that asks from inside each tenant. 0032: a clamp was blind the same way and the validated CHECK that followed was not, so the migration refused its own repair. 0043: a UNIQUE INDEX is ENFORCED with row security disabled, so `uq_outbox_dead_letter_attempt (outbox_id, attempt)` was cross-tenant while the trigger allocating `attempt` was confined — demonstrated live, tenant B seeing zero rows and the index refusing anyway, which made it an existence oracle AND took the `UPDATE crm.outbox` down with it. The rule: DML and a FK's bulk validation are ordinary queries and need FORCE lifted (0027's pattern); a CHECK's validation and a unique index's enforcement are not, so they need the KEY to carry `tenant_id`. | us | _carry it_ |
| **No snapshot can be refreshed incrementally, so every pass reads every record.** Not a defect any more — it is reported now, and the watermark is no longer advanced from an unbounded read — but it is the standing cost, and it is the strongest argument for Q9's `meta.webhook_deliveries` that exists. `snapshot_incremental` runs every five minutes per tenant and pages each entity in full, because 0 of 51 entities publish `updated_at` as filterable. The alternative is the platform adding it to the pack's filterable sets, which is one line on their side and removes a full pass per entity per five minutes on ours. | Platform | _set a date_ |
| **An attachment's bytes travel as base64 in a JSON envelope, not as a binary body.** `send()` JSON-stringifies every body and always writes `application/json`, so a Buffer would go out as `{"type":"Buffer","data":[…]}`. Base64 is symmetric with the upload, needs no change to the router, and inherits its `cache-control: no-store` and `x-content-type-options: nosniff`, which are right for a third party's personal data — and 512 KiB of base64 fits the 1 MiB body cap by construction. Teaching `send()` that a Buffer body is written verbatim with the caller's `content-type` is the change if real bytes are ever wanted; `HandlerResult.headers` already exists to carry it. | Platform | _set a date_ |
| **`problems.test.ts`'s silent skip is gone, and the module list no longer rots.** A throwing constructor is now `expect.fail` naming the class and the arguments tried, and the three classes that threw were fixed with real probe arguments read out of each package's own exported state constants — never by widening the allow-list. The list of audited packages is DERIVED from `packages/*/package.json`: every package must be audited or excluded with a reason, and each exclusion is grounded against `@crm/api`'s own `dependencies`, so "no request can reach it" is a fact about the manifest rather than prose. Coverage went from 7 packages / 64 classes to 12 / 99, and the per-package minimum counts were replaced by a scan of each package's `src` for `export class X extends …Error` asserting the barrel exports it — which is what found `ErpWriteDeadLetteredError` and `ReceiptClaimStateError` declared, thrown and absent from their barrels. Both are exported and mapped now. | us | **closed 2026-10-05** |
| **`crm.attachment_access`'s missing tenant guard was a STALE NOTE, and 0037 had already closed it.** Proved rather than reasoned, as `crm_app` under FORCE RLS with every trigger live: a row naming another tenant's attachment is refused `23503` on `attachment_access_attachment_id_fkey`, another tenant's reader the same on `attachment_access_read_by_fkey`, and with no tenant context at all the policy's `WITH CHECK` refuses before any key is consulted. The composite keys ARE the guard, because a referential check runs with row security disabled and therefore answers "same tenant?" at the same moment as "does it exist?". The note came from 0037's own header, which says the table carries no insert-time guard as the JUSTIFICATION for converting the two keys — not as a residual gap. Four tests pin it, run with triggers enabled (the pre-existing probes run under `DISABLE TRIGGER USER`, which is the wrong evidence for "does this need a trigger"). | us | **closed 2026-10-05** |
| **No virus scanning, and no retention horizon on an attachment.** Both argued in 0033's header and both still true: the ERP's own `files` package declares a `scanning` lifecycle with nothing behind it (README rule 29 territory), and an attachment IS the regulated fact, so choosing how long to keep a doctor's signature is a statutory question rather than a parameter. | Compliance | _set a date_ |
| **A client-supplied `X-Correlation-Id` made every attachment byte-read a 500 — and a refusal, not just an unlogged read.** `dispatch` read the header and fell back to a uuid only when it was ABSENT, so an empty value arrived as `''` and a long one arrived whole; `crm.attachment_access.correlation_id` is `CHECK (length BETWEEN 1 AND 64)`, nothing translated a `23514` on it, and the access row is written BEFORE the bytes are served on purpose (an unrecordable privileged read is refused, not served unaudited). So any ingress that emits a composite request id — AWS X-Ray's `Root=…;Parent=…;Sampled=1` is about seventy characters — would have made every signature in the system unreadable, including to the rep who has to produce it in an audit, with the answer "an unexpected error occurred". Reproduced end to end at lengths 0 and 65. Normalised where the column is written (`normaliseCorrelationId`: blank becomes absent, over-long is truncated, because a prefix still joins and a 500 serves nobody) and not by relaxing the CHECK; the echoed header stays byte-identical to what the caller sent, so their own tracing still joins on it. | us | **closed 2026-10-06** |
| **Every expense route that reached for the supervision helper leaked the claim owner's rep id.** `requireSupervision`'s sentence is `no rep <id> on your team`, so a caller holding a claim id they should not — a screenshot, a support ticket, a spreadsheet, a period when they did supervise that rep — was handed the identifier the 404 exists to conceal. The signature route next door had avoided it; the receipt route added in the same commit as that argument did not, and nor did `/erp`, `/approve`, `/reject`, `/post` and `/reimburse`. All six now answer `no expense claim <id> on your team`, and the test asserts the SHAPE is gone as well as the id, so a future author reaching for the supervision helper fails rather than passing because the fixture's rep id happened not to appear. | us | **closed 2026-10-06** |
| **A revived ERP write re-asked under the key the gateway had already answered, so its second refusal was the CRM's failure to read a reply rather than the ERP's reason.** The `Idempotency-Key` was `crm-<row id>`, fixed for the life of the row; the deployed gateway's idempotency store keeps a reply's STATUS without its body (the same measured fact that makes a replayed 201 arrive empty), so a replayed 422 failed both error parses and the death history recorded `rejected: unrecognised_error_shape` where the first episode had `validation_failed: request_number is required`. The operator who pressed retry was told LESS than before they pressed it, and `is_repeat_of_previous` called an identical cause a new one — the exact question `crm.outbox_dead_letter` exists to answer, answered backwards. The key is now per EPISODE, `crm-<row id>-r<revive count>`: stable within an episode so a worker that died after sending is still deduped, distinct across them because a revive is a request for the ERP's answer NOW. Safe because the dedup that matters is the record-id constraint, which §6h already proves settles a landed write with the driver message stripped. Found by the live gate; no offline test could, because the fake ERP has no memory. | us | **closed 2026-10-06** |
| **A migration that cannot succeed used to make its own repair unreachable forever.** `applyMigrations` halts on the first failure and records nothing, so a database stuck on 0032 retried it on every deploy and 0033–0041 — including 0039, written to repair exactly that state — could never run. `scripts/setup-test-db.sh` had the same shape. Reproduced: a database with the ledger at 0031 and a million-row floor fails on 0032 and stays there. The fix is a declaration in the file, like `@requires: dba` and for the same reason: `-- @supersedes: <filename>` in a LATER migration records the named file with its real hash WITHOUT running it. The hash is still recorded, so editing an applied migration is refused exactly as before, and a database that did apply the file is untouched. 0042 carries the declaration (not 0039, which is applied and therefore hash-frozen) plus the two function definitions retiring 0032 would otherwise take with it. Proved on the halted database: 10 files apply, 0039's clamp brings the floor from 1,000,000 to 1,000, and the capped constraint lands. The declaration is validated — an unknown name or one that does not sort earlier is refused by both `apply` and `--dry-run` — because a typo would otherwise be silent. | us | **closed 2026-10-06** |
| **`settleLost` was counted and no deployed process could see it.** A refused settlement means two workers raced the same row, which `reclaimStale` makes possible by design, and the loser's outcome was discarded rather than written — but it was absent from the `relay_drain` summary line AND `OutboxRelay` was constructed in `bin/scheduler.ts` with no `onEvent` at all, so every per-row `RelayEvent` went nowhere outside the tests. A race read exactly like a quiet tenant. The summary now carries `LOST=n` when non-zero and omits it otherwise (a zero that is always there is a zero nobody sees), and the binary logs `dead` and `settle_lost` per row to stderr. `delivered` and `retry` are deliberately NOT logged: two hundred lines to say what `claimed=/delivered=/retried=` already says is not observability. | us | **closed 2026-10-06** |
| **A posting intent that collapsed onto a DEAD outbox row used to be indistinguishable from a harmless duplicate.** `enqueueOutbox`'s unique key is unconditional, so a re-enqueue collapses onto a `delivered` or `dead` row as readily as a `pending` one — four states, not three. `postClaim` read `enqueued: false` as "replay, carry on" and set `posted`, which settles the claim against a write that will never reach the ERP and removes it from the only sweep that would ever look again; the job line read `posted=1 replayed=1`, healthy. It now refuses (`ErpWriteDeadLetteredError`, a 409 naming the outbox row and the retry route), the claim stays `approved`, the sweep reports `blocked(erp_write_dead)`, and the rep and their supervisors get `expense_post_blocked`. A live duplicate stays silent, which is the whole value of the distinction. The sample mirror does the opposite and deliberately: the movement IS recorded, so it answers 201 with `erpMirror.deadLettered` in the body and raises nothing — `raiseDeadLetterAlarm` already told the rep at the moment of death, keyed on `revive_count` so a second mention of one death is not news. | us | **closed 2026-10-06** |
| **`crm.expense_claim` has no lifecycle trigger at all.** The whole state machine is `packages/expense` TypeScript, so a psql prompt can move a claim `reimbursed → draft`, or set `approved` with `approved_by` null. This is the same class of gap 0040 just closed for attachments, and it is now the weaker half of the pair the receipt rule reads: the trigger that refuses a receipt on a claim that has moved on trusts a `state` column nothing in the database defends. 0040's own fixtures depend on that looseness to build the six states, which is a fair summary of the problem. | Platform | _set a date_ |
| **The dead-letter history is bounded at 50 episodes per outbox row, and the trim is not an audit decision anybody made.** 0041 gives `crm.outbox_dead_letter` a `seq` (the real write order, since `died_at` ties — the trigger copies a caller-supplied `Date` and a batch refused before any HTTP call settles inside one millisecond) and a ring enforced in the insert trigger rather than a scheduled job, because a ring that depends on a scheduler is unbounded whenever the scheduler is down. What it costs: the oldest episodes' REASONS, so `alwaysTheSameReason` and `neverTheSameReason` describe a page rather than a history once a row has died more than fifty times. What it keeps: the count, because `attempt` keeps counting past a trim, so `deathsEverRecorded` and `episodesMissing` still tell the truth — that property is what made a ring acceptable instead of a cascade and it is pinned by a test. 0041 deliberately trims NOTHING on application: a one-off DELETE over existing history would be a retention decision applied retroactively to records of regulated failures, by a migration, with no operator and no undo. Whether fifty is the right number is a judgement nobody has made. | Product | _set a date_ |
| **`title` and `detail` disagreed for three state-machine refusals, and now there is one type for all three.** `visit.InvalidTransitionError` and `callplan.InvalidPlanTransitionError` shared the `visit_final` / `plan_final` types with the errors that really do mean "this record is over" — so a `planned → completed` refusal came back titled "Visit is final" with a detail saying otherwise, which is the wrong sentence for a client that renders `title`, and rendering `title` is what a title is for. `expense.InvalidExpenseClaimTransitionError` answered a bare `conflict`, which was not wrong, just less than it could say and inconsistent with two sibling state machines in the same API. All three now answer `invalid_transition` (409, "Transition not allowed"); `VisitIsFinalError` and `PlanFrozenError` keep their own types, because the REMEDY differs — a transition refusal says try a legal one, a final-state refusal says there is nothing left to do to this record. And `visit.InvalidTransitionError` answers EITHER, because it covers both facts: its constructor already branched on `VISIT_TRANSITIONS[from].length === 0` to choose between "a completed visit is final" and "cannot move a visit from planned to completed", and then threw the distinction away. It now carries it as `fromIsFinal` and the mapper reads the flag rather than reconstructing the map — so `completed → in_progress` is still `visit_final` and the pre-existing route test that asserted exactly that passes unchanged, which is how I know it was asserting something true. `callplan`'s transition error takes only a message and has no map to consult, so it answers the flat type; refining `InvalidExpenseClaimTransitionError` the same way is a follow-up, left until 0044's lifecycle work lands rather than done across it. One shared type rather than one per domain: the fact is identical, the `detail` names the record and the states, and `conflict` is already shared across a dozen domains on exactly that reasoning. The test asserts through `body()`, because asserting the kind alone would have passed before the change too. A wire-contract change with no client to break, which is the cheapest moment to make one. | us | **closed 2026-10-06** |
| **`GET /.well-known/jwks.json` rendered its document outside its own try/catch.** `verifiableKeys()` was guarded and fell back to the 503; `buildJwksDocument` on the next line can throw `JwkError` when a registry row's `kid` is not the thumbprint of its own key — a row the read cannot refuse — and that escaped as a 500. Fail-closed held either way (any non-200 makes a verifier keep its last good key set), but the designed answer is the 503, and the fix is one line of scope. Pinned by a test that inserts exactly such a row. | us | **closed 2026-10-06** |
| **The expense claim lifecycle is in the database as of 0044, and the escape hatch is DDL on purpose.** The whole state machine lived in `packages/expense` TypeScript, so a psql prompt could move a claim `reimbursed → draft` or set `approved` with `approved_by` null — and 0040's receipt trigger reads `crm.expense_claim.state`, so that rule was only as strong as a column nothing defended. The map is now one queryable SQL function, a test asserts it agrees with `EXPENSE_CLAIM_TRANSITIONS` edge for edge from both sides, entering a state must supply the columns that state's record of a decision consists of, and a decision once recorded is write-once. The required-field check runs ONLY on a change of state, which is what leaves 0030's legacy `rejected` rows with no rejecter alone — the trade 0030 examined and declined. Four eyes on `post`/`reimburse` stays unenforceable because neither records an actor, but `posted` and `reimbursed` now require `approved_by` and the map admits one route into each, so a claim in either state provably passed through `approved` with a named approver who was not the claimant. The hatch is `ALTER TABLE … DISABLE TRIGGER`, not a session GUC: a GUC is cheap, per-transaction and invisible in a catalog, which makes it the thing a future writer sets once "just for this sync flush", after which the lifecycle is back in TypeScript. DDL takes `ACCESS EXCLUSIVE`, shows under `log_statement = 'ddl'`, and must be undone explicitly. 21 fixtures were reclassified and none loosened. | us | **closed 2026-10-06** |
| **A claim's SUBSTANCE is still not frozen once it leaves draft.** `crm_category`, `amount`, `currency` and `incurred_on` can be rewritten on an `approved` or `posted` claim with no state change and no constraint objecting, so a claim approved for 120.50 can be edited to 1,205.00 and posted. 0044 closed the lifecycle and named this as owed rather than attempting it: it is a different rule. The account codes cannot simply join the write-once set — a `draft` claim may legally already carry one and `submitClaim` overwrites it with the live mapping, so sealing would refuse a legal submission. This is the same class 0016 closed for an approved call plan, and it is the sharpest thing left in the expense path. | us | _set a date_ |
| **A tenant's total probe volume is bounded as of 0045, and the retention ring was refunding the budget.** 120 probes an hour by default across every endpoint, counted over a rolling window on `requested_at` — the cooldown's own shape, so an operator learns one mechanism for two limits — enforced in the same trigger, under `pg_advisory_xact_lock` held to commit because a count has no partial unique index available to it. Proved under a real interleaving: without the lock two simultaneous requests on different endpoints both pass a ceiling of one; with it the second is parked at the lock before it counts anything and is refused. The finding that mattered came out of building it: 0034's ring keeps the newest 20 complete probes per endpoint and the budget counts rows in that table, so the ring handed budget back — and with the cooldown at 0, which the schema permits, a single endpoint could emit unbounded probes while never retaining more than 20 rows, so the budget would not have been a bound at all in the one configuration with no other one. A bound computed from rows cannot also be the reason those rows are deleted; the ring now keeps at least 20 **and** anything inside the window, written as the strict complement of the budget's own predicate. Whether 120 is the right number for a fifty-endpoint tenant is a judgement nobody has made. | Product | _set a date_ |
| **Delivery history outlives the inbox as of 0046, and the endpoint leg is the identical defect, still open.** `crm.notification_delivery` cascaded from `crm.notification`, so an inbox horizon was also the retention period for the record of a push to a third party. The key is dropped (not `SET NULL`: a composite SET NULL nulls `tenant_id` too, which makes deleting a notification *fail*, and the column-list form would null the one value that goes out on the wire as `notificationId` — the thing a receiver quotes back), four facts are copied by the trigger that also IS the tenant guard, and `retain_delivery_days` (730, floored at `retain_unread_days`) bounds the orphans. Still open: `notification_delivery_endpoint_id_fkey` is `ON DELETE CASCADE`, so deleting an endpoint still erases the record of everything ever sent to it — latent only because no route deletes one. Closing it is the same shape, and the horizon that bounds its orphans already exists. | Platform | _set a date_ |
| **The CRM's `api` and `scheduler` binaries are now driven at the live ERP, and nothing in them needed changing.** The gate had only ever driven the `dist` as a library: it built its own `OutboxRelay`, handed it a credential it assembled itself, and called `drainTenant`. §7 of `docs/LIVE_ERP_VERIFICATION.md` starts both processes instead — the API behind a stand-in IdP, the scheduler with `NODE_ENV=production` and `CRM_SIGNING_KEY_FILE` exactly as compose runs it — and the chain completes: `POST /v1/samples/receipts` writes the outbox row, the scheduler's own `relay_drain` tick mints a per-tenant Ed25519 token under the role in `crm.erp_service_principal`, and the `StockMovement` lands at the live ERP. With controls: the role flipped to `erp_viewer` makes the row die `forbidden`, a static `ERP_TOKEN` under production exits 1 while the same token outside production starts, and the CRM's API refuses a token signed by the ERP-facing service key because the two tiers publish different key sets. 34 assertions, 124 in the gate. Worth recording that this gap lived only in the verification doc and was never a row in this table until it was closed. | us | **closed 2026-10-06** |
| **A replayed refusal from the gateway was being read as an answer, and the per-episode idempotency key was only half the fix.** The commit that introduced the per-episode key argued "nothing is risked by it — the key only ever saved a round trip", and an adversarial review proved that false. `attempts` is deliberately not in the key, so every retry INSIDE an episode still re-asked under a key the gateway had already answered — and the gateway's store keeps a reply's STATUS without its body, for a handler's 4xx and 5xx as readily as a success, on a 24-hour TTL in a store that never evicts. Measured consequences, both expensive: a bodiless 422 parsed as `validation_failed` and DEAD-LETTERED a correct write with `rejected: unrecognised_error_shape` — reachable on the first retry of a claim posted into a locked fiscal period, where the backoff is 15 minutes and the attempt budget is 60 — and a bodiless 409 parsed as a bare `conflict`, past the `invalid_transition` branch written to catch exactly it, and marked a transition DELIVERED that the ERP had refused and never applied. The fix is not a per-attempt key, which would give up the one thing the header is for: `ErpClient` now recognises a replay by the gateway's own `x-idempotent-replay` header and asks again under a fresh key, once, and only for a 4xx/5xx — where the stored outcome means the handler refused, so nothing was written and nothing is applied twice. A replayed 2xx is left alone. No offline test could have caught the original: the fake ERP answers every request it is given and has no memory to replay from — the fifth occurrence of "the fixture was kinder than reality", and the first where what the fixture lacked was the ERP's MEMORY. | us | **closed 2026-10-06** |
| **`packages/api`'s `@crm/acl` dependency is NOT dead, and the row that said so was wrong — I checked by removing it.** The finding was that nothing in `packages/api/src/` imports it: no `ErpClient`, no `crm/acl` import, one outbound HTTP call in the package (the IdP JWKS fetch). All true, and the conclusion did not follow. `packages/api/src/problems.test.ts` imports it, and has to: the error-mapping audit walks each audited package's exports, and `@crm/acl` is one of them because `ErpError` is mapped. Dropping the dependency removed the pnpm symlink, the test file stopped resolving, and `problems.test.ts` reported "no tests" — which is the failure mode that test exists to prevent, arriving as a silent pass. Restored. Recorded because the original row would have been a plausible one-line cleanup for a future reader, and because "src/ does not import it" is the wrong question for a package whose test surface is part of its contract. | us | **closed 2026-10-06** |
| **`packages/sample` sends `quantity` to the ERP as a string.** node-postgres returns `NUMERIC` as text, so a mirrored `StockMovement` carries `"12.000"`. The live ERP accepts it — its decimal validator does `Number(value)` — and stores the string, which is the same kind of dependency on ERP leniency as the leaked driver message above: it works today and breaks silently, in the expensive direction, if that validator ever tightens. Every mirrored movement would 422 and dead-letter. | Platform + us | _set a date_ |
| **A claim's substance is frozen once it leaves draft, as of 0047.** `crm_category`, `amount`, `currency`, `incurred_on`, the snapshotted account codes, `description`, `receipt_url` and `rep_profile_id` could all be rewritten on an `approved` or `posted` claim with no state change and nothing objecting — so a claim approved for 120.50 could be edited to 1,205.00 and posted, with the approval still on the row, with its approver and its timestamp, attesting to a number nobody ever saw. `rep_profile_id` being writable was 0016's call-plan defect in the expense table: "a plan that can be re-pointed at a different rep after approval is not an approved plan." The rule is keyed on `OLD.state <> 'draft'` rather than being write-once, and that is what makes the one legitimate writer legal — `submitClaim` stamps the account codes in the SAME statement as `draft -> submitted`, so the row is still a draft when the trigger looks; write-once would have refused exactly that, and would also have left the nullable cost centre settable forever. A second trigger rather than an arm in 0044's, because `CREATE OR REPLACE FUNCTION` replaces a whole body and rebuilding 0044's from memory is how 0041 silently reverted 0038's guard. The frozen list is published as a SQL function and asserted against the table's real columns, because a typo'd name freezes nothing and fails nothing. `description` is frozen, which is a judgement: it is part of what an approver read, and annotating a decided record belongs in an append-only note beside it (0030's shape), not in rewriting the field the decision was given against. | us | **closed 2026-10-06** |
| **The endpoint cascade is closed too, as of 0048, and `crm.notification_delivery` now has no foreign key at all.** 0046 fixed the notification leg and called the endpoint leg "the identical defect, still open". It was: `ON DELETE CASCADE` meant deleting an endpoint erased the record of everything ever sent to it. The shape is 0046's — drop the key, copy what the row needs, let the trigger that makes the copies be the tenant guard — and the copies are `endpoint_channel` and `endpoint_url`, which 0046 deliberately JOINED on the grounds that "the endpoint is still joinable". That argument expired the moment the row could outlive it. It closes a second thing on the way: `updateEndpoint` refuses to repoint a url, arguing that doing so would carry the delivery history onto a different destination, and nothing in the schema said so — a copy taken at enqueue time cannot be re-attributed by anything. `secret_env` is NOT copied, because it names an environment variable and rotating which one an endpoint reads is a legitimate change; which is also why `claimDue` still joins the live endpoint to send, and therefore why the orphan hazard 0046 met had to be answered again for the second parent: the `due` CTE now requires both parents and `settleOrphanedDeliveries` reports the two kinds of orphan separately, since a missing notification means the payload cannot be rebuilt where a missing endpoint means the secret cannot be read. | us | **closed 2026-10-06** |
| **THERE IS NO CLIENT.** The CRM is an API and a background process: 15 packages, 43 migrations, 98 routes, no web UI, no mobile app, no on-device store. This is the largest thing not written down anywhere until now, and it matters more than its one row suggests, because "offline-first" is load-bearing in the brief and a great deal of this system exists to serve a client that does not exist: device-minted ids for idempotent replay (0017), `POST /v1/sync/visits` and the per-row batch results, the `UiSchema`-free hand-rolled route surface, the staleness question below, and the signature capture that commits to bytes no app has produced. Every one of those is a guess about a consumer until something consumes it. Choosing the shape — a PWA like the ERP's `operate-web`, a Capacitor wrapper, or native — is a product decision with a long tail, not an increment to slot in. | Product | _set a date_ |

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
