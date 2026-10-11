// Same-origin proxy to the Liege API. It replaces a plain Vercel rewrite so the API can rate
// limit each visitor separately: the visitor's IP travels with LIEGE_PROXY_SECRET, which the
// API checks before trusting it (backend/src/operations.ts clientIp).
export const config = { runtime: "edge" };

const upstream = (process.env.LIEGE_API_URL || "https://api.liegeagents.com").replace(/\/$/, "");
const dropped = new Set([
  "host",
  "connection",
  "content-length",
  "cookie",
  "x-real-ip",
  "x-liege-proxy-secret",
  "x-liege-client-ip",
]);

export default async function handler(request) {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const [name, value] of request.headers)
    if (!dropped.has(name) && !name.startsWith("x-forwarded-") && !name.startsWith("x-vercel-"))
      headers.set(name, value);
  const visitorIp =
    request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0];
  if (process.env.LIEGE_PROXY_SECRET && visitorIp) {
    headers.set("x-liege-proxy-secret", process.env.LIEGE_PROXY_SECRET);
    headers.set("x-liege-client-ip", visitorIp.trim());
  }
  const method = request.method.toUpperCase();
  const response = await fetch(`${upstream}${url.pathname.replace(/^\/api/, "")}${url.search}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
