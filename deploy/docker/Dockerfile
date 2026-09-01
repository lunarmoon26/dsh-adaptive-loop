# syntax=docker/dockerfile:1
# DSH Adaptive Loop — pinned container-hosted deepseek-harness.
# Build: pnpm run build && docker build -f deploy/docker/Dockerfile \
#   -t dsh-adaptive-loop/dsh:0.1.1-rc.2 \
#   -t dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 .
# The workspace is bind-mounted at /workspace; dal runs inside the container as
# /opt/dal (dist + schemas + config + linux-built node_modules with the
# bwrap/Landlock sandbox chain).

FROM node:24-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV NODE_ENV=production

# bubblewrap: the first rung of the dsh sandbox chain on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The harness CLI plus pnpm (dsh plugin manages profiles through pnpm).
# pnpm comes from corepack: an npm -g pnpm install collides with the
# corepack shims on node:24-slim (pnpx EEXIST).
RUN corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && npm install -g @deepseek-ai/dsh@0.1.1-rc.2

# The dal runtime: linux-built dependencies first (koffi/landlock prebuilds),
# then the compiled dist and the schemas/config the runtime reads. The full
# install keeps tsx so in-container verifier commands can run the workspace's
# TypeScript graders.
WORKDIR /opt/dal
COPY package.json pnpm-workspace.yaml .npmrc /opt/dal/
RUN pnpm install --prefer-offline || pnpm install

COPY dist /opt/dal/dist
COPY schemas /opt/dal/schemas
COPY config /opt/dal/config

# The benchmark workspace's typed workflow tools, resolvable from the
# profile install anchor so --patch overlays can mount them.
COPY benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools /opt/dal/plugins/dal-workflow-tools
RUN npm install -g /opt/dal/plugins/dal-workflow-tools

WORKDIR /workspace
CMD ["dsh", "--help"]
