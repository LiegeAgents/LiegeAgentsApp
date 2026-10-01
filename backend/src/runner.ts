import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

export type RunnerArtifact = { name: string; sizeBytes: number; sha256: string; content: Buffer };
export type SandboxResult = {
  runId: string;
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  artifacts: RunnerArtifact[];
};

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_ARTIFACT_BYTES = 5_000_000;
const forbiddenEnvironment = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_)/;
const safeRelative = (value: string) => {
  const normalized = value.replaceAll("\\", "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..")
    ? normalized
    : null;
};

export async function runSandboxed(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  artifactPaths?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<SandboxResult> {
  for (const key of Object.keys(input.env ?? {}))
    if (forbiddenEnvironment.test(key))
      throw new Error(`Unsafe runner environment variable: ${key}`);
  const runId = randomUUID();
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 100), MAX_TIMEOUT_MS);
  const maxOutputBytes = Math.min(
    Math.max(input.maxOutputBytes ?? 256_000, 1_024),
    MAX_OUTPUT_BYTES,
  );
  const workspace = await mkdtemp(`${tmpdir()}/liege-runner-`);
  try {
    for (const [relative, content] of Object.entries(input.files ?? {})) {
      const safe = safeRelative(relative);
      if (!safe) throw new Error(`Unsafe workspace path: ${relative}`);
      const destination = resolve(workspace, safe);
      if (!destination.startsWith(`${workspace}${sep}`))
        throw new Error(`Unsafe workspace path: ${relative}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }
    const output = await execute(input.command, input.args ?? [], {
      cwd: workspace,
      env: { ...(input.env ?? {}), PATH: process.env.PATH ?? "/usr/bin:/bin", LIEGE_RUN_ID: runId },
      timeoutMs,
      maxOutputBytes,
    });
    const artifacts: RunnerArtifact[] = [];
    for (const requested of input.artifactPaths ?? []) {
      const safe = safeRelative(requested);
      if (!safe) continue;
      const path = resolve(workspace, safe);
      if (!path.startsWith(`${workspace}${sep}`)) continue;
      try {
        const content = await readFile(path);
        if (content.byteLength > MAX_ARTIFACT_BYTES) continue;
        artifacts.push({
          name: safe,
          sizeBytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          content,
        });
      } catch {}
    }
    return { runId, ...output, artifacts };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function execute(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
) {
  return new Promise<Omit<SandboxResult, "runId" | "artifacts">>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, options.maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }, options.timeoutMs);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed",
        exitCode,
        stdout,
        stderr,
        error: timedOut
          ? `Execution exceeded ${options.timeoutMs}ms.`
          : exitCode === 0
            ? null
            : `Process exited with code ${exitCode}.`,
      });
    });
  });
}
