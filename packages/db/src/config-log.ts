import type { PoolClient } from "pg";

/**
 * Reading the configuration log (0061).
 *
 * Here rather than in a domain package because the log is not one domain's: the same table
 * records the notification horizons, the prune guard and the expense account map, and a reader
 * asking "what changed in this tenant's configuration" is asking one question across all of
 * them. The writer lives one file over, in `attribution.ts`.
 */

export interface ConfigChange {
  readonly id: string;
  readonly table_name: string;
  readonly row_key: Record<string, unknown>;
  readonly action: "created" | "amended";
  readonly changed_at: Date;
  readonly changed_by: string;
  readonly changed_by_name: string;
  readonly reason: string;
  readonly changed_columns: readonly string[];
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
}

export const CONFIG_LOG_LIMIT = 200;

/**
 * A tenant's configuration changes, newest first, optionally for one table.
 *
 * `table` is matched against the bare name as `crm.config_change` stores it, and is NOT
 * validated against the catalog: an unknown name returns nothing, which is the honest answer
 * for a table that has never been changed and for one that does not exist alike. Validating it
 * would mean teaching this read which tables are under attribution, which is a list that
 * belongs in the schema and already is one.
 */
export async function configChanges(
  tx: PoolClient,
  tenantId: string,
  opts: { readonly table?: string | null; readonly limit?: number } = {},
): Promise<readonly ConfigChange[]> {
  const table = opts.table === undefined || opts.table === null || opts.table.trim() === "" ? null : opts.table.trim();
  const limit = Math.max(1, Math.min(CONFIG_LOG_LIMIT, opts.limit ?? 50));
  const { rows } = await tx.query<ConfigChange>(
    `SELECT c.id::text AS id, c.table_name, c.row_key, c.action, c.changed_at,
            c.changed_by::text AS changed_by, r.display_name AS changed_by_name,
            c.reason, c.changed_columns, c.before, c.after
       FROM crm.config_change c
       -- An INNER join that cannot hide a row: the composite key to crm.rep_profile is ON
       -- DELETE RESTRICT, so an author named by a record cannot be deleted while it exists,
       -- and RLS shows the caller every profile in their own tenant.
       JOIN crm.rep_profile r ON r.id = c.changed_by
      WHERE c.tenant_id = $1 AND ($2::text IS NULL OR c.table_name = $2)
      -- Newest first, and deterministically: changed_at is clock_timestamp() rather than
      -- now(), so two changes written in one transaction do not tie.
      ORDER BY c.changed_at DESC, c.id DESC
      LIMIT $3`,
    [tenantId, table, limit],
  );
  return rows;
}
