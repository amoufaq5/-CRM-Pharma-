/**
 * Where a tenant's signals are pushed — the configuration half of the channel.
 *
 * Until now these rows were insertable only in SQL, because the API had no principal
 * it could restrict the write to (0023 gives it one). The store is here rather than in
 * @crm/role because the table belongs to notifications; the role only decides who may
 * call these functions.
 */
import type { PoolClient } from "pg";
import { NOTIFICATION_KINDS, SEVERITIES, type NotificationKind, type Severity } from "./kinds.js";

export class InvalidEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEndpointError";
  }
}

export interface EndpointRow {
  readonly id: string;
  readonly channel: string;
  readonly url: string;
  readonly secret_env: string;
  readonly min_severity: Severity;
  readonly kinds: readonly NotificationKind[] | null;
  readonly enabled: boolean;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateEndpointInput {
  readonly url: string;
  readonly secretEnv: string;
  readonly minSeverity?: Severity;
  /** null means every kind. A non-empty array is an allow-list. */
  readonly kinds?: readonly string[] | null;
  readonly description?: string | null;
  readonly enabled?: boolean;
}

export interface UpdateEndpointInput {
  readonly minSeverity?: Severity;
  readonly kinds?: readonly string[] | null;
  readonly description?: string | null;
  readonly enabled?: boolean;
}

/**
 * Lists endpoints. NEVER returns a secret, because it never holds one — `secret_env`
 * is the name of an environment variable and the database has only ever had the name.
 *
 * Ordered oldest-first and then by URL, NOT "in creation order": `now()` is the
 * transaction timestamp, so two endpoints created in one transaction share `created_at`
 * exactly and nothing records which INSERT came first. The URL breaks that tie with
 * something a reader can predict, where the id would break it at random.
 */
export async function listEndpoints(tx: PoolClient, tenantId: string): Promise<readonly EndpointRow[]> {
  const { rows } = await tx.query<EndpointRow>(
    `SELECT id, channel, url, secret_env, min_severity, kinds, enabled, description,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM crm.notification_endpoint
      WHERE tenant_id = $1
      ORDER BY created_at, url, id`,
    [tenantId],
  );
  return rows;
}

export async function getEndpoint(tx: PoolClient, id: string): Promise<EndpointRow | null> {
  const { rows } = await tx.query<EndpointRow>(
    `SELECT id, channel, url, secret_env, min_severity, kinds, enabled, description,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM crm.notification_endpoint WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createEndpoint(
  tx: PoolClient,
  tenantId: string,
  input: CreateEndpointInput,
): Promise<EndpointRow> {
  const kinds = normaliseKinds(input.kinds);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm.notification_endpoint
       (tenant_id, channel, url, secret_env, min_severity, kinds, description, enabled)
     VALUES ($1, 'webhook', $2, $3, COALESCE($4, 'warning'), $5::text[], $6, COALESCE($7, true))
     RETURNING id`,
    [
      tenantId,
      input.url,
      input.secretEnv,
      input.minSeverity ?? null,
      kinds,
      input.description ?? null,
      input.enabled ?? null,
    ],
  );
  return (await getEndpoint(tx, rows[0]!.id))!;
}

/**
 * Changes the knobs, and only the knobs.
 *
 * `url` and `secret_env` are deliberately not updatable. Repointing an endpoint in
 * place would carry its delivery history onto a different destination, so the honest
 * record of "these notifications went there" would start describing somewhere else.
 * Moving a destination is: disable the old endpoint, create a new one.
 */
export async function updateEndpoint(
  tx: PoolClient,
  id: string,
  input: UpdateEndpointInput,
): Promise<EndpointRow | null> {
  const kindsGiven = Object.prototype.hasOwnProperty.call(input, "kinds");
  const kinds = kindsGiven ? normaliseKinds(input.kinds) : null;
  const { rowCount } = await tx.query(
    `UPDATE crm.notification_endpoint
        SET min_severity = COALESCE($2, min_severity),
            kinds        = CASE WHEN $3::boolean THEN $4::text[] ELSE kinds END,
            description  = CASE WHEN $5::boolean THEN $6::text ELSE description END,
            enabled      = COALESCE($7, enabled),
            updated_at   = now()
      WHERE id = $1`,
    [
      id,
      input.minSeverity ?? null,
      kindsGiven,
      kinds,
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      input.enabled ?? null,
    ],
  );
  if (rowCount === 0) return null;
  return await getEndpoint(tx, id);
}

/**
 * Validates and narrows the kind allow-list.
 *
 * Done here as well as in the database because `crm.notification_endpoint.kinds` is a
 * bare text[] with no CHECK against the kind vocabulary — a kind that does not exist
 * would be accepted and then match nothing, so the endpoint would be silently dead.
 * That asymmetry with `crm.notification.kind` (which does have the CHECK) is noted in
 * ADR-0001; this is the guard until the array has one of its own.
 */
function normaliseKinds(kinds: readonly string[] | null | undefined): string[] | null {
  if (kinds === null || kinds === undefined) return null;
  if (kinds.length === 0) {
    throw new InvalidEndpointError("kinds must be a non-empty array, or null for every kind");
  }
  const unknown = kinds.filter((k) => !(NOTIFICATION_KINDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new InvalidEndpointError(
      `unknown notification kind(s): ${unknown.join(", ")}. ` +
        `An endpoint filtered to a kind that does not exist receives nothing.`,
    );
  }
  return [...new Set(kinds)].sort();
}

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}
