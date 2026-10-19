# The API image (T-0021). Built from the repository root:
#   docker build -f apps/api/Dockerfile .
# Node runs the TypeScript sources directly with --experimental-strip-types (every package on the
# runtime path is erasable-syntax only, T-0016/T-0017), so there is no compile step. Node refuses to
# strip types under node_modules, so the workspace layout is kept: a filtered production install links
# @kesher/* to packages/* and apps/* instead of copying them (which is what `pnpm deploy` would do, and
# why it is not used here).
FROM node:22.22.0-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --prod --filter @kesher/api... \
 && pnpm store prune \
 && chown -R node:node /app
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]
