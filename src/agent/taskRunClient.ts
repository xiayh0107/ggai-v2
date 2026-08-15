import type {
  CanvasDurableRunEntry,
  CanvasRunIntent,
  CanvasTaskRunClient,
  CanvasTaskRunClose,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import type { CanvasAgentEvent } from './types'
import { enabledArtifactCapabilitySnapshot } from '@/plugins/types'
import type { ArtifactCapabilitySnapshotRequest } from '@/plugins/artifactContracts'
import {
  TaskRunHttpClient,
  TaskRunHttpError,
  TaskRunProtocolError,
  decodeTaskRunLogEntry,
  type TaskRunIntentPayload,
} from './taskRunHttpClient'

export interface DaemonTaskRunClientOptions {
  client: CanvasTaskRunDaemonApi
  historyLimit?: number
  pluginCapabilities?: () => ArtifactCapabilitySnapshotRequest
}

/** The only daemon capabilities owned by Canvas Task Run orchestration. */
export type CanvasTaskRunDaemonApi = Pick<TaskRunHttpClient,
  | 'registerPluginCapabilities'
  | 'createTaskRun'
  | 'getTaskRun'
  | 'listTaskRuns'
  | 'getRunLog'
  | 'attachRun'
  | 'cancelRun'
  | 'resolvePermission'
>

const RECONCILE_ATTEMPTS = 3

/**
 * Narrow Task-owned transport. The only accepted create body is a canonical RunIntent.
 */
export class DaemonTaskRunClient implements CanvasTaskRunClient {
  readonly #client: CanvasTaskRunDaemonApi
  readonly #historyLimit: number
  readonly #pluginCapabilities: () => ArtifactCapabilitySnapshotRequest

  constructor(options: DaemonTaskRunClientOptions) {
    this.#client = options.client
    this.#historyLimit = options.historyLimit ?? 2_000
    this.#pluginCapabilities = options.pluginCapabilities ?? enabledArtifactCapabilitySnapshot
    if (!Number.isSafeInteger(this.#historyLimit)
      || this.#historyLimit < 1
      || this.#historyLimit > 2_000) {
      throw new TypeError('historyLimit must be between 1 and 2000')
    }
  }

  async createTaskRun(input: {
    projectDir: string
    intent: CanvasRunIntent
  }): Promise<{ runId: string }> {
    const registration = await this.#client.registerPluginCapabilities(
      input.projectDir,
      this.#pluginCapabilities(),
    )
    return this.#client.createTaskRun(
      input.intent as TaskRunIntentPayload,
      input.projectDir,
      undefined,
      registration.digest,
    )
  }

  async reconcileTaskRun(input: {
    projectDir: string
    intent: CanvasRunIntent
    cause: unknown
  }): Promise<CanvasTaskRunSummary | null> {
    // The cause is evidence for the controller, not authority to cancel. Only
    // the client-generated run identity may be queried here.
    void input.cause
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
      let summary: Awaited<ReturnType<CanvasTaskRunDaemonApi['getTaskRun']>>
      try {
        summary = await this.#client.getTaskRun(input.intent.runId, input.projectDir)
      } catch (error) {
        if (!(error instanceof TaskRunHttpError) || error.status !== 404) throw error
        if (attempt + 1 === RECONCILE_ATTEMPTS) return null
        await shortDelay(50 * (attempt + 1))
        continue
      }
      if (summary.runId !== input.intent.runId
        || summary.taskId !== input.intent.taskId
        || summary.agentId !== input.intent.agentId
        || summary.canvasBranch !== input.intent.canvasBranch) {
        throw new TaskRunProtocolError('Reconciled Task Run did not match its RunIntent')
      }
      return taskSummary(summary)
    }
    return null
  }

  async listTaskRuns(input: {
    projectDir: string
    branch: string
    taskId: string
  }): Promise<readonly CanvasTaskRunSummary[]> {
    return (await this.#client.listTaskRuns({
      projectDir: input.projectDir,
      taskId: input.taskId,
      branch: input.branch,
      limit: this.#historyLimit,
    })).map(taskSummary)
  }

  async readTaskRunSummary(input: {
    projectDir: string
    runId: string
  }): Promise<CanvasTaskRunSummary> {
    return taskSummary(await this.#client.getTaskRun(input.runId, input.projectDir))
  }

  async readTaskRunLog(input: {
    projectDir: string
    runId: string
    afterEventId: number
  }): Promise<{
    entries: readonly CanvasDurableRunEntry[]
    nextEventId: number | null
  }> {
    const page = await this.#client.getRunLog(input.runId, {
      projectDir: input.projectDir,
      afterEventId: input.afterEventId,
      limit: 2_000,
    })
    const entries = page.entries.map((entry): CanvasDurableRunEntry => {
      const decoded = decodeTaskRunLogEntry(entry, input.runId)
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
  }): Promise<{ close: CanvasTaskRunClose }> {
    let cursor = input.afterEventId
    const result = await this.#client.attachRun(input.runId, {
      projectDir: input.projectDir,
      afterEventId: input.afterEventId,
      signal: input.signal,
      onEvent: () => undefined,
      onEventEnvelope: (entry) => {
        if (entry.id === null) {
          throw new TaskRunProtocolError('Task Run SSE Agent event did not have a durable id')
        }
        if (entry.id <= cursor) {
          throw new TaskRunProtocolError('Task Run SSE Agent event cursor did not advance')
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
  baseRevision?: number
  prompt?: string
  status: CanvasTaskRunSummary['status']
  startedAt: number
  error?: string
}): CanvasTaskRunSummary {
  return {
    runId: summary.runId,
    taskId: summary.taskId,
    agentId: summary.agentId,
    canvasBranch: summary.canvasBranch,
    ...(summary.baseRevision === undefined ? {} : { baseRevision: summary.baseRevision }),
    ...(summary.prompt === undefined ? {} : { prompt: summary.prompt }),
    status: summary.status,
    startedAt: summary.startedAt,
    ...(summary.error === undefined ? {} : { error: summary.error }),
  }
}
