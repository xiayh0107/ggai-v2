import { validateExecutionOutputs, type NodeExecution } from './contracts'

export class NodeExecutionClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(baseUrl: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
    this.#fetch = fetchImpl
  }

  async start(input: {
    projectDir: string
    branch: string
    nodeId: string
    force?: boolean
  }): Promise<NodeExecution> {
    const response = await this.#fetch(this.#nodeUrl(input), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: input.force ?? false }),
    })
    return decodeExecutionResponse(response)
  }

  async list(input: {
    projectDir: string
    branch: string
    nodeId: string
  }): Promise<NodeExecution[]> {
    const response = await this.#fetch(this.#nodeUrl(input))
    const value = await response.json() as unknown
    if (!response.ok) throw executionHttpError(response.status, value)
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.executions)) {
      throw new TypeError('execution history response is invalid')
    }
    return value.executions.map(parseExecution)
  }

  #nodeUrl(input: { projectDir: string; branch: string; nodeId: string }): string {
    const url = new URL(`/nodes/${encodeURIComponent(input.nodeId)}/executions`, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', input.projectDir)
    url.searchParams.set('branch', input.branch)
    return url.toString()
  }
}

async function decodeExecutionResponse(response: Response): Promise<NodeExecution> {
  const value = await response.json() as unknown
  if (!response.ok) throw executionHttpError(response.status, value)
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.execution)) {
    throw new TypeError('execution response is invalid')
  }
  return parseExecution(value.execution)
}

function parseExecution(value: unknown): NodeExecution {
  if (!isRecord(value)
    || typeof value.executionId !== 'string'
    || typeof value.nodeId !== 'string'
    || !isRecord(value.nodeTypeRef)
    || typeof value.executorId !== 'string'
    || typeof value.status !== 'string'
    || !['queued', 'awaiting-approval', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out']
      .includes(value.status)
    || !isRecord(value.outputs)
    || typeof value.startedAt !== 'string') {
    throw new TypeError('execution record is invalid')
  }
  validateExecutionOutputs(value.outputs as Record<string, never[]>)
  return structuredClone(value) as unknown as NodeExecution
}

function executionHttpError(status: number, value: unknown): Error {
  const message = isRecord(value)
    && isRecord(value.error)
    && typeof value.error.message === 'string'
    ? value.error.message
    : `execution request failed (${status})`
  return new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
