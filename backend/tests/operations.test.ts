import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseTrustProxy, pruneRateLimitBuckets } from "../src/operations.js";
import { api, clearData, databaseAvailable, db, rebuildSchema } from "./support.js";

test("TRUST_PROXY accepts a hop count, a boolean, or trusted addresses", () => {
  expect(parseTrustProxy("1")).toBe(1);
  expect(parseTrustProxy("false")).toBe(false);
  expect(parseTrustProxy("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
});

describe.skipIf(!databaseAvailable)("rate limiting", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("sign-in has its own budget, separate from the rest of the API", async () => {
    const address = `0x${"1".repeat(40)}`;
    for (let request = 0; request < 20; request++)
      await api().post("/v1/auth/nonce").send({ address }).expect(201);
    const limited = await api().post("/v1/auth/nonce").send({ address }).expect(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    await api().get("/v1/agents").expect(200);
  });

  test("expired buckets are pruned", async () => {
    await db.query(
      `INSERT INTO rate_limit_buckets (bucket, window_started_at, request_count) VALUES
       ('general:old', now() - interval '10 minutes', 5), ('general:current', now(), 5)`,
    );
    expect(await pruneRateLimitBuckets()).toBe(1);
    const remaining = await db.query("SELECT bucket FROM rate_limit_buckets");
    expect(remaining.rows.map((row) => row.bucket)).toEqual(["general:current"]);
  });
});
