import type { PoolClient } from "pg";

import { raiseNotification } from "./raise.js";

/**
 * Telling whoever can act on a change that takes two people (0062, 0063).
 *
 * THE PROBLEM IS THAT THE AUDIENCE MOVES. `config_change_awaiting_approval` goes out when a
 * proposal is made, to whoever held the governing grant at that moment — and the two cases
 * that matter most are the ones a single raise cannot cover: a tenant whose only compliance
 * officer asks for something (nobody to tell), and an officer appointed afterwards (eligible
 * for everything pending, told about none of it). 0062's browser gate measured the first as a
 * zero rather than leaving it to be guessed.
 *
 * So this answers "who should know about this NOW" from the live roster, and the scheduler
 * calls it every tick. The route that creates a proposal calls the SAME function, scoped to
 * the one proposal it just made, which is what keeps the immediate notice and the catch-up
 * from drifting into two sentences about one fact.
 *
 * HERE RATHER THAN IN `@crm/db`, which depends on `pg` and nothing else and so cannot reach
 * `raiseNotification`. 0062 worked around that by having the proposal store RETURN the people
 * who should be told and leaving the route to tell them — a seam a caller can forget, which is
 * a defect this repository has shipped more than once. There is no seam now: there is a
 * function, and both callers call it.
 */

export interface PendingApprovalSweep {
  /** Proposals still undecided in this tenant. */
  readonly pending: number;
  /** Notices raised by this pass — the newly-eligible, and the newly-blocked. */
  readonly notified: number;
  /** Pairs that were already told. The steady state: almost every tick is all of these. */
  readonly alreadyKnown: number;
  /**
   * Proposals with nobody eligible to decide them.
   *
   * The number an operator wants in the line, because it is the one state the product cannot
   * fix for itself: a tenant with one compliance officer cannot arm the unattended write-off
   * job, which is the point of the rule for that switch, and the remedy is an administrator
   * appointing a second officer.
   */
  readonly blocked: number;
  /**
   * Blocked proposals with nobody to tell about them either.
   *
   * A tenant with exactly one administrator who proposes an administrator-governed change is
   * stuck AND unreportable: the only person who could appoint a colleague is the person
   * waiting. Counted rather than notified, because the alternative is telling somebody what
   * they already know, and this line is the end of the chain.
   */
  readonly unreportable: number;
}

interface NoticeRow {
  readonly proposal_id: string;
  readonly table_name: string;
  readonly four_eyes_columns: readonly string[];
  readonly role: string;
  readonly proposed_by_name: string;
  readonly proposed_reason: string;
  readonly recipient: string;
  readonly why: "can_decide" | "can_unblock";
}

/**
 * Who should be told what, right now.
 *
 * `crm.role_holders` answers from the live grants, which is the whole point — a sweep that
 * re-derived the audience from anything stored at proposal time would be the raise it is
 * replacing. It is tenant-scoped by row-level security rather than by an argument, like every
 * other read in this schema.
 *
 * TWO AUDIENCES IN ONE QUERY, and `blocked` is defined by the absence of the first: a proposal
 * nobody can decide is reported to the administrators, who are the people who can appoint
 * somebody who can. Never the proposer, in either arm — they know, and a notification telling
 * somebody about their own request is how an inbox becomes something to ignore.
 */
const NOTICES_SQL = `
  WITH pending AS (
    SELECT p.id, p.role, p.proposed_by, p.table_name, p.four_eyes_columns, p.proposed_reason,
           pr.display_name AS proposed_by_name
      FROM crm.config_proposal p
      JOIN crm.rep_profile pr ON pr.id = p.proposed_by
     WHERE p.tenant_id = $1 AND p.decision IS NULL
       AND ($2::uuid IS NULL OR p.id = $2::uuid)
  ),
  deciders AS (
    SELECT p.id AS proposal_id, p.table_name, p.four_eyes_columns, p.role,
           p.proposed_by_name, p.proposed_reason,
           h.rep_profile_id AS recipient, 'can_decide' AS why
      FROM pending p
      CROSS JOIN LATERAL crm.role_holders(p.role) h
     WHERE h.rep_profile_id <> p.proposed_by
  ),
  blocked AS (
    SELECT p.id AS proposal_id, p.table_name, p.four_eyes_columns, p.role,
           p.proposed_by_name, p.proposed_reason,
           h.rep_profile_id AS recipient, 'can_unblock' AS why
      FROM pending p
      CROSS JOIN LATERAL crm.role_holders('administrator') h
     WHERE h.rep_profile_id <> p.proposed_by
       AND NOT EXISTS (SELECT 1 FROM deciders d WHERE d.proposal_id = p.id)
  )
  SELECT proposal_id::text AS proposal_id, table_name, four_eyes_columns, role,
         proposed_by_name, proposed_reason, recipient::text AS recipient, why
    FROM deciders
   UNION ALL
  SELECT proposal_id::text AS proposal_id, table_name, four_eyes_columns, role,
         proposed_by_name, proposed_reason, recipient::text AS recipient, why
    FROM blocked
   ORDER BY proposal_id, why, recipient`;

/**
 * Raises what is missing, and counts what was already there.
 *
 * IDEMPOTENT BY THE DEDUP KEY, which is the only thing making this safe to run every tick:
 * `crm.notification`'s uniqueness is `(tenant_id, recipient, dedup_key)` and the key names the
 * proposal and the reason for the notice, so an officer told at proposal time is not told
 * again and a proposal that sits for months produces one notice per person. That also means
 * there is NO escalation — a request nobody acts on is never raised again — which is a
 * deliberate choice against nagging and is recorded as open rather than hidden.
 *
 * `onlyProposalId` is how the route tells the people who can act on the proposal it just made,
 * through this same function. Without it, the sweep's scope is the tenant.
 */
export async function notifyPendingApprovals(
  tx: PoolClient,
  tenantId: string,
  opts: { readonly onlyProposalId?: string } = {},
): Promise<PendingApprovalSweep> {
  const { rows } = await tx.query<NoticeRow>(NOTICES_SQL, [
    tenantId,
    opts.onlyProposalId ?? null,
  ]);

  // The pending ids, which is also the count. Two queries did this a moment ago — one
  // `count(*)` and one `SELECT id` over the same predicate — which is two chances for the
  // number in the log line and the set the arithmetic below uses to disagree.
  const { rows: pendingRows } = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM crm.config_proposal
      WHERE tenant_id = $1 AND decision IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)`,
    [tenantId, opts.onlyProposalId ?? null],
  );

  let notified = 0;
  let alreadyKnown = 0;
  for (const notice of rows) {
    const result = await raiseNotification(tx, tenantId, buildNotice(notice));
    if (result.created) notified += 1;
    else alreadyKnown += 1;
  }

  // Derived from the SAME rows the notices came from rather than counted separately, so the
  // two cannot disagree about which proposals had a decider.
  const decidable = new Set(
    rows.filter((r) => r.why === "can_decide").map((r) => r.proposal_id),
  );
  const reportable = new Set(
    rows.filter((r) => r.why === "can_unblock").map((r) => r.proposal_id),
  );
  const blockedIds = pendingRows.map((r) => r.id).filter((id) => !decidable.has(id));
  return {
    pending: pendingRows.length,
    notified,
    alreadyKnown,
    blocked: blockedIds.length,
    unreportable: blockedIds.filter((id) => !reportable.has(id)).length,
  };
}

/**
 * The sentence, which differs by what the reader can do about it.
 *
 * A DECIDER is told they can approve it and cannot approve their own — the second half
 * because the queue shows every pending proposal and the rule is easier to meet than to
 * discover. An ADMINISTRATOR who cannot decide it is told what it actually needs, which is a
 * second holder of the grant, because "approve this" to somebody who may not is worse than
 * silence.
 *
 * The dedup keys differ for the same reason: one person can legitimately receive both notices
 * about one proposal — an administrator who is also the tenant's only compliance officer is
 * told nothing as a decider (they proposed it) and told as an unblocker — and a shared key
 * would make the second notice disappear into the first.
 */
function buildNotice(n: NoticeRow): Parameters<typeof raiseNotification>[2] {
  const what = n.four_eyes_columns.join(", ");
  const common = {
    kind: "config_change_awaiting_approval" as const,
    // `warning` rather than `info`: nothing is broken, but a colleague is blocked on this
    // reader specifically, and the queue is short by design.
    severity: "warning" as const,
    recipientRepProfileId: n.recipient,
    subjectTable: "crm.config_proposal",
    subjectId: n.proposal_id,
    payload: { tableName: n.table_name, columns: n.four_eyes_columns, why: n.why },
  };
  if (n.why === "can_decide") {
    return {
      ...common,
      subject: `${n.proposed_by_name} needs a second signature on ${what}`,
      body:
        `${n.proposed_by_name} asked to change ${what} on ${n.table_name} — ` +
        `"${n.proposed_reason}". It takes two people, so it cannot happen until you or ` +
        `another holder of the ${n.role} grant approves it. You cannot approve your own.`,
      dedupKey: `config_proposal:${n.proposal_id}:awaiting`,
    };
  }
  return {
    ...common,
    subject: `A change to ${what} is stuck: nobody can approve it`,
    body:
      `${n.proposed_by_name} asked to change ${what} on ${n.table_name} — ` +
      `"${n.proposed_reason}". It takes two different people and there is nobody else in ` +
      `this tenant holding the ${n.role} grant, so it cannot be approved by anyone. ` +
      `Granting ${n.role} to a second rep is what unblocks it, and that is yours to do.`,
    dedupKey: `config_proposal:${n.proposal_id}:blocked`,
  };
}
