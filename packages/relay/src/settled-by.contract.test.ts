import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ErpError } from "@crm/acl";
import { withTenantContext } from "@crm/db";
import {
  appPool,
  registerFixtureTenant,
  TENANT_SETTLED_BY as TENANT,
  TENANT_SETTLED_BY_OTHER as OTHER,
} from "@crm/db/testing";

import { claimBatch, enqueueOutbox, markDelivered, markRetry, settlementExceptions } from "./store.js";
import { SETTLED_BY, TargetAlreadyPresentError, classify } from "./outcome.js";

/**
 * Which mechanism settled a delivery (migration 0076).
 *
 * WHAT THIS IS FOR, because a column recording "how" looks like bookkeeping until the reason is
 * stated. ADR-0001 carried a row saying the CRM's idempotency guarantee rested on the ERP
 * leaking a node-postgres message to clients: a duplicate record id answers
 * `500 {"error":"write_failed","detail":"duplicate key value violates unique constraint …"}`,
 * which normalises to `unavailable` rather than `conflict`, so a regex over that sentence was
 * the only thing settling a redelivery. The read-back probe closed the dependency — but the
 * regex is still the documented fallback, and nothing said whether it was still load-bearing.
 * A deployment settling every redelivery by that sentence looked identical to one settling none
 * that way.
 *
 * So each delivery records the mechanism and the question becomes a query. These tests assert
 * the three things that makes true: the database refuses a delivery that does not say;
 * `classify` names the right mechanism for each shape of failure; and the per-tenant count
 * excludes the ordinary case so the exceptional ones are what a reader sees.
 */
describe("which mechanism settled a delivery (0076)", () => {
  let pool: Pool;
  let client: PoolClient;

  const DUE = new Date("2027-01-01T09:00:00Z");

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();
    await registerFixtureTenant(client, TENANT, "relay — settled_by");
    await registerFixtureTenant(client, OTHER, "relay — settled_by control");
  });

  const reset = async (): Promise<void> => {
    for (const tenant of [TENANT, OTHER]) {
      await withTenantContext(client, tenant, async (tx) => {
        await tx.query("DELETE FROM crm.outbox_dead_letter WHERE tenant_id = $1", [tenant]);
        await tx.query("DELETE FROM crm.outbox WHERE tenant_id = $1", [tenant]);
      });
    }
  };

  afterAll(async () => {
    await reset();
    client?.release();
    await pool?.end();
  });

  afterEach(reset);

  const queued = async (tx: PoolClient, tenant = TENANT): Promise<string> => {
    const { id } = await enqueueOutbox(tx, tenant, {
      entity: "Expense",
      operation: "create",
      payload: { amount: 12 },
      targetRecordId: `SB-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      sourceTable: "crm.expense_claim",
      sourceId: randomUUID(),
    });
    return id;
  };

  const settledByOf = async (tx: PoolClient, id: string): Promise<string | null> => {
    const { rows } = await tx.query<{ settled_by: string | null }>(
      "SELECT settled_by FROM crm.outbox WHERE id = $1",
      [id],
    );
    return rows[0]?.settled_by ?? null;
  };

  // =========================================================================
  // THE PAIRING, which is what makes the column impossible to leave silent
  // =========================================================================

  /**
   * A column that is allowed to be silent is a column that will be — 0051's `undecided` and
   * 0066's `unverifiable` are the same rule in their own subsystems. Here the pairing is with
   * the state, in both directions: a delivery must say, and nothing else may.
   */
  it("refuses a delivery that does not say which mechanism settled it", async () => {
    await inTenant(async (tx) => {
      const id = await queued(tx);
      await tx.query("SAVEPOINT probe");
      const refusal = await tx
        .query("UPDATE crm.outbox SET state = 'delivered' WHERE id = $1", [id])
        .then(() => null, (e: unknown) => e as { constraint?: string });
      await tx.query("ROLLBACK TO SAVEPOINT probe");
      expect(refusal?.constraint).toBe("outbox_delivered_records_its_mechanism");
    });
  });

  it("refuses a mechanism on a row that is not delivered", async () => {
    await inTenant(async (tx) => {
      const id = await queued(tx);
      await tx.query("SAVEPOINT probe");
      const refusal = await tx
        .query("UPDATE crm.outbox SET settled_by = 'accepted' WHERE id = $1", [id])
        .then(() => null, (e: unknown) => e as { constraint?: string });
      await tx.query("ROLLBACK TO SAVEPOINT probe");
      expect(refusal?.constraint).toBe("outbox_delivered_records_its_mechanism");
    });
  });

  it("admits exactly the five values the vocabulary names, and refuses anything else", async () => {
    await inTenant(async (tx) => {
      for (const value of SETTLED_BY) {
        const id = await queued(tx);
        await tx.query("SAVEPOINT v");
        await tx.query("UPDATE crm.outbox SET state = 'delivered', settled_by = $2 WHERE id = $1", [
          id,
          value,
        ]);
        expect(await settledByOf(tx, id), `${value} must be admitted`).toBe(value);
        await tx.query("ROLLBACK TO SAVEPOINT v");
      }

      const id = await queued(tx);
      await tx.query("SAVEPOINT bogus");
      const refusal = await tx
        .query("UPDATE crm.outbox SET state = 'delivered', settled_by = 'probably_fine' WHERE id = $1", [id])
        .then(() => null, (e: unknown) => e as { constraint?: string });
      await tx.query("ROLLBACK TO SAVEPOINT bogus");
      expect(refusal?.constraint).toBe("outbox_settled_by_vocabulary");
    });
  });

  /**
   * And the TypeScript union is the same list, asserted rather than assumed.
   *
   * `SETTLED_BY` drives the type the relay must supply and the CHECK admits the column's values;
   * the two drifting apart would mean a value the code can produce and the database refuses, or
   * the reverse. Derived from `pg_constraint` so a migration that widens the CHECK without
   * widening the union fails here.
   */
  it("keeps the vocabulary and the CHECK the same list", async () => {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'crm.outbox'::regclass AND conname = 'outbox_settled_by_vocabulary'`,
    );
    expect(rows, "the vocabulary CHECK is missing, so this assertion would be vacuous").toHaveLength(1);
    const admitted = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
    expect(admitted).toEqual([...SETTLED_BY].sort());
  });

  // =========================================================================
  // WHAT `classify` NAMES, which is the part the column exists to distinguish
  // =========================================================================

  /**
   * THE THREE WAYS A REDELIVERY CAN SETTLE, and why telling them apart is the point.
   *
   * `read_back` is evidence: the relay asked the ERP for the id it minted and the ERP had it.
   * `conflict_status` is a statement: the ERP answered a real 409. `duplicate_key_text` is an
   * inference from a sentence the platform never promised to keep — the dependency ADR-0001
   * described as breaking "silently and in the expensive direction".
   */
  it("names read_back when the probe read the record back", () => {
    const outcome = classify({
      error: new TargetAlreadyPresentError("SB-1", new ErpError("unavailable", 500, "write_failed", "boom", null)),
      isTransition: false,
    });
    expect(outcome.kind).toBe("already_delivered");
    expect(outcome.kind === "already_delivered" ? outcome.settledBy : null).toBe("read_back");
  });

  it("names conflict_status when the ERP answered a real 409", () => {
    const outcome = classify({
      error: new ErpError("conflict", 409, "conflict", "that id is taken", null),
      isTransition: false,
    });
    expect(outcome.kind).toBe("already_delivered");
    expect(outcome.kind === "already_delivered" ? outcome.settledBy : null).toBe("conflict_status");
  });

  /**
   * The fallback, named as the fallback. This is the shape the live server really answers — a
   * 500 whose `detail` is the node-postgres message — and the whole reason the column exists is
   * that a deployment settling redeliveries this way should be able to SEE that it is.
   */
  it("names duplicate_key_text when only the driver's sentence settled it", () => {
    const outcome = classify({
      // The shape the live server really answers: `unavailable`, because a 500 is not a
      // conflict, with the driver's sentence in `detail`. That mismatch is the whole origin of
      // the open row — `classify`'s conflict branch never fires, and only the regex settles it.
      error: new ErpError(
        "unavailable",
        500,
        "write_failed",
        'duplicate key value violates unique constraint "operate_entity_records_pkey"',
        null,
      ),
      isTransition: false,
    });
    expect(outcome.kind).toBe("already_delivered");
    expect(outcome.kind === "already_delivered" ? outcome.settledBy : null).toBe("duplicate_key_text");
  });

  it("names nothing at all on an outcome that is not a delivery", () => {
    const outcome = classify({
      error: new ErpError("unavailable", 503, "unavailable", "the ERP is restarting", null),
      isTransition: false,
    });
    expect(outcome.kind).toBe("retry_transient");
    // The union has no `settledBy` on this branch, so this is a statement about the shape
    // rather than about a value: a reader destructuring it gets a type error, not `undefined`.
    expect(Object.prototype.hasOwnProperty.call(outcome, "settledBy")).toBe(false);
  });

  // =========================================================================
  // AND THE COUNT, which is the surface somebody reads
  // =========================================================================

  it("counts the exceptional settlements and leaves the ordinary one out", async () => {
    await inTenant(async (tx) => {
      const deliver = async (mechanism: (typeof SETTLED_BY)[number]): Promise<void> => {
        const id = await queued(tx);
        expect(await claimBatch(tx, TENANT, "worker-a", 10, DUE)).not.toHaveLength(0);
        expect(await markDelivered(tx, id, DUE, { ok: true }, mechanism)).toBe(true);
      };
      await deliver("accepted");
      await deliver("accepted");
      await deliver("read_back");
      await deliver("duplicate_key_text");

      // `accepted` is absent deliberately: it is the overwhelming majority of every queue, and
      // a number that is always large sits badly next to the ones that matter.
      expect([...(await settlementExceptions(tx, TENANT))].sort()).toEqual([
        ["duplicate_key_text", 1],
        ["read_back", 1],
      ]);
    });
  });

  it("says nothing when every delivery was simply accepted", async () => {
    await inTenant(async (tx) => {
      const id = await queued(tx);
      expect(await claimBatch(tx, TENANT, "worker-a", 10, DUE)).not.toHaveLength(0);
      await markDelivered(tx, id, DUE, { ok: true }, "accepted");
      expect([...(await settlementExceptions(tx, TENANT))]).toEqual([]);
    });
  });

  /**
   * Per tenant, because which writes collide is a property of that tenant's traffic.
   *
   * One tenant's `duplicate_key_text` must say nothing about another's — and the function reads
   * `crm.outbox` under the caller's own row security, so this also asserts the confinement
   * rather than only the predicate.
   */
  it("counts only the caller's own tenant", async () => {
    await withTenantContext(client, OTHER, async (tx) => {
      const id = await queued(tx, OTHER);
      expect(await claimBatch(tx, OTHER, "worker-b", 10, DUE)).not.toHaveLength(0);
      await markDelivered(tx, id, DUE, { ok: true }, "duplicate_key_text");
    });
    await inTenant(async (tx) => {
      expect([...(await settlementExceptions(tx, TENANT))]).toEqual([]);
    });
    await withTenantContext(client, OTHER, async (tx) => {
      expect([...(await settlementExceptions(tx, OTHER))]).toEqual([["duplicate_key_text", 1]]);
    });
  });

  /**
   * A retry clears it, which is the pairing again from the other side.
   *
   * A row that was delivered and is somehow retried must not keep a mechanism it is no longer
   * settled by. `markRetry` does not mention the column, so this asserts the CHECK would refuse
   * the transition if it ever did — the one case where a test earns its place by proving a
   * statement the code does not make.
   */
  it("cannot be retried while still claiming a mechanism", async () => {
    await inTenant(async (tx) => {
      const id = await queued(tx);
      expect(await claimBatch(tx, TENANT, "worker-a", 10, DUE)).not.toHaveLength(0);
      await markDelivered(tx, id, DUE, { ok: true }, "read_back");
      await tx.query("SAVEPOINT probe");
      // `markRetry` sets `state = 'pending'` and leaves `settled_by` alone, so the pairing
      // refuses it. That is correct rather than inconvenient: a row cannot be both.
      const refusal = await markRetry(tx, id, DUE, "a late retry").then(
        () => null,
        (e: unknown) => e as { constraint?: string },
      );
      await tx.query("ROLLBACK TO SAVEPOINT probe");
      expect(refusal?.constraint).toBe("outbox_delivered_records_its_mechanism");
    });
  });
});
