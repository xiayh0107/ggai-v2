import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentRegistry } from '../registry.js'
import type { RunManager } from '../runs.js'
import type { TaskRunPreflightService } from '../taskRunPreflight.js'

const DEFAULT_BROWSER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
])

export interface HttpRouteContext {
  readonly projectRoot: string
  readonly registry: AgentRegistry
  readonly runs: RunManager
  readonly taskRunPreflight: TaskRunPreflightService
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

/** Applies the shared security and CORS contract before a bounded route responds. */
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

export class HttpJsonRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HttpJsonRequestError'
  }
}

export async function readHttpJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new HttpJsonRequestError('request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpJsonRequestError('request body must be valid JSON')
  }
}
