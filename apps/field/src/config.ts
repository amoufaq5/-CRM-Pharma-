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
  return FieldConfig.parse(await response.json());
}
