import { expect, test } from "bun:test";
import { healthPayload } from "../src/app.js";

test("health payload reports API availability", () => {
  const body = healthPayload();
  expect(body.status).toBe("ok");
  expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
});
