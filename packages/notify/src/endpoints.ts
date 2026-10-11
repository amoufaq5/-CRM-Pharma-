/**
 * Where a tenant's signals are pushed — the configuration half of the channel.
 *
 * Until now these rows were insertable only in SQL, because the API had no principal
 * it could restrict the write to (0023 gives it one). The store is here rather than in
 * @crm/role because the table belongs to notifications; the role only decides who may
 * call these functions.
 *
 * SINCE 0060, EVERY WRITE HERE IS ATTRIBUTED AND REASONED. 0023's header named this table
 * and `crm.disposal_policy` as the two that were "settable by anyone with the application
 * password, with no record of who changed what"; it answered who may, and left what
 * happened. Creating an endpoint adds a route out of the tenant for records carrying a
 * rep's name and an account id, and disabling one stops the signals with nobody told — so
 * the creation's author and reason are frozen columns on the row, and every amendment is a
 * row in an append-only log the tunable columns are a projection of. Neither is optional
 * and neither is this store's choice: the database refuses the write without them.
 */
import type { PoolClient } from "pg";
import { NOTIFICATION_KINDS, SEVERITIES, type NotificationKind, type Severity } from "./kinds.js";
import { PER_RECIPIENT_MARKER_URL } from "./smtp.js";

/**
 * The channels an endpoint row may name — 0029's
 * `notification_endpoint_channel_check`, in TypeScript.
 *
 * Duplicated from the CHECK on purpose, and `endpoints.contract.test.ts` compares the two
 * against `pg_constraint` so the copy cannot drift. The point is where the refusal lands:
 * a channel this process cannot send is a 422 naming the legal values, not a constraint
 * violation surfacing as a 500 from the bottom of the stack.
 */
export const ENDPOINT_CHANNELS = ["webhook", "email", "email_recipient"] as const;
export type EndpointChannel = (typeof ENDPOINT_CHANNELS)[number];

/**
 * An amendment the database refuses (0060).
 *
 * Its own class rather than `InvalidEndpointError`'s, because the two want different HTTP
 * answers and a client does different things with them: an invalid endpoint is a 422 and the
 * operator fixes what they typed, while "that amendment changes nothing" and "this column is
 * derived from the log" are well-formed requests the endpoint's own state refuses — a 409,
 * and nothing to retype.
 */
export class EndpointAmendmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointAmendmentError";
  }
}

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
  /**
   * Who added this destination, and why (0060).
   *
   * NULL only for an endpoint created before that rule, which is the honest record of a row
   * from before it rather than an invented author — the rule governs the ACT of creating, so
   * no existing row is in violation (0040's distinction, quoted by 0049).
   */
  readonly created_by: string | null;
  readonly created_by_name: string | null;
  readonly created_reason: string | null;
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
  /**
   * The rep opening this route, and why. Both required, and the database refuses the INSERT
   * without them — "adding a webhook" is not an answer to why a tenant's notifications now
   * leave the building.
   */
  readonly createdBy: string;
  readonly reason: string;
}

export interface UpdateEndpointInput {
  readonly minSeverity?: Severity;
  readonly kinds?: readonly string[] | null;
  readonly description?: string | null;
  readonly enabled?: boolean;
  readonly changedBy: string;
  readonly reason: string;
}

/** One amendment in an endpoint's history. */
export interface EndpointChange {
  readonly id: string;
  readonly endpoint_id: string;
  readonly changed_at: Date;
  readonly changed_by: string;
  readonly changed_by_name: string;
  readonly reason: string;
  readonly min_severity_from: Severity;
  readonly min_severity_to: Severity;
  readonly kinds_from: readonly NotificationKind[] | null;
  readonly kinds_to: readonly NotificationKind[] | null;
  readonly enabled_from: boolean;
  readonly enabled_to: boolean;
  readonly description_from: string | null;
  readonly description_to: string | null;
}

export const ENDPOINT_HISTORY_LIMIT = 200;

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
    `SELECT e.id, e.channel, e.url, e.secret_env, e.min_severity, e.kinds, e.enabled, e.description,
            e.created_by::text AS created_by, r.display_name AS created_by_name, e.created_reason,
            e.created_at::text AS created_at, e.updated_at::text AS updated_at
       FROM crm.notification_endpoint e
       -- LEFT, because an endpoint created before 0060 has no author and must still be
       -- listed: hiding a live destination because nobody signed for it is the opposite of
       -- what this read is for.
       LEFT JOIN crm.rep_profile r ON r.id = e.created_by
      WHERE e.tenant_id = $1
      ORDER BY e.created_at, e.url, e.id`,
    [tenantId],
  );
  return rows;
}

export async function getEndpoint(tx: PoolClient, id: string): Promise<EndpointRow | null> {
  const { rows } = await tx.query<EndpointRow>(
    `SELECT e.id, e.channel, e.url, e.secret_env, e.min_severity, e.kinds, e.enabled, e.description,
            e.created_by::text AS created_by, r.display_name AS created_by_name, e.created_reason,
            e.created_at::text AS created_at, e.updated_at::text AS updated_at
       FROM crm.notification_endpoint e
       LEFT JOIN crm.rep_profile r ON r.id = e.created_by
      WHERE e.id = $1`,
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
         (tenant_id, channel, url, secret_env, min_severity, kinds, description, enabled,
          created_by, created_reason)
       VALUES ($1, $8, $2, $3, COALESCE($4, 'warning'), $5::text[], $6, COALESCE($7, true),
               $9, $10)
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
        input.createdBy,
        input.reason,
      ],
    );
    id = rows[0]!.id;
  } catch (err) {
    throw translateEndpointError(err, input.channel);
  }
  return (await getEndpoint(tx, id))!;
}

/**
 * Changes the knobs, and only the knobs — by writing the amendment, which is the only way
 * there is.
 *
 * `url` and `secret_env` are not updatable. Repointing an endpoint in place would carry its
 * delivery history onto a different destination, so the honest record of "these
 * notifications went there" would start describing somewhere else. Moving a destination is:
 * disable the old endpoint, create a new one.
 *
 * Since 0049 that is a rule and not just an omission —
 * `notification_endpoint_freeze_destination` refuses a change to `channel`, `url` or
 * `secret_env` from any writer — and since 0060 the same trigger also refuses a rewrite of
 * `created_by` and `created_reason`, with a sentence of their own.
 *
 * SINCE 0060 THIS IS AN INSERT, not an UPDATE. The endpoint's four tunable columns are a
 * projection of `crm.notification_endpoint_change`; a direct UPDATE is refused by the
 * database. Two consequences worth stating:
 *
 *   * THE COMPLETE DESIRED STATE GOES IN, not just what moved. `kinds` NULL means every kind
 *     and `description` NULL means none, so in a partial record "not specified" and "set to
 *     null" are the same thing and a COALESCE against the live row would read "clear the
 *     allow-list" as "leave it alone". The merge happens here, in one place, over a row read
 *     `FOR UPDATE`.
 *   * THAT LOCK IS LOAD-BEARING. The trigger stamps the `*_from` values from the live row, so
 *     without it two administrators amending at once would each merge a stale copy and the
 *     second would silently revert a knob it never meant to touch. Reading for update is what
 *     makes the merge and the apply see one state.
 *
 * Returns null for an endpoint that is not there, as it always has.
 */
export async function updateEndpoint(
  tx: PoolClient,
  id: string,
  input: UpdateEndpointInput,
): Promise<EndpointRow | null> {
  const kindsGiven = Object.prototype.hasOwnProperty.call(input, "kinds");
  const kinds = kindsGiven ? normaliseKinds(input.kinds) : null;
  const { rows: live } = await tx.query<{
    tenant_id: string;
    min_severity: Severity;
    kinds: string[] | null;
    enabled: boolean;
    description: string | null;
  }>(
    `SELECT tenant_id, min_severity, kinds, enabled, description
       FROM crm.notification_endpoint WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const current = live[0];
  if (current === undefined) return null;

  try {
    await tx.query(
      `INSERT INTO crm.notification_endpoint_change
         (tenant_id, endpoint_id, changed_by, reason,
          min_severity_to, kinds_to, enabled_to, description_to)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)`,
      [
        current.tenant_id,
        id,
        input.changedBy,
        input.reason,
        input.minSeverity ?? current.min_severity,
        kindsGiven ? kinds : current.kinds,
        input.enabled ?? current.enabled,
        Object.prototype.hasOwnProperty.call(input, "description")
          ? (input.description ?? null)
          : current.description,
      ],
    );
  } catch (err) {
    throw translateEndpointError(err, "webhook");
  }
  return await getEndpoint(tx, id);
}

/**
 * How an endpoint got to its current tuning: every amendment, newest first.
 *
 * Administrator-only at the route, unlike the disposal policy's history — that one is a rule
 * every rep is measured against, and this is a list of the third parties a tenant talks to.
 */
export async function endpointHistory(
  tx: PoolClient,
  endpointId: string,
  opts: { readonly limit?: number } = {},
): Promise<readonly EndpointChange[]> {
  const limit = Math.max(1, Math.min(ENDPOINT_HISTORY_LIMIT, opts.limit ?? 50));
  const { rows } = await tx.query<EndpointChange>(
    `SELECT c.id::text AS id, c.endpoint_id::text AS endpoint_id, c.changed_at,
            c.changed_by::text AS changed_by, r.display_name AS changed_by_name, c.reason,
            c.min_severity_from, c.min_severity_to, c.kinds_from, c.kinds_to,
            c.enabled_from, c.enabled_to, c.description_from, c.description_to
       FROM crm.notification_endpoint_change c
       -- An INNER join, which cannot hide a row: the composite key to crm.rep_profile is
       -- ON DELETE RESTRICT, so an author named by an amendment cannot be deleted while the
       -- amendment exists, and RLS shows the caller every profile in their own tenant.
       JOIN crm.rep_profile r ON r.id = c.changed_by
      WHERE c.endpoint_id = $1
      ORDER BY c.changed_at DESC, c.id DESC
      LIMIT $2`,
    [endpointId, limit],
  );
  return rows;
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
  const message = (err as { message?: string }).message ?? "";
  // 0060's own refusals, which arrive as messages rather than constraint names because the
  // triggers raise them. Checked before the constraint arms below: a no-op amendment never
  // reaches a CHECK, because the trigger answers first.
  if (
    message.includes("endpoint amendment changes nothing") ||
    message.includes("cannot be updated directly") ||
    message.includes("endpoint-creation-frozen") ||
    message.includes("endpoint-destination-frozen") ||
    message.includes("must name the rep who added it")
  ) {
    return new EndpointAmendmentError(message);
  }
  if (constraint === "notification_endpoint_change_is_a_change") {
    return new EndpointAmendmentError("that endpoint amendment changes nothing");
  }
  if (constraint === "notification_endpoint_change_reason_check") {
    return new EndpointAmendmentError(
      "an amendment to an endpoint must say why, in at least ten characters — it is where this tenant's signals go",
    );
  }
  if (constraint === "notification_endpoint_created_reason_check") {
    return new InvalidEndpointError(
      "a new endpoint must say why it exists, in at least ten characters — it is a route out of this tenant for records carrying a rep's name",
    );
  }
  if (constraint === "notification_endpoint_url_check") {
    return new InvalidEndpointError(
      channel === "email"
        ? "an email endpoint's url must be a single mailto: mailbox — one delivery has one outcome, " +
          "so one endpoint is one destination"
        : channel === "email_recipient"
          ? // 0065. The url is not a destination on this channel and the CHECK pins it to the
            // marker, so the sentence has to say what the row is FOR rather than what is
            // wrong with what was typed — an administrator reaching this was trying to give
            // it a mailbox, which is the one thing this channel exists not to have.
            `an email_recipient endpoint's url must be exactly ${JSON.stringify(PER_RECIPIENT_MARKER_URL)} — ` +
            "on this channel the mailbox comes from whoever the notification names, so the row " +
            "carries a marker rather than a destination. A fixed mailbox is the email channel."
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
