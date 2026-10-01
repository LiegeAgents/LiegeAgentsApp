FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/runner.ts src/runner-worker.ts ./src/
RUN mkdir /workspace && chown bun:bun /workspace
ENV NODE_ENV=production RUNNER_PORT=3200
USER bun
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3200/health > /dev/null || exit 1
CMD ["bun", "src/runner-worker.ts"]
