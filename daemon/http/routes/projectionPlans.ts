import { parseCanvasBranch, ProtocolError } from '../../protocol.js'
import {
  prepareHttpRoute,
  writeHttpJson,
  type HttpRoute,
} from '../router.js'

const PLAN_ID = /^plan_[0-9a-f]{64}$/u

/**
 * GET is an audit/read endpoint and therefore returns retained dismissed plans
 * as well as pending ones. Mutation endpoints continue to resolve only pending
 * plans through the trusted command path.
 */
export function createProjectionPlanReadRoute(): HttpRoute {
  return async (request, response, context) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(/^\/projection-plans\/([^/]+)$/u)
    if (request.method !== 'GET' || !match) return false
    if (!prepareHttpRoute(request, response, context)) return true

    try {
      const planId = projectionPlanIdFromPath(match[1] ?? '')
      const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
      const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
      const record = await context.runs.getProjectionPlanRecord(planId, projectDir, branch)
      if (!record) {
        writeHttpJson(response, 404, {
          error: {
            code: 'projection_plan_not_found',
            message: 'projection plan not found',
          },
        })
        return true
      }
      writeHttpJson(response, 200, {
        plan: record.plan,
        suggestedActions: record.suggestedActions,
      })
    } catch (error) {
      if (error instanceof ProtocolError) {
        writeHttpJson(response, error.status, {
          error: { code: error.code, message: error.message },
        })
        return true
      }
      throw error
    }
    return true
  }
}

function projectionPlanIdFromPath(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new ProtocolError('projection plan id is malformed')
  }
  if (!PLAN_ID.test(decoded)) {
    throw new ProtocolError('projection plan id is invalid')
  }
  return decoded
}

function singleQueryParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) throw new ProtocolError(`${name} must be provided at most once`)
  return values[0]
}
