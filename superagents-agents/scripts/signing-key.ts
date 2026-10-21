// Prints a new Ed25519 signing key for one agent: the secret seed for the runtime's environment
// and the public key the runtime publishes to Liege at startup.
import { generateKeyPairSync } from "node:crypto";

const agent = (Bun.argv[2] ?? "").toUpperCase();
if (!/^[A-Z]+$/.test(agent)) throw new Error("Usage: bun run signing-key <agent>, e.g. anna");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
console.log(`${agent}_SIGNING_KEY=${Buffer.from(seed).toString("base64")}`);
console.log(`# public key: ${Buffer.from(raw).toString("base64")}`);
