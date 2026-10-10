import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { api, bearer, clearData, databaseAvailable, rebuildSchema, signIn } from "./support.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!databaseAvailable)("CLI workspace pairing", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function pair(owner: User, platform: "cli" | "android") {
    const code = await api().post("/v1/mobile/pairing-codes").set(bearer(owner)).expect(201);
    const paired = await api()
      .post("/v1/mobile/pair")
      .send({ code: code.body.data.code, platform, name: `${platform} device` })
      .expect(201);
    return paired.body.data as {
      deviceId: string;
      accessToken: string;
      refreshToken: string;
    };
  }

  const asToken = (token: string) => ({ Authorization: `Bearer ${token}` });

  test("a CLI paired with a workspace code acts as the owner's operator session", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    const viaCli = await api().get("/v1/invoices").set(asToken(cli.accessToken)).expect(200);
    const viaSession = await api().get("/v1/invoices").set(bearer(owner)).expect(200);
    expect(viaCli.body.data).toEqual(viaSession.body.data);

    const devices = await api().get("/v1/mobile/devices").set(bearer(owner)).expect(200);
    expect(devices.body.data).toEqual([
      expect.objectContaining({ id: cli.deviceId, platform: "cli", name: "cli device" }),
    ]);
  });

  test("Android companion tokens stay limited to mobile routes", async () => {
    const owner = await signIn();
    const android = await pair(owner, "android");
    await api().get("/v1/invoices").set(asToken(android.accessToken)).expect(401);
    await api().get("/v1/mobile/overview").set(asToken(android.accessToken)).expect(200);
  });

  test("refreshing keeps CLI access and rotates the refresh token", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    const refreshed = await api()
      .post("/v1/mobile/refresh")
      .send({ refreshToken: cli.refreshToken })
      .expect(200);
    await api().get("/v1/invoices").set(asToken(refreshed.body.data.accessToken)).expect(200);
    await api().post("/v1/mobile/refresh").send({ refreshToken: cli.refreshToken }).expect(401);
  });

  test("revoking the device from the workspace ends CLI access", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    await api().delete(`/v1/mobile/devices/${cli.deviceId}`).set(bearer(owner)).expect(204);
    await api().get("/v1/invoices").set(asToken(cli.accessToken)).expect(401);
    await api().post("/v1/mobile/refresh").send({ refreshToken: cli.refreshToken }).expect(401);
  });

  test("a CLI can revoke its own device on logout", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    await api()
      .delete(`/v1/mobile/devices/${cli.deviceId}`)
      .set(asToken(cli.accessToken))
      .expect(204);
    await api().get("/v1/invoices").set(asToken(cli.accessToken)).expect(401);
  });

  test("a linked CLI can use the Super Agents chat endpoints", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    await api().get("/v1/super-agents/dashboard").set(asToken(cli.accessToken)).expect(200);
    await api().get("/v1/super-agents/intents").set(asToken(cli.accessToken)).expect(200);
    await api()
      .post("/v1/super-agents/intents/parse")
      .set(asToken(cli.accessToken))
      .send({ text: "Hire Anna for a brief, budget 5 USDG" })
      .expect(200);
  });

  test("Super Agent proposals can be created from the CLI", async () => {
    const owner = await signIn();
    const cli = await pair(owner, "cli");
    // No enrolled agent matches, so the request is refused before anything is stored.
    const response = await api()
      .post("/v1/super-agents/intents")
      .set(asToken(cli.accessToken))
      .send({ text: "Hire Nobody for a brief, budget 5 USDG", source: "cli" })
      .expect(422);
    expect(response.body.error.code).toBe("agent_unavailable");
    await api()
      .post("/v1/super-agents/intents")
      .set(asToken(cli.accessToken))
      .send({ text: "Hire Nobody", source: "mcp" })
      .expect(400);
  });
});
