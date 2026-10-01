import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config.js";
import { api, clearData, databaseAvailable, rebuildSchema } from "./support.js";

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
});
