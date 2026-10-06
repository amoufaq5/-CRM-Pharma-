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

/**
 * The channels an endpoint row may name — 0029's
 * `notification_endpoint_channel_check`, in TypeScript.
 *
 * Duplicated from the CHECK on purpose, and `endpoints.contract.test.ts` compares the two
 * against `pg_constraint` so the copy cannot drift. The point is where the refusal lands:
 * a channel this process cannot send is a 422 naming the legal values, not a constraint
 * violation surfacing as a 500 from the bottom of the stack.
 */
export const ENDPOINT_CHANNELS = ["webhook", "email"] as const;
export type EndpointChannel = (typeof ENDPOINT_CHANNELS)[number];

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
  /**
   * Required, with no default.
   *
   * It was a literal `'webhook'` in the INSERT until now, which is why 0029 could add the
   * email channel to the CHECK and leave it unreachable: nothing above SQL could name it.
   * A default would have the same effect for the next channel, so there is none — and the
   * url shape is channel-dependent (0029), so a caller that does not know which channel
   * it means does not know whether its url is valid either.
   */
  readonly channel: EndpointChannel;
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
  if (!(ENDPOINT_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new InvalidEndpointError(
      `channel must be one of ${ENDPOINT_CHANNELS.join(", ")}, not ${JSON.stringify(input.channel)}`,
    );
  }
  let id: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO crm.notification_endpoint
         (tenant_id, channel, url, secret_env, min_severity, kinds, description, enabled)
       VALUES ($1, $8, $2, $3, COALESCE($4, 'warning'), $5::text[], $6, COALESCE($7, true))
       RETURNING id`,
      [
        tenantId,
        input.url,
        input.secretEnv,
        input.minSeverity ?? null,
        kinds,
        input.description ?? null,
        input.enabled ?? null,
        input.channel,
      ],
    );
    id = rows[0]!.id;
  } catch (err) {
    throw translateEndpointError(err, input.channel);
  }
  return (await getEndpoint(tx, id))!;
}

/**
 * Changes the knobs, and only the knobs.
 *
 * `url` and `secret_env` are deliberately not updatable. Repointing an endpoint in
 * place would carry its delivery history onto a different destination, so the honest
 * record of "these notifications went there" would start describing somewhere else.
 * Moving a destination is: disable the old endpoint, create a new one.
 *
 * Since 0049 that is a rule and not just an omission: `notification_endpoint_freeze_destination`
 * refuses a change to `channel`, `url` or `secret_env` from any writer, so this UPDATE's
 * silence about those columns is the database's answer too and not merely this function's.
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
 * `notification_endpoint_kinds_known` (0049) is the real rule — the array is checked
 * against `crm.notification_kinds()`, the one place the vocabulary is now declared, so a
 * kind that does not exist is refused by the database rather than accepted and then
 * matching nothing. This stays in front of it for two things the constraint cannot do:
 * it dedups and sorts, so two spellings of the same allow-list store identically; and it
 * names every unknown kind at once, where the constraint can only say the array failed.
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

/**
 * The table's CHECKs, as the sentences a 422 can carry.
 *
 * Without this an endpoint refused by the database reached the client as a 500 "an
 * unexpected error occurred" — including the plaintext-url refusal, which is one of the
 * most deliberate rules in the schema (0021: a notification carries a rep's name and an
 * account id, so it does not travel in the clear). The url rule is CHANNEL-DEPENDENT since
 * 0029, so the message names the channel the caller actually asked for; a flat "that url
 * is invalid" would be unactionable for exactly the mismatch 0029 exists to catch.
 */
function translateEndpointError(err: unknown, channel: string): Error {
  const constraint = (err as { constraint?: string }).constraint;
  if (constraint === "notification_endpoint_url_check") {
    return new InvalidEndpointError(
      channel === "email"
        ? "an email endpoint's url must be a single mailto: mailbox — one delivery has one outcome, " +
          "so one endpoint is one destination"
        : "a webhook endpoint's url must be https:// (or http:// to loopback, for a local sink) — " +
          "a notification carries a rep's name and an account id and does not travel in the clear",
    );
  }
  if (constraint === "notification_endpoint_channel_check") {
    return new InvalidEndpointError(`channel must be one of ${ENDPOINT_CHANNELS.join(", ")}, not ${channel}`);
  }
  if (constraint === "notification_endpoint_secret_env_check") {
    return new InvalidEndpointError("secretEnv must be the NAME of an environment variable, not a secret value");
  }
  if (constraint === "notification_endpoint_min_severity_check") {
    return new InvalidEndpointError(`minSeverity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (constraint === "notification_endpoint_kinds_not_empty") {
    return new InvalidEndpointError("kinds must be a non-empty array, or null for every kind");
  }
  if (constraint === "notification_endpoint_kinds_known") {
    // Reachable only from SQL or from a kind this build does not know about: `normaliseKinds`
    // refuses an unknown kind first and names it. The sentence is therefore the general one.
    return new InvalidEndpointError(
      `kinds must be drawn from: ${NOTIFICATION_KINDS.join(", ")}. ` +
        `An endpoint filtered to a kind that does not exist receives nothing.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}
