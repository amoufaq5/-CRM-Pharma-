/**
 * What the CRM can tell someone about, and how loudly.
 *
 * A closed list, mirrored by the CHECK on `crm.notification.kind`, so a typo'd kind is
 * refused by the database rather than delivered to nobody. Each one exists because
 * something in this system produced a signal that previously ended in a log line.
 */
export const NOTIFICATION_KINDS = [
  /** The expiry sweep found expired stock in a rep's bag. */
  "disposal_obligation_raised",
  /** It is still there past the deadline. Goes to the rep AND up the hierarchy. */
  "disposal_obligation_overdue",
  /** A rep submitted a call plan; whoever can approve it is told. */
  "call_plan_submitted",
  "call_plan_approved",
  "call_plan_returned",
  /** Material was sent to a rep who has no other reason to expect it. */
  "sample_transfer_awaiting_acceptance",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const SEVERITIES = ["info", "warning", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

const RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, urgent: 2 };

/**
 * Whether a signal clears an endpoint's threshold.
 *
 * In one place because an endpoint that pages a human must not start firing on `info`
 * through a comparison written slightly differently somewhere else.
 */
export function meetsSeverity(severity: Severity, minimum: Severity): boolean {
  return RANK[severity] >= RANK[minimum];
}
