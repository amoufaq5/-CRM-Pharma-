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
