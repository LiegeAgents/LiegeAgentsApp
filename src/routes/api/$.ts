import { createFileRoute } from "@tanstack/react-router";

const upstreamBase = (process.env.LIEGE_API_URL || "https://api.liegeagents.com").replace(
  /\/$/,
  "",
);
const forwardHeaders = ["authorization", "content-type"];
const sessionCookie = "liege_session";
const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);

async function proxy({ request, params }: { request: Request; params: { _splat?: string } }) {
  const path = params._splat || "";
  const operatorRoute =
    path === "v1/admin/ledger/credit" ||
    path === "v1/admin/evaluators/stake" ||
    path === "v1/admin/escrows/backfill" ||
    path === "v1/admin/session" ||
    path === "v1/admin/metrics";
  if (
    !path.startsWith("v1/") ||
    (path.startsWith("v1/admin/") && !operatorRoute) ||
    path.startsWith("v1/cron/")
  ) {
    return Response.json(
      { error: { code: "not_found", message: "Route not found." } },
      { status: 404 },
    );
  }

  const headers = new Headers();
  for (const name of forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("authorization")) {
    const token = cookieValue(request, sessionCookie);
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  const method = request.method.toUpperCase();
  const response = await fetch(`${upstreamBase}/${path}${new URL(request.url).search}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
  });
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (path === "v1/auth/verify" && response.ok) {
    const payload = await response.json();
    const { token, ...session } = payload.data ?? {};
    if (token)
      responseHeaders.append(
        "Set-Cookie",
        `${sessionCookie}=${token}; Path=/api; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`,
      );
    return Response.json(
      { ...payload, data: session },
      { status: response.status, headers: responseHeaders },
    );
  }
  if (path === "v1/auth/logout")
    responseHeaders.append(
      "Set-Cookie",
      `${sessionCookie}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export const Route = createFileRoute("/api/$")({
  server: { handlers: { GET: proxy, POST: proxy, PUT: proxy } },
});
