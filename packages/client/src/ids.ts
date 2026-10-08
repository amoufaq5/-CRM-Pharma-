/**
 * UUIDv7 on the device, because the id has to exist before the network does.
 *
 * `crm.visit.id` has no default (migration 0012: "the device generates it before the row
 * ever reaches us"), and the server upserts by it — that is the whole of the idempotent
 * replay. So minting is a client concern, and it is pure here: the clock and the random
 * source are injected, so a test can mint a known id and two devices minting in the same
 * millisecond can be shown not to collide.
 *
 * v7 rather than v4 because the first 48 bits are the timestamp, so ids sort by when the
 * visit was recorded — which makes a queue readable in the order a rep worked, and makes
 * a support question ("what did this device send on Tuesday?") answerable from the id.
 * `z.string().uuid()` in zod 3.25 accepts it, verified rather than assumed: zod's older
 * regex pinned the version nibble to 1-5 and would have refused every id this mints.
 */
export interface MintDeps {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Fills the given array with random bytes, like `crypto.getRandomValues`. */
  readonly randomBytes: (into: Uint8Array) => void;
}

export function mintUuidV7(deps: MintDeps): string {
  const ms = Math.floor(deps.now());
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`mintUuidV7: a clock reading of ${ms} cannot be a timestamp`);

  const bytes = new Uint8Array(16);
  deps.randomBytes(bytes);

  // 48-bit big-endian millisecond timestamp.
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Version 7 in the high nibble of byte 6, variant 10 in the top bits of byte 8. The
  // remaining 74 bits stay random, which is what keeps two devices minting in the same
  // millisecond apart.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

/** The millisecond a v7 id was minted, for ordering a queue and for reading a log. */
export function uuidV7Timestamp(id: string): number | null {
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12]?.toLowerCase() !== "7") return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}
