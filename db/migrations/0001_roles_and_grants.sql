-- 0001_roles_and_grants.sql
-- @requires: dba
--
-- DBA STEP. Run once per cluster as a superuser, NOT by the CRM at runtime.
-- Roles are cluster-wide objects; the CRM's own migrations (0002+) run as
-- crm_app and must never need this file's privileges.
--
-- ADR-0001 decision item 2. The separation below is the isolation guarantee, not
-- a convention: a table's OWNER bypasses row-level security (verified live, see
-- packages/db/src/rls.contract.test.ts), so crm_app owning an ERP object would
-- read every tenant's data regardless of RLS policy.
--
--   erp_owner  owns the ERP's meta schema and its tables (CrossEngin migrations)
--   erp_app    the ERP runtime; non-owner, so RLS confines it
--   crm_app    the CRM runtime; owns crm.*, and NOTHING on the ERP — not even SELECT

-- PRECONDITION: the ERP must already be migrated into this database.
--
-- WHAT THIS SAID UNTIL ADR-0001 ITEM 42, AND WHY IT WAS WRONG. It required
-- `meta.operate_entity_records` specifically, and gave the reason as "the CRM
-- reads ERP master data over SQL and grants itself SELECT on that table". The
-- CRM does not read ERP master data over SQL and never did: every read goes
-- over HTTP through `ErpClient`, which is what ADR-0001 Q5 decided ("entity
-- names, not tables") and what the live gate exercises. The sentence was a
-- claim about a design that was considered and not built, and it invited
-- exactly the thing ADR-0001 item 5 forbids — the grants it justified are gone
-- (see the REVOKE below).
--
-- WHAT IS STILL WORTH REFUSING, which is the question that had to be answered
-- before the sentence could be deleted rather than merely corrected. ADR-0001
-- chose a SHARED database (option b), and a database with no ERP in it means
-- somebody pointed the CRM at the wrong one. That is worth refusing to migrate
-- into: the CRM would come up, serve reps, queue writes, and send them over
-- HTTP to an ERP whose own data lives somewhere else — and nothing downstream
-- would say so, because the HTTP path does not care which database it is
-- deployed beside. So the check stays and the SUBJECT narrows, from one table
-- to the schema: "is an ERP in this database at all".
--
-- Local development and CI have no real ERP; scripts/setup-test-db.sh builds a
-- faithful stand-in for exactly this reason.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'meta') THEN
    RAISE EXCEPTION
      'schema "meta" was not found, so there is no CrossEngin ERP in this database. ADR-0001 deploys the two side by side, and a CRM migrated beside the wrong database would come up, serve reps and queue writes to an ERP whose own data is somewhere else — with nothing downstream saying so, because every CRM read of the ERP goes over HTTP. Run the ERP''s `crossengin apply` into this database first, or scripts/setup-test-db.sh for a local stand-in.'
      USING ERRCODE = 'invalid_schema_name';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN;
  END IF;
END
$$;

-- crm_app must never be able to escalate past RLS.
ALTER ROLE crm_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

CREATE SCHEMA IF NOT EXISTS crm AUTHORIZATION crm_app;

-- NO REACH INTO THE ERP AT ALL, as of ADR-0001 item 42 — and this is a REVOKE of grants this
-- file used to issue, not merely their absence.
--
-- It granted `USAGE ON SCHEMA meta` and `SELECT ON meta.operate_entity_records`,
-- narrowly and deliberately, for an SQL read path that was designed and never
-- built. Nothing in `packages/` has ever selected from that table; the only
-- occurrences of the name are two tests quoting an ERP unique-constraint
-- message. Every read goes over HTTP through `ErpClient`.
--
-- An unused grant is not neutral. It is an invitation to the thing ADR-0001
-- item 5 forbids, and the ERP's own ADR-0314 has since made that path actively
-- wrong: a tenant serving an activated manifest is served from its OWN schema,
-- so an SQL read of `meta.operate_entity_records` would return zero rows for
-- them — silently, under a fail-closed rule that reads an empty set as "no
-- products". Because the CRM reads over HTTP, 0314 costs it nothing; the hazard
-- was the privilege sitting there waiting for somebody to use it.
--
-- REVOKED RATHER THAN DELETED FROM THIS FILE, because this is a DBA migration
-- and DBA migrations run on EVERY deploy. Removing the GRANT lines would leave
-- the privilege in place on every database that has already been migrated,
-- where nothing would ever take it away. An explicit REVOKE is idempotent, so
-- it is correct on a fresh database too — and `IF EXISTS` on the table, because
-- a fresh database has the schema (the precondition above insists) but a
-- stand-in need not have that one table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'meta' AND table_name = 'operate_entity_records') THEN
    EXECUTE 'REVOKE ALL ON meta.operate_entity_records FROM crm_app';
  END IF;
END
$$;
REVOKE ALL ON SCHEMA meta FROM crm_app;

-- The CRM talks to the ERP over its HTTP API, never over SQL (ADR-0001 item 5),
-- and since ADR-0001 item 42 that is a property of the PRIVILEGES rather than a convention:
-- `crm_app` cannot so much as resolve a name in `meta`. `schema.contract.test.ts`
-- asserts it holds no privilege there at all, so a grant added back has to
-- argue with a test.
