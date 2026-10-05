import {
  TargetAlreadyPresentError,
  TargetConfirmedAbsentError,
  isAmbiguousWriteFailure,
} from "./outcome.js";
import { probeTargetRecord, type ProbeReader } from "./probe.js";
import type { OutboxRow } from "./store.js";

/**
 * The ERP capabilities one outbox row needs.
 *
 * Structural rather than `ErpClient` itself so this module's decisions can be
 * tested without a server, a socket or a schema fetch. `ErpClient` satisfies it,
 * and `get` is already one of its methods — the probe below needed no new ACL
 * method.
 */
export interface ErpWriteTarget extends ProbeReader {
  create(
    tenantId: string,
    entity: string,
    record: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  update(tenantId: string, entity: string, id: string, patch: Record<string, unknown>): Promise<unknown>;
  transition(
    tenantId: string,
    entity: string,
    id: string,
    transition: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
}

/**
 * An outbox row's `operation`: `create`, `update`, or `transition:<name>`.
 *
 * Parsed rather than assumed, so a malformed operation is a clean dead-letter
 * with a readable reason instead of an undefined method call at 3am.
 */
export type ParsedOperation =
  | { readonly kind: "create" }
  | { readonly kind: "update" }
  | { readonly kind: "transition"; readonly name: string };

export class UnknownOperationError extends Error {
  constructor(operation: string) {
    super(`unknown outbox operation ${JSON.stringify(operation)} (expected create, update, or transition:<name>)`);
    this.name = "UnknownOperationError";
  }
}

export function parseOperation(operation: string): ParsedOperation {
  if (operation === "create") return { kind: "create" };
  if (operation === "update") return { kind: "update" };
  const m = /^transition:([A-Za-z_][A-Za-z0-9_]*)$/.exec(operation);
  if (m !== null) return { kind: "transition", name: m[1]! };
  throw new UnknownOperationError(operation);
}

/**
 * The `Idempotency-Key` for one DISPATCH EPISODE of a row.
 *
 * Derived from the row's identity so a retry within an episode reuses it, and from
 * `revive_count` so a REVIVE does not. Belt and braces either way: the real dedup is the
 * ERP's `(tenant_id, entity, record_id)` unique constraint over an id the CRM minted
 * itself, because the deployed gateway's idempotency store is in-memory, dies on restart
 * and does not span instances (report R6).
 *
 * THE REVIVE COUNT IS NOT COSMETIC, and the live gate is why it is here. The key used to
 * be `crm-<row id>` for the life of the row, so a revived row re-sent its write under the
 * key the ERP had already answered — and the gateway replayed its stored answer, which it
 * keeps the STATUS of and not the body (section 4's measured fact, the same one that makes
 * a replayed 201 arrive empty). So a second death's reason was not the ERP's reason at all:
 * a 422 came back bodiless, failed both error parses, and the history recorded
 * `rejected: unrecognised_error_shape` where the first episode had recorded
 * `validation_failed: request_number is required`. The operator who pressed retry was told
 * LESS than before they pressed it, and `is_repeat_of_previous` called an identical cause a
 * new one — the exact question `crm.outbox_dead_letter` exists to answer, answered wrongly.
 *
 * A revive is a request for the ERP's answer NOW, on the premise that the cause was fixed.
 * Replaying the old answer makes that unanswerable, so each episode asks in its own name.
 * Nothing is risked by it: if the earlier attempt actually landed, the collision is on the
 * record id and `classify` settles it `already_delivered` — proved against the live server
 * with the driver message removed (6h). The key only ever saved a round trip.
 */
export function idempotencyKeyFor(row: OutboxRow): string {
  return `crm-${row.id}-r${row.revive_count}`;
}

/**
 * Whether reading `row.target_record_id` back answers "did this write land".
 *
 * Only for a `create`. The id is one WE minted — `crm-exp-<claim id>`,
 * `crm-<uuidv7>` — deterministically from the CRM row that produced the write, so
 * nothing else in either system can mint it and "the ERP holds it" means "my write
 * landed", exactly.
 *
 * An `update` is the trap. Its record existed before the write, so existence is
 * true whether or not the patch applied, and a probe that confirmed it would be
 * reporting an unrelated fact as a delivery. (It also has no need of one: a
 * redelivered PATCH carries the same body and is idempotent, so the expensive
 * direction — a landed write dead-lettered at the cap — does not arise.)
 *
 * A `transition` is the same trap plus a second one: what matters there is the
 * record's STATE, not its existence, and the ERP already answers that precisely —
 * `invalid_transition`, which classifies as `retry_ordering` so the sibling row
 * ahead of it can land.
 */
export function probeAnswersDelivery(op: ParsedOperation): boolean {
  return op.kind === "create";
}

/**
 * Performs one outbox row against the ERP.
 *
 * The client-minted `target_record_id` is sent as the record's `id` on create,
 * which is what makes a redelivery collapse into a unique violation — and what
 * makes the record readable by a known id afterwards, which is the whole basis of
 * the disambiguation below.
 *
 * Throws on failure, as before, having first made that failure as unambiguous as
 * it can: `dispatch` disambiguates, `classify` classifies. The error it raises is
 * therefore sometimes one of ours rather than the ERP's — see
 * `TargetAlreadyPresentError`.
 */
export async function dispatch(
  client: ErpWriteTarget,
  row: OutboxRow,
): Promise<{ readonly response: unknown; readonly isTransition: boolean }> {
  // Outside the try on purpose: a malformed operation has not touched the ERP, so
  // it must not reach the probe path and spend a read deciding nothing.
  const op = parseOperation(row.operation);
  const key = idempotencyKeyFor(row);

  try {
    switch (op.kind) {
      case "create": {
        const response = await client.create(
          row.tenant_id,
          row.entity,
          { ...row.payload, id: row.target_record_id },
          key,
        );
        return { response, isTransition: false };
      }
      case "update": {
        const response = await client.update(row.tenant_id, row.entity, row.target_record_id, row.payload);
        return { response, isTransition: false };
      }
      case "transition": {
        const response = await client.transition(
          row.tenant_id,
          row.entity,
          row.target_record_id,
          op.name,
          row.payload,
          key,
        );
        return { response, isTransition: true };
      }
    }
  } catch (writeError) {
    throw await disambiguate(client, row, op, writeError);
  }
}

/**
 * Turns an ambiguous write failure into one that states what happened to the
 * record, by asking the ERP.
 *
 * WHY THIS EXISTS. A redelivery of a write that already landed must read as
 * success, or the relay retries to the cap and raises `erp_write_failed` at a rep
 * for a write the ERP already holds. Against a live operate-server a duplicate
 * record id answers `500 {"error":"write_failed","detail":"duplicate key value
 * violates unique constraint …"}` — the node-postgres message forwarded verbatim —
 * which normalises to `unavailable`, not `conflict`, so the only thing that
 * settled it was a regex over that sentence. A platform that stopped leaking the
 * driver message, which is ordinary hardening nobody would think to announce,
 * would have broken the guarantee silently and in the expensive direction.
 *
 * The deterministic target id is the asset that closes it: on an ambiguous
 * failure the relay can ASK whether the record is there, and settle on the answer
 * instead of on a string.
 *
 * Returns the error to raise, never throws: a failure to CHECK must not become a
 * worse outcome than the failure it was checking.
 */
async function disambiguate(
  client: ErpWriteTarget,
  row: OutboxRow,
  op: ParsedOperation,
  writeError: unknown,
): Promise<unknown> {
  if (!probeAnswersDelivery(op)) return writeError;
  if (!isAmbiguousWriteFailure(writeError)) return writeError;

  const verdict = await probeTargetRecord(
    client,
    { tenantId: row.tenant_id, entity: row.entity, recordId: row.target_record_id },
  );

  switch (verdict.kind) {
    case "present":
      return new TargetAlreadyPresentError(row.target_record_id, writeError);
    case "absent":
      return new TargetConfirmedAbsentError(row.target_record_id, writeError);
    case "unknown":
      // The probe is itself a request, and it can fail for the same reasons the
      // write did. When it cannot answer, the original failure is raised UNCHANGED
      // — so the `ALREADY_EXISTS` fallback still gets its chance, and a row whose
      // fate is genuinely unknown stays pending and is retried. Dead-lettering on a
      // failure to check would turn an ERP outage into lost writes, which is the
      // opposite of what this function is for.
      return writeError;
  }
}
