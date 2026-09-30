import type { ErpClient } from "@crm/acl";
import type { OutboxRow } from "./store.js";

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
 * The `Idempotency-Key` for a row.
 *
 * Derived from the row's own identity so a retry of the SAME row reuses it while
 * a different row never collides. Belt and braces only: the real dedup is the
 * ERP's `(tenant_id, entity, record_id)` unique constraint, because the
 * deployed gateway's idempotency store is in-memory, dies on restart and does
 * not span instances (report R6).
 */
export function idempotencyKeyFor(row: OutboxRow): string {
  return `crm-${row.id}`;
}

/**
 * Performs one outbox row against the ERP.
 *
 * The client-minted `target_record_id` is sent as the record's `id` on create,
 * which is what makes a redelivery collapse into a unique violation the
 * classifier reads as success rather than creating a duplicate.
 */
export async function dispatch(
  client: ErpClient,
  row: OutboxRow,
): Promise<{ readonly response: unknown; readonly isTransition: boolean }> {
  const op = parseOperation(row.operation);
  const key = idempotencyKeyFor(row);

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
}
