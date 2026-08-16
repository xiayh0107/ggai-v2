import {
  HttpJsonRequestError,
  prepareHttpRoute,
  readHttpJson,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'
import {
  parseTaskRunPreflightRequest,
} from '../../taskRunPreflight.js'
import { TaskRunProtocolError } from '../../taskRunProtocol.js'

export function createTaskRunPreflightRoute(): HttpRoute {
  return async (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/task-runs/preflight') return false
    if (!prepareHttpRoute(request, response, context)) return true

    let input
    try {
      const projectDirs = url.searchParams.getAll('projectDir')
      if (projectDirs.length > 1) {
        throw new TaskRunProtocolError('projectDir must be specified at most once')
      }
      input = {
        projectDir: projectDirs[0] ?? '.',
        request: parseTaskRunPreflightRequest(await readHttpJson(request)),
      }
    } catch (error) {
      if (!(error instanceof TaskRunProtocolError)
        && !(error instanceof HttpJsonRequestError)) throw error
      writeHttpJson(response, 400, {
        error: {
          code: 'invalid_task_run_preflight',
          message: error.message,
        },
      })
      return true
    }

    writeHttpJson(
      response,
      200,
      await context.taskRunPreflight.inspect(input.request, input.projectDir),
    )
    return true
  }
}
