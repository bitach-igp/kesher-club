# The worker image (T-0022). Built from the repository root:
#   docker build -f apps/worker/Dockerfile .
# Same shape as the API's (apps/api/Dockerfile): Node runs the TypeScript sources with
# --experimental-strip-types and the workspace layout is kept, because Node refuses to strip types under
# node_modules and the worker imports the API's services as @kesher/api/*. No port: the worker serves
# nothing; ECS stops it with SIGTERM, and it lets running jobs finish before it exits.
FROM node:22.22.0-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --prod --filter @kesher/worker... \
 && pnpm store prune \
 && chown -R node:node /app
USER node
WORKDIR /app/apps/worker
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]
