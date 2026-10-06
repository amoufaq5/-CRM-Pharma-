import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "@crm/db";
import { appPool, TENANT_STORAGE as TENANT, TENANT_STORAGE_OTHER as OTHER_TENANT } from "@crm/db/testing";

import { PostgresBlobStore } from "./blob.js";
import { MAX_ATTACHMENT_BYTES, sha256Hex } from "./content.js";
import {
  AttachmentContentMismatchError,
  AttachmentContentTypeMismatchError,
  AttachmentForbiddenError,
  AttachmentIdReusedError,
  AttachmentImmutableError,
  AttachmentNotFoundError,
  AttachmentNotSupersedableError,
  AttachmentSubjectMismatchError,
  AttachmentSubjectNotFoundError,
  AttachmentSupersessionError,
  AttachmentTooLargeError,
  MissingSignatureCommitmentError,
  SignatureCommitmentMismatchError,
  UnsupportedAttachmentTypeError,
  translateAttachmentError,
} from "./errors.js";
import {
  attachmentAccessLog,
  attachmentSubjectOwner,
  getAttachment,
  listAttachmentsForSubject,
  putAttachment,
  readAttachmentContent,
  requireAttachment,
} from "./attachment.js";

/**
 * The attachment layer against a real Postgres, connected as `crm_app`.
 *
 * `appPool()` rather than `testPool()`, and that choice is the whole reason the isolation
 * assertions below mean anything: a superuser bypasses row-level security even under
 * `FORCE`, so a suite that connects as one proves nothing about tenancy. ADR-0001 item 14
 * records a real cross-tenant write that this repo's suites could not have caught for
 * exactly that reason.
 *
 * Every refusal here is raised by the database, not by this package, which is what makes
 * it hold for a route, for a future offline flush and for a psql prompt alike.
 */
describe("attachments", () => {
  let pool: Pool;
  let client: PoolClient;
  const store = new PostgresBlobStore();

  const REP = "dd200000-0000-4000-8000-000000000001";
  const BOSS = "dd200000-0000-4000-8000-000000000002";
  const PEER = "dd200000-0000-4000-8000-000000000003";
  const REGION = "dd300000-0000-4000-8000-000000000001";
  const PATCH = "dd300000-0000-4000-8000-000000000002";
  const ELSEWHERE = "dd300000-0000-4000-8000-000000000003";
  const ACCOUNT = "ST-ACC-1";
  const WAREHOUSE = "ST-WH-1";

  /** A real 8-byte PNG header plus a little payload, so the trigger's sniff is satisfied. */
  const png = (salt: string): Buffer =>
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(salt, "utf8")]);
  const jpeg = (salt: string): Buffer =>
    Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.from(salt, "utf8")]);
  const pdf = (salt: string): Buffer =>
    Buffer.concat([Buffer.from("%PDF-", "utf8"), Buffer.from(salt, "utf8")]);

  const SIGNATURE = png("the doctor's mark");
  const SIGNATURE_SHA = sha256Hex(SIGNATURE);

  let lotId: string;
  let disbursementId: string;
  let claimId: string;

  const inTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, TENANT, fn);
  const inOtherTenant = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> =>
    withTenantContext(client, OTHER_TENANT, fn);

  /**
   * Asserts a refusal without poisoning the transaction, and returns it translated.
   *
   * Postgres aborts the whole transaction on any error, so each expected refusal needs a
   * savepoint. The translator runs here rather than only inside the store because several
   * tests deliberately write the SQL a future code path might — and the pairing worth
   * pinning is "the database refuses this AND this package names it that", against real
   * pg errors rather than hand-made ones.
   */
  const refuses = async (tx: PoolClient, fn: () => Promise<unknown>): Promise<Error> => {
    await tx.query("SAVEPOINT expect_refusal");
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    await tx.query("ROLLBACK TO SAVEPOINT expect_refusal");
    if (caught === undefined) throw new Error("expected the database to refuse, but it accepted");
    return translateAttachmentError(caught);
  };

  const clearAttachments = async (): Promise<void> => {
    for (const run of [inTenant, inOtherTenant]) {
      await run(async (tx) => {
        // The guards this package exists to provide have to be lifted explicitly to tear
        // the fixture down. Doing it in the open, per table, is the point: nothing else in
        // the system may, and a fixture that found a way around them would be proving the
        // guards are optional.
        for (const t of ["crm.attachment", "crm.attachment_blob", "crm.attachment_access"]) {
          await tx.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        }
        try {
          await tx.query("DELETE FROM crm.attachment_access");
          await tx.query("DELETE FROM crm.attachment_blob");
          await tx.query("DELETE FROM crm.attachment");
        } finally {
          for (const t of ["crm.attachment", "crm.attachment_blob", "crm.attachment_access"]) {
            await tx.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
          }
        }
      });
    }
  };

  beforeAll(async () => {
    pool = appPool();
    client = await pool.connect();

    await inTenant(async (tx) => {
      for (const [id, subject, number] of [
        [REP, "st-rep", "ST-1"],
        [BOSS, "st-boss", "ST-2"],
        [PEER, "st-peer", "ST-3"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.rep_profile (id, tenant_id, subject, employee_number, display_name)
           VALUES ($1,$2,$3,$4,$3) ON CONFLICT DO NOTHING`,
          [id, TENANT, subject, number],
        );
      }
      // A two-level hierarchy, because supervision follows the hierarchy and not
      // co-location (README rule 20): BOSS manages the region, REP works the patch beneath
      // it, and PEER is primary somewhere unrelated — so PEER is a colleague, not a reader.
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'ST-REGION','Region')
         ON CONFLICT DO NOTHING`,
        [REGION, TENANT],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name, parent_id)
         VALUES ($1,$2,'ST-PATCH','Patch',$3) ON CONFLICT DO NOTHING`,
        [PATCH, TENANT, REGION],
      );
      await tx.query(
        `INSERT INTO crm.territory (id, tenant_id, code, name) VALUES ($1,$2,'ST-ELSE','Elsewhere')
         ON CONFLICT DO NOTHING`,
        [ELSEWHERE, TENANT],
      );
      for (const [territory, rep, role] of [
        [PATCH, REP, "primary"],
        [REGION, BOSS, "manager"],
        [ELSEWHERE, PEER, "primary"],
      ] as const) {
        await tx.query(
          `INSERT INTO crm.territory_assignment (tenant_id, territory_id, rep_profile_id, role, valid_from)
           VALUES ($1,$2,$3,$4,'2026-01-01') ON CONFLICT DO NOTHING`,
          [TENANT, territory, rep, role],
        );
      }
      await tx.query(
        `INSERT INTO crm.account_assignment (tenant_id, territory_id, erp_account_id, valid_from)
         SELECT $1,$2,$3::crm.erp_record_id,'2026-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM crm.account_assignment
                             WHERE tenant_id = $1 AND erp_account_id = $3::crm.erp_record_id)`,
        [TENANT, PATCH, ACCOUNT],
      );

      // A real lot, a real receipt into custody, and a real disbursement carrying the
      // commitment. Written as SQL rather than through @crm/sample so this package takes
      // no dependency on it; the 0017/0018 triggers still run, so the fixture rows are the
      // rows a rep's hand-over would produce.
      const lot = await tx.query<{ id: string }>(
        `INSERT INTO crm.sample_lot (tenant_id, erp_item_id, lot_number, expiry_date, material_kind)
         VALUES ($1,'ST-ITEM-1','ST-LOT-1', CURRENT_DATE + 365, 'drug_sample')
         ON CONFLICT (tenant_id, erp_item_id, lot_number) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [TENANT],
      );
      lotId = lot.rows[0]!.id;

      await tx.query(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_warehouse_id, occurred_at)
         VALUES ($1,$2,$3,$4,'receipt',100,$5, now())
         ON CONFLICT (id) DO NOTHING`,
        [randomUUID(), TENANT, lotId, REP, WAREHOUSE],
      );

      disbursementId = randomUUID();
      await tx.query(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, kind, quantity, erp_account_id,
            recipient_name, signature_sha256, occurred_at)
         VALUES ($1,$2,$3,$4,'disbursement',2,$5,'Dr Halabi',$6, now())`,
        [disbursementId, TENANT, lotId, REP, ACCOUNT, SIGNATURE_SHA],
      );

      claimId = randomUUID();
      await tx.query(
        `INSERT INTO crm.expense_claim
           (id, tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
         VALUES ($1,$2,$3,'congress', 120.00, 'EUR', CURRENT_DATE)`,
        [claimId, TENANT, REP],
      );
    });
  });

  afterAll(async () => {
    await clearAttachments();
    await inTenant(async (tx) => {
      await tx.query("ALTER TABLE crm.sample_transaction DISABLE TRIGGER USER");
      await tx.query("ALTER TABLE crm.sample_holding DISABLE TRIGGER USER");
      try {
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_transaction WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_holding WHERE tenant_id = $1", [TENANT]);
        await tx.query("DELETE FROM crm.sample_lot WHERE tenant_id = $1", [TENANT]);
      } finally {
        await tx.query("ALTER TABLE crm.sample_holding ENABLE TRIGGER USER");
        await tx.query("ALTER TABLE crm.sample_transaction ENABLE TRIGGER USER");
      }
      await tx.query("DELETE FROM crm.account_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory_assignment WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1 AND parent_id IS NOT NULL", [TENANT]);
      await tx.query("DELETE FROM crm.territory WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM crm.rep_profile WHERE tenant_id = $1", [TENANT]);
    });
    client?.release();
    await pool?.end();
  });

  beforeEach(clearAttachments);

  const putSignature = (tx: PoolClient, over: Partial<{ id: string; content: Buffer; uploadedBy: string }> = {}) =>
    putAttachment(tx, TENANT, store, {
      id: over.id ?? randomUUID(),
      purpose: "disbursement_signature",
      subjectId: disbursementId,
      contentType: "image/png",
      content: over.content ?? SIGNATURE,
      uploadedBy: over.uploadedBy ?? REP,
    });

  const putReceipt = (
    tx: PoolClient,
    over: Partial<{ id: string; content: Buffer; uploadedBy: string; supersedes: { attachmentId: string; reason: string } }> = {},
  ) =>
    putAttachment(tx, TENANT, store, {
      id: over.id ?? randomUUID(),
      purpose: "expense_receipt",
      subjectId: claimId,
      contentType: "image/jpeg",
      content: over.content ?? jpeg("the taxi"),
      uploadedBy: over.uploadedBy ?? REP,
      ...(over.supersedes !== undefined ? { supersedes: over.supersedes } : {}),
    });

  // -------------------------------------------------------------------------
  // The hole this migration closes.
  // -------------------------------------------------------------------------

  it("stores a signature whose bytes hash to the ledger's commitment", async () => {
    const row = await inTenant(async (tx) => putSignature(tx));
    expect(row.purpose).toBe("disbursement_signature");
    expect(row.subject_table).toBe("crm.sample_transaction");
    expect(row.subject_id).toBe(disbursementId);
    expect(row.content_sha256).toBe(SIGNATURE_SHA);
    expect(row.byte_size).toBe(SIGNATURE.length);
    expect(row.status).toBe("current");
    expect(row.storage_backend).toBe("postgres");
  });

  it("produces the image an inspector asks for, byte for byte", async () => {
    const got = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: REP });
    });
    expect(got.content.equals(SIGNATURE)).toBe(true);
    expect(sha256Hex(got.content)).toBe(SIGNATURE_SHA);
  });

  /**
   * THE refusal. A blob that does not hash to the commitment looks like evidence and is
   * evidence of nothing, and it is also what a deliberate swap looks like — so it must be
   * the one state this table cannot hold.
   */
  it("refuses a signature that does not hash to what the ledger committed to", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () => putSignature(tx, { content: png("a different mark") })),
    );
    expect(err).toBeInstanceOf(SignatureCommitmentMismatchError);
    expect(err.message).toContain(SIGNATURE_SHA);
    expect(err.message).toContain("evidence of nothing");
  });

  it("refuses a signature for a ledger row that never claimed one", async () => {
    const err = await inTenant(async (tx) => {
      const writeOff = randomUUID();
      await tx.query(
        `INSERT INTO crm.sample_transaction
           (id, tenant_id, lot_id, rep_profile_id, kind, quantity, reason, occurred_at)
         VALUES ($1,$2,$3,$4,'destruction',1,'bin',now())`,
        [writeOff, TENANT, lotId, REP],
      );
      return refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "disbursement_signature",
          subjectId: writeOff,
          contentType: "image/png",
          content: SIGNATURE,
          uploadedBy: REP,
        }),
      );
    });
    expect(err).toBeInstanceOf(MissingSignatureCommitmentError);
  });

  it("verifies the digest against the stored octets, not against a caller's claim", async () => {
    // The SQL a future code path might write: a metadata row declaring one hash and a
    // blob holding other bytes. The trigger computes the digest itself, which is what
    // makes `content_sha256` — and therefore the commitment check above — trustworthy.
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO crm.attachment
           (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
            content_sha256, uploaded_by)
         VALUES ($1,$2,'expense_receipt','crm.expense_claim',$3,'image/jpeg',$4,$5,$6)`,
        [id, TENANT, claimId, 9, SIGNATURE_SHA, REP],
      );
      return refuses(tx, () =>
        tx.query("INSERT INTO crm.attachment_blob (attachment_id, tenant_id, content) VALUES ($1,$2,$3)", [
          id,
          TENANT,
          jpeg("nine chars"),
        ]),
      );
    });
    expect(err).toBeInstanceOf(AttachmentContentMismatchError);
  });

  it("refuses bytes whose length disagrees with the declared size", async () => {
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      const content = jpeg("x");
      await tx.query(
        `INSERT INTO crm.attachment
           (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
            content_sha256, uploaded_by)
         VALUES ($1,$2,'expense_receipt','crm.expense_claim',$3,'image/jpeg',$4,$5,$6)`,
        [id, TENANT, claimId, content.length + 1, sha256Hex(content), REP],
      );
      return refuses(tx, () =>
        tx.query("INSERT INTO crm.attachment_blob (attachment_id, tenant_id, content) VALUES ($1,$2,$3)", [
          id,
          TENANT,
          content,
        ]),
      );
    });
    expect(err).toBeInstanceOf(AttachmentContentMismatchError);
    expect(err.message).toContain("bytes and these are");
  });

  it("refuses a PNG declared as a PDF, because the header is what a browser acts on", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "expense_receipt",
          subjectId: claimId,
          contentType: "application/pdf",
          content: png("not a pdf"),
          uploadedBy: REP,
        }),
      ),
    );
    expect(err).toBeInstanceOf(AttachmentContentTypeMismatchError);
    expect(err.message).toContain("89504e47");
  });

  it("accepts each declared content type with bytes that really begin like one", async () => {
    await inTenant(async (tx) => {
      for (const [contentType, content] of [
        ["image/png", png("p")],
        ["image/jpeg", jpeg("j")],
        ["application/pdf", pdf("d")],
      ] as const) {
        await tx.query("SAVEPOINT per_type");
        const row = await putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "expense_receipt",
          subjectId: claimId,
          contentType,
          content,
          uploadedBy: REP,
        });
        expect(row.content_type).toBe(contentType);
        await tx.query("ROLLBACK TO SAVEPOINT per_type");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Who may read one.
  // -------------------------------------------------------------------------

  it("lets the rep who made the record read their own attachment", async () => {
    const got = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return getAttachment(tx, TENANT, row.id, REP);
    });
    expect(got?.content_sha256).toBe(SIGNATURE_SHA);
  });

  it("lets a supervisor read it, through the territory hierarchy", async () => {
    const got = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return getAttachment(tx, TENANT, row.id, BOSS);
    });
    expect(got).not.toBeNull();
  });

  /**
   * RLS is no help here and that is the point: PEER is in the same tenant, so the policy
   * admits the row and `crm.rep_can_supervise` is the only thing between them (README
   * rule 19). A rep assigned to a sibling territory is a colleague, not a supervisor.
   */
  it("hides it from a peer in the same tenant, who RLS would otherwise admit", async () => {
    const { visible, readable } = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.attachment WHERE id = $1",
        [row.id],
      );
      return {
        // The policy lets PEER's connection see the row...
        visible: Number(rows[0]!.n),
        // ...and the predicate does not let PEER read it.
        readable: await getAttachment(tx, TENANT, row.id, PEER),
      };
    });
    expect(visible).toBe(1);
    expect(readable).toBeNull();
  });

  /**
   * A read is authorised AS OF TODAY, and no caller can date it otherwise.
   *
   * 0033's header names this as the one place the subsystem departs from README rule 8: a
   * write is judged on the day it happened, a disclosure on who is accountable now, because
   * backdating it would give the manager who has left the district continuing access to its
   * personal data and the manager who runs it none. The store used to accept an `on`
   * argument and pass it straight into the predicate, which is how a route following the
   * house `?on=` pattern would have reached exactly that. The first assertion proves the
   * date really does change the SQL predicate's answer — so the parameter was not inert —
   * and the second proves the reads no longer have a way to supply one.
   */
  it("authorises a read as of today, with no way for a caller to backdate it", async () => {
    const answers = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      const { rows } = await tx.query<{ then: boolean; now: boolean }>(
        `SELECT crm.attachment_readable_by($1, $2, DATE '2025-01-01') AS then,
                crm.attachment_readable_by($1, $2, CURRENT_DATE) AS now`,
        [row.id, BOSS],
      );
      return {
        predicate: rows[0]!,
        viaStore: await getAttachment(tx, TENANT, row.id, BOSS),
        viaListing: await listAttachmentsForSubject(tx, TENANT, {
          readBy: BOSS,
          purpose: "disbursement_signature",
          subjectId: disbursementId,
        }),
      };
    });
    // BOSS manages the region from 2026-01-01, so the predicate says no for a date before
    // that and yes for today.
    expect(answers.predicate.then).toBe(false);
    expect(answers.predicate.now).toBe(true);
    expect(answers.viaStore).not.toBeNull();
    expect(answers.viaListing).toHaveLength(1);
  });

  it("answers 'not yours' and 'no such thing' identically, so existence does not leak", async () => {
    const err = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      const notYours = await refuses(tx, () => requireAttachment(tx, TENANT, row.id, PEER));
      const noSuchThing = await refuses(tx, () => requireAttachment(tx, TENANT, randomUUID(), REP));
      expect(notYours).toBeInstanceOf(AttachmentNotFoundError);
      expect(noSuchThing).toBeInstanceOf(AttachmentNotFoundError);
      return notYours;
    });
    expect(err.message).toMatch(/^no attachment /);
  });

  it("refuses the bytes to a peer, and records nothing when it does", async () => {
    const { log } = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      const err = await refuses(tx, () =>
        readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: PEER }),
      );
      expect(err).toBeInstanceOf(AttachmentNotFoundError);
      return { log: await attachmentAccessLog(tx, TENANT, row.id, REP) };
    });
    // A refused read is not a read. The access log is evidence of disclosure, so an entry
    // for a request that was denied would make it evidence of nothing.
    expect(log).toHaveLength(0);
  });

  it("returns an empty listing to a reader with no claim on the subject, rather than refusing", async () => {
    const rows = await inTenant(async (tx) => {
      await putReceipt(tx);
      return listAttachmentsForSubject(tx, TENANT, {
        readBy: PEER,
        purpose: "expense_receipt",
        subjectId: claimId,
      });
    });
    // Fail closed by returning nothing, never by returning everything — the shape
    // `crm.visible_account_ids` has.
    expect(rows).toEqual([]);
  });

  it("refuses an uploader who neither owns nor supervises the subject's rep", async () => {
    const err = await inTenant(async (tx) => refuses(tx, () => putReceipt(tx, { uploadedBy: PEER })));
    expect(err).toBeInstanceOf(AttachmentForbiddenError);
    expect(err.message).toContain("neither owns nor supervises");
  });

  it("lets a supervisor upload on the rep's behalf, and records who did", async () => {
    const row = await inTenant(async (tx) => putReceipt(tx, { uploadedBy: BOSS }));
    expect(row.uploaded_by).toBe(BOSS);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation, proved positively.
  // -------------------------------------------------------------------------

  it("does not let another tenant reach a blob, by id, as the table's owner", async () => {
    const id = await inTenant(async (tx) => (await putSignature(tx)).id);

    const reached = await inOtherTenant(async (tx) => ({
      metadata: await tx.query("SELECT id FROM crm.attachment WHERE id = $1", [id]),
      bytes: await tx.query("SELECT content FROM crm.attachment_blob WHERE attachment_id = $1", [id]),
      // Through the store's own reader, which carries the explicit tenant predicate as
      // well as relying on the policy.
      viaStore: await store.get(tx, OTHER_TENANT, id),
      // And through the authorisation predicate, whose subject lookup is itself scoped.
      readable: await tx.query<{ ok: boolean }>("SELECT crm.attachment_readable_by($1, $2) AS ok", [id, REP]),
    }));

    expect(reached.metadata.rowCount).toBe(0);
    expect(reached.bytes.rowCount).toBe(0);
    expect(reached.viaStore).toBeNull();
    expect(reached.readable.rows[0]?.ok).toBe(false);

    // And the row really is there for the tenant that owns it, so the assertion above is
    // about isolation rather than about an empty table.
    const own = await inTenant(async (tx) => store.get(tx, TENANT, id));
    expect(own?.equals(SIGNATURE)).toBe(true);
  });

  it("refuses a write that would smuggle a row into another tenant", async () => {
    await expect(
      inTenant(async (tx) => {
        await tx.query(
          `INSERT INTO crm.attachment
             (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
              content_sha256, uploaded_by)
           VALUES ($1,$2,'expense_receipt','crm.expense_claim',$3,'image/jpeg',4,$4,$5)`,
          [randomUUID(), OTHER_TENANT, claimId, "a".repeat(64), REP],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  // -------------------------------------------------------------------------
  // Append-only, and the retaken/swapped distinction.
  // -------------------------------------------------------------------------

  it("refuses to delete an attachment, because it is the record and not a copy of one", async () => {
    const err = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return refuses(tx, () => tx.query("DELETE FROM crm.attachment WHERE id = $1", [row.id]));
    });
    expect(err).toBeInstanceOf(AttachmentImmutableError);
    expect(err.message).toContain("append-only");
  });

  it("refuses to rewrite the bytes behind a committed hash", async () => {
    const err = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return refuses(tx, () =>
        tx.query("UPDATE crm.attachment_blob SET content = $2 WHERE attachment_id = $1", [
          row.id,
          png("swapped"),
        ]),
      );
    });
    expect(err).toBeInstanceOf(AttachmentImmutableError);
    expect(err.message).toContain("write-once");
  });

  it("refuses to delete the bytes while keeping the row", async () => {
    const err = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      return refuses(tx, () => tx.query("DELETE FROM crm.attachment_blob WHERE attachment_id = $1", [row.id]));
    });
    expect(err).toBeInstanceOf(AttachmentImmutableError);
  });

  it("refuses any update but current -> superseded", async () => {
    await inTenant(async (tx) => {
      const row = await putSignature(tx);
      for (const [sql, params] of [
        ["UPDATE crm.attachment SET content_type = 'application/pdf' WHERE id = $1", [row.id]],
        ["UPDATE crm.attachment SET subject_id = gen_random_uuid() WHERE id = $1", [row.id]],
        ["UPDATE crm.attachment SET content_sha256 = repeat('b', 64) WHERE id = $1", [row.id]],
        ["UPDATE crm.attachment SET uploaded_by = $2 WHERE id = $1", [row.id, BOSS]],
        ["UPDATE crm.attachment SET status = 'current' WHERE id = $1", [row.id]],
      ] as const) {
        const err = await refuses(tx, () => tx.query(sql, [...params]));
        expect(err, sql).toBeInstanceOf(AttachmentImmutableError);
      }
    });
  });

  it("refuses a supersession that also edits the row it is marking", async () => {
    const err = await inTenant(async (tx) => {
      const row = await putReceipt(tx);
      return refuses(tx, () =>
        tx.query(
          `UPDATE crm.attachment
              SET status = 'superseded', superseded_by_attachment_id = $2,
                  superseded_reason = 'r', byte_size = 1
            WHERE id = $1`,
          [row.id, randomUUID()],
        ),
      );
    });
    expect(err).toBeInstanceOf(AttachmentImmutableError);
    expect(err.message).toContain("may set only");
  });

  it("refuses a supersession with no reason", async () => {
    await inTenant(async (tx) => {
      const row = await putReceipt(tx);
      await tx.query("SAVEPOINT no_reason");
      await expect(
        tx.query(
          `UPDATE crm.attachment SET status = 'superseded', superseded_by_attachment_id = $2
            WHERE id = $1`,
          [row.id, randomUUID()],
        ),
      ).rejects.toThrow(/attachment_superseded_reason/);
      await tx.query("ROLLBACK TO SAVEPOINT no_reason");
    });
  });

  it("replaces a receipt as a new row, keeping the old one and its bytes", async () => {
    const { first, second, chain } = await inTenant(async (tx) => {
      const first = await putReceipt(tx, { content: jpeg("the wrong taxi") });
      const second = await putReceipt(tx, {
        content: jpeg("the right taxi"),
        supersedes: { attachmentId: first.id, reason: "photographed the wrong receipt" },
      });
      return {
        first: await getAttachment(tx, TENANT, first.id, REP),
        second,
        chain: await listAttachmentsForSubject(tx, TENANT, {
          readBy: REP,
          purpose: "expense_receipt",
          subjectId: claimId,
        }),
      };
    });

    // "Retaken" reads as two rows and a reason...
    expect(first?.status).toBe("superseded");
    expect(first?.superseded_by_attachment_id).toBe(second.id);
    expect(first?.superseded_reason).toBe("photographed the wrong receipt");
    expect(second.supersedes_attachment_id).toBe(first?.id);
    expect(second.status).toBe("current");
    // ...and the superseded photograph is still there, which is what makes a swap
    // impossible rather than merely discouraged.
    expect(chain).toHaveLength(2);
    expect(chain.map((r) => r.status)).toEqual(["superseded", "current"].reverse());
  });

  it("keeps the superseded receipt's bytes readable", async () => {
    const old = jpeg("the wrong taxi");
    const got = await inTenant(async (tx) => {
      const first = await putReceipt(tx, { content: old });
      await putReceipt(tx, {
        content: jpeg("the right taxi"),
        supersedes: { attachmentId: first.id, reason: "wrong receipt" },
      });
      return readAttachmentContent(tx, TENANT, store, { attachmentId: first.id, readBy: BOSS });
    });
    expect(got.content.equals(old)).toBe(true);
  });

  it("refuses to supersede a signature at all", async () => {
    const err = await inTenant(async (tx) => {
      const first = await putSignature(tx);
      return refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "disbursement_signature",
          subjectId: disbursementId,
          contentType: "image/png",
          content: png("a second mark"),
          uploadedBy: REP,
          supersedes: { attachmentId: first.id, reason: "retaken" },
        }),
      );
    });
    expect(err).toBeInstanceOf(AttachmentNotSupersedableError);
    expect(err.message).toContain("a different hand-over");
  });

  it("refuses the trigger-level signature supersession too, not only the store's early check", async () => {
    // The store refuses this before it writes anything, so the database's own arm would
    // otherwise never be exercised — and it is the one that holds for a psql prompt.
    //
    // ONE savepoint around BOTH statements, not just around the insert. The back link is a
    // DEFERRED foreign key, so rolling back only the successor would leave the first row
    // pointing at a row nobody wrote and the transaction would fail at COMMIT instead —
    // the test would pass for the wrong reason, or fail in `inTenant` with the FK's
    // message rather than the trigger's.
    const err = await inTenant(async (tx) => {
      const first = await putSignature(tx);
      const successor = randomUUID();
      await tx.query("SAVEPOINT trigger_arm");
      await tx.query(
        `UPDATE crm.attachment SET status = 'superseded', superseded_by_attachment_id = $2,
                superseded_reason = 'retaken' WHERE id = $1`,
        [first.id, successor],
      );
      let caught: unknown;
      try {
        await tx.query(
          `INSERT INTO crm.attachment
             (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
              content_sha256, uploaded_by, supersedes_attachment_id)
           VALUES ($1,$2,'disbursement_signature','crm.sample_transaction',$3,'image/png',$4,$5,$6,$7)`,
          [successor, TENANT, disbursementId, SIGNATURE.length, SIGNATURE_SHA, REP, first.id],
        );
      } catch (err) {
        caught = err;
      }
      await tx.query("ROLLBACK TO SAVEPOINT trigger_arm");
      if (caught === undefined) throw new Error("expected the trigger to refuse");
      return translateAttachmentError(caught);
    });
    expect(err).toBeInstanceOf(AttachmentNotSupersedableError);
  });

  it("refuses a second current attachment of the same purpose for one subject", async () => {
    const err = await inTenant(async (tx) => {
      await putReceipt(tx);
      return refuses(tx, () => putReceipt(tx, { content: jpeg("another") }));
    });
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
    expect(err.message).toContain("supersede it with a reason");
  });

  it("refuses a supersession whose bytes are identical, because it replaces nothing", async () => {
    const err = await inTenant(async (tx) => {
      const first = await putReceipt(tx, { content: jpeg("same") });
      return refuses(tx, () =>
        putReceipt(tx, {
          content: jpeg("same"),
          supersedes: { attachmentId: first.id, reason: "retaken" },
        }),
      );
    });
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
    expect(err.message).toContain("supersedes nothing");
  });

  it("refuses a supersession across subjects", async () => {
    const err = await inTenant(async (tx) => {
      const sig = await putSignature(tx);
      return refuses(tx, () =>
        putReceipt(tx, {
          content: jpeg("mispaired"),
          supersedes: { attachmentId: sig.id, reason: "wrong" },
        }),
      );
    });
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
  });

  it("refuses to supersede an attachment that was already replaced", async () => {
    const err = await inTenant(async (tx) => {
      const first = await putReceipt(tx, { content: jpeg("one") });
      await putReceipt(tx, { content: jpeg("two"), supersedes: { attachmentId: first.id, reason: "r" } });
      return refuses(tx, () =>
        putReceipt(tx, { content: jpeg("three"), supersedes: { attachmentId: first.id, reason: "r" } }),
      );
    });
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
    expect(err.message).toContain("already");
  });

  /**
   * The row being REPLACED is authorised too, before it is touched.
   *
   * The successor's trigger would refuse PEER anyway — it asks whether the uploader
   * supervises the subject's rep — but it refuses AFTER `markSuperseded` has run, so which
   * refusal comes back tells a caller holding a guessed id whether that attachment is the
   * current one. PEER here names a receipt on REP's claim and a subject PEER cannot attach
   * to, and gets the same sentence as for an id that does not exist.
   */
  it("refuses to supersede an attachment the actor has no claim on, in the same words as a missing one", async () => {
    const { notYours, missing } = await inTenant(async (tx) => {
      const first = await putReceipt(tx);
      return {
        notYours: await refuses(tx, () =>
          putReceipt(tx, {
            uploadedBy: PEER,
            content: jpeg("peer's attempt"),
            supersedes: { attachmentId: first.id, reason: "r" },
          }),
        ),
        missing: await refuses(tx, () =>
          putReceipt(tx, {
            uploadedBy: PEER,
            content: jpeg("peer's attempt"),
            supersedes: { attachmentId: randomUUID(), reason: "r" },
          }),
        ),
      };
    });
    expect(notYours).toBeInstanceOf(AttachmentSupersessionError);
    expect(missing).toBeInstanceOf(AttachmentSupersessionError);
    // The two refusals differ only in the id they name, which is the id the caller sent.
    expect(notYours.message.replace(/[0-9a-f-]{36}/, "ID")).toBe(
      missing.message.replace(/[0-9a-f-]{36}/, "ID"),
    );
  });

  it("still lets a supervisor replace a rep's receipt, so the gate is not simply closed", async () => {
    const second = await inTenant(async (tx) => {
      const first = await putReceipt(tx);
      return putReceipt(tx, {
        uploadedBy: BOSS,
        content: jpeg("the right taxi"),
        supersedes: { attachmentId: first.id, reason: "wrong receipt" },
      });
    });
    expect(second.uploaded_by).toBe(BOSS);
    expect(second.status).toBe("current");
  });

  it("refuses to supersede an attachment that does not exist", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () => putReceipt(tx, { supersedes: { attachmentId: randomUUID(), reason: "r" } })),
    );
    expect(err).toBeInstanceOf(AttachmentSupersessionError);
  });

  /**
   * The deferred foreign key earning its keep: marking a row superseded by a successor
   * nobody writes is legal inside the transaction and refused at COMMIT, so the half-done
   * replacement cannot be left in the table.
   */
  it("refuses at commit a supersession whose successor was never written", async () => {
    const id = await inTenant(async (tx) => (await putReceipt(tx)).id);
    await expect(
      inTenant(async (tx) => {
        await tx.query(
          `UPDATE crm.attachment SET status = 'superseded', superseded_by_attachment_id = $2,
                  superseded_reason = 'never written' WHERE id = $1`,
          [id, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint/);

    const after = await inTenant(async (tx) => getAttachment(tx, TENANT, id, REP));
    expect(after?.status).toBe("current");
  });

  // -------------------------------------------------------------------------
  // The device-minted id: retry versus swap.
  // -------------------------------------------------------------------------

  it("collapses a retried upload of the same capture into the row already there", async () => {
    const { first, second, count } = await inTenant(async (tx) => {
      const id = randomUUID();
      const first = await putSignature(tx, { id });
      const second = await putSignature(tx, { id });
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM crm.attachment WHERE subject_id = $1",
        [disbursementId],
      );
      return { first, second, count: Number(rows[0]!.n) };
    });
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(count).toBe(1);
  });

  it("heals a retry whose metadata landed and whose bytes did not", async () => {
    const content = await inTenant(async (tx) => {
      const id = randomUUID();
      await putSignature(tx, { id });
      // The state an earlier attempt could leave behind if the connection died between
      // the two statements. Removing the blob needs the guard lifted, which is itself the
      // evidence that no ordinary path can produce it.
      await tx.query("ALTER TABLE crm.attachment_blob DISABLE TRIGGER USER");
      await tx.query("DELETE FROM crm.attachment_blob WHERE attachment_id = $1", [id]);
      await tx.query("ALTER TABLE crm.attachment_blob ENABLE TRIGGER USER");
      expect(await store.has(tx, TENANT, id)).toBe(false);

      await putSignature(tx, { id });
      return store.get(tx, TENANT, id);
    });
    expect(content?.equals(SIGNATURE)).toBe(true);
  });

  it("refuses the same id carrying different bytes, which is the swap", async () => {
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      await putReceipt(tx, { id, content: jpeg("one") });
      return refuses(tx, () => putReceipt(tx, { id, content: jpeg("two") }));
    });
    expect(err).toBeInstanceOf(AttachmentIdReusedError);
    expect(err.message).toContain("reused id");
  });

  it("refuses the same id pointing at a different subject", async () => {
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      await putReceipt(tx, { id });
      return refuses(tx, () => putSignature(tx, { id }));
    });
    expect(err).toBeInstanceOf(AttachmentIdReusedError);
  });

  /**
   * The retry path authorises its uploader, like the first write does.
   *
   * A first write is authorised by `crm.attachment_validate`, which asks
   * `crm.rep_can_supervise(uploaded_by, owner)` — but a retry writes no metadata row, so no
   * trigger speaks for it. Without a check of its own the collapse branch answered a rep
   * with no claim on the subject with the whole row: the purpose, the subject, the uploader
   * and the content hash of a colleague's doctor signature, which is the disclosure the
   * read predicate exists to prevent. PEER holds the bytes here only because the test has
   * them; the point is that nothing asked whether PEER was entitled to the answer.
   */
  it("refuses a retried upload from a rep with no claim on the subject", async () => {
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      await putSignature(tx, { id });
      return refuses(tx, () => putSignature(tx, { id, uploadedBy: PEER }));
    });
    expect(err).toBeInstanceOf(AttachmentForbiddenError);
    expect(err.message).toContain("neither owns nor supervises");
  });

  it("lets the owner and their supervisor retry, so the collapse still heals a lost write", async () => {
    const rows = await inTenant(async (tx) => {
      const id = randomUUID();
      const first = await putSignature(tx, { id });
      return [first, await putSignature(tx, { id }), await putSignature(tx, { id, uploadedBy: BOSS })];
    });
    // All three answers are the SAME row, and `uploaded_by` still names whoever wrote it
    // first — a retry is not a second act of attribution.
    expect(rows.map((r) => r.id)).toEqual([rows[0]!.id, rows[0]!.id, rows[0]!.id]);
    expect(rows.map((r) => r.uploaded_by)).toEqual([REP, REP, REP]);
  });

  /**
   * The retry comparison covers `content_type` too, because a first write would not have
   * survived without it.
   *
   * Identical bytes can only legally carry one of the three declared types — the trigger's
   * magic-byte sniff decides which — so a retry that renames PNG bytes `application/pdf`
   * is a declaration the schema refuses outright on a first write. Omitted from the
   * identity comparison, it was accepted silently and answered with the stored row, which
   * made the retry path the one way into this table that is more permissive than the
   * write it is replaying.
   */
  it("refuses a retry that redeclares the stored bytes as another content type", async () => {
    const err = await inTenant(async (tx) => {
      const id = randomUUID();
      await putSignature(tx, { id });
      return refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id,
          purpose: "disbursement_signature",
          subjectId: disbursementId,
          contentType: "application/pdf",
          content: SIGNATURE,
          uploadedBy: REP,
        }),
      );
    });
    expect(err).toBeInstanceOf(AttachmentContentTypeMismatchError);
    expect(err.message).toContain("image/png");
  });

  // -------------------------------------------------------------------------
  // Subjects, ordering, limits, and the access log.
  // -------------------------------------------------------------------------

  it("refuses an attachment for a subject row that does not exist", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "expense_receipt",
          subjectId: randomUUID(),
          contentType: "image/jpeg",
          content: jpeg("orphan"),
          uploadedBy: REP,
        }),
      ),
    );
    expect(err).toBeInstanceOf(AttachmentSubjectNotFoundError);
  });

  it("refuses a subject table no owner branch knows about", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () =>
        tx.query(
          `INSERT INTO crm.attachment
             (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
              content_sha256, uploaded_by)
           VALUES ($1,$2,'expense_receipt','crm.visit',$3,'image/jpeg',4,$4,$5)`,
          [randomUUID(), TENANT, randomUUID(), "a".repeat(64), REP],
        ),
      ),
    );
    // Three rules would each refuse this and the pairing arm gets there first, because a
    // purpose pins its table — so an unknown table is unreachable by construction rather
    // than merely rejected. The arm in the trigger that names an unknown table stays
    // anyway, for the reason `translateSampleError` keeps its own unreachable arm: a
    // trigger must not assume the CHECK beside it is still there.
    expect(err).toBeInstanceOf(AttachmentSubjectMismatchError);
  });

  it("admits only the two known subject tables, whichever rule is consulted", async () => {
    const admitted = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.attachment'::regclass AND conname = 'attachment_subject_table_check'`,
      );
      return rows[0]?.def ?? "";
    });
    expect(admitted).toContain("crm.sample_transaction");
    expect(admitted).toContain("crm.expense_claim");
    expect(admitted).not.toContain("crm.visit");
  });

  /**
   * The fail-closed default itself, exercised directly rather than through an insert the
   * pairing rule makes unreachable.
   *
   * This is the inversion that matters: `crm.notification_subject_open` reads an unknown
   * table as "not open" so its notifications prune, because the failure IT fixes is
   * unbounded growth. Here an unknown table resolves to no owner, and no owner means
   * nobody may read — because the failure being avoided is disclosure of a third party's
   * personal data.
   */
  it("resolves no owner and no reader for a subject table it has no branch for", async () => {
    const answers = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ owner: string | null; unknown: boolean; readable: boolean }>(
        `SELECT crm.attachment_subject_rep('crm.visit', $1) AS owner,
                crm.attachment_subject_unknown('crm.visit') AS unknown,
                crm.attachment_readable_by($1, $2) AS readable`,
        [randomUUID(), REP],
      );
      return rows[0]!;
    });
    expect(answers.owner).toBeNull();
    expect(answers.unknown).toBe(true);
    expect(answers.readable).toBe(false);
  });

  /**
   * And it says WHICH rule was broken, which took an arm of its own.
   *
   * A BEFORE INSERT trigger runs ahead of constraint evaluation, so `attachment_validate`
   * answers before `attachment_purpose_subject` does. Without the pairing arm at the top
   * of that function, a signature pointed at an expense claim looked for a commitment in
   * `crm.sample_transaction`, found no row with the claim's id, and was refused as
   * "records no signature_sha256" — true, and about the wrong question. Pinned here
   * because a client that only ever saw the misleading message would report the wrong
   * cause (the same reason ADR-0001 item 13 pins the lockout/four-eyes order).
   */
  it("refuses a receipt hung off a ledger row, and a signature hung off a claim", async () => {
    await inTenant(async (tx) => {
      for (const [purpose, table, subject] of [
        ["expense_receipt", "crm.sample_transaction", disbursementId],
        ["disbursement_signature", "crm.expense_claim", claimId],
      ] as const) {
        const err = await refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.attachment
               (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
                content_sha256, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,'image/jpeg',4,$6,$7)`,
            [randomUUID(), TENANT, purpose, table, subject, "a".repeat(64), REP],
          ),
        );
        expect(err, `${purpose} on ${table}`).toBeInstanceOf(AttachmentSubjectMismatchError);
        expect(err.message, `${purpose} on ${table}`).toContain("the two do not pair");
        expect(err.message, `${purpose} on ${table}`).not.toContain("records no signature_sha256");
      }
    });
  });

  it("keeps the CHECK underneath the trigger's arm, so the pairing survives a dropped trigger", async () => {
    const def = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'crm.attachment'::regclass AND conname = 'attachment_purpose_subject'`,
      );
      return rows[0]?.def ?? "";
    });
    expect(def).toContain("disbursement_signature");
    expect(def).toContain("crm.sample_transaction");
    expect(def).toContain("expense_receipt");
    expect(def).toContain("crm.expense_claim");
  });

  it("resolves the owning rep for each subject, and null for a subject that is gone", async () => {
    const owners = await inTenant(async (tx) => ({
      signature: await attachmentSubjectOwner(tx, TENANT, "disbursement_signature", disbursementId),
      receipt: await attachmentSubjectOwner(tx, TENANT, "expense_receipt", claimId),
      missing: await attachmentSubjectOwner(tx, TENANT, "expense_receipt", randomUUID()),
    }));
    expect(owners.signature).toBe(REP);
    expect(owners.receipt).toBe(REP);
    expect(owners.missing).toBeNull();
  });

  /**
   * And it carries the explicit tenant predicate this module says every read carries.
   *
   * `crm.attachment_subject_rep` takes no tenant argument, so this was the one exported
   * read with nothing but the policy between it and the wrong tenant's rows — the shape
   * ADR-0001 item 14 records a real cross-tenant write for. The predicate is against the
   * session's own `app.current_tenant_id` rather than against a column, because the branch
   * that resolves the owner is in SQL and must not be restated here: what it buys is that a
   * route holding the wrong tenant, or one outside `withTenantContext` altogether, gets
   * null instead of an answer about whatever context the connection happened to be in.
   */
  it("resolves no owner when asked under a tenant that is not the session's", async () => {
    const answers = await inTenant(async (tx) => ({
      right: await attachmentSubjectOwner(tx, TENANT, "expense_receipt", claimId),
      wrong: await attachmentSubjectOwner(tx, OTHER_TENANT, "expense_receipt", claimId),
    }));
    expect(answers.right).toBe(REP);
    expect(answers.wrong).toBeNull();
  });

  it("resolves no owner with no tenant context at all, rather than one from the catalog", async () => {
    const owner = await attachmentSubjectOwner(client, TENANT, "expense_receipt", claimId);
    expect(owner).toBeNull();
  });

  /**
   * `uploaded_at` is now(), which is the TRANSACTION clock — two attachments written in
   * one transaction share it to the microsecond. 0027 added a sequence to `crm.outbox`
   * after exactly that tie decided a dispatch order; this asserts the same tie exists here
   * and that `seq` breaks it.
   */
  it("orders attachments written in one transaction by seq, which uploaded_at cannot do", async () => {
    const rows = await inTenant(async (tx) => {
      const first = await putReceipt(tx, { content: jpeg("one") });
      const second = await putReceipt(tx, {
        content: jpeg("two"),
        supersedes: { attachmentId: first.id, reason: "r" },
      });
      expect(first.uploaded_at.getTime()).toBe(second.uploaded_at.getTime());
      return listAttachmentsForSubject(tx, TENANT, {
        readBy: REP,
        purpose: "expense_receipt",
        subjectId: claimId,
      });
    });
    expect(rows.map((r) => r.status)).toEqual(["current", "superseded"]);
    expect(BigInt(rows[0]!.seq)).toBeGreaterThan(BigInt(rows[1]!.seq));
  });

  it("holds a blob of exactly the maximum size, and refuses one byte more", async () => {
    const biggest = Buffer.concat([
      Buffer.from("ffd8ff", "hex"),
      Buffer.alloc(MAX_ATTACHMENT_BYTES - 3, 7),
    ]);
    expect(biggest.length).toBe(MAX_ATTACHMENT_BYTES);

    const stored = await inTenant(async (tx) => {
      const row = await putReceipt(tx, { content: biggest });
      const got = await store.get(tx, TENANT, row.id);
      return { row, matched: got?.equals(biggest) === true };
    });
    expect(stored.row.byte_size).toBe(MAX_ATTACHMENT_BYTES);
    expect(stored.matched).toBe(true);

    const err = await inTenant(async (tx) =>
      refuses(tx, () => putReceipt(tx, { content: Buffer.concat([biggest, Buffer.of(0)]) })),
    );
    expect(err).toBeInstanceOf(AttachmentTooLargeError);
  });

  it("carries the schema's own ceiling, so the constant and the CHECK cannot drift", async () => {
    const defs = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid IN ('crm.attachment'::regclass, 'crm.attachment_blob'::regclass)
            AND conname IN ('attachment_byte_size_check', 'attachment_blob_size')`,
      );
      return rows;
    });
    expect(defs).toHaveLength(2);
    for (const row of defs) {
      expect(row.def, `${row.conname} must carry MAX_ATTACHMENT_BYTES`).toContain(
        String(MAX_ATTACHMENT_BYTES),
      );
    }
  });

  it("refuses a content type the schema does not admit, before the wire", async () => {
    const err = await inTenant(async (tx) =>
      refuses(tx, () =>
        putAttachment(tx, TENANT, store, {
          id: randomUUID(),
          purpose: "expense_receipt",
          subjectId: claimId,
          contentType: "image/svg+xml",
          content: Buffer.from("<svg/>", "utf8"),
          uploadedBy: REP,
        }),
      ),
    );
    expect(err).toBeInstanceOf(UnsupportedAttachmentTypeError);
  });

  it("records a read before it serves the bytes, with the correlation id", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await readAttachmentContent(tx, TENANT, store, {
        attachmentId: row.id,
        readBy: BOSS,
        correlationId: "cid-1234",
      });
      return attachmentAccessLog(tx, TENANT, row.id, REP);
    });
    expect(log).toHaveLength(1);
    expect(log[0]?.read_by).toBe(BOSS);
    expect(log[0]?.correlation_id).toBe("cid-1234");
  });

  it("records one row per read, newest first, ordered by seq rather than by the clock", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      for (const reader of [REP, BOSS, REP]) {
        await readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: reader });
      }
      return attachmentAccessLog(tx, TENANT, row.id, BOSS);
    });
    expect(log).toHaveLength(3);
    expect(log.map((r) => r.read_by)).toEqual([REP, BOSS, REP]);
    // All three share read_at to the microsecond, which is why seq exists.
    expect(new Set(log.map((r) => r.read_at.getTime())).size).toBe(1);
    expect(BigInt(log[0]!.seq)).toBeGreaterThan(BigInt(log[2]!.seq));
  });

  it("does not log a metadata listing, only a read of the bytes", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await getAttachment(tx, TENANT, row.id, BOSS);
      await listAttachmentsForSubject(tx, TENANT, {
        readBy: BOSS,
        purpose: "disbursement_signature",
        subjectId: disbursementId,
      });
      return attachmentAccessLog(tx, TENANT, row.id, REP);
    });
    expect(log).toEqual([]);
  });

  it("refuses to edit or remove an access record", async () => {
    await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: REP });
      const [entry] = await attachmentAccessLog(tx, TENANT, row.id, REP);
      for (const [sql, params] of [
        ["DELETE FROM crm.attachment_access WHERE id = $1", [entry!.id]],
        ["UPDATE crm.attachment_access SET read_by = $2 WHERE id = $1", [entry!.id, BOSS]],
      ] as const) {
        const err = await refuses(tx, () => tx.query(sql, [...params]));
        expect(err, sql).toBeInstanceOf(AttachmentImmutableError);
      }
    });
  });

  it("hides the access log from a peer, by the same predicate as the bytes", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: REP });
      return attachmentAccessLog(tx, TENANT, row.id, PEER);
    });
    expect(log).toEqual([]);
  });

  it("bounds the access log's limit rather than trusting a caller's number", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: REP });
      return {
        zero: await attachmentAccessLog(tx, TENANT, row.id, REP, 0),
        negative: await attachmentAccessLog(tx, TENANT, row.id, REP, -5),
        huge: await attachmentAccessLog(tx, TENANT, row.id, REP, 10_000),
      };
    });
    // A limit of 0 or -5 would otherwise be a silently empty answer that reads as "nobody
    // ever looked at this", which is the wrong thing for a disclosure question.
    expect(log.zero).toHaveLength(1);
    expect(log.negative).toHaveLength(1);
    expect(log.huge).toHaveLength(1);
  });

  /**
   * And a limit that is not a number at all.
   *
   * A route reads `Number(query.limit)` and gets NaN for any garbage — and the clamp does
   * not survive it, because `Math.max(1, Math.min(1000, NaN))` is NaN, which reaches
   * Postgres as the text "NaN" and fails the statement. So "who has read this signature"
   * answered 500 for `?limit=all`.
   */
  it("falls back to the default for a limit that is not a number", async () => {
    const log = await inTenant(async (tx) => {
      const row = await putSignature(tx);
      await readAttachmentContent(tx, TENANT, store, { attachmentId: row.id, readBy: REP });
      return {
        nan: await attachmentAccessLog(tx, TENANT, row.id, REP, Number("all")),
        infinite: await attachmentAccessLog(tx, TENANT, row.id, REP, Number.POSITIVE_INFINITY),
      };
    });
    expect(log.nan).toHaveLength(1);
    expect(log.infinite).toHaveLength(1);
  });

  it("writes the blob into the caller's transaction, so a rollback leaves nothing behind", async () => {
    let id = "";
    await expect(
      inTenant(async (tx) => {
        id = (await putSignature(tx)).id;
        throw new Error("the rest of the request failed");
      }),
    ).rejects.toThrow("the rest of the request failed");

    const after = await inTenant(async (tx) => ({
      metadata: await getAttachment(tx, TENANT, id, REP),
      bytes: await store.has(tx, TENANT, id),
    }));
    // There is no state where a disbursement claims an attachment whose bytes are
    // missing, and none where bytes outlive the row that describes them. That is what the
    // Postgres backend buys and what the S3 seam would give up.
    expect(after.metadata).toBeNull();
    expect(after.bytes).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 0040: the claim state a receipt may be attached, replaced or stood down at.
  // -------------------------------------------------------------------------

  /**
   * The rule the route used to be the only holder of.
   *
   * `POST /v1/expenses/:id/receipt` still checks it — it is the sentence a rep reads and it
   * runs before half a megabyte crosses the wire — but every assertion below goes through
   * this package or through raw SQL, with no router anywhere, which is the point: what 0040
   * moved into the database is what an offline flush and a psql prompt meet.
   *
   * EVERY CLAIM IS BUILT BY ADVANCING A REAL ONE. A predecessor receipt cannot be attached
   * to an `approved` claim at all once 0040 is in place, so the fixture does what a rep
   * does: files a draft, attaches the receipt, and the claim then moves. That is also the
   * exact sequence the rule exists for — the swap happens to a receipt that was legitimately
   * attached, after the decision was taken against it.
   */
  describe("the claim state a receipt may be attached, replaced or stood down at", () => {
    /** Every state 0006's CHECK admits, so a state added later fails this suite. */
    const CLAIM_STATES = ["draft", "submitted", "approved", "rejected", "posted", "reimbursed"] as const;
    type ClaimState = (typeof CLAIM_STATES)[number];

    /** A first receipt: evidence legitimately arrives while an approver is already looking. */
    const FIRST_RECEIPT_ADMITS: readonly ClaimState[] = ["draft", "submitted"];
    /** A replacement, either half: an approver may be reading A at the moment it becomes B. */
    const REPLACEMENT_ADMITS: readonly ClaimState[] = ["draft"];

    const newDraftClaim = async (tx: PoolClient): Promise<string> => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO crm.expense_claim
           (id, tenant_id, rep_profile_id, crm_category, amount, currency, incurred_on)
         VALUES ($1,$2,$3,'congress', 95.00, 'EUR', CURRENT_DATE)`,
        [id, TENANT, REP],
      );
      return id;
    };

    /**
     * Walks a claim to `state`, one legal hop at a time.
     *
     * It used to write the target state in a single UPDATE, setting whichever of 0006's and
     * 0030's paired columns that state needs. Migration 0044 refuses that: a claim is born
     * `draft` and changes state only along an edge of `crm.expense_claim_transitions()`, so
     * `draft -> posted` is no longer expressible — which is the whole point of 0044 and is
     * what this file's `refuses a raw INSERT on a posted claim` case was reaching for from
     * the other direction.
     *
     * The walk sets each column on exactly the hop that records it, and never twice: 0044
     * seals the lifecycle columns write-once, so a helper that re-stamped `submitted_at` on
     * every hop would be refused by the seal. BOSS is the approver and rejecter because
     * `expense_claim_four_eyes` and `expense_claim_reject_four_eyes` forbid the claimant
     * being either, and 0044 now requires the actor on the transition rather than leaving it
     * to a CHECK that a null satisfies.
     *
     * A fixed timestamp rather than `now()`, for the same write-once reason and because
     * `now()` in a transaction is one instant anyway.
     */
    const CLAIM_AT = "2026-09-01T09:00:00.000Z";

    /** The hop that reaches each state, as the `SET` list it needs beyond `state`. */
    const HOP: Readonly<Record<Exclude<ClaimState, "draft">, readonly string[]>> = {
      submitted: [`submitted_at = '${CLAIM_AT}'`, "erp_ledger_account_code = '6000'"],
      approved: [`approved_at = '${CLAIM_AT}'`, `approved_by = '${BOSS}'`],
      rejected: [`rejected_at = '${CLAIM_AT}'`, `rejected_by = '${BOSS}'`],
      posted: [`posted_at = '${CLAIM_AT}'`, "erp_expense_id = 'rec_attachment_fixture'"],
      reimbursed: [],
    };

    /** The one path into each state, from `draft`. `rejected` hangs off `submitted`. */
    const PATH: Readonly<Record<ClaimState, readonly Exclude<ClaimState, "draft">[]>> = {
      draft: [],
      submitted: ["submitted"],
      rejected: ["submitted", "rejected"],
      approved: ["submitted", "approved"],
      posted: ["submitted", "approved", "posted"],
      reimbursed: ["submitted", "approved", "posted", "reimbursed"],
    };

    const setClaimState = async (tx: PoolClient, claim: string, state: ClaimState): Promise<void> => {
      for (const hop of PATH[state]) {
        const sets = ["state = $3", ...HOP[hop]];
        await tx.query(
          `UPDATE crm.expense_claim SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
          [TENANT, claim, hop],
        );
      }
      const { rows } = await tx.query<{ state: string }>(
        "SELECT state FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2",
        [TENANT, claim],
      );
      // The fixture asserts itself: a CHECK or 0044's trigger that this helper failed to
      // satisfy would otherwise leave the claim short of its target and every refusal below
      // would pass for the wrong reason.
      expect(rows[0]?.state, `claim could not be walked to ${state}`).toBe(state);
    };

    const receiptOn = (
      tx: PoolClient,
      claim: string,
      over: Partial<{ content: Buffer; supersedes: { attachmentId: string; reason: string } }> = {},
    ) =>
      putAttachment(tx, TENANT, store, {
        id: randomUUID(),
        purpose: "expense_receipt",
        subjectId: claim,
        contentType: "image/jpeg",
        content: over.content ?? jpeg("the taxi"),
        uploadedBy: REP,
        ...(over.supersedes !== undefined ? { supersedes: over.supersedes } : {}),
      });

    for (const state of CLAIM_STATES) {
      const admitted = FIRST_RECEIPT_ADMITS.includes(state);

      it(`${admitted ? "attaches" : "refuses"} a first receipt to a ${state} claim`, async () => {
        const outcome = await inTenant(async (tx) => {
          const claim = await newDraftClaim(tx);
          await setClaimState(tx, claim, state);
          if (admitted) return { row: await receiptOn(tx, claim) };
          return { err: await refuses(tx, () => receiptOn(tx, claim)) };
        });
        if (admitted) {
          expect(outcome.row?.status).toBe("current");
        } else {
          expect(outcome.err?.name).toBe("ReceiptClaimStateError");
          // The state is NAMED, because "refused" without it sends a rep to the wrong
          // screen: the remedy for `rejected` is not the remedy for `posted`.
          expect(outcome.err?.message).toContain(state);
          expect(outcome.err?.message).toContain("receipt-claim-state:");
        }
      });

      const canReplace = REPLACEMENT_ADMITS.includes(state);

      it(`${canReplace ? "replaces" : "refuses to replace"} the receipt on a ${state} claim`, async () => {
        const outcome = await inTenant(async (tx) => {
          const claim = await newDraftClaim(tx);
          // Attached while the claim is still a draft, as a rep would, and the claim moves
          // around it afterwards.
          const first = await receiptOn(tx, claim);
          await setClaimState(tx, claim, state);
          const replace = () =>
            receiptOn(tx, claim, {
              content: jpeg("a different taxi"),
              supersedes: { attachmentId: first.id, reason: "photographed the wrong receipt" },
            });
          if (canReplace) return { first, row: await replace() };
          return { first, err: await refuses(tx, replace) };
        });
        if (canReplace) {
          expect(outcome.row?.supersedes_attachment_id).toBe(outcome.first.id);
        } else {
          expect(outcome.err?.name).toBe("ReceiptClaimStateError");
          expect(outcome.err?.message).toContain(state);
        }
      });
    }

    /**
     * The hole that made this an UPDATE trigger and not an arm in `attachment_validate`.
     *
     * Superseding is two statements and the predecessor is marked FIRST, so the stand-down
     * can be run ALONE — and it commits: `attachment_append_only` admits `current ->
     * superseded`, the pair and reason CHECKs are satisfied, and the DEFERRABLE back link
     * finds a real row at COMMIT as long as it names any attachment of the tenant. The claim
     * is then approved with NO current receipt at all, which is worse than the swap this rule
     * is about and needed one statement.
     */
    it("refuses the stand-down half on its own, which would leave an approved claim with no receipt", async () => {
      const err = await inTenant(async (tx) => {
        const claim = await newDraftClaim(tx);
        const receipt = await receiptOn(tx, claim);
        // Any other attachment of this tenant satisfies the deferred back link, so the
        // statement below is not refused for naming a successor that does not exist.
        const decoy = await putSignature(tx);
        await setClaimState(tx, claim, "approved");
        return refuses(tx, () =>
          tx.query(
            `UPDATE crm.attachment
                SET status = 'superseded',
                    superseded_by_attachment_id = $3,
                    superseded_reason = 'standing it down on its own'
              WHERE tenant_id = $1 AND id = $2`,
            [TENANT, receipt.id, decoy.id],
          ),
        );
      });
      expect(err.name).toBe("ReceiptClaimStateError");
      expect(err.message).toContain("cannot be stood down");
      expect(err.message).toContain("approved");
    });

    /** And the same statement is fine while the claim is still a draft. */
    it("admits the stand-down half on a draft claim, because that is the first half of a legal replacement", async () => {
      const after = await inTenant(async (tx) => {
        const claim = await newDraftClaim(tx);
        const receipt = await receiptOn(tx, claim);
        const decoy = await putSignature(tx);
        await tx.query(
          `UPDATE crm.attachment
              SET status = 'superseded',
                  superseded_by_attachment_id = $3,
                  superseded_reason = 'the first half of a replacement'
            WHERE tenant_id = $1 AND id = $2`,
          [TENANT, receipt.id, decoy.id],
        );
        const { rows } = await tx.query<{ status: string }>(
          "SELECT status FROM crm.attachment WHERE tenant_id = $1 AND id = $2",
          [TENANT, receipt.id],
        );
        return rows[0]?.status;
      });
      expect(after).toBe("superseded");
    });

    /**
     * The path with no TypeScript in it at all.
     *
     * `putAttachment` is one writer of this table and the route is one caller of it. This is
     * the INSERT a psql prompt or a future offline flush would run, and it meets the same
     * refusal — which is the whole reason the rule was moved out of the handler.
     */
    it("refuses a raw INSERT on a posted claim, with no store and no route in the way", async () => {
      const err = await inTenant(async (tx) => {
        const claim = await newDraftClaim(tx);
        await setClaimState(tx, claim, "posted");
        return refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.attachment
               (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
                content_sha256, uploaded_by)
             VALUES ($1,$2,'expense_receipt','crm.expense_claim',$3,'image/jpeg',8,$4,$5)`,
            [randomUUID(), TENANT, claim, sha256Hex(jpeg("smuggled in")), REP],
          ),
        );
      });
      expect(err.name).toBe("ReceiptClaimStateError");
      expect(err.message).toContain("posted");
    });

    /**
     * A receipt whose claim has been deleted cannot be moved, and the refusal says so.
     *
     * `crm.attachment.subject_id` is deliberately not a foreign key (0033: a column cannot
     * reference two tables), so nothing stops a claim being deleted under its receipts. On
     * INSERT this case is unreachable — `attachment_validate` refuses a missing subject
     * first, with a better sentence — so the stand-down is the only way to observe the arm,
     * and the fail-closed direction is 0033's: an attachment nobody is accountable for is
     * not one to be moved around.
     */
    it("refuses to stand down a receipt whose claim has been deleted", async () => {
      const err = await inTenant(async (tx) => {
        const claim = await newDraftClaim(tx);
        const receipt = await receiptOn(tx, claim);
        const decoy = await putSignature(tx);
        await tx.query("DELETE FROM crm.expense_claim WHERE tenant_id = $1 AND id = $2", [TENANT, claim]);
        return refuses(tx, () =>
          tx.query(
            `UPDATE crm.attachment
                SET status = 'superseded', superseded_by_attachment_id = $3,
                    superseded_reason = 'the claim is gone'
              WHERE tenant_id = $1 AND id = $2`,
            [TENANT, receipt.id, decoy.id],
          ),
        );
      });
      expect(err.name).toBe("ReceiptClaimStateError");
      expect(err.message).toContain("is not visible in tenant");
    });

    /**
     * The other purpose is untouched, and could not be governed this way.
     *
     * A signature hangs off `crm.sample_transaction`, which has no state column and could
     * not have one — 0018 makes the ledger append-only, so a hand-over has no lifecycle to
     * be at the wrong point of.
     */
    it("leaves a disbursement signature alone, because its subject has no state to be at", async () => {
      const row = await inTenant(async (tx) => putSignature(tx));
      expect(row.purpose).toBe("disbursement_signature");
      expect(row.status).toBe("current");
    });

    /**
     * THE TRIGGER ORDER, pinned from this side, because 0040's name is load-bearing.
     *
     * Postgres fires same-event triggers in alphabetical order by name, and 0033 records
     * that the ORDER of its own arms was a finding: a `disbursement_signature` pointed at an
     * expense claim used to be refused with "records no signature_sha256", a true sentence
     * about the wrong question. A claim-state trigger sorting BEFORE `attachment_validate`
     * would reintroduce exactly that — a mispaired receipt would be told its claim is
     * missing. Renaming it has to break a test rather than quietly reorder two refusals.
     */
    it("fires after both of 0033's triggers, so each event's better-aimed refusal still speaks first", async () => {
      const names = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger
            WHERE tgrelid = 'crm.attachment'::regclass AND NOT tgisinternal
            ORDER BY tgname`,
        );
        return rows.map((r) => r.tgname);
      });
      expect(names).toEqual([
        "attachment_append_only",
        "attachment_validate",
        "attachment_validate_receipt_claim_state",
      ]);
    });

    /** And the consequence of that order: a mispaired row still gets 0033's sentence. */
    it("still answers a mispaired receipt with the pairing refusal, not with a missing claim", async () => {
      const err = await inTenant(async (tx) =>
        refuses(tx, () =>
          tx.query(
            `INSERT INTO crm.attachment
               (id, tenant_id, purpose, subject_table, subject_id, content_type, byte_size,
                content_sha256, uploaded_by)
             VALUES ($1,$2,'expense_receipt','crm.sample_transaction',$3,'image/jpeg',8,$4,$5)`,
            [randomUUID(), TENANT, disbursementId, sha256Hex(jpeg("mispaired")), REP],
          ),
        ),
      );
      expect(err).toBeInstanceOf(AttachmentSubjectMismatchError);
      expect(err.message).not.toContain("receipt-claim-state:");
    });
  });
});
