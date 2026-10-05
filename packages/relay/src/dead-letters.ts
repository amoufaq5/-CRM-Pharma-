import type { PoolClient } from "pg";
import { raiseForSupervisors, raiseNotification } from "@crm/notify";

/**
 * Dead letters: telling someone, and the way back.
 *
 * A dead outbox row is a write the ERP will never accept. The CRM recorded it, the rep's
 * app showed it as recorded — because in the CRM it IS — and the half they cannot see never
 * landed. Until now nothing said so.
 */

export interface DeadLetter {
  readonly id: string;
  readonly entity: string;
  readonly operation: string;
  readonly target_record_id: string;
  readonly source_table: string;
  readonly source_id: string;
  readonly rep_profile_id: string | null;
  readonly display_name: string | null;
  readonly attempts: number;
  readonly revive_count: number;
  readonly dead_at: Date | null;
  readonly dead_reason: string | null;
  readonly created_at: Date;
}

export interface DeadLetterAlarm {
  /** Null when the producing table is not mapped to a rep — see `crm.outbox_recipient`. */
  readonly repProfileId: string | null;
  readonly notified: number;
}

/**
 * Raises the alarm for a row that has just been dead-lettered.
 *
 * Called from the relay's settle step, inside the same transaction as the state change, so
 * there is no window in which a write is dead and nobody was told.
 *
 * Goes to the rep AND up the hierarchy. The rep needs to know their write did not land; the
 * supervisor needs to know because most of the reasons a write dies permanently — a missing
 * ledger account, a permission not granted, a parent record that does not exist — are not
 * things the rep can fix.
 *
 * Returns the resolved rep (null when the producing table is unmapped) so the caller can
 * count what it could not attribute rather than assuming it told someone.
 */
export async function raiseDeadLetterAlarm(
  tx: PoolClient,
  tenantId: string,
  row: {
    readonly id: string;
    readonly entity: string;
    readonly operation: string;
    readonly source_table: string;
    readonly source_id: string;
  },
  reason: string,
): Promise<DeadLetterAlarm> {
  const { rows } = await tx.query<{ rep_profile_id: string | null; revive_count: number }>(
    `SELECT crm.outbox_recipient($1, $2) AS rep_profile_id,
            COALESCE((SELECT revive_count FROM crm.outbox WHERE id = $3), 0) AS revive_count`,
    [row.source_table, row.source_id, row.id],
  );
  const repProfileId = rows[0]?.rep_profile_id ?? null;
  if (repProfileId === null) {
    // Cannot attribute. The dead letter is still visible through
    // crm.dead_outbox_letters — which lists unattributed rows precisely because nobody was
    // notified about them — and the relay counts it.
    return { repProfileId: null, notified: 0 };
  }

  const reviveCount = rows[0]?.revive_count ?? 0;
  const what = `${row.operation} ${row.entity}`;
  const detail = {
    kind: "erp_write_failed",
    // A revived row that dies again IS news, so the count is in the key. Without it the
    // second death would be silently deduped against the first.
    dedupKey: `outbox:${row.id}:dead:${reviveCount}`,
    subjectTable: "crm.outbox",
    subjectId: row.id,
    payload: {
      entity: row.entity,
      operation: row.operation,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      reason: reason.slice(0, 500),
      reviveCount,
    },
  } as const;

  await raiseNotification(tx, tenantId, {
    ...detail,
    recipientRepProfileId: repProfileId,
    // Urgent for the rep: they are the one who believes this already happened.
    severity: "urgent",
    subject: `Not recorded in the ERP: ${what}`,
    body:
      `A ${what} you made was refused by the ERP and will not be retried automatically. ` +
      `It is saved here, so nothing is lost — but the ERP does not have it. Reason: ${reason.slice(0, 300)}`,
  });

  const escalations = await raiseForSupervisors(tx, tenantId, repProfileId, {
    ...detail,
    severity: "warning",
    subject: `A rep's ERP write failed permanently: ${what}`,
    body:
      `A ${what} from one of your reps was refused by the ERP and will not retry. ` +
      `Most causes are configuration on the ERP side; once fixed the write can be retried. ` +
      `Reason: ${reason.slice(0, 300)}`,
  });

  return { repProfileId, notified: 1 + escalations.length };
}

/** Dead letters for one rep, or every one in the tenant when no rep is given. */
export async function deadLetters(
  tx: PoolClient,
  opts: { repProfileId?: string | null; limit?: number } = {},
): Promise<readonly DeadLetter[]> {
  const { rows } = await tx.query<DeadLetter>(
    `SELECT id, entity, operation, target_record_id, source_table, source_id,
            rep_profile_id, display_name, attempts, revive_count, dead_at, dead_reason, created_at
       FROM crm.dead_outbox_letters($1, $2)`,
    [opts.repProfileId ?? null, opts.limit ?? 100],
  );
  return rows;
}

/**
 * One dead letter by id, with its resolved rep.
 *
 * A targeted lookup rather than scanning the list: a route authorising a retry needs this
 * one row, and filtering a page of five hundred in TypeScript to find it would be both
 * wasteful and a quiet cap on which rows can be retried at all.
 */
export async function deadLetter(tx: PoolClient, id: string): Promise<DeadLetter | null> {
  const { rows } = await tx.query<DeadLetter>(
    `SELECT o.id, o.entity, o.operation, o.target_record_id::text AS target_record_id,
            o.source_table, o.source_id,
            crm.outbox_recipient(o.source_table, o.source_id) AS rep_profile_id,
            rp.display_name, o.attempts, o.revive_count, o.dead_at, o.dead_reason, o.created_at
       FROM crm.outbox o
       LEFT JOIN crm.rep_profile rp
              ON rp.id = crm.outbox_recipient(o.source_table, o.source_id)
      WHERE o.id = $1 AND o.state = 'dead'`,
    [id],
  );
  return rows[0] ?? null;
}

/** Dead letters across a manager's team, scoped in SQL by `crm.managed_rep_ids`. */
export async function teamDeadLetters(
  tx: PoolClient,
  managerRepProfileId: string,
  opts: { limit?: number } = {},
): Promise<readonly DeadLetter[]> {
  const { rows } = await tx.query<DeadLetter>(
    `SELECT d.* FROM crm.dead_outbox_letters(NULL, $2) d
      WHERE d.rep_profile_id IN (
              SELECT rep_profile_id FROM crm.managed_rep_ids($1, CURRENT_DATE)
            )`,
    [managerRepProfileId, opts.limit ?? 100],
  );
  return rows;
}

/**
 * Who a queue row belongs to, WHATEVER STATE IT IS IN.
 *
 * `deadLetter` carries `state = 'dead'` in its WHERE clause, which is right for a retry —
 * there is nothing to revive otherwise — and wrong for reading a death history. A history
 * exists precisely because a row died, and the interesting histories are the ones whose
 * row then got revived and delivered: predicating the lookup on `dead` would make the
 * record unreadable at the exact moment it became worth reading.
 *
 * So this answers the authorisation question on its own, with no state predicate, and the
 * route decides what to do with the state rather than being silently denied by it.
 *
 * Returns null when there is no such row in this tenant — which, under RLS, also covers
 * another tenant's id. Note that `crm.outbox_dead_letter` deliberately carries no foreign
 * key to `crm.outbox` (0036), so a history can outlive its queue row; when it has, this
 * returns null and the per-row history is unreachable for a rep. That is the fail-closed
 * reading and it is deliberate: an orphaned history cannot be attributed to anybody, so
 * nobody but an administrator has a claim on it, and the tenant-wide listing is how they
 * reach it.
 */
export interface OutboxLetterOwner {
  readonly id: string;
  readonly state: string;
  /** Null when the producing table is not mapped to a rep — see `crm.outbox_recipient`. */
  readonly rep_profile_id: string | null;
  readonly revive_count: number;
}

export async function outboxLetterOwner(
  tx: PoolClient,
  id: string,
): Promise<OutboxLetterOwner | null> {
  const { rows } = await tx.query<OutboxLetterOwner>(
    `SELECT o.id, o.state,
            crm.outbox_recipient(o.source_table, o.source_id) AS rep_profile_id,
            o.revive_count
       FROM crm.outbox o
      WHERE o.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export class DeadLetterNotFoundError extends Error {
  constructor(id: string) {
    super(`no dead outbox letter ${id}`);
    this.name = "DeadLetterNotFoundError";
  }
}

/**
 * Puts a dead letter back in the queue.
 *
 * Worth being clear about what this does and does not fix. It re-sends the SAME payload:
 * useful when the ERP side has changed — a ledger account created, a permission granted, a
 * parent record that now exists — and useless when the payload itself is wrong, in which
 * case it will die again and `revive_count` will say so. It is not an edit.
 */
export async function reviveDeadLetter(
  tx: PoolClient,
  id: string,
  revivedBy: string,
  now = new Date(),
): Promise<boolean> {
  const { rows } = await tx.query<{ revived: boolean }>(
    `SELECT crm.revive_outbox_letter($1, $2, $3) AS revived`,
    [id, revivedBy, now],
  );
  return rows[0]?.revived === true;
}
