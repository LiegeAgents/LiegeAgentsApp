import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config.js";
import { hashSessionToken } from "../src/auth.js";
import { api, bearer, clearData, databaseAvailable, rebuildSchema, signIn } from "./support.js";
import { db } from "../src/db/index.js";

describe.skipIf(!databaseAvailable)("wallet authentication", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("a newer nonce does not invalidate an earlier nonce", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const first = await api().post("/v1/auth/nonce").send({ address: account.address }).expect(201);
    await api().post("/v1/auth/nonce").send({ address: account.address }).expect(201);
    const signature = await account.signMessage({ message: first.body.data.message });
    await api()
      .post("/v1/auth/verify")
      .send({ address: account.address, nonce: first.body.data.nonce, signature })
      .expect(200);
  });

  test("rejects a signature bound to a foreign domain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = await api().post("/v1/auth/nonce").send({ address: account.address }).expect(201);
    const foreignMessage = createSiweMessage({
      address: account.address,
      chainId: env.RHC_ID,
      domain: "phishing.example",
      nonce: nonce.body.data.nonce,
      statement: "Sign in to Liege.",
      uri: "https://phishing.example",
      version: "1",
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message: foreignMessage });
    const response = await api()
      .post("/v1/auth/verify")
      .send({ address: account.address, nonce: nonce.body.data.nonce, signature })
      .expect(401);
    expect(response.body.error.code).toBe("invalid_signature");
  });

  test("allows scoped mobile sessions to read Super Agents and gates hire proposals", async () => {
    const owner = await signIn();
    const code = await api()
      .post("/v1/mobile/pairing-codes")
      .set(bearer(owner))
      .send({})
      .expect(201);
    const paired = await api()
      .post("/v1/mobile/pair")
      .send({ code: code.body.data.code, name: "Test companion", platform: "android" })
      .expect(201);
    const mobileToken = paired.body.data.accessToken as string;

    await api()
      .get("/v1/super-agents/dashboard")
      .set(bearer({ ...owner, token: mobileToken }))
      .expect(200);

    await db.query("UPDATE mobile_sessions SET scopes=$2 WHERE access_token_hash=$1", [
      hashSessionToken(mobileToken),
      ["mobile:read"],
    ]);
    const denied = await api()
      .post(`/v1/super-agents/intents/${randomUUID()}/decision`)
      .set(bearer({ ...owner, token: mobileToken }))
      .send({ decision: "approved" })
      .expect(403);
    expect(denied.body.error.code).toBe("mobile_scope_required");

    await db.query("UPDATE mobile_sessions SET scopes=$2 WHERE access_token_hash=$1", [
      hashSessionToken(mobileToken),
      ["mobile:read", "mobile:approve"],
    ]);
    const response = await api()
      .post(`/v1/super-agents/intents/${randomUUID()}/decision`)
      .set(bearer({ ...owner, token: mobileToken }))
      .send({ decision: "approved" })
      .expect(409);
    expect(response.body.error.code).toBe("proposal_unavailable");
  });
});
