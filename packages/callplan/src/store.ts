import type { PoolClient } from "pg";
import { raiseForSupervisors, raiseNotification } from "@crm/notify";

import {
  CallPlanNotFoundError,
  InvalidCycleError,
  translateCallPlanError,
} from "./errors.js";

/**
 * Cycles and call plans.
 *
 * Every function takes a `PoolClient` already inside `withTenantContext`, like the
 * rest of the CRM's stores: RLS confines the queries, and a caller who forgets the
 * wrapper sees no rows rather than everyone's.
 */

export interface Cycle {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly starts_on: string;
  readonly ends_on: string;
  readonly status: "planning" | "active" | "closed";
}

export type CallPlanStatus = "draft" | "submitted" | "approved" | "superseded" | "withdrawn";

export interface CallPlan {
  readonly id: string;
  readonly cycle_id: string;
  readonly rep_profile_id: string;
  readonly status: CallPlanStatus;
  readonly revision: number;
  readonly submitted_by: string | null;
  readonly submitted_at: Date | null;
  readonly approved_by: string | null;
  readonly approved_at: Date | null;
  readonly superseded_by: string | null;
}

export interface CallPlanTarget {
  readonly id: string;
  readonly erp_account_id: string;
  readonly erp_contact_id: string | null;
  readonly segment: string | null;
  readonly target_calls: number;
  readonly notes: string | null;
}

export interface CallPlanProduct {
  readonly id: string;
  readonly erp_item_id: string;
  readonly position: number;
  readonly key_message: string | null;
}

export interface TargetAdherence {
  readonly target_id: string;
  readonly erp_account_id: string;
  readonly erp_contact_id: string | null;
  readonly segment: string | null;
  readonly target_calls: number;
  readonly actual_calls: number;
  readonly met: boolean;
  readonly last_call_at: Date | null;
}

export interface PlanSummary {
  readonly targets: number;
  readonly targets_met: number;
  readonly targets_touched: number;
  readonly planned_calls: number;
  readonly actual_calls: number;
  /** Null when the plan has no targets: no denominator, so no honest percentage. */
  readonly coverage_pct: string | null;
  readonly attainment_pct: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CYCLE_COLUMNS = "id, code, name, starts_on::text AS starts_on, ends_on::text AS ends_on, status";
const PLAN_COLUMNS =
  "id, cycle_id, rep_profile_id, status, revision, submitted_by, submitted_at, approved_by, approved_at, superseded_by";

export async function createCycle(
  tx: PoolClient,
  tenantId: string,
  input: { code: string; name: string; startsOn: string; endsOn: string },
): Promise<Cycle> {
  for (const [label, value] of [
    ["startsOn", input.startsOn],
    ["endsOn", input.endsOn],
  ] as const) {
    if (!DATE_RE.test(value)) {
      throw new InvalidCycleError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
    }
  }
  try {
    const { rows } = await tx.query<Cycle>(
      `INSERT INTO crm.cycle (tenant_id, code, name, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CYCLE_COLUMNS}`,
      [tenantId, input.code, input.name, input.startsOn, input.endsOn],
    );
    return rows[0]!;
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

export async function activateCycle(tx: PoolClient, cycleId: string): Promise<Cycle> {
  const { rows } = await tx.query<Cycle>(
    `UPDATE crm.cycle SET status = 'active', updated_at = now()
      WHERE id = $1 AND status = 'planning'
      RETURNING ${CYCLE_COLUMNS}`,
    [cycleId],
  );
  if (rows[0] === undefined) throw new InvalidCycleError(`cycle ${cycleId} is not in planning`);
  return rows[0];
}

export async function listCycles(tx: PoolClient, opts: { status?: string } = {}): Promise<readonly Cycle[]> {
  const { rows } = await tx.query<Cycle>(
    `SELECT ${CYCLE_COLUMNS} FROM crm.cycle
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY starts_on DESC, code`,
    [opts.status ?? null],
  );
  return rows;
}

/** The cycle covering a date — what a mobile client asks for on launch. */
export async function cycleOn(tx: PoolClient, on: string): Promise<Cycle | null> {
  const { rows } = await tx.query<Cycle>(
    `SELECT ${CYCLE_COLUMNS} FROM crm.cycle
      WHERE $1::date BETWEEN starts_on AND ends_on AND status <> 'closed'
      ORDER BY starts_on DESC LIMIT 1`,
    [on],
  );
  return rows[0] ?? null;
}

export async function createPlan(
  tx: PoolClient,
  tenantId: string,
  input: { cycleId: string; repProfileId: string; revision?: number },
): Promise<CallPlan> {
  try {
    const { rows } = await tx.query<CallPlan>(
      `INSERT INTO crm.call_plan (tenant_id, cycle_id, rep_profile_id, revision)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PLAN_COLUMNS}`,
      [tenantId, input.cycleId, input.repProfileId, input.revision ?? 1],
    );
    return rows[0]!;
  } catch (err) {
    throw translateCallPlanError(err, { cycleId: input.cycleId, repProfileId: input.repProfileId });
  }
}

export async function getPlan(tx: PoolClient, planId: string): Promise<CallPlan | null> {
  const { rows } = await tx.query<CallPlan>(`SELECT ${PLAN_COLUMNS} FROM crm.call_plan WHERE id = $1`, [planId]);
  return rows[0] ?? null;
}

export async function livePlanFor(
  tx: PoolClient,
  input: { cycleId: string; repProfileId: string },
): Promise<CallPlan | null> {
  const { rows } = await tx.query<CallPlan>(
    `SELECT ${PLAN_COLUMNS} FROM crm.call_plan
      WHERE cycle_id = $1 AND rep_profile_id = $2
        AND status IN ('draft','submitted','approved')`,
    [input.cycleId, input.repProfileId],
  );
  return rows[0] ?? null;
}

export async function listPlans(
  tx: PoolClient,
  opts: { repProfileId?: string; cycleId?: string; status?: CallPlanStatus } = {},
): Promise<readonly CallPlan[]> {
  const { rows } = await tx.query<CallPlan>(
    `SELECT ${PLAN_COLUMNS} FROM crm.call_plan
      WHERE ($1::uuid IS NULL OR rep_profile_id = $1)
        AND ($2::uuid IS NULL OR cycle_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC`,
    [opts.repProfileId ?? null, opts.cycleId ?? null, opts.status ?? null],
  );
  return rows;
}

export async function addTarget(
  tx: PoolClient,
  tenantId: string,
  input: {
    planId: string;
    erpAccountId: string;
    erpContactId?: string | null;
    segment?: string | null;
    targetCalls: number;
    notes?: string | null;
  },
): Promise<CallPlanTarget> {
  try {
    const { rows } = await tx.query<CallPlanTarget>(
      `INSERT INTO crm.call_plan_target
         (tenant_id, call_plan_id, erp_account_id, erp_contact_id, segment, target_calls, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, erp_account_id::text AS erp_account_id, erp_contact_id::text AS erp_contact_id,
                 segment, target_calls, notes`,
      [
        tenantId,
        input.planId,
        input.erpAccountId,
        input.erpContactId ?? null,
        input.segment ?? null,
        input.targetCalls,
        input.notes ?? null,
      ],
    );
    return rows[0]!;
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

export async function removeTarget(tx: PoolClient, targetId: string): Promise<boolean> {
  try {
    const { rowCount } = await tx.query(`DELETE FROM crm.call_plan_target WHERE id = $1`, [targetId]);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

export async function listTargets(tx: PoolClient, planId: string): Promise<readonly CallPlanTarget[]> {
  const { rows } = await tx.query<CallPlanTarget>(
    `SELECT id, erp_account_id::text AS erp_account_id, erp_contact_id::text AS erp_contact_id,
            segment, target_calls, notes
       FROM crm.call_plan_target WHERE call_plan_id = $1
      ORDER BY erp_account_id, erp_contact_id NULLS FIRST`,
    [planId],
  );
  return rows;
}

/**
 * Replaces the plan's product emphasis wholesale.
 *
 * Positions are assigned from the array order rather than taken from the caller,
 * so a gap or a duplicate cannot be expressed. Same approach as a visit's
 * detailing lines.
 */
export async function setPlanProducts(
  tx: PoolClient,
  tenantId: string,
  planId: string,
  products: ReadonlyArray<{ erpItemId: string; keyMessage?: string | null }>,
): Promise<readonly CallPlanProduct[]> {
  try {
    await tx.query(`DELETE FROM crm.call_plan_product WHERE call_plan_id = $1`, [planId]);
    const out: CallPlanProduct[] = [];
    for (const [index, p] of products.entries()) {
      const { rows } = await tx.query<CallPlanProduct>(
        `INSERT INTO crm.call_plan_product (tenant_id, call_plan_id, erp_item_id, position, key_message)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, erp_item_id::text AS erp_item_id, position, key_message`,
        [tenantId, planId, p.erpItemId, index + 1, p.keyMessage ?? null],
      );
      out.push(rows[0]!);
    }
    return out;
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

export async function listPlanProducts(tx: PoolClient, planId: string): Promise<readonly CallPlanProduct[]> {
  const { rows } = await tx.query<CallPlanProduct>(
    `SELECT id, erp_item_id::text AS erp_item_id, position, key_message
       FROM crm.call_plan_product WHERE call_plan_id = $1 ORDER BY position`,
    [planId],
  );
  return rows;
}

/**
 * Submits a plan for approval, and tells whoever can approve it.
 *
 * The notification goes to `crm.supervisors_of` the plan's rep — the same hierarchy that
 * decides whether an approval is allowed (0016), so the people told are exactly the people
 * who can act. A submitted plan previously sat in a queue nobody was informed about.
 */
export async function submitPlan(
  tx: PoolClient,
  planId: string,
  submittedBy: string,
  now = new Date(),
): Promise<CallPlan> {
  const plan = await transition(tx, planId, {
    sql: `UPDATE crm.call_plan
             SET status = 'submitted', submitted_by = $2, submitted_at = $3, updated_at = now()
           WHERE id = $1
           RETURNING ${PLAN_COLUMNS}`,
    params: [planId, submittedBy, now],
  });

  const { rows } = await tx.query<{ display_name: string; cycle_code: string; tenant_id: string }>(
    `SELECT rp.display_name, c.code AS cycle_code, cp.tenant_id
       FROM crm.call_plan cp
       JOIN crm.rep_profile rp ON rp.id = cp.rep_profile_id
       JOIN crm.cycle c ON c.id = cp.cycle_id
      WHERE cp.id = $1`,
    [planId],
  );
  const info = rows[0];
  if (info !== undefined) {
    await raiseForSupervisors(tx, info.tenant_id, plan.rep_profile_id, {
      kind: "call_plan_submitted",
      severity: "info",
      subject: `${info.display_name} submitted a call plan for ${info.cycle_code}`,
      body:
        `${info.display_name}'s call plan for cycle ${info.cycle_code} is waiting for approval. ` +
        `You cannot approve a plan you submitted yourself.`,
      // Keyed on the plan and the revision-independent event: a plan returned and
      // resubmitted is the same plan, and re-notifying on every resubmission would train
      // the manager to ignore it.
      dedupKey: `call_plan:${planId}:submitted`,
      subjectTable: "crm.call_plan",
      subjectId: planId,
      payload: { cycleCode: info.cycle_code, repDisplayName: info.display_name },
    });
  }
  return plan;
}

/** Sends a submitted plan back for rework. The round trip the lifecycle map allows. */
export async function returnPlanToDraft(tx: PoolClient, planId: string): Promise<CallPlan> {
  const plan = await transition(tx, planId, {
    sql: `UPDATE crm.call_plan
             SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now()
           WHERE id = $1
           RETURNING ${PLAN_COLUMNS}`,
    params: [planId],
  });
  await notifyPlanOwner(tx, plan, "call_plan_returned", "sent back for rework", null);
  return plan;
}

/**
 * Tells the rep whose plan it is what happened to it.
 *
 * The decision is news to them and to nobody else, so it does not go up the hierarchy —
 * the approver already knows, having just made it.
 */
async function notifyPlanOwner(
  tx: PoolClient,
  plan: CallPlan,
  kind: "call_plan_approved" | "call_plan_returned",
  verb: string,
  note: string | null,
): Promise<void> {
  const { rows } = await tx.query<{ tenant_id: string; cycle_code: string }>(
    `SELECT cp.tenant_id, c.code AS cycle_code
       FROM crm.call_plan cp JOIN crm.cycle c ON c.id = cp.cycle_id
      WHERE cp.id = $1`,
    [plan.id],
  );
  const info = rows[0];
  if (info === undefined) return;
  await raiseNotification(tx, info.tenant_id, {
    recipientRepProfileId: plan.rep_profile_id,
    kind,
    severity: "info",
    subject: `Your call plan for ${info.cycle_code} was ${verb}`,
    body:
      `Your call plan for cycle ${info.cycle_code} was ${verb}.` +
      (note !== null && note !== "" ? ` Note: ${note}` : "") +
      (kind === "call_plan_returned" ? " It is editable again." : ""),
    // Includes the revision, so a resubmitted-and-re-decided plan notifies again — unlike
    // the submission, where a repeat would be noise, a second decision is new information.
    dedupKey: `call_plan:${plan.id}:${kind}:r${plan.revision}`,
    subjectTable: "crm.call_plan",
    subjectId: plan.id,
    payload: { cycleCode: info.cycle_code, revision: plan.revision },
  });
}

/**
 * Approves a plan.
 *
 * Four-eyes and the approver's authority over the rep's territory are both
 * enforced by the database (0015 CHECKs, 0016 trigger); this just names the actor
 * and translates the refusal.
 */
export async function approvePlan(
  tx: PoolClient,
  planId: string,
  approvedBy: string,
  opts: { note?: string | null; now?: Date } = {},
): Promise<CallPlan> {
  const plan = await transition(tx, planId, {
    sql: `UPDATE crm.call_plan
             SET status = 'approved', approved_by = $2, approved_at = $3, approval_note = $4, updated_at = now()
           WHERE id = $1
           RETURNING ${PLAN_COLUMNS}`,
    params: [planId, approvedBy, opts.now ?? new Date(), opts.note ?? null],
  });
  await notifyPlanOwner(tx, plan, "call_plan_approved", "approved", opts.note ?? null);
  return plan;
}

export async function withdrawPlan(tx: PoolClient, planId: string): Promise<CallPlan> {
  return transition(tx, planId, {
    sql: `UPDATE crm.call_plan SET status = 'withdrawn', updated_at = now()
           WHERE id = $1 RETURNING ${PLAN_COLUMNS}`,
    params: [planId],
  });
}

/**
 * Replaces a plan with a fresh draft that inherits its targets and products.
 *
 * The only way to change an approved plan, and the reason freezing it is tolerable
 * rather than obstructive. Both rows survive: the original records what was agreed,
 * the replacement what was agreed instead.
 *
 * THE ORDER IS LOAD-BEARING. `uq_call_plan_live` permits one live plan per rep and
 * cycle, so the original has to leave the live set before the replacement enters
 * it — and `superseded` requires a successor that does not exist yet. Hence: mint
 * the successor's id, point the original at it (the self-FK is deferred to commit,
 * see 0015), then insert the successor. Every step is in the caller's transaction,
 * so no reader ever sees a cycle with no live plan or two.
 *
 * Targets are copied by default, because amending one line of a forty-account plan
 * should not mean retyping thirty-nine. A copied target is re-validated against the
 * territory rules, so if coverage has changed the supersede FAILS rather than
 * carrying forward a target the rep no longer covers; pass `copyTargets: false` and
 * add targets explicitly when that happens.
 */
export async function supersedePlan(
  tx: PoolClient,
  tenantId: string,
  planId: string,
  opts: { copyTargets?: boolean } = {},
): Promise<{ readonly superseded: CallPlan; readonly replacement: CallPlan }> {
  const existing = await getPlan(tx, planId);
  if (existing === null) throw new CallPlanNotFoundError(planId);

  try {
    const { rows: idRows } = await tx.query<{ id: string }>("SELECT gen_random_uuid() AS id");
    const replacementId = idRows[0]!.id;

    const { rows: oldRows } = await tx.query<CallPlan>(
      `UPDATE crm.call_plan
          SET status = 'superseded', superseded_by = $2, updated_at = now()
        WHERE id = $1
        RETURNING ${PLAN_COLUMNS}`,
      [planId, replacementId],
    );
    if (oldRows[0] === undefined) throw new CallPlanNotFoundError(planId);

    const { rows: newRows } = await tx.query<CallPlan>(
      `INSERT INTO crm.call_plan (id, tenant_id, cycle_id, rep_profile_id, revision)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PLAN_COLUMNS}`,
      [replacementId, tenantId, existing.cycle_id, existing.rep_profile_id, existing.revision + 1],
    );

    if (opts.copyTargets !== false) {
      await tx.query(
        `INSERT INTO crm.call_plan_target
           (tenant_id, call_plan_id, erp_account_id, erp_contact_id, segment, target_calls, notes)
         SELECT tenant_id, $2, erp_account_id, erp_contact_id, segment, target_calls, notes
           FROM crm.call_plan_target WHERE call_plan_id = $1`,
        [planId, replacementId],
      );
      await tx.query(
        `INSERT INTO crm.call_plan_product
           (tenant_id, call_plan_id, erp_item_id, position, key_message)
         SELECT tenant_id, $2, erp_item_id, position, key_message
           FROM crm.call_plan_product WHERE call_plan_id = $1`,
        [planId, replacementId],
      );
    }

    return { superseded: oldRows[0], replacement: newRows[0]! };
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

interface TransitionSpec {
  readonly sql: string;
  readonly params: readonly unknown[];
}

async function transition(tx: PoolClient, planId: string, spec: TransitionSpec): Promise<CallPlan> {
  try {
    const { rows } = await tx.query<CallPlan>(spec.sql, [...spec.params]);
    if (rows[0] === undefined) throw new CallPlanNotFoundError(planId);
    return rows[0];
  } catch (err) {
    throw translateCallPlanError(err);
  }
}

export async function planAdherence(tx: PoolClient, planId: string): Promise<readonly TargetAdherence[]> {
  const { rows } = await tx.query<TargetAdherence>(`SELECT * FROM crm.call_plan_adherence($1)`, [planId]);
  return rows;
}

export async function planSummary(tx: PoolClient, planId: string): Promise<PlanSummary> {
  const { rows } = await tx.query<PlanSummary>(`SELECT * FROM crm.call_plan_summary($1)`, [planId]);
  return rows[0]!;
}

export interface TeamAdherenceRow {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
  /** Null when the rep has no live plan for this cycle — the row still appears. */
  readonly call_plan_id: string | null;
  readonly plan_status: CallPlanStatus | null;
  readonly targets: number | null;
  readonly targets_met: number | null;
  readonly targets_touched: number | null;
  readonly planned_calls: number | null;
  readonly actual_calls: number | null;
  readonly coverage_pct: string | null;
  readonly attainment_pct: string | null;
}

/**
 * The territory review: one row per supervised rep for one cycle.
 *
 * A rep with no plan appears with nulls rather than being omitted. "Who has not got a
 * plan this cycle" is the first question this screen is opened to answer, and an inner
 * join would answer it by hiding them — the team would look fully covered because the
 * gaps were not in the result set.
 */
export async function teamAdherence(
  tx: PoolClient,
  managerRepProfileId: string,
  cycleId: string,
  on?: string,
): Promise<readonly TeamAdherenceRow[]> {
  const { rows } = await tx.query<TeamAdherenceRow>(
    `SELECT * FROM crm.cycle_team_adherence($1, $2, COALESCE($3::date, CURRENT_DATE))`,
    [managerRepProfileId, cycleId, on ?? null],
  );
  return rows;
}

/**
 * Plans belonging to a manager's team, newest first.
 *
 * Scoped by `crm.managed_rep_ids` in SQL rather than by a rep id the caller supplies:
 * a `?rep=` parameter the route filters on afterwards is one forgotten `AND` away from
 * reading a peer's plans.
 */
export async function teamPlans(
  tx: PoolClient,
  managerRepProfileId: string,
  opts: { cycleId?: string; status?: CallPlanStatus; on?: string } = {},
): Promise<ReadonlyArray<CallPlan & { readonly display_name: string }>> {
  const { rows } = await tx.query<CallPlan & { display_name: string }>(
    `SELECT ${PLAN_COLUMNS.split(", ").map((c) => `cp.${c}`).join(", ")}, rp.display_name
       FROM crm.call_plan cp
       JOIN crm.rep_profile rp ON rp.id = cp.rep_profile_id
      WHERE cp.rep_profile_id IN (
              SELECT rep_profile_id FROM crm.managed_rep_ids($1, COALESCE($4::date, CURRENT_DATE))
            )
        AND ($2::uuid IS NULL OR cp.cycle_id = $2)
        AND ($3::text IS NULL OR cp.status = $3)
      ORDER BY cp.created_at DESC`,
    [managerRepProfileId, opts.cycleId ?? null, opts.status ?? null, opts.on ?? null],
  );
  return rows;
}
