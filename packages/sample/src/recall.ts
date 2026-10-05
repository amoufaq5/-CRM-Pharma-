import { raiseNotification } from "@crm/notify";
import type { PoolClient } from "pg";

import { translateSampleError } from "./errors.js";
import { getTransaction, type SampleTransaction, type TransactionKind } from "./store.js";

/**
 * Taking back a transfer nobody accepted.
 *
 * A `transfer_out` parks the quantity in the sender's `quantity_in_transit`, where it
 * stayed forever if the receiver never accepted it (ADR-0001: "A transfer that is never
 * accepted leaves material in `quantity_in_transit` indefinitely"). A recall is the way
 * out: a new ledger row of kind `transfer_recall`, pointing at the original, which puts
 * the quantity back in the sender's bag.
 *
 * It is a MOVEMENT, not a correction of the transfer. The ledger is append-only, so the
 * `transfer_out` stays exactly as recorded and the recall sits next to it — which is what
 * makes "we sent these and took them back" readable afterwards. An `adjustment_in` would
 * have been the wrong tool twice over: it carries no link to the transfer, and it only
 * touches `quantity_on_hand`, so the rep would end up holding the material and still
 * showing it in transit.
 *
 * Every rule is in 0025, in the same trigger as the acceptance rules, because the
 * interactive path and the offline-sync path must enforce one set.
 */

/** `store.ts`'s kinds plus the one 0025 adds. */
/**
 * Kept as a name for the recall kind specifically. `TransactionKind` in `store.ts` now
 * covers it, so this is no longer a widening — it reads at a call site that only ever
 * means a recall.
 */
export type RecallTransactionKind = Extract<TransactionKind, "transfer_recall">;

export interface TransferRecall extends Omit<SampleTransaction, "kind"> {
  readonly kind: "transfer_recall";
}

/** A transfer the caller sent that still has no terminal event, with what a screen needs to show it. */
export interface RecallableTransfer {
  readonly transaction_id: string;
  readonly lot_id: string;
  readonly lot_number: string;
  readonly erp_item_id: string;
  readonly expiry_date: string | null;
  readonly quantity: string;
  readonly sent_to: string;
  readonly sent_to_name: string;
  readonly occurred_at: Date;
  /** Negative for a transfer dated in the future, as an offline sync can legitimately produce. */
  readonly days_in_transit: number;
}

const RECALL_COLUMNS =
  "id, lot_id, rep_profile_id, kind, quantity::text AS quantity, " +
  "erp_account_id::text AS erp_account_id, erp_contact_id::text AS erp_contact_id, visit_id, " +
  "recipient_name, signature_sha256, erp_warehouse_id::text AS erp_warehouse_id, " +
  "counterparty_rep_profile_id, transfer_of, reason, occurred_at, recorded_at";

/**
 * The sender takes back a transfer nobody accepted.
 *
 * `repProfileId` is the caller — their own id, from the token, never read off the
 * transfer. Deriving it would make a recall by the wrong rep succeed silently, and
 * "recorded by the sender" is the rule that separates a recall from a receiver refusing
 * delivery. The database refuses the mismatch; this passes it through so it can.
 *
 * The lot, the quantity and the receiver ARE read off the transfer, like an acceptance
 * does, because all three must equal what was sent and the database would refuse them
 * anyway — reading them here removes the chance to get them wrong.
 */
export async function recallTransfer(
  tx: PoolClient,
  tenantId: string,
  input: {
    /** Device-minted, like every other movement: a replayed sync must not recall twice. */
    readonly id: string;
    readonly transferOf: string;
    readonly repProfileId: string;
    readonly occurredAt: Date;
    readonly reason?: string | null;
  },
): Promise<TransferRecall> {
  const source = await getTransaction(tx, input.transferOf);
  if (source === null) {
    throw translateSampleError(new Error(`transfer_of ${input.transferOf} does not exist`));
  }
  try {
    const { rows } = await tx.query<TransferRecall>(
      `INSERT INTO crm.sample_transaction
         (id, tenant_id, lot_id, rep_profile_id, kind, quantity,
          counterparty_rep_profile_id, transfer_of, reason, occurred_at)
       VALUES ($1,$2,$3,$4,'transfer_recall',$5,$6,$7,$8,$9)
       -- Same idempotency as every other movement: a redelivered recall collapses into
       -- the row already there instead of refusing as a second terminal event.
       ON CONFLICT (id) DO NOTHING
       RETURNING ${RECALL_COLUMNS}`,
      [
        input.id,
        tenantId,
        source.lot_id,
        input.repProfileId,
        source.quantity,
        source.counterparty_rep_profile_id,
        input.transferOf,
        input.reason ?? null,
        input.occurredAt,
      ],
    );
    const inserted = rows[0];
    if (inserted === undefined) {
      // Redelivered: the row is already there, and so is its notification — the dedup key
      // below is keyed on the transfer, so raising again would be a no-op anyway. Return
      // without re-raising so the two paths cannot diverge.
      const existing = await recallOf(tx, input.transferOf);
      if (existing === null) throw new Error(`recall ${input.id} neither inserted nor found`);
      return existing;
    }

    await notifyRecalled(tx, tenantId, inserted);
    return inserted;
  } catch (err) {
    throw translateSampleError(err);
  }
}

/**
 * Transfers the caller sent that they could still take back.
 *
 * Scoped to the SENDER inside `crm.recallable_transfers`, not by filtering afterwards:
 * only the sender can recall, so a list that offered the action for a transfer sent TO
 * the caller would be a button the database refuses. That makes this narrower than
 * `outstandingTransfers`, which answers "where is my material" for either side.
 */
/**
 * Tell the receiver the material is not coming.
 *
 * `transferOut` told them it was. Leaving that notification standing would send a rep
 * looking for stock that is in somebody else's bag — the inbox would be the thing that
 * misled them, which is worse than never having told them.
 *
 * In the same transaction as the ledger row, like every other signal here: either the
 * recall and the correction both land or neither does.
 */
async function notifyRecalled(
  tx: PoolClient,
  tenantId: string,
  recall: TransferRecall,
): Promise<void> {
  // `sample_tx_transfer_recall_fields` makes this non-null for a recall, but the row type
  // is shared with kinds where it is nullable. Checked rather than asserted: if the
  // constraint ever changed, an assertion would send `null` to a NOT NULL column and the
  // failure would surface as a confusing insert error instead of here.
  const receiver = recall.counterparty_rep_profile_id;
  if (receiver === null) return;

  const { rows } = await tx.query<{ lot_number: string; display_name: string }>(
    `SELECT l.lot_number, rp.display_name
       FROM crm.sample_lot l, crm.rep_profile rp
      WHERE l.id = $1 AND rp.id = $2`,
    [recall.lot_id, recall.rep_profile_id],
  );
  const lotNumber = rows[0]?.lot_number ?? recall.lot_id;
  const sender = rows[0]?.display_name ?? "the sender";
  // numeric(16,3) comes back as "12.000", and the notification this one corrects says
  // "12" because it was given the caller's own string. Two messages about one transfer
  // that disagree about the quantity read like two different events.
  //
  // Guarded on the decimal point rather than written as one regex: `/\.?0+$/` turns
  // "120" into "12", and the only reason that cannot happen today is that this column is
  // numeric(16,3) and always arrives with its three places. That is too thin a thing to
  // rely on for a quantity of a drug sample.
  const quantity = recall.quantity.includes(".")
    ? recall.quantity.replace(/0+$/, "").replace(/\.$/, "")
    : recall.quantity;

  await raiseNotification(tx, tenantId, {
    recipientRepProfileId: receiver,
    kind: "sample_transfer_recalled",
    severity: "warning",
    subject: `${sender} took back ${quantity} of lot ${lotNumber}`,
    body:
      `${sender} recalled the ${quantity} unit(s) of lot ${lotNumber} that were on ` +
      `their way to you. Nothing is owed and nothing is outstanding; the material is back ` +
      `on their balance.`,
    // Keyed on the TRANSFER, like the awaiting-acceptance signal it corrects, so the two
    // are a matched pair and a replay of either notifies once.
    dedupKey: `transfer:${recall.transfer_of ?? recall.id}:recalled`,
    subjectTable: "crm.sample_transaction",
    subjectId: recall.transfer_of ?? recall.id,
    payload: { lotNumber, quantity, byRepProfileId: recall.rep_profile_id },
  });
}

export async function recallableTransfers(
  tx: PoolClient,
  repProfileId: string,
): Promise<readonly RecallableTransfer[]> {
  const { rows } = await tx.query<RecallableTransfer>(
    `SELECT transaction_id, lot_id, lot_number, erp_item_id, expiry_date::text AS expiry_date,
            quantity::text AS quantity, sent_to, sent_to_name, occurred_at, days_in_transit
       FROM crm.recallable_transfers($1)`,
    [repProfileId],
  );
  return rows;
}

/** The recall recorded against a transfer, if it was recalled rather than accepted. */
export async function recallOf(tx: PoolClient, transferOutId: string): Promise<TransferRecall | null> {
  const { rows } = await tx.query<TransferRecall>(
    `SELECT ${RECALL_COLUMNS} FROM crm.sample_transaction
      WHERE transfer_of = $1 AND kind = 'transfer_recall'`,
    [transferOutId],
  );
  return rows[0] ?? null;
}
