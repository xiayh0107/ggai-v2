import type {
  CanvasV2DurableRunEntry,
  CanvasV2RunIntent,
  CanvasV2TaskRunClient,
  CanvasV2TaskRunClose,
  CanvasV2TaskRunSummary,
} from '@/canvas-v2/runController'
import type { CanvasAgentEvent } from './types'
import {
  DaemonClient,
  DaemonHttpError,
  DaemonProtocolError,
  decodeDaemonRunLogEntry,
  type DaemonRunIntentV2,
} from './daemonClient'

export interface DaemonTaskRunClientV2Options {
  client: DaemonClient
  historyLimit?: number
}

const RECONCILE_ATTEMPTS = 3

/**
 * Narrow Task-owned transport. It deliberately cannot call the V1 snapshot
 * create path: the only accepted create body is a canonical RunIntent V2.
 */
export class DaemonTaskRunClientV2 implements CanvasV2TaskRunClient {
  readonly #client: DaemonClient
  readonly #historyLimit: number

  constructor(options: DaemonTaskRunClientV2Options) {
    this.#client = options.client
    this.#historyLimit = options.historyLimit ?? 2_000
    if (!Number.isSafeInteger(this.#historyLimit)
      || this.#historyLimit < 1
      || this.#historyLimit > 2_000) {
      throw new TypeError('historyLimit must be between 1 and 2000')
    }
  }

  async createTaskRun(input: {
    projectDir: string
    intent: CanvasV2RunIntent
  }): Promise<{ runId: string }> {
    return this.#client.createTaskRunV2(
      input.intent as DaemonRunIntentV2,
      input.projectDir,
    )
  }

  async reconcileTaskRun(input: {
    projectDir: string
    intent: CanvasV2RunIntent
    cause: unknown
  }): Promise<CanvasV2TaskRunSummary | null> {
    // The cause is evidence for the controller, not authority to cancel. Only
    // the client-generated run identity may be queried here.
    void input.cause
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
      let summary: Awaited<ReturnType<DaemonClient['getTaskRunV2']>>
      try {
        summary = await this.#client.getTaskRunV2(input.intent.runId, input.projectDir)
      } catch (error) {
        if (!(error instanceof DaemonHttpError) || error.status !== 404) throw error
        if (attempt + 1 === RECONCILE_ATTEMPTS) return null
        await shortDelay(50 * (attempt + 1))
        continue
      }
      if (summary.runId !== input.intent.runId
        || summary.taskId !== input.intent.taskId
        || summary.agentId !== input.intent.agentId
        || summary.canvasBranch !== input.intent.canvasBranch) {
        throw new DaemonProtocolError('Reconciled Task Run did not match its RunIntent')
      }
      return taskSummary(summary)
    }
    return null
  }

  async listTaskRuns(input: {
    projectDir: string
    branch: string
    taskId: string
  }): Promise<readonly CanvasV2TaskRunSummary[]> {
    return (await this.#client.listTaskRunsV2({
      projectDir: input.projectDir,
      taskId: input.taskId,
      branch: input.branch,
      limit: this.#historyLimit,
    })).map(taskSummary)
  }

  async readTaskRunLog(input: {
    projectDir: string
    runId: string
    afterEventId: number
  }): Promise<{
    entries: readonly CanvasV2DurableRunEntry[]
    nextEventId: number | null
  }> {
    const page = await this.#client.getRunLog(input.runId, {
      projectDir: input.projectDir,
      afterEventId: input.afterEventId,
      limit: 2_000,
    })
    const entries = page.entries.map((entry): CanvasV2DurableRunEntry => {
      const decoded = decodeDaemonRunLogEntry(entry, input.runId)
      if (decoded.event === 'agent-event') return decoded
      if (decoded.event === 'session') return decoded
      return { id: decoded.id, event: 'close', data: decoded.data }
    })
    return { entries, nextEventId: page.nextEventId }
  }

  async attachTaskRun(input: {
    projectDir: string
    runId: string
    afterEventId: number
    signal: AbortSignal
    onEvent: (entry: { id: number; data: CanvasAgentEvent }) => void
  }): Promise<{ close: CanvasV2TaskRunClose }> {
    let cursor = input.afterEventId
    const result = await this.#client.attachRun(input.runId, {
      projectDir: input.projectDir,
      afterEventId: input.afterEventId,
      signal: input.signal,
      onEvent: () => undefined,
      onEventEnvelope: (entry) => {
        if (entry.id === null) {
          throw new DaemonProtocolError('Task Run SSE Agent event did not have a durable id')
        }
        if (entry.id <= cursor) {
          throw new DaemonProtocolError('Task Run SSE Agent event cursor did not advance')
        }
        cursor = entry.id
        input.onEvent({ id: entry.id, data: entry.data })
      },
    })
    return { close: result.close }
  }

  async cancelTaskRun(input: { projectDir: string; runId: string }): Promise<void> {
    void input.projectDir
    await this.#client.cancelRun(input.runId)
  }
}

function shortDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function taskSummary(summary: {
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  status: CanvasV2TaskRunSummary['status']
  startedAt: number
  error?: string
}): CanvasV2TaskRunSummary {
  return {
    runId: summary.runId,
    taskId: summary.taskId,
    agentId: summary.agentId,
    canvasBranch: summary.canvasBranch,
    status: summary.status,
    startedAt: summary.startedAt,
    ...(summary.error === undefined ? {} : { error: summary.error }),
  }
}
