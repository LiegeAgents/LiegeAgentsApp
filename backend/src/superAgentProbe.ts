import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import * as ipaddr from "ipaddr.js";
import { assertSafeWebhookUrl } from "./webhooks.js";

export const probeTransport = {
  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; proof: string }> {
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
    // Pin the checked IP while preserving the TLS identity. Never follow redirects.
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
          const proof = response.headers["x-liege-connection-proof"];
          resolve({
            ok:
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300,
            proof: typeof proof === "string" ? proof : "",
          });
          response.destroy();
        },
      );
      const timer = setTimeout(
        () => outgoing.destroy(new Error("Connection test timed out")),
        10000,
      );
      outgoing.on("close", () => clearTimeout(timer));
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  },
};
