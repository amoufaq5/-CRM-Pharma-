import type { PoolClient } from "pg";

/**
 * Who is changing a tenant's configuration, and why — for the length of a block.
 *
 * Migration 0061 puts configuration tables under attribution: an AFTER trigger records every
 * change to `crm.config_change` and REFUSES the write when nobody has said who is making it.
 * The author and the reason travel in two transaction-local settings rather than in an
 * argument every store function would have to thread — the same mechanism, for the same
 * reason, as `app.current_tenant_id`, which `withTenantContext` has set since 0003 and every
 * row-security policy in the schema reads.
 *
 * THE ERGONOMIC POINT IS THE WHOLE POINT. 0059 and 0060 gave two tables their own logs by
 * changing the signature of every function that writes them, which worked and does not scale:
 * each table costs a bespoke log, a trigger that applies it, and a fixture change in every
 * suite that touches it. Here a store function is untouched — `setNotificationPolicy` has no
 * idea this exists — and a route opts its write into attribution by wrapping it.
 *
 * SCOPED, NOT ONE-SHOT. The settings last for the block and are restored afterwards, rather
 * than being consumed by the first write. One-shot is more precise and worse: a route that
 * legitimately writes twice would fail on its second write, and the honest unit is the
 * administrative ACTION — one author, one sentence, however many rows it touches.
 *
 * RESTORED RATHER THAN CLEARED, so a nested block cannot strip the outer one's attribution on
 * the way out. `set_config(..., is_local => true)` is already transaction-scoped, so nothing
 * survives the commit either way; the restore is about what the REST of this transaction sees.
 */
export interface ChangeAttribution {
  /** The rep making the change. From the authenticated principal, never from a request body. */
  readonly repProfileId: string;
  /** Why, in a sentence. Ten characters is the column's own floor (0061). */
  readonly reason: string;
}

export const ACTOR_SETTING = "app.change_actor";
export const REASON_SETTING = "app.change_reason";

/**
 * A change the database refused because nothing had said who was making it.
 *
 * NOT the caller's mistake, and the mapping says so: a missing `reason` in a request body is
 * refused by a route's own schema long before the database sees it, so reaching this means the
 * code forgot to open a block. It belongs in the 500 bucket — "this deployment has a bug" — and
 * dressing it as a 422 would send an administrator looking for something to retype.
 */
export class UnattributedChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnattributedChangeError";
  }
}

/**
 * Recognises 0061's refusal by the prefix the trigger raises it with.
 *
 * Matched on a prefix rather than on a constraint name because it comes from a `RAISE` and
 * carries none — and on a deliberately unlovely token (`config-change-unattributed:`) for the
 * reason 0049's `endpoint-destination-frozen:` uses one: a sentence can be reworded by whoever
 * improves it, and a token in front of it cannot be reworded by accident.
 *
 * There is only one. A write that moves nothing is not refused by 0061 — it is simply not
 * recorded — because this mechanism serves routes with ENSURE semantics as well as routes that
 * set a named knob, and only the route knows which it promised.
 */
export function translateAttributionError(err: unknown): unknown {
  const message = (err as { message?: string })?.message ?? "";
  if (message.includes("config-change-unattributed:")) return new UnattributedChangeError(message);
  return err;
}

/**
 * Runs `fn` with the author and reason set, and leaves nothing behind.
 *
 * Both settings are written in ONE statement, so a connection cannot sit between them holding
 * an author with no reason — a state in which a write would be refused for the wrong cause —
 * and both are CLEARED in a `finally` rather than restored to what they were. Clearing is the
 * stronger choice and the simpler one: an attribution that outlives its own block is the hazard
 * worth designing against, and the only thing a restore would buy is nesting, which no caller
 * does and which would mean one administrative action inside another.
 *
 * The reason is not validated here beyond being non-empty. Its floor is the column's own (ten
 * characters, 0061) and its ceiling is the route's schema; a third opinion in the middle is how
 * two of them come to disagree.
 *
 * The clearing statement is NOT inside the caller's error path: if `fn` threw, the transaction
 * is usually being rolled back anyway and the `set_config` would fail on an aborted connection,
 * so it is allowed to fail quietly. What must not happen is that failure replacing the error
 * the caller is already handling.
 */
export async function withAttribution<T>(
  client: PoolClient,
  attribution: ChangeAttribution,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (attribution.reason.trim() === "") {
    throw new UnattributedChangeError("a configuration change must carry a reason");
  }
  await client.query(`SELECT set_config($1, $3, true), set_config($2, $4, true)`, [
    ACTOR_SETTING,
    REASON_SETTING,
    attribution.repProfileId,
    attribution.reason,
  ]);
  try {
    return await fn(client);
  } catch (err) {
    throw translateAttributionError(err);
  } finally {
    await client
      .query(`SELECT set_config($1, '', true), set_config($2, '', true)`, [
        ACTOR_SETTING,
        REASON_SETTING,
      ])
      .catch(() => undefined);
  }
}
