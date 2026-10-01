const port = Number(process.env.PORT ?? 3002);

Bun.serve({
  port,
  fetch(request) {
    if (new URL(request.url).pathname === "/health")
      return Response.json({ status: "ok", service: "liege-mcp" });
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Liege MCP service listening on :${port}`);
