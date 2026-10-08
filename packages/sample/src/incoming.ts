import type { PoolClient } from "pg";

/**
 * The receiver's half of a transfer: what is on its way to me, and who else I could send to.
 *
 * Both reads exist to put a screen in front of a rep, and both are scoped the way 0025
 * scoped the sender's list — inside the SQL, against the caller's own rep id, never by
 * filtering a wider answer afterwards. The difference matters because only the receiver may
 * accept and only the sender may recall: a list that offered either action to the wrong side
 * would be a button the database refuses, and the rep would have no way to know why.
 */

/** A transfer sent TO the caller that nobody has accepted or recalled — the mirror of `RecallableTransfer`. */
export interface IncomingTransfer {
  readonly transaction_id: string;
  readonly lot_id: string;
  readonly lot_number: string;
  readonly erp_item_id: string;
  readonly expiry_date: string | null;
  readonly quantity: string;
  readonly sent_by: string;
  readonly sent_by_name: string;
  readonly occurred_at: Date;
  /** Negative for a transfer dated in the future, as an offline sync can legitimately produce. */
  readonly days_in_transit: number;
}

export async function incomingTransfers(
  tx: PoolClient,
  repProfileId: string,
): Promise<readonly IncomingTransfer[]> {
  const { rows } = await tx.query<IncomingTransfer>(
    `SELECT transaction_id, lot_id, lot_number, erp_item_id, expiry_date::text AS expiry_date,
            quantity::text AS quantity, sent_by, sent_by_name, occurred_at, days_in_transit
       FROM crm.incoming_transfers($1)`,
    [repProfileId],
  );
  return rows;
}

/** Somebody a transfer can be addressed to. */
export interface TransferPeer {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
}

/**
 * The cap, which is a screen limit rather than a rule: a picker is unusable long before
 * this, and `?q=` is how a rep in a large tenant finds a name.
 */
export const TRANSFER_PEER_LIMIT = 500;

/**
 * Who a rep may hand material to.
 *
 * THIS LIST IS DELIBERATELY AS WIDE AS THE WRITE. `crm.sample_transaction`'s
 * `counterparty_rep_profile_id` is a foreign key to `crm.rep_profile` with one further rule —
 * `counterparty_rep_profile_id <> rep_profile_id`, from 0017 — so the database accepts any
 * rep in the tenant, and RLS is what makes "in the tenant" true. Offering a narrower set
 * here (territory peers, or a manager's team) would be theatre: the route would still accept
 * anyone, so the narrowing would restrict the screen and not the system. And narrowing the
 * RULE would refuse hand-overs that really happen — a congress, a colleague covering a
 * district, a manager taking stock back off someone who is leaving.
 *
 * The one place it IS narrower is `status = 'active'`, and that is not a rule either: a
 * departed rep is someone nobody should be offered as a destination, while the write stays
 * open because material already sitting with a departed rep has to be movable by somebody.
 * Tightening the write is a question for whoever owns the departure flow; it is recorded,
 * not silently assumed here.
 *
 * The consequence is stated rather than hidden: every rep can read every active colleague's
 * display name and employee number within their own tenant. That is an internal directory,
 * which is what a transfer needs to be usable at all.
 */
export async function transferPeers(
  tx: PoolClient,
  repProfileId: string,
  opts: { readonly query?: string | null; readonly limit?: number } = {},
): Promise<readonly TransferPeer[]> {
  const q = opts.query === undefined || opts.query === null || opts.query.trim() === "" ? null : opts.query.trim();
  const limit = Math.max(1, Math.min(TRANSFER_PEER_LIMIT, opts.limit ?? TRANSFER_PEER_LIMIT));
  const { rows } = await tx.query<TransferPeer>(
    `SELECT id AS rep_profile_id, display_name, employee_number
       FROM crm.rep_profile
      WHERE status = 'active'
        AND id <> $1
        -- A substring match on either half of how a rep is known. Parameterised, and the
        -- pattern is built in SQL rather than interpolated, so a name containing % or _
        -- searches for those characters instead of becoming a wildcard.
        AND ($2::text IS NULL
             OR display_name ILIKE '%' || replace(replace($2, '%', '\\%'), '_', '\\_') || '%'
             OR employee_number ILIKE '%' || replace(replace($2, '%', '\\%'), '_', '\\_') || '%')
      ORDER BY display_name, employee_number
      LIMIT $3`,
    [repProfileId, q, limit],
  );
  return rows;
}
