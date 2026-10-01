import { expect, test } from "bun:test";
import { api } from "./support.js";
import { healthPayload } from "../src/app.js";
import { env } from "../src/config.js";

test("health payload reports API availability", () => {
  const body = healthPayload();
  expect(body.status).toBe("ok");
  expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
});

test("health config exposes only deployment values that clients must verify", async () => {
  const response = await api().get("/health/config").expect(200);
  expect(response.body).toEqual({
    chainId: env.RHC_ID,
    escrowMode: env.ESCROW_MODE,
    usdgTokenAddress: env.USDG_TOKEN_ADDRESS ?? null,
  });
});
