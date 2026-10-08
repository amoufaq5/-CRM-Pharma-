import { webcrypto } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { capture, sha256Hex, toBase64 } from "./signature.js";

// `btoa` is a browser global; the capture path uses it, so the test supplies it rather
// than the module reaching for a Node API it would not have in the browser.
beforeAll(() => {
  (globalThis as { btoa?: (s: string) => string }).btoa ??= (s) => Buffer.from(s, "binary").toString("base64");
});

const subtle = webcrypto.subtle;
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("sha256Hex", () => {
  it("produces the digest the API's regex requires, for a known vector", () => {
    // sha256("abc"), and the form matters as much as the value: the server's check is
    // /^[0-9a-f]{64}$/, so an upper-case digest is a validation_failed from inside a batch.
    return expect(sha256Hex(new TextEncoder().encode("abc"), subtle)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the empty input to the empty-string digest, rather than refusing", async () => {
    // `capture` refuses an empty signature; the hash function itself has no opinion, and
    // keeping that boundary clear is why the two are separate.
    await expect(sha256Hex(new Uint8Array(0), subtle)).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("toBase64", () => {
  it("encodes bytes the way the API decodes them", () => {
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(toBase64(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("iVBORw==");
  });

  it("survives an input longer than one argument list", async () => {
    // `String.fromCharCode(...bytes)` on a large image throws RangeError on some engines.
    // A signature is small; the function should not be the reason a bigger attachment
    // cannot be added later.
    const big = new Uint8Array(200_000).fill(0x41);
    const encoded = toBase64(big);
    expect(encoded.length).toBe(4 * Math.ceil(big.length / 3));
    expect(Buffer.from(encoded, "base64").length).toBe(big.length);
  });
});

describe("capture", () => {
  it("returns the hash and the bytes TOGETHER, from one array", async () => {
    // The pairing is the point. The ledger row commits to `sha256` and the image is
    // uploaded separately; if they could be produced apart, a caller could pair up the
    // wrong two and earn a permanent `signature_mismatch`. One function, one input.
    const png = new TextEncoder().encode("not-really-a-png");
    const out = await capture(png, subtle);
    expect(out.sha256).toBe(await sha256Hex(png, subtle));
    expect(Buffer.from(out.base64, "base64").equals(Buffer.from(png))).toBe(true);
    expect(out.contentType).toBe("image/png");
  });

  it("refuses an empty capture", async () => {
    await expect(capture(new Uint8Array(0), subtle)).rejects.toThrow(/nothing to capture/);
  });

  it("refuses one larger than the server accepts, in kilobytes a person can read", async () => {
    // 512 KiB is the API's cap, inside a 1 MiB body. Meeting it at the keyboard beats
    // meeting it as a 413 behind a queue.
    const huge = new Uint8Array(600 * 1024).fill(1);
    await expect(capture(huge, subtle)).rejects.toThrow(/600 KB, and the server accepts at most 512 KB/);
  });
});
