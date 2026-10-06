/**
 * Turning what Postgres gives us into what the ERP should be given.
 *
 * node-postgres returns `NUMERIC` as a STRING, deliberately and correctly: a numeric is
 * arbitrary precision and a JS number is not, so the driver refuses to lose digits on the
 * caller's behalf. Everything in this repo that reads a money or quantity column therefore
 * holds text — `SampleTransaction.quantity`, `ExpenseClaim.amount` — and both were being
 * put into an ERP payload verbatim.
 *
 * WHICH THE ERP ACCEPTS, AND THAT IS THE PROBLEM. `operate-runtime/src/validation.ts`
 * validates a `decimal` with `typeof value === "string" ? Number(value) : …` and then stores
 * the value it was SENT, uncoerced — so the ERP's `StockMovement.quantity` holds the string
 * `"12.000"` and `Expense.amount` holds `"40.00"`, in fields its own schema calls numbers.
 * It works today entirely because that validator is lenient. The day it tightens to
 * `typeof value === "number"`, every mirrored movement and every posted claim answers 422
 * and dead-letters — the same shape as the ERP leaking node-postgres's duplicate-key message
 * (ADR-0001), where correct behaviour rests on the platform not hardening something it
 * should.
 *
 * So the CRM sends a number. Not because the ERP demands one — it does not — but because a
 * `decimal` field holding a string is a value nobody chose and a dependency nobody declared.
 */

/**
 * The most significant decimal digits an IEEE-754 double survives a round trip through.
 *
 * `JSON.stringify` writes the SHORTEST decimal that parses back to the same double, so for a
 * value within this many significant digits the JSON the ERP receives is the digits the
 * database holds, exactly. Past it the two silently differ, which is the one thing a money
 * field must not do.
 *
 * It is NOT merely theoretical, which the first draft of this comment got wrong.
 * `crm.expense_claim.amount` is `numeric(14,2)` and never reaches it. But
 * `crm.sample_transaction.quantity` is `numeric(16,3)` — up to 16 significant digits — so
 * the top band of that column really is past what a JSON number names unambiguously, and
 * this refuses it. That is the trade, stated rather than discovered: a 13-integer-digit
 * sample quantity is a data-entry error long before it is a shipment, and a refusal that
 * dead-letters with the field named is visible where a silently different figure in somebody
 * else's inventory is not.
 */
const MAX_ROUND_TRIP_DIGITS = 15;

export class ErpDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpDecimalError";
  }
}

/**
 * A `NUMERIC` column's value, as a number the ERP can store as one.
 *
 * Refuses rather than rounds. A quantity or an amount that cannot be carried exactly is not
 * something to send approximately: the caller is enqueueing a write to somebody else's
 * ledger, and the honest outcome is a refusal at the point the value is read — where it
 * names the column — rather than a figure that is nearly right in a journal entry.
 */
export function erpDecimal(field: string, value: string | number): number {
  const text = typeof value === "number" ? String(value) : value.trim();
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) {
    throw new ErpDecimalError(`${field} is not a number the ERP can be sent (${JSON.stringify(value)})`);
  }
  // Significant digits, not characters: a sign, a decimal point, and leading or trailing
  // zeros carry no information and `numeric` emits trailing zeros to its scale ("12.000").
  const digits = text.replace(/[-+.]/g, "").replace(/^0+/, "").replace(/0+$/, "").length;
  if (digits > MAX_ROUND_TRIP_DIGITS) {
    throw new ErpDecimalError(
      `${field} has ${String(digits)} significant digits (${text}), which a JSON number cannot ` +
        `carry exactly — sending it would put a different value in the ERP than the one recorded here`,
    );
  }
  return n;
}
