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
  /**
   * The sender took it back before it was accepted.
   *
   * The counterpart to the kind above, and the reason it exists: that one told the
   * receiver material was waiting for them, and after a recall that notification names
   * material sitting in somebody else's bag. Correcting it is not optional — a rep who
   * goes looking for stock the inbox promised them has been sent on an errand by us.
   */
  "sample_transfer_recalled",
  /**
   * A write to the ERP failed permanently.
   *
   * The one signal about something the rep believes already happened: the CRM recorded it,
   * their app said so, and the half they cannot see never landed.
   */
  "erp_write_failed",
  /**
   * An approved claim could not be handed to the ERP, and a human has to unblock it.
   *
   * Raised by the `expense_post` sweep (0031), which is the one scheduled job that acts on
   * money. It fires for the refusals the sweep cannot resolve on its own — the rep has no
   * `erp_employee_id`, or the claim's queued ERP write is already dead-lettered and only a
   * revive will move it — and not for a transport failure, which the outbox retries without
   * anyone's help.
   *
   * This sentence used to name a second case that cannot happen: "the claim's category
   * snapshot names no ledger account". That refusal is `UnmappedCategoryError` at
   * `submitClaim`, so such a claim never reaches `approved` and the sweep never sees it.
   * The sweep only ever caught `RepNotMappedToEmployeeError` until the dead-write block
   * above joined it.
   */
  "expense_post_blocked",
  /**
   * Somebody asked for a configuration change they cannot make alone (0062).
   *
   * The same shape as `call_plan_submitted` above and for the same reason: a request waiting
   * on a second person is a request that needs the second person TOLD. Goes to every other
   * holder of the grant the change answers to — the compliance officers for arming the
   * unattended write-off job, the administrators for re-pointing a ledger account — and
   * never to whoever asked, who already knows.
   *
   * Without it the approval queue is a screen somebody has to think to visit, which is how a
   * four-eyes rule becomes a reason to go back to the psql prompt that this whole lineage
   * exists to get away from.
   */
  "config_change_awaiting_approval",
  /**
   * A change that takes two people has been waiting past its deadline (0064).
   *
   * A SECOND KIND rather than a louder `config_change_awaiting_approval`, and the precedent is
   * `disposal_obligation_overdue` eight entries up: one subject, two facts, and an operator
   * routing kinds to a webhook wants to send the second somewhere the first does not go.
   *
   * Raised ONCE, at `urgent`, when `crm.config_proposal.decide_by` passes — to the people who
   * can decide it and to the administrators, who are the layer that can do something a decider
   * cannot. There is no third notice: escalation here is a state change, not a cadence, because
   * a reminder that arrives every week is one a reader learns to ignore.
   */
  "config_change_approval_overdue",
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
