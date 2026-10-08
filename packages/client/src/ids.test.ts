import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mintUuidV7, uuidV7Timestamp } from "./ids.js";

const zeros = (into: Uint8Array): void => {
  into.fill(0);
};
const ones = (into: Uint8Array): void => {
  into.fill(0xff);
};

describe("mintUuidV7", () => {
  it("mints something the API's own validator accepts", () => {
    // The whole point. `VisitBody.id` is `z.string().uuid()` server-side, and zod's older
    // uuid regex pinned the version nibble to 1-5 — it would have refused every id this
    // mints, and every queued visit would have come back validation_failed from inside a
    // batch. Asserted against the same validator rather than a regex of our own.
    const id = mintUuidV7({ now: () => 1_760_000_000_000, randomBytes: (b) => b.fill(0xab) });
    expect(z.string().uuid().safeParse(id).success).toBe(true);
  });

  it("is version 7 and variant 10, with the timestamp in the first 48 bits", () => {
    const ms = 0x0192_f3a1_2b3c;
    const id = mintUuidV7({ now: () => ms, randomBytes: zeros });
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
    expect(uuidV7Timestamp(id)).toBe(ms);
  });

  it("sorts by the millisecond it was minted", () => {
    const at = (ms: number): string => mintUuidV7({ now: () => ms, randomBytes: zeros });
    const ids = [at(3000), at(1000), at(2000)];
    expect([...ids].sort()).toEqual([at(1000), at(2000), at(3000)]);
  });

  it("keeps two devices apart inside one millisecond", () => {
    const a = mintUuidV7({ now: () => 1000, randomBytes: zeros });
    const b = mintUuidV7({ now: () => 1000, randomBytes: ones });
    expect(a).not.toBe(b);
    // Same prefix, because the clock half is identical; different tail, because 74 bits
    // of it stay random. That is the collision argument in one assertion.
    expect(a.slice(0, 13)).toBe(b.slice(0, 13));
  });

  it("floors a fractional clock rather than minting a corrupt id", () => {
    const id = mintUuidV7({ now: () => 1234.987, randomBytes: zeros });
    expect(uuidV7Timestamp(id)).toBe(1234);
  });

  it("refuses a clock that cannot be a timestamp", () => {
    expect(() => mintUuidV7({ now: () => Number.NaN, randomBytes: zeros })).toThrow(/cannot be a timestamp/);
    expect(() => mintUuidV7({ now: () => -1, randomBytes: zeros })).toThrow(/cannot be a timestamp/);
  });

  it("survives a timestamp past 2 ** 32 ms, which is 1970 + 50 days of naive shifting", () => {
    // The 48-bit field is written byte by byte with divisions rather than bit shifts for
    // exactly this reason: JavaScript's `<<` is 32-bit, so `ms >> 32` is 0 and every id
    // minted after 1970-02-19 would have carried the wrong time.
    const ms = 1_760_000_000_000;
    expect(uuidV7Timestamp(mintUuidV7({ now: () => ms, randomBytes: zeros }))).toBe(ms);
  });

  it("reads no timestamp out of something that is not a v7", () => {
    expect(uuidV7Timestamp("0192f3a1-2b3c-4d5e-8f90-1234567890ab")).toBeNull();
    expect(uuidV7Timestamp("not-a-uuid")).toBeNull();
  });
});
