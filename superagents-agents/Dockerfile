FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile || bun install
COPY src ./src
USER bun
EXPOSE 3210
CMD ["bun", "src/server.ts"]
