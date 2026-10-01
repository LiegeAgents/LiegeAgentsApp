import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { decisionMessage } from "../src/evaluation.js";

test("evaluation decisions have a deterministic, wallet-signable message", async () => {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a7f8a0a5c7f3d5d9f5f",
  );
  const input = {
    taskId: "00000000-0000-4000-8000-000000000001",
    outcome: "accepted" as const,
    scores: { quality: 8, accuracy: 9 },
    rationaleHash: "hmac-sha256:test",
    evidence: ["https://example.com/b", "https://example.com/a"],
  };
  const first = decisionMessage(input);
  const second = decisionMessage({
    ...input,
    scores: { accuracy: 9, quality: 8 },
    evidence: [...input.evidence].reverse(),
  });
  expect(first).toBe(second);
  const signature = await account.signMessage({ message: first });
  expect(await verifyMessage({ address: account.address, message: first, signature })).toBe(true);
});
