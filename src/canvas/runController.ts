import type { CanvasAgentEvent } from '@/agent/types'
import type { DaemonProjectionPlan } from '@/agent/projectionPlan'
import type { SuggestedAction } from '@/agent/suggestedActions'
import type { CanvasDocument } from './model'
import type { CanvasGhostOutput, CanvasTaskRuntime } from './selectors'

export type CanvasAttachmentRef =
  | { kind: 'artifact'; runId: string; artifactId: string }
  | { kind: 'node'; nodeId: string }

export interface CanvasRunIntent {
  schemaVersion: 2
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  prompt: string
  attachments: CanvasAttachmentRef[]
  materializationPolicy: 'auto'
}

export type CanvasTaskRunStatus =
  | 'preparing'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface CanvasTaskRunSummary {
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  /** Optional only for task-run records created before intent metadata became durable. */
  baseRevision?: number
  /** Exact accepted prompt; optional only for legacy task-run records. */
  prompt?: string
  status: CanvasTaskRunStatus
  startedAt: number
  error?: string
}

/** Full trusted daemon plan; no fields are narrowed away before review/tray UI. */
export type CanvasProjectionPlanNotice = DaemonProjectionPlan
export type CanvasSuggestedActionNotice = SuggestedAction

export interface CanvasTaskRunClose {
  runId: string
  status: Extract<CanvasTaskRunStatus, 'done' | 'error' | 'cancelled' | 'interrupted'>
  artifactsComplete: boolean
  projectionPlan?: CanvasProjectionPlanNotice
  suggestedActions?: readonly CanvasSuggestedActionNotice[]
}

export type CanvasDurableRunEntry =
  | { id: number; event: 'agent-event'; data: CanvasAgentEvent }
  | { id: number; event: 'session'; data: { sessionId: string } }
  | { id: number; event: 'close'; data: CanvasTaskRunClose }

export interface CanvasTaskRunClient {
  createTaskRun(input: {
    projectDir: string
    intent: CanvasRunIntent
  }): Promise<{ runId: string }>
  /** Resolve a create whose response was lost. It must never cancel the run. */
  reconcileTaskRun(input: {
    projectDir: string
    intent: CanvasRunIntent
    cause: unknown
  }): Promise<CanvasTaskRunSummary | null>
  listTaskRuns(input: {
    projectDir: string
    branch: string
    taskId: string
  }): Promise<readonly CanvasTaskRunSummary[]>
  readTaskRunSummary(input: {
    projectDir: string
    runId: string
  }): Promise<CanvasTaskRunSummary>
  readTaskRunLog(input: {
    projectDir: string
    runId: string
    afterEventId: number
  }): Promise<{
    entries: readonly CanvasDurableRunEntry[]
    nextEventId: number | null
  }>
  attachTaskRun(input: {
    projectDir: string
    runId: string
    afterEventId: number
    signal: AbortSignal
    onEvent: (entry: { id: number; data: CanvasAgentEvent }) => void
  }): Promise<{ close: CanvasTaskRunClose }>
  cancelTaskRun(input: { projectDir: string; runId: string }): Promise<void>
}

export interface CanvasRunStoreSnapshot {
  scope: { projectDir: string; branch: string }
  hydration: { status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }
  commandSync: {
    status: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'
    pendingCount: number
    error: string | null
    conflict: unknown
  }
  envelope: { branch: string; revision: number; document: CanvasDocument } | null
  document: CanvasDocument
  runtimeByTaskId: Readonly<Record<string, CanvasTaskRuntime>>
}

/** The concrete CanvasStore satisfies this interface structurally. */
export interface CanvasRunStore {
  getSnapshot(): CanvasRunStoreSnapshot
  flushCommands(): Promise<void>
  reload(): Promise<void>
  setTaskRuntime(runtime: CanvasTaskRuntime): void
  upsertTaskGhost(taskId: string, ghost: CanvasGhostOutput): void
  clearTaskRuntime(taskId: string): void
}

export interface CanvasTaskRunLogEntry {
  eventId: number
  /** meta 行来自持久日志的会话 / 结束记录，只出现在详细日志视图。 */
  kind: 'thinking' | 'text' | 'tool' | 'warning' | 'meta'
  text: string
}

/** Agent 事件到日志行的唯一映射：实时流与持久日志回放共用，保证两种来源展示一致。 */
export function runLogLinesForAgentEvent(
  event: CanvasAgentEvent,
): readonly Pick<CanvasTaskRunLogEntry, 'kind' | 'text'>[] {
  if (event.type === 'thinking') return [{ kind: 'thinking', text: event.text }]
  if (event.type === 'text-delta') return [{ kind: 'text', text: event.text }]
  if (event.type === 'tool-call') {
    return [{ kind: 'tool', text: `→ ${event.name} ${safeDisplay(event.input)}`.trim() }]
  }
  if (event.type === 'tool-result') {
    return [{ kind: 'tool', text: `← ${safeDisplay(event.result)}` }]
  }
  if (event.type === 'error') return [{ kind: 'warning', text: event.message }]
  return []
}

export interface CanvasPermissionRequestNotice {
  taskId: string
  runId: string
  permissionId: string
  action: string
  detail: string
}

export interface CanvasProjectionSettlementNotice {
  taskId: string
  runId: string
  plan: CanvasProjectionPlanNotice
  suggestedActions: readonly CanvasSuggestedActionNotice[]
}

export interface CanvasTaskRunControllerOptions {
  store: CanvasRunStore
  client: CanvasTaskRunClient
  runId?: () => string
  maxLogEntries?: number
  maxLogCharacters?: number
  onPermissionRequest?: (notice: CanvasPermissionRequestNotice) => void | Promise<void>
  onProjectionPlan?: (notice: CanvasProjectionSettlementNotice) => void | Promise<void>
  onError?: (error: unknown) => void
}

export interface CanvasRunTaskInput {
  taskId: string
  agentId: string
  prompt?: string
  attachments?: readonly CanvasAttachmentRef[]
  signal?: AbortSignal
}

export interface CanvasTaskRunHandle {
  taskId: string
  runId: string
  completion: Promise<CanvasTaskRunClose>
  /** Detaches this browser subscriber. It never cancels the daemon run. */
  detach(): void
}

interface ActiveExecution {
  taskId: string
  runId: string
  cursor: number
  abort: AbortController
  completion: Promise<CanvasTaskRunClose>
}

const ACTIVE_STATUSES = new Set<CanvasTaskRunStatus>([
  'preparing',
  'running',
  'awaiting-permission',
])

const DEFAULT_MAX_LOG_ENTRIES = 200
const DEFAULT_MAX_LOG_CHARACTERS = 64_000

export class CanvasTaskRunBusyError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} already has an active run`)
    this.name = 'CanvasTaskRunBusyError'
  }
}

export class CanvasTaskRunController {
  readonly #store: CanvasRunStore
  readonly #client: CanvasTaskRunClient
  readonly #runId: () => string
  readonly #maxLogEntries: number
  readonly #maxLogCharacters: number
  readonly #onPermissionRequest?: CanvasTaskRunControllerOptions['onPermissionRequest']
  readonly #onProjectionPlan?: CanvasTaskRunControllerOptions['onProjectionPlan']
  readonly #onError: (error: unknown) => void
  readonly #claimedTaskIds = new Set<string>()
  readonly #activeByTaskId = new Map<string, ActiveExecution>()
  readonly #recoveryByTaskId = new Map<string, Promise<CanvasTaskRunHandle | null>>()
  readonly #logsByRunId = new Map<string, CanvasTaskRunLogEntry[]>()
  readonly #deliveredPlanIds = new Set<string>()
  readonly #settledRunIds = new Set<string>()
  #disposed = false

  constructor(options: CanvasTaskRunControllerOptions) {
    this.#store = options.store
    this.#client = options.client
    this.#runId = options.runId ?? (() => globalThis.crypto.randomUUID())
    this.#maxLogEntries = positiveInteger(
      options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES,
      'maxLogEntries',
    )
    this.#maxLogCharacters = positiveInteger(
      options.maxLogCharacters ?? DEFAULT_MAX_LOG_CHARACTERS,
      'maxLogCharacters',
    )
    this.#onPermissionRequest = options.onPermissionRequest
    this.#onProjectionPlan = options.onProjectionPlan
    this.#onError = options.onError ?? (() => undefined)
  }

  async runTask(input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle> {
    this.#assertUsable()
    if (this.#claimedTaskIds.has(input.taskId)) {
      throw new CanvasTaskRunBusyError(input.taskId)
    }
    this.#claimedTaskIds.add(input.taskId)
    let queuedRunId: string | null = null
    try {
      if (input.signal?.aborted) throw input.signal.reason
      await this.#store.flushCommands()
      const snapshot = this.#assertRunReady(input.taskId)
      const task = snapshot.document.tasks.find((candidate) => candidate.id === input.taskId)
      if (!task) throw new Error(`Task ${input.taskId} does not exist`)

      queuedRunId = this.#runId()
      assertIdentifier(queuedRunId, 'runId')
      assertIdentifier(input.agentId, 'agentId')
      const intent: CanvasRunIntent = {
        schemaVersion: 2,
        runId: queuedRunId,
        taskId: input.taskId,
        agentId: input.agentId,
        canvasBranch: snapshot.scope.branch,
        baseRevision: snapshot.envelope.revision,
        prompt: input.prompt ?? task.goal,
        attachments: normalizeAttachments(input.attachments ?? []),
        materializationPolicy: 'auto',
      }
      this.#store.setTaskRuntime({
        taskId: input.taskId,
        runId: queuedRunId,
        phase: 'queued',
        message: '等待运行',
        ghosts: [],
      })

      let recovered = false
      try {
        const created = await this.#client.createTaskRun({
          projectDir: snapshot.scope.projectDir,
          intent,
        })
        if (created.runId !== queuedRunId) {
          throw new Error(`Daemon returned unexpected run id ${created.runId}`)
        }
      } catch (cause) {
        const summary = await this.#client.reconcileTaskRun({
          projectDir: snapshot.scope.projectDir,
          intent,
          cause,
        })
        if (!summary) throw cause
        assertSummaryIdentity(summary, intent)
        recovered = true
      }

      return this.#beginExecution({
        taskId: input.taskId,
        runId: queuedRunId,
        projectDir: snapshot.scope.projectDir,
        replayDurableLog: recovered,
        signal: input.signal,
      })
    } catch (error) {
      this.#claimedTaskIds.delete(input.taskId)
      if (queuedRunId) this.#clearRuntimeIfCurrent(input.taskId, queuedRunId)
      throw error
    }
  }

  async recoverTask(taskId: string): Promise<CanvasTaskRunHandle | null> {
    this.#assertUsable()
    const active = this.#activeByTaskId.get(taskId)
    if (active) return this.#handle(active)
    const pending = this.#recoveryByTaskId.get(taskId)
    if (pending) return pending
    if (this.#claimedTaskIds.has(taskId)) throw new CanvasTaskRunBusyError(taskId)

    this.#claimedTaskIds.add(taskId)
    const operation = this.#recoverTask(taskId).finally(() => {
      if (this.#recoveryByTaskId.get(taskId) === operation) {
        this.#recoveryByTaskId.delete(taskId)
      }
      if (!this.#activeByTaskId.has(taskId)) this.#claimedTaskIds.delete(taskId)
    })
    this.#recoveryByTaskId.set(taskId, operation)
    return operation
  }

  async recoverAll(): Promise<CanvasTaskRunHandle[]> {
    this.#assertUsable()
    const snapshot = this.#store.getSnapshot()
    if (snapshot.hydration.status !== 'ready') {
      throw new Error('Canvas must be hydrated before run recovery')
    }
    const recovered = await Promise.all(snapshot.document.tasks.map((task) =>
      this.recoverTask(task.id)))
    return recovered.filter((handle): handle is CanvasTaskRunHandle => handle !== null)
  }

  async cancelTask(taskId: string): Promise<CanvasTaskRunClose | null> {
    this.#assertUsable()
    let execution = this.#activeByTaskId.get(taskId)
    if (!execution) {
      const recovered = await this.recoverTask(taskId)
      if (!recovered) return null
      execution = this.#activeByTaskId.get(taskId)
    }
    if (!execution) return null
    const projectDir = this.#store.getSnapshot().scope.projectDir
    await this.#client.cancelTaskRun({ projectDir, runId: execution.runId })
    return execution.completion
  }

  getRunLog(runId: string): readonly CanvasTaskRunLogEntry[] {
    return (this.#logsByRunId.get(runId) ?? []).map((entry) => ({ ...entry }))
  }

  async readTaskRunSummary(runId: string): Promise<CanvasTaskRunSummary> {
    this.#assertUsable()
    assertIdentifier(runId, 'runId')
    const summary = await this.#client.readTaskRunSummary({
      projectDir: this.#store.getSnapshot().scope.projectDir,
      runId,
    })
    if (summary.runId !== runId) {
      throw new Error(`Daemon returned unexpected run id ${summary.runId}`)
    }
    return structuredClone(summary)
  }

  /**
   * 读取 daemon 持久日志（跨会话保留），供详细日志视图使用。
   * 会话与结束记录映射为 meta 行；closed 表示已读到终态 close，无需继续翻页。
   */
  async readTaskRunLog(
    runId: string,
    afterEventId: number,
  ): Promise<{
    entries: readonly CanvasTaskRunLogEntry[]
    nextEventId: number | null
    closed: boolean
  }> {
    this.#assertUsable()
    assertIdentifier(runId, 'runId')
    const page = await this.#client.readTaskRunLog({
      projectDir: this.#store.getSnapshot().scope.projectDir,
      runId,
      afterEventId: Math.max(0, Math.trunc(afterEventId)),
    })
    const entries: CanvasTaskRunLogEntry[] = []
    let closed = false
    for (const entry of page.entries) {
      if (entry.event === 'agent-event') {
        for (const line of runLogLinesForAgentEvent(entry.data)) {
          entries.push({ eventId: entry.id, kind: line.kind, text: line.text })
        }
      } else if (entry.event === 'session') {
        entries.push({ eventId: entry.id, kind: 'meta', text: `建立会话 ${entry.data.sessionId}` })
      } else {
        closed = true
        entries.push({ eventId: entry.id, kind: 'meta', text: `运行结束 · ${entry.data.status}` })
      }
    }
    return { entries, nextEventId: page.nextEventId, closed }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const execution of this.#activeByTaskId.values()) {
      execution.abort.abort(new DOMException('Run subscriber detached', 'AbortError'))
    }
  }

  async #recoverTask(taskId: string): Promise<CanvasTaskRunHandle | null> {
    const snapshot = this.#store.getSnapshot()
    if (snapshot.hydration.status !== 'ready') {
      throw new Error('Canvas must be hydrated before run recovery')
    }
    if (!snapshot.document.tasks.some((task) => task.id === taskId)) return null
    const summaries = (await this.#client.listTaskRuns({
      projectDir: snapshot.scope.projectDir,
      branch: snapshot.scope.branch,
      taskId,
    })).filter((summary) =>
      summary.taskId === taskId
      && summary.canvasBranch === snapshot.scope.branch)
    const active = summaries.filter((summary) =>
      ACTIVE_STATUSES.has(summary.status) && !this.#settledRunIds.has(summary.runId))
    if (active.length > 1) {
      throw new Error(`Task ${taskId} has multiple active daemon runs`)
    }
    const latestTerminal = summaries
      .filter((candidate) => !ACTIVE_STATUSES.has(candidate.status))
      .sort(compareNewestRun)[0]
    const summary = active[0]
      ?? (latestTerminal && !this.#settledRunIds.has(latestTerminal.runId)
        ? latestTerminal
        : undefined)
    if (!summary) return null
    this.#store.setTaskRuntime({
      taskId,
      runId: summary.runId,
      phase: summaryPhase(summary.status),
      ...(summary.error ? { message: summary.error } : {}),
      ghosts: [],
    })
    return this.#beginExecution({
      taskId,
      runId: summary.runId,
      projectDir: snapshot.scope.projectDir,
      replayDurableLog: true,
    })
  }

  #beginExecution(input: {
    taskId: string
    runId: string
    projectDir: string
    replayDurableLog: boolean
    signal?: AbortSignal
  }): CanvasTaskRunHandle {
    let resolve!: (close: CanvasTaskRunClose) => void
    let reject!: (error: unknown) => void
    const completion = new Promise<CanvasTaskRunClose>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    // A UI may intentionally fire-and-forget a run; retain the rejection for
    // handle consumers without producing an unhandled browser rejection.
    void completion.catch(() => undefined)
    const abort = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) abort.abort(input.signal.reason)
      else input.signal.addEventListener('abort', () => abort.abort(input.signal?.reason), {
        once: true,
      })
    }
    if (this.#disposed) abort.abort(new DOMException('Run subscriber detached', 'AbortError'))
    const execution: ActiveExecution = {
      taskId: input.taskId,
      runId: input.runId,
      cursor: 0,
      abort,
      completion,
    }
    this.#activeByTaskId.set(input.taskId, execution)
    if (this.#isCurrent(execution)) {
      const runtime = this.#store.getSnapshot().runtimeByTaskId[input.taskId]
      const sameRun = runtime?.runId === input.runId
      const continuingRuntime = sameRun && runtime.phase !== 'queued'
      this.#store.setTaskRuntime({
        taskId: input.taskId,
        runId: input.runId,
        phase: continuingRuntime ? runtime.phase : 'running',
        // POST /runs 已被 daemon 接受后就不再是“等待运行”。恢复已有
        // runtime 时保留它的精确状态文案；新建 Run 从 queued 进入 running
        // 时让 UI 使用“正在运行”，直到第一条 Agent 事件给出更具体进度。
        ...(continuingRuntime && runtime.message ? { message: runtime.message } : {}),
        ghosts: sameRun ? runtime.ghosts : [],
      })
    }
    void this.#consumeExecution(execution, input.projectDir, input.replayDurableLog)
      .then(resolve, reject)
      .finally(() => {
        if (this.#activeByTaskId.get(input.taskId) === execution) {
          this.#activeByTaskId.delete(input.taskId)
          this.#claimedTaskIds.delete(input.taskId)
        }
      })
    return this.#handle(execution)
  }

  async #consumeExecution(
    execution: ActiveExecution,
    projectDir: string,
    replayDurableLog: boolean,
  ): Promise<CanvasTaskRunClose> {
    if (replayDurableLog) {
      const close = await this.#replayLog(execution, projectDir)
      if (close) return this.#settle(execution, close)
    }
    const result = await this.#client.attachTaskRun({
      projectDir,
      runId: execution.runId,
      afterEventId: execution.cursor,
      signal: execution.abort.signal,
      onEvent: (entry) => this.#applyAgentEvent(execution, entry.id, entry.data),
    })
    return this.#settle(execution, result.close)
  }

  async #replayLog(
    execution: ActiveExecution,
    projectDir: string,
  ): Promise<CanvasTaskRunClose | null> {
    while (!execution.abort.signal.aborted) {
      const page = await this.#client.readTaskRunLog({
        projectDir,
        runId: execution.runId,
        afterEventId: execution.cursor,
      })
      let close: CanvasTaskRunClose | null = null
      const pageStartCursor = execution.cursor
      for (const entry of page.entries) {
        if (entry.id <= execution.cursor) continue
        if (entry.event === 'agent-event') {
          this.#applyAgentEvent(execution, entry.id, entry.data)
        } else if (entry.event === 'close') {
          execution.cursor = entry.id
          close = entry.data
        } else {
          execution.cursor = entry.id
        }
      }
      if (close) return close
      if (page.nextEventId === null) return null
      if (page.nextEventId < execution.cursor || execution.cursor === pageStartCursor) {
        throw new Error(`Run ${execution.runId} log cursor did not advance`)
      }
      execution.cursor = Math.max(execution.cursor, page.nextEventId)
    }
    throw execution.abort.signal.reason
  }

  #applyAgentEvent(
    execution: ActiveExecution,
    eventId: number,
    event: CanvasAgentEvent,
  ): void {
    if (!this.#isCurrent(execution) || this.#settledRunIds.has(execution.runId)) return
    if (eventId <= execution.cursor) return
    if (eventId > execution.cursor) execution.cursor = eventId
    const current = this.#store.getSnapshot().runtimeByTaskId[execution.taskId]
    if (!current || current.runId !== execution.runId) return

    if (event.type === 'file-write') {
      const ghost = ghostFromPath(event.path)
      if (ghost) this.#store.upsertTaskGhost(execution.taskId, ghost)
      return
    }
    if (event.type === 'permission-request') {
      this.#store.setTaskRuntime({
        ...current,
        phase: 'awaiting-permission',
        message: event.detail || event.action,
      })
      this.#notifyAsync(this.#onPermissionRequest, {
        taskId: execution.taskId,
        runId: execution.runId,
        permissionId: event.id,
        action: event.action,
        detail: event.detail,
      })
      return
    }
    if (event.type === 'thinking') {
      this.#markRunning(current, '正在思考')
    } else if (event.type === 'text-delta') {
      this.#markRunning(current, '正在生成')
    } else if (event.type === 'tool-call') {
      this.#markRunning(current, `正在使用 ${event.name}`)
    } else if (event.type === 'tool-result') {
      this.#markRunning(current, '工具调用完成')
    } else if (event.type === 'error') {
      this.#markRunning(current, event.message)
    } else if (event.type === 'done') {
      this.#markRunning(current, '正在持久化产物')
    }
    for (const line of runLogLinesForAgentEvent(event)) {
      this.#appendLog(execution.runId, eventId, line.kind, line.text)
    }
  }

  async #settle(
    execution: ActiveExecution,
    close: CanvasTaskRunClose,
  ): Promise<CanvasTaskRunClose> {
    if (close.runId !== execution.runId) {
      throw new Error(`Run close belonged to ${close.runId}, expected ${execution.runId}`)
    }
    if (this.#settledRunIds.has(close.runId)) return close
    await this.#store.reload()
    const snapshot = this.#store.getSnapshot()
    if (snapshot.hydration.status !== 'ready') {
      throw new Error(snapshot.hydration.error ?? 'Canvas reload after Run close failed')
    }
    this.#settledRunIds.add(close.runId)
    if (snapshot.document.tasks.some((task) => task.id === execution.taskId)) {
      this.#store.setTaskRuntime({
        taskId: execution.taskId,
        runId: execution.runId,
        phase: terminalPhase(close),
        ...(close.status === 'error' ? { message: '运行失败' } : {}),
        // Ghosts describe transient file-write progress only. Durable close
        // reloads the real projections, so retaining ghosts would duplicate them.
        ghosts: [],
      })
    }
    const plan = close.projectionPlan
    if (plan
      && !this.#deliveredPlanIds.has(plan.planId)
      && !isPlanReviewSettled(snapshot.document, plan.planId)) {
      if (plan.runId !== execution.runId || plan.taskId !== execution.taskId) {
        throw new Error('Projection plan identity did not match its Run close')
      }
      this.#deliveredPlanIds.add(plan.planId)
      this.#notifyAsync(this.#onProjectionPlan, {
        taskId: execution.taskId,
        runId: execution.runId,
        plan,
        suggestedActions: close.suggestedActions ?? [],
      })
    }
    return close
  }

  #appendLog(
    runId: string,
    eventId: number,
    kind: CanvasTaskRunLogEntry['kind'],
    rawText: string,
  ): void {
    const text = rawText.slice(0, this.#maxLogCharacters)
    if (!text) return
    const entries = this.#logsByRunId.get(runId) ?? []
    const duplicate = entries.some((entry) => entry.eventId === eventId && entry.kind === kind)
    if (duplicate) return
    entries.push({ eventId, kind, text })
    let characters = entries.reduce((total, entry) => total + entry.text.length, 0)
    while (entries.length > this.#maxLogEntries || characters > this.#maxLogCharacters) {
      const removed = entries.shift()
      characters -= removed?.text.length ?? 0
    }
    this.#logsByRunId.set(runId, entries)
  }

  #markRunning(runtime: CanvasTaskRuntime, message: string): void {
    this.#store.setTaskRuntime({ ...runtime, phase: 'running', message })
  }

  #assertRunReady(taskId: string): CanvasRunStoreSnapshot & {
    envelope: NonNullable<CanvasRunStoreSnapshot['envelope']>
  } {
    const snapshot = this.#store.getSnapshot()
    if (snapshot.hydration.status !== 'ready') {
      throw new Error('Canvas must be hydrated before starting a run')
    }
    if (!snapshot.envelope || snapshot.envelope.branch !== snapshot.scope.branch) {
      throw new Error('Canvas has no daemon-acknowledged envelope for this branch')
    }
    if (snapshot.commandSync.pendingCount !== 0
      || snapshot.commandSync.status === 'pending'
      || snapshot.commandSync.status === 'saving') {
      throw new Error('Canvas command outbox is not empty')
    }
    if (snapshot.commandSync.status === 'conflict' || snapshot.commandSync.conflict) {
      throw new Error('Canvas has an unresolved command conflict')
    }
    if (snapshot.commandSync.status === 'error' || snapshot.commandSync.error) {
      throw new Error('Canvas command outbox failed to flush')
    }
    if (!snapshot.document.tasks.some((task) => task.id === taskId)) {
      throw new Error(`Task ${taskId} does not exist`)
    }
    return snapshot as CanvasRunStoreSnapshot & {
      envelope: NonNullable<CanvasRunStoreSnapshot['envelope']>
    }
  }

  #handle(execution: ActiveExecution): CanvasTaskRunHandle {
    return {
      taskId: execution.taskId,
      runId: execution.runId,
      completion: execution.completion,
      detach: () => execution.abort.abort(
        new DOMException('Run subscriber detached', 'AbortError'),
      ),
    }
  }

  #isCurrent(execution: ActiveExecution): boolean {
    return !this.#disposed && this.#activeByTaskId.get(execution.taskId) === execution
  }

  #clearRuntimeIfCurrent(taskId: string, runId: string): void {
    if (this.#store.getSnapshot().runtimeByTaskId[taskId]?.runId === runId) {
      this.#store.clearTaskRuntime(taskId)
    }
  }

  #notifyAsync<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void {
    if (!callback) return
    try {
      void Promise.resolve(callback(value)).catch(this.#onError)
    } catch (error) {
      this.#onError(error)
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Canvas Task Run controller is disposed')
  }
}

function terminalPhase(close: CanvasTaskRunClose): CanvasTaskRuntime['phase'] {
  if (close.projectionPlan?.status === 'partial') return 'partial'
  return close.status
}

function summaryPhase(status: CanvasTaskRunStatus): CanvasTaskRuntime['phase'] {
  if (status === 'preparing') return 'queued'
  return status
}

function compareNewestRun(
  left: CanvasTaskRunSummary,
  right: CanvasTaskRunSummary,
): number {
  return right.startedAt - left.startedAt || right.runId.localeCompare(left.runId)
}

function isPlanReviewSettled(document: CanvasDocument, planId: string): boolean {
  // Phase 10 treats proposal acceptance as settlement of the whole review:
  // selected proposals are accepted and every unselected proposal is rejected.
  // Materialization alone is deliberately not a review settlement.
  return document.receipts.some((receipt) =>
    receipt.planId === planId
    && (receipt.kind === 'proposal-acceptance' || receipt.kind === 'plan-dismissal'))
}

function ghostFromPath(rawPath: string): CanvasGhostOutput | null {
  const parts = rawPath.normalize('NFKC').replaceAll('\\', '/').split('/')
    .map((part) => stripControlCharacters(part).trim())
    .filter(Boolean)
  if (parts.includes('.ggai')) return null
  const rawName = parts.at(-1)
  if (!rawName || rawName === '.' || rawName === '..' || rawName.startsWith('.')) return null
  if (/^(?:~.*|.*(?:\.tmp|\.part|\.swp|~))$/iu.test(rawName)) return null
  const title = rawName.slice(0, 180)
  const normalizedKey = title.toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120) || 'output'
  return {
    key: `file:${normalizedKey}`,
    title,
    phase: 'writing',
  }
}

function stripControlCharacters(value: string): string {
  let result = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code > 0x1f && code !== 0x7f) result += character
  }
  return result
}

function normalizeAttachments(
  attachments: readonly CanvasAttachmentRef[],
): CanvasAttachmentRef[] {
  const result = attachments.map((attachment) => {
    if (attachment.kind === 'artifact') {
      assertIdentifier(attachment.runId, 'attachment.runId')
      if (!/^artifact_[0-9a-f]{64}$/u.test(attachment.artifactId)) {
        throw new TypeError('attachment.artifactId is invalid')
      }
      return {
        kind: 'artifact' as const,
        runId: attachment.runId,
        artifactId: attachment.artifactId,
      }
    }
    if (attachment.kind !== 'node') throw new TypeError('attachment kind is invalid')
    assertIdentifier(attachment.nodeId, 'attachment.nodeId')
    return { kind: 'node' as const, nodeId: attachment.nodeId }
  })
  const keys = result.map((attachment) => attachment.kind === 'artifact'
    ? `artifact:${attachment.runId}:${attachment.artifactId}`
    : `node:${attachment.nodeId}`)
  if (new Set(keys).size !== keys.length) throw new TypeError('attachments contain duplicates')
  return result
}

function assertSummaryIdentity(
  summary: CanvasTaskRunSummary,
  intent: CanvasRunIntent,
): void {
  if (summary.runId !== intent.runId
    || summary.taskId !== intent.taskId
    || summary.agentId !== intent.agentId
    || summary.canvasBranch !== intent.canvasBranch) {
    throw new Error('Reconciled Run did not match its intent')
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value) || value.includes('..')) {
    throw new TypeError(`${label} is invalid`)
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} is invalid`)
  return value
}

function safeDisplay(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return candidate.toString()
      if (typeof candidate === 'object' && candidate !== null) {
        if (seen.has(candidate)) return '[Circular]'
        seen.add(candidate)
      }
      return candidate
    }) ?? ''
  } catch {
    return String(value)
  }
}
