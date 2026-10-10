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
  /**
   * The approved proposal this change is spending, for the few changes that take two people.
   *
   * Travels with the author because it is the same KIND of fact — who this write is on the
   * authority of — and because the alternative is a second wrapper that a caller can open
   * without the first. 0062 refuses a four-eyed change whose transaction does not name one,
   * and refuses one whose proposal does not match the row and values being written, so a
   * caller cannot launder a change through an approval given for something else.
   *
   * Omitted for the single-signature majority, which is almost every change: a proposal set
   * where none is needed is simply never read.
   */
  readonly proposalId?: string;
}

export const ACTOR_SETTING = "app.change_actor";
export const REASON_SETTING = "app.change_reason";
export const PROPOSAL_SETTING = "app.change_proposal";

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
/**
 * A change the database refused because one person is not enough for it (0062).
 *
 * `Config` in the name on purpose: `@crm/expense` has had a `FourEyesViolationError` since
 * 0006 for the rule that a claimant cannot approve their own claim, and the two are different
 * rules about different things. `toProblem` dispatches on `name`, so two classes called
 * `FourEyesError` would not collide — they would do something worse, which is read as
 * interchangeable to whoever is deciding which one to throw.
 *
 * THE CALLER'S TO ACT ON, unlike the error above, which is why it is a separate class: the
 * answer is "propose it and have somebody else approve", and that is a sentence an
 * administrator can read and do something about. It covers every `four-eyes-*` refusal — no
 * proposal named, not approved yet, already spent, about another row, for another value,
 * either actor no longer qualified — because every one of them means the same thing to
 * whoever asked: this change has not been agreed by two people who may make it.
 */
export class ConfigFourEyesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFourEyesError";
  }
}

/**
 * A proposal the database refused to change or re-decide (0062).
 *
 * Separate from `ConfigFourEyesError` because it is about the proposal rather than about the
 * change: what it asked for is frozen, a decision cannot be retaken, and an approval is
 * good for one write. All three are races as often as they are mistakes — two approvers
 * clicking at once is the ordinary case — so the sentence matters and the status is a
 * conflict.
 */
export class ConfigProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigProposalError";
  }
}

/**
 * Recognises 0061's and 0062's refusals by the prefixes their triggers raise them with.
 *
 * Matched on prefixes rather than on constraint names because they come from `RAISE` and
 * carry none — and on deliberately unlovely tokens for the reason 0049's
 * `endpoint-destination-frozen:` uses one: a sentence can be reworded by whoever improves
 * it, and a token in front of it cannot be reworded by accident.
 *
 * ORDER MATTERS BY ACCIDENT HERE AND MUST NOT: the tokens are disjoint prefixes, so no
 * message can match two. `config-proposal-` and `config-change-` share nine characters and
 * diverge before either token ends, which is why both are matched with their trailing
 * hyphen rather than as bare words.
 */
export function translateAttributionError(err: unknown): unknown {
  const message = (err as { message?: string })?.message ?? "";
  if (message.includes("config-change-unattributed:")) return new UnattributedChangeError(message);
  if (message.includes("four-eyes-")) return new ConfigFourEyesError(message);
  if (message.includes("config-proposal-")) return new ConfigProposalError(message);
  return err;
}

/**
 * Runs `fn` with the author and reason set, and leaves nothing behind.
 *
 * All three settings are written in ONE statement, so a connection cannot sit between them
 * holding an author with no reason — a state in which a write would be refused for the wrong
 * cause.
 *
 * RESTORED RATHER THAN CLEARED on the way out, which is a correction. 0061 cleared them, and
 * argued for it on the grounds that "the only thing a restore would buy is nesting, which no
 * caller does". 0062 gave it a caller: `withFourEyes` in the test helpers opens an attribution
 * block of its own inside suites that already have one, so clearing would leave every write
 * after it unattributed — and the failure would arrive as a refusal in a test about something
 * else entirely. The interface comment above has said "restored rather than cleared" since
 * 0061; the implementation did the other thing, and this is the two of them agreeing.
 *
 * Nothing is weakened by it. `set_config(..., is_local => true)` is already transaction-scoped
 * so nothing survives the commit either way, and what gets restored is what the enclosing
 * block set and is still inside — not a stale value from somewhere else.
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
  // READ BEFORE WRITING, so the `finally` can put back what an enclosing block had set. The
  // empty string is what `current_setting(…, true)` returns for a setting nobody has touched,
  // so "no outer block" and "an outer block that cleared" restore identically — and the
  // trigger's `NULLIF` reads both as absent.
  const { rows } = await client.query<{ actor: string; reason: string; proposal: string }>(
    `SELECT current_setting($1, true) AS actor,
            current_setting($2, true) AS reason,
            current_setting($3, true) AS proposal`,
    [ACTOR_SETTING, REASON_SETTING, PROPOSAL_SETTING],
  );
  const previous = {
    actor: rows[0]?.actor ?? "",
    reason: rows[0]?.reason ?? "",
    proposal: rows[0]?.proposal ?? "",
  };
  // All three in ONE statement, so a connection cannot sit between them holding an author
  // with no reason — a state in which a write would be refused for the wrong cause. The
  // proposal is written as the empty string when there is none, which is what
  // `current_setting(…, true)` returns for a setting nobody has touched, so the trigger's
  // `NULLIF` reads both cases identically.
  await client.query(
    `SELECT set_config($1, $4, true), set_config($2, $5, true), set_config($3, $6, true)`,
    [
      ACTOR_SETTING,
      REASON_SETTING,
      PROPOSAL_SETTING,
      attribution.repProfileId,
      attribution.reason,
      attribution.proposalId ?? "",
    ],
  );
  try {
    return await fn(client);
  } catch (err) {
    throw translateAttributionError(err);
  } finally {
    await client
      .query(`SELECT set_config($1, $4, true), set_config($2, $5, true), set_config($3, $6, true)`, [
        ACTOR_SETTING,
        REASON_SETTING,
        PROPOSAL_SETTING,
        previous.actor,
        previous.reason,
        previous.proposal,
      ])
      .catch(() => undefined);
  }
}
