import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_CONFIG_LOG as TENANT,
  TENANT_CONFIG_LOG_OTHER as OTHER,
  testPool,
  wipeConfigChanges,
} from "./testing.js";
import { withTenantContext } from "./tenant-context.js";
import { ACTOR_SETTING, REASON_SETTING, UnattributedChangeError, withAttribution } from "./attribution.js";
import { CONFIG_LOG_LIMIT, configChanges } from "./config-log.js";

/**
 * Migration 0061's mechanism, as a mechanism.
 *
 * `accounts.contract.test.ts` next door proves it works on the real table Finance owns. This
 * file proves the GENERIC rules, and it does that the only way they can honestly be proved: by
 * attaching `crm.require_config_attribution` to scratch tables built to pose one question each.
 * The two production tables cannot pose them — neither has a column with a volatile default,
 * neither lacks a primary key, and `crm.notification_policy` has exactly one shape of key — so
 * a suite that only used them would be asserting the mechanism's rules against the one case
 * each rule happens to meet today.
 *
 * `testPool()` with `SET ROLE crm_app`, the pattern `expense.contract.test.ts` established:
 * the DDL below needs schema ownership and every write has to run as the application does, with
 * row-level security on. `crm.config_change` is FORCE ROW LEVEL SECURITY precisely so that
 * owning it is not a way past it, which is what makes the isolation test at the bottom mean
 * something.
 */
describe("a configuration change is a record (0061)", () => {
  let pool: Pool;
  let client: PoolClient;

  let rep = "";
  let otherRep = "";

  const REASON = "an operator changing a knob under test";

  /** Dropped and re-created by this suite, and registered with 0051 while they exist. */
  const PROBE_TABLES = [
    "config_probe",
    "config_probe_volatile",
    "config_probe_txclock",
    "config_probe_nokey",
  ] as const;

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const signed = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    inTenant((tx) => withAttribution(tx, { repProfileId: rep, reason: REASON }, fn));

  /**
   * One row per question.
   *
   * `config_probe` is the ordinary shape: a composite key, two columns with declared
   * defaults, one nullable column with none. `config_probe_volatile` exists for a single
   * assertion — that a volatile default reads as CHOSEN — and has to be its own table,
   * because a column like that makes every insert attributable and so would hide the
   * exemption the first table is here to demonstrate. `config_probe_nokey` is never
   * written to at all; the mechanism refuses to attach to it.
   */
  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");

    await client.query("DROP TABLE IF EXISTS crm.config_probe");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_volatile");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_txclock");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_nokey");
    await client.query(`
      CREATE TABLE crm.config_probe (
        tenant_id  uuid NOT NULL,
        knob       text NOT NULL,
        grace_days integer NOT NULL DEFAULT 30,
        enabled    boolean NOT NULL DEFAULT false,
        label      text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, knob)
      )`);
    await client.query(`
      CREATE TABLE crm.config_probe_volatile (
        tenant_id uuid NOT NULL,
        knob      text NOT NULL,
        token     uuid NOT NULL DEFAULT gen_random_uuid(),
        PRIMARY KEY (tenant_id, knob)
      )`);
    await client.query(`
      CREATE TABLE crm.config_probe_txclock (
        tenant_id uuid NOT NULL,
        knob      text NOT NULL,
        stamp     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, knob)
      )`);
    await client.query(`
      CREATE TABLE crm.config_probe_nokey (tenant_id uuid NOT NULL, value integer)`);
    await client.query("SELECT crm.apply_tenant_isolation('crm.config_probe_nokey')");
    await client.query("SELECT crm.apply_tenant_isolation('crm.config_probe')");
    await client.query("SELECT crm.apply_tenant_isolation('crm.config_probe_volatile')");
    await client.query("SELECT crm.apply_tenant_isolation('crm.config_probe_txclock')");
    await client.query("SELECT crm.require_config_attribution('crm.config_probe')");
    await client.query("SELECT crm.require_config_attribution('crm.config_probe_volatile')");
    await client.query("SELECT crm.require_config_attribution('crm.config_probe_txclock')");

    /**
     * The scratch tables obey the house rules while they exist.
     *
     * Two suites derive their claim from the live catalog rather than from a list: 0051's
     * register asserts that the number of `crm.data_disposition` rows EQUALS the number of
     * `tenant_id`-bearing tables in `crm`, and `schema.contract` asserts that every one of
     * them forces row-level security. A scratch table that skipped either would make those
     * suites fail — correctly — for a table that is not the repository's. `fileParallelism`
     * is false today, so in practice they never run while these exist; relying on that is
     * exactly the "it happens to be set" reasoning this repository has been bitten by, and
     * four extra statements cost nothing.
     */
    for (const table of PROBE_TABLES) {
      await client.query(
        `INSERT INTO crm.data_disposition
           (table_name, disposition, obligation, obligation_note, retained_reference,
            question, decided_by, decided_at)
         VALUES ($1, 'erase', NULL, NULL, NULL, NULL, 'crm:0061-test-scratch', now())
         ON CONFLICT (table_name) DO NOTHING`,
        [table],
      );
    }

    for (const [tenant, subject] of [
      [TENANT, "cfg-log-rep"],
      [OTHER, "cfg-log-other-rep"],
    ] as const) {
      const { rows } = await withTenantContext(client, tenant, (tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO crm.rep_profile (tenant_id, subject, employee_number, display_name)
           VALUES ($1, $2, $2, 'Config Operator')
           ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [tenant, subject],
        ),
      );
      if (tenant === TENANT) rep = rows[0]!.id;
      else otherRep = rows[0]!.id;
    }
  });

  afterAll(async () => {
    await client.query("DELETE FROM crm.data_disposition WHERE table_name = ANY($1::text[])", [
      PROBE_TABLES,
    ]);
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await wipeConfigChanges(tx, tenant);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client.query("DROP TABLE IF EXISTS crm.config_probe");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_volatile");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_txclock");
    await client.query("DROP TABLE IF EXISTS crm.config_probe_nokey");
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await wipeConfigChanges(tx, tenant);
        await tx.query("DELETE FROM crm.config_probe WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.config_probe_volatile WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.config_probe_txclock WHERE tenant_id = $1", [tenant]);
      });
    }
  });

  const insertBare = (tx: PoolClient, knob: string): Promise<unknown> =>
    tx.query("INSERT INTO crm.config_probe (tenant_id, knob) VALUES ($1, $2)", [TENANT, knob]);

  const log = (opts: { table?: string; limit?: number } = {}): Promise<readonly unknown[]> =>
    inTenant((tx) => configChanges(tx, TENANT, opts)) as Promise<readonly unknown[]>;

  describe("what the mechanism knows about a table", () => {
    it("reads the key from the catalog, in key order", async () => {
      const { rows } = await client.query<{ cols: string[] }>(
        "SELECT crm.config_change_key_columns('crm.config_probe') AS cols",
      );
      // In KEY order, not alphabetical — `knob` sorts before `tenant_id`.
      expect(rows[0]!.cols).toEqual(["tenant_id", "knob"]);
    });

    it("names exactly the two columns whose movement is not a change", async () => {
      const { rows } = await client.query<{ cols: string[] }>(
        "SELECT crm.config_change_ignored_columns() AS cols",
      );
      expect(rows[0]!.cols).toEqual(["created_at", "updated_at"]);
    });

    /**
     * The refusal fires on ATTACHMENT, not on somebody's first write months later. A row with
     * no identity has no history worth keeping, and a `row_key` built from no columns would be
     * a record pointing at nothing.
     */
    it("refuses to attach to a table with no primary key", async () => {
      await expect(
        client.query("SELECT crm.require_config_attribution('crm.config_probe_nokey')"),
      ).rejects.toThrow(/has no primary key/);
      // And attached nothing: the table is still unwatched.
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger
          WHERE tgrelid = 'crm.config_probe_nokey'::regclass AND NOT tgisinternal`,
      );
      expect(rows[0]!.n).toBe("0");
    });

    it("is idempotent, so a table re-attached is still recorded once per write", async () => {
      await client.query("SELECT crm.require_config_attribution('crm.config_probe')");
      await client.query("SELECT crm.require_config_attribution('crm.config_probe')");
      await signed((tx) =>
        tx.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'a',7)", [
          TENANT,
        ]),
      );
      expect((await log()).length).toBe(1);
    });
  });

  describe("which values somebody chose", () => {
    const chosen = async (row: Record<string, unknown>): Promise<string[]> => {
      const { rows } = await client.query<{ cols: string[] }>(
        "SELECT crm.config_change_chosen_columns('crm.config_probe', $1::jsonb) AS cols",
        [JSON.stringify(row)],
      );
      return rows[0]!.cols;
    };

    it("finds nothing chosen in a row holding every declared default", async () => {
      expect(await chosen({ tenant_id: TENANT, knob: "a", grace_days: 30, enabled: false, label: null })).toEqual(
        [],
      );
    });

    /**
     * Against the DEFAULT READ FROM THE CATALOG, not a literal restated in the trigger. 0059
     * hardcoded `(30, false)` and needed a test to catch the day those numbers moved; this
     * reads `pg_attrdef`, so moving the default moves the exemption with it.
     */
    it("finds the column that differs from its declared default", async () => {
      expect(await chosen({ tenant_id: TENANT, knob: "a", grace_days: 7, enabled: false, label: null })).toEqual(
        ["grace_days"],
      );
      expect(await chosen({ tenant_id: TENANT, knob: "a", grace_days: 30, enabled: true, label: null })).toEqual(
        ["enabled"],
      );
    });

    it("counts a column with no default as chosen only while it holds a value", async () => {
      expect(
        await chosen({ tenant_id: TENANT, knob: "a", grace_days: 30, enabled: false, label: "set" }),
      ).toEqual(["label"]);
      expect(
        await chosen({ tenant_id: TENANT, knob: "a", grace_days: 30, enabled: false, label: null }),
      ).toEqual([]);
    });

    it("never counts the key or the timestamps, whatever they hold", async () => {
      expect(
        await chosen({
          tenant_id: OTHER,
          knob: "something-else",
          grace_days: 30,
          enabled: false,
          label: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }),
      ).toEqual([]);
    });
  });

  describe("an insert", () => {
    /**
     * The case that made the declared-default rule necessary. `policyRow` provisions a
     * tenant's policy lazily on every read, from the scheduler, with no human anywhere near
     * it — so a row holding nothing but what a migration declared has to be writable by
     * nobody in particular, or the first background read of a new tenant fails.
     */
    it("at the declared defaults is exempt, and not recorded", async () => {
      await inTenant((tx) => insertBare(tx, "bare"));
      expect(await log()).toEqual([]);
    });

    it("that chooses a value is refused when nobody has signed it", async () => {
      await inTenant(async (tx) => {
        await expect(
          tx.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'a',7)", [
            TENANT,
          ]),
        ).rejects.toThrow(/config-change-unattributed/);
      });
      // Refused means refused: the transaction carried nothing.
      expect(
        await inTenant((tx) =>
          tx.query<{ n: string }>("SELECT count(*)::text AS n FROM crm.config_probe WHERE tenant_id = $1", [
            TENANT,
          ]),
        ).then((r) => r.rows[0]!.n),
      ).toBe("0");
    });

    it("is recorded as a creation naming only the columns the creator decided", async () => {
      await signed((tx) =>
        tx.query(
          "INSERT INTO crm.config_probe (tenant_id, knob, grace_days, label) VALUES ($1,'a',7,'first')",
          [TENANT],
        ),
      );
      const entries = await inTenant((tx) => configChanges(tx, TENANT));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.action).toBe("created");
      expect(entry.table_name).toBe("config_probe");
      expect(entry.changed_by).toBe(rep);
      expect(entry.changed_by_name).toBe("Config Operator");
      expect(entry.reason).toBe(REASON);
      expect(entry.before).toBeNull();
      expect(entry.changed_columns).toEqual(["grace_days", "label"]);
      // The key as the catalog spells it, both columns, so the record points at a row.
      expect(entry.row_key).toEqual({ tenant_id: TENANT, knob: "a" });
      expect(entry.after).toMatchObject({ grace_days: 7, label: "first", enabled: false });
    });

    /**
     * A default that cannot be re-derived reads as CHOSEN, and so demands an author.
     *
     * `gen_random_uuid()` is the case the migration's header names: the exemption compares the
     * stored value against the declared default evaluated now, and for this one those never
     * agree. That is the SAFE direction and the reason the rule is not a correctness hazard —
     * the failure mode is a refusal asking who, never a silent exemption.
     */
    it("whose default cannot be re-derived is never exempt — the rule fails closed", async () => {
      await inTenant(async (tx) => {
        await expect(
          tx.query("INSERT INTO crm.config_probe_volatile (tenant_id, knob) VALUES ($1,'v')", [
            TENANT,
          ]),
        ).rejects.toThrow(/config-change-unattributed/);
      });
      await signed((tx) =>
        tx.query("INSERT INTO crm.config_probe_volatile (tenant_id, knob) VALUES ($1,'v')", [TENANT]),
      );
      const entries = await inTenant((tx) =>
        configChanges(tx, TENANT, { table: "config_probe_volatile" }),
      );
      expect(entries[0]!.changed_columns).toEqual(["token"]);
    });

    /**
     * And a `now()` default IS exempt, which looks like the opposite answer and is the same
     * rule. `now()` is the TRANSACTION clock, so the default re-evaluated inside the inserting
     * transaction returns exactly the value the column holds: the row really does hold what the
     * schema would have put there, which is what the exemption asks. The test is here because
     * the distinction is invisible from the trigger's text — this was written expecting a
     * refusal, and the database was right.
     *
     * It also marks the boundary: a `clock_timestamp()` default would NOT be exempt, for the
     * same reason `crm.config_change.changed_at` uses it.
     */
    it("with a transaction-clock default is exempt, because the default re-derives", async () => {
      await inTenant((tx) =>
        tx.query("INSERT INTO crm.config_probe_txclock (tenant_id, knob) VALUES ($1,'t')", [TENANT]),
      );
      expect(await log({ table: "config_probe_txclock" })).toEqual([]);
    });
  });

  describe("an update", () => {
    const seed = (): Promise<unknown> => inTenant((tx) => insertBare(tx, "k"));

    it("is refused when nobody has signed it", async () => {
      await seed();
      await inTenant(async (tx) => {
        await expect(
          tx.query("UPDATE crm.config_probe SET grace_days = 7 WHERE tenant_id = $1", [TENANT]),
        ).rejects.toThrow(/config-change-unattributed/);
      });
    });

    it("records what the DATABASE held before, not what the writer claimed", async () => {
      await seed();
      await signed((tx) =>
        tx.query("UPDATE crm.config_probe SET grace_days = 7 WHERE tenant_id = $1", [TENANT]),
      );
      const entries = await inTenant((tx) => configChanges(tx, TENANT));
      expect(entries[0]!.action).toBe("amended");
      expect(entries[0]!.changed_columns).toEqual(["grace_days"]);
      expect(entries[0]!.before).toMatchObject({ grace_days: 30 });
      expect(entries[0]!.after).toMatchObject({ grace_days: 7 });
    });

    /**
     * Neither recorded nor refused, which is where this deliberately parts from 0059 and 0060.
     * Those refuse a no-op because each of their routes is an explicit "set this knob". This
     * mechanism also serves routes with ENSURE semantics — `PUT /v1/admin/expense-accounts/:category`
     * is an upsert — and refusing "make sure this maps to 6200" because it already does would
     * make an idempotent route non-idempotent. The universal half is kept: an empty change is
     * never recorded, because the one log a reader relies on to be short must not fill with
     * rows that say nothing.
     */
    it("that moves nothing attributable is neither recorded nor refused", async () => {
      await seed();
      await inTenant((tx) =>
        tx.query("UPDATE crm.config_probe SET grace_days = 30, updated_at = now() WHERE tenant_id = $1", [
          TENANT,
        ]),
      );
      expect(await log()).toEqual([]);
    });

    it("names every column that moved, in one record", async () => {
      await seed();
      await signed((tx) =>
        tx.query(
          "UPDATE crm.config_probe SET grace_days = 7, enabled = true, label = 'why' WHERE tenant_id = $1",
          [TENANT],
        ),
      );
      const entries = await inTenant((tx) => configChanges(tx, TENANT));
      expect(entries.length).toBe(1);
      expect(entries[0]!.changed_columns).toEqual(["enabled", "grace_days", "label"]);
    });

    /**
     * One author, one sentence, however many rows — the scoped-not-one-shot decision. A route
     * that legitimately writes twice (`PUT /v1/admin/notifications/probe-limits` sets a
     * cooldown and a budget through two store functions) must not fail on its second write.
     */
    it("twice in one block is two records under the same signature", async () => {
      await inTenant(async (tx) => {
        await insertBare(tx, "one");
        await insertBare(tx, "two");
      });
      await signed(async (tx) => {
        await tx.query("UPDATE crm.config_probe SET grace_days = 7 WHERE tenant_id = $1 AND knob = 'one'", [
          TENANT,
        ]);
        await tx.query("UPDATE crm.config_probe SET grace_days = 9 WHERE tenant_id = $1 AND knob = 'two'", [
          TENANT,
        ]);
      });
      const entries = await inTenant((tx) => configChanges(tx, TENANT));
      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.reason === REASON && e.changed_by === rep)).toBe(true);
      // Newest first, and not a tie: `changed_at` is `clock_timestamp()` rather than `now()`,
      // so two changes written inside ONE transaction still order. With `now()` both rows
      // carry the transaction clock and "newest first" picks between them arbitrarily.
      expect(entries.map((e) => (e.row_key as { knob: string }).knob)).toEqual(["two", "one"]);
    });
  });

  describe("the block that carries the signature", () => {
    it("refuses an empty reason without touching the database", async () => {
      await inTenant(async (tx) => {
        await expect(
          withAttribution(tx, { repProfileId: rep, reason: "   " }, async () => {
            throw new Error("the block must not run");
          }),
        ).rejects.toBeInstanceOf(UnattributedChangeError);
      });
    });

    /**
     * RESTORES, which with no enclosing block is the same as leaving nothing behind.
     *
     * 0062 changed the mechanism from clearing to restoring, because `withFourEyes` nests one
     * attribution block inside another and clearing would leave the outer block's writes
     * unattributed. This test is unchanged by that and says why: with nothing set outside, the
     * value restored is the empty string, so the guard is live again afterwards either way.
     * The nesting case is the test below it.
     */
    it("leaves nothing set behind it, so the next write in the transaction is unsigned", async () => {
      await inTenant(async (tx) => {
        await withAttribution(tx, { repProfileId: rep, reason: REASON }, (c) => insertBare(c, "inside"));
        const { rows } = await tx.query<{ actor: string; why: string }>(
          `SELECT current_setting($1, true) AS actor, current_setting($2, true) AS why`,
          [ACTOR_SETTING, REASON_SETTING],
        );
        expect(rows[0]!.actor).toBe("");
        expect(rows[0]!.why).toBe("");
        // And the guard is live again, which is the point of asserting the settings at all.
        await expect(
          tx.query("UPDATE crm.config_probe SET grace_days = 7 WHERE tenant_id = $1", [TENANT]),
        ).rejects.toThrow(/config-change-unattributed/);
      });
    });

    /**
     * And a nested block puts the outer one back, which is the case 0061 argued could not
     * arise — "the only thing a restore would buy is nesting, which no caller does".
     *
     * `withFourEyes` is that caller: a suite whose fixtures are already attributed needs one
     * change inside them signed by two people, so it opens a block of its own. Under the
     * clearing behaviour the write after it was refused as unattributed, in a test about the
     * expiry sweep, which is the kind of failure that gets diagnosed three files away from
     * its cause.
     */
    it("restores the enclosing block's author, so a write after a nested one is still signed", async () => {
      await inTenant(async (tx) => {
        await withAttribution(tx, { repProfileId: rep, reason: REASON }, async (outer) => {
          await withAttribution(
            outer,
            { repProfileId: rep, reason: "an inner block with its own sentence" },
            (inner) => insertBare(inner, "nested-inner"),
          );
          const { rows } = await outer.query<{ actor: string; why: string }>(
            `SELECT current_setting($1, true) AS actor, current_setting($2, true) AS why`,
            [ACTOR_SETTING, REASON_SETTING],
          );
          expect(rows[0]!.actor).toBe(rep);
          expect(rows[0]!.why).toBe(REASON);
          // And a real write proves it rather than the settings alone.
          await outer.query(
            "INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'after-nested',7)",
            [TENANT],
          );
        });
      });
      const entries = await inTenant((tx) => configChanges(tx, TENANT));
      expect(entries.length).toBe(1);
      expect(entries[0]!.reason).toBe(REASON);
      expect((entries[0]!.row_key as { knob: string }).knob).toBe("after-nested");
    });

    it("translates the trigger's refusal into a named error", async () => {
      await inTenant(async (tx) => {
        const err = await withAttribution(tx, { repProfileId: rep, reason: REASON }, async (c) => {
          // Signed, then the setting is cleared underneath the block — the only way to reach
          // the refusal from INSIDE one, and what proves the translation is wired up.
          await c.query("SELECT set_config($1, '', true)", [ACTOR_SETTING]);
          return c.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'x',7)", [
            TENANT,
          ]);
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnattributedChangeError);
      });
    });
  });

  describe("reading it back", () => {
    it("shows a tenant only its own changes", async () => {
      await signed((tx) =>
        tx.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'mine',7)", [
          TENANT,
        ]),
      );
      await withTenantContext(client, OTHER, (tx) =>
        withAttribution(tx, { repProfileId: otherRep, reason: "the other tenant's own change" }, (c) =>
          c.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'theirs',9)", [
            OTHER,
          ]),
        ),
      );
      const mine = await inTenant((tx) => configChanges(tx, TENANT));
      expect(mine.length).toBe(1);
      expect((mine[0]!.row_key as { knob: string }).knob).toBe("mine");
      const theirs = await withTenantContext(client, OTHER, (tx) => configChanges(tx, OTHER));
      expect(theirs.length).toBe(1);
      expect((theirs[0]!.row_key as { knob: string }).knob).toBe("theirs");
    });

    it("clamps a limit to the ceiling and to one, rather than honouring either extreme", async () => {
      await inTenant(async (tx) => {
        await insertBare(tx, "a");
        await insertBare(tx, "b");
      });
      await signed(async (tx) => {
        await tx.query("UPDATE crm.config_probe SET grace_days = 7 WHERE tenant_id = $1 AND knob = 'a'", [
          TENANT,
        ]);
        await tx.query("UPDATE crm.config_probe SET grace_days = 9 WHERE tenant_id = $1 AND knob = 'b'", [
          TENANT,
        ]);
      });
      expect((await log({ limit: CONFIG_LOG_LIMIT + 1000 })).length).toBe(2);
      // Clamped UP to one, not down to the default: a `LIMIT 0` read as "everything" is the
      // worse of the two readings, since the caller asking for nothing gets nothing either way
      // and a caller who meant "one" is answered.
      expect((await log({ limit: 0 })).length).toBe(1);
    });

    it("answers nothing for a table that has never been changed", async () => {
      await signed((tx) =>
        tx.query("INSERT INTO crm.config_probe (tenant_id, knob, grace_days) VALUES ($1,'a',7)", [
          TENANT,
        ]),
      );
      expect(await log({ table: "notification_policy" })).toEqual([]);
      expect(await log({ table: "a_table_that_does_not_exist" })).toEqual([]);
      expect((await log({ table: "config_probe" })).length).toBe(1);
    });
  });
});
