import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { TENANT_DISPOSAL_SEQ as TENANT, appPool } from "@crm/db/testing";

import { disposalHistory, sweepExpiredStock } from "./expiry-sweep.js";
import { openObligations, receiveSamples, registerLot, type SampleLot } from "./store.js";

/**
 * Two disposal obligations written in one transaction, and whether anything can order
 * them (0036 part 1).
 *
 * WHAT WAS BROKEN. `crm.disposal_obligation.created_at` defaults to `now()`, which is the
 * TRANSACTION timestamp, and `sweepExpiredStock` runs its whole pass in one transaction by
 * design. So a pass that opens obligations for several expired lots stamps every row with
 * one timestamp, and nothing else in the table recorded the order. `crm.open_disposal_obligations`
 * sorted by `(due_by, display_name)` — both of which TIE for one rep's two lots found on the
 * same pass — and `crm.disposal_obligation_chain` fell back to `(created_at, id)` for a row
 * the continuation walk could not reach, which is `ORDER BY id` once the timestamps match.
 *
 * Every test below is a variation on one sentence: the order the rows were written is now
 * recorded in `seq`, and it is the last term of every ordering over this table.
 *
 * NON-VACUOUSNESS. Proving an order is "stable" is the classic vacuous test — a wrong
 * order is stable too. So the crafted cases here mint ids whose uuid order is the REVERSE
 * of the insert order. A query that fell back to `id`, or that returned whatever the plan
 * produced and happened to agree with `id`, fails these assertions rather than passing
 * them by luck.
 *
 * Connected through `appPool()` so every statement runs as `crm_app` with RLS live; a
 * superuser connection would prove nothing about the isolation assertions at the bottom.
 *
 * TENANT. This file uses `TENANT_DISPOSAL_SEQ`, the block reserved for it. The attempt
 * history suite in `packages/relay` shares it (it touches `crm.outbox` and
 * `crm.outbox_dead_letter`, disjoint from everything here, and test files run
 * sequentially) because adding a second reserved block means editing
 * `packages/db/src/testing.ts`, which this change does not own. A dedicated block for it
 * is the tidier end state.
 */
describe("ordering two disposal obligations written in one transaction", () => {
  let pool: Pool;
  let client: PoolClient;

  const REP = "e2aa0000-0000-4000-8000-000000000001";
  const WAREHOUSE = "DS-WH-1";

  /** Insert order ascending, uuid order DESCENDING — see NON-VACUOUSNESS above. */
  const HIGH_UUID = "e2bb0000-0000-4000-8000-0000000000ff";
  const LOW_UUID = "e2bb0000-0000-4000-8000-00000000000a";
  const MID_UUID = "e2bb0000-0000-4000-8000-0000000000b0";

  const day = (d: string): Date => new Date(`${d}T09:00:00Z`);

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  const reset = async (): Promise<void> => {
    await inTenant(async (tx) => {
      for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
        await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      }
      try {
        await tx.query("DELETE FROM crm.notification_delivery WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.notification WHERE tenant_id = $1", [TENANT]);
        // One statement for the whole chain: `continues_obligation_id` is ON DELETE
        // RESTRICT, so deleting a continuation and its predecessor in two statements
        // would be refused in whichever order it tried.
        await tx.query("DELETE FROM crm.disposal_obligation WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.disposal_policy WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      } finally {
        for (const t of ["crm.sample_transaction", "crm.sample_holding"]) {
          await tx.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
        }
      }
    });
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
         VALUES ($1,$2,'dseq-rep','DSEQ-1','dseq-rep') ON CONFLICT DO NOTHING`,
        [REP, TENANT],
      );
    });
  });

  afterAll(async () => {
    await reset();
    client?.release();
    await pool?.end();
  });

  beforeEach(reset);

  /** Stock received while still in date, so it expires in the rep's custody (0020). */
  const heldStock = async (
    tx: PoolClient,
    opts: { expiry: string; quantity?: number },
  ): Promise<SampleLot> => {
    const lot = await registerLot(tx, TENANT, {
      erpItemId: "DS-ITEM",
      lotNumber: `DSEQ-${randomUUID().slice(0, 8)}`,
      materialKind: "drug_sample",
      expiryDate: opts.expiry,
    });
    await receiveSamples(tx, TENANT, {
      id: randomUUID(),
      lotId: lot.id,
      repProfileId: REP,
      quantity: opts.quantity ?? 10,
      occurredAt: day("2026-01-05"),
      erpWarehouseId: WAREHOUSE,
    });
    return lot;
  };

  /**
   * A bare obligation, with the id chosen by the caller.
   *
   * Direct SQL rather than through the sweep because the point is to control the id and
   * the insert order independently of each other, which the sweep does not let a caller do.
   */
  const insertObligation = async (
    tx: PoolClient,
    opts: {
      id: string;
      lotId: string;
      dueBy: string;
      discoveredOn?: string;
      continues?: string | null;
      resolved?: boolean;
    },
  ): Promise<{ id: string; seq: string; created_at: Date }> => {
    const { rows } = await tx.query<{ id: string; seq: string; created_at: Date }>(
      `INSERT INTO crm.disposal_obligation
         (id, tenant_id, rep_profile_id, lot_id, quantity_at_discovery, expired_on,
          discovered_on, due_by, continues_obligation_id, status, resolved_on, resolution)
       VALUES ($1, $2, $3, $4, 5, '2026-03-31', $5::date, $6::date, $7,
               CASE WHEN $8 THEN 'resolved' ELSE 'open' END,
               CASE WHEN $8 THEN $5::date END,
               CASE WHEN $8 THEN 'destroyed' END)
       RETURNING id, seq::text AS seq, created_at`,
      [
        opts.id,
        TENANT,
        REP,
        opts.lotId,
        opts.discoveredOn ?? "2026-04-10",
        opts.dueBy,
        opts.continues ?? null,
        opts.resolved ?? false,
      ],
    );
    return rows[0]!;
  };

  // ---- the gap, demonstrated ------------------------------------------------

  describe("the transaction clock", () => {
    it("stamps two obligations from one sweep pass with the same created_at", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-03-31" });
        await heldStock(tx, { expiry: "2026-03-30" });

        const result = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        expect(result.opened).toBe(2);

        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(DISTINCT created_at) AS n FROM crm.disposal_obligation
            WHERE tenant_id = $1`,
          [TENANT],
        );
        // One distinct timestamp over two rows: this is the defect, measured. Nothing
        // temporal can order these, which is why `seq` exists.
        expect(Number(rows[0]!.n)).toBe(1);
      });
    });

    it("leaves due_by and display_name tied too, so 0020's sort key discriminates nothing", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-03-31" });
        await heldStock(tx, { expiry: "2026-03-30" });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const { rows } = await tx.query<{ due: string; name: string }>(
          `SELECT DISTINCT o.due_by::text AS due, rp.display_name AS name
             FROM crm.disposal_obligation o
             JOIN crm.rep_profile rp ON rp.id = o.rep_profile_id
            WHERE o.tenant_id = $1`,
          [TENANT],
        );
        // Both obligations share the whole of `ORDER BY due_by, display_name`. Before
        // `seq` the chase list's order was therefore the planner's.
        expect(rows).toHaveLength(1);
      });
    });
  });

  // ---- the column ----------------------------------------------------------

  describe("seq", () => {
    it("is allocated per INSERT and strictly increases inside one transaction", async () => {
      await inTenant(async (tx) => {
        const a = await heldStock(tx, { expiry: "2026-03-31" });
        const b = await heldStock(tx, { expiry: "2026-03-30" });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const { rows } = await tx.query<{ lot_id: string; seq: string }>(
          `SELECT lot_id, seq::text AS seq FROM crm.disposal_obligation
            WHERE tenant_id = $1 ORDER BY seq`,
          [TENANT],
        );
        expect(rows).toHaveLength(2);
        expect(Number(rows[1]!.seq)).toBeGreaterThan(Number(rows[0]!.seq));
        // `crm.expired_sample_holdings` returns `ORDER BY expiry_date`, so the lot that
        // expired FIRST was inserted first — and `seq` now says so. This is the sweep's
        // own order, recovered from the table instead of from the code.
        expect(rows[0]!.lot_id).toBe(b.id);
        expect(rows[1]!.lot_id).toBe(a.id);
      });
    });

    it("needs no writer: the column default supplies it", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        // No `seq` in the column list, and the sweep names none either.
        const row = await insertObligation(tx, { id: randomUUID(), lotId: lot.id, dueBy: "2026-05-10" });
        expect(Number(row.seq)).toBeGreaterThan(0);
      });
    });

    it("refuses an explicit duplicate", async () => {
      await inTenant(async (tx) => {
        const lotA = await heldStock(tx, { expiry: "2026-03-31" });
        const lotB = await heldStock(tx, { expiry: "2026-03-30" });
        const first = await insertObligation(tx, {
          id: randomUUID(),
          lotId: lotA.id,
          dueBy: "2026-05-10",
        });
        const second = await insertObligation(tx, {
          id: randomUUID(),
          lotId: lotB.id,
          dueBy: "2026-05-10",
        });
        await expect(
          tx.query("UPDATE crm.disposal_obligation SET seq = $2 WHERE id = $1", [
            second.id,
            first.seq,
          ]),
        ).rejects.toThrow(/uq_disposal_obligation_seq/);
      });
    });

    it("refuses being nulled", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        const row = await insertObligation(tx, { id: randomUUID(), lotId: lot.id, dueBy: "2026-05-10" });
        await expect(
          tx.query("UPDATE crm.disposal_obligation SET seq = NULL WHERE id = $1", [row.id]),
        ).rejects.toThrow(/null value in column "seq"/);
      });
    });

    it("has GAPS, because a sweep that re-sees a carton burns a value", async () => {
      await inTenant(async (tx) => {
        await heldStock(tx, { expiry: "2026-03-31" });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });

        const before = await tx.query<{ n: string; max: string }>(
          `SELECT count(*) AS n, max(seq)::text AS max FROM crm.disposal_obligation
            WHERE tenant_id = $1`,
          [TENANT],
        );
        // The second pass finds the same expired holding, hits
        // `uq_disposal_obligation_live` and inserts nothing — but the column DEFAULT is
        // evaluated before the conflict is detected, so the value is spent.
        const again = await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-11") });
        expect(again.opened).toBe(0);

        const { rows } = await tx.query<{ last: string }>("SELECT last_value::text AS last FROM crm.disposal_obligation_seq_seq");
        expect(Number(rows[0]!.last)).toBeGreaterThan(Number(before.rows[0]!.max));
        const after = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM crm.disposal_obligation WHERE tenant_id = $1`,
          [TENANT],
        );
        // Row count unchanged while the sequence advanced: nothing may read `seq` as a
        // count, and no reader may infer "I am missing row N" from a gap.
        expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      });
    });

    it("is owned by the column, so it cannot outlive it", async () => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_depend d
           JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
           JOIN pg_class t ON t.oid = d.refobjid
          WHERE s.relname = 'disposal_obligation_seq_seq'
            AND t.relname = 'disposal_obligation'
            AND d.deptype = 'a'`,
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it("is one sequence for the whole deployment, not a per-tenant counter", async () => {
      // Worth pinning because the column sits on a tenant-scoped table and reads like a
      // per-tenant ordinal. It is not: `nextval` knows nothing about RLS, so a tenant's
      // lowest `seq` is whatever the deployment had reached. Only the ORDER is meaningful.
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        const row = await insertObligation(tx, { id: randomUUID(), lotId: lot.id, dueBy: "2026-05-10" });
        const { rows } = await tx.query<{ last: string }>(
          "SELECT last_value::text AS last FROM crm.disposal_obligation_seq_seq",
        );
        expect(row.seq).toBe(rows[0]!.last);
      });
    });
  });

  // ---- the chase list ------------------------------------------------------

  /**
   * Rewrites a row's heap tuple, which moves it to the end of a sequential scan.
   *
   * This is how the ordering assertions below are kept from being vacuous: a sort key
   * that discriminated nothing would inherit the scan order, which on a table of freshly
   * inserted rows is often the insert order — so it could produce the right answer for the
   * wrong reason. Perturbing the layout takes that coincidence away.
   *
   * Not contrived, either: the sweep's step 4 updates obligations to `overdue`, so a row
   * rewritten since it was inserted is the normal state of this table.
   */
  const touch = async (tx: PoolClient, id: string): Promise<void> => {
    await tx.query("UPDATE crm.disposal_obligation SET updated_at = now() WHERE id = $1", [id]);
  };

  describe("crm.open_disposal_obligations", () => {
    it("returns the insert order when due_by and display_name tie", async () => {
      await inTenant(async (tx) => {
        const lotA = await heldStock(tx, { expiry: "2026-03-31" });
        const lotB = await heldStock(tx, { expiry: "2026-03-30" });

        // HIGH first, LOW second: uuid order is the reverse of insert order, so a sort
        // that fell back to `id` returns these the other way round.
        await insertObligation(tx, { id: HIGH_UUID, lotId: lotA.id, dueBy: "2026-05-10" });
        await insertObligation(tx, { id: LOW_UUID, lotId: lotB.id, dueBy: "2026-05-10" });
        await touch(tx, HIGH_UUID);

        const { rows } = await tx.query<{ id: string }>(
          "SELECT id FROM crm.open_disposal_obligations($1, '2026-04-10'::date)",
          [REP],
        );
        expect(rows.map((r) => r.id)).toEqual([HIGH_UUID, LOW_UUID]);
      });
    });

    /**
     * The same property, asserted deterministically — and the THIRD attempt at it.
     *
     * The first compared the function against 0020's tie-less sort key and asserted that
     * key's answer, which passed on one database and failed on a freshly built one,
     * because what a tie-less ORDER BY returns is the scan order and the scan order
     * depends on the heap. The second forced a heap move with an UPDATE and asserted the
     * answer was invariant under it, guarding its own premise with "the layout did not
     * change, so the invariance is untested".
     *
     * That guard is correct and the premise is not reliably satisfiable. An UPDATE
     * relocates a tuple only when its page has no room; `crm.disposal_obligation` is
     * written by several suites, so whether there is room depends on dead tuples left by
     * whatever ran before. Run alone it moved and the test passed; run in the full suite
     * it did not and the test failed, reporting its own premise rather than a defect.
     *
     * So the layout is removed as a variable instead of being fought. The property that
     * matters is that the ordering is TOTAL — with every term of 0020's key tied, the
     * answer is decided by `seq` and by nothing physical. That is checked by reading both
     * orders and asserting the function agrees with `seq` whatever the scan returned, and
     * it is checked on the arrangement where the two can disagree. When they do disagree
     * the test has observed exactly what the removed version was trying to force; when
     * they happen to coincide it still holds, because `seq` order is the claim.
     */
    it("decides a full tie by seq, not by whatever order the scan returns", async () => {
      await inTenant(async (tx) => {
        const lotA = await heldStock(tx, { expiry: "2026-03-31" });
        const lotB = await heldStock(tx, { expiry: "2026-03-30" });
        // HIGH first, so `seq` order is [HIGH, LOW] while uuid order is the reverse — the
        // arrangement in which a sort falling through to `id`, or to the scan, is visible.
        await insertObligation(tx, { id: HIGH_UUID, lotId: lotA.id, dueBy: "2026-05-10" });
        await insertObligation(tx, { id: LOW_UUID, lotId: lotB.id, dueBy: "2026-05-10" });
        await touch(tx, HIGH_UUID);

        const { rows: scan } = await tx.query<{ id: string; seq: string }>(
          // No ORDER BY, deliberately: this is the scan order, which is what a tie-less
          // sort inherits and what must NOT be able to decide the answer.
          "SELECT id, seq::text AS seq FROM crm.disposal_obligation WHERE tenant_id = $1",
          [TENANT],
        );
        const { rows: chased } = await tx.query<{ id: string }>(
          "SELECT id FROM crm.open_disposal_obligations($1, '2026-04-10'::date)",
          [REP],
        );

        const bySeq = [...scan].sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.id);
        expect(bySeq).toEqual([HIGH_UUID, LOW_UUID]);
        expect(chased.map((r) => r.id)).toEqual(bySeq);
        // And twice in a row, so a coincidence on one call is not the whole evidence.
        const { rows: again } = await tx.query<{ id: string }>(
          "SELECT id FROM crm.open_disposal_obligations($1, '2026-04-10'::date)",
          [REP],
        );
        expect(again.map((r) => r.id)).toEqual(bySeq);
      });
    });

    it("still puts the sooner deadline first — the tie-break is the LAST term", async () => {
      await inTenant(async (tx) => {
        const lotA = await heldStock(tx, { expiry: "2026-03-31" });
        const lotB = await heldStock(tx, { expiry: "2026-03-30" });

        // Inserted in the wrong order for `due_by` on purpose: `seq` must not outrank it.
        await insertObligation(tx, { id: HIGH_UUID, lotId: lotA.id, dueBy: "2026-06-10" });
        await insertObligation(tx, { id: LOW_UUID, lotId: lotB.id, dueBy: "2026-05-10" });

        const { rows } = await tx.query<{ id: string }>(
          "SELECT id FROM crm.open_disposal_obligations($1, '2026-04-10'::date)",
          [REP],
        );
        expect(rows.map((r) => r.id)).toEqual([LOW_UUID, HIGH_UUID]);
      });
    });

    it("gives the same answer on every call", async () => {
      await inTenant(async (tx) => {
        const lots = [
          await heldStock(tx, { expiry: "2026-03-31" }),
          await heldStock(tx, { expiry: "2026-03-30" }),
          await heldStock(tx, { expiry: "2026-03-29" }),
        ];
        for (const [i, id] of [HIGH_UUID, LOW_UUID, MID_UUID].entries()) {
          await insertObligation(tx, { id, lotId: lots[i]!.id, dueBy: "2026-05-10" });
        }
        await touch(tx, HIGH_UUID);
        await touch(tx, LOW_UUID);
        const read = async (): Promise<readonly string[]> => {
          const { rows } = await tx.query<{ id: string }>(
            "SELECT id FROM crm.open_disposal_obligations($1, '2026-04-10'::date)",
            [REP],
          );
          return rows.map((r) => r.id);
        };
        const first = await read();
        expect(first).toEqual([HIGH_UUID, LOW_UUID, MID_UUID]);
        expect(await read()).toEqual(first);
        expect(await read()).toEqual(first);
      });
    });

    it("keeps every column 0020 declared, so its callers still read by name", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        await insertObligation(tx, { id: HIGH_UUID, lotId: lot.id, dueBy: "2026-05-10" });
        const [row] = await openObligations(tx, REP, { asOf: "2026-04-10" });
        expect(row).toMatchObject({
          id: HIGH_UUID,
          rep_profile_id: REP,
          display_name: "dseq-rep",
          lot_id: lot.id,
          lot_number: lot.lot_number,
          material_kind: "drug_sample",
          due_by: "2026-05-10",
          status: "open",
        });
        expect(row!.days_overdue).toBe(-30);
        expect(row!.quantity_on_hand).toBe("10.000");
      });
    });

    it("reaches openObligations in that order too", async () => {
      await inTenant(async (tx) => {
        const lotA = await heldStock(tx, { expiry: "2026-03-31" });
        const lotB = await heldStock(tx, { expiry: "2026-03-30" });
        await insertObligation(tx, { id: HIGH_UUID, lotId: lotA.id, dueBy: "2026-05-10" });
        await insertObligation(tx, { id: LOW_UUID, lotId: lotB.id, dueBy: "2026-05-10" });
        await touch(tx, HIGH_UUID);
        const rows = await openObligations(tx, REP, { asOf: "2026-04-10" });
        expect(rows.map((r) => r.id)).toEqual([HIGH_UUID, LOW_UUID]);
      });
    });
  });

  // ---- the audit chain -----------------------------------------------------

  describe("crm.disposal_obligation_chain", () => {
    it("still orders by the continuation links, not by seq", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        // The continuation's uuid sorts BEFORE the root's, so a sort that fell back to
        // `id` — which is what `(created_at, id)` degenerates to here — returns these the
        // wrong way round. The walk does not.
        //
        // What this does NOT distinguish is the walk from `seq`: for a chain this schema
        // can write they necessarily agree, because the row being continued must already
        // exist to be referenced and so took its sequence value first. The assertion is a
        // regression guard on the walk, and the orphan case below is where the two differ.
        const root = await insertObligation(tx, {
          id: HIGH_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          resolved: true,
        });
        await insertObligation(tx, {
          id: LOW_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          continues: root.id,
        });

        const chain = await disposalHistory(tx, REP, lot.id);
        expect(chain.map((c) => c.id)).toEqual([HIGH_UUID, LOW_UUID]);
        expect(chain.map((c) => c.sequence_number)).toEqual([1, 2]);
      });
    });

    it("exposes seq, in the walk's order", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        const root = await insertObligation(tx, {
          id: HIGH_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          resolved: true,
        });
        const cont = await insertObligation(tx, {
          id: LOW_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          continues: root.id,
        });
        const chain = await disposalHistory(tx, REP, lot.id);
        expect(chain.map((c) => c.seq)).toEqual([root.seq, cont.seq]);
      });
    });

    it("orders rows the walk cannot reach by seq, not by id", async () => {
      await inTenant(async (tx) => {
        const anchor = await heldStock(tx, { expiry: "2026-03-29" });
        const lot = await heldStock(tx, { expiry: "2026-03-31" });

        // The anchor belongs to a DIFFERENT lot, so a row continuing it is neither a root
        // (its `continues_obligation_id` is set) nor reachable by the walk for `lot`
        // (which never visits another lot's rows). Only reachable by a hand-written
        // row — which is the case 0030 wrote the fallback for.
        const other = await insertObligation(tx, {
          id: randomUUID(),
          lotId: anchor.id,
          dueBy: "2026-05-10",
          resolved: true,
        });
        const root = await insertObligation(tx, {
          id: MID_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          resolved: true,
        });
        await insertObligation(tx, {
          id: HIGH_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          continues: other.id,
          resolved: true,
        });
        await insertObligation(tx, {
          id: LOW_UUID,
          lotId: lot.id,
          dueBy: "2026-05-10",
          continues: other.id,
        });

        const chain = await disposalHistory(tx, REP, lot.id);
        // Root first at depth 1; then the two unreachable rows at depth 0, in INSERT
        // order. `ORDER BY id` would have returned LOW before HIGH.
        expect(chain.map((c) => c.id)).toEqual([MID_UUID, HIGH_UUID, LOW_UUID]);
        expect(chain.map((c) => c.sequence_number)).toEqual([1, 0, 0]);
        expect(Number(chain[2]!.seq)).toBeGreaterThan(Number(chain[1]!.seq));
      });
    });

    it("keeps the attributed ledger fact and the 0030 columns", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        await sweepExpiredStock(tx, TENANT, { asOf: day("2026-04-10") });
        const [row] = await disposalHistory(tx, REP, lot.id);
        expect(row).toMatchObject({
          sequence_number: 1,
          continues_obligation_id: null,
          expired_on: "2026-03-31",
          discovered_on: "2026-04-10",
          due_by: "2026-05-10",
          status: "open",
          resolved_on: null,
          resolution: null,
          resolving_transaction_id: null,
          resolving_transaction_kind: null,
        });
        expect(row!.quantity_at_discovery).toBe("10.000");
        expect(row!.created_at).toBeInstanceOf(Date);
        expect(typeof row!.seq).toBe("string");
      });
    });

    it("has nothing to show for a lot with no obligation", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-12-31" });
        expect(await disposalHistory(tx, REP, lot.id)).toHaveLength(0);
      });
    });
  });

  // ---- isolation -----------------------------------------------------------

  describe("tenant isolation", () => {
    it("hides the rows, and therefore the order, from another tenant", async () => {
      const OTHER = "e2cc0000-0000-4000-8000-000000000099";
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        await insertObligation(tx, { id: HIGH_UUID, lotId: lot.id, dueBy: "2026-05-10" });
      });
      await withTenantContext(client, OTHER, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM crm.disposal_obligation",
        );
        expect(Number(rows[0]!.n)).toBe(0);
        const chain = await tx.query(
          "SELECT * FROM crm.disposal_obligation_chain($1, $2)",
          [REP, "00000000-0000-4000-8000-000000000000"],
        );
        expect(chain.rows).toHaveLength(0);
      });
    });

    it("cannot smuggle an obligation into another tenant, seq or no seq", async () => {
      await inTenant(async (tx) => {
        const lot = await heldStock(tx, { expiry: "2026-03-31" });
        await expect(
          tx.query(
            `INSERT INTO crm.disposal_obligation
               (tenant_id, rep_profile_id, lot_id, quantity_at_discovery, expired_on,
                discovered_on, due_by)
             VALUES ($1, $2, $3, 1, '2026-03-31', '2026-04-10', '2026-05-10')`,
            ["e2cc0000-0000-4000-8000-000000000099", REP, lot.id],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it("keeps FORCE ROW LEVEL SECURITY on after the backfill lifted it", async () => {
      // 0036 does what 0027 had to: `NO FORCE` around a DML backfill, restored at the end
      // of the part. A migration that forgot the restore leaves crm_app — the OWNER of
      // this table — reading every tenant's obligations.
      const { rows } = await client.query<{ rls: boolean; forced: boolean }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crm' AND c.relname = 'disposal_obligation'`,
      );
      expect(rows[0]).toEqual({ rls: true, forced: true });
    });
  });
});
