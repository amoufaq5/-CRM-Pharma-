import { describe, expect, it } from "vitest";
import { MigrationChangedError, sha256 } from "./migrate.js";

describe("sha256", () => {
  it("is stable and content-addressed", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(sha256("a")).not.toBe(sha256("b"));
    expect(sha256("")).toHaveLength(64);
  });
});

describe("MigrationChangedError", () => {
  it("names the file and tells the reader what to do instead", () => {
    const err = new MigrationChangedError("0003_rep_profile.sql", "a".repeat(64), "b".repeat(64));
    expect(err.message).toContain("0003_rep_profile.sql");
    expect(err.message).toContain("Write a new migration");
    expect(err.name).toBe("MigrationChangedError");
  });
});
