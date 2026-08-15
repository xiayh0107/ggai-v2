import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createGenerationPreflightRoute,
} from './http/routes/generationPreflight.js'
import {
  createHealthRoute,
} from './http/routes/health.js'
import {
  createProjectionPlanReadRoute,
} from './http/routes/projectionPlans.js'
import {
  createRuntimeRoute,
} from './http/routes/runtime.js'
import {
  createHttpRouter,
  setHttpSecurityHeaders,
  writeHttpJson,
  type HttpRouteContext,
} from './http/router.js'
import {
  createDaemonServer as createLegacyDaemonServer,
  type DaemonServer,
  type DaemonServerOptions,
} from './serverLegacy.js'

export type { DaemonServer, DaemonServerOptions } from './serverLegacy.js'

type RequestListener = (request: IncomingMessage, response: ServerResponse) => void

/**
 * HTTP composition adapter. New bounded-context routes mount here while the
 * existing protocol implementation remains delegated byte-for-byte until each
 * domain is migrated with protocol parity tests.
 */
export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const daemon = createLegacyDaemonServer(options)
  const legacyListeners = daemon.server.listeners('request') as RequestListener[]
  if (legacyListeners.length === 0) {
    throw new Error('legacy daemon server did not install a request listener')
  }
  daemon.server.removeAllListeners('request')

  const lifecycle = { closing: false }
  const context: HttpRouteContext = {
    projectRoot: options.projectRoot,
    registry: daemon.registry,
    runs: daemon.runs,
    allowedOrigins: new Set(options.allowedOrigins ?? []),
    lifecycle,
  }
  const router = createHttpRouter([
    createHealthRoute(),
    createRuntimeRoute(),
    createGenerationPreflightRoute(),
    createProjectionPlanReadRoute(),
  ])

  daemon.server.on('request', (request, response) => {
    void Promise.resolve(router(request, response, context))
      .then((handled: boolean) => {
        if (handled) return
        for (const listener of legacyListeners) {
          listener.call(daemon.server, request, response)
        }
      })
      .catch((error: unknown) => {
        setHttpSecurityHeaders(response)
        writeHttpJson(response, 500, {
          error: {
            code: 'internal_error',
            message: error instanceof Error ? error.message : 'internal daemon error',
          },
        })
      })
  })

  const closeLegacy = daemon.close.bind(daemon)
  let closePromise: Promise<void> | null = null
  return {
    ...daemon,
    close() {
      lifecycle.closing = true
      closePromise ??= closeLegacy()
      return closePromise
    },
  }
}
