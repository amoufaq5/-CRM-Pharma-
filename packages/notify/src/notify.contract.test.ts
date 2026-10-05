import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool, TENANT_NOTIFY as TENANT } from "@crm/db/testing";

import { NotificationDispatcher, MAX_ATTEMPTS, nextDelayMs } from "./dispatch.js";
import { inbox, markAllRead, markRead, unreadCount } from "./inbox.js";
import { raiseForSupervisors, raiseNotification } from "./raise.js";
import { WebhookSender, verifyWebhook, type FetchLike } from "./sender.js";

/**
 * Notifications against a real Postgres, and — for the webhook channel — against a real
 * HTTP server on loopback.
 *
 * The delivery test stands up `node:http` and checks the signature on the bytes that
 * actually arrived. That is the difference between "the sender compiles" and "a receiver
 * can verify what we send", and it is the half the ERP's notification stack never got to.
 */
/**
 * `appPool()`: this pool is handed to production code that opens its own connections,
 * which inherit its role. Under the admin pool they would run as a superuser, and RLS —
 * including the per-tenant assertions below — would not apply at all.
 */
describe("notifications", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "d0100000-0000-4000-8000-000000000001";
  const MANAGER = "d0200000-0000-4000-8000-000000000002";
  const PEER = "d0300000-0000-4000-8000-000000000003";
  const REGION = "d0400000-0000-4000-8000-000000000004";
  const TERRITORY = "d0500000-0000-4000-8000-000000000005";
  const ELSEWHERE = "d0600000-0000-4000-8000-000000000006";
  const SECRET = "hook-secret-value";

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await client.query("SET ROLE crm_app");
    await inTenant(async (tx) => {
      for (const [id, n] of [
        [REP, "ntf-rep"],
        [MANAGER, "ntf-mgr"],
        [PEER, "ntf-peer"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$3,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, n],
        );
      }
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES
           ($1,$4,'NTF-REGION','Region'), ($2,$4,'NTF-T','Territory'), ($3,$4,'NTF-ELSE','Elsewhere')
         ON CONFLICT DO NOTHING`,
        [REGION, TERRITORY, ELSEWHERE, TENANT],
      );
      await tx.query("UPDATE crm.territory SET parent_id = $1 WHERE id = $2", [REGION, TERRITORY]);
      await tx.query(
        `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
         VALUES ($1,$2,$3,'primary','2026-01-01'), ($1,$4,$5,'manager','2026-01-01'),
                ($1,$6,$7,'manager','2026-01-01')
         ON CONFLICT DO NOTHING`,
        [TENANT, TERRITORY, REP, REGION, MANAGER, ELSEWHERE, PEER],
      );
    });
  });

  afterAll(async () => {
    await reset();
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    await client?.query("RESET ROLE");
    client?.release();
    await pool?.end();
  });

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.notification_endpoint WHERE tenant_id = $1", [TENANT]);
    });
  };

  beforeEach(reset);

  const raise = (
    tx: PoolClient,
    overrides: Partial<Parameters<typeof raiseNotification>[2]> = {},
  ): ReturnType<typeof raiseNotification> =>
    raiseNotification(tx, TENANT, {
      recipientRepProfileId: REP,
      kind: "disposal_obligation_raised",
      severity: "warning",
      subject: "Expired stock to dispose of",
      body: "Lot LOT-A expired on 2026-03-31.",
      dedupKey: "disposal:lot-a:raised",
      ...overrides,
    });

  const addEndpoint = async (
    tx: PoolClient,
    opts: { url: string; minSeverity?: string; kinds?: readonly string[] | null; enabled?: boolean },
  ): Promise<string> => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO crm.notification_endpoint
         (tenant_id, channel, url, secret_env, min_severity, kinds, enabled)
       VALUES ($1,'webhook',$2,'CRM_TEST_HOOK_SECRET',$3,$4,$5) RETURNING id`,
      [TENANT, opts.url, opts.minSeverity ?? "warning", opts.kinds ?? null, opts.enabled ?? true],
    );
    return rows[0]!.id;
  };

  describe("raising", () => {
    it("writes the notification and nothing else when no endpoint wants it", async () => {
      await inTenant(async (tx) => {
        const result = await raise(tx);
        expect(result.created).toBe(true);
        expect(result.deliveries).toBe(0);
        const items = await inbox(tx, REP);
        expect(items).toHaveLength(1);
        expect(items[0]!.read_at).toBeNull();
      });
    });

    /**
     * The whole reason the nightly sweep can raise unconditionally: a repeat is a no-op.
     * Without it a rep would be told about the same expired carton every night until they
     * stopped reading any of it.
     */
    it("is idempotent on the dedup key, and raises no second delivery", async () => {
      await inTenant(async (tx) => {
        await addEndpoint(tx, { url: "https://hooks.example.com/x" });
        const first = await raise(tx);
        const second = await raise(tx, { body: "a later wording" });
        expect(first.created).toBe(true);
        expect(first.deliveries).toBe(1);
        expect(second.created).toBe(false);
        expect(second.deliveries).toBe(0);
        expect(second.id).toBe(first.id);
        expect(await inbox(tx, REP)).toHaveLength(1);
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        expect(Number(rows[0]!.n)).toBe(1);
      });
    });

    it("scopes the dedup key per recipient, so one event reaches two people once each", async () => {
      await inTenant(async (tx) => {
        await raise(tx, { recipientRepProfileId: REP });
        await raise(tx, { recipientRepProfileId: MANAGER });
        expect(await inbox(tx, REP)).toHaveLength(1);
        expect(await inbox(tx, MANAGER)).toHaveLength(1);
      });
    });

    it("refuses an unknown kind at the database, not silently", async () => {
      await inTenant(async (tx) => {
        await expect(
          // @ts-expect-error — the point is that the database refuses it even if a caller
          // bypasses the type.
          raise(tx, { kind: "something_invented" }),
        ).rejects.toThrow(/notification_kind_check|violates check constraint/);
      });
    });

    describe("endpoint selection", () => {
      it("skips an endpoint whose severity threshold is higher", async () => {
        await inTenant(async (tx) => {
          await addEndpoint(tx, { url: "https://hooks.example.com/urgent", minSeverity: "urgent" });
          expect((await raise(tx, { severity: "warning" })).deliveries).toBe(0);
        });
      });

      it("includes one whose threshold is met or lower", async () => {
        await inTenant(async (tx) => {
          await addEndpoint(tx, { url: "https://hooks.example.com/info", minSeverity: "info" });
          expect((await raise(tx, { severity: "warning" })).deliveries).toBe(1);
        });
      });

      it("honours an explicit kind allow-list", async () => {
        await inTenant(async (tx) => {
          await addEndpoint(tx, {
            url: "https://hooks.example.com/overdue-only",
            kinds: ["disposal_obligation_overdue"],
          });
          expect((await raise(tx, { kind: "disposal_obligation_raised" })).deliveries).toBe(0);
          expect(
            (await raise(tx, { kind: "disposal_obligation_overdue", dedupKey: "d2", severity: "urgent" }))
              .deliveries,
          ).toBe(1);
        });
      });

      it("skips a disabled endpoint", async () => {
        await inTenant(async (tx) => {
          await addEndpoint(tx, { url: "https://hooks.example.com/off", enabled: false });
          expect((await raise(tx)).deliveries).toBe(0);
        });
      });

      /**
       * Deliveries are selected when the signal is raised, not when it is sent. An endpoint
       * added today therefore gets today's signals onward — not a backlog of everything
       * that happened before anyone turned it on.
       */
      it("does not back-fill an endpoint added after the event", async () => {
        await inTenant(async (tx) => {
          await raise(tx);
          await addEndpoint(tx, { url: "https://hooks.example.com/late" });
          const { rows } = await tx.query<{ n: string }>(
            "SELECT count(*) AS n FROM crm.notification_delivery WHERE tenant_id = $1",
            [TENANT],
          );
          expect(Number(rows[0]!.n)).toBe(0);
        });
      });

      it("refuses a plaintext URL to another host", async () => {
        await inTenant(async (tx) => {
          await expect(addEndpoint(tx, { url: "http://hooks.example.com/x" })).rejects.toThrow(
            /notification_endpoint_url_check|violates check constraint/,
          );
        });
      });

      it("allows loopback over http, for a local receiver", async () => {
        await inTenant(async (tx) => {
          await expect(addEndpoint(tx, { url: "http://127.0.0.1:8099/hook" })).resolves.toBeTruthy();
        });
      });

      it("refuses a literal secret in place of a variable name", async () => {
        await inTenant(async (tx) => {
          await expect(
            tx.query(
              `INSERT INTO crm.notification_endpoint (tenant_id, channel, url, secret_env)
               VALUES ($1,'webhook','https://h.example.com/x','hunter2')`,
              [TENANT],
            ),
          ).rejects.toThrow(/secret_env/);
        });
      });
    });
  });

  describe("raising for supervisors", () => {
    it("reaches the manager above the rep and nobody else", async () => {
      await inTenant(async (tx) => {
        const results = await raiseForSupervisors(tx, TENANT, REP, {
          kind: "call_plan_submitted",
          severity: "info",
          subject: "A plan needs approval",
          body: "…",
          dedupKey: "plan:1:submitted",
        });
        expect(results).toHaveLength(1);
        expect(await inbox(tx, MANAGER)).toHaveLength(1);
        expect(await inbox(tx, PEER)).toHaveLength(0);
        expect(await inbox(tx, REP)).toHaveLength(0);
      });
    });

    /**
     * The symmetry that keeps the two hierarchy walks honest: managed_rep_ids(M) contains R
     * exactly when supervisors_of(R) contains M. Written separately in 0019 and 0021, so
     * they are two chances to disagree about who is accountable for whom.
     */
    it("agrees with crm.managed_rep_ids in both directions", async () => {
      await inTenant(async (tx) => {
        const { rows: down } = await tx.query<{ rep_profile_id: string }>(
          "SELECT rep_profile_id FROM crm.managed_rep_ids($1)",
          [MANAGER],
        );
        const { rows: up } = await tx.query<{ rep_profile_id: string }>(
          "SELECT rep_profile_id FROM crm.supervisors_of($1)",
          [REP],
        );
        expect(down.map((r) => r.rep_profile_id)).toContain(REP);
        expect(up.map((r) => r.rep_profile_id)).toContain(MANAGER);

        const { rows: peerDown } = await tx.query<{ rep_profile_id: string }>(
          "SELECT rep_profile_id FROM crm.managed_rep_ids($1)",
          [PEER],
        );
        expect(peerDown.map((r) => r.rep_profile_id)).not.toContain(REP);
        expect(up.map((r) => r.rep_profile_id)).not.toContain(PEER);
      });
    });

    it("raises nothing for a rep nobody supervises", async () => {
      await inTenant(async (tx) => {
        const results = await raiseForSupervisors(tx, TENANT, MANAGER, {
          kind: "call_plan_submitted",
          severity: "info",
          subject: "x",
          body: "y",
          dedupKey: "plan:2:submitted",
        });
        expect(results).toEqual([]);
      });
    });
  });

  describe("the inbox", () => {
    it("counts unread from an actual column and keeps the first read timestamp", async () => {
      await inTenant(async (tx) => {
        const a = await raise(tx, { dedupKey: "a" });
        await raise(tx, { dedupKey: "b" });
        expect(await unreadCount(tx, REP)).toBe(2);

        expect(await markRead(tx, REP, a.id)).toBe(true);
        expect(await unreadCount(tx, REP)).toBe(1);

        const first = (await inbox(tx, REP)).find((i) => i.id === a.id)!.read_at;
        // Reading again is success and does not move the timestamp: when they saw it is the
        // fact worth keeping.
        expect(await markRead(tx, REP, a.id)).toBe(true);
        expect((await inbox(tx, REP)).find((i) => i.id === a.id)!.read_at).toEqual(first);
      });
    });

    it("filters to unread on request", async () => {
      await inTenant(async (tx) => {
        const a = await raise(tx, { dedupKey: "a" });
        await raise(tx, { dedupKey: "b" });
        await markRead(tx, REP, a.id);
        expect(await inbox(tx, REP, { unreadOnly: true })).toHaveLength(1);
        expect(await inbox(tx, REP)).toHaveLength(2);
      });
    });

    it("refuses to mark another rep's notification read", async () => {
      await inTenant(async (tx) => {
        const theirs = await raise(tx, { recipientRepProfileId: MANAGER, dedupKey: "theirs" });
        expect(await markRead(tx, REP, theirs.id)).toBe(false);
        expect(await unreadCount(tx, MANAGER)).toBe(1);
      });
    });

    it("marks everything read and reports how many", async () => {
      await inTenant(async (tx) => {
        await raise(tx, { dedupKey: "a" });
        await raise(tx, { dedupKey: "b" });
        expect(await markAllRead(tx, REP)).toBe(2);
        expect(await markAllRead(tx, REP)).toBe(0);
        expect(await unreadCount(tx, REP)).toBe(0);
      });
    });
  });

  describe("webhook delivery against a real HTTP server", () => {
    interface Received {
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }

    const withServer = async <T>(
      handler: (received: Received) => { status: number; body?: string },
      fn: (url: string, received: Received[]) => Promise<T>,
    ): Promise<T> => {
      const received: Received[] = [];
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const entry = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
          received.push(entry);
          const out = handler(entry);
          res.writeHead(out.status, { "content-type": "text/plain" });
          res.end(out.body ?? "");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        return await fn(`http://127.0.0.1:${port}/hook`, received);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };

    const dispatcher = (): NotificationDispatcher =>
      new NotificationDispatcher({
        pool,
        senders: [
          new WebhookSender({
            fetch: globalThis.fetch as unknown as FetchLike,
            env: { CRM_TEST_HOOK_SECRET: SECRET },
          }),
        ],
      });

    /**
     * The test that earns the channel. A real server receives the POST, and the signature is
     * verified against the bytes that actually arrived rather than the bytes we meant to
     * send.
     */
    it("delivers a signed payload a receiver can verify", async () => {
      await withServer(
        () => ({ status: 200, body: "ok" }),
        async (url, received) => {
          const raised = await inTenant(async (tx) => {
            await addEndpoint(tx, { url, minSeverity: "info" });
            return raise(tx, { severity: "urgent", kind: "disposal_obligation_overdue" });
          });

          const result = await dispatcher().drainTenant(TENANT);
          expect(result).toMatchObject({ claimed: 1, delivered: 1, retried: 0, dead: 0, pending: 0 });

          expect(received).toHaveLength(1);
          const got = received[0]!;
          const timestamp = Number(got.headers["x-crm-timestamp"]);
          expect(
            verifyWebhook(SECRET, timestamp, got.body, String(got.headers["x-crm-signature"])),
          ).toBe(true);

          const payload = JSON.parse(got.body) as Record<string, unknown>;
          expect(payload["notificationId"]).toBe(raised.id);
          expect(payload["kind"]).toBe("disposal_obligation_overdue");
          expect(payload["severity"]).toBe("urgent");
          // The recipient travels resolved, so a receiver needs no second lookup.
          expect((payload["recipient"] as Record<string, unknown>)["displayName"]).toBe("ntf-rep");
          expect(got.headers["x-crm-event"]).toBe("disposal_obligation_overdue");

          await inTenant(async (tx) => {
            const { rows } = await tx.query<{ state: string; last_status: number; attempts: number }>(
              "SELECT state, last_status, attempts FROM crm.notification_delivery WHERE tenant_id = $1",
              [TENANT],
            );
            expect(rows[0]!.state).toBe("delivered");
            expect(rows[0]!.last_status).toBe(200);
            expect(rows[0]!.attempts).toBe(1);
          });
        },
      );
    });

    it("retries a 503 and records why", async () => {
      await withServer(
        () => ({ status: 503, body: "upstream down" }),
        async (url) => {
          await inTenant(async (tx) => {
            await addEndpoint(tx, { url, minSeverity: "info" });
            return raise(tx);
          });
          const result = await dispatcher().drainTenant(TENANT);
          expect(result).toMatchObject({ delivered: 0, retried: 1, dead: 0 });
          await inTenant(async (tx) => {
            const { rows } = await tx.query<{ state: string; last_error: string; next_attempt_at: Date }>(
              "SELECT state, last_error, next_attempt_at FROM crm.notification_delivery WHERE tenant_id = $1",
              [TENANT],
            );
            expect(rows[0]!.state).toBe("pending");
            expect(rows[0]!.last_error).toMatch(/503/);
            expect(rows[0]!.last_error).toMatch(/upstream down/);
            // Rescheduled into the future rather than retried in a tight loop.
            expect(rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
          });
        },
      );
    });

    it("dead-letters a 404 immediately rather than burning eight attempts", async () => {
      await withServer(
        () => ({ status: 404, body: "no such hook" }),
        async (url) => {
          await inTenant(async (tx) => {
            await addEndpoint(tx, { url, minSeverity: "info" });
            return raise(tx);
          });
          const result = await dispatcher().drainTenant(TENANT);
          expect(result).toMatchObject({ dead: 1, retried: 0 });
          await inTenant(async (tx) => {
            const { rows } = await tx.query<{ state: string; attempts: number; last_error: string }>(
              "SELECT state, attempts, last_error FROM crm.notification_delivery WHERE tenant_id = $1",
              [TENANT],
            );
            expect(rows[0]!.state).toBe("dead");
            expect(rows[0]!.attempts).toBe(1);
            expect(rows[0]!.last_error).toMatch(/will not succeed on retry/);
          });
        },
      );
    });

    it("gives up after the attempt ceiling, keeping the last real failure as the reason", async () => {
      await withServer(
        () => ({ status: 500, body: "still broken" }),
        async (url) => {
          await inTenant(async (tx) => {
            await addEndpoint(tx, { url, minSeverity: "info" });
            return raise(tx);
          });
          const d = dispatcher();
          for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
            await inTenant((tx) =>
              tx.query("UPDATE crm.notification_delivery SET next_attempt_at = now() WHERE tenant_id = $1", [
                TENANT,
              ]),
            );
            await d.drainTenant(TENANT);
          }
          await inTenant(async (tx) => {
            const { rows } = await tx.query<{ state: string; attempts: number; last_error: string }>(
              "SELECT state, attempts, last_error FROM crm.notification_delivery WHERE tenant_id = $1",
              [TENANT],
            );
            expect(rows[0]!.state).toBe("dead");
            expect(rows[0]!.attempts).toBe(MAX_ATTEMPTS);
            expect(rows[0]!.last_error).toMatch(/still broken/);
            expect(rows[0]!.last_error).toMatch(/gave up after/);
          });
        },
      );
    });

    /**
     * RETRIES a channel this process cannot send — it does not dead-letter it.
     *
     * It used to, and that destroyed every notification routed to a correctly configured
     * endpoint whose sender the running binary happened not to register: `markDead` is
     * terminal. A missing sender is a statement about the PROCESS, not the destination,
     * and the notification is deliverable the moment a process that has the channel takes
     * a tick. The retry ladder still gives up at MAX_ATTEMPTS, so a channel nobody ever
     * registers dead-letters on its own rather than retrying forever — which the second
     * half of this test proves, because "retry" must not mean "never resolves".
     */
    it("retries a channel with no registered sender, then gives up on its own", async () => {
      await inTenant(async (tx) => {
        await addEndpoint(tx, { url: "https://hooks.example.com/x", minSeverity: "info" });
        return raise(tx);
      });
      const d = new NotificationDispatcher({ pool, senders: [] });
      expect(await d.drainTenant(TENANT)).toMatchObject({ dead: 0, retried: 1 });
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ state: string; last_error: string }>(
          "SELECT state, last_error FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows[0]!.state).toBe("pending");
        // Names the channel AND what this process does register, so an operator reading a
        // dead letter can tell "wrong binary" from "wrong endpoint".
        expect(rows[0]!.last_error).toMatch(/no sender registered for channel webhook/);
        expect(rows[0]!.last_error).toMatch(/it registers none/);
      });

      for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
        await inTenant((tx) =>
          tx.query("UPDATE crm.notification_delivery SET next_attempt_at = now() WHERE tenant_id = $1", [TENANT]),
        );
        await d.drainTenant(TENANT);
      }
      await inTenant(async (tx) => {
        const { rows } = await tx.query<{ state: string; attempts: number }>(
          "SELECT state, attempts FROM crm.notification_delivery WHERE tenant_id = $1",
          [TENANT],
        );
        expect(rows[0]!.state).toBe("dead");
        expect(rows[0]!.attempts).toBe(MAX_ATTEMPTS);
      });
    });

    it("does not claim a delivery before it is due", async () => {
      await withServer(
        () => ({ status: 200 }),
        async (url) => {
          await inTenant(async (tx) => {
            await addEndpoint(tx, { url, minSeverity: "info" });
            await raise(tx);
            await tx.query(
              "UPDATE crm.notification_delivery SET next_attempt_at = now() + interval '1 hour' WHERE tenant_id = $1",
              [TENANT],
            );
          });
          expect((await dispatcher().drainTenant(TENANT)).claimed).toBe(0);
        },
      );
    });
  });

  describe("the backoff curve", () => {
    it("grows and then caps, so a dead endpoint is not retried every 10 seconds forever", () => {
      const noJitter = (): number => 1;
      expect(nextDelayMs(1, noJitter)).toBe(10_000);
      expect(nextDelayMs(2, noJitter)).toBe(20_000);
      expect(nextDelayMs(5, noJitter)).toBe(160_000);
      expect(nextDelayMs(9, noJitter)).toBe(300_000);
      expect(nextDelayMs(50, noJitter)).toBe(300_000);
    });

    /**
     * Full jitter, not a narrow band: when an endpoint recovers, every queued delivery for
     * it becomes due at once, and a ±10% band would reproduce the burst that took it down.
     */
    it("spreads retries across the whole window", () => {
      expect(nextDelayMs(3, () => 0)).toBe(1_000);
      expect(nextDelayMs(3, () => 1)).toBe(40_000);
      expect(nextDelayMs(3, () => 0.5)).toBe(20_000);
    });
  });
});
