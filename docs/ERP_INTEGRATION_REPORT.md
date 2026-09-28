# ERP Integration Report — CrossEngin

**Subject:** `../CrossEngin` (GitHub `amoufaq5/CrossEngin`), read at commit `b2de883`
(`refactor(kernel): delete the dead entity emitter (#176)`) on branch `main`.
**Purpose:** establish what the Pharma CRM can rely on, what it must build, and
what it must never duplicate.
**Method:** source read only. Nothing in `../CrossEngin` was modified, built, or run.

> **Read this caveat first.** CrossEngin is not a conventional ERP with fixed
> tables. It is a *platform* that compiles a declarative **manifest** into a live
> multi-tenant API and Postgres schema. "The ERP" is the `pack-erp-core` manifest
> served by the `operate-server` binary. Every statement below distinguishes
> **declared** (a zod contract exists, tests pass) from **wired** (the deployed
> `operate-server` actually does it at runtime). The gap between the two is the
> single largest risk to this project, and §13 is mostly about that gap.

---

## 1. Language, framework, runtime, package manager, build tooling

| Concern | Value | Evidence |
|---|---|---|
| Language | TypeScript, strict, ESM (`"type": "module"`), no `any`, explicit return types on exports | `packages/config/typescript/base`, `CLAUDE.md` |
| Runtime | Node `>=20`; the Docker image is `node:20-bookworm-slim`; dev box here runs 22.22.2 | root `package.json` `engines`, `deploy/Dockerfile` |
| Package manager | **pnpm 9.12.0**, pinned via `packageManager`, workspaces | `package.json`, `pnpm-workspace.yaml` |
| Monorepo orchestrator | **Turborepo 2.x** (`build`, `lint`, `test`, `typecheck`, `dev`, `clean`) | `turbo.json` |
| Compiler | `tsc` per package → `dist/`; `next build` for the web app | per-package `package.json` |
| Test runner | **Vitest 2.1** with a shared preset (`@crossengin/testing`), v8 coverage | `packages/testing/src/vitest-preset.ts` |
| Schema/validation | **zod ^3.23** — the single source of truth; types derive via `z.infer` | every package |
| Runtime deps | Deliberately near-zero. The Anthropic/OpenAI/Stripe clients are hand-written over `fetch`. `zod` and `pg` are essentially the only third-party runtime libraries. | `packages/ai-providers-*`, `packages/billing-stripe` |
| Workspace shape | **82 packages** under `packages/`, **3 apps** under `apps/`; 855 non-test `.ts` files, 584 test files, ~239k LOC total | measured |

Workspace globs include `manifests/*` and `tools/*`; **neither directory exists**.

**Build commands**

```bash
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm -r test   # several minutes
pnpm --filter @crossengin/<name> test
cd apps/operate-web && npx next build && npx tsc --noEmit   # outside the vitest workspace
```

There is **no top-level lint script**. ESLint was never migrated to v9 flat config, so
`turbo run lint` finds nothing to run in most packages. Do not expect lint parity.

### The layering convention (you must internalise this)

Most domains appear two or three times under related names, and the suffix is the layer:

- **`X`** — contracts. Pure zod schemas, enums, state machines, deterministic helpers.
  No sockets, no SQL, no clock unless injected.
- **`X-runtime`** — the in-process engine over those contracts. Still pure and offline;
  takes an injected `Clock`/`IdGenerator`, returns decisions and projected state.
- **`X-runtime-pg` / `X-pg`** — the impure persistence sibling. Postgres stores,
  `withTenantContext`, a `buildPersistent*` factory, usually a replayer.

Read the contracts package first; the runtime packages assume its vocabulary.

### The three apps

- **`apps/architect-cli`** — one-shot CLI (`crossengin`): `init`, `validate`, `diff`,
  `patch`, `hash`, `apply`, `chat`, `license`, `version`, `help`. `--format human|json`,
  exit 0/1/2. This is the **migration tool** (see §2).
- **`apps/operate-server`** — the deployed API. A long-running Node `http` listener over
  `buildOperateGateway`, plus a framework-neutral `dispatch` core with a Fetch/Workers
  edge adapter. 63 modules. Configured entirely by CLI flags (~70 of them).
- **`apps/operate-web`** — Next.js 14 app router + Tailwind, `next start` on :3000.

There is also a `web-ui/` directory at the repo root — a separate static app with
**no deployment story**, in no compose file and no guide. Ignore it.

---

## 2. Database, ORM, migrations, naming, multi-tenancy

### Engine and driver

**PostgreSQL only.** No ORM, no query builder, no Prisma/Drizzle/TypeORM/Knex.
Every query is hand-written parameterised SQL behind a thin `PgConnection` interface
(`packages/kernel-pg`) bound to `node-postgres`. Connection config comes from standard
`PG*` environment variables (`parsePgEnvConfig`).

Extensions in play:

- `pg_uuidv7` — required; every `meta.*` id defaults to `uuid_generate_v7()`.
  Managed Postgres usually forbids C extensions, so `deploy/supabase/00-uuidv7.sql`
  defines a pure-SQL `uuid_generate_v7()` and the applier accepts either.
- `pg_trgm` + `unaccent` — created on demand by the column store for `?q=` search.
- `pgcrypto` — for at-rest encryption of `phi`/`regulated` columns.
- **PostGIS is nowhere.** See §13 — this matters for GPS check-in.

### Migration tool

Home-grown, in `packages/kernel-pg`:

- The kernel emits DDL **deterministically** from `META_TABLES`, a hand-maintained
  TypeScript catalog of **139 platform tables** in `packages/kernel/src/bootstrap/meta-schema.ts`.
- `crossengin apply` applies it **per-statement**, gated by a Postgres **advisory lock**,
  with hash bookkeeping in `_meta_migrations` and explicit preconditions.
- `--dry-run` prints the full SQL; live mode executes.
- Drift detection reads `pg_catalog` and diffs against the expected schema.
- Entity (business) tables are emitted separately by `operate-runtime-pg`'s
  `ensureSchema` (ADR-0284), not by the kernel.

There are **no `.sql` migration files** to read. The schema is TypeScript.

Two invariants the meta-schema test suite enforces, which you will hit if you ever
contribute tables upstream:

1. Every `tenant_id`-bearing table has RLS enabled.
2. Every FK target is declared **earlier** in `META_TABLES` than the referrer.

### Naming conventions

- Postgres schemas: `meta` for platform tables. Entity tables land in `public`
  (library default) or `meta` (the `operate-server --schema` default). Configurable.
- Table names: `PascalCase` entity → `snake_case` (`SalesOrder` → `sales_order`,
  `BillOfMaterials` → `bill_of_materials`). Not pluralised.
- Columns: `snake_case`. Reference fields get an `_id` suffix if absent.
- REST resource slugs: `SalesOrder` → `sales-orders`, `Item` → `items` (kebab + `s`).
- `operationId`: `salesOrder.list`, `invoice.mark_paid`.
- Sequence-backed document numbers: `INV-{YYYY}-{SEQ:5}`, `SO-`, `PO-`, `BILL-`,
  `PAY-`, `EXP-`, `JE-`, `SHP-`, `WHT-`, yearly reset.
- Record ids are **`TEXT`**, not UUID — shaped `rec_<base36-time><base36-counter>`,
  regex `^[A-Za-z0-9_-]{1,200}$`.

### Multi-tenancy — what is actually implemented

**⚠️ ADR-0002 ("Multi-Tenancy Model", still status *Proposed*) describes
schema-per-tenant (`t_<short_uuid>`) for entity tables. That is not what the code does.**

What the code does is **shared-schema, shared-table, row-level security**:

- Every tenant-scoped table carries `tenant_id UUID NOT NULL REFERENCES meta.tenants(id)`.
- RLS is enabled with a uniform policy:
  ```sql
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  ```
- Every read and write goes through `withTenantContext(conn, tenantId, fn)`
  (`packages/operate-runtime-pg/src/tenant-context.ts`), which opens a transaction and
  runs `SELECT set_config('app.current_tenant_id', $1, true)` — transaction-local, tenant
  id bound as `$1` (never interpolated), validated against `/^[0-9a-fA-F-]{1,64}$/` first.
- **A table's owner bypasses RLS.** This is stated explicitly in `CLAUDE.md` as
  empirically verified. Cross-tenant reads are therefore granted *explicitly* by
  application code, never assumed from role. **Any CRM database role must not own
  ERP tables, or RLS silently stops protecting you.**

Two entity-store flavours behind one `EntityStore` contract:

| Store | Shape | Flag | Default schema |
|---|---|---|---|
| `PostgresEntityStore` | One table for everything: `meta.operate_entity_records(tenant_id, entity, record_id, document JSONB)`, unique on `(tenant_id, entity, record_id)` | `--store pg` | `meta` |
| `ColumnMappedEntityStore` | Real per-entity typed tables, DDL derived from the manifest | `--store pg-columns` | **`public`** |

> **⚠️ Every deployment artifact in the repo runs `--store pg` — the JSONB store.**
> `deploy/docker-compose.yml` (l.63–64) and `deploy/docker-compose.ai.yml` (l.66–67) both
> pass `--store` / `pg` as **hardcoded list items**, not `${…}` substitutions (unlike
> `--pack`, which is `${OPERATE_PACK:-erp-core}`), so there is no env override.
> `deploy/VERCEL-SUPABASE.md` (l.71) documents the same. `docker-compose.ai-gpu.yml` adds
> no store flag. `scripts/run-dev.ps1` defaults to `memory`, and the CLI's own default when
> `--store` is omitted is `memory` (`cli.ts:142`). **Nothing anywhere in the repo deploys
> `pg-columns`.** See R17 — this is decisive for the integration architecture.
>
> Note also the schema difference: `options.schema` defaults to `null` (`cli.ts:143`), and
> `ColumnMappedEntityStore` falls back to `opts.schema ?? "public"` while the JSONB store
> falls back to `"meta"`. So under `pg-columns` with no `--schema`, entity tables land in
> **`public`** (`public.employee`, `public.item`, `public.account`) — even though the CLI
> help text for the *other* subcommands says "default meta".

The column store is the interesting one and the one to integrate against:

- Table per entity, PK `(tenant_id, id)` where `id` is `TEXT`.
- **Composite tenant-scoped foreign keys** — an FK is `(tenant_id, <ref>_id) REFERENCES
  <target>(tenant_id, id)` with per-relation `ON DELETE` (default `RESTRICT`). Reference
  columns are `TEXT`, not `UUID`, precisely so this type-checks. Emitted as a
  `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` pair in a **second pass after every table
  exists**, so reference cycles are safe; a target entity not in the manifest is skipped
  silently. Verified in `packages/operate-runtime-pg/src/entity-ddl.ts:167–199`.
- m2m join tables, per-entity `pg_trgm` GIN indexes on plaintext text columns,
  pgcrypto `BYTEA` for `phi`/`regulated` columns, and SQL-level pushdown of
  filter/sort/keyset/projection.
- Classification is recorded as a column comment:
  `COMMENT ON COLUMN … IS 'crossengin.data_class=phi; crossengin.encrypt=at_rest'`.
- **Migration is additive only** (ADR-0283): `ADD COLUMN IF NOT EXISTS`, with `NOT NULL`
  dropped when there is no default. A removed field's column is never dropped; a changed
  type is never altered. Both need a data decision the emitter cannot make.
- **Per-tenant activated manifests get no DDL at all.** The store is built from the boot
  manifest alone.

Field-type → Postgres mapping worth knowing:
`text(maxLength)`→`VARCHAR(n)`, `decimal(p,s)`→`NUMERIC(p,s)`, `enum`→`TEXT`,
`reference`→`TEXT`, `json`/`file`/`currency_amount`→`JSONB`, `country_code`→`CHAR(2)`,
`datetime`→`TIMESTAMPTZ`, `geo_point`→`geography(POINT)`, `geo_polygon`→`geography(POLYGON)`.

Built-in traits inject real columns: `auditable` → `created_at`, `updated_at`,
`created_by UUID`, `updated_by UUID`; `soft_deletable` → `deleted_at`, `deleted_by`;
`versioned` → `version INTEGER`; `gxp_signed` → `e_signature_required BOOLEAN`.
**Every `pack-erp-core` entity declares `auditable` and nothing else** — so no soft
delete, no optimistic-concurrency `version`, no e-signature anywhere in the ERP today.

---

## 3. Authentication and authorization

### Identity provider

**There is none, and there is no login endpoint.** This is the most consequential
finding in the report.

`operate-server` accepts exactly two credential shapes
(`apps/operate-server/src/principals.ts`):

1. **`x-api-key: <token>`** — an opaque token matched against a set configured at boot
   via repeatable `--api-key key:role:tenant[:principalId]` flags. In-memory. To add a
   key you restart the process.
2. **`Authorization: Bearer <JWT>`** — an **EdDSA/Ed25519** JWT verified against a JWKS.
   The gateway checks signature, `iss`, `aud`, `exp`, `nbf`, and cross-checks the JWT's
   tenant claim against the `x-tenant-id` header (ADR-0098). Keys come from
   `--jwks-key kid:base64`, `--jwks-file`, or `--jwks-url` (cached, refreshed on unknown
   `kid`, rate-limited, last-good retained, fail-closed to 401).
   `--jwt-issuer` and `--jwt-audience` are mandatory when a JWKS is configured.

**CrossEngin issues no tokens.** It only *verifies* them. Some external IdP must mint
Ed25519-signed JWTs. Note the algorithm constraint: the JWKS parser keeps only
`kty=OKP, crv=Ed25519` keys and silently drops everything else — **an RS256 IdP
(Auth0/Entra/Cognito default, Keycloak default) will not work without a re-signing
proxy.**

### The principal model

`principalFromJwtClaims` is stateless — *the token is the principal*:

- `principalId` = the JWT `sub`, used as-is if it is a UUID, otherwise SHA-256-hashed
  into a stable v5-shaped UUID.
- `tenantId` = the `x-tenant-id` header (validated as a UUID), **not** a JWT claim.
- **Roles = the JWT `scope` claim.** `principalRoles` returns
  `{ primaryRole: grantedScopes[0] ?? "anonymous" }` — *only the first scope is read.*
  Secondary roles are never populated from a token.

`meta.users` and `meta.user_tenant_membership` (with `primary_role`, `secondary_roles TEXT[]`,
`abac_attributes JSONB`, `status`) exist in the meta-schema — but the **only** code that
reads them is the notification recipient resolver. **They are not part of authentication.**
There is no user directory behind the API.

### Authorization

RBAC is declarative and manifest-driven (`packages/auth`):

- `RoleDefinition` with inheritance; `EntityPermissions` = `{ list, read, create, update,
  delete, transitions: { <name>: grant } }`, each grant `{ roles: string[], abac?: string }`.
- `rbacCheck` resolves the principal's effective roles (primary + secondary + inherited)
  and allows if any is in the grant. Fails closed on an undeclared entity or operation.
- 15 roles ship in `pack-erp-core`: `erp_admin`, `erp_accountant`, `erp_viewer`,
  `inventory_manager`, `warehouse_clerk`, `procurement_manager`, `ap_clerk`, `controller`,
  `hr_manager`, `sales_manager`, `sales_rep`, `production_manager`, `project_manager`,
  `asset_manager`, `tax_manager`.
- **Field-level redaction is real and works.** `computeClassifiedFieldRedaction` runs at
  the gateway's `transform_response` stage, per caller, driven by a registry derived
  straight from the manifest's `classification` annotations. It fails closed on
  `pii`/`phi`/`regulated`. Handlers return full records; the gateway strips.

**ABAC is declared and never enforced.** `RbacGrant.abac` is parsed, `rbacCheck` returns
`requiresAbac` in its decision — and **nothing in the workspace consumes that field**
(grep: three hits, all declarations). There is therefore **no row-level scoping anywhere
in the ERP**. Any `sales_rep` can list every `Lead`, `Opportunity` and `Account` in the
tenant. Any `hr_manager` can list every `Expense`. "My accounts", "my territory",
"my team's expenses" do not exist and cannot be expressed.

### The web app's auth story

`apps/operate-web/app/api/[...path]/route.ts` is a server-side proxy that attaches **one
shared `OPERATE_API_KEY`** to every upstream call. There is no login page, no session, no
cookie, no per-user identity in the UI at all. Everyone using the console is the same
principal with the same role. Treat the ERP console as a single-operator admin tool.

### Usable endpoints for the CRM

There is **no SSO endpoint, no token-issuing endpoint, no `/userinfo`, no introspection
endpoint**. The `packages/sso` package (SAML 2.0, OIDC, SCIM 2.0, claim mapping, JIT
provisioning, session lifecycle) is **contracts only** — nothing depends on it, no
runtime, no `-pg` sibling. `meta.sso_providers`, `meta.sso_logins`, `meta.sso_sessions`,
`meta.scim_clients`, `meta.scim_provisioning` are empty tables with no writer.

---

## 4. Employee / HR master data

All in `packages/pack-erp-core/src/entities-hr.ts`. Four entities, all `auditable`.

**`Department`** — `dept_code` (unique), `name`, `parent_department_id → Department`
(self-referencing hierarchy), `manager_id → Employee`, `cost_center` (a **free-text
string**, not an FK to `CostCenter`), `status: active|inactive`.

**`Position`** — `code` (unique), `title`, `department_id → Department` (required),
`job_grade: intern|junior|mid|senior|lead|manager|director|executive`, `headcount`,
`status: open|filled|frozen|closed`.

**`Employee`** — `employee_number` (unique), `given_name`, `family_name`,
`work_email` (pii), `personal_email` (pii), `phone` (pii), `national_id` (pii),
`date_of_birth` (pii), `department_id`, `position_id`, `manager_id → Employee`
(self-referencing reporting line), `hire_date`,
`employment_type: full_time|part_time|contractor|intern|temporary`,
`status: active|on_leave|suspended|terminated`,
`annual_salary` (`NUMERIC(14,2)`, `commercial_sensitive`), `currency`.

**`LeaveRequest`** — `request_number` (unique, sequence),
`employee_id`, `leave_type: annual|sick|unpaid|parental|bereavement|study`,
`start_date`, `end_date`, `days NUMERIC(5,1)`, `reason`,
`state: draft|submitted|approved|rejected|cancelled` with a real lifecycle workflow.

**`Timesheet`** lives under Projects, not HR (`entities-projects.ts`), with its own lifecycle.

### What HR does **not** have

| Missing | Consequence for the CRM |
|---|---|
| **Any link from `Employee` to a login identity.** No `user_id`, no `principal_id`, no email→subject mapping. | The CRM cannot answer "which Employee is this JWT?" from ERP data. It must own that mapping. This is a hard blocker for rep-scoped anything. |
| **Leave balances.** Only requests exist. No entitlement, accrual, carry-over, or balance table. | Cannot show a rep their remaining leave. |
| **Employment contracts.** No contract entity, no start/end, no probation, no notice period, no version history. Grade is a fixed 8-value enum on `Position`. | Cannot model rep contract terms or grade-driven incentive tiers. |
| **Payroll.** No payroll run, payslip, earning, deduction, or pay-element entity. `Employee.annual_salary` is a single scalar. `JournalEntry.source` allows `'payroll'` and a `erp-core-payroll-disbursement` job is declared for a `erp.payroll_approved` event — **but no entity emits that event and no handler is registered.** | Commission and incentive payout must terminate in a document the ERP can consume (a `Bill`, `Expense`, or manual `JournalEntry`) — never in "payroll", which does not exist. |
| **Territory, region, or sales-org structure.** `Department` is the only org axis. | The CRM owns territory entirely. |
| **Effective-dating on anything.** No `valid_from`/`valid_to` on `Employee`, `Position` or `Department`. A reassignment overwrites history. | Historical attribution ("who owned this account in Q2?") cannot be reconstructed from the ERP. The CRM must snapshot. |

---

## 5. Product master

`packages/pack-erp-core/src/entities-inventory.ts` and `entities-pricing.ts`.

**`Item`** is the single product entity — no separate Product/SKU/variant split:
`sku` (unique), `name`, `description`,
`item_type: stock|service|kit|raw_material|finished_good|consumable`,
`unit_of_measure: each|kg|g|l|ml|m|cm|box|pallet|hour` (a **closed enum** —
`strip`, `vial`, `ampoule`, `blister`, `carton` are not expressible),
`category` (free text, indexed — the only grouping axis),
`barcode` (single, plain text — not GTIN-validated, no multi-barcode),
`tracking: none|lot|serial`,
`standard_cost NUMERIC(14,4)` (`commercial_sensitive`), `list_price NUMERIC(14,2)`,
`currency`, `reorder_point`, `reorder_quantity`, `weight_kg`,
`status: draft|active|discontinued`.

**`PriceList`** — `code` (unique), `name`, `currency`, `valid_from`, `valid_to`, `is_active`.
**`PriceListItem`** — `price_list_id`, `item_id`, `unit_price NUMERIC(14,4)`,
`min_quantity` (quantity breaks). No customer/segment assignment, no discount matrix,
no promotional pricing, no price-list → `Account` binding.

**`TaxCode`** — `code`, `rate_pct`, `kind: sales|purchase|vat|gst|withholding|exempt`,
`jurisdiction`, `gl_account_code`, `is_active`. Plus `TaxJurisdiction`, `TaxRule`,
`TaxReturn` for country rules and filing.

### What the product master does **not** have

- **No pack/UoM hierarchy.** No base-unit vs. selling-unit, no conversion factors,
  no "case of 24 boxes of 30 tablets". `unit_of_measure` is one flat enum value per item.
- **No therapeutic grouping of any kind.** No ATC code, no INN/generic name, no active
  ingredient, no strength, no dosage form, no molecule, no brand family, no
  prescription/OTC/controlled classification, no schedule. `category` is a free-text
  string and is the whole taxonomy.
- **No regulatory attributes.** No marketing-authorisation number, no registration
  status, no country-of-registration, no shelf life, no storage conditions
  (cold-chain!), no controlled-substance schedule.
- **No `Lot` / batch entity in core.** `Item.tracking` can say `lot`, but there is no
  entity to hold a lot. `pack-erp-grocery` defines `PerishableLot` — a *different pack*
  that extends retail, not core, and is not what an ERP-core deployment serves.
  **Lot and expiry tracking do not exist in the ERP the CRM will integrate with.**
- **No competitor products, no market/IMS data, no sample-eligible flag.**

---

## 6. Inventory and warehouse model — and "can a field rep be a stock location?"

Four entities:

- **`Warehouse`** — `code` (unique), `name`,
  `warehouse_type: distribution|retail|transit|manufacturing|**virtual**`,
  `address_line1`, `city`, `country`, `status: active|inactive|closed`.
  No `manager_id`, **no `employee_id`, no owner of any kind**, no geo coordinates,
  no parent/child nesting, no bin/zone entity.
- **`StockLevel`** — `item_id`, `warehouse_id`, `quantity_on_hand NUMERIC(16,3)`,
  `quantity_reserved`, `quantity_incoming`, `bin_location` (free text), `last_counted_at`.
  Indexed on `(item_id, warehouse_id)` — **but not unique on it**. Nothing prevents two
  rows for the same item/warehouse pair.
- **`StockMovement`** — `item_id`, `warehouse_id`,
  `movement_type: receipt|issue|transfer_in|transfer_out|adjustment|return`,
  `quantity`, `reference` (free text), `reason`, `occurred_at`.
- **`GoodsReceipt`** (procurement) — receipt against a `PurchaseOrder`.

### Three structural problems

1. **A transfer has no counterparty.** `StockMovement` carries a single `warehouse_id`.
   A transfer is two independent rows (`transfer_out` here, `transfer_in` there) with
   **no field linking them** — only the free-text `reference`. There is no transfer
   document, no in-transit state, no acceptance step, no way to detect a half-posted
   transfer. For rep replenishment this is a correctness problem, not a cosmetic one.
2. **Nothing keeps `StockLevel` and `StockMovement` consistent.** Grepping
   `operate-runtime`, `operate-runtime-pg` and `operate-server` for `StockLevel`,
   `StockMovement` or `quantity_on_hand` returns **zero hits outside the pack
   declaration**. There is no write-effect, no trigger, no job handler. Posting a
   movement does not change a level. Both tables are hand-maintained by whoever calls
   the API. The GL has real double-entry automation (§7); inventory has none.
3. **No lot, no expiry, no serial.** Covered in §5. For pharma samples this is
   disqualifying on its own.

### The direct answer

**Yes, mechanically. No, safely.**

You *can* model a field rep as a stock location today: create a `Warehouse` per rep with
`warehouse_type: "virtual"` and put the rep's `employee_number` in `code`. That is
clearly what `virtual` is for, and `StockLevel`/`StockMovement` will accept the rows.

What you get for free: a per-rep on-hand quantity per item, and an append-only movement
log.

What you do not get, and would have to build:

| Need | Status |
|---|---|
| Warehouse → Employee link | **Absent.** You would encode it in a free-text `code` and reconcile by string. There is no FK, so nothing enforces one warehouse per rep or prevents an orphan. |
| Balance maintained from movements | **Absent.** You post both the movement and the level, non-atomically, from outside. |
| Linked transfer with in-transit and acceptance | **Absent.** Two unlinked rows. |
| Lot + expiry per holding | **Absent.** Sample accountability without expiry is not defensible. |
| Serial / unit-level custody for controlled or high-value items | **Absent.** |
| Distinction between saleable stock, promotional material and regulated drug samples | **Absent.** `item_type` has no sample value; you would overload `category`. |
| Signature or acknowledgement on hand-over to an HCP | **Absent.** No e-signature (`gxp_signed` trait exists but no ERP entity uses it), no file attachment runtime (§13). |
| Reconciliation / cycle count for a rep's boot stock | **Absent.** `last_counted_at` is a bare timestamp with no count document. |

**Recommendation:** model sample and promo-material custody **in the CRM**, as a
first-class `SampleHolding` / `SampleTransaction` pair with lot and expiry, and mirror
only the aggregate movement into the ERP (a `StockMovement` of type `issue` from the
distribution warehouse) when material physically leaves ERP-controlled stock. Do not try
to make the ERP's `Warehouse`/`StockLevel` the system of record for rep-held samples —
it lacks lot, expiry, custody and balance integrity, and pharma sample accountability is
a regulatory obligation you cannot discharge on a table nothing keeps consistent.

---

## 7. Finance model

This is the strongest part of the ERP by a wide margin. The GL is genuinely implemented,
not just declared.

### Entities

**GL:** `LedgerAccount` (`account_code` unique, `account_type: asset|liability|equity|
revenue|expense`, `is_postable`), `JournalEntry` (`entry_number` sequence, `entry_date`,
`book_id → AccountingBook`, `fiscal_period_id → FiscalPeriod`,
`source: manual|invoice|bill|payment|payroll|fx_revaluation|depreciation|system`,
`state: draft|posted|reversed`), `JournalLine` (`ledger_account_id`,
**`cost_center_id → CostCenter`**, `debit`, `credit`, `currency`, `fx_rate NUMERIC(20,10)`,
`functional_debit`, `functional_credit`).

**Accounting depth:** `Currency`, `ExchangeRate`, `FiscalYear`, `FiscalPeriod`,
`AccountingBook` (parallel books by accounting standard), **`CostCenter`** (`code` unique,
`name`, `parent_id` — hierarchical, `manager_id → Employee`,
`segment: operating|geographic|product|service|other`, `is_active`).

**AR:** `Account`, `Contact`, `Invoice` (+ `document_type: invoice|credit_note`,
`credit_note_of`, `booking_rate`, `withholding_total`, `credit_amount`), `InvoiceLine`
(with per-line `tax_code_id`), `WhtCertificate`.

**AP:** `Vendor`, `Bill`, `BillLine`, `PurchaseOrder`, `PurchaseOrderLine`, `GoodsReceipt`.

**Treasury:** `Payment` — `direction: inbound|outbound`,
`method: bank_transfer|card|cash|cheque|ach|wire`, `invoice_id` **or** `bill_id`
(so partial payments accumulate against a specific document and auto-settle it),
`amount`, `cash_amount` (the gap books realised FX gain/loss), `state`, `bank_reference`.

**Expense claims:** `Expense` — `expense_number` (sequence), `employee_id` (required),
`category: travel|meals|lodging|supplies|software|training|other`, `amount`, `currency`,
`incurred_on`, `description`, **`receipt` (a `file` field)**,
`state: draft|submitted|approved|reimbursed|rejected`.

### Approval workflows that already exist

Every one is an `entityLifecycle` workflow compiled into `POST /v1/<resource>/{id}/<transition>`
routes, each guarded by a role-based permission.

| Entity | Transitions |
|---|---|
| `Invoice` | `send`, `mark_overdue` (automatic), `mark_paid`, `void` — plus a `P30D` sent→paid SLA escalating to `notify_accountant` |
| `Bill` | `approve`, `mark_overdue`, `mark_paid`, `void` |
| `PurchaseOrder` | `submit`, `approve`, `receive`, `close`, `cancel` — plus a `P3D` submitted→approved SLA |
| `Payment` | draft → pending → completed / failed / refunded |
| `JournalEntry` | `post`, `reverse` |
| **`Expense`** | **`submit`, `approve`, `reimburse`, `reject`** |
| **`LeaveRequest`** | `submit`, `approve`, `reject`, `cancel` |
| `Lead`, `Opportunity`, `Quote`, `SalesOrder`, `Shipment`, `WorkOrder`, `Project`, `ProjectTask`, `Timesheet`, `FixedAsset`, `MaintenanceOrder`, `TaxReturn` | 12 more lifecycles |

`Expense` grants: `submit` → `erp_admin`/`erp_accountant`/`hr_manager`;
`approve` and `reject` → `erp_admin`/`hr_manager`/`controller`;
`reimburse` → `erp_admin`/`ap_clerk`/`erp_accountant`.

**Approvals are role checks only.** There is no manager-hierarchy routing (the workflow
never reads `Employee.manager_id`), no amount threshold, no multi-step chain, no
delegation, and **no four-eyes at this layer** — the four-eyes invariant is enforced by
zod in the compliance packages (`forensics`, `access-reviews`, `incident-response`),
not in ERP document approval. The same `erp_admin` can submit and approve.

### Write-effects: the real double-entry engine

`packages/operate-runtime/src/write-effects.ts` (~1,700 lines) runs synchronously inside
the write transaction. An effect that throws aborts the write — by design, unlike event
emission, which is best-effort. Wired conditionally in `compile.ts` based on which
entities the manifest declares:

- **Recognition GL posting** — invoice `sent` → debit AR, credit revenue + tax payable,
  with per-`TaxCode` tax-line breakdown (VAT/GST) and per-jurisdiction default accounts
  from tenant settings; stamps `withholding_total` from withholding tax codes.
- **Credit-note GL posting** — AR reversal, honouring partial `credit_amount`.
- **Bill GL posting** — debit expense + input tax, credit AP.
- **Payment GL posting** and **payment settlement posting** — including realised FX
  gain/loss from the `amount` vs `cash_amount` gap.
- **Payment application** — partial payments accumulate against `invoice_id`/`bill_id`
  and auto-settle the document.
- **Unrealised FX revaluation** at period close, comparing period-end rate to the
  document's stamped `booking_rate`.
- **Booking-rate stamping** at issue/approval.
- **Journal reversal**, **WHT certificate clearing**, **invoice-void auto credit note**.

### Write-guards

- **`journalPostingGuard`** — a `JournalEntry` cannot post unbalanced.
- **`postedEntryImmutabilityGuard`** — a posted entry cannot be mutated.
- **`lockedDocumentGuard`** — writes into a closed `FiscalPeriod` are refused.

### Finance gaps that matter to the CRM

- **`Expense` has no GL effect.** An expense can travel draft → submitted → approved →
  reimbursed and **never touch the ledger**. There is no expense accrual posting, no
  reimbursement payable, no `Payment` linkage (`Payment` references `invoice_id`/`bill_id`,
  never `expense_id`). Reimbursement is a state flag.
- **No employee advances / floats.** No advance entity, no settlement against an advance,
  no outstanding-float balance. A rep given cash for a conference cannot be tracked.
- **No expense lines.** `Expense` is a single amount with one category — you cannot
  itemise a trip. No mileage, no per-diem, no multi-currency conversion on the claim.
- **`Expense` has no `cost_center_id`.** `CostCenter` is on `JournalLine` only, so a
  claim carries no dimension until (and unless) someone posts a manual journal.
  `Department.cost_center` is free text, not an FK.
- **No project/campaign dimension on `Expense`** — no `project_id`, no `account_id`.
  You cannot attribute spend to a customer or an activity.
- **`Expense.receipt` is a `file` field that maps to `JSONB`** with no upload runtime
  (§13). It stores whatever JSON you write; there is no storage service behind it.

---

## 8. API surface

**REST/JSON over HTTP.** No GraphQL, no gRPC, no RPC. The whole surface is compiled from
the manifest at boot by `packages/operate-runtime/src/compile.ts`; there is no static
route table and **no OpenAPI document is generated** (`requestSchemaSha256` /
`responseSchemaSha256` on every route are `null`).

### The 17-stage request pipeline

`receive → parse_request → validate_tls → parse_auth_credential → authenticate →
resolve_principal → match_route → negotiate_version → negotiate_content →
check_idempotency → check_rate_limit → validate_request_signature →
validate_request_schema → dispatch_handler → transform_response →
apply_security_headers → emit_audit`

Every request produces a schema-valid `PipelineExecution` with per-stage outcome, timing
and reason.

### Versioning

All routes are `apiVersion: "v1"` and every path begins `/v1/`. The gateway supports
`x-api-version` negotiation, `Deprecation`/`Sunset` headers and a `sunset_endpoint`
problem type — **none of which is exercised**: generated routes have `isDeprecated: false`,
`sunsetAt: null`, `successorOperationId: null`.

### Conventions

**Auth:** `x-api-key: <token>` or `Authorization: Bearer <Ed25519 JWT>`, plus
`x-tenant-id: <uuid>` (load-bearing — a JWT principal's tenant comes from this header,
and the gateway cross-checks it against the token).

**List response:**
```json
{ "data": [ … ], "page": { "limit": 50, "nextCursor": "…" } }
```
Read/create/update return the bare record. Delete returns `204`.

**Pagination:** opaque **keyset cursor**, `?limit=` (default 50, hard max 500),
`?cursor=`. Not offset-based. The cursor encodes the `(sort…, id)` tuple.

**Sorting:** `?sort=<field>&order=asc|desc` — only for fields the entity's `ListView`
marks sortable; otherwise the view's default sort is used silently.

**Filtering:** `?field=value` or `?field[op]=value` where
`op ∈ eq|ne|gt|gte|lt|lte|in|contains`. `in` takes repeated params or a comma list.
`contains` is a case-insensitive substring (trigram-accelerated). **A non-filterable or
unknown param is silently ignored**, so a filter you get wrong widens your result set
rather than erroring — verify filters against the served `UiSchema`, do not assume.

Filterable-by-default without any view config: every lifecycle `stateField` and every
reference (FK) field. That is what makes `?account_id=…` and `?state[in]=draft,sent` work
out of the box.

**Free-text:** `?q=term` — OR-of-`contains` across the entity's text-like fields,
narrowed to the list view's visible columns when a view exists.

**Projection:** `?fields=a,b,c` — comma list, pushed into SQL by the column store.

**Errors:** RFC 9457 `application/problem+json` at the gateway
(`{type, title, status, detail, …}`, types under `https://crossengin.io/errors/…`) —
but **handler-level errors return a plain `{error, detail}` body**
(`{"error":"forbidden","detail":"…"}`, `{"error":"not_found"}`,
`{"error":"tenant_required"}`). **Two different error shapes on the same API.** Write your
client to accept both.

**Idempotency:** `Idempotency-Key` header. Replay-hit returns the stored response;
same key + different body → `409` `idempotency-mismatch`. Generated routes set
`idempotencyRequired: false`, so the header is optional. **See §13 — the deployed server
never wires a Postgres idempotency store, so this is per-process and lost on restart.**

**Security headers:** HSTS, CSP (`default-src 'self'; frame-ancestors 'none'`),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
CORS allows `authorization, content-type, idempotency-key, x-api-version`.

### Concrete endpoints the CRM will need

Every entity gets five CRUD routes plus one per lifecycle transition.

**Read-only masters (the CRM's anti-corruption layer reads these):**

```
GET  /v1/employees              ?status=active&department_id=…&sort=family_name&limit=200&cursor=…
GET  /v1/employees/{id}
GET  /v1/departments            ?status=active
GET  /v1/positions
GET  /v1/items                  ?status=active&item_type=stock&category=…&q=…&fields=id,sku,name,list_price
GET  /v1/items/{id}
GET  /v1/price-lists            ?is_active=true
GET  /v1/price-list-items       ?price_list_id=…&item_id=…
GET  /v1/tax-codes              ?is_active=true
GET  /v1/currencys              ⚠ naive pluraliser: "Currency" → "currencys"
GET  /v1/exchange-rates
GET  /v1/warehouses             ?status=active&warehouse_type=virtual
GET  /v1/cost-centers           ?is_active=true
GET  /v1/ledger-accounts        ?account_type=expense&is_postable=true
GET  /v1/fiscal-periods
```

**Customer master (shared with the ERP — the CRM must not fork these):**

```
GET|POST        /v1/accounts
GET|PATCH|DELETE /v1/accounts/{id}
GET|POST        /v1/contacts    ?account_id=…&is_primary=true
```

**Pipeline (already modelled in the ERP — decide ownership, see §13):**

```
GET|POST /v1/leads              ?state[in]=new,working&owner_id=…
POST     /v1/leads/{id}/{start_working|qualify|convert|disqualify}
GET|POST /v1/opportunitys       ⚠ naive pluraliser
POST     /v1/opportunitys/{id}/{advance_to_qualification|advance_to_proposal|advance_to_negotiation|win|lose}
GET|POST /v1/quotes             POST /v1/quotes/{id}/{send|accept|reject|expire}
GET|POST /v1/quote-lines        ?quote_id=…
```

**Order capture (the CRM's main write path):**

```
POST /v1/sales-orders                       { account_id, order_date, currency, … }
POST /v1/sales-order-lines                  { sales_order_id, item_id, quantity, unit_price, … }
POST /v1/sales-orders/{id}/confirm|fulfill|invoice|close|cancel
GET  /v1/shipments                          ?sales_order_id=…&state[in]=shipped,delivered
```

**Expense claims (rep field spend):**

```
POST /v1/expenses                           { employee_id, category, amount, currency, incurred_on, … }
POST /v1/expenses/{id}/submit|approve|reimburse|reject
GET  /v1/expenses                           ?employee_id=…&state[in]=submitted,approved
```

**Stock (if you mirror sample movements):**

```
GET|POST /v1/stock-movements                ?item_id=…&warehouse_id=…&occurred_at[gte]=…
GET|PATCH /v1/stock-levels                  ?item_id=…&warehouse_id=…
GET|POST /v1/warehouses
```

**AR visibility (rep credit checks):**

```
GET /v1/invoices                            ?account_id=…&state[in]=sent,overdue&sort=due_date
GET /v1/payments                            ?account_id=…&direction=inbound
GET /v1/meta/aging                          AR + AP aging buckets (finance roles only)
GET /v1/meta/wht-reconciliation
```

**Association routes** (only for `many_to_many` relations; `pack-erp-core` declares none,
so these exist for future packs):

```
GET    /v1/<owner>/{id}/<related>
GET    /v1/<owner>/{id}/<related>/count
PUT    /v1/<owner>/{id}/<related>/{relatedId}     link
DELETE /v1/<owner>/{id}/<related>/{relatedId}     unlink
```

**Platform / meta routes:**

```
GET  /v1/meta/schema                        ⭐ the whole UiSchema — entities, fields, types,
                                              enums, references, lifecycles, permissions.
                                              Build the ACL's type generation from this.
GET  /v1/meta/entitlement                   caller tenant's plan + subscription status
GET  /v1/meta/usage                         per-entity record counts vs plan cap
GET  /v1/meta/notifications                 recency-approximated inbox
POST /v1/meta/jobs/invoke                   enqueue a userInvoked job
POST /v1/meta/billing-portal                Stripe portal session
GET|PUT /v1/admin/settings                  tenant settings (functional currency, GL account
                                              refs, tax accounts by jurisdiction)
POST /v1/webhooks/stripe                    inbound Stripe webhook
GET|POST /v1/platform/tenants               tenant provisioning  (--platform-admin)
POST /v1/platform/tenants/{id}/suspend|archive|reactivate
GET  /v1/platform/stats
GET|POST /v1/platform/design-reviews …      AI design review queue
POST /v1/ai/design, /v1/ai/design/jobs      AI Architect  (--ai-design)
GET  /v1/ai/manifests, POST …/{id}/activate|archive
GET|POST /v1/admin/packs …                  marketplace install/uninstall
GET|POST /v1/authoring/packs …              pack authoring  (--marketplace-authoring)
```

> **⚠️ The pluraliser is naive.** `resourceSlug` is kebab-case + a literal `"s"`.
> `Opportunity` → `/v1/opportunitys`, `Currency` → `/v1/currencys`,
> `BillOfMaterials` → `/v1/bill-of-materialss`. Do not "correct" these in your client.
> Derive slugs from `GET /v1/meta/schema` rather than hand-writing them.

---

## 9. Events, queues, jobs, webhooks

### What is wired and works

**Durable job queue in Postgres.** `meta.job_runs` + `meta.dead_letter_jobs` +
`meta.job_costs`. `workflow-runtime-pg` provides claim/lease with renew and release
(`claimDueTimers` / `claimDueActivities` / `claimDueJobs`), so multiple workers are safe.
`workflow-worker` is the thin generic loop (batch, renew lease while a handler runs)
with three concrete workers: timer, activity, job.

**Cron scheduling.** `--schedule-ms` ticks `enqueueScheduledJobs`; `PostgresTenantSource`
enumerates active tenants from `meta.tenants` each tick, so a newly provisioned tenant is
picked up automatically. `--schedule-all-tenants` or repeated `--schedule-tenant`.

**Entity events → jobs (the outbox-shaped path you care about).**
`--emit-entity-events` installs `entityEventEffect` as a write-effect. Every persisted
write emits `<prefix?>.<entity>.<verb>` where verb is `created` / `updated` / `deleted`
or the lifecycle target state (`salesorder.placed`). The event carries the full record
after the write and a deterministic `idempotencyKey` of
`<entity>:<operation>:<recordId>:<updated_at|verb>`. `PostgresEntityEventSink` maps it to
a `DomainEvent` and calls `enqueueJobsForEvent`, which inserts `pending` job runs with a
deterministic `run_id` and `ON CONFLICT DO NOTHING` — so redelivery collapses.
`--event-prefix` namespaces it.

> **This is the closest thing to an outbox the ERP has, and it is genuinely useful.**
> Two caveats: (a) it is **best-effort — a sink failure is swallowed** so it never fails
> the user's write, which means an event can be lost; (b) it enqueues *job runs*, not
> messages on a bus. There is no fan-out to an external subscriber.

**Event-sourced workflow engine.** `workflow-runtime` is a real append-only event log
with deterministic left-fold projection, automatic transitions until quiescent,
registered activity handlers, signal correlation with exactly-once dedup, timer firing,
and saga compensation planning. `workflow-runtime-pg` persists it with a
`ProjectingEventLog` and a drift replayer. Note: `engine.ts` still **throws on one
unimplemented action kind** — the only genuine stub in the TypeScript.

**Inbound webhooks.** `workflow-signal-bridge` verifies an HMAC-SHA256 signature with a
replay window, extracts a correlation key by field path, and submits a workflow signal.
`POST /v1/webhooks/stripe` verifies a Stripe signature with a tolerance window.

**Notification pipeline.** Planning → throttling → quiet hours → digest assembly →
`ChannelSender` → drain loop (`--notification-drain-ms`), with
`meta.notification_dispatches` / `_deliveries` / `_digests` / `_suppressions` / `_templates`.

**Other in-process schedulers** (all inside `operate-server`, which is why it cannot be
serverless): JWKS refresh, manifest-activation polling, dangling-link prune, forensic
chain checkpoints, SLO evaluation, access-review campaigns, Stripe usage sync.

### What is declared but not wired

- **Outbound webhooks do not exist as running code.** `meta.webhook_endpoints`
  (with `whk_` id regex, `https://` check, `signing_secret_sha256`, `hmac-sha256`,
  `consecutive_failures`) and `meta.webhook_deliveries` (with a full
  `pending|delivering|delivered|retrying|failed|dropped` state machine, `attempt`,
  `max_attempts: 8`, `payload_sha256`, `signature`) are in the meta-schema. **Grep for
  either table name across the workspace returns three hits: the schema definition, its
  test, and a rate-limiting quota target.** Nothing writes them. Nothing delivers them.
  **The ERP cannot push an event to the CRM over HTTP today.**
- **No message broker.** No Kafka, no RabbitMQ, no SQS, no Redis, no NATS, no
  `LISTEN`/`NOTIFY`. The queue is Postgres rows polled on an interval.
- **The 14 declared `erp-core-*` jobs have no handlers.** Overdue-invoice reminder,
  payment-gateway sync, bank-statement import, FX rate refresh, tax calculation,
  e-invoice submission, carrier tracking sync, lead enrichment, payroll disbursement,
  inventory reorder (MRP), sales-order → invoice, work-order completion, depreciation
  run — all are `JobDeclaration` objects with cron/event triggers, retry ladders and
  dead-letter policies. **No code registers a handler for any of them.** They would
  enqueue and then fail to dispatch.
- `packages/integrations` is thin contracts only: 12 integration kinds (outbound/inbound
  HTTP, GraphQL, HL7, FHIR, EDI, SFTP, webhook), credential refs, HMAC and retry policy
  shapes, plus `meta.integration_calls` audit rows. No client implementations.

---

## 10. Front-end

**`apps/operate-web`** — Next.js **14.2** app router, React 18.3, **Tailwind 3.4** with
PostCSS + autoprefixer. TypeScript.

**No component library.** No shadcn/ui, no Radix, no MUI, no Headless UI, no
`class-variance-authority`, no icon package. Twelve hand-rolled components:
`AccountCodePicker`, `Badge`, `ColumnChooser`, `DiffView`, `FieldInput`, `ReferenceLabel`,
`ReferencePicker`, `SchemaView`, `ShellBar`, `Sidebar`, `SubscriptionBanner`, `Topbar`.
Styling is inline Tailwind classes. ADR-0266 describes a "Fiori restyle", so the visual
language is SAP-Fiori-flavoured. There is **no design-token file, no theme provider, no
dark mode** (ADR-0271 lists dark theme as an open cosmetic item, as it does per-tenant
branding).

**Routes:** `/e/[slug]` and `/e/[slug]/[id]` (generic entity list / record / form,
rendered entirely from `GET /v1/meta/schema`), `/inbox`, `/reports/aging`, `/reports/wht`,
`/reports/period-close`, `/admin/settings`, `/admin/billing`, `/setup`,
`/platform`, `/platform/new`, `/platform/[id]`, `/platform/reviews`,
and the `/api/[...path]` proxy.

**The renderer is manifest-driven and genuinely generic** — that is the interesting part.
`buildUiSchema(manifest)` emits entities, fields, widget hints, enums, reference targets,
lifecycle transitions and permissions; the web app renders from it with zero
entity-specific code. If the CRM adds entities to the ERP manifest, they get a usable
admin UI free. (That is a real argument for option (a) in the ADR — and it is not enough.)

**Only `list`, `record` and `form` render.** `packages/views` declares eight view kinds —
list, record, form, **kanban, calendar, map**, dashboard, pivot. `pack-erp-core` declares
only `list` views, and the web app implements only list/record/form. Kanban boards,
route calendars and territory maps are vocabulary with no renderer.

**i18n:** `packages/i18n` is a real, well-built contracts package — BCP-47 locales, ICU
MessageFormat parsing, CLDR plural categories, bundles, resolution chains, calendar and
numbering systems, per-tenant config. `SUPPORTED_LOCALES_V1 = ["en", "ar", "ar-AE"]`;
`RTL_LOCALES` includes `ar`, `he`, `fa`, `ur`; `directionFor(locale)` returns `ltr`/`rtl`.

**But no application consumes it.** `@crossengin/i18n` is a dependency of `views`, `pwa`,
`kernel`, `notifications` and `billing` — **never of `operate-web` or `operate-server`.**
`app/layout.tsx` is hard-coded `<html lang="en">` with **no `dir` attribute**. Labels in
the packs are `{ en: "…" }` objects with no other locale populated. There are no
translation catalogues. Tailwind has no RTL plugin and no logical-property configuration.

**RTL support is a contract, not a feature.** Arabic is a founding target of this platform
(`ar` and `ar-AE` are the only non-English v1 locales, and ADR-0002's tenant examples are
Gulf healthcare) and the console cannot render it. For a Gulf/MENA pharma CRM this is a
build-it-yourself item, and doing it right from day one is much cheaper than retrofitting.

**PWA / offline:** `packages/pwa` declares a PWA manifest, service-worker cache
strategies, an **IndexedDB outbox with conflict strategies**, background sync, PHI-safe
push, and Capacitor native wrapper config. **Nothing depends on it.** There is no service
worker, no offline shell, no sync engine. The offline story is 100% the CRM's to build.

---

## 11. Testing, CI, deployment, environments, secrets, observability

### Testing

Vitest, node environment, `globals: false`, v8 coverage. **584 test files, ~9,285 tests**,
all green per `CLAUDE.md`. Convention: 15–35 tests per module covering constants, accept
*and* reject schema paths, helpers, and state-machine transitions.

Postgres-backed modules are tested **offline against a fake `PgConnection`** that records
`{sql, params}`; assertions are on recorded SQL and bound parameters. `CLAUDE.md` is
explicit that this catches SQL *shape* only, not type inference, RLS behaviour or
ordering, and that "several real defects in this repo were found only by booting a
throwaway cluster and the real server."

**There is no integration test suite against a live Postgres, and no E2E suite.** The
README claims Playwright and MSW; neither appears in any `package.json`.

### CI

**There is none. No `.github/` directory exists.** No workflows, no PR checks, no branch
protection automation, no release pipeline, no Dependabot. Everything — build, typecheck,
test, live verification — is run by hand per the workflow in `CLAUDE.md`.
**The CRM must bring its own CI and cannot assume the ERP's `main` is green on any given
commit.**

### Deployment

`deploy/` is a single-VM Docker Compose stack:

| Service | Role |
|---|---|
| `db` | Postgres with `pg_uuidv7` (custom image, `00-extension.sql` on first init) |
| `migrate` | one-shot `crossengin apply --confirm`, idempotent, gates the API on success |
| `api` | `operate-server --pack erp-core --store pg --port 8787 --scheme https --platform-admin --api-key …` |
| `web` | `next start`, proxying to `http://api:8787` |
| `caddy` | automatic TLS on :80/:443 |

One Dockerfile builds the whole workspace (`pnpm install --frozen-lockfile && pnpm -r
build && pnpm --filter @crossengin/operate-web build`) and Compose runs it three ways.

`deploy/docker-compose.ai.yml` and `…ai-gpu.yml` overlay a self-hosted model.
`deploy/VERCEL-SUPABASE.md` covers the managed path.

Two hard constraints:

- **`operate-server` must be a long-running process.** Its schedulers run in-process, so
  serverless can host `operate-web` but never the API.
- **Managed Postgres usually forbids C extensions**, so `pg_uuidv7` is unavailable;
  `deploy/supabase/00-uuidv7.sql` supplies a pure-SQL `uuid_generate_v7()`.

`packages/deploy` declares 4 environments (dev/staging/prod/on-prem) × 4 strategies and
forbids the `latest` docker tag — but that is contract vocabulary. **In practice there is
one environment: whatever the VM is running.**

### Secrets management

Plain environment variables and CLI flags. `deploy/.env` (git-ignored; there is no
`.env.example` in the tree despite the compose comment referencing one) carries
`POSTGRES_*`, `OPERATE_ADMIN_API_KEY`, `OPERATE_WEB_API_KEY`, `DOMAIN`, `ACME_EMAIL`.
API keys are passed as **argv** (`--api-key key:role:tenant`), so they are visible in
`ps`. Stripe keys, JWKS material and the licence key are likewise flags or files.
**No vault, no KMS, no secret rotation.**

`packages/crypto` + `crypto-pg` do provide a real per-tenant `KeyStore` with opaque
`KeyHandle`s, Ed25519 signing and rotation — used for pack signing, forensic chain
entries, webhook HMAC and evidence sealing. That is application-level key management,
not deployment secret management.

### Observability

Rich contracts, thin runtime:

- `packages/observability` — SLO definitions, error-budget compute, alert policies and
  channels, log/field redaction, synthetic checks, OTel-style span attributes.
- `observability-runtime` — real multi-window Google-SRE burn-rate evaluation, latency
  percentile evaluation, synthetic consecutive-failure detection, and pure planners that
  turn a breach into a declared incident + an on-call page + a kill-switch rollback.
  A `TraceCollector` stitches gateway → workflow → notification spans into a tree.
- `observability-runtime-pg` persists evaluations and enforcement actions with a replayer.
- `operate-server` wires SLO evaluation via `--slo-config` / `--slo-defaults`.

**But:** no OpenTelemetry SDK, no exporter, no Prometheus endpoint, no `/metrics`, no
`/healthz`, no structured logger, no Sentry, no APM agent, no dashboards.
"OTel-style span attributes" are zod schemas, not spans. There is nowhere for telemetry
to go. Per-request `PipelineExecution` rows in `meta.gateway_pipeline_executions` and
`meta.audit_log` are the actual operational record.

**Audit is split and unreconciled** (ADR-0279, flagged in `CLAUDE.md` as the most
consequential open item): `meta.audit_log` receives one row per request via the
`emit_audit` stage, and is **neither hash-chained nor signed**, while `packages/forensics`
+ `forensics-pg` ship a proper advisory-lock-serialised, Ed25519-signed hash chain with
checkpoints. Two audit paths that do not know about each other.

---

## 12. What the CRM can rely on — quick reference

| Capability | Status |
|---|---|
| Postgres with tenant RLS and a disciplined migration applier | ✅ solid |
| Composite tenant-scoped FKs `(tenant_id, id)` in the column store | ⚠️ correct in code, **but the column store is not deployed** — every deploy artifact runs `--store pg` (JSONB), where no such table exists. See R17. |
| Manifest-compiled REST CRUD + lifecycle transitions | ✅ solid |
| Keyset pagination, typed filters, `?q` search, `?fields` projection | ⚠️ solid on `pg-columns`; on the deployed JSONB store filters and sorts are **text comparisons** (numeric predicates are wrong) and `?q` has no trigram index. See R19. |
| RFC 9457 problem details at the gateway | ⚠️ two error shapes coexist |
| Manifest-driven RBAC + classification-driven response redaction | ✅ solid |
| Double-entry GL with tax breakdown, FX, payment application, period locks | ✅ solid, the best part of the codebase |
| Document numbering sequences with yearly reset | ✅ solid |
| Durable Postgres job queue with claim/lease and multi-worker safety | ✅ solid |
| Entity write → domain event → enqueued job | ✅ wired (best-effort) |
| Event-sourced workflow engine with sagas and signals | ✅ mostly (one stub action kind) |
| Inbound webhook → workflow signal with HMAC + replay window | ✅ solid |
| Generic manifest-driven admin UI | ✅ works, list/record/form only |
| **Row-level (ABAC) access scoping** | ❌ declared, never enforced |
| **User directory / login / token issuance / SSO** | ❌ contracts only, zero runtime |
| **Employee → login identity link** | ❌ does not exist |
| **Outbound webhooks** | ❌ tables only, no delivery code |
| **File/attachment storage** | ❌ contracts only |
| **Search engine (Typesense/pgvector)** | ❌ contracts only |
| **Offline / PWA / IndexedDB outbox** | ❌ contracts only |
| **i18n / RTL in the running apps** | ❌ contracts only, `lang="en"` hard-coded |
| **Lot / batch / expiry tracking** | ❌ not in core |
| **Stock balance maintained from movements** | ❌ no automation at all |
| **Expense → GL posting; employee advances** | ❌ absent |
| **Payroll** | ❌ absent |
| **CI** | ❌ absent |
| **Metrics / tracing / health endpoints** | ❌ absent |

---

## 13. Risks and gaps: what the CRM needs that the ERP cannot provide

Ordered by how much they should change the integration decision.

### R1 — No identity. The CRM must own authentication, and the link from login to Employee. **(critical)**

The ERP verifies Ed25519 JWTs and matches static API keys. It issues nothing, has no user
table in the auth path, and cannot tell you which `Employee` a caller is. A field-force
CRM is defined by "this rep, these accounts, this territory".

*Consequences:* the CRM needs its own IdP (or an external one minting **Ed25519** —
not RS256 — JWTs with the right `iss`/`aud`, scope-as-role, and a UUID `sub`), its own
session handling, and its own `user ↔ Employee` mapping table. Because
`principalRoles` reads **only the first scope**, a CRM user needs exactly one ERP role in
the token, or the ACL must call the ERP with a service credential and enforce user
identity itself. Recommend the latter: **the ACL holds one ERP service credential per
tenant and does user-level authorisation in the CRM**, because of R2.

### R2 — No row-level scoping. Every ERP read is tenant-wide. **(critical)**

`requiresAbac` is computed and discarded. A `sales_rep` token can list every `Lead`,
`Account`, `Opportunity` and `Invoice` in the tenant. There is no ownership predicate,
no territory filter, no manager-subtree visibility.

*Consequences:* the CRM cannot delegate authorisation to the ERP for any user-facing
read. Every rep-facing query must be filtered by the CRM against CRM-owned assignment
data. If the CRM ever proxies raw ERP responses to a mobile client, it leaks the entire
tenant. This alone rules out "just point the mobile app at the ERP API".

### R3 — No lot, expiry, or custody model. Sample accountability is not expressible. **(critical for pharma)**

No `Lot` entity in core, no expiry date anywhere, no serial tracking, no
`Warehouse → Employee` link, no linked transfer document, no e-signature on hand-over,
and — decisively — **nothing keeps `StockLevel` consistent with `StockMovement`**.

*Consequences:* the CRM must own sample and promo-material custody end-to-end, with lot
and expiry, and mirror only aggregate issues into the ERP's `StockMovement`. Plan for a
reconciliation report, because the two will drift and there is no ERP-side check.

### R4 — The ERP cannot push. There is no outbound event channel. **(high)**

`meta.webhook_endpoints` and `meta.webhook_deliveries` are unimplemented tables. There is
no broker, no `LISTEN`/`NOTIFY`, no CDC pipeline (`packages/reporting` declares one;
`meta.cdc_checkpoints` has no writer).

*Consequences:* either (a) the CRM polls the ERP API on `updated_at` — which every
entity has via the `auditable` trait, and which the `?field[gte]=` filter supports — or
(b) the CRM shares the database and reads the ERP's tables or a logical-replication slot
directly, or (c) someone implements the webhook deliverer. Option (b) is the reason
option (b) in the ADR is attractive. **`--emit-entity-events` is the nearest thing that
works, but it enqueues rows in `meta.job_runs`, and a CRM-side worker would have to
claim from that same queue — which means shared-database anyway.**

### R5 — No product taxonomy. Therapeutic grouping does not exist. **(high for pharma)**

No ATC, INN, molecule, strength, dosage form, brand family, Rx/OTC/controlled schedule,
marketing authorisation, storage condition, or shelf life. One free-text `category`.
No pack/UoM hierarchy — you cannot express "case → box → strip → tablet".

*Consequences:* the CRM owns the therapeutic and detailing taxonomy as **CRM-side
attributes keyed by the ERP `Item.id`** — an extension table, never a copy of the product.
Detailing plans, message hierarchies and competitor mapping are all CRM-native. Never mint
an `Item` in the CRM.

### R6 — Idempotency and rate limiting are in-memory in the deployed server. **(high, and it will bite an offline CRM)**

`buildOperateGateway` defaults to `InMemoryIdempotencyStore` and
`InMemoryRateLimitChecker({ limit: 10_000 })`. Grepping `apps/operate-server` for
`idempotencyStore` or `rateLimitChecker` returns **nothing** — the deployed binary never
overrides the defaults, even though `api-gateway-pg` ships Postgres implementations of
both (`meta.gateway_idempotency_records`, `meta.rate_limit_decisions`).

*Consequences:* replay protection dies on process restart and does not work across API
instances. An offline mobile client flushing a queue after a deploy **will double-post**.
Mitigations: the CRM's own outbox must be idempotent independently of the ERP; and
because `resolveRecordId` **accepts a client-supplied `id`** matching
`^[A-Za-z0-9_-]{1,200}$`, the ACL can mint deterministic ids and rely on the
`(tenant_id, entity, record_id)` unique constraint for dedup. That is the safest path and
should be a design rule. (Note also that `generateRecordId` uses `Date.now()` plus a
*process-local* counter — two API instances can collide; the unique constraint catches it,
but only if you look at the error.)

### R7 — Approvals are flat role checks; there is no hierarchy, threshold, or four-eyes. **(medium-high)**

`Expense.approve` is granted to `erp_admin` / `hr_manager` / `controller` as roles. The
workflow never reads `Employee.manager_id`. No amount bands, no multi-step chain, no
delegation, no segregation of duties — the same principal can submit and approve.

*Consequences:* if rep expense approval must route to the rep's line manager (it must),
the CRM owns the approval graph and calls the ERP's `submit`/`approve` transitions with a
service credential **after** its own approval completes. The ERP transition becomes a
record of an already-made decision, not the decision point.

### R8 — Expenses never reach the ledger, and there are no advances. **(medium-high)**

No expense GL write-effect, no `Payment` linkage to an `Expense`, no expense lines, no
`cost_center_id` on `Expense`, no project/campaign/account dimension, no advance or float
entity, no mileage or per-diem.

*Consequences:* field spend cannot be attributed to a campaign, account or cost centre
through the ERP's expense object. Either accept that (claims are reimbursement records
only) or post a manual `JournalEntry` with `cost_center_id` on each line via the API and
accept the reconciliation burden. Decide before building the expense module — see Q6.

### R9 — No storage service behind `file` fields. **(medium-high)**

`packages/files` (lifecycle, storage tiers, signed-URL operations, OCR, embeddings,
quotas) is contracts only; `meta.files` has no writer. `Expense.receipt` is a `file` field
that becomes an untyped `JSONB` column.

*Consequences:* the CRM must provide object storage (S3/R2/Supabase Storage) for receipts,
visit photos, signed detailing forms and e-detailing assets, and write a reference into the
ERP's `JSONB` — or keep attachments entirely CRM-side and pass only a URL. Prefer the
latter.

### R10 — No offline runtime, and no RTL in the running apps. **(medium-high — this is most of the CRM's client work)**

`packages/pwa` declares an IndexedDB outbox with conflict strategies and background sync;
nothing implements it. `packages/i18n` is complete and unused: `app/layout.tsx` is
hard-coded `lang="en"` with no `dir`, no catalogues, no RTL plugin, and the packs' labels
are `{ en: … }` only.

*Consequences:* offline-first sync, conflict resolution and Arabic RTL are entirely CRM
work. Budget for them as first-class features, not polish. Build RTL in from the first
component — retrofitting logical properties across a component library is far more
expensive than starting with them.

### R11 — No CI, no metrics, no health endpoint, and unsigned audit. **(medium)**

No `.github/`. No `/healthz`, no `/metrics`, no tracing exporter, no structured logger.
`meta.audit_log` is neither chained nor signed while `forensics` ships a chain that the
request path does not use (ADR-0279).

*Consequences:* the CRM brings its own CI, health checks and observability, and must not
assume the ERP is monitored. If pharma compliance requires a tamper-evident audit of
CRM↔ERP writes, the CRM must produce it — the ERP's request audit will not satisfy an
auditor as-is.

### R12 — Additive-only schema migration, and per-tenant manifests get no DDL. **(medium)**

`ensureSchema` only does `ADD COLUMN IF NOT EXISTS`, dropping `NOT NULL` when there is no
default. A removed field's column is never dropped; a changed type is never altered
(ADR-0283). And per-tenant activated manifests receive **no DDL at all** — the column
store is built from the boot manifest alone.

*Consequences:* if the CRM ever contributes entities to the ERP manifest, field removals
and type changes are manual DBA work. More importantly, **per-tenant schema divergence via
the AI Architect does not reach the column store**, so a CRM that assumed per-tenant
entity tables would break.

### R13 — Two error shapes, a naive pluraliser, and silently-ignored filters. **(medium — integration correctness)**

Gateway errors are RFC 9457 `application/problem+json`; handler errors are
`{error, detail}`. `resourceSlug` appends a literal `s` (`/v1/opportunitys`,
`/v1/currencys`). An unknown or non-filterable query param is **silently dropped**, so a
mistyped filter returns *more* rows, not an error.

*Consequences:* the ACL must handle both error shapes, derive every slug and every
filterable field from `GET /v1/meta/schema` rather than hand-writing them, and **assert on
the shape of results** rather than trusting that a filter applied. Generate the ACL client
from `/v1/meta/schema` at build time and fail the build when it drifts.

### R17 — The ERP is deployed on `--store pg` (JSONB), not `pg-columns`. Cross-schema foreign keys are impossible today. **(critical — this is Q1, and it gates the integration architecture)**

Checked every deployment artifact in the repo. All of them run the **JSONB store**:

| Artifact | Store |
|---|---|
| `deploy/docker-compose.yml` l.63–64 | `--store` `pg` — **hardcoded list items**, not `${…}`, so no env override (contrast `--pack ${OPERATE_PACK:-erp-core}` two lines above) |
| `deploy/docker-compose.ai.yml` l.66–67 | `--store` `pg` (the overlay repeats the whole command because Compose replaces rather than merges) |
| `deploy/VERCEL-SUPABASE.md` l.71 | `--pack erp-core --store pg --port 8787 …` |
| `deploy/docker-compose.ai-gpu.yml` | no store flag (overlays the model service only) |
| `scripts/run-dev.ps1` l.25 | `[string]$Store = "memory"` |
| CLI default when `--store` is omitted | `memory` (`cli.ts:142`) |

**Nothing in the repository deploys `pg-columns`.**

On `--store pg` every record of every entity of every tenant is one row in
`meta.operate_entity_records`, with the business data in an untyped JSONB `document`
column. There are no per-entity tables, therefore **no columns to reference, therefore no
foreign keys** — from the CRM or from anywhere. Filters, sorts and projections are JSONB
path expressions, and the only indexes are `(tenant_id, entity)` plus the uniqueness
constraint.

And `pg-columns` is not a settled alternative you can simply switch on. **ADR-0283
(2026-08-26, Accepted — the second-newest ADR in the repo, six days before this report)
is titled "The served table is what the manifest says" and records that `pack-erp-core`
booted on `pg-columns` for the first time in that change.** Before it, the flagship pack
died at startup with `operator class "gin_trgm_ops" does not accept data type character`
because `country_code` emits `CHAR(2)` — confirmed by the author as pre-existing by
reproducing it on the unmodified tree. The same ADR fixed a second defect: `ensureSchema`
issued only `CREATE TABLE IF NOT EXISTS`, so **any manifest that gained a field bricked
the server on restart** (`fatal: column "triage_level" does not exist`).

So the column store is six days old in any usable form, has never been deployed, and has
no CI behind it.

*Consequences:* the ADR's headline argument — enforced `(tenant_id, id)` foreign keys from
a CRM schema into ERP tables — is **conditional on a store migration that has not
happened**. Two paths: (i) migrate the ERP deployment to `--store pg-columns`, which means
backfilling every existing JSONB record into typed tables (no migration tool exists for
this) and accepting a barely-exercised code path; or (ii) accept that the CRM's
"references" to ERP records are unenforced `TEXT` ids validated by the ACL rather than by
Postgres, which materially weakens option (b) — it keeps the local-read and single-backup
advantages but loses the integrity guarantee that distinguished it from option (c).
**Do not start CRM schema work until this is decided.**

### R18 — Under `--per-tenant-manifests`, a `pg-columns` deployment is silently mixed. **(high, if per-tenant manifests are ever enabled)**

`apps/operate-server/src/node.ts:1023–1031`: when `--per-tenant-manifests` is on, a tenant
serving a custom (AI-Architect-authored) manifest is served from the **JSONB
`PostgresEntityStore`** — even in a `pg-columns` deployment — because the column plans are
derived from the boot manifest at startup and the store "only knows the boot pack's
entities". The comment is explicit that this is to avoid 500ing on every unplanned entity.

*Consequences:* in such a deployment, tenants on the boot pack have typed tables with FKs
and tenants on a custom manifest have JSONB rows with neither. A CRM foreign key would
hold for some tenants and be structurally impossible for others, with nothing signalling
which is which. Combined with R12 (per-tenant manifests never get DDL at all), this means
**option (b)'s integrity guarantee is per-tenant, not per-deployment.** Either
`--per-tenant-manifests` stays off wherever the CRM is deployed, or the CRM must tolerate
both cases — which in practice means tolerating the weaker one.

### R19 — On the deployed JSONB store, every filter and sort compares as **text**. Numeric comparisons are wrong. **(high — direct consequence of R17)**

The two stores build their list SQL through the same `ListSqlAdapter` seam but supply
opposite `castSuffix` implementations:

| Store | `columnExpr` | `castSuffix` | Effect |
|---|---|---|---|
| `ColumnMappedEntityStore` (`column-store.ts:169–179`) | `"total"` (real typed column) | `` `::${m.sqlType}` `` → `::NUMERIC(16,2)` | filters and sorts compare **on the native type** |
| `PostgresEntityStore` (`entity-ops.ts:43–47`) — **the deployed one** | `document ->> 'total'` | `() => ""` — **no cast** | filters and sorts compare **as text** |

So on the deployed configuration:

- `?total[gt]=1000` is a **string** comparison. `"999" > "1000"` is true in text collation, so
  the filter returns rows it should exclude and excludes rows it should return.
- `?sort=amount` orders lexicographically: `100`, `20`, `9`. The keyset cursor is built from
  the same text values, so pagination is *internally consistent with the wrong order* —
  it will not error, it will just be wrong, page after page.
- ISO-8601 dates and datetimes are **safe by accident**: lexicographic order equals
  chronological order for `YYYY-MM-DD` and RFC 3339. `?due_date[gte]=…` is correct.
- Booleans and enums are safe (equality only). Decimals, integers and money are not.

There is no index to help either. `meta.operate_entity_records` carries only
`(tenant_id, entity)` and the unique `(tenant_id, entity, record_id)` — **no GIN on
`document`** — so any business-field predicate is a scan within the tenant+entity slice.
And the CRM cannot add one: creating an index on `meta.operate_entity_records` requires
ownership of that table, which is precisely what R16 forbids the CRM role from having.

*Consequences:* the CRM must never rely on the ERP API (or on raw JSONB reads) for numeric
filtering, numeric sorting, or aggregation. Anything of that shape — "invoices over
X", "top accounts by balance", "items under reorder point" — belongs in a CRM-owned
snapshot table with real column types. This promotes the snapshot tables from a
performance convenience to a **correctness requirement**, and it is the single strongest
practical argument for the platform eventually moving to `pg-columns`.

### R20 — The tenant-isolation policy raises rather than returning empty on a pooled connection. **(medium — affects the ERP itself, and every client of it)**

Every tenant-scoped table in CrossEngin carries the same policy:

```sql
USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
```

Verified live on Postgres 16.13 that this behaves **two different ways** depending on what
the connection did previously:

| Connection state | `current_setting(…, true)` | Result |
|---|---|---|
| Fresh — GUC never set | `NULL` | predicate is `NULL` → **0 rows** |
| Reused after any tenant-scoped transaction | `''` (the GUC's reset value) | `''::UUID` → **`ERROR: invalid input syntax for type uuid: ""`** |

`set_config(..., is_local => true)` discards the *value* at transaction end, but the GUC
itself now exists on that backend and reverts to the empty string rather than to unset.

Both behaviours are fail-closed — neither leaks a row — so this is a robustness and
observability problem, not a security one. But in a connection-pooled server, which
`operate-server` is, the second row is the **normal** case after the first request. So the
ERP's documented posture ("an unresolvable identity yields an empty result set, never an
unfiltered one", `CLAUDE.md`) holds only on a pristine connection; in practice a query that
misses `withTenantContext` surfaces as a type-cast error, most likely as a 500.

*Consequences:* the CRM's own policies wrap the setting in `NULLIF(..., '')`, which
collapses both cases to "no rows" so a forgotten tenant context fails the same way every
time. This is the **only** deliberate divergence from the ERP's policy text and it is
recorded in ADR-0001 item 2. Worth passing to the platform team: it is a one-word change
per policy on their side, and it would make their fail-closed claim true as written.

### R14 — No PostGIS. `geo_point` would not create. **(low-medium)**

`geo_point` → `geography(POINT)` and `geo_polygon` → `geography(POLYGON)` are in the
field-type map, but PostGIS is not in `deploy/postgres/init/00-extension.sql` and appears
nowhere in the workspace. Only `pg_uuidv7`, `pg_trgm`, `unaccent` and `pgcrypto` are ever
created.

*Consequences:* an ERP entity with a geo field would fail `ensureSchema`. GPS check-in,
territory polygons and route optimisation are CRM-side, and the CRM's own database needs
PostGIS enabled explicitly.

### R15 — ADR-0002 (schema-per-tenant) does not describe the running system. **(low, but read it as a warning)**

ADR-0002 is still *Proposed* and specifies `t_<short_uuid>` schema-per-tenant with
database-per-tenant for enterprise tiers. The implementation is shared-schema + RLS
throughout. 79 of the 280 ADRs are still *Proposed*, largely Phase-1 design documents
never re-statused.

*Consequences:* **treat the code as the specification and the ADRs as intent.** Anything
this report asserts was read from source; do not re-derive requirements from a *Proposed*
ADR without checking. And note the corollary: if CrossEngin ever *does* move to
schema-per-tenant, a CRM that reaches into ERP tables by name breaks. Route reads through
the ACL, never inline.

### R16 — RLS is bypassed by the table owner. **(low likelihood, catastrophic impact)**

`CLAUDE.md` states this was verified empirically. Cross-tenant reads are granted
explicitly in application code; the guarantee is not "the role cannot see other tenants",
it is "this role is not the owner and the policy applies".

*Consequences:* **the CRM's database role must never own ERP tables and must never be
superuser or the migration role.** If option (b) is chosen, provision at least three
roles: the ERP migrator/owner, the ERP runtime role, and a CRM runtime role with
`SELECT`-only grants on the ERP schema. Verify with a live cross-tenant read test in CI,
not by inspection.

---

## Appendix A — orientation for whoever reads the ERP next

- `CLAUDE.md` (37 KB) is the accurate, current map. The root `README.md` is
  **badly stale** — it claims 51 packages, 119 meta tables, 5,768 tests and one app.
  Actual: 82 packages, 139 meta tables, ~9,285 tests, three apps. Read `CLAUDE.md`.
- `docs/adr/index.md` — 280 ADR files, generated index; 200 Accepted, 79 Proposed.
  ADRs 0080–0085 were reserved and never written; the gap is permanent.
- Start reading at `packages/kernel/src/bootstrap/meta-schema.ts` (the 139-table catalog),
  then `packages/operate-runtime/src/compile.ts` (how a manifest becomes an API),
  then `packages/pack-erp-core/src/entities-*.ts` (the business model),
  then `apps/operate-server/src/cli.ts` (what the deployment actually turns on).
- Working branch discipline in the ERP repo: `CLAUDE.md` names
  `claude/eloquent-archimedes-bn69tr`; never `--no-verify`, never force-push except
  `--force-with-lease` when resetting an already-merged branch to `origin/main`.

## Appendix B — the `operate-server` flags an integration cares about

```
--store pg | pg-columns | (in-memory default)   pg-columns gives real typed tables + composite FKs
--schema <name>                                 entity-store schema (default meta)
--pack erp-core | erp-retail | …                boot manifest
--manifest <path>                               or a manifest file (mutually exclusive with --pack)
--api-key key:role:tenant[:principalId]         repeatable, in-memory, visible in `ps`
--jwks-url | --jwks-file | --jwks-key kid:b64   Ed25519 only
--jwt-issuer / --jwt-audience                   required when a JWKS is configured
--emit-entity-events / --event-prefix <p>       write → domain event → enqueued job run
--schedule-ms N --schedule-all-tenants          cron tick
--enable-job-invoke --job-invoke-role <r>       POST /v1/meta/jobs/invoke
--notification-drain-ms N                       notification delivery loop
--platform-admin --platform-admin-role <r>      /v1/platform/tenants…
--per-tenant-manifests --manifest-refresh-ms N  activation poller (no column-store DDL — R12)
--ai-design --design-review --require-design-review
--audit-chain-config / --checkpoint-config      hash-chained audit (separate from meta.audit_log)
--slo-config | --slo-defaults
--stripe-webhook-secret / --plan-catalog / --stripe-api-key
--license <file> --license-key <base64 ed25519 pub>
```
