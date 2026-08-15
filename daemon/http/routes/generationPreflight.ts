import { inspectGenerationServicePreflight } from '../../generationPreflight.js'
import {
  prepareHttpRoute,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'

export function createGenerationPreflightRoute(): HttpRoute {
  return async (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/generation/preflight') return false
    if (!prepareHttpRoute(request, response, context)) return true

    const agentId = url.searchParams.get('agentId') ?? ''
    try {
      writeHttpJson(
        response,
        200,
        await inspectGenerationServicePreflight(context.registry, agentId),
      )
    } catch (error) {
      writeHttpJson(response, 400, {
        error: {
          code: 'invalid_generation_preflight',
          message: error instanceof Error ? error.message : 'generation preflight is invalid',
        },
      })
    }
    return true
  }
}
