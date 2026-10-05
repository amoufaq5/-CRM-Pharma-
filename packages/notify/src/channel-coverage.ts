/**
 * Is every channel this deployment has endpoints for actually sendable by this binary?
 *
 * WHAT THIS ANSWERS, AND WHEN. `dispatch.ts` retries a delivery whose channel no sender in
 * the process registers, which is right — a missing sender is a fact about the binary and
 * not about the destination, and the notification is deliverable the moment a process that
 * has the channel takes a tick. But it means a channel NOBODY ever registers burns
 * `MAX_ATTEMPTS` per delivery before dead-lettering, and until the first delivery is
 * already late nothing has told the operator their endpoint is unsendable. This says it
 * once, at boot, before anything is late.
 *
 * WHY IT IS A WARNING AND NEVER A REFUSAL TO BOOT. `SmtpSender`'s constructor refuses a
 * plaintext relay to a remote host at boot rather than per send, and the precedent is
 * tempting. It does not transfer, for three reasons:
 *
 *   * That refusal is a statement about THIS PROCESS'S OWN configuration, decidable from
 *     the environment alone, and no deployment has a legitimate version of it. This one is
 *     a statement about TENANT DATA, which changes while the process runs: an
 *     administrator can create an `email` endpoint a minute after a webhook-only scheduler
 *     booted, so a refusal at boot guarantees nothing a later tick would honour.
 *   * The blast radius is inverted. Refusing to start takes down relay drain, the expiry
 *     sweep and expense posting FOR EVERY TENANT because one tenant configured one
 *     endpoint this binary cannot serve. A notification that retries is late; a scheduler
 *     that will not start means a rep's write never reaches the ERP at all.
 *   * A deployment deliberately running webhooks only, with one disabled email endpoint
 *     left in the table, must not be bricked by a row that sends nothing.
 *
 * So the verdict is data, the caller logs it, and a deployment that wants strictness can
 * read `verdict` and decide to exit. What this module will not do is decide that for it.
 *
 * WHY IT IS PER TENANT, AND WHY THAT IS THE INTERESTING PART. `crm.notification_endpoint`
 * is tenant-scoped under FORCED row-level security, and boot happens before any tenant
 * context exists — so a single cross-tenant `SELECT DISTINCT channel` at boot returns
 * exactly zero rows, correctly and silently. There is no privileged read available either:
 * `crm_app` is `NOBYPASSRLS` by rule 1, and a `SECURITY DEFINER` aggregate is refused by
 * `packages/db/src/schema.contract.test.ts`. The only thing a boot-time check can see
 * without a tenant is `crm.tenant`, the one deliberately RLS-exempt registry — so the
 * shape is: the caller enumerates tenants from its own one definition of "active tenant",
 * and this asks each of them in its own transaction. The gap is reported per tenant,
 * because "channel email is unsendable" without a tenant id is not something an operator
 * can act on.
 */
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";

import type { ChannelSender } from "./sender.js";

export const CHANNEL_COVERAGE_VERDICTS = ["covered", "dormant", "unsendable"] as const;
export type ChannelCoverageVerdict = (typeof CHANNEL_COVERAGE_VERDICTS)[number];

/** One (tenant, channel) pair and how many endpoints name it. */
export interface EndpointChannelUsage {
  readonly tenantId: string;
  readonly channel: string;
  readonly enabled: number;
  readonly disabled: number;
}

export interface ChannelCoverage {
  /**
   * `unsendable` — at least one ENABLED endpoint names a channel with no sender here.
   * `dormant`    — only disabled endpoints do, so nothing is late yet.
   * `covered`    — every configured channel has a sender, including the case of no
   *                endpoints at all.
   */
  readonly verdict: ChannelCoverageVerdict;
  /** The channels this process registers, sorted. Named in every line below. */
  readonly registered: readonly string[];
  readonly tenantsChecked: number;
  readonly unsendable: readonly EndpointChannelUsage[];
  readonly dormant: readonly EndpointChannelUsage[];
  /** One sentence per gap, in the order an operator should read them. */
  readonly lines: readonly string[];
  /** The one line to log when there is nothing else to say. */
  readonly summary: string;
}

/**
 * What the boot check returns: the verdict, plus the tenants it could not ask.
 *
 * `unreadable` is its own field rather than folded into a verdict, because "we could not
 * look" is not a coverage answer and must not read like one — a `covered` report with a
 * non-empty `unreadable` is covered as far as it got, and the caller's log line should say
 * so.
 */
export interface ChannelCoverageReport extends ChannelCoverage {
  readonly unreadable: readonly string[];
}

interface ChannelRow {
  readonly channel: string;
  readonly enabled_endpoints: string;
  readonly disabled_endpoints: string;
}

/**
 * The channels one tenant has configured. Must be called inside `withTenantContext`, or
 * RLS returns nothing — which is the correct fail-closed answer and also indistinguishable
 * from "this tenant has no endpoints", so `checkChannelCoverage` below owns the context
 * rather than trusting a caller to remember.
 */
export async function endpointChannelUsage(
  tx: PoolClient,
  tenantId: string,
): Promise<readonly EndpointChannelUsage[]> {
  const { rows } = await tx.query<ChannelRow>(
    "SELECT channel, enabled_endpoints, disabled_endpoints FROM crm.notification_endpoint_channels()",
  );
  return rows.map((r) => ({
    tenantId,
    channel: r.channel,
    // bigint comes back as a string from node-postgres; Number() here rather than in the
    // SQL because a count that overflowed a double would mean a tenant with 2^53 endpoints.
    enabled: Number(r.enabled_endpoints),
    disabled: Number(r.disabled_endpoints),
  }));
}

/**
 * The verdict, as a pure function of what is configured and what is registered.
 *
 * Separate from the query so the whole decision table can be exercised without a database,
 * and so the sentences are written once.
 *
 * THE VOICE IS DELIBERATELY `dispatch.ts`'s. That module's retry reason reads "no sender
 * registered for channel email in this process — it registers webhook", and an operator
 * who meets both messages is meeting one fault. Matching them is what lets them tell
 * "wrong binary" from "wrong endpoint": the channel names the row, the registered list
 * names the process.
 */
export function assessChannelCoverage(
  usage: readonly EndpointChannelUsage[],
  senders: readonly Pick<ChannelSender, "channel">[],
  tenantsChecked: number,
): ChannelCoverage {
  const registered = [...new Set(senders.map((s) => s.channel))].sort();
  const known = new Set(registered);
  const registeredList = registered.join(", ") || "none";

  const uncovered = [...usage]
    .filter((u) => !known.has(u.channel))
    // Sorted by channel then tenant, so the same fault reads the same way on every boot
    // and a log diff between two deploys is about the fault rather than about row order.
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.tenantId.localeCompare(b.tenantId));

  const unsendable = uncovered.filter((u) => u.enabled > 0);
  const dormant = uncovered.filter((u) => u.enabled === 0);

  const lines = [
    ...unsendable.map(
      (u) =>
        `no sender registered for channel ${u.channel} in this process — it registers ${registeredList}; ` +
        `tenant ${u.tenantId} has ${String(u.enabled)} enabled endpoint(s) on it, and every delivery to ` +
        `them will retry until it dead-letters`,
    ),
    ...dormant.map(
      (u) =>
        `no sender registered for channel ${u.channel} in this process — it registers ${registeredList}; ` +
        `tenant ${u.tenantId} has ${String(u.disabled)} disabled endpoint(s) on it, so nothing is late — ` +
        `but enabling one would be unsendable here`,
    ),
  ];

  const verdict: ChannelCoverageVerdict =
    unsendable.length > 0 ? "unsendable" : dormant.length > 0 ? "dormant" : "covered";

  return {
    verdict,
    registered,
    tenantsChecked,
    unsendable,
    dormant,
    lines,
    summary: summarise(verdict, registeredList, usage, unsendable, dormant, tenantsChecked),
  };
}

function summarise(
  verdict: ChannelCoverageVerdict,
  registeredList: string,
  usage: readonly EndpointChannelUsage[],
  unsendable: readonly EndpointChannelUsage[],
  dormant: readonly EndpointChannelUsage[],
  tenantsChecked: number,
): string {
  const tenants = `${String(tenantsChecked)} tenant(s)`;
  if (verdict === "unsendable") {
    return (
      `${String(unsendable.length)} of the channel/tenant pairs configured across ${tenants} cannot be sent ` +
      `by this process, which registers ${registeredList}`
    );
  }
  if (verdict === "dormant") {
    return (
      `every enabled endpoint across ${tenants} has a sender here (${registeredList}), but ` +
      `${String(dormant.length)} channel/tenant pair(s) are configured on disabled endpoints this process ` +
      `could not send`
    );
  }
  if (usage.length === 0) {
    // Said rather than skipped: a webhook-only deployment with no endpoints at all looks
    // identical to a healthy one in every other log line, and "no endpoints" is the answer
    // to "why did nobody get paged".
    return `no notification endpoint is configured in any of the ${tenants} checked; this process registers ${registeredList}`;
  }
  const channels = [...new Set(usage.map((u) => u.channel))].sort().join(", ");
  return `every configured channel (${channels}) has a sender in this process, which registers ${registeredList}`;
}

/**
 * The boot-time check. One short transaction per tenant.
 *
 * Takes the tenant ids rather than reading `crm.tenant` itself: "which tenants does this
 * deployment serve" already has exactly one definition (`activeTenants` in
 * `@crm/scheduler`), and a second copy here would be a second thing to keep in step —
 * importing it is not an option either, since that package depends on this one.
 *
 * A tenant whose query fails does NOT fail the check. Its gap is reported as unknown
 * rather than as absent, because "we could not look" and "there is nothing there" are the
 * two answers a coverage report must never conflate — and a boot check that threw would
 * stop a scheduler for a reason unrelated to sending anything.
 */
export async function checkChannelCoverage(
  pool: Pool,
  tenantIds: readonly string[],
  senders: readonly Pick<ChannelSender, "channel">[],
): Promise<ChannelCoverageReport> {
  const client = await pool.connect();
  const usage: EndpointChannelUsage[] = [];
  const unreadable: string[] = [];
  try {
    for (const tenantId of tenantIds) {
      try {
        const rows = await withTenantContext(client, tenantId, (tx) => endpointChannelUsage(tx, tenantId));
        usage.push(...rows);
      } catch {
        unreadable.push(tenantId);
      }
    }
  } finally {
    client.release();
  }

  const coverage = assessChannelCoverage(usage, senders, tenantIds.length);
  if (unreadable.length === 0) return { ...coverage, unreadable };
  return {
    ...coverage,
    unreadable,
    lines: [
      ...coverage.lines,
      `channel coverage could not be read for ${String(unreadable.length)} tenant(s) ` +
        `(${unreadable.join(", ")}); an unsendable channel there would not appear above`,
    ],
  };
}
