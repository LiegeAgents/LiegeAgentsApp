# Pinned by digest to the Bun version CI tests with; Dependabot proposes updates.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
# Reported by /health so a deployment can confirm which commit is serving.
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
COPY --from=deps /app/node_modules ./node_modules
# Copy only what the service runs; secrets are injected at runtime, never baked into layers.
COPY package.json tsconfig.json ./
COPY src ./src
COPY db ./db
COPY install.sh ./install.sh
COPY skill.md ./skill.md
EXPOSE 3001
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" > /dev/null || exit 1
CMD ["bun", "run", "start"]
