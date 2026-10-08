import { MAX_ATTACHMENT_BYTES } from "@crm/client";

import type { Digester } from "./auth.js";

/**
 * The signature: drawn on glass, hashed, and committed to before it is uploaded.
 *
 * This is the piece ADR-0001 described as "the signature capture that commits to bytes no
 * app has produced". The server's design is what makes it interesting: the disbursement
 * row carries `signatureSha256`, so the LEDGER commits to the digest, and the image goes
 * up separately to a route that recomputes it and refuses a mismatch
 * (`signature_mismatch`, whose comment says "re-sending the same bytes can never work").
 *
 * So the device hashes once, at capture, and keeps both halves. They agree by
 * construction because they come from the same `Uint8Array` — and `capture()` returns them
 * together for exactly that reason, rather than offering two functions a caller could
 * pair up wrongly.
 */
export interface SignatureCapture {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly base64: string;
  readonly contentType: "image/png";
}

/** Lowercase hex, which is the form the API's regex requires. */
export async function sha256Hex(bytes: Uint8Array, subtle: Digester = crypto.subtle): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  // Chunked, because `String.fromCharCode(...bytes)` on a 100 KB image is an argument
  // list long enough to throw RangeError on some engines. A signature is small, but the
  // function should not be the reason a larger attachment cannot be added later.
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export async function capture(bytes: Uint8Array, subtle: Digester = crypto.subtle): Promise<SignatureCapture> {
  if (bytes.length === 0) throw new Error("there is nothing to capture: the signature is empty");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    // The API's cap is 512 KiB inside a 1 MiB body. A signature drawn on a 600×200 canvas
    // is a few kilobytes, so this is a guard rather than a limit anyone will meet — but
    // meeting it at the keyboard beats meeting it as a 413 behind a queue.
    throw new Error(
      `this signature is ${Math.round(bytes.length / 1024)} KB, and the server accepts at most ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB`,
    );
  }
  return { bytes, sha256: await sha256Hex(bytes, subtle), base64: toBase64(bytes), contentType: "image/png" };
}

export interface SignaturePad {
  clear(): void;
  isEmpty(): boolean;
  /** The PNG the canvas holds. Rejects if the browser will not encode it. */
  toPng(): Promise<Uint8Array>;
  detach(): void;
}

/**
 * A pointer-driven pad over a canvas.
 *
 * Pointer events rather than touch or mouse: one code path covers a finger, a stylus and
 * a trackpad, which is what a clinic desk actually presents. `touch-action: none` on the
 * element is what stops a drawn stroke scrolling the page instead.
 */
export function createSignaturePad(canvas: HTMLCanvasElement): SignaturePad {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("this browser would not give the signature pad a 2d context");

  // The backing store is sized to the device's pixels so a signature is not a blurry
  // upscale on a phone, and the drawing is scaled to match.
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 200;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.scale(ratio, ratio);
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#0b1f20";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  let drawing = false;
  let empty = true;

  const positionOf = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const down = (event: PointerEvent): void => {
    drawing = true;
    empty = false;
    canvas.setPointerCapture(event.pointerId);
    const { x, y } = positionOf(event);
    context.beginPath();
    context.moveTo(x, y);
    // A dot is a signature too — a single tap must leave a mark rather than nothing.
    context.lineTo(x + 0.01, y);
    context.stroke();
  };
  const move = (event: PointerEvent): void => {
    if (!drawing) return;
    const { x, y } = positionOf(event);
    context.lineTo(x, y);
    context.stroke();
  };
  const up = (): void => {
    drawing = false;
  };

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointerleave", up);
  canvas.addEventListener("pointercancel", up);

  return {
    clear(): void {
      context.fillRect(0, 0, width, height);
      empty = true;
    },
    isEmpty(): boolean {
      return empty;
    },
    async toPng(): Promise<Uint8Array> {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob === null) throw new Error("this browser would not encode the signature as a PNG");
      return new Uint8Array(await blob.arrayBuffer());
    },
    detach(): void {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", up);
      canvas.removeEventListener("pointercancel", up);
    },
  };
}
