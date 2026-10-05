import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_ATTACHMENT_BYTES,
  assertAttachmentContent,
  decodeAttachmentContent,
  sha256Hex,
} from "./content.js";
import {
  AttachmentTooLargeError,
  InvalidAttachmentContentError,
  UnsupportedAttachmentTypeError,
} from "./errors.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("attachment content", () => {
  it("caps a blob at 512 KiB", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(524_288);
  });

  /**
   * The cap is DERIVED, and this is the derivation.
   *
   * `MAX_BODY_BYTES` in `packages/api/src/router.ts` is 1 MiB and the only body that API
   * parses is JSON, so a blob arrives base64-encoded. If the encoded form did not fit, a
   * rep would be told "payload too large" by the router for a file the schema advertises
   * as acceptable — a refusal from the wrong layer naming the wrong cause.
   */
  it("leaves room for the base64 form inside the API's 1 MiB body limit", () => {
    const API_MAX_BODY_BYTES = 1024 * 1024;
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBeLessThan(API_MAX_BODY_BYTES);
    // And the next power-of-two step up would not fit, which is what makes 512 KiB the
    // largest honest answer rather than a round number somebody liked.
    expect(4 * Math.ceil((MAX_ATTACHMENT_BYTES * 2) / 3)).toBeGreaterThan(API_MAX_BODY_BYTES);
  });

  it("states the base64 ceiling as 4/3 of the byte ceiling", () => {
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBe(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3));
    expect(Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64").length).toBe(MAX_ATTACHMENT_BASE64_CHARS);
  });

  it("hashes bytes the way the schema spells a hash", () => {
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(PNG)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agrees with node's own digest for random bytes", () => {
    const bytes = randomBytes(1024);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("hashes an empty buffer rather than throwing, because the refusal belongs elsewhere", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("decodes canonical base64", () => {
    const b64 = PNG.toString("base64");
    expect(decodeAttachmentContent(b64).equals(PNG)).toBe(true);
  });

  it("refuses an empty string", () => {
    expect(() => decodeAttachmentContent("")).toThrow(InvalidAttachmentContentError);
  });

  /**
   * The reason this function exists at all.
   *
   * `Buffer.from(s, "base64")` SKIPS characters outside the alphabet and stops at the
   * first `=`, so a corrupted upload decodes to a shorter buffer with no error. A
   * silently truncated signature would then hash to something, fail the ledger's
   * commitment check, and be reported to a rep as "that is the wrong picture" when the
   * fault was the transport.
   */
  it("refuses base64 node would silently truncate", () => {
    const b64 = PNG.toString("base64");
    const corrupted = `${b64.slice(0, 8)}!!${b64.slice(10)}`;
    // Proof that the lenient decode really does accept it, so the test is about a real
    // hazard and not a hypothetical one.
    expect(Buffer.from(corrupted, "base64").length).toBeGreaterThan(0);
    expect(() => decodeAttachmentContent(corrupted)).toThrow(InvalidAttachmentContentError);
  });

  it("refuses base64 with embedded whitespace or newlines", () => {
    const b64 = PNG.toString("base64");
    for (const value of [`${b64.slice(0, 4)} ${b64.slice(4)}`, `${b64.slice(0, 4)}\n${b64.slice(4)}`]) {
      expect(() => decodeAttachmentContent(value)).toThrow(InvalidAttachmentContentError);
    }
  });

  it("refuses url-safe base64 rather than guessing at the alphabet", () => {
    // `-` and `_` are the url-safe alphabet. Accepting both alphabets means accepting a
    // string whose decoding depends on which one was meant, which is how a hash check
    // starts disagreeing with a client.
    expect(() => decodeAttachmentContent("ab-d")).toThrow(InvalidAttachmentContentError);
    expect(() => decodeAttachmentContent("ab_d")).toThrow(InvalidAttachmentContentError);
  });

  it("refuses unpadded base64", () => {
    const b64 = Buffer.from("abcd", "utf8").toString("base64");
    expect(b64.endsWith("=")).toBe(true);
    expect(() => decodeAttachmentContent(b64.replace(/=+$/, ""))).toThrow(InvalidAttachmentContentError);
  });

  it("refuses non-canonical padding that decodes to the same bytes", () => {
    // `QQ==` is the canonical encoding of one byte; `QR==` decodes to the same byte with
    // the trailing bits set, which is a different string for the same content — so a
    // sha256 of the decoded bytes would match while the request did not round-trip.
    expect(Buffer.from("QR==", "base64").equals(Buffer.from("QQ==", "base64"))).toBe(true);
    expect(() => decodeAttachmentContent("QR==")).toThrow(InvalidAttachmentContentError);
    expect(decodeAttachmentContent("QQ==").length).toBe(1);
  });

  it("refuses a base64 string over the ceiling without allocating the buffer", () => {
    const err = catchError(() => decodeAttachmentContent("A".repeat(MAX_ATTACHMENT_BASE64_CHARS + 4)));
    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    expect((err as AttachmentTooLargeError).maxBytes).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("accepts a blob of exactly the maximum size", () => {
    const biggest = Buffer.alloc(MAX_ATTACHMENT_BYTES, 1);
    expect(decodeAttachmentContent(biggest.toString("base64")).length).toBe(MAX_ATTACHMENT_BYTES);
    expect(() => assertAttachmentContent("image/png", biggest)).not.toThrow();
  });

  it("accepts each declared content type with real bytes", () => {
    for (const type of ["image/png", "image/jpeg", "application/pdf"]) {
      expect(() => assertAttachmentContent(type, PNG)).not.toThrow();
    }
  });

  it("refuses a content type outside the allow-list, naming what is accepted", () => {
    const err = catchError(() => assertAttachmentContent("image/svg+xml", PNG));
    expect(err).toBeInstanceOf(UnsupportedAttachmentTypeError);
    expect((err as Error).message).toContain("image/png");
    expect((err as Error).message).toContain("script container");
  });

  it("refuses an empty blob", () => {
    expect(() => assertAttachmentContent("image/png", Buffer.alloc(0))).toThrow(
      InvalidAttachmentContentError,
    );
  });

  it("refuses one byte over the cap, and says it was the API limit and not storage", () => {
    const err = catchError(() =>
      assertAttachmentContent("image/png", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    );
    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    expect((err as AttachmentTooLargeError).byteSize).toBe(MAX_ATTACHMENT_BYTES + 1);
    expect((err as Error).message).toContain("1 MiB JSON body limit");
  });

  /**
   * The order of the two checks inside `assertAttachmentContent`.
   *
   * An oversized blob of an unsupported type is reported as the unsupported type, because
   * that is the fault the client can fix and resending a smaller SVG would fail again.
   */
  it("reports an unsupported type before a size, when both are wrong", () => {
    expect(() =>
      assertAttachmentContent("image/svg+xml", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    ).toThrow(UnsupportedAttachmentTypeError);
  });

  /**
   * The magic-byte sniff is NOT here, and its absence is deliberate: it lives only in
   * 0033's trigger, so there is one implementation of "do these bytes look like what they
   * claim to be". A second one here would be a second chance to disagree about an edge
   * case, and the database's is the one that actually decides.
   */
  it("does not sniff, so a mislabelled blob passes this layer and is refused by the trigger", () => {
    expect(() => assertAttachmentContent("application/pdf", PNG)).not.toThrow();
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}
