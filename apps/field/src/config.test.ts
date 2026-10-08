import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const base = { oidc: { issuer: "https://idp.example", clientId: "crm-field", scope: "openid" } };

describe("loadConfig", () => {
  it("reads the deployed configuration", async () => {
    const config = await loadConfig(respond({ ...base, apiBaseUrl: "https://crm.example" }));
    expect(config.apiBaseUrl).toBe("https://crm.example");
    expect(config.oidc.clientId).toBe("crm-field");
  });

  it('strips a trailing slash, so `apiBaseUrl: "/"` cannot build `//v1/accounts`', async () => {
    // That URL is the same resource to a proxy and a different string to anything
    // matching on a prefix — including the service worker, which would then cache API
    // answers as app files.
    expect((await loadConfig(respond({ ...base, apiBaseUrl: "/" }))).apiBaseUrl).toBe("");
    expect((await loadConfig(respond({ ...base, apiBaseUrl: "https://crm.example/" }))).apiBaseUrl).toBe("https://crm.example");
    expect((await loadConfig(respond({ ...base, apiBaseUrl: "///" }))).apiBaseUrl).toBe("");
  });

  it("keeps same-origin as the empty string it already is", async () => {
    expect((await loadConfig(respond({ ...base, apiBaseUrl: "" }))).apiBaseUrl).toBe("");
  });

  it("refuses a config it cannot read rather than booting on defaults", async () => {
    // A 404 here means the file was not deployed. Guessing would give a client that
    // silently talks to the wrong host.
    await expect(loadConfig(respond({}, 404))).rejects.toThrow(/could not be read/);
    await expect(loadConfig(respond({ apiBaseUrl: "" }))).rejects.toThrow();
  });
});
