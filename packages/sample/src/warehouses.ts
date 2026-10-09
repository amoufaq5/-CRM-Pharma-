import type { PoolClient } from "pg";

import { UnknownWarehouseError, WarehouseInactiveError, WarehouseListUnsyncedError } from "./errors.js";

/**
 * The ERP's warehouses, as far as the CRM is concerned: a list to address a return to, and
 * a check that a receipt names a depot that exists.
 *
 * Read out of `crm.warehouse_snapshot` (0058) and never out of the ERP directly. Not for
 * speed: a return is recorded by a device that may be offline and drained hours later, so
 * a synchronous call to the ERP inside that write would make the write's success depend on
 * the ERP being up at drain time — which is exactly what the outbox exists to avoid. The
 * snapshot is the CRM's read path for every other ERP fact for the same reason.
 *
 * The cost of that choice is stated rather than hidden: a warehouse opened at the ERP five
 * minutes ago is not yet addressable, and one closed five minutes ago is still offered.
 * `crm.snapshot_freshness` carries how old the list is, and the scheduler refreshes it
 * every five minutes.
 */

/** A depot a return can be addressed to. */
export interface Warehouse {
  readonly erp_warehouse_id: string;
  readonly code: string;
  readonly name: string;
  readonly warehouse_type: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly status: string | null;
}

/**
 * The status a warehouse must be in to receive a return.
 *
 * One value, from the ERP's `active | inactive | closed`. The comparison is against the
 * snapshot's text rather than a CHECK on an enum, so a status the ERP adds later reads as
 * "not active" — refused with a sentence naming it — instead of crashing a coercion or,
 * worse, being admitted by a `NOT IN ('inactive','closed')` test nobody updated.
 */
export const ACTIVE_WAREHOUSE_STATUS = "active";

/** A screen limit, as on `transferPeers`: a picker is unusable long before this. */
export const WAREHOUSE_LIMIT = 500;

const COLUMNS =
  "erp_warehouse_id::text AS erp_warehouse_id, code, name, warehouse_type, city, country::text AS country, status";

/**
 * The depots a return may be addressed to.
 *
 * ACTIVE ONLY, and that is the same rule the write enforces rather than a narrower screen:
 * offering a closed depot would be a button the write refuses. Inactive rows stay in the
 * table — a movement posted against a depot that later closed must still be nameable — so
 * this filters rather than the sweep deleting.
 */
export async function listWarehouses(
  tx: PoolClient,
  opts: { readonly query?: string | null; readonly limit?: number } = {},
): Promise<readonly Warehouse[]> {
  const q = opts.query === undefined || opts.query === null || opts.query.trim() === "" ? null : opts.query.trim();
  const limit = Math.max(1, Math.min(WAREHOUSE_LIMIT, opts.limit ?? WAREHOUSE_LIMIT));
  const { rows } = await tx.query<Warehouse>(
    `SELECT ${COLUMNS}
       FROM crm.warehouse_snapshot
      WHERE status = $1
        -- Matched on either the code or the long name, because a rep knows a depot by
        -- whichever is on the paperwork in front of them. The pattern is built in SQL from
        -- a bound parameter, so a name containing % or _ searches for those characters
        -- rather than becoming a wildcard.
        AND ($2::text IS NULL
             OR code ILIKE '%' || replace(replace($2, '%', '\\%'), '_', '\\_') || '%'
             OR name ILIKE '%' || replace(replace($2, '%', '\\%'), '_', '\\_') || '%')
      ORDER BY code
      LIMIT $3`,
    [ACTIVE_WAREHOUSE_STATUS, q, limit],
  );
  return rows;
}

/**
 * Resolves the warehouse a movement is posted against, or refuses the movement.
 *
 * A CHECK AT THE MOMENT OF THE WRITE, deliberately, and not a foreign key — 0058 gives the
 * reason at length: the snapshot's rows can be retracted by a full sweep when the ERP drops
 * a warehouse, and the append-only ledger must not depend referentially on a table another
 * system can empty. So the movement keeps whatever id it was written with, for ever, and
 * this answers only "may it be written now".
 *
 * Three refusals rather than one, because they want three different answers from a client:
 *
 * - NO LIST AT ALL is an integration state, not the caller's mistake: the snapshot has
 *   never synced for this tenant, so no id could possibly be valid. 503 and "try later",
 *   never 422 — telling a rep their warehouse id is wrong when the CRM simply has not
 *   fetched the list yet would send them looking for a typo that is not there.
 * - AN UNKNOWN ID is the caller's: 422, and the device should pick from the list.
 * - A KNOWN BUT INACTIVE depot is a conflict: the request is well formed and the
 *   warehouse's own state refuses it. The sentence names the status, so "closed" and
 *   "inactive" are distinguishable by whoever reads it.
 *
 * Failing closed on an unsynced list is the whole point and is worth being explicit about:
 * the tempting alternative — accept anything while the list is empty — is the shape of
 * validation that silently stops validating exactly when the integration is unhealthy.
 */
export async function requireActiveWarehouse(
  tx: PoolClient,
  erpWarehouseId: string,
): Promise<Warehouse> {
  const { rows } = await tx.query<Warehouse>(
    `SELECT ${COLUMNS} FROM crm.warehouse_snapshot WHERE erp_warehouse_id = $1`,
    [erpWarehouseId],
  );
  const found = rows[0];
  if (found === undefined) {
    // Only asked when the lookup missed, so the common path stays one primary-key hit.
    const { rows: probe } = await tx.query<{ known: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM crm.warehouse_snapshot) AS known`,
    );
    if (probe[0]?.known !== true) {
      throw new WarehouseListUnsyncedError(
        "this CRM has no list of ERP warehouses yet, so it cannot tell whether " +
          `${erpWarehouseId} is one — the list syncs from the ERP and this tenant's copy is empty`,
      );
    }
    throw new UnknownWarehouseError(`no ERP warehouse ${erpWarehouseId} in this tenant's list`);
  }
  if (found.status !== ACTIVE_WAREHOUSE_STATUS) {
    throw new WarehouseInactiveError(
      `warehouse ${found.code} is ${found.status ?? "of unknown status"}, not active, so stock cannot be sent there`,
    );
  }
  return found;
}
