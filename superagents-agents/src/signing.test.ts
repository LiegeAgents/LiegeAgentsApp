import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { deliverableSha256, signDeliverable, signingKeyFrom } from "./signing.js";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const seed = () =>
  Buffer.from(
    generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .subarray(-32),
  ).toString("base64");

describe("deliverable signing", () => {
  test("a seed gives a key whose signature Liege's check accepts", () => {
    const key = signingKeyFrom(seed(), "anna");
    expect(key?.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const jobId = "7bb46aff-d280-4ca8-8ea0-19c009fa166d";
    const signature = signDeliverable(key!, jobId, "# Report");
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    // The same check the API and a receipt holder run.
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(key!.publicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    const message = (text: string) =>
      Buffer.from(`liege-deliverable:v1:${jobId}:${deliverableSha256(text)}`);
    expect(verify(null, message("# Report"), publicKey, Buffer.from(signature, "base64"))).toBe(
      true,
    );
    expect(verify(null, message("# Other"), publicKey, Buffer.from(signature, "base64"))).toBe(
      false,
    );
    expect(deliverableSha256("abc")).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("a missing or malformed seed turns signing off instead of stopping the runtime", () => {
    expect(signingKeyFrom(undefined, "anna")).toBeNull();
    expect(signingKeyFrom("  ", "anna")).toBeNull();
    expect(signingKeyFrom("dG9vIHNob3J0", "anna")).toBeNull();
  });
});
