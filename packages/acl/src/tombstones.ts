import { ErpError } from "./problems.js";

/**
 * Whether the ERP has deleted a tenant, answered in three ways and never guessed.
 *
 * CrossEngin's ADR-0316 to ADR-0320 made a tenant deletion real: the tenant's own Postgres
 * schema is dropped, a tombstone is composed from per-subsystem attestations and anchored in
 * the forensic chain, and `GET /v1/platform/tenants/{id}/tombstones` is the receipt. That
 * route is the signal this module reads, and the reason it can be read at all is a property
 * of the ERP worth writing down: the tenant row in `meta.tenants` is retired AFTER the
 * deletion pipeline commits, and the request path never consults that registry to
 * authenticate — a JWT's `tenant_id` claim sets the request's tenant directly. So a
 * per-tenant token still authenticates after its tenant is gone, which is what makes an
 * affirmative read possible instead of an inference from a 401.
 *
 * THE RULE THIS FILE EXISTS FOR: nothing here ever infers a deletion. Not from an empty
 * entity list, not from a 401, not from a timeout, not from the schema having vanished. A
 * tenant is marked deleted by one thing only — a `tenant_deletion` tombstone naming it, in
 * hand. Everything else is `unknown`, which the caller records and retries.
 *
 * The inverse is just as deliberate. An `unknown` is NOT a quiet pass: a deployment whose
 * read role was never granted gets 403 forever, and a signal that silently never fires is
 * worse than no signal because the deployment believes it is watching. So `unknown` carries
 * the reason, and `crm.tenant_deletion_check` keeps it.
 */

/** The receipt, as `tombstoneReceipt` in the ERP's `tenant-deletion-routes.ts` shapes it. */
export interface TenantTombstone {
  readonly tombstoneId: string;
  readonly kind: string;
  readonly deletedAt: string;
  readonly proofSha256: string;
  /** The ERP types this `string | null`: a tombstone is stored whether or not the anchor returned. */
  readonly chainEntryHash: string | null;
}

export type TenantDeletionVerdict =
  /** A `tenant_deletion` tombstone for this tenant. The only thing that stops a tenant. */
  | { readonly verdict: "deleted"; readonly httpStatus: 200; readonly tombstone: TenantTombstone }
  /** The ERP answered, and said no such tombstone exists. An affirmative not-deleted. */
  | { readonly verdict: "live"; readonly httpStatus: 200 }
  /** Anything else. Means neither deleted nor live, and must be retried. */
  | { readonly verdict: "unknown"; readonly httpStatus: number | null; readonly detail: string };

/** Only this kind stops a tenant. See `classifyTombstonePayload`. */
export const TENANT_DELETION_TOMBSTONE_KIND = "tenant_deletion";

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOMBSTONE_ID_RE = /^tomb_[A-Za-z0-9_-]{12,40}$/;

/**
 * The one constructor for an `unknown`, so every detail is bounded by construction.
 *
 * `crm.tenant_deletion_check.detail` is `length BETWEEN 1 AND 500`, and the text flows from
 * two places that can be arbitrarily long: a body the ERP sent and an error message from
 * whatever failed to reach it. Truncating the interpolated FRAGMENT is not enough — the first
 * version of this did that, and a composed detail could still exceed the bound it was
 * supposedly enforcing, which a test caught. So nothing builds an `unknown` by hand: the
 * whole sentence is squeezed to one line and capped here, once.
 */
const MAX_DETAIL = 300;

function unknown(httpStatus: number | null, detail: string): TenantDeletionVerdict {
  const one = detail.replace(/\s+/g, " ").trim();
  return {
    verdict: "unknown",
    httpStatus,
    detail: one.length <= MAX_DETAIL ? one : `${one.slice(0, MAX_DETAIL - 3)}...`,
  };
}

function readTombstone(row: unknown): TenantTombstone | { readonly rejected: string } {
  if (typeof row !== "object" || row === null) return { rejected: "a tombstone entry was not an object" };
  const r = row as Record<string, unknown>;
  const { tombstoneId, kind, deletedAt, proofSha256, chainEntryHash } = r;
  if (typeof tombstoneId !== "string" || !TOMBSTONE_ID_RE.test(tombstoneId)) {
    return { rejected: `tombstoneId ${JSON.stringify(tombstoneId)} is not a tomb_ id` };
  }
  if (typeof kind !== "string" || kind === "") return { rejected: `tombstone ${tombstoneId} has no kind` };
  if (typeof deletedAt !== "string" || Number.isNaN(Date.parse(deletedAt))) {
    return { rejected: `tombstone ${tombstoneId} has no parseable deletedAt` };
  }
  if (typeof proofSha256 !== "string" || !SHA256_RE.test(proofSha256)) {
    return { rejected: `tombstone ${tombstoneId} has no sha256 proof` };
  }
  if (chainEntryHash !== null && (typeof chainEntryHash !== "string" || !SHA256_RE.test(chainEntryHash))) {
    return { rejected: `tombstone ${tombstoneId} has a chainEntryHash that is neither null nor a sha256` };
  }
  return { tombstoneId, kind, deletedAt, proofSha256, chainEntryHash };
}

/**
 * Turns a 200 body into a verdict.
 *
 * THE KIND FILTER IS THE WHOLE POINT. The route returns both kinds the ERP stores —
 * `DELETABLE_TOMBSTONE_KINDS = ["tenant_deletion", "data_subject_erasure"]`. A
 * `data_subject_erasure` tombstone is ONE person exercising Article 17 inside a tenant that
 * is otherwise entirely alive, and reacting to it would take a working tenant's whole field
 * force offline the first time one employee asked to be forgotten. So a non-`tenant_deletion`
 * entry is not a deletion and not an error: it is read, skipped, and the answer is `live`.
 *
 * `tenantId` is cross-checked against the payload's own, because a route that answered about
 * a different tenant would be the one mistake with no recovery — and the id is a path
 * parameter, so a mis-built URL is a plausible way to get one.
 *
 * A body that does not parse is `unknown` and NOT `live`. That asymmetry is the file's rule
 * applied to our own code: failing to understand the answer is not the ERP saying no.
 */
export function classifyTombstonePayload(tenantId: string, body: unknown): TenantDeletionVerdict {
  if (typeof body !== "object" || body === null) {
    return unknown(200, "the tombstones response was not an object");
  }
  const payload = body as Record<string, unknown>;
  if (typeof payload["tenantId"] !== "string") {
    return unknown(200, "the tombstones response named no tenant");
  }
  if (payload["tenantId"] !== tenantId) {
    return unknown(200, `asked about ${tenantId} and was answered about ${String(payload["tenantId"])}`);
  }
  const data = payload["data"];
  if (!Array.isArray(data)) {
    return unknown(200, "the tombstones response carried no data array");
  }

  for (const row of data) {
    const read = readTombstone(row);
    if ("rejected" in read) {
      return unknown(200, read.rejected);
    }
    if (read.kind === TENANT_DELETION_TOMBSTONE_KIND) {
      return { verdict: "deleted", httpStatus: 200, tombstone: read };
    }
  }
  return { verdict: "live", httpStatus: 200 };
}

/**
 * Turns a refusal into `unknown`, with the reason the caller has to be able to read.
 *
 * Every branch is `unknown` and that is not laziness — it is the only honest reading of each
 * one, and the detail is what distinguishes a thing somebody must fix from weather:
 *
 *   403 — the role was never added to `--tenant-tombstone-read-role`. A configuration fault:
 *         this deployment is not watching and does not know it.
 *   404 — the ERP does not run `--tenant-deletion-routes`, so no tenant can be observed.
 *   503 — the ERP's own "do not treat this as an absence": it has a stored tombstone it
 *         cannot re-parse, which is a finding on its side and emphatically not a no.
 *   401 — our credential. NOT a deletion, though a retired tenant is exactly when somebody
 *         would be tempted to read it as one.
 */
export function classifyTombstoneRefusal(err: unknown): TenantDeletionVerdict {
  if (err instanceof ErpError) {
    const because =
      err.status === 403
        ? "the ERP refused the read: this role is not in --tenant-tombstone-read-role, so this deployment is not watching"
        : err.status === 404
          ? "the ERP has no tombstones route: it is not running --tenant-deletion-routes"
          : err.status === 503
            ? "the ERP could not read its own stored tombstones; it says explicitly not to treat this as an absence"
            : err.status === 401
              ? "the ERP rejected our credential, which says nothing about whether the tenant was deleted"
              : `the ERP answered ${String(err.status)} ${err.code}`;
    return unknown(err.status, err.detail !== undefined ? `${because} (${err.detail})` : because);
  }
  return unknown(null, `no answer from the ERP: ${err instanceof Error ? err.message : String(err)}`);
}

/** What `readTenantDeletionVerdict` needs, so a test can supply four lines instead of a server. */
export interface TombstoneReader {
  tenantTombstones(tenantId: string): Promise<unknown>;
}

/**
 * One call, one verdict, never a throw.
 *
 * The only impure function here, and it is three lines, because everything that decides
 * anything is above and testable without a socket.
 */
export async function readTenantDeletionVerdict(
  reader: TombstoneReader,
  tenantId: string,
): Promise<TenantDeletionVerdict> {
  try {
    return classifyTombstonePayload(tenantId, await reader.tenantTombstones(tenantId));
  } catch (err) {
    return classifyTombstoneRefusal(err);
  }
}
