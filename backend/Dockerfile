FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# Copy only what the service runs; secrets are injected at runtime, never baked into layers.
COPY package.json tsconfig.json ./
COPY src ./src
COPY db ./db
EXPOSE 3001
USER bun
CMD ["bun", "run", "start"]
