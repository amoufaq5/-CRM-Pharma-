import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_NOTIFY_ADDRESS as TENANT,
  TENANT_NOTIFY_ADDRESS_OTHER as OTHER,
  testPool,
  wipeConfigChanges,
  wipeEndpoints,
} from "@crm/db/testing";
import { UnattributedChangeError, withAttribution, withTenantContext } from "@crm/db";

import { createEndpoint, InvalidEndpointError } from "./endpoints.js";
import {
  InvalidNotifyAddressError,
  NOTIFY_ADDRESS_SHAPE,
  RepNotFoundError,
  clearRepNotifyAddress,
  notifyAddressCoverage,
  repNotifyAddress,
  setRepNotifyAddress,
} from "./notify-address.js";
import { raiseNotification } from "./raise.js";
import { deliveryHistory } from "./delivery-history.js";
import { PER_RECIPIENT_MARKER_URL } from "./smtp.js";

/**
 * Migration 0065 — a notification is addressed to a PERSON, and now so is an email.
 *
 * WHAT THIS SUITE IS ABOUT. `crm.notification` carries `recipient_rep_profile_id`;
 * `crm.notification_delivery` carries an endpoint; endpoints are per tenant. So every rep's
 * email went to whichever single `mailto:` the tenant's one email endpoint was frozen to by
 * 0049 — wrong for the case email exists to serve, which is 0064's `urgent` escalation
 * reaching somebody who has not opened the app in a week.
 *
 * NONE OF THIS COULD BE ASSERTED AGAINST A FAKE CONNECTION, and the reasons are the three this
 * repository keeps relearning. The attribution refusal is a trigger's. The address shape is a
 * CHECK whose POSIX character classes are not JavaScript's, so the only way to know the
 * TypeScript copy agrees is to ask the database about the same strings. And the
 * channel/`to_address` pairing is a CHECK against a column a BEFORE trigger fills in, which a
 * recorded-SQL fake would report as written and the database refuses.
 *
 * `testPool()` with `SET ROLE crm_app`: seeding a grant-free roster needs more than the
 * application has, and every read still runs as the application does with row security on.
 */
describe("where a person's notifications go (0065)", () => {
  let pool: Pool;
  let client: PoolClient;

  let ada = "";
  let grace = "";
  let omar = "";
  let outsider = "";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOther = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER, fn);

  /** An attributed block, because 0065 puts this table under 0061. */
  const asAda = <T>(tx: PoolClient, fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withAttribution(tx, { repProfileId: ada, reason: "the address suite is setting this" }, fn);

  const rep = async (
    tenant: string,
    subject: string,
    name: string,
    opts: { readonly hint?: string; readonly status?: string } = {},
  ): Promise<string> => {
    const { rows } = await withTenantContext(client, tenant, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO crm.rep_profile
           (tenant_id, subject, employee_number, display_name, work_email_hint, status)
         VALUES ($1, $2, $2, $3, $4, COALESCE($5, 'active'))
         ON CONFLICT (tenant_id, subject) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               work_email_hint = EXCLUDED.work_email_hint,
               status = EXCLUDED.status
         RETURNING id`,
        [tenant, subject, name, opts.hint ?? null, opts.status ?? null],
      ),
    );
    return rows[0]!.id;
  };

  /** Forces a refusal to BE one: `.catch(e => e)` passes when nothing throws. */
  const refusalOf = async (fn: () => Promise<unknown>): Promise<Error> => {
    try {
      await fn();
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected a refusal, and the call succeeded");
  };

  beforeAll(async () => {
    pool = testPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    // Ada is the author every attributed write here names, and the ERP has an email for her
    // which nothing is allowed to send to until somebody confirms it.
    ada = await rep(TENANT, "addr-ada", "Ada Lovelace", { hint: "ada@erp.example.test" });
    grace = await rep(TENANT, "addr-grace", "Grace Hopper", { hint: "grace@erp.example.test" });
    // No hint at all: the ERP does not know either, which is a different sentence on the
    // to-do list and a case an administrator cannot fix by confirming anything.
    omar = await rep(TENANT, "addr-omar", "Omar Khayyam");
    outsider = await rep(OTHER, "addr-outsider", "Another Tenant's Rep");
  });

  afterAll(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await wipeEndpoints(tx, tenant);
        // Before the profiles and before the addresses: 0061's log names its author ON DELETE
        // RESTRICT, and the address rows CASCADE from the profiles.
        await wipeConfigChanges(tx, tenant);
        await tx.query("DELETE FROM crm.rep_notify_address WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [tenant]);
      });
    }
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  });

  /**
   * No addresses, no endpoints, no log, every time.
   *
   * The coverage report counts the WHOLE tenant, so an accumulated address from a previous
   * test would move the numerator of every assertion below it — the coupling 0062's
   * expense-lifecycle suite was found to have.
   */
  beforeEach(async () => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [tenant]);
        await wipeEndpoints(tx, tenant);
        await wipeConfigChanges(tx, tenant);
        await tx.query("DELETE FROM crm.rep_notify_address WHERE tenant_id = $1", [tenant]);
      });
    }
  });

  describe("setting and withdrawing a destination", () => {
    it("sets, reads back, and withdraws without deleting the row", async () => {
      await inTenant(async (tx) => {
        const set = await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        expect(set.address).toBe("grace@example.test");
        expect(set.display_name).toBe("Grace Hopper");

        const read = await repNotifyAddress(tx, TENANT, grace);
        expect(read?.address).toBe("grace@example.test");

        const cleared = await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, grace));
        expect(cleared).toBe(true);

        // THE ROW IS STILL THERE, with a null address. 0061's trigger fires AFTER INSERT OR
        // UPDATE, so a DELETE would be the one change to this table nobody signed and nothing
        // logged — the withdrawal is an amendment precisely so it is recorded.
        const after = await repNotifyAddress(tx, TENANT, grace);
        expect(after).not.toBeNull();
        expect(after?.address).toBeNull();
      });
    });

    it("reports no change when there was nothing to withdraw", async () => {
      await inTenant(async (tx) => {
        // No row at all.
        expect(await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, omar))).toBe(false);
        // And a row already withdrawn, which is the same answer: the route reports the change
        // it made, and it made none.
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, omar, "omar@example.test"));
        expect(await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, omar))).toBe(true);
        expect(await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, omar))).toBe(false);
      });
    });

    it("re-setting the same address changes nothing and logs nothing", async () => {
      await inTenant(async (tx) => {
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        const first = await repNotifyAddress(tx, TENANT, grace);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        const second = await repNotifyAddress(tx, TENANT, grace);
        // `updated_at` untouched, which is the visible half: a listing must not report a
        // change that was not one. The invisible half is the log, counted below.
        expect(second?.updated_at).toEqual(first?.updated_at);

        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM crm.config_change
            WHERE tenant_id = $1 AND table_name = 'rep_notify_address'`,
          [TENANT],
        );
        expect(rows[0]!.n).toBe("1");
      });
    });

    it("refuses a rep who is not in this tenant, with the same answer as one who does not exist", async () => {
      await inTenant(async (tx) => {
        // Row-level security makes these two indistinguishable, correctly: naming the
        // difference would be a cross-tenant existence oracle.
        const foreign = await refusalOf(() =>
          asAda(tx, (t) => setRepNotifyAddress(t, TENANT, outsider, "nope@example.test")),
        );
        const absent = await refusalOf(() =>
          asAda(tx, (t) =>
            setRepNotifyAddress(t, TENANT, "00000000-0000-4000-8000-000000000000", "nope@example.test"),
          ),
        );
        expect(foreign).toBeInstanceOf(RepNotFoundError);
        expect(absent).toBeInstanceOf(RepNotFoundError);
      });
    });
  });

  describe("every write is attributed (0061)", () => {
    it("refuses a set with nobody named", async () => {
      await inTenant(async (tx) => {
        const err = await refusalOf(() => setRepNotifyAddress(tx, TENANT, grace, "grace@example.test"));
        // The store does not know attribution exists; the database does. This is the whole
        // reason the destination is its own table and not a column on `crm.rep_profile`,
        // which the ERP reconciler writes from the scheduler with no human anywhere near it.
        //
        // The token rather than the class, for the reason given on the withdrawal below.
        expect(err.message).toContain("config-change-unattributed:");
        expect(err.message).toContain("rep_notify_address");
      });
    });

    it("refuses a withdrawal with nobody named", async () => {
      await inTenant(async (tx) => {
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        const err = await refusalOf(() => clearRepNotifyAddress(tx, TENANT, grace));
        // The one that mattered most. "Stop telling this person" is as consequential as
        // "start", so a withdrawal nobody signed is the hole 0060 and 0061 exist to close.
        //
        // ASSERTED ON THE TOKEN, not on the class, and the difference says something about
        // where translation lives: `withAttribution` is what turns 0061's refusal into
        // `UnattributedChangeError`, and this call deliberately has no block open, so the raw
        // refusal arrives. The store does not translate — unlike `@crm/db`'s four-eyes store,
        // which does because its refusals are a 409 a caller acts on, where this one is a 500
        // either way. 0049's reason for an unlovely token is why asserting on it is safe: a
        // sentence can be reworded by whoever improves it, and the token cannot be by accident.
        expect(err.message).toContain("config-change-unattributed:");
        expect(err.message).toContain("rep_notify_address");
      });
    });

    it("logs the creation and the withdrawal, with the before-image on the second", async () => {
      await inTenant(async (tx) => {
        await withAttribution(
          tx,
          { repProfileId: ada, reason: "confirmed the mailbox with her in person" },
          (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"),
        );
        await withAttribution(
          tx,
          { repProfileId: ada, reason: "she asked to be taken off email entirely" },
          (t) => clearRepNotifyAddress(t, TENANT, grace),
        );

        const { rows } = await tx.query<{
          action: string;
          reason: string;
          changed_columns: readonly string[];
          before: Record<string, unknown> | null;
          after: Record<string, unknown>;
        }>(
          `SELECT action, reason, changed_columns, before, after
             FROM crm.config_change
            WHERE tenant_id = $1 AND table_name = 'rep_notify_address'
            -- changed_at is clock_timestamp() and not now(), exactly so two changes written
            -- in one transaction do not tie -- which is what this test needs, since both of
            -- them are. (No backticks: this is inside a template literal.)
            ORDER BY changed_at, id`,
          [TENANT],
        );
        expect(rows).toHaveLength(2);

        expect(rows[0]!.action).toBe("created");
        expect(rows[0]!.changed_columns).toEqual(["address"]);
        expect(rows[0]!.before).toBeNull();
        expect(rows[0]!.after["address"]).toBe("grace@example.test");
        expect(rows[0]!.reason).toContain("in person");

        expect(rows[1]!.action).toBe("amended");
        expect(rows[1]!.changed_columns).toEqual(["address"]);
        // `updated_at` moved too and is deliberately absent from `changed_columns`: 0061
        // ignores both timestamps, or every amendment would report a column nobody chose.
        expect(rows[1]!.before?.["address"]).toBe("grace@example.test");
        expect(rows[1]!.after["address"]).toBeNull();
        expect(rows[1]!.reason).toContain("off email");
      });
    });

    it("does not take two people", async () => {
      // Asserted because the opposite would be easy to arrive at by accident and is a
      // defensible design: setting where a person's signals go is a route out of the tenant
      // for records carrying their name. It is deliberately single-signature — an
      // administrator working through twelve unaddressed reps who needed a second approver
      // for each would do none of them, and the change is trivially reversible (0062's rule
      // is for the irreversible ones: stock destroyed, postings made).
      await inTenant(async (tx) => {
        const row = await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        expect(row.address).toBe("grace@example.test");
      });
    });
  });

  describe("what counts as an address", () => {
    /**
     * The TypeScript copy and the CHECK, compared BY BEHAVIOUR rather than by text.
     *
     * `ENDPOINT_CHANNELS`' test can compare strings because a channel list is a list of
     * strings. This one cannot: the column's regex uses POSIX classes (`[[:space:]]`) that
     * JavaScript does not have, so the only honest comparison is to put the same candidates
     * through both and require the same verdict. The database is the ground truth and each
     * attempt runs in a savepoint, because a failed statement aborts the transaction.
     */
    it("agrees with the CHECK about the same strings", async () => {
      const candidates = [
        "grace@example.test",
        "grace.hopper+field@example.co.uk",
        "GRACE@EXAMPLE.TEST",
        // No dot in the domain: the one the first version of this got wrong, by calling
        // `isMailbox` "deliberately stricter" and checking only that. `isMailbox` admits it
        // and the column does not, so an address like this reached the CHECK as a 500.
        "rep@localhost",
        "no-at-sign.example.test",
        "two@@example.test",
        "a@b.c",
        "has a space@example.test",
        "one@example.test,two@example.test",
        "trailing@example.test;",
        "@example.test",
        "grace@",
      ];
      await inTenant(async (tx) => {
        for (const candidate of candidates) {
          await tx.query("SAVEPOINT candidate");
          let accepted: boolean;
          try {
            await tx.query(
              // Written straight at the table with the trigger left ON and no attribution
              // block open — which would refuse it. So the INSERT is wrapped to tell the two
              // refusals apart: a CHECK violation is 23514 and the trigger's is raised as
              // one too, so the CONSTRAINT NAME is what distinguishes them.
              `INSERT INTO crm.rep_notify_address (tenant_id, rep_profile_id, address)
               VALUES ($1, $2, $3)`,
              [TENANT, grace, candidate],
            );
            accepted = true;
          } catch (err) {
            const e = err as { constraint?: string; message?: string };
            if (e.constraint === "rep_notify_address_address_check") {
              accepted = false;
            } else if ((e.message ?? "").includes("config-change-unattributed:")) {
              // The CHECK is evaluated before the AFTER trigger, so reaching the trigger
              // means the shape was accepted.
              accepted = true;
            } else {
              throw err;
            }
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT candidate");
          }
          expect(
            NOTIFY_ADDRESS_SHAPE.test(candidate),
            `NOTIFY_ADDRESS_SHAPE and the CHECK disagree about ${JSON.stringify(candidate)}`,
          ).toBe(accepted);
        }
      });
    });

    it("refuses an address the relay could not be given, before the CHECK sees it", async () => {
      await inTenant(async (tx) => {
        for (const bad of [
          // Passes the column's regex (no space, no comma, a dotted domain) and `isMailbox`
          // refuses it: angle brackets and a display name are not what goes in a RCPT TO.
          "<grace@example.test>",
          "Grace:grace@example.test",
          // Over RFC 5321's limit, which the relay would refuse eight minutes later.
          `${"g".repeat(250)}@example.test`,
          // And the dotless domain, from the other direction: the store refuses it rather
          // than letting the CHECK answer with a 500.
          "rep@localhost",
        ]) {
          const err = await refusalOf(() => asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, bad)));
          expect(err, `${JSON.stringify(bad)} was not refused by the store`).toBeInstanceOf(
            InvalidNotifyAddressError,
          );
        }
      });
    });
  });

  describe("row-level security", () => {
    it("does not show one tenant another's addresses", async () => {
      await inOther(async (tx) => {
        await withAttribution(
          tx,
          { repProfileId: outsider, reason: "the other tenant setting their own address" },
          (t) => setRepNotifyAddress(t, OTHER, outsider, "outsider@example.test"),
        );
      });
      await inTenant(async (tx) => {
        expect(await repNotifyAddress(tx, TENANT, outsider)).toBeNull();
        const coverage = await notifyAddressCoverage(tx, TENANT);
        expect(coverage.missing.map((m) => m.rep_profile_id)).not.toContain(outsider);
      });
    });
  });

  describe("the to-do list", () => {
    const endpoint = (tx: PoolClient, channel: "email" | "email_recipient", url: string): Promise<unknown> =>
      withAttribution(
        tx,
        { repProfileId: ada, reason: "the address suite needs an endpoint on this channel" },
        (t) =>
          createEndpoint(t, TENANT, {
            channel,
            url,
            secretEnv: "CRM_SMTP_PASSWORD",
            minSeverity: "info",
            createdBy: ada,
            reason: "the address suite needs an endpoint on this channel",
          }),
      );

    it("lists the unaddressed with the ERP's guess beside them, and says it does not matter yet", async () => {
      await inTenant(async (tx) => {
        const coverage = await notifyAddressCoverage(tx, TENANT);
        expect(coverage.endpoints).toBe(0);
        expect(coverage.reps).toBe(3);
        expect(coverage.addressed).toBe(0);
        expect(coverage.missing).toHaveLength(3);
        // The hint, under a name that cannot be mistaken for a destination. 0003 declares
        // `work_email_hint` a reconciliation hint that "must never be the join key", and this
        // is the only consumer it has ever had — as a suggestion an administrator confirms.
        const forGrace = coverage.missing.find((m) => m.rep_profile_id === grace);
        expect(forGrace?.suggestion).toBe("grace@erp.example.test");
        expect(forGrace?.address).toBeNull();
        // And the case an administrator cannot fix by confirming anything.
        expect(coverage.missing.find((m) => m.rep_profile_id === omar)?.suggestion).toBeNull();
        // NO ENABLED ENDPOINT, so nothing is unreachable yet — said out loud, because a list
        // of three that reads as urgent when nothing uses it is how a to-do list gets ignored.
        expect(coverage.summary).toContain("nothing is unreachable yet");
      });
    });

    it("changes its tone once an endpoint would have mailed them", async () => {
      await inTenant(async (tx) => {
        await endpoint(tx, "email_recipient", PER_RECIPIENT_MARKER_URL);
        const coverage = await notifyAddressCoverage(tx, TENANT);
        expect(coverage.endpoints).toBe(1);
        expect(coverage.summary).toContain("their signals go nowhere");
      });
    });

    it("counts a fixed email endpoint as no reason to address anybody", async () => {
      await inTenant(async (tx) => {
        // The `email` channel is the OTHER policy and it is not deprecated: a tenant wanting
        // urgent signals in a shared ops mailbox is asking for something reasonable. It
        // addresses nobody personally, so it must not make the per-person list look urgent.
        await endpoint(tx, "email", "mailto:ops@example.test");
        const coverage = await notifyAddressCoverage(tx, TENANT);
        expect(coverage.endpoints).toBe(0);
        expect(coverage.summary).toContain("nothing is unreachable yet");
      });
    });

    it("leaves a departed rep off the list, and finds them when asked", async () => {
      const departed = await rep(TENANT, "addr-departed", "A Departed Rep", { status: "departed" });
      try {
        await inTenant(async (tx) => {
          const active = await notifyAddressCoverage(tx, TENANT);
          expect(active.missing.map((m) => m.rep_profile_id)).not.toContain(departed);
          const all = await notifyAddressCoverage(tx, TENANT, { includeInactive: true });
          expect(all.missing.map((m) => m.rep_profile_id)).toContain(departed);
          expect(all.missing.find((m) => m.rep_profile_id === departed)?.status).toBe("departed");
        });
      } finally {
        await inTenant((tx) => tx.query("DELETE FROM crm.rep_profile WHERE id = $1", [departed]));
      }
    });

    it("counts a withdrawn address as no address", async () => {
      await inTenant(async (tx) => {
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        expect((await notifyAddressCoverage(tx, TENANT)).addressed).toBe(1);
        await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, grace));
        const coverage = await notifyAddressCoverage(tx, TENANT);
        // The row still exists; it is not a destination. "No row" and "withdrawn" are the
        // same answer to the question being asked.
        expect(coverage.addressed).toBe(0);
        expect(coverage.missing.map((m) => m.rep_profile_id)).toContain(grace);
      });
    });
  });

  describe("the third channel", () => {
    it("pins its url to the marker, and says what the channel is for", async () => {
      await inTenant(async (tx) => {
        const err = await refusalOf(() =>
          withAttribution(tx, { repProfileId: ada, reason: "trying to give it a mailbox" }, (t) =>
            createEndpoint(t, TENANT, {
              channel: "email_recipient",
              url: "mailto:ops@example.test",
              secretEnv: "CRM_SMTP_PASSWORD",
              createdBy: ada,
              reason: "trying to give it a mailbox",
            }),
          ),
        );
        expect(err).toBeInstanceOf(InvalidEndpointError);
        // The sentence says what the row is FOR, not what is wrong with what was typed:
        // whoever reached this was trying to give the channel a destination, which is the one
        // thing it exists not to have.
        expect(err.message).toContain("mailto:*");
        expect(err.message).toContain("whoever the notification names");
      });
    });

    it("accepts the marker", async () => {
      await inTenant(async (tx) => {
        const ep = await withAttribution(
          tx,
          { repProfileId: ada, reason: "the per-recipient channel, as it is meant to be" },
          (t) =>
            createEndpoint(t, TENANT, {
              channel: "email_recipient",
              url: PER_RECIPIENT_MARKER_URL,
              secretEnv: "CRM_SMTP_PASSWORD",
              createdBy: ada,
              reason: "the per-recipient channel, as it is meant to be",
            }),
        );
        expect(ep.channel).toBe("email_recipient");
        expect(ep.url).toBe(PER_RECIPIENT_MARKER_URL);
      });
    });
  });

  describe("raising a signal", () => {
    const perRecipientEndpoint = (tx: PoolClient): Promise<{ readonly id: string }> =>
      withAttribution(tx, { repProfileId: ada, reason: "an endpoint for the raise tests" }, (t) =>
        createEndpoint(t, TENANT, {
          channel: "email_recipient",
          url: PER_RECIPIENT_MARKER_URL,
          secretEnv: "CRM_SMTP_PASSWORD",
          minSeverity: "info",
          createdBy: ada,
          reason: "an endpoint for the raise tests",
        }),
      );

    const signal = {
      kind: "config_change_approval_overdue",
      severity: "urgent",
      subject: "A change has been waiting too long",
      body: "Somebody has to decide it.",
    } as const;

    it("addresses the delivery to the recipient's own mailbox", async () => {
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));

        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: grace,
          dedupKey: "addr:grace:overdue",
        });
        expect(raised).toMatchObject({ created: true, deliveries: 1, unaddressable: 0 });

        const { rows } = await tx.query<{ to_address: string | null; endpoint_channel: string }>(
          `SELECT to_address, endpoint_channel FROM crm.notification_delivery
            WHERE tenant_id = $1 AND notification_id = $2`,
          [TENANT, raised.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ to_address: "grace@example.test", endpoint_channel: "email_recipient" });
      });
    });

    it("sends two reps' signals to two different mailboxes through one endpoint", async () => {
      // THE WHOLE POINT, stated as one test. Before 0065 the destination was the endpoint's
      // own frozen url, so these two deliveries would have named the same mailbox.
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, omar, "omar@example.test"));

        for (const [who, key] of [
          [grace, "addr:two:grace"],
          [omar, "addr:two:omar"],
        ] as const) {
          await raiseNotification(tx, TENANT, { ...signal, recipientRepProfileId: who, dedupKey: key });
        }

        const { rows } = await tx.query<{ to_address: string }>(
          `SELECT d.to_address FROM crm.notification_delivery d
            WHERE d.tenant_id = $1 ORDER BY d.to_address`,
          [TENANT],
        );
        expect(rows.map((r) => r.to_address)).toEqual(["grace@example.test", "omar@example.test"]);
      });
    });

    it("counts a recipient with no mailbox instead of enqueueing a delivery that cannot be made", async () => {
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: omar,
          dedupKey: "addr:omar:unaddressable",
        });
        // THE NOTIFICATION IS STILL RAISED: the in-app copy is the row, and a configuration
        // gap in the email channel must not cost somebody their inbox entry.
        expect(raised.created).toBe(true);
        // And no delivery, which was the decision. A `dead` row saying "this rep has no
        // address" is better evidence and worse behaviour: it would be re-created and
        // re-killed on every raise, filling the one table 0046 exists to keep honest.
        expect(raised).toMatchObject({ deliveries: 0, unaddressable: 1 });
        const { rows } = await tx.query(
          `SELECT 1 FROM crm.notification_delivery WHERE tenant_id = $1`,
          [TENANT],
        );
        expect(rows).toHaveLength(0);
      });
    });

    it("counts a withdrawn mailbox the same way", async () => {
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        await asAda(tx, (t) => clearRepNotifyAddress(t, TENANT, grace));
        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: grace,
          dedupKey: "addr:grace:withdrawn",
        });
        expect(raised).toMatchObject({ deliveries: 0, unaddressable: 1 });
      });
    });

    it("does not report unaddressable for an endpoint that did not want the signal", async () => {
      await inTenant(async (tx) => {
        await withAttribution(tx, { repProfileId: ada, reason: "urgent signals only, by email" }, (t) =>
          createEndpoint(t, TENANT, {
            channel: "email_recipient",
            url: PER_RECIPIENT_MARKER_URL,
            secretEnv: "CRM_SMTP_PASSWORD",
            minSeverity: "urgent",
            createdBy: ada,
            reason: "urgent signals only, by email",
          }),
        );
        const raised = await raiseNotification(tx, TENANT, {
          kind: "disposal_obligation_raised",
          severity: "info",
          subject: "Something minor",
          body: "Not urgent.",
          recipientRepProfileId: omar,
          dedupKey: "addr:omar:filtered",
        });
        // The severity filter runs FIRST, deliberately: an endpoint that did not want this
        // signal is not a destination that failed, so a rep with no mailbox must not be
        // reported unreachable by an endpoint that would have skipped them anyway.
        expect(raised).toMatchObject({ deliveries: 0, unaddressable: 0 });
      });
    });

    it("leaves to_address null on the fixed email channel, and the CHECK enforces the pairing", async () => {
      await inTenant(async (tx) => {
        const ep = await withAttribution(
          tx,
          { repProfileId: ada, reason: "the shared ops mailbox, which is still a policy" },
          (t) =>
            createEndpoint(t, TENANT, {
              channel: "email",
              url: "mailto:ops@example.test",
              secretEnv: "CRM_SMTP_PASSWORD",
              minSeverity: "info",
              createdBy: ada,
              reason: "the shared ops mailbox, which is still a policy",
            }),
        );
        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: grace,
          dedupKey: "addr:grace:ops",
        });
        expect(raised).toMatchObject({ deliveries: 1, unaddressable: 0 });
        const { rows } = await tx.query<{ to_address: string | null }>(
          `SELECT to_address FROM crm.notification_delivery WHERE tenant_id = $1`,
          [TENANT],
        );
        expect(rows[0]!.to_address).toBeNull();

        // And the reverse, which is the half a fake connection cannot check: a column that is
        // sometimes meaningful is a column every reader has to think about, so an address on a
        // channel with no use for one is refused rather than stored. `endpoint_channel` is
        // filled by 0048's BEFORE trigger, so the CHECK is evaluated against it.
        await tx.query("SAVEPOINT pairing");
        const err = await refusalOf(() =>
          tx.query(
            `INSERT INTO crm.notification_delivery (tenant_id, notification_id, endpoint_id, to_address)
             VALUES ($1, $2, $3, 'ops@example.test')`,
            [TENANT, raised.id, (ep as { id: string }).id],
          ),
        );
        await tx.query("ROLLBACK TO SAVEPOINT pairing");
        expect((err as { constraint?: string }).constraint).toBe(
          "notification_delivery_to_address_pairs_with_channel",
        );
      });
    });

    it("says where the signal went after the notification is gone", async () => {
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "grace@example.test"));
        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: grace,
          dedupKey: "addr:grace:history",
        });
        // 0046's whole point, and 0049's: the delivery outlives its parents and must still say
        // where it went. On this channel `endpoint_url` is the marker, so without `to_address`
        // in the history functions the column's entire justification is unreadable.
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1 AND id = $2", [
          TENANT,
          raised.id,
        ]);
        const history = await deliveryHistory(tx, raised.id);
        expect(history).toHaveLength(1);
        expect(history[0]!.notification_present).toBe(false);
        expect(history[0]!.endpoint_url).toBe(PER_RECIPIENT_MARKER_URL);
        expect(history[0]!.to_address).toBe("grace@example.test");
      });
    });

    it("does not re-resolve the address when the delivery is claimed", async () => {
      await inTenant(async (tx) => {
        await perRecipientEndpoint(tx);
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "old@example.test"));
        const raised = await raiseNotification(tx, TENANT, {
          ...signal,
          recipientRepProfileId: grace,
          dedupKey: "addr:grace:frozen",
        });
        // The address moves AFTER the push was enqueued. 0049's rule: a delivery record says
        // where the signal went, so re-resolving at send time would make the record say one
        // thing and the envelope another.
        await asAda(tx, (t) => setRepNotifyAddress(t, TENANT, grace, "new@example.test"));
        const history = await deliveryHistory(tx, raised.id);
        expect(history[0]!.to_address).toBe("old@example.test");
      });
    });
  });
});
