import {
  prepareHttpRoute,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'

export function createRuntimeRoute(): HttpRoute {
  return (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/runtime') return false
    if (!prepareHttpRoute(request, response, context)) return true
    writeHttpJson(response, 200, context.registry.runtimeDiagnostics())
    return true
  }
}
