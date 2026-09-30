import { describe, expect, it } from "vitest";
import { nextDelayMs, policyFor, ORDERING_BACKOFF, PERIOD_BACKOFF, TRANSIENT_BACKOFF } from "./backoff.js";

describe("nextDelayMs", () => {
  it("grows exponentially with attempts", () => {
    const max = (n: number) => nextDelayMs(n, TRANSIENT_BACKOFF, () => 0.999999);
    expect(max(1)).toBeLessThan(max(2));
    expect(max(2)).toBeLessThan(max(3));
  });

  it("never exceeds the policy ceiling", () => {
    for (const attempts of [1, 5, 10, 50, 500]) {
      expect(nextDelayMs(attempts, TRANSIENT_BACKOFF, () => 1)).toBeLessThanOrEqual(TRANSIENT_BACKOFF.maxMs);
    }
  });

  it("applies FULL jitter, so a batch failing together does not return together", () => {
    // Undithered, every row in a batch retries at the same instant and
    // re-stampedes an ERP that is already struggling.
    expect(nextDelayMs(5, TRANSIENT_BACKOFF, () => 0)).toBe(0);
    const ceiling = nextDelayMs(5, TRANSIENT_BACKOFF, () => 0.999999);
    expect(nextDelayMs(5, TRANSIENT_BACKOFF, () => 0.5)).toBeLessThan(ceiling);
  });

  it("stays finite at absurd attempt counts", () => {
    // 2 ** 1024 is Infinity and Infinity * 0 is NaN, which would land in the
    // database as a null next_attempt_at and make the row invisible forever.
    const d = nextDelayMs(5000, TRANSIENT_BACKOFF, () => 0);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(0);
    expect(Number.isFinite(nextDelayMs(5000, TRANSIENT_BACKOFF, () => 0.5))).toBe(true);
  });

  it("returns a whole number of milliseconds", () => {
    expect(Number.isInteger(nextDelayMs(3, TRANSIENT_BACKOFF, () => 0.4242))).toBe(true);
  });
});

describe("policies are matched to what they wait on", () => {
  it("routes each retry kind to its own curve", () => {
    expect(policyFor("retry_transient")).toBe(TRANSIENT_BACKOFF);
    expect(policyFor("retry_ordering")).toBe(ORDERING_BACKOFF);
    expect(policyFor("retry_period")).toBe(PERIOD_BACKOFF);
  });

  it("waits hours for a fiscal period and seconds for a transient fault", () => {
    // A locked period waits on an accountant, not on a network. One backoff
    // curve for both would either hammer the ERP or park an order for a day.
    expect(PERIOD_BACKOFF.baseMs).toBeGreaterThan(TRANSIENT_BACKOFF.maxMs);
    expect(ORDERING_BACKOFF.maxMs).toBeLessThan(TRANSIENT_BACKOFF.maxMs);
  });

  it("is most patient with a locked period, because the entry is correct", () => {
    expect(PERIOD_BACKOFF.maxAttempts).toBeGreaterThan(TRANSIENT_BACKOFF.maxAttempts);
  });
});
