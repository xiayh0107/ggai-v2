import {
  prepareHttpRoute,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'

export function createHealthRoute(): HttpRoute {
  return (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/health') return false
    if (!prepareHttpRoute(request, response, context)) return true
    writeHttpJson(response, 200, {
      status: 'ok',
      version: 1,
      capabilities: {
        canvas: true,
        pluginArtifactCapabilities: true,
        nodeSkills: true,
      },
      canvas: {
        schemaVersion: 3,
        initializationRequired: false,
      },
      projectRoot: context.projectRoot,
    })
    return true
  }
}
