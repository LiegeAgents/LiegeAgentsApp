import { createFileRoute } from '@tanstack/react-router'

const upstreamBase = (process.env.LIEGE_API_URL || 'https://api.liegeagents.com').replace(/\/$/, '')
const forwardHeaders = ['authorization', 'content-type']

async function proxy({ request, params }: { request: Request; params: { _splat?: string } }) {
  const path = params._splat || ''
  if (!path.startsWith('v1/') || path.startsWith('v1/admin/') || path.startsWith('v1/cron/')) {
    return Response.json({ error: { code: 'not_found', message: 'Route not found.' } }, { status: 404 })
  }

  const headers = new Headers()
  for (const name of forwardHeaders) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const method = request.method.toUpperCase()
  const response = await fetch(`${upstreamBase}/${path}${new URL(request.url).search}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
  })
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of ['content-type', 'x-request-id']) {
    const value = response.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders })
}

export const Route = createFileRoute('/api/$')({
  server: { handlers: { GET: proxy, POST: proxy } },
})
