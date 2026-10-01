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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/acl/package.json        packages/acl/
COPY packages/api/package.json        packages/api/
COPY packages/db/package.json         packages/db/
COPY packages/relay/package.json      packages/relay/
COPY packages/scheduler/package.json  packages/scheduler/
COPY packages/sync/package.json       packages/sync/
COPY packages/territory/package.json  packages/territory/
COPY packages/visit/package.json      packages/visit/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
RUN pnpm exec tsc --build

# Drops dev dependencies in place. `--prod` after the build rather than a second
# install, so the lockfile is resolved exactly once.
RUN pnpm prune --prod

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
