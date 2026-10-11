import { expect, test } from "bun:test";

// The staking and Super Agents sites proxy /api through identical edge functions.
let seen = null;
globalThis.fetch = async (url, init) => {
  seen = { url, init };
  return new Response('{"data":1}', {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": "12",
      "content-encoding": "gzip",
    },
  });
};

for (const site of ["staking-frontend", "superagents-frontend"]) {
  const file = new URL(`../${site}/api/[...path].js`, import.meta.url).pathname;
  test(`${site}: forwards path, query, body, visitor IP + secret; drops spoofed headers`, async () => {
    process.env.LIEGE_PROXY_SECRET = "s".repeat(40);
    const { default: handler } = await import(`${file}?${site}a`);
    const res = await handler(
      new Request("https://staking.liegeagents.com/api/v1/staking/locks/0xabc?x=1", {
        method: "POST",
        body: '{"a":1}',
        headers: {
          "content-type": "application/json",
          authorization: "Bearer t",
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": "203.0.113.7",
          "x-liege-client-ip": "1.1.1.1",
          "x-liege-proxy-secret": "evil",
          cookie: "c=1",
        },
      }),
    );
    expect(seen.url).toBe("https://api.liegeagents.com/v1/staking/locks/0xabc?x=1");
    const h = new Headers(seen.init.headers);
    expect(h.get("x-liege-client-ip")).toBe("203.0.113.7");
    expect(h.get("x-liege-proxy-secret")).toBe("s".repeat(40));
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(new TextDecoder().decode(seen.init.body)).toBe('{"a":1}');
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test(`${site}: without the secret configured, no identity headers are sent (even spoofed ones)`, async () => {
    delete process.env.LIEGE_PROXY_SECRET;
    const { default: handler } = await import(`${file}?${site}b`);
    await handler(
      new Request("https://x.test/api/v1/super-agents/dashboard", {
        headers: {
          "x-real-ip": "203.0.113.7",
          "x-liege-client-ip": "1.1.1.1",
          "x-liege-proxy-secret": "evil",
        },
      }),
    );
    const h = new Headers(seen.init.headers);
    expect(seen.init.method).toBe("GET");
    expect(seen.init.body).toBeUndefined();
    expect(h.get("x-liege-client-ip")).toBeNull();
    expect(h.get("x-liege-proxy-secret")).toBeNull();
  });
}
