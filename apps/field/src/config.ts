import { z } from "zod";

/**
 * Runtime configuration, fetched rather than compiled in, so one bundle deploys anywhere.
 *
 * `apiBaseUrl: ""` means same origin, which is the deployed arrangement: Caddy serves
 * this app and proxies `/v1` to the API. That is not a convenience — it is why this
 * client needs no CORS on the API, and the API has none.
 */
export const FieldConfig = z.object({
  apiBaseUrl: z.string(),
  oidc: z.object({
    issuer: z.string(),
    clientId: z.string(),
    scope: z.string(),
    audience: z.string().optional(),
  }),
});
export type FieldConfig = z.infer<typeof FieldConfig>;

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<FieldConfig> {
  const response = await fetchImpl("./config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json could not be read: HTTP ${response.status}`);
  const parsed = FieldConfig.parse(await response.json());
  // A TRAILING SLASH IS STRIPPED HERE, because every path this client requests begins
  // with one. `apiBaseUrl: "/"` — a reasonable way to write "same origin, at the root" —
  // would otherwise produce `//v1/accounts`, which is the same resource to a proxy and a
  // different string to anything matching on a prefix. The service worker is hardened
  // against it too; this is the half that stops it being built at all.
  return { ...parsed, apiBaseUrl: parsed.apiBaseUrl.replace(/\/+$/, "") };
}
