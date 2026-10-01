import { timingSafeEqual } from "node:crypto";
import { runSandboxed } from "./runner.js";

const token = process.env.RUNNER_WORKER_TOKEN;
if (!token) throw new Error("RUNNER_WORKER_TOKEN is required.");
const validToken = (value: string | null) => {
  if (!value) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const server = Bun.serve({
  port: Number(process.env.RUNNER_PORT ?? 3200),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health")
      return Response.json({ status: "ok", service: "liege-runner" });
    if (request.method !== "POST" || path !== "/run")
      return new Response("Not found", { status: 404 });
    if (!validToken(request.headers.get("x-runner-token")))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const result = await runSandboxed(await request.json());
      return Response.json({
        ...result,
        artifacts: result.artifacts.map(({ content, ...artifact }) => ({
          ...artifact,
          contentBase64: content.toString("base64"),
        })),
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  },
});
console.log(`Liege runner listening on :${server.port}`);
