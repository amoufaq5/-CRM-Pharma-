/**
 * The bundle. esbuild, because a PWA must be a known, fixed set of files.
 *
 * tsc is not the build here — it typechecks (`pnpm --filter @crm/field typecheck`) and
 * emits nothing. The reason is the service worker: it precaches the app shell by name, so
 * the shell has to be a handful of files this script can enumerate, not a module graph
 * that reaches into node_modules for zod's twenty-odd files and changes shape on upgrade.
 *
 * DEV_TOKEN_LOGIN is baked in at build time, not read at runtime. A production bundle
 * does not contain the paste-a-token path at all — the same rule the scheduler applies to
 * ERP_TOKEN, applied where it cannot be flipped by a config file an operator mis-copies.
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "dist");
const production = process.env["NODE_ENV"] === "production";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  platform: "browser",
  minify: production,
  sourcemap: !production,
  logLevel: "warning",
  define: {
    __DEV_TOKEN_LOGIN__: production ? "false" : "true",
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
};

await build({ ...common, entryPoints: [resolve(here, "src/main.ts")], outfile: resolve(out, "app.js") });

// The service worker is its own bundle: a worker cannot be a module the page imports, and
// `importScripts` of a module graph is worse than compiling it separately.
await build({
  ...common,
  entryPoints: [resolve(here, "src/sw.ts")],
  outfile: resolve(out, "sw.js"),
  format: "iife",
});

for (const file of ["index.html", "styles.css", "manifest.webmanifest", "icon.svg", "config.json"]) {
  await cp(resolve(here, "public", file), resolve(out, file));
}

console.log(`built apps/field -> dist (${production ? "production" : "development"})`);
