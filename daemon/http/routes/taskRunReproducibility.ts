import { parseRunId, ProtocolError } from '../../protocol.js'
import {
  prepareHttpRoute,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'

export function createTaskRunReproducibilityRoute(): HttpRoute {
  return async (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = /^\/task-runs\/([^/]+)\/reproducibility$/u.exec(url.pathname)
    if (request.method !== 'GET' || !match) return false
    if (!prepareHttpRoute(request, response, context)) return true

    let runId: string
    let projectDir: string
    try {
      runId = parseRunId(decodeURIComponent(match[1]!))
      const projectDirs = url.searchParams.getAll('projectDir')
      if (projectDirs.length > 1) {
        throw new ProtocolError('projectDir must be specified at most once')
      }
      projectDir = projectDirs[0] ?? '.'
    } catch (error) {
      if (!(error instanceof ProtocolError) && !(error instanceof URIError)) throw error
      writeHttpJson(response, 400, {
        error: {
          code: 'invalid_task_run_reproducibility_request',
          message: error.message,
        },
      })
      return true
    }

    const model = await context.runs.getTaskRunReproducibility(runId, projectDir)
    if (!model) {
      writeHttpJson(response, 404, {
        error: { code: 'task_run_not_found', message: 'Task Run does not exist' },
      })
      return true
    }
    writeHttpJson(response, 200, model)
    return true
  }
}
