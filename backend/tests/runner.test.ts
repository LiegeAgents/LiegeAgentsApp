import { expect, test } from "bun:test";
import { runSandboxed } from "../src/runner.js";

test("runner captures scoped output and artifacts in a temporary workspace", async () => {
  const result = await runSandboxed({
    command: process.execPath,
    args: [
      "-e",
      "require('fs').writeFileSync('result.txt', process.env.SCOPED_SECRET); console.log(process.env.SCOPED_SECRET);",
    ],
    env: { SCOPED_SECRET: "available-only-to-this-run" },
    artifactPaths: ["result.txt"],
  });
  expect(result.status).toBe("completed");
  expect(result.stdout).toContain("available-only-to-this-run");
  expect(result.artifacts[0]?.name).toBe("result.txt");
  expect(result.artifacts[0]?.content.toString()).toBe("available-only-to-this-run");
});

test("runner kills workloads that exceed the time limit", async () => {
  const result = await runSandboxed({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    timeoutMs: 100,
  });
  expect(result.status).toBe("timed_out");
  expect(result.error).toContain("100ms");
});

test("runner rejects workspace traversal", async () => {
  await expect(
    runSandboxed({ command: process.execPath, files: { "../escape.txt": "nope" } }),
  ).rejects.toThrow("Unsafe workspace path");
});

test("runner rejects environment variables that can alter the runtime loader", async () => {
  await expect(
    runSandboxed({ command: process.execPath, env: { NODE_OPTIONS: "--require /tmp/evil.js" } }),
  ).rejects.toThrow("Unsafe runner environment variable");
});
