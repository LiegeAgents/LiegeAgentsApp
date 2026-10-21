import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import * as ipaddr from "ipaddr.js";
import { assertSafeWebhookUrl } from "./webhooks.js";

type PinnedReply = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * POSTs to a runtime URL pinned to the checked public IP while preserving the TLS identity.
 * Never follows redirects. With maxBytes 0 the body is not read.
 */
async function pinnedPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: { timeoutMs: number; maxBytes: number; timeoutMessage: string },
): Promise<PinnedReply> {
  await assertSafeWebhookUrl(url);
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => ipaddr.process(item.address).range() !== "unicast")
  )
    throw new Error("Unsafe endpoint");
  const destination = addresses[0];
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: destination.address,
        family: destination.family,
        servername: isIP(hostname) ? undefined : hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "POST",
        headers: { ...headers, host: target.host },
      },
      (response) => {
        const reply = { status: response.statusCode ?? 0, headers: response.headers };
        if (!options.maxBytes) {
          resolve({ ...reply, body: "" });
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            reject(new Error("The runtime's reply is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ ...reply, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => outgoing.destroy(new Error(options.timeoutMessage)),
      options.timeoutMs,
    );
    outgoing.on("close", () => clearTimeout(timer));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

export const probeTransport = {
  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; proof: string }> {
    const reply = await pinnedPost(url, body, headers, {
      timeoutMs: 10_000,
      maxBytes: 0,
      timeoutMessage: "Connection test timed out",
    });
    const proof = reply.headers["x-liege-connection-proof"];
    return {
      ok: reply.status >= 200 && reply.status < 300,
      proof: typeof proof === "string" ? proof : "",
    };
  },
};

/** Sends an instant call and waits for the runtime's answer. */
export const callTransport = {
  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; proof: string; body: string }> {
    const reply = await pinnedPost(url, body, headers, {
      timeoutMs,
      maxBytes: 512_000,
      timeoutMessage: "The agent did not answer in time.",
    });
    const proof = reply.headers["x-liege-call-proof"];
    return {
      status: reply.status,
      proof: typeof proof === "string" ? proof : "",
      body: reply.body,
    };
  },
};
