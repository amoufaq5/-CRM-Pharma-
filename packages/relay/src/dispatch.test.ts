import { describe, expect, it } from "vitest";
import { ErpError } from "@crm/acl";

import {
  dispatch,
  idempotencyKeyFor,
  parseOperation,
  probeAnswersDelivery,
  UnknownOperationError,
  type ErpWriteTarget,
} from "./dispatch.js";
import { TargetAlreadyPresentError, TargetConfirmedAbsentError, classify } from "./outcome.js";
import type { OutboxRow } from "./store.js";

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "0d1c1e2f-0000-4000-8000-000000000001",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  entity: "Item",
  operation: "create",
  payload: {},
  target_record_id: "crm_abc",
  source_table: "crm.expense_claim",
  source_id: "0d1c1e2f-0000-4000-8000-000000000002",
  attempts: 0,
  revive_count: 0,
  ...over,
});

describe("parseOperation", () => {
  it("reads create, update and a named transition", () => {
    expect(parseOperation("create")).toEqual({ kind: "create" });
    expect(parseOperation("update")).toEqual({ kind: "update" });
    expect(parseOperation("transition:mark_paid")).toEqual({ kind: "transition", name: "mark_paid" });
  });

  it.each(["", "delete", "transition:", "transition:bad-name", "transition:1abc", "CREATE"])(
    "refuses %s rather than failing later as an undefined method call",
    (op) => {
      expect(() => parseOperation(op)).toThrow(UnknownOperationError);
    },
  );
});

describe("idempotencyKeyFor", () => {
  it("is stable within an episode, so a retry of the same attempt reuses it", () => {
    expect(idempotencyKeyFor(row())).toBe(idempotencyKeyFor(row()));
    // `attempts` moves inside one episode and must NOT move the key: a worker that died
    // after sending and before settling has to be deduped by the gateway.
    expect(idempotencyKeyFor(row({ attempts: 4 }))).toBe(idempotencyKeyFor(row({ attempts: 1 })));
  });

  it("differs between rows, so distinct writes never collide", () => {
    expect(idempotencyKeyFor(row())).not.toBe(
      idempotencyKeyFor(row({ id: "0d1c1e2f-0000-4000-8000-000000000009" })),
    );
  });

  /**
   * The live gate caught this one. Under a reused key the ERP replays its earlier answer,
   * whose body it does not keep — so a revived row's second refusal came back bodiless and
   * was recorded as `rejected: unrecognised_error_shape` instead of the ERP's own sentence.
   * A revive asks what the ERP says NOW; it has to ask in its own name.
   */
  it("CHANGES across a revive, so the ERP answers again instead of replaying", () => {
    expect(idempotencyKeyFor(row({ revive_count: 1 }))).not.toBe(idempotencyKeyFor(row()));
    expect(idempotencyKeyFor(row({ revive_count: 2 }))).not.toBe(
      idempotencyKeyFor(row({ revive_count: 1 })),
    );
  });
});

/** The live duplicate-key 500, byte for byte (`handlers.ts` forwards `e.message`). */
const liveDuplicate = (): ErpError =>
  new ErpError(
    "unavailable",
    500,
    "write_failed",
    'duplicate key value violates unique constraint "operate_entity_records_tenant_entity_record_key"',
    null,
  );

/** The same answer from a platform that stopped leaking the driver message. */
const silentDuplicate = (): ErpError =>
  new ErpError("unavailable", 500, "write_failed", undefined, null);

interface Recorded {
  readonly writes: string[];
  readonly probes: Array<readonly [string, string, string]>;
}

/**
 * An ERP whose write always fails with `writeError` and whose read answers
 * `readAnswer`.
 *
 * The write and the read are scripted separately on purpose: every claim below is
 * about which of the two the code chose to make.
 */
function scripted(input: {
  readonly writeError?: unknown;
  readonly writeResponse?: unknown;
  readonly readAnswer?: () => Promise<unknown>;
}): { client: ErpWriteTarget; recorded: Recorded } {
  const recorded: Recorded = { writes: [], probes: [] };
  const write = (label: string): Promise<unknown> => {
    recorded.writes.push(label);
    if (input.writeError !== undefined) return Promise.reject(input.writeError);
    return Promise.resolve(input.writeResponse ?? { id: "crm_abc" });
  };
  const client: ErpWriteTarget = {
    create: () => write("create"),
    update: () => write("update"),
    transition: (_t, _e, _id, name) => write(`transition:${name}`),
    get: (tenantId, entity, id) => {
      recorded.probes.push([tenantId, entity, id]);
      return (input.readAnswer ?? (() => Promise.resolve(null)))();
    },
  };
  return { client, recorded };
}

async function raised(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    throw new Error("dispatch resolved, but the test expected it to throw");
  } catch (err) {
    return err;
  }
}

describe("probeAnswersDelivery", () => {
  // The id is ours only for a create. On an update the record existed beforehand,
  // so existence is true whether or not the patch applied; on a transition what
  // matters is the state, which `invalid_transition` already answers precisely.
  it("is true for a create and false for everything else", () => {
    expect(probeAnswersDelivery({ kind: "create" })).toBe(true);
    expect(probeAnswersDelivery({ kind: "update" })).toBe(false);
    expect(probeAnswersDelivery({ kind: "transition", name: "approve" })).toBe(false);
  });
});

describe("dispatch sends the row", () => {
  it("puts the client-minted target id in the create payload", async () => {
    let sent: Record<string, unknown> | null = null;
    const client: ErpWriteTarget = {
      create: (_t, _e, record) => {
        sent = record;
        return Promise.resolve({ id: "crm_abc" });
      },
      update: () => Promise.resolve(null),
      transition: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    };
    const out = await dispatch(client, row({ payload: { sku: "A" } }));
    expect(out.isTransition).toBe(false);
    expect(sent).toEqual({ sku: "A", id: "crm_abc" });
  });

  it("reports a transition as one, which is what `classify` branches on", async () => {
    const { client } = scripted({ writeResponse: { id: "crm_abc" } });
    expect((await dispatch(client, row({ operation: "transition:approve" }))).isTransition).toBe(true);
  });

  it("does not read anything back when the write SUCCEEDS", async () => {
    const { client, recorded } = scripted({ writeResponse: { id: "crm_abc" } });
    await dispatch(client, row());
    expect(recorded.probes).toEqual([]);
  });
});

describe("an ambiguous create is settled by reading the record back", () => {
  it("raises `already delivered` when the ERP holds the record — with NO driver text to go on", async () => {
    // The headline case. Status and code identical to the live duplicate answer, the
    // leaked sentence gone, and the write still settles — because the relay asked.
    const { client, recorded } = scripted({
      writeError: silentDuplicate(),
      readAnswer: () => Promise.resolve({ id: "crm_abc", state: "draft" }),
    });
    const err = await raised(dispatch(client, row()));

    expect(err).toBeInstanceOf(TargetAlreadyPresentError);
    expect(classify({ error: err, isTransition: false }).kind).toBe("already_delivered");
    // The control: the probe really was the mechanism, and it asked for OUR id.
    expect(recorded.probes).toEqual([[row().tenant_id, "Item", "crm_abc"]]);
  });

  it("raises `confirmed absent` when the ERP does not hold it, so the row retries instead of settling", async () => {
    // NON-VACUITY: the write error carries the duplicate-key sentence, so without the
    // probe's answer this classifies `already_delivered` (asserted below). A pass here
    // therefore requires the absence verdict to have been produced AND to have won.
    const writeError = liveDuplicate();
    expect(classify({ error: writeError, isTransition: false }).kind).toBe("already_delivered");

    const { client, recorded } = scripted({ writeError, readAnswer: () => Promise.resolve(null) });
    const err = await raised(dispatch(client, row()));

    expect(err).toBeInstanceOf(TargetConfirmedAbsentError);
    expect(classify({ error: err, isTransition: false }).kind).toBe("retry_transient");
    expect(recorded.probes).toHaveLength(1);
  });

  it("probes a timeout and a reset too — the write may have landed and the answer been lost", async () => {
    for (const writeError of [
      new ErpError("unavailable", 504, "client_timeout", "POST /v1/items exceeded 15000ms", null),
      new Error("ECONNRESET"),
    ]) {
      const { client, recorded } = scripted({
        writeError,
        readAnswer: () => Promise.resolve({ id: "crm_abc" }),
      });
      const err = await raised(dispatch(client, row()));
      expect(recorded.probes).toHaveLength(1);
      expect(classify({ error: err, isTransition: false }).kind).toBe("already_delivered");
    }
  });
});

describe("a probe that cannot answer changes nothing", () => {
  it("raises the ORIGINAL error untouched, leaving the regex its fallback", async () => {
    const writeError = liveDuplicate();
    const { client, recorded } = scripted({
      writeError,
      readAnswer: () => Promise.reject(new ErpError("unavailable", 503, "service_unavailable", "down", null)),
    });
    const err = await raised(dispatch(client, row()));

    // Identity, not shape: nothing was wrapped, re-coded or re-worded, so every
    // classification downstream behaves exactly as it did before this increment.
    expect(err).toBe(writeError);
    expect(classify({ error: err, isTransition: false }).kind).toBe("already_delivered");
    expect(recorded.probes).toHaveLength(1);
  });

  it("leaves the row PENDING rather than dead when neither the probe nor the text can say", async () => {
    // The honest outcome of a failure to CHECK: retry. Dead-lettering here would turn
    // an ERP outage into lost writes, which is the opposite of the point.
    const { client } = scripted({
      writeError: silentDuplicate(),
      readAnswer: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const out = classify({ error: await raised(dispatch(client, row())), isTransition: false });
    expect(out.kind).toBe("retry_transient");
    expect(out.kind).not.toBe("dead");
  });

  it("does not probe the probe", async () => {
    let reads = 0;
    const { client } = scripted({
      writeError: silentDuplicate(),
      readAnswer: () => {
        reads += 1;
        return Promise.reject(new Error("ECONNRESET"));
      },
    });
    await raised(dispatch(client, row()));
    expect(reads).toBe(1);
  });
});

describe("what dispatch refuses to probe", () => {
  it.each([
    ["an update, whose record existed before the write", "update"],
    ["a transition, where the state is the question and existence is not", "transition:approve"],
  ])("does not read anything back for %s", async (_label, operation) => {
    const { client, recorded } = scripted({ writeError: silentDuplicate() });
    const err = await raised(dispatch(client, row({ operation })));
    expect(recorded.probes).toEqual([]);
    expect(err).toBeInstanceOf(ErpError);
  });

  it("leaves an out-of-order transition on its existing ordering path", async () => {
    // Last increment's fix, which the probe must not disturb: the ERP's answer here is
    // precise, and existence would tell us nothing it did not already say.
    const { client, recorded } = scripted({
      writeError: new ErpError("conflict", 409, "invalid_transition", "'approve' cannot fire from 'draft'", null),
    });
    const out = classify({
      error: await raised(dispatch(client, row({ operation: "transition:approve" }))),
      isTransition: true,
    });
    expect(out.kind).toBe("retry_ordering");
    expect(recorded.probes).toEqual([]);
  });

  it.each([
    ["422, a payload the ERP rejected", new ErpError("validation_failed", 422, "validation_failed", "request_number is required", null)],
    ["403, a role we do not hold", new ErpError("forbidden", 403, "forbidden", "role may not post", null)],
    ["404, a route that does not exist", new ErpError("not_found", 404, "not_found", undefined, null)],
    ["429, a rate limit", new ErpError("rate_limited", 429, "too_many_requests", undefined, null)],
    ["409, which the cheap existing branch already settles", new ErpError("conflict", 409, "conflict_idempotency_mismatch", undefined, null)],
  ])("spends no read on a create that failed %s", async (_label, writeError) => {
    const { client, recorded } = scripted({ writeError });
    await raised(dispatch(client, row()));
    expect(recorded.probes).toEqual([]);
  });

  it("spends no read, and no write, on a malformed operation", async () => {
    const { client, recorded } = scripted({ writeError: silentDuplicate() });
    await expect(dispatch(client, row({ operation: "obliterate" }))).rejects.toThrow(UnknownOperationError);
    expect(recorded.writes).toEqual([]);
    expect(recorded.probes).toEqual([]);
  });
});
