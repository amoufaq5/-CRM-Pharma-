import { createHash } from "node:crypto";

import {
  AttachmentTooLargeError,
  InvalidAttachmentContentError,
  UnsupportedAttachmentTypeError,
} from "./errors.js";
import { ATTACHMENT_CONTENT_TYPES, isAttachmentContentType, type AttachmentContentType } from "./subjects.js";

/**
 * The bytes themselves: how big they may be, how they arrive, and what they hash to.
 *
 * Deliberately free of `pg` and of any store, so the one number every layer has to agree
 * about is importable by a route without dragging a connection along with it.
 */

/**
 * 512 KiB, and the number is DERIVED rather than picked.
 *
 * `MAX_BODY_BYTES` in `packages/api/src/router.ts` is 1 MiB. The only body that API parses
 * is JSON, so a blob arrives base64-encoded, and base64 inflates by 4/3: 512 KiB becomes
 * 683 KiB with room left for the envelope, where 768 KiB would not fit at all. A cap the
 * route cannot deliver under is worse than a smaller one, because the rep is then told
 * "payload too large" by the router for a file the schema advertises as acceptable.
 *
 * (The 10 MiB figure in the README is the ERP's cap on its own API, not this one's.)
 *
 * `0033_attachments.sql` carries the same number in two CHECK constraints;
 * `attachment.contract.test.ts` asserts the schema and this constant agree, because two
 * places holding one limit is two places for it to drift.
 */
export const MAX_ATTACHMENT_BYTES = 524_288;

/**
 * What `MAX_ATTACHMENT_BYTES` costs once base64-encoded, so a route can refuse an
 * oversized upload by looking at the string it already has rather than by decoding it
 * first.
 */
export const MAX_ATTACHMENT_BASE64_CHARS = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

/** The lowercase hex sha256 of some bytes, which is the form every column here stores. */
export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Strict base64 → bytes.
 *
 * `Buffer.from(s, "base64")` is deliberately lenient: it SKIPS characters outside the
 * alphabet and stops at the first `=`, so a truncated or corrupted upload decodes to a
 * shorter buffer with no error at all. That matters more here than almost anywhere else
 * in this repo — a silently truncated signature would hash to something, fail the
 * commitment check, and be reported to a rep as "that is the wrong picture" when the real
 * fault was the transport.
 *
 * So the string is validated first and the decode is checked by re-encoding: if the round
 * trip does not reproduce the input, something was dropped.
 */
export function decodeAttachmentContent(base64: string): Buffer {
  if (base64 === "") {
    throw new InvalidAttachmentContentError("attachment content is empty");
  }
  if (base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
    // Refused before decoding: the point of the base64 ceiling is not to allocate the
    // buffer in the first place.
    throw new AttachmentTooLargeError(Math.floor((base64.length * 3) / 4), MAX_ATTACHMENT_BYTES);
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new InvalidAttachmentContentError(
      "attachment content is not valid base64 — expected the standard alphabet with correct padding " +
        "(url-safe base64 and unpadded base64 are both refused rather than guessed at)",
    );
  }
  const content = Buffer.from(base64, "base64");
  if (content.length === 0) {
    throw new InvalidAttachmentContentError("attachment content decoded to zero bytes");
  }
  if (content.toString("base64") !== base64) {
    throw new InvalidAttachmentContentError(
      "attachment content did not survive a base64 round trip, so octets were dropped in transit " +
        "or the encoding is non-canonical — refusing rather than storing a truncated capture",
    );
  }
  return content;
}

/**
 * Everything about a blob that can be judged without a database.
 *
 * The magic-byte sniff is NOT here: it lives only in the trigger (0033), so there is one
 * implementation of "do these bytes look like what they claim to be" rather than two that
 * can disagree about an edge case. This function covers the type allow-list and the size,
 * both of which belong in front of the wire.
 */
export function assertAttachmentContent(
  contentType: string,
  content: Buffer,
): asserts contentType is AttachmentContentType {
  if (!isAttachmentContentType(contentType)) {
    throw new UnsupportedAttachmentTypeError(contentType, ATTACHMENT_CONTENT_TYPES);
  }
  if (content.length === 0) {
    throw new InvalidAttachmentContentError("attachment content is empty");
  }
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(content.length, MAX_ATTACHMENT_BYTES);
  }
}
