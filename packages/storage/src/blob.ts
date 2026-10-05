import type { PoolClient } from "pg";

import type { AttachmentStorageBackend } from "./subjects.js";

/**
 * The storage seam, and the one implementation behind it.
 *
 * `BlobStore` exists because ADR-0001 records object storage as a platform gap that will
 * eventually be filled, and the precedent for how to hold a gap open is `ChannelSender`
 * in `packages/notify/src/sender.ts`: an interface with a WORKING implementation behind
 * it, and nothing claimed that is not built. There is exactly one store here and it is
 * real; an `S3BlobStore` is not declared, not stubbed and not listed as a provider,
 * because a channel that cannot be constructed is not a channel (README rule 29).
 *
 * WHY POSTGRES AND NOT A FILE, in one sentence each — the argument is in 0033's header.
 * `deploy/docker-compose.yml` gives the API service no volume, so a file would live in an
 * ephemeral container layer, invisible to the second replica and to the scheduler; the
 * managed path puts the API on a serverless runtime with a read-only filesystem; and
 * large objects live in a cluster-wide catalog that carries no `tenant_id` and cannot be
 * put under a policy, which would end tenant isolation at this table's edge.
 *
 * WHAT THE SEAM COSTS, stated rather than discovered later. `put` takes the CALLER'S
 * transaction, because a Postgres store must participate in it — the metadata row and the
 * bytes commit together, which is why there is no state where an attachment exists and
 * its content does not. An S3 implementation cannot honour that: its object would land
 * before the row and an aborted transaction would leave it orphaned. So moving to object
 * storage is a swap plus a sweeper for unreferenced objects, not a swap alone. The
 * parameter stays because the honest shape of the interface is the one the working
 * implementation needs; a future store ignoring it is a documented weakening, where
 * dropping it now would be an undocumented one.
 */
export interface BlobStore {
  /** Matches `crm.attachment.storage_backend`, so a row says which store holds its bytes. */
  readonly backend: AttachmentStorageBackend;

  /**
   * Writes the bytes for an attachment whose metadata row already exists.
   *
   * Idempotent: re-running it for the same attachment is a no-op rather than a conflict,
   * which is what makes a retried offline upload safe end to end. It does NOT verify the
   * bytes — 0033's trigger does, against the metadata row, because a check that runs only
   * in the store is a check a psql prompt walks past.
   */
  put(tx: PoolClient, tenantId: string, attachmentId: string, content: Buffer): Promise<void>;

  /** The bytes, or null when this store holds none for that attachment. */
  get(tx: PoolClient, tenantId: string, attachmentId: string): Promise<Buffer | null>;

  /** Whether this store holds bytes for the attachment, without reading them. */
  has(tx: PoolClient, tenantId: string, attachmentId: string): Promise<boolean>;
}

/**
 * `crm.attachment_blob`.
 *
 * The whole class is four statements, which is the point: everything that makes an
 * attachment trustworthy — the digest, the length, the magic bytes, the immutability — is
 * in the database, where it also holds for the next writer.
 *
 * Stateless, so one instance can be shared by the API and the scheduler; it never holds a
 * client of its own and only ever uses the transaction it is handed.
 */
export class PostgresBlobStore implements BlobStore {
  readonly backend: AttachmentStorageBackend = "postgres";

  async put(tx: PoolClient, tenantId: string, attachmentId: string, content: Buffer): Promise<void> {
    await tx.query(
      `INSERT INTO crm.attachment_blob (attachment_id, tenant_id, content)
       VALUES ($1, $2, $3)
       -- A redelivered upload collapses into the bytes already stored rather than
       -- conflicting. DO NOTHING rather than DO UPDATE deliberately: the content hash is
       -- a commitment, so overwriting the bytes behind one is the single thing this
       -- subsystem must make impossible, and crm.attachment_blob_immutable refuses the
       -- UPDATE anyway.
       --
       -- Note what this clause does and does not reach. A BEFORE INSERT trigger runs
       -- ahead of the conflict check, so attachment_blob_verify sees the incoming bytes
       -- first: a redelivery carrying DIFFERENT bytes is refused rather than silently
       -- ignored, and only a byte-identical one gets as far as collapsing here.
       ON CONFLICT (attachment_id) DO NOTHING`,
      [attachmentId, tenantId, content],
    );
  }

  async get(tx: PoolClient, tenantId: string, attachmentId: string): Promise<Buffer | null> {
    const { rows } = await tx.query<{ content: Buffer }>(
      `SELECT content FROM crm.attachment_blob
        WHERE tenant_id = $1 AND attachment_id = $2`,
      [tenantId, attachmentId],
    );
    // The explicit tenant predicate alongside RLS, as every store here carries: the policy
    // is the backstop and this is the check (ADR-0001 item 13's correction, where a
    // missing `AND tenant_id = $n` ended a grant in another tenant under a superuser
    // connection that switched RLS off).
    return rows[0]?.content ?? null;
  }

  async has(tx: PoolClient, tenantId: string, attachmentId: string): Promise<boolean> {
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT true AS present FROM crm.attachment_blob
        WHERE tenant_id = $1 AND attachment_id = $2`,
      [tenantId, attachmentId],
    );
    return rows[0]?.present === true;
  }
}
