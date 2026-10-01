import type { PoolClient } from "pg";

import { assertDate } from "./errors.js";

/**
 * Supervision: which reps a manager is accountable for.
 *
 * Thin wrappers over the SQL in 0019 on purpose. The rules live there so the API, a
 * report and a background job get one answer, and RLS is no help — a manager and a
 * peer's rep are in the same tenant, so this predicate is the only thing between them.
 */

export interface TeamMember {
  readonly rep_profile_id: string;
  readonly display_name: string;
  readonly employee_number: string;
  readonly status: string;
  readonly territory_codes: readonly string[];
}

/** The rep ids a manager supervises, excluding themselves. */
export async function managedRepIds(
  tx: PoolClient,
  managerRepProfileId: string,
  on?: string,
): Promise<readonly string[]> {
  if (on !== undefined) assertDate("on", on);
  const { rows } = await tx.query<{ rep_profile_id: string }>(
    `SELECT rep_profile_id FROM crm.managed_rep_ids($1, COALESCE($2::date, CURRENT_DATE))`,
    [managerRepProfileId, on ?? null],
  );
  return rows.map((r) => r.rep_profile_id);
}

/**
 * Whether a caller may read a rep's records. True for themselves.
 *
 * The single-rep form, for an authorisation check on a record already in hand — the
 * same shape as `canSeeAccount`, and used the same way.
 */
export async function canSupervise(
  tx: PoolClient,
  managerRepProfileId: string,
  repProfileId: string,
  on?: string,
): Promise<boolean> {
  if (on !== undefined) assertDate("on", on);
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT crm.rep_can_supervise($1, $2, COALESCE($3::date, CURRENT_DATE)) AS ok`,
    [managerRepProfileId, repProfileId, on ?? null],
  );
  return rows[0]?.ok === true;
}

export async function teamRoster(
  tx: PoolClient,
  managerRepProfileId: string,
  on?: string,
): Promise<readonly TeamMember[]> {
  if (on !== undefined) assertDate("on", on);
  const { rows } = await tx.query<TeamMember>(
    `SELECT rep_profile_id, display_name, employee_number, status, territory_codes
       FROM crm.team_roster($1, COALESCE($2::date, CURRENT_DATE))`,
    [managerRepProfileId, on ?? null],
  );
  return rows;
}
