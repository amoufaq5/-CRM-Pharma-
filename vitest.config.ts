import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Contract tests talk to a real Postgres and must not interleave: they set
    // roles and tenant context on a shared connection.
    fileParallelism: false,
    // apps/ too, since the field client lives there: its transport, PKCE and storage
    // are testable without a browser, and the browser-only half is covered by
    // scripts/verify-client-live.sh driving a real Chromium.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text"] },
  },
});
