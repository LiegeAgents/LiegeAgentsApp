FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b
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
