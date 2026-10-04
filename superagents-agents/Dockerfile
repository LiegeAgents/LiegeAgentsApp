FROM oven/bun:1.4.2-alpine
WORKDIR /app
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA NODE_ENV=production
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile || bun install
COPY src ./src
USER bun
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3210}/health" > /dev/null || exit 1
CMD ["bun", "src/server.ts"]
