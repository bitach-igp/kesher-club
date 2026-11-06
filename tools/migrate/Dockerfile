# The database preparation image (T-0044). Built from the repository root:
#   docker build -f tools/migrate/Dockerfile .
# It runs `node db/prepare.mjs` as a one-off Fargate task inside the VPC: roles.sql, the service roles' passwords and grants, then
# every schema's migrations with Atlas. It carries psql and the Atlas binary, which the service images must not, so it is its own
# image (kesher/migrate in ECR, built by release.yml next to api, worker and admin). The Atlas version is pinned: db/migrate.mjs
# pulls arigaio/atlas:latest on a developer machine, which a deploy must never do.
ARG ATLAS_IMAGE=arigaio/atlas:1.3.8
FROM ${ATLAS_IMAGE} AS atlas

FROM node:22.22.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=atlas /atlas /usr/local/bin/atlas
WORKDIR /app
COPY --chown=node:node db ./db
USER node
# Atlas and psql write their scratch files under HOME; the task mounts a volume at /tmp and has a read-only root.
ENV HOME=/tmp
CMD ["node", "db/prepare.mjs"]
