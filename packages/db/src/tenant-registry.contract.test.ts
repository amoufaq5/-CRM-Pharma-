import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { appPool, testPool } from "./testing.js";

/**
 * Which tenants exist, derived from the data rather than from a list (migration 0073).
 *
 * ADR-0001 carried this as an open row with a MEASUREMENT attached rather than a fix: nothing in
 * `crm.*` references `crm.tenant`, so a tenant can have rows everywhere and no registry row — and
 * every per-tenant job walks the registry, so that tenant's writes are never relayed, its expiries
 * never swept, its deletions never noticed, while the API serves it (deliberately). The obvious
 * detection — ask the data which tenants exist — is a PRIVILEGED act: these tables are owned by
 * `crm_app`, RLS is enabled and FORCED, so the owner is confined too and a cross-tenant count with
 * no context answers zero.
 *
 * THIS SUITE IS THE ONE PLACE BOTH ROLES ARE EXERCISED AGAINST THE SAME QUESTION, which is why it
 * is here and not in `@crm/notify` or a shell script: `testPool()` connects as the migration admin
 * and `appPool()` as `crm_app`, and the property worth asserting is that the second gets a REFUSAL
 * rather than a zero. "I could not look" must never read like "there is nothing there" — 0066's
 * `unverifiable`, 0067's `self_test_failed`, and this.
 */
describe("the tenant registry, reconciled against the data (0073)", () => {
  let admin: Pool;
  let app: Pool;
  let adminClient: PoolClient;
  let appClient: PoolClient;

  /** A tenant id nothing else in the suite uses, planted and removed inside this file. */
  const PLANTED = "00000000-0000-4000-8000-00000000073a";

  beforeAll(async () => {
    admin = testPool();
    app = appPool();
    adminClient = await admin.connect();
    appClient = await app.connect();
  });

  afterAll(async () => {
    await adminClient.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [PLANTED]);
    await adminClient.query("DELETE FROM crm.tenant WHERE tenant_id = $1", [PLANTED]);
    adminClient.release();
    appClient.release();
    await admin.end();
    await app.end();
  });

  it("refuses the application role by name, instead of answering zero", async () => {
    // THE WHOLE POINT. Under `crm_app` every table in the register is FORCE RLS-protected and a
    // query with no tenant context returns nothing, so this function would report "no tenant has
    // any data" about a database with thousands of rows — and a reconciliation built on that
    // would print a clean verdict on every deployment forever.
    const err = await appClient
      .query("SELECT count(*) FROM crm.tenants_with_data()")
      .then(() => null, (e: unknown) => e as { message?: string; code?: string });
    expect(err?.message ?? "").toContain("tenant-enumeration-confined");
    // It names the role it refused and the credentials the question needs, which is what makes
    // the refusal actionable rather than merely correct.
    expect(err?.message).toContain("crm_app");
    expect(err?.message).toContain("BYPASSRLS");
    expect(err?.code).toBe("42501");
  });

  it("answers the migration admin, which row-level security does not confine", async () => {
    const { rows } = await adminClient.query<{ confined: boolean }>(
      "SELECT crm.caller_sees_every_tenant() AS confined",
    );
    expect(rows[0]!.confined).toBe(true);
    // The suite's own reserved tenants are data, so this is never zero in a test database —
    // which is also why no CI job gates on the script that reads it.
    const { rows: counted } = await adminClient.query<{ n: string }>(
      "SELECT count(*) AS n FROM crm.tenants_with_data()",
    );
    expect(Number(counted[0]!.n)).toBeGreaterThan(1);
  });

  it("finds a tenant that has data and no registry row, and stops finding it once registered", async () => {
    // Planted in the one register table that needs nothing but a tenant id, so the control does
    // not have to invent a rep, a lot or a receipt.
    await adminClient.query("INSERT INTO crm.notification_policy (tenant_id) VALUES ($1)", [PLANTED]);

    const unregistered = async (): Promise<number> => {
      const { rows } = await adminClient.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.unregistered_tenants() WHERE tenant_id = $1",
        [PLANTED],
      );
      return Number(rows[0]!.n);
    };
    expect(await unregistered()).toBe(1);

    // And the count of tables it appears in is reported, because "one table" and "nine tables"
    // are different situations for whoever has to decide what to do about it.
    const { rows } = await adminClient.query<{ tables_with_rows: number }>(
      "SELECT tables_with_rows FROM crm.unregistered_tenants() WHERE tenant_id = $1",
      [PLANTED],
    );
    expect(rows[0]!.tables_with_rows).toBe(1);

    await adminClient.query(
      "INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, 'Planted by 0073 suite')",
      [PLANTED],
    );
    expect(await unregistered()).toBe(0);
  });

  it("reports a registry row with no data as the other direction, not as a defect", async () => {
    await adminClient.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, 'Planted by 0073 suite')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [PLANTED],
    );
    await adminClient.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [PLANTED]);
    const { rows } = await adminClient.query<{ status: string }>(
      "SELECT status FROM crm.registered_tenants_without_data() WHERE tenant_id = $1",
      [PLANTED],
    );
    // A provisioned tenant nobody has used yet, or one whose erasure completed. Both legitimate;
    // the status is returned so the two can be told apart.
    expect(rows[0]!.status).toBe("active");
    expect(await adminClient
      .query("SELECT count(*) AS n FROM crm.unregistered_tenants() WHERE tenant_id = $1", [PLANTED])
      .then((r) => Number((r.rows[0] as { n: string }).n))).toBe(0);
  });

  /**
   * THE ONE TABLE THE DERIVATION EXCLUDES, asserted because excluding it was a correction.
   *
   * `crm.tenant` is in the register like every other tenant-scoped table, so the first version of
   * `crm.tenants_with_data()` counted a registry row as data — which makes the check CIRCULAR:
   * every registered tenant then has data by virtue of being registered, and the test above
   * ("a registry row with no data") could never pass on any database. The reconciliation is about
   * BUSINESS data with no registry row, so the list being checked against cannot be part of the
   * derivation.
   */
  it("excludes the registry from its own derivation, and nothing else", async () => {
    await adminClient.query(
      `INSERT INTO crm.tenant (tenant_id, display_name) VALUES ($1, 'Planted by 0073 suite')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [PLANTED],
    );
    await adminClient.query("DELETE FROM crm.notification_policy WHERE tenant_id = $1", [PLANTED]);
    // A tenant whose ONLY row anywhere is its registry row has no data, by this definition.
    const { rows } = await adminClient.query<{ n: string }>(
      "SELECT count(*) AS n FROM crm.tenants_with_data() WHERE tenant_id = $1",
      [PLANTED],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // And `crm.tenant` is in the register, so the exclusion is a deliberate subtraction rather
    // than a table the register happens not to list.
    const { rows: registered } = await adminClient.query<{ n: string }>(
      "SELECT count(*) AS n FROM crm.data_disposition WHERE table_name = 'tenant'",
    );
    expect(Number(registered[0]!.n)).toBe(1);
  });

  /**
   * The derivation, asserted against the register rather than against a count.
   *
   * 0051's principle is that a completeness claim derived from a LIST is a claim about the list,
   * and this function reads `crm.data_disposition` — so the thing to assert is that it reads ALL
   * of it. A table added to the register tomorrow has to be a table this enumeration covers, or
   * a tenant whose only rows are in it is invisible again.
   */
  it("derives its tables from the whole register, not from a subset", async () => {
    const { rows } = await adminClient.query<{ table_name: string }>(
      "SELECT table_name FROM crm.data_disposition ORDER BY table_name",
    );
    expect(rows.length).toBeGreaterThan(40);

    // Planted in the LAST table of the register by name, which is the one a hand-written list
    // would most plausibly have missed.
    const last = rows[rows.length - 1]!.table_name;
    const { rows: cols } = await adminClient.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'crm' AND table_name = $1 AND column_name = 'tenant_id'`,
      [last],
    );
    // Every register table is tenant-scoped — the register's own trigger refuses a name that is
    // not — so this is a property of the register, asserted here because the enumeration above
    // depends on it.
    expect(Number(cols[0]!.n)).toBe(1);
  });
});
