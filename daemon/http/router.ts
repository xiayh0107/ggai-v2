import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentRegistry } from '../registry.js'
import type { RunManager } from '../runs.js'

const DEFAULT_BROWSER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
])

export interface HttpRouteContext {
  readonly projectRoot: string
  readonly registry: AgentRegistry
  readonly runs: Pick<RunManager, 'getProjectionPlanRecord'>
  readonly allowedOrigins: Set<string>
  readonly lifecycle: { closing: boolean }
}

export type HttpRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpRouteContext,
) => boolean | Promise<boolean>

export function createHttpRouter(routes: readonly HttpRoute[]): HttpRoute {
  const mounted = [...routes]
  return async (request, response, context) => {
    for (const route of mounted) {
      if (await route(request, response, context)) return true
    }
    return false
  }
}

/** Applies the exact security and CORS contract used by the legacy adapter. */
export function prepareHttpRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpRouteContext,
): boolean {
  setHttpSecurityHeaders(response)
  if (context.lifecycle.closing) {
    writeHttpJson(response, 503, {
      error: { code: 'daemon_shutting_down', message: 'daemon is shutting down' },
    })
    return false
  }
  const origin = request.headers.origin
  if (origin && !context.allowedOrigins.has(origin) && !DEFAULT_BROWSER_ORIGINS.has(origin)) {
    writeHttpJson(response, 403, {
      error: { code: 'origin_denied', message: 'request origin is not allowed' },
    })
    return false
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  return true
}

export function setHttpSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}

export function writeHttpJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}
