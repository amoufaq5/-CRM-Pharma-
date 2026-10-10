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
  /**
   * Proposals past their deadline and still undecided (0064).
   *
   * Counted separately from `blocked` because they are different problems: a blocked proposal
   * has nobody who may act on it, an overdue one has somebody who has not. A proposal can be
   * both, and is counted in both.
   */
  readonly overdue: number;
  /**
   * Escalation notices raised by this pass — the `urgent` second kind.
   *
   * Included in `notified` as well, which this pass's own total is: splitting them out is for
   * the log line, because a tick that escalated something is the one an operator wants to see
   * in a column of zeroes.
   */
  readonly escalated: number;
}

interface NoticeRow {
  readonly proposal_id: string;
  readonly table_name: string;
  readonly four_eyes_columns: readonly string[];
  readonly role: string;
  readonly proposed_by_name: string;
  readonly proposed_reason: string;
  readonly recipient: string;
  readonly why: "can_decide" | "can_unblock" | "overdue";
  /** Past `decide_by`, as the SWEEP's clock sees it — see `asOf`. */
  readonly overdue: boolean;
  /** Whole days it has been waiting, for the sentence an escalation carries. */
  readonly waiting_days: number;
}

/**
 * Who should be told what, right now.
 *
 * `crm.role_holders` answers from the live grants, which is the whole point — a sweep that
 * re-derived the audience from anything stored at proposal time would be the raise it is
 * replacing. It is tenant-scoped by row-level security rather than by an argument, like every
 * other read in this schema.
 *
 * THREE AUDIENCES IN ONE QUERY. `blocked` is defined by the absence of the first: a proposal
 * nobody can decide is reported to the administrators, who are the people who can appoint
 * somebody who can. `escalation` (0064) is the third and overlaps both on purpose — an overdue
 * proposal goes to everybody who could have acted on it and to the administrators besides,
 * because what has gone wrong is that nobody did. Never the proposer, in any arm: they know,
 * and a notification telling somebody about their own request is how an inbox becomes something
 * to ignore.
 */
const NOTICES_SQL = `
  WITH pending AS (
    SELECT p.id, p.role, p.proposed_by, p.table_name, p.four_eyes_columns, p.proposed_reason,
           pr.display_name AS proposed_by_name,
           (p.decide_by < $3::timestamptz) AS overdue,
           GREATEST(0, floor(EXTRACT(EPOCH FROM ($3::timestamptz - p.proposed_at)) / 86400))::int
             AS waiting_days
      FROM crm.config_proposal p
      JOIN crm.rep_profile pr ON pr.id = p.proposed_by
     WHERE p.tenant_id = $1 AND p.decision IS NULL
       AND ($2::uuid IS NULL OR p.id = $2::uuid)
  ),
  deciders AS (
    SELECT p.id AS proposal_id, p.table_name, p.four_eyes_columns, p.role,
           p.proposed_by_name, p.proposed_reason, p.overdue, p.waiting_days,
           h.rep_profile_id AS recipient, 'can_decide' AS why
      FROM pending p
      CROSS JOIN LATERAL crm.role_holders(p.role) h
     WHERE h.rep_profile_id <> p.proposed_by
  ),
  blocked AS (
    SELECT p.id AS proposal_id, p.table_name, p.four_eyes_columns, p.role,
           p.proposed_by_name, p.proposed_reason, p.overdue, p.waiting_days,
           h.rep_profile_id AS recipient, 'can_unblock' AS why
      FROM pending p
      CROSS JOIN LATERAL crm.role_holders('administrator') h
     WHERE h.rep_profile_id <> p.proposed_by
       AND NOT EXISTS (SELECT 1 FROM deciders d WHERE d.proposal_id = p.id)
  ),
  -- 0064. The ESCALATION arm, and it is deliberately not the same set as either arm above.
  -- An overdue proposal goes to the people who can decide it AND to the administrators — who
  -- are told even when the proposal is perfectly decidable, because the thing that has gone
  -- wrong is that nobody decided it, and that is the layer which can ask why. The two arms
  -- above are mutually exclusive by construction; this one overlaps both on purpose, and the
  -- dedup key is what stops one person getting the same escalation twice.
  escalation AS (
    SELECT p.id AS proposal_id, p.table_name, p.four_eyes_columns, p.role,
           p.proposed_by_name, p.proposed_reason, p.overdue, p.waiting_days,
           h.rep_profile_id AS recipient, 'overdue' AS why
      FROM pending p
      CROSS JOIN LATERAL (
        SELECT rep_profile_id FROM crm.role_holders(p.role)
         UNION
        SELECT rep_profile_id FROM crm.role_holders('administrator')
      ) h
     WHERE p.overdue AND h.rep_profile_id <> p.proposed_by
  )
  SELECT proposal_id::text AS proposal_id, table_name, four_eyes_columns, role,
         proposed_by_name, proposed_reason, overdue, waiting_days,
         recipient::text AS recipient, why
    FROM deciders
   UNION ALL
  SELECT proposal_id::text AS proposal_id, table_name, four_eyes_columns, role,
         proposed_by_name, proposed_reason, overdue, waiting_days,
         recipient::text AS recipient, why
    FROM blocked
   UNION ALL
  SELECT proposal_id::text AS proposal_id, table_name, four_eyes_columns, role,
         proposed_by_name, proposed_reason, overdue, waiting_days,
         recipient::text AS recipient, why
    FROM escalation
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
 *
 * `asOf` is the clock the deadline is measured against, injected rather than taken, exactly as
 * `sweepExpiredStock` and `pruneNotifications` take theirs. It is what lets a test assert an
 * escalation without a fixture reaching past `config_proposal_decided_once` to back-date a
 * frozen column — and a sweep whose idea of "late" came from somewhere other than its caller
 * is a sweep no test can pin.
 */
export async function notifyPendingApprovals(
  tx: PoolClient,
  tenantId: string,
  opts: { readonly onlyProposalId?: string; readonly asOf?: Date } = {},
): Promise<PendingApprovalSweep> {
  const asOf = opts.asOf ?? new Date();
  const { rows } = await tx.query<NoticeRow>(NOTICES_SQL, [
    tenantId,
    opts.onlyProposalId ?? null,
    asOf,
  ]);

  // The pending ids, which is also the count. Two queries did this a moment ago — one
  // `count(*)` and one `SELECT id` over the same predicate — which is two chances for the
  // number in the log line and the set the arithmetic below uses to disagree.
  const { rows: pendingRows } = await tx.query<{ id: string; overdue: boolean }>(
    `SELECT id::text AS id, (decide_by < $3::timestamptz) AS overdue
       FROM crm.config_proposal
      WHERE tenant_id = $1 AND decision IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)`,
    [tenantId, opts.onlyProposalId ?? null, asOf],
  );

  let notified = 0;
  let alreadyKnown = 0;
  let escalated = 0;
  for (const notice of rows) {
    const result = await raiseNotification(tx, tenantId, buildNotice(notice));
    if (result.created) {
      notified += 1;
      if (notice.why === "overdue") escalated += 1;
    } else {
      alreadyKnown += 1;
    }
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
    // Counted from the pending rows rather than from the notices, because a proposal can be
    // overdue AND have nobody to tell — the notices would show neither, and the number an
    // operator needs is how many are late rather than how many letters went out about it.
    overdue: pendingRows.filter((r) => r.overdue).length,
    escalated,
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
  if (n.why === "overdue") {
    return {
      ...common,
      // THE SECOND KIND, and it has to be named here rather than inherited: `common` carries
      // the first one, and the first version of this branch overrode the severity and the
      // sentence and not the kind — so an `urgent` escalation went out as
      // `config_change_awaiting_approval`, which is the kind an operator routes somewhere
      // quiet. Caught by the suite asserting on kinds rather than on counts.
      kind: "config_change_approval_overdue" as const,
      // URGENT, and it is the only `urgent` this file raises. The two notices above are
      // `warning` because somebody is blocked on the reader; this one is `urgent` because the
      // thing that has gone wrong is that nobody acted on the first one.
      severity: "urgent" as const,
      subject: `Overdue: ${what} has been waiting ${n.waiting_days} day(s) for a second signature`,
      body:
        `${n.proposed_by_name} asked to change ${what} on ${n.table_name} ` +
        `${n.waiting_days} day(s) ago — "${n.proposed_reason}" — and it is past the date it ` +
        `should have been decided by. It takes a second holder of the ${n.role} grant to ` +
        `approve or reject it, and nothing happens until somebody does. This is the only ` +
        `reminder: nobody will be told again.`,
      dedupKey: `config_proposal:${n.proposal_id}:overdue`,
    };
  }
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
