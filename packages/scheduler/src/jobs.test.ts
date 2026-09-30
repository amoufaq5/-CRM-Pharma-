import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVALS_MS,
  JOB_NAMES,
  MAX_FAILURE_BACKOFF_MULTIPLIER,
  failureBackoffMultiplier,
  nextRunAt,
} from "./jobs.js";

describe("cadences", () => {
  it("drains the outbox far more often than it sweeps snapshots", () => {
    // The relay interval is the floor on how stale "sent" looks to a rep, so it
    // is the tightest; a full sweep reads every record, so it is the loosest.
    expect(DEFAULT_INTERVALS_MS.relay_drain).toBeLessThan(DEFAULT_INTERVALS_MS.snapshot_incremental);
    expect(DEFAULT_INTERVALS_MS.snapshot_incremental).toBeLessThan(DEFAULT_INTERVALS_MS.snapshot_full);
  });

  it("covers every declared job", () => {
    for (const job of JOB_NAMES) expect(DEFAULT_INTERVALS_MS[job]).toBeGreaterThan(0);
  });
});

describe("failureBackoffMultiplier", () => {
  it("does not slow a healthy job", () => {
    expect(failureBackoffMultiplier(0)).toBe(1);
    expect(failureBackoffMultiplier(-1)).toBe(1);
  });

  it("doubles per consecutive failure", () => {
    expect(failureBackoffMultiplier(1)).toBe(2);
    expect(failureBackoffMultiplier(3)).toBe(8);
  });

  it("caps, so a broken tenant does not drift to a once-a-year retry", () => {
    expect(failureBackoffMultiplier(100)).toBe(MAX_FAILURE_BACKOFF_MULTIPLIER);
  });
});

describe("nextRunAt", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("schedules roughly one interval ahead", () => {
    const at = nextRunAt(now, 60_000, 0, () => 0.5); // 0.5 -> zero jitter
    expect(at.getTime() - now.getTime()).toBe(60_000);
  });

  it("applies +/-10% jitter, so instances started together do not stay in lockstep", () => {
    const low = nextRunAt(now, 60_000, 0, () => 0).getTime() - now.getTime();
    const high = nextRunAt(now, 60_000, 0, () => 1).getTime() - now.getTime();
    expect(low).toBe(54_000);
    expect(high).toBe(66_000);
  });

  it("backs a failing job off", () => {
    const healthy = nextRunAt(now, 60_000, 0, () => 0.5).getTime();
    const failing = nextRunAt(now, 60_000, 3, () => 0.5).getTime();
    expect(failing - now.getTime()).toBe(8 * 60_000);
    expect(failing).toBeGreaterThan(healthy);
  });

  it("never schedules sooner than a second away", () => {
    // A pathological interval or jitter must not turn the loop into a spin.
    expect(nextRunAt(now, 1000, 0, () => 0).getTime() - now.getTime()).toBeGreaterThanOrEqual(1000);
  });
});
