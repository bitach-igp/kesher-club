# The admin console image (T-0917). Built from the repository root:
#   docker build -f apps/admin/Dockerfile .
# Unlike the API and the worker, the console is compiled: Next builds it, workspace packages included,
# with no settings at all (T-0915), and the runtime stage keeps only the traced standalone server and the
# static assets. @kesher/tokens is built first: its `./css` export is a generated file under dist, which
# .dockerignore drops from the context. Every setting arrives as an environment variable when the task starts; nothing is baked in.
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @kesher/admin... \
 && pnpm --filter @kesher/tokens build \
 && pnpm --filter @kesher/admin build

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]
