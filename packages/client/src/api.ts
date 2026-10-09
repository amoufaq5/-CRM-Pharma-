import { z } from "zod";

/**
 * The wire contracts this client speaks, as the API declares them.
 *
 * WHY THESE ARE DECLARED AGAIN HERE. `packages/api` builds its request schemas inside
 * `buildRoutes` and depends on `pg`, so importing them would drag the server — and a
 * Postgres driver — into a browser bundle. So the client carries its own copy, with two
 * consequences accepted deliberately:
 *
 *   1. it VALIDATES WHAT IT RECEIVES rather than trusting it. A response that does not
 *      parse is a bug worth surfacing at the boundary, not three screens later as
 *      `undefined is not a function`;
 *   2. it can drift from the server. Nothing compares the two statically, so
 *      `scripts/verify-client-live.sh` drives this client's own code against a real
 *      running API — agreement proven by use, which is stronger than two files that look
 *      alike. A generated client is the real fix and is recorded as open.
 *
 * The shapes below are copied from `packages/api/src/handlers/routes.ts` at the commit
 * that added this package; the regexes are its `ERP_ID` and `ISO_DATE` verbatim, because
 * a client that accepts an id the server's CHECK constraint refuses has only moved the
 * failure to the far side of a queue.
 */

/** `crm.erp_record_id`'s domain constraint, verbatim. */
export const ErpRecordId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, "not a valid ERP record id");
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const Uuid = z.string().uuid();

export const VISIT_STATUSES = ["planned", "in_progress", "completed", "cancelled", "missed"] as const;
export const VISIT_TYPES = [
  "detailing",
  "follow_up",
  "sample_drop",
  "training",
  "cycle_meeting",
  "other",
] as const;
export const VISIT_OUTCOMES = ["successful", "no_access", "rescheduled", "declined"] as const;
export const PRODUCT_REACTIONS = ["positive", "neutral", "negative", "not_discussed"] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];
export type VisitType = (typeof VISIT_TYPES)[number];

/**
 * What `POST /v1/visits` and each element of `POST /v1/sync/visits` accept.
 *
 * `id` is required and minted on the DEVICE — `crm.visit.id` has no default, and that is
 * what makes a replay idempotent: the server upserts by this id, so the same visit sent
 * twice after a dropped connection collapses into one row instead of two call reports.
 */
export const VisitBody = z.object({
  id: Uuid,
  erpAccountId: ErpRecordId,
  erpContactId: ErpRecordId.nullish(),
  visitType: z.enum(VISIT_TYPES).optional(),
  status: z.enum(VISIT_STATUSES).optional(),
  plannedFor: IsoDate.nullish(),
  occurredAt: z.string().datetime({ offset: true }).nullish(),
  durationMinutes: z.number().int().min(0).max(1440).nullish(),
  checkin: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyM: z.number().min(0).optional(),
    })
    .nullish(),
  outcome: z.enum(VISIT_OUTCOMES).nullish(),
  notes: z.string().max(10_000).nullish(),
  products: z
    .array(
      z.object({
        erpItemId: ErpRecordId,
        keyMessage: z.string().max(2000).optional(),
        reaction: z.enum(PRODUCT_REACTIONS).optional(),
      }),
    )
    .max(50)
    .optional(),
});
export type VisitBody = z.infer<typeof VisitBody>;

/**
 * The batch cap the server enforces (`z.array(VisitBody).max(200)`).
 *
 * Declared here because the client must split its own queue to respect it: a 201-row
 * batch is refused WHOLE, so an outbox that has been offline for a fortnight would never
 * drain if it sent everything it had.
 */
export const SYNC_BATCH_MAX = 200;

export const Me = z.object({
  repProfileId: Uuid,
  displayName: z.string(),
  erpEmployeeId: z.string().nullable(),
  territories: z.array(Uuid),
  accountCount: z.number().int(),
});
export type Me = z.infer<typeof Me>;

export const Account = z.object({
  erp_account_id: z.string(),
  // LEFT JOINed against the snapshot, so every label can be null: an account assigned
  // before the snapshot caught up appears unlabelled rather than vanishing, and the UI
  // has to render that rather than assume a name.
  name: z.string().nullable(),
  status: z.string().nullable(),
  country: z.string().nullable(),
  synced_from: z.string().nullable(),
});
export type Account = z.infer<typeof Account>;

export const AccountList = z.object({ data: z.array(Account) });

export const Visit = z
  .object({
    id: Uuid,
    erp_account_id: z.string(),
    status: z.enum(VISIT_STATUSES),
    visit_type: z.string(),
    occurred_at: z.string().nullable(),
    planned_for: z.string().nullable(),
    outcome: z.string().nullable(),
  })
  .passthrough();
export type Visit = z.infer<typeof Visit>;

export const VisitResponse = z.object({ visit: Visit, products: z.array(z.unknown()) });
export const VisitList = z.object({ data: z.array(Visit) });

/** One row's verdict from `POST /v1/sync/visits`. */
export const SyncRowResult = z.object({
  id: z.string(),
  ok: z.boolean(),
  /** The problem KIND, not the full type URL — the server sends `problem.kind` here. */
  type: z.string().optional(),
  error: z.string().optional(),
});
export type SyncRowResult = z.infer<typeof SyncRowResult>;

export const SyncResponse = z.object({
  accepted: z.number().int(),
  rejected: z.number().int(),
  results: z.array(SyncRowResult),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

/** RFC 9457, the API's one error shape. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;

export const PROBLEM_BASE = "https://crm.pharma/errors";

/**
 * The kind out of a problem `type` URL.
 *
 * The API sends `https://crm.pharma/errors/<kind-with-dashes>`; the per-row `type` in a
 * sync response sends the kind directly. Both reach `classifyRowOutcome`, so this
 * normalises the URL form into the other and returns the tail of an unrecognised type
 * rather than null — an unknown kind must still be classifiable, and defaulting it to
 * "retry forever" or "drop" are both worse than naming it.
 */
export function problemKind(type: string): string {
  const tail = type.startsWith(`${PROBLEM_BASE}/`) ? type.slice(PROBLEM_BASE.length + 1) : type;
  return tail.replaceAll("-", "_");
}

// ---- samples --------------------------------------------------------------

/**
 * A quantity on the wire, as the server's `numeric(16,3)` columns accept it.
 *
 * Named once here because three bodies now carry one, and the rule is not obvious: it is
 * TEXT, not a number, because a float cannot represent 0.1 and a third decimal place of a
 * drug sample is not a rounding detail.
 */
export const DecimalQuantity = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,3})?$/, "expected a decimal quantity");

/**
 * What `POST /v1/samples/disbursements` and each element of `POST /v1/sync/disbursements`
 * accept — the act at the centre of a pharma field visit, and the one with legal weight.
 *
 * `signatureSha256` IS THE DESIGN, and it shapes everything the client does here. The
 * ledger row commits to the digest of bytes the device captured; the bytes themselves go
 * up separately, to a route that 404s until this row exists. So a disbursement recorded
 * at a clinic desk with no signal is TWO queued things in a fixed order, and the second
 * cannot be sent until the first has been accepted. That is why the outbox grew
 * dependencies.
 *
 * `quantity` is a string here rather than a number, and deliberately: the column is
 * `numeric(16,3)` and a float cannot represent 0.1. The server accepts either; sending
 * the decimal as text is the only form that cannot lose a third decimal place on the way.
 */
export const DisbursementBody = z.object({
  id: Uuid,
  lotId: Uuid,
  quantity: DecimalQuantity,
  occurredAt: z.string().datetime(),
  erpAccountId: ErpRecordId,
  erpContactId: ErpRecordId.nullish(),
  recipientName: z.string().min(1).max(200),
  signatureSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest"),
  visitId: Uuid.nullish(),
});
export type DisbursementBody = z.infer<typeof DisbursementBody>;

export const ATTACHMENT_CONTENT_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;

/** `MAX_ATTACHMENT_BYTES` in @crm/storage, which the API enforces. 512 KiB. */
export const MAX_ATTACHMENT_BYTES = 524_288;
export const MAX_ATTACHMENT_BASE64_CHARS = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

/**
 * The signature itself, for `POST /v1/samples/disbursements/:id/signature`.
 *
 * There is no `sha256` field and that is the server's choice, not an omission: it computes
 * the digest from the bytes it received and compares it to what the ledger committed. A
 * client that sent its own digest would be asserting the thing under test.
 */
export const SignatureBody = z.object({
  id: Uuid,
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
});
export type SignatureBody = z.infer<typeof SignatureBody>;

/** A row of `GET /v1/samples/holdings`: what this rep is carrying. */
export const Holding = z.object({
  rep_profile_id: Uuid,
  lot_id: Uuid,
  erp_item_id: z.string(),
  lot_number: z.string(),
  expiry_date: z.string().nullable(),
  material_kind: z.string(),
  // Text, because the column is numeric(16,3) and JSON numbers are doubles. Parsing it
  // into a float to show it would reintroduce exactly the error the column type avoids.
  quantity_on_hand: z.string(),
  quantity_in_transit: z.string(),
});
export type Holding = z.infer<typeof Holding>;

export const HoldingList = z.object({ data: z.array(Holding) });

export const Disbursement = z
  .object({ id: Uuid, lot_id: Uuid, quantity: z.string(), signature_sha256: z.string() })
  .passthrough();

// ---- transfers ------------------------------------------------------------

/**
 * What `POST /v1/samples/transfers` accepts: material leaving this rep for another.
 *
 * `toRepProfileId` is the only field naming a person, and the server supplies the sender
 * from the token — so a device cannot transfer somebody else's stock even by asking.
 *
 * A transfer is NOT the end of the story on either device. It moves the quantity out of
 * `quantity_on_hand` and into `quantity_in_transit`, where it stays until the receiver
 * accepts it or the sender recalls it. Both of those are separate movements, which is why
 * this client has three transfer-shaped outbox kinds rather than one.
 */
export const TransferBody = z.object({
  id: Uuid,
  lotId: Uuid,
  quantity: DecimalQuantity,
  occurredAt: z.string().datetime(),
  toRepProfileId: Uuid,
});
export type TransferBody = z.infer<typeof TransferBody>;

/**
 * What `POST /v1/samples/transfers/:id/accept` accepts — and what it deliberately does not.
 *
 * No lot and no quantity: both are read off the transfer by the server, because an
 * acceptance that disagreed with what was sent would not be an acceptance. The route's own
 * comment says it removes the chance to try, and this body is the shape of that decision.
 */
export const AcceptBody = z.object({ id: Uuid, occurredAt: z.string().datetime() });
export type AcceptBody = z.infer<typeof AcceptBody>;

/** What `POST /v1/samples/transfers/:id/recall` accepts: the sender taking it back. */
export const RecallBody = z.object({
  id: Uuid,
  occurredAt: z.string().datetime(),
  reason: z.string().max(500).nullish(),
});
export type RecallBody = z.infer<typeof RecallBody>;

/** A row of `GET /v1/samples/transfer-peers`: somebody a transfer can be addressed to. */
export const TransferPeer = z.object({
  rep_profile_id: Uuid,
  display_name: z.string(),
  employee_number: z.string(),
});
export type TransferPeer = z.infer<typeof TransferPeer>;

export const TransferPeerList = z.object({ data: z.array(TransferPeer) });

/**
 * A row of `GET /v1/samples/transfers/incoming`: material on its way TO this rep.
 *
 * `occurred_at` is a string because that is what JSON carries; it is not parsed into a
 * `Date` here, since the only thing the screen does with it is show it and the only thing
 * the server does with it is order by it.
 */
export const IncomingTransfer = z.object({
  transaction_id: Uuid,
  lot_id: Uuid,
  lot_number: z.string(),
  erp_item_id: z.string(),
  expiry_date: z.string().nullable(),
  quantity: z.string(),
  sent_by: Uuid,
  sent_by_name: z.string(),
  occurred_at: z.string(),
  days_in_transit: z.number().int(),
});
export type IncomingTransfer = z.infer<typeof IncomingTransfer>;

export const IncomingTransferList = z.object({ data: z.array(IncomingTransfer) });

/**
 * A row of `GET /v1/samples/transfers/recallable`: material this rep sent that nobody has
 * taken yet. The mirror of the row above, and the two are separate lists because only one
 * side can act on each.
 */
export const RecallableTransfer = z.object({
  transaction_id: Uuid,
  lot_id: Uuid,
  lot_number: z.string(),
  erp_item_id: z.string(),
  expiry_date: z.string().nullable(),
  quantity: z.string(),
  sent_to: Uuid,
  sent_to_name: z.string(),
  occurred_at: z.string(),
  days_in_transit: z.number().int(),
});
export type RecallableTransfer = z.infer<typeof RecallableTransfer>;

export const RecallableTransferList = z.object({ data: z.array(RecallableTransfer) });

// ---- counts ---------------------------------------------------------------

/**
 * What `POST /v1/samples/counts` accepts: the count DOCUMENT, opened before its lines.
 *
 * `id` is required here, unlike on the server, where it is optional for a caller that has
 * a network. A device has to mint it: `POST /v1/samples/counts/:id/lines` needs the id in
 * its path, and a count is the one custody document whose whole purpose is to happen where
 * the stock is — a car park, a clinic corridor — rather than where the signal is. Sending
 * the same open twice opens one count: the server reads the existing row back (0056).
 *
 * `countedAt` is when the counting happened, not when it synced, and it is the clock the
 * resulting adjustments are dated with.
 */
export const CountBody = z.object({
  id: Uuid,
  countedAt: z.string().datetime(),
  note: z.string().max(2000).nullish(),
});
export type CountBody = z.infer<typeof CountBody>;

/**
 * One counted lot, for `POST /v1/samples/counts/:id/lines`.
 *
 * No id of its own, and that is the server's shape rather than an omission: a line's
 * identity is `(count_id, lot_id)`, which is a UNIQUE constraint and an upsert — so
 * counting a lot twice replaces the figure instead of adding a second line. This client
 * keys its queue the same way for the same reason.
 *
 * `deviceExpectedQuantity` is what the screen was showing when the rep counted. It is kept
 * BESIDE the server's own snapshot, never over it (0056): a count taken offline snapshots
 * a balance that is hours stale by the time the line arrives, and a client able to
 * overwrite the server's figure could make any variance disappear from review while the
 * ledger still wrote the adjustment.
 */
export const CountLineBody = z.object({
  lotId: Uuid,
  countedQuantity: DecimalQuantity,
  deviceExpectedQuantity: DecimalQuantity.nullish(),
});
export type CountLineBody = z.infer<typeof CountLineBody>;

/** A row of `GET /v1/samples/counts`. */
export const Count = z
  .object({
    id: Uuid,
    rep_profile_id: Uuid,
    counted_by: Uuid,
    status: z.enum(["open", "committed", "cancelled"]),
    counted_at: z.string(),
    committed_at: z.string().nullable(),
    note: z.string().nullable(),
  })
  .passthrough();
export type Count = z.infer<typeof Count>;

export const CountList = z.object({ data: z.array(Count) });

/** What `POST /v1/samples/counts/:id/commit` answers: the finding, as a number. */
export const CommitResult = z.object({ adjustments: z.number().int() });

// ---- getting material out of custody --------------------------------------

export const WRITE_OFF_KINDS = ["destruction", "expiry_writeoff"] as const;
export type WriteOffKind = (typeof WRITE_OFF_KINDS)[number];

/**
 * What `POST /v1/samples/write-offs` accepts: material leaving custody for good.
 *
 * TWO KINDS, KEPT APART ON PURPOSE, as the route's own comment says: `destruction` says it
 * was destroyed, `expiry_writeoff` says it stopped being counted. A reader who needs to
 * tell those apart can, and nothing in this client collapses them into one word.
 *
 * `reason` is REQUIRED by the server (`length BETWEEN 1 AND 500`), and this is the one
 * write in the whole client where that is true of a free-text field. It is the only record
 * of why regulated material no longer exists, so a device that let it through empty would
 * be queueing a row the server must refuse — hours later, from inside a queue.
 *
 * `occurredAt` is when the material actually went, which for a write-off recorded in a car
 * park is not when it syncs. It is also the date the expiry sweep now records the
 * obligation as resolved on (0057), so it is the difference between a disposal logged as
 * early and the same disposal logged as overdue.
 */
export const WriteOffBody = z.object({
  id: Uuid,
  lotId: Uuid,
  quantity: DecimalQuantity,
  occurredAt: z.string().datetime(),
  kind: z.enum(WRITE_OFF_KINDS),
  reason: z.string().min(1).max(500),
});
export type WriteOffBody = z.infer<typeof WriteOffBody>;

/**
 * A row of `GET /v1/samples/obligations`: material this rep must get rid of, and by when.
 *
 * `days_overdue` is positive once past the deadline and negative while there is still time,
 * so one number sorts and reads for both — and `status` is the server's own word for it.
 *
 * `quantity_on_hand` comes from the holding rather than from the obligation, which makes a
 * zero here meaningful: the material is gone and the obligation is simply waiting for the
 * nightly sweep to confirm it. The screen says that rather than showing a deadline for
 * something already dealt with.
 */
export const Obligation = z
  .object({
    id: Uuid,
    rep_profile_id: Uuid,
    lot_id: Uuid,
    erp_item_id: z.string(),
    lot_number: z.string(),
    material_kind: z.string(),
    expired_on: z.string(),
    discovered_on: z.string(),
    due_by: z.string(),
    days_overdue: z.number().int(),
    status: z.enum(["open", "overdue"]),
    quantity_on_hand: z.string(),
  })
  .passthrough();
export type Obligation = z.infer<typeof Obligation>;

export const ObligationList = z.object({ data: z.array(Obligation) });
