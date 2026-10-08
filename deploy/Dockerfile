# syntax=docker/dockerfile:1
#
# One image, three entrypoints: the migrate one-shot, the API, and the scheduler.
# Compose runs the same image three ways, so what is tested is what ships —
# three separate images would drift.
#
# Multi-stage: the build stage needs dev dependencies (typescript, vitest), the
# runtime stage must not ship them. The ERP builds in a single stage and carries
# its whole toolchain into production; worth not copying.

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change reuses the dependency layer.
#
# EVERY workspace package, enumerated. Not a style choice: a package missing from
# this list is not an importer when pnpm runs, so it gets no node_modules of its
# own, and `tsc --build` below cannot resolve `@crm/db` from inside it. The failure
# is not subtle — the image does not build — and for most of this file's life eight
# of the sixteen were missing. What hid it was a build context carrying the host's
# own dist/, which made a laptop build succeed while a clean one could not.
#
# `scripts/verify-deploy-stack.sh` property 8 derives the expected list from the
# workspace and fails when this one drifts, so adding a package and forgetting it
# here is a red CI job rather than a broken deploy.
#
# A glob would be better than a list. `COPY packages/*/package.json packages/`
# flattens them onto one path; `COPY --parents`, which would not, needs the
# dockerfile:1.7-labs frontend. An unstable frontend is the worse dependency.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/field/package.json           apps/field/
COPY packages/acl/package.json         packages/acl/
COPY packages/api/package.json         packages/api/
COPY packages/callplan/package.json    packages/callplan/
COPY packages/client/package.json      packages/client/
COPY packages/credential/package.json  packages/credential/
COPY packages/db/package.json          packages/db/
COPY packages/erasure/package.json     packages/erasure/
COPY packages/expense/package.json     packages/expense/
COPY packages/notify/package.json      packages/notify/
COPY packages/relay/package.json       packages/relay/
COPY packages/role/package.json        packages/role/
COPY packages/sample/package.json      packages/sample/
COPY packages/scheduler/package.json   packages/scheduler/
COPY packages/storage/package.json     packages/storage/
COPY packages/sync/package.json        packages/sync/
COPY packages/territory/package.json   packages/territory/
COPY packages/visit/package.json       packages/visit/
RUN pnpm install --frozen-lockfile

# Sources. `.dockerignore` keeps the host's node_modules, dist/ and *.tsbuildinfo out
# of the context. Without it this COPY lands host build output on top of what pnpm
# just installed, tsc finds every project up to date, emits nothing, and the image
# ships artifacts compiled on someone's laptop rather than the ones it built.
COPY packages/ packages/
# apps/ too, and this was missing until the replay script tried to run the app build and
# found no build.mjs: the manifest layer above copies apps/field/package.json, so pnpm
# links the workspace correctly and `tsc --build` succeeds — and the bundle step a few
# lines down had nothing to bundle. A build that passes every typecheck and produces no
# app.
COPY apps/ apps/
# Builds every project in the root tsconfig's references. A package absent from that
# list is silently not built — property 10 gates that too.
RUN pnpm exec tsc --build

# The field client's bundle. Built here rather than in a second image so there is one
# source of truth for what is deployed, and built BEFORE the prod install below, because
# esbuild is a dev dependency that install removes.
#
# NODE_ENV=production is what compiles out the paste-a-token login path entirely — the
# same rule the scheduler applies to ERP_TOKEN, applied where no config file can flip it.
RUN NODE_ENV=production node apps/field/build.mjs

# Drop the dev dependencies. A second install rather than `pnpm prune --prod`, which
# this file used until the replay script ran it: in a workspace, prune empties every
# importer's node_modules and relinks only the root, so `packages/api/node_modules/@crm`
# came back EMPTY and the api died on
# `Cannot find package '@crm/callplan' imported from .../dist/handlers/routes.js`. A
# build that succeeds and an image that cannot load a single handler is the worst of the
# failures found here, because nothing before the first request would have said so.
# `pnpm -r prune` is not a thing (exit 1, dev dependencies left in place).
#
# `--frozen-lockfile` keeps the promise the prune was there for: nothing is re-resolved,
# the lockfile is read a second time and obeyed. --ignore-scripts because no dependency
# here has a postinstall worth running in an image, and
# --config.confirmModulesPurge=false because excluding dev dependencies rewrites the
# modules directory, which pnpm 10 asks about and refuses to do unasked without a TTY.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --config.confirmModulesPurge=false

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Non-root. The database enforces least privilege through crm_app; the container
# should not undo that by running everything as uid 0.
RUN useradd --system --create-home --uid 10001 crm

COPY --from=build --chown=crm:crm /app/node_modules          ./node_modules
COPY --from=build --chown=crm:crm /app/packages              ./packages
COPY --from=build --chown=crm:crm /app/package.json          ./package.json
COPY --from=build --chown=crm:crm /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml
# Migrations are data the migrate step reads at runtime, not compiled output.
COPY --chown=crm:crm db/migrations ./db/migrations

USER crm

# Overridden per service in compose. Defaults to the API, the thing most likely
# to be run by hand.
CMD ["node", "packages/api/dist/bin/api.js"]

# ---- web --------------------------------------------------------------------
# The TLS edge, carrying the app it serves.
#
# One origin for the app and the API is not a convenience: it is why neither has any CORS.
# Caddy serves these files and proxies /v1, /healthz and /.well-known to the api service
# (deploy/Caddyfile), so the browser only ever talks to one host — and a client that never
# makes a cross-origin request needs no preflight to be allowed.
#
# Built as a separate TARGET of this same Dockerfile rather than a second file, so the
# bundle the edge serves is the one the build stage produced from the committed sources.
FROM caddy:2 AS web

COPY --from=build /app/apps/field/dist /srv
