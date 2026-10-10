import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, loadCredentials, saveCredentials } from "../src/credentials.js";
import { execute, request } from "../src/index.js";

const API = "https://api.liegeagents.com";
type Json = Record<string, unknown>;

describe("CLI workspace login", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let dir = "";
  let calls: Array<{ path: string; method: string; auth: string | null; body?: Json }> = [];
  let refreshCount = 0;
  let validAccess = new Set<string>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "liege-cli-test-"));
    process.env.LIEGE_CONFIG_DIR = dir;
    process.env.LIEGE_API_URL = API;
    delete process.env.LIEGE_SESSION_TOKEN;
    calls = [];
    refreshCount = 0;
    validAccess = new Set(["access-1"]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      calls.push({ path, method, auth, body });
      const json = (status: number, data: unknown) =>
        new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "/v1/mobile/pair")
        return body?.code === "12345678"
          ? json(201, {
              deviceId: "device-1",
              accessToken: "access-1",
              refreshToken: "refresh-1",
              accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            })
          : json(401, { message: "This pairing code is invalid or expired." });
      if (path === "/v1/mobile/refresh") {
        if (body?.refreshToken !== `refresh-${refreshCount + 1}`)
          return json(401, { message: "invalid" });
        refreshCount++;
        const access = `access-${refreshCount + 1}`;
        validAccess.add(access);
        return json(200, {
          deviceId: "device-1",
          accessToken: access,
          refreshToken: `refresh-${refreshCount + 1}`,
          accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        });
      }
      const token = auth?.replace(/^Bearer /, "") ?? "";
      if (!validAccess.has(token) && token !== "env-token")
        return json(401, { message: "This session is invalid or expired." });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json(200, { ok: true });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    await rm(dir, { recursive: true, force: true });
  });

  test("pairs as a CLI device and stores private credentials", async () => {
    const result = (await execute(["login", "1234-5678", "--name", "Work laptop"])) as Json;
    expect(result).toMatchObject({ linked: true, deviceId: "device-1" });
    expect(calls[0].body).toEqual({ code: "12345678", platform: "cli", name: "Work laptop" });
    expect(calls[0].auth).toBeNull();
    const stored = JSON.parse(await readFile(credentialsPath(), "utf8"));
    expect(stored).toMatchObject({ apiUrl: API, accessToken: "access-1" });
    if (process.platform !== "win32")
      expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
  });

  test("rejects malformed and invalid pairing codes without storing anything", async () => {
    await expect(execute(["login", "1234"])).rejects.toThrow("8 digits");
    await expect(execute(["login", "87654321"])).rejects.toThrow("invalid or expired");
    expect(await loadCredentials(API)).toBeNull();
  });

  test("uses the linked token and refreshes it once it is near expiry", async () => {
    await execute(["login", "12345678"]);
    await request("/v1/jobs");
    expect(calls.at(-1)?.auth).toBe("Bearer access-1");

    const stored = (await loadCredentials(API))!;
    await saveCredentials({ ...stored, accessExpiresAt: new Date().toISOString() });
    await request("/v1/jobs");
    expect(calls.map((call) => call.path)).toContain("/v1/mobile/refresh");
    expect(calls.at(-1)?.auth).toBe("Bearer access-2");
    expect((await loadCredentials(API))?.refreshToken).toBe("refresh-2");
  });

  test("concurrent requests share a single refresh", async () => {
    await execute(["login", "12345678"]);
    const stored = (await loadCredentials(API))!;
    await saveCredentials({ ...stored, accessExpiresAt: new Date().toISOString() });
    await Promise.all([request("/v1/jobs"), request("/v1/agents"), request("/v1/invoices")]);
    expect(calls.filter((call) => call.path === "/v1/mobile/refresh")).toHaveLength(1);
  });

  test("refreshes and retries once when the access token is rejected", async () => {
    await execute(["login", "12345678"]);
    validAccess.delete("access-1");
    await request("/v1/jobs");
    expect(calls.at(-1)?.auth).toBe("Bearer access-2");
  });

  test("a revoked link clears credentials and asks to log in again", async () => {
    await execute(["login", "12345678"]);
    const stored = (await loadCredentials(API))!;
    await saveCredentials({
      ...stored,
      refreshToken: "revoked",
      accessExpiresAt: new Date().toISOString(),
    });
    await expect(request("/v1/jobs")).rejects.toThrow("liege login");
    expect(await loadCredentials(API)).toBeNull();
  });

  test("LIEGE_SESSION_TOKEN takes precedence and credentials stay bound to their API", async () => {
    await execute(["login", "12345678"]);
    process.env.LIEGE_SESSION_TOKEN = "env-token";
    await request("/v1/jobs");
    expect(calls.at(-1)?.auth).toBe("Bearer env-token");

    delete process.env.LIEGE_SESSION_TOKEN;
    process.env.LIEGE_API_URL = "https://staging.example.com";
    await expect(request("/v1/jobs")).rejects.toThrow("Not signed in");
  });

  test("logout revokes the device and removes credentials", async () => {
    await execute(["login", "12345678"]);
    expect(await execute(["logout"])).toEqual({ loggedOut: true, revoked: true });
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/mobile/devices/device-1",
      method: "DELETE",
      auth: "Bearer access-1",
    });
    expect(await loadCredentials(API)).toBeNull();
  });
});

describe("CLI public requests while linked", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("a rejected public request never sends or refreshes the linked token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "liege-cli-test-"));
    process.env.LIEGE_CONFIG_DIR = dir;
    process.env.LIEGE_API_URL = API;
    delete process.env.LIEGE_SESSION_TOKEN;
    await saveCredentials({
      apiUrl: API,
      deviceId: "device-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const calls: Array<{ path: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ error: { message: "This pairing code is invalid." } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(execute(["login", "12345678"])).rejects.toThrow("pairing code is invalid");
    expect(calls).toEqual([{ path: "/v1/mobile/pair", auth: null }]);
    expect((await loadCredentials(API))?.refreshToken).toBe("refresh-1");
    await rm(dir, { recursive: true, force: true });
  });
});
