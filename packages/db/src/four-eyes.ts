import type { PoolClient } from "pg";

import { translateAttributionError } from "./attribution.js";

/**
 * The few configuration changes that take two people (0062).
 *
 * Here rather than in a domain package for `config-log.ts`'s reason: the register spans
 * domains — the disposal SOP parameters belong to `@crm/sample` and the expense account map
 * to `@crm/expense` — and a reader asking "what in this tenant is waiting for a second
 * signature" is asking one question across all of them.
 *
 * WHAT THIS FILE DOES NOT DO IS APPLY A CHANGE, and the omission is deliberate. Approving a
 * proposal has to perform the write on the table it is about, which means knowing how to
 * write to that table, which means depending on the domain packages — and `@crm/db` is the
 * substrate every one of them depends on. So the approve path lives at the route layer,
 * where both are already in scope, and this file stops at the record.
 *
 * NEITHER DOES IT NOTIFY, for the same reason: `@crm/db` depends on `pg` and nothing else,
 * so it cannot reach `@crm/notify`. `proposeConfigChange` therefore RETURNS the reps who
 * could decide the proposal rather than telling them, and the route raises the signal. That
 * is a seam a caller can forget, which is a defect this repository has shipped more than
 * once, so the return type names them rather than counting them: a route that ignores a list
 * of people is more obviously wrong than one that ignores a number.
 */

/**
 * One query, with 0062's refusals turned into their named classes.
 *
 * Every statement in this file that can raise one goes through here, for the reason
 * `decideConfigProposal` explains at length: the translation belongs with the statement that
 * can raise rather than with a wrapper that happens to enclose most of them.
 */
async function query<T extends Record<string, unknown>>(
  tx: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<{ readonly rows: readonly T[] }> {
  try {
    return await tx.query<T>(sql, [...params]);
  } catch (err) {
    throw translateAttributionError(err);
  }
}

/** A row of `crm.four_eyes_rule`: which change, in which direction, under which grant. */
export interface FourEyesRule {
  readonly table_name: string;
  readonly column_name: string;
  readonly direction: "any_change" | "to_true" | "to_false";
  readonly role: "administrator" | "compliance";
  readonly note: string;
}

export type ProposalDecision = "approved" | "rejected" | "withdrawn";

export interface ConfigProposal {
  readonly id: string;
  readonly table_name: string;
  readonly row_key: Record<string, unknown>;
  readonly changes: Record<string, unknown>;
  readonly four_eyes_columns: readonly string[];
  readonly role: "administrator" | "compliance";
  readonly proposed_by: string;
  readonly proposed_by_name: string;
  readonly proposed_at: Date;
  readonly proposed_reason: string;
  readonly decision: ProposalDecision | null;
  readonly decided_by: string | null;
  readonly decided_by_name: string | null;
  readonly decided_at: Date | null;
  readonly decided_reason: string | null;
  readonly applied_at: Date | null;
  /**
   * How many OTHER holders of the grant could decide it, right now.
   *
   * Carried on the read rather than computed by a screen, because zero is the answer that
   * needs saying: a tenant with one compliance officer cannot arm the unattended write-off
   * job, which is the whole point of the rule for that switch, and an administrator staring
   * at a proposal that will never move deserves to be told why rather than left to infer it.
   */
  readonly eligible_deciders: number;
}

/** A rep who could decide a proposal — returned so the caller can tell them. */
export interface ProposalDecider {
  readonly rep_profile_id: string;
  readonly display_name: string;
}

export const PROPOSAL_LIST_LIMIT = 200;

const PROPOSAL_COLUMNS = `
  p.id::text AS id, p.table_name, p.row_key, p.changes, p.four_eyes_columns, p.role,
  p.proposed_by::text AS proposed_by, pr.display_name AS proposed_by_name,
  p.proposed_at, p.proposed_reason,
  p.decision, p.decided_by::text AS decided_by, dr.display_name AS decided_by_name,
  p.decided_at, p.decided_reason, p.applied_at,
  crm.config_proposal_eligible_deciders(p.id) AS eligible_deciders`;

const PROPOSAL_FROM = `
  FROM crm.config_proposal p
  -- An INNER join on the proposer that cannot hide a row: the composite key to
  -- crm.rep_profile is ON DELETE RESTRICT, so a proposer named by a record cannot be
  -- deleted while it exists. LEFT on the decider, which is null while it waits.
  JOIN crm.rep_profile pr ON pr.id = p.proposed_by
  LEFT JOIN crm.rep_profile dr ON dr.id = p.decided_by`;

/**
 * The register itself, which is a read rather than a constant.
 *
 * Served so an administrator can see which changes take two people BEFORE attempting one,
 * and so the claim is the database's. A TypeScript copy of this list would be a second
 * opinion, and the one thing worse than a rule nobody can enumerate is two that disagree.
 */
export async function fourEyesRules(tx: PoolClient): Promise<readonly FourEyesRule[]> {
  const { rows } = await tx.query<FourEyesRule>(
    `SELECT table_name, column_name, direction, role, note
       FROM crm.four_eyes_rule ORDER BY table_name, column_name, direction`,
  );
  return rows;
}

/**
 * Which of a proposed set of values would need a second person.
 *
 * Asked by a route BEFORE it writes, so it can propose instead of attempting a write it
 * knows will be refused. Not the authority — `crm.require_four_eyes` asks the same question
 * again as the write lands, and that is what enforces the rule — but the two agreeing is
 * what lets a route answer "this needs two people" rather than translating a trigger's
 * refusal into a guess about what the caller should do next.
 *
 * `changes` is keyed by column and holds the values being WRITTEN, because the rule is
 * directional: turning the write-off switch off is not the change the rule is about.
 */
export async function fourEyesRequired(
  tx: PoolClient,
  tableName: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<readonly string[]> {
  const { rows } = await tx.query<{ cols: string[] }>(
    "SELECT crm.four_eyes_required($1, $2::jsonb) AS cols",
    [tableName, JSON.stringify(changes)],
  );
  return rows[0]?.cols ?? [];
}

export interface ProposeInput {
  readonly tableName: string;
  /** The row's PRIMARY KEY columns, as `crm.config_change.row_key` spells them. */
  readonly rowKey: Readonly<Record<string, unknown>>;
  /** Column to proposed value. The value, because the apply-time check compares it. */
  readonly changes: Readonly<Record<string, unknown>>;
  /** From the authenticated principal, never from a request body. */
  readonly proposedBy: string;
  readonly reason: string;
}

export interface ProposeResult {
  readonly proposal: ConfigProposal;
  readonly deciders: readonly ProposalDecider[];
}

/**
 * Records a change somebody is asking for and cannot make alone.
 *
 * `four_eyes_columns` and `role` are STAMPED FROM THE REGISTER rather than accepted, for the
 * reason 0059 stamps a change's `from` values: a proposal whose claim about why it needed two
 * people came from the caller is not evidence of anything. A caller who asks to propose a
 * change that needs nobody's approval is refused here rather than given a proposal that
 * authorises a write it was never needed for.
 */
export async function proposeConfigChange(
  tx: PoolClient,
  tenantId: string,
  input: ProposeInput,
): Promise<ProposeResult> {
  const { rows } = await query<{ id: string }>(
    tx,
    `WITH needed AS (
       SELECT crm.four_eyes_required($2, $4::jsonb) AS cols
     )
     INSERT INTO crm.config_proposal
       (tenant_id, table_name, row_key, changes, four_eyes_columns, role,
        proposed_by, proposed_reason)
     SELECT $1, $2, $3::jsonb, $4::jsonb, n.cols,
            crm.four_eyes_role($2, n.cols), $5, $6
       FROM needed n
      WHERE cardinality(n.cols) > 0
     RETURNING id::text AS id`,
    [
      tenantId,
      input.tableName,
      JSON.stringify(input.rowKey),
      JSON.stringify(input.changes),
      input.proposedBy,
      input.reason,
    ],
  );

  const id = rows[0]?.id;
  if (id === undefined) {
    // No rule matched, so there is nothing to approve. Refused rather than recorded: a
    // proposal that authorises a change needing no authority would be a row an inspector
    // would read as "two people agreed this was dangerous".
    throw new NoFourEyesRuleError(
      `changing ${Object.keys(input.changes).sort().join(", ")} of crm.${input.tableName} does not need a second person, so there is nothing to propose — make the change`,
    );
  }
  const proposal = await requireProposal(tx, tenantId, id);
  return { proposal, deciders: await proposalDeciders(tx, tenantId, id) };
}

/**
 * A proposal nobody needed to approve.
 *
 * Its own class rather than a generic validation error because the remedy is specific and
 * cheerful: just make the change. It means a route asked `fourEyesRequired` and acted on a
 * different answer, or a client called the propose path directly for a change that never
 * needed it.
 */
export class NoFourEyesRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFourEyesRuleError";
  }
}

/** A proposal id that names nothing in this tenant. Row-level security makes those one case. */
export class ConfigProposalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigProposalNotFoundError";
  }
}

export async function configProposal(
  tx: PoolClient,
  tenantId: string,
  id: string,
): Promise<ConfigProposal | null> {
  const { rows } = await tx.query<ConfigProposal>(
    `SELECT ${PROPOSAL_COLUMNS} ${PROPOSAL_FROM} WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

async function requireProposal(
  tx: PoolClient,
  tenantId: string,
  id: string,
): Promise<ConfigProposal> {
  const found = await configProposal(tx, tenantId, id);
  if (found === null) throw new ConfigProposalNotFoundError(`no proposal ${id} in this tenant`);
  return found;
}

/**
 * A tenant's proposals, newest first, optionally only the ones still waiting.
 *
 * Both reads matter and they are different questions. "What is waiting" is the queue an
 * approver works through; "what happened" is the record of who agreed to what, and it has to
 * include the rejected and the withdrawn — a proposal somebody refused is as much a fact as
 * one they allowed.
 */
export async function configProposals(
  tx: PoolClient,
  tenantId: string,
  opts: { readonly pendingOnly?: boolean; readonly limit?: number } = {},
): Promise<readonly ConfigProposal[]> {
  const limit = Math.max(1, Math.min(PROPOSAL_LIST_LIMIT, opts.limit ?? 50));
  const { rows } = await tx.query<ConfigProposal>(
    `SELECT ${PROPOSAL_COLUMNS} ${PROPOSAL_FROM}
      WHERE p.tenant_id = $1 AND ($2::boolean IS NOT TRUE OR p.decision IS NULL)
      -- Newest first, and deterministically: proposed_at is clock_timestamp() rather than
      -- now(), so two proposals made in one transaction do not tie.
      ORDER BY p.proposed_at DESC, p.id DESC
      LIMIT $3`,
    [tenantId, opts.pendingOnly ?? false, limit],
  );
  return rows;
}

/** Who could decide this proposal — everybody holding the grant except whoever asked. */
export async function proposalDeciders(
  tx: PoolClient,
  tenantId: string,
  id: string,
): Promise<readonly ProposalDecider[]> {
  const { rows } = await tx.query<ProposalDecider>(
    `SELECT h.rep_profile_id::text AS rep_profile_id, h.display_name
       FROM crm.config_proposal p
       CROSS JOIN LATERAL crm.role_holders(p.role) h
      WHERE p.tenant_id = $1 AND p.id = $2 AND h.rep_profile_id <> p.proposed_by
      ORDER BY h.display_name`,
    [tenantId, id],
  );
  return rows;
}

/**
 * Records a decision, through the database function that holds the rules.
 *
 * `crm.decide_config_proposal` rather than an UPDATE from here, for `crm.revoke_rep_role`'s
 * reason: "it is still pending", "the decider is not the proposer", "the decider holds the
 * grant" and "approving a departed proposer's request is agreeing with nobody" are rules
 * that must not be restatable by a second caller, and a function is the only place they can
 * live where every path goes through them.
 *
 * It does NOT apply the change. The caller approves and then performs the write with the
 * proposal named in its attribution block, so the apply goes through the same
 * `crm.require_four_eyes` as any other path.
 */
export async function decideConfigProposal(
  tx: PoolClient,
  tenantId: string,
  id: string,
  decision: ProposalDecision,
  decidedBy: string,
  reason: string,
): Promise<ConfigProposal> {
  // TRANSLATED HERE, not only inside `withAttribution`.
  //
  // 0061 put the translation in that wrapper because every refusal it knew about came from a
  // write to an attributed table, and every such write is inside one. These are not: rejecting
  // and withdrawing touch `crm.config_proposal`, which is not under attribution, so their
  // routes open no block — and the first version of them answered 500 to "you cannot reject
  // your own proposal", which is a sentence the caller needed and a status that told them to
  // report a bug instead.
  //
  // The lesson is that translation belongs with the statement that can raise, not with a
  // wrapper that happens to enclose most of them.
  try {
    await tx.query("SELECT crm.decide_config_proposal($1, $2, $3, $4)", [
      id,
      decision,
      decidedBy,
      reason,
    ]);
  } catch (err) {
    throw translateAttributionError(err);
  }
  return requireProposal(tx, tenantId, id);
}
