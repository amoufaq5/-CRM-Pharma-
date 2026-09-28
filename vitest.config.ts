import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Contract tests talk to a real Postgres and must not interleave: they set
    // roles and tenant context on a shared connection.
    fileParallelism: false,
    include: ["packages/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text"] },
  },
});
