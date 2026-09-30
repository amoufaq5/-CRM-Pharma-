/**
 * Coercing an ERP JSONB value into a typed snapshot column.
 *
 * This is the riskiest code in the sync path. The snapshot tables exist BECAUSE
 * the ERP compares everything as text (report R19); if coercion into them is
 * sloppy, we have moved the bug rather than fixed it — and moved it somewhere
 * worse, because a wrong number in a typed column looks authoritative.
 *
 * Two rules throughout:
 *
 * 1. **Decimals stay strings all the way into Postgres.** `NUMERIC` is exact;
 *    JavaScript's `number` is float64 and cannot represent 0.1, let alone a
 *    14-digit price. Parsing "1234567890.12" into a float and handing that to
 *    the driver would round it silently. So the value is VALIDATED as a decimal
 *    and passed through as text, which Postgres parses exactly.
 * 2. **A malformed value is an error, never a null.** Nulling a bad price makes
 *    a record look free. The row is rejected, loudly and individually, and the
 *    rest of the batch proceeds.
 */

export class CoercionError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`cannot coerce ${field}=${JSON.stringify(value)?.slice(0, 80)}: ${reason}`);
    this.name = "CoercionError";
  }
}

/** Absent, in the two ways JSON and the ERP express it. */
function isAbsent(v: unknown): boolean {
  return v === null || v === undefined;
}

export function coerceText(field: string, v: unknown): string | null {
  if (isAbsent(v)) return null;
  if (typeof v === "string") return v;
  // A number or boolean in a text column is benign and unambiguous.
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new CoercionError(field, v, "expected a string");
}

/** Text required by the column. An empty string is treated as absent, not as "". */
export function coerceRequiredText(field: string, v: unknown): string {
  const s = coerceText(field, v);
  if (s === null || s.trim() === "") {
    throw new CoercionError(field, v, "required by the snapshot column but absent or blank");
  }
  return s;
}

/**
 * A decimal, returned as a STRING for exact NUMERIC storage.
 *
 * Rejects the shapes JSON and JavaScript make easy to produce by accident:
 * `NaN`, `Infinity`, exponent notation (Postgres accepts it, but its presence
 * means something upstream already went through a float), and anything with
 * stray characters.
 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function coerceDecimal(field: string, v: unknown): string | null {
  if (isAbsent(v)) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new CoercionError(field, v, "not a finite number");
    // Reached here the value already survived a float64 round trip, so exactness
    // is gone; `toString` at least avoids adding error. Real ERP payloads carry
    // decimals as strings, so this path is the unusual one.
    return String(v);
  }
  if (typeof v !== "string") throw new CoercionError(field, v, "expected a decimal string");
  const s = v.trim();
  if (s === "") return null;
  if (!DECIMAL_RE.test(s)) {
    throw new CoercionError(
      field,
      v,
      "not a plain decimal (exponent notation and stray characters are refused — " +
        "an exponent means the value already passed through a float somewhere)",
    );
  }
  return s;
}

/** `YYYY-MM-DD`. Rejects a datetime, because truncating one silently shifts the day across time zones. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function coerceDate(field: string, v: unknown): string | null {
  if (isAbsent(v)) return null;
  if (typeof v !== "string") throw new CoercionError(field, v, "expected an ISO date string");
  const s = v.trim();
  if (s === "") return null;
  if (!DATE_RE.test(s)) throw new CoercionError(field, v, "expected YYYY-MM-DD");
  // Catches 2026-02-30, which matches the regex but is not a date.
  const parsed = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(s)) {
    throw new CoercionError(field, v, "not a real calendar date");
  }
  return s;
}

export function coerceTimestamp(field: string, v: unknown): string | null {
  if (isAbsent(v)) return null;
  if (typeof v !== "string") throw new CoercionError(field, v, "expected an ISO-8601 timestamp string");
  const s = v.trim();
  if (s === "") return null;
  if (Number.isNaN(new Date(s).getTime())) {
    throw new CoercionError(field, v, "not a parseable ISO-8601 timestamp");
  }
  // Passed through verbatim rather than normalised: Postgres parses ISO-8601
  // exactly, and re-formatting risks shifting the microseconds that the
  // incremental high-water mark depends on.
  return s;
}

export function coerceBoolean(field: string, v: unknown): boolean | null {
  if (isAbsent(v)) return null;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new CoercionError(field, v, "expected a boolean");
}

/** ISO 3166-1 alpha-2, upper-cased, for a CHAR(2) column. */
export function coerceCountry(field: string, v: unknown): string | null {
  const s = coerceText(field, v);
  if (s === null || s.trim() === "") return null;
  const up = s.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) throw new CoercionError(field, v, "expected a 2-letter country code");
  return up;
}

/** An ERP record id, validated against the same shape the CHECK on the domain enforces. */
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function coerceRecordId(field: string, v: unknown): string | null {
  const s = coerceText(field, v);
  if (s === null || s.trim() === "") return null;
  if (!RECORD_ID_RE.test(s)) {
    throw new CoercionError(field, v, "not a valid ERP record id (crm.erp_record_id would reject it)");
  }
  return s;
}

export function coerceRequiredRecordId(field: string, v: unknown): string {
  const s = coerceRecordId(field, v);
  if (s === null) throw new CoercionError(field, v, "required ERP record id is absent");
  return s;
}
