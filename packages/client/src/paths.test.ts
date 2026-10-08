import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { API_PATHS_EXACT, API_PATH_PREFIXES, isApiPath, normalizePath } from "./paths.js";

describe("isApiPath", () => {
  it("knows the API's own paths", () => {
    expect(isApiPath("/v1/accounts")).toBe(true);
    expect(isApiPath("/healthz")).toBe(true);
    expect(isApiPath("/.well-known/jwks.json")).toBe(true);
  });

  it("knows the app's", () => {
    for (const path of ["/", "/index.html", "/app.js", "/sw.js", "/config.json", "/styles.css", "/e/visit/123"]) {
      expect(isApiPath(path), path).toBe(false);
    }
  });

  it("COLLAPSES REPEATED SLASHES, because `apiBaseUrl: \"/\"` is a plausible mistake", () => {
    // It makes every request `//v1/...`, which a bare startsWith misses — and then the
    // service worker caches API answers as if they were app files. A stale answer is a
    // lie, and a silent one.
    expect(isApiPath("//v1/accounts")).toBe(true);
    expect(isApiPath("///v1//accounts")).toBe(true);
    expect(isApiPath("//healthz")).toBe(true);
    expect(normalizePath("//v1//accounts")).toBe("/v1/accounts");
  });

  it("does not match a path that merely contains one of the prefixes", () => {
    expect(isApiPath("/app/v1/thing")).toBe(false);
    expect(isApiPath("/healthzz")).toBe(false);
    expect(isApiPath("/v1")).toBe(false);
  });
});

describe("the Caddyfile", () => {
  /**
   * Caddy configuration cannot import TypeScript, so the two lists are compared instead
   * of trusted to agree. A prefix added here and forgotten there means the edge serves an
   * API path out of /srv as a 404, or — worse — proxies an app path to the API.
   */
  it("matches API_PATH_PREFIXES, since it cannot import them", () => {
    const caddyfile = readFileSync(resolve(import.meta.dirname, "../../../deploy/Caddyfile"), "utf8");
    const line = /^\s*@api path (.+)$/m.exec(caddyfile);
    expect(line, "deploy/Caddyfile has no `@api path …` matcher").not.toBeNull();

    const declared = (line?.[1] ?? "").trim().split(/\s+/).sort();
    const expected = [
      ...API_PATH_PREFIXES.map((p) => `${p}*`),
      ...API_PATHS_EXACT,
    ].sort();
    expect(declared).toEqual(expected);
  });
});
