# The institution console image (T-0047). Built from the repository root:
#   docker build -f apps/console/Dockerfile .
# Like the admin image (T-0917): Next builds the console, workspace packages included, with no settings at
# all, and the runtime stage keeps only the traced standalone server and the static assets. One image serves
# every environment; CONSOLE_ENVIRONMENT and CONSOLE_API_URL arrive as environment variables when the task
# starts, and nothing is baked in.
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @kesher/console... \
 && pnpm --filter @kesher/tokens build \
 && pnpm --filter @kesher/console build

FROM node:22.22.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/console/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/console/.next/static ./apps/console/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
