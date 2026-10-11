/**
 * Where one rep's notifications are emailed (0065).
 *
 * `crm.notification` is addressed to a PERSON and `crm.notification_delivery` is addressed to
 * an ENDPOINT, and endpoints are per tenant — so until this existed every rep's signals went
 * to whichever single `mailto:` the tenant's one email endpoint was frozen to. For 0064's
 * `urgent` escalation, whose whole case is reaching somebody who has not opened the app in a
 * week, a shared ops mailbox is the wrong destination: nobody is personally addressed, so
 * nobody is personally responsible.
 *
 * WHY NOT `crm.rep_profile.work_email_hint`, WHICH HAS BEEN SITTING THERE SINCE 0003. Because
 * 0003 says so, in as many words: "work_email is carried as a RECONCILIATION HINT ONLY: it
 * changes on marriage, rebrand and domain migration, and must never be the join key." It is
 * written by the ERP reconciler from whatever the Employee record happens to say. Mailing a
 * rep's name and a lot number to an address nobody confirmed is the "fixture kinder than
 * reality" failure wearing a mail header — so the hint becomes a SUGGESTION in
 * `notifyAddressCoverage` below, which an administrator confirms, and the destination itself
 * is a separate deliberately-set fact.
 *
 * EVERY WRITE HERE IS ATTRIBUTED, and the store does not know it. 0065 puts the table under
 * `crm.require_config_attribution`, so the database refuses an INSERT or UPDATE whose
 * transaction has not said who is making it and why — a caller opens `withAttribution` and
 * these functions are untouched by it, which is 0061's whole ergonomic point.
 *
 * A WITHDRAWAL IS AN AMENDMENT, NOT A DELETION. `address` is nullable and `clear` sets it to
 * NULL rather than removing the row, because 0061's trigger fires `AFTER INSERT OR UPDATE`:
 * a DELETE would be the one change to this table that nobody signed and nothing logged.
 */
import type { PoolClient } from "pg";

import { isMailbox } from "./smtp.js";

/**
 * RFC 5321's limit on a path, which is what the relay will enforce. Named here because the
 * refusal should arrive as a 422 from this store rather than as a 550 eight minutes later.
 */
export const NOTIFY_ADDRESS_MAX = 254;

/**
 * 0065's `rep_notify_address_address_check`, in TypeScript.
 *
 * Duplicated from the CHECK on purpose, and `notify-address.contract.test.ts` compares the two
 * against `pg_constraint` so the copy cannot drift — `ENDPOINT_CHANNELS`' arrangement, for
 * `ENDPOINT_CHANNELS`' reason: the refusal should land as a 422 naming what is wrong, not as a
 * constraint violation surfacing as a 500 from the bottom of the stack.
 */
export const NOTIFY_ADDRESS_SHAPE = /^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/;

/**
 * An address this process would not be able to send to.
 *
 * BOTH RULES, and neither implies the other — which is the trap worth naming. The column's
 * CHECK wants a dot in the domain and `isMailbox` does not, so `rep@localhost` passes
 * `isMailbox` and would arrive at the CHECK as a 500. `isMailbox` refuses angle brackets, a
 * display name and a colon, where the column's regex admits all three, so an address that
 * satisfied only the column would be stored happily and then dead-letter every delivery to it
 * forever. An earlier version of this called `isMailbox` "deliberately stricter" and checked
 * only that; it was wrong in exactly the direction that produces a 500.
 */
export class InvalidNotifyAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNotifyAddressError";
  }
}

/**
 * Thrown when the rep named has no profile in this tenant.
 *
 * The name is deliberately general rather than `NotifyAddressRepNotFoundError`, because the
 * fact is general and so is the answer `toProblem` gives it: any package refusing a write for
 * "there is no such rep here" wants the same 404 with the same reading. `ConfigFourEyesError`
 * was renamed for the opposite reason — two classes that would have looked interchangeable and
 * were not — and this is the case that rule does not cover.
 */
export class RepNotFoundError extends Error {
  constructor(repProfileId: string) {
    super(`no rep profile ${repProfileId} in this tenant`);
    this.name = "RepNotFoundError";
  }
}

export interface RepNotifyAddress {
  readonly rep_profile_id: string;
  readonly display_name: string;
  /** Null when the destination has been withdrawn — the row is the record that it was. */
  readonly address: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * One rep on the coverage list, addressed or not.
 *
 * `work_email_hint` travels as `suggestion` and never as a value this module would use. The
 * rename is the whole point: a field called `address` that sometimes held a hint is how a
 * hint becomes load-bearing by accident, which is the thing 0003 forbids.
 */
export interface NotifyAddressGap {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
  readonly status: string;
  /** Null when this rep has no destination — the reason they are on the list. */
  readonly address: string | null;
  /** `crm.rep_profile.work_email_hint`, for an administrator to confirm or replace. */
  readonly suggestion: string | null;
}

/**
 * The to-do list, and the two numbers that say whether it matters.
 *
 * `endpoints` is the count of ENABLED `email_recipient` endpoints in the tenant. Reported
 * alongside the gaps because a tenant with no such endpoint has no gap — nothing would be
 * mailed to any of these people either way — and a list of twelve unaddressed reps that reads
 * as urgent when nothing is configured to use it is how a to-do list gets ignored.
 */
export interface NotifyAddressCoverage {
  readonly endpoints: number;
  readonly reps: number;
  readonly addressed: number;
  readonly missing: readonly NotifyAddressGap[];
  readonly summary: string;
}

const ADDRESS_COLUMNS =
  "a.rep_profile_id, r.display_name, a.address, a.created_at, a.updated_at";

function checkedAddress(address: string): string {
  if (address.length > NOTIFY_ADDRESS_MAX) {
    throw new InvalidNotifyAddressError(
      `an address may be at most ${String(NOTIFY_ADDRESS_MAX)} characters, which is RFC 5321's own limit; ` +
        `this one is ${String(address.length)}`,
    );
  }
  if (!NOTIFY_ADDRESS_SHAPE.test(address)) {
    throw new InvalidNotifyAddressError(
      `${JSON.stringify(address.slice(0, 80))} is not an address — one mailbox, an @, and a domain ` +
        `with a dot in it`,
    );
  }
  if (!isMailbox(address)) {
    throw new InvalidNotifyAddressError(
      `${JSON.stringify(address.slice(0, 80))} is not a mailbox this process could put in a RCPT TO — ` +
        `the address alone, with no display name, no angle brackets and no comma`,
    );
  }
  return address;
}

export async function repNotifyAddress(
  tx: PoolClient,
  tenantId: string,
  repProfileId: string,
): Promise<RepNotifyAddress | null> {
  const { rows } = await tx.query<RepNotifyAddress>(
    `SELECT ${ADDRESS_COLUMNS}
       FROM crm.rep_notify_address a
       JOIN crm.rep_profile r ON r.tenant_id = a.tenant_id AND r.id = a.rep_profile_id
      WHERE a.tenant_id = $1 AND a.rep_profile_id = $2`,
    [tenantId, repProfileId],
  );
  return rows[0] ?? null;
}

/**
 * Sets where this rep's notifications go. Creates the row or amends it.
 *
 * An upsert rather than insert-or-fail because correcting an address is the ordinary act —
 * somebody mistyped it, or the person moved domain — and the record of what it used to be is
 * in `crm.config_change` with a before-image, which is the right place for it. Re-setting the
 * same address writes nothing: 0061's trigger records only changes, so the no-op is simply not
 * logged, and the row's `updated_at` is deliberately left alone in that case so a listing does
 * not report a change that was not one.
 */
export async function setRepNotifyAddress(
  tx: PoolClient,
  tenantId: string,
  repProfileId: string,
  address: string,
): Promise<RepNotifyAddress> {
  const checked = checkedAddress(address);
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT true AS ok FROM crm.rep_profile WHERE tenant_id = $1 AND id = $2`,
    [tenantId, repProfileId],
  );
  // Checked rather than left to the foreign key, because the key's violation is a 23503 with
  // a constraint name and this is a 404: an administrator typing a rep id that is not in
  // their tenant has made an ordinary mistake, and RLS means "another tenant's rep" and "no
  // such rep" are the same answer here, correctly.
  if (rows[0] === undefined) throw new RepNotFoundError(repProfileId);

  await tx.query(
    `INSERT INTO crm.rep_notify_address (tenant_id, rep_profile_id, address)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, rep_profile_id) DO UPDATE
       SET address = EXCLUDED.address, updated_at = now()
     WHERE crm.rep_notify_address.address IS DISTINCT FROM EXCLUDED.address`,
    [tenantId, repProfileId, checked],
  );
  // Non-null: either the upsert wrote the row or the WHERE above declined because the row
  // already says exactly this.
  return (await repNotifyAddress(tx, tenantId, repProfileId))!;
}

/**
 * Stops mailing this rep, by amending the row rather than removing it.
 *
 * Returns false when there was nothing to withdraw — no row, or a row already withdrawn — so
 * a caller can answer 404 rather than reporting a change it did not make. The row that stays
 * behind with a null address is not dead weight: it is the record, with `crm.config_change`
 * beside it, that somebody deliberately stopped this person's mail and said why.
 */
export async function clearRepNotifyAddress(
  tx: PoolClient,
  tenantId: string,
  repProfileId: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE crm.rep_notify_address
        SET address = NULL, updated_at = now()
      WHERE tenant_id = $1 AND rep_profile_id = $2 AND address IS NOT NULL`,
    [tenantId, repProfileId],
  );
  return (rowCount ?? 0) > 0;
}

interface CoverageRow {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
  readonly status: string;
  readonly address: string | null;
  readonly suggestion: string | null;
}

/**
 * Who would be mailed, who would not, and whether this tenant has anything that would mail
 * them — the administrator's to-do list.
 *
 * ACTIVE REPS ONLY, by default. A departed rep with no notification address is not a
 * configuration gap, and listing them would bury the three people who are actually
 * unreachable under everyone who ever left. `includeInactive` is there because "why did
 * nobody tell Omar" has a different answer when Omar is suspended.
 *
 * The same shape as `unmappedCategoriesWithClaims` in `@crm/expense`, and for the same
 * reason: it turns "notifications cannot reach half this tenant" from a sentence in an ADR
 * into a number somebody can watch go to zero.
 */
export async function notifyAddressCoverage(
  tx: PoolClient,
  tenantId: string,
  opts: { readonly includeInactive?: boolean } = {},
): Promise<NotifyAddressCoverage> {
  const { rows: endpointRows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM crm.notification_endpoint
      WHERE tenant_id = $1 AND enabled AND channel = 'email_recipient'`,
    [tenantId],
  );
  const endpoints = Number(endpointRows[0]?.n ?? "0");

  const { rows } = await tx.query<CoverageRow>(
    `SELECT r.id AS rep_profile_id, r.display_name, r.employee_number, r.status,
            a.address, r.work_email_hint AS suggestion
       FROM crm.rep_profile r
       LEFT JOIN crm.rep_notify_address a
              ON a.tenant_id = r.tenant_id AND a.rep_profile_id = r.id
      WHERE r.tenant_id = $1
        AND ($2::boolean OR r.status = 'active')
      ORDER BY r.display_name, r.id`,
    [tenantId, opts.includeInactive ?? false],
  );

  const missing = rows
    .filter((r) => r.address === null)
    .map((r) => ({
      rep_profile_id: r.rep_profile_id,
      display_name: r.display_name,
      employee_number: r.employee_number,
      status: r.status,
      address: null,
      suggestion: r.suggestion,
    }));

  return {
    endpoints,
    reps: rows.length,
    addressed: rows.length - missing.length,
    missing,
    summary: summarise(endpoints, rows.length, missing.length),
  };
}

function summarise(endpoints: number, reps: number, missing: number): string {
  if (reps === 0) return "this tenant has no reps to address";
  if (missing === 0) {
    return endpoints === 0
      ? `all ${String(reps)} rep(s) have a notification address, and no enabled endpoint uses one yet`
      : `all ${String(reps)} rep(s) have a notification address`;
  }
  if (endpoints === 0) {
    // Said rather than skipped, and said as "would not" rather than "cannot": nothing is
    // broken today, and the first `email_recipient` endpoint someone enables makes it so.
    return (
      `${String(missing)} of ${String(reps)} rep(s) have no notification address; no enabled endpoint is on ` +
      `the email_recipient channel, so nothing is unreachable yet — enabling one would make it so`
    );
  }
  return (
    `${String(missing)} of ${String(reps)} rep(s) have no notification address and ${String(endpoints)} ` +
    `enabled endpoint(s) would have mailed them, so their signals go nowhere`
  );
}
