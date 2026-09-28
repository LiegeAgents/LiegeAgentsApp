export function reportRuntimeError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return
  console.error('Liege runtime error', {
    error,
    route: window.location.pathname,
    ...context,
  })
}
