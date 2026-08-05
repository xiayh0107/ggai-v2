import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { RunOutcome, SuggestedAction } from '../src/agent/outcome.js'
import type { RunOutcomeV2 } from '../src/agent/outcomeV2.js'
import type { CanvasAgentEvent } from '../src/agent/types.js'
import type { ArtifactManifestV1 } from './artifactManifestV2.js'
import { artifactRunRelativeDir, isArtifactControlPath } from './artifactPaths.js'
import { canvasBranchStorageId } from './canvasStore.js'
import { readRunOutcome } from './outcome.js'
import { readRunOutcomeV2 } from './outcomeV2.js'
import { listArtifactSnapshot, prepareRunContext } from './packer.js'
import {
  assessWritePath,
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
  resolveProjectDir,
  type ProjectScope,
} from './permissions.js'
import type {
  DaemonRunStatus,
  RunClosePayload,
  RunStreamMessage,
  RunSummary,
} from './protocol.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'
import { AgentRegistry } from './registry.js'
import { RunLogExistsError, RunLogStore, type RunLogPage } from './runLogs.js'
import {
  RunArtifactStoreV2,
  type RunArtifactLookupV2,
} from './runArtifactStorageV2.js'
import { SessionStore, type SessionRecord } from './sessions.js'
import {
  TaskSessionStoreV2,
  type TaskSessionListFilterV2,
  type TaskSessionRecordV2,
} from './taskSessionsV2.js'
import {
  isResolvedTaskRunRequestV2,
  requestedRunSessionId,
  runTargetId,
  type RunExecutionRequest,
} from './taskRunTypesV2.js'
import type { AgentProcessTransport } from './transport/types.js'
import { watchArtifacts, type ArtifactWatcher } from './watcher.js'
import { BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 } from './projectionPluginsV2.js'
import type { ProjectionPlanV2, ProjectionSettlementV2 } from './projectionPlanV2.js'
import { ProjectionPlanStoreV2 } from './projectionPlanStoreV2.js'

const EVENT_HISTORY_LIMIT = 2_000
const EVENT_HISTORY_BYTES = 1024 * 1024
const FINISHED_RUN_LIMIT = 50
const MAX_ACTIVE_RUNS = 4
const MAX_SUBSCRIBERS_PER_RUN = 8
const WATCHER_SETTLE_MS = 350

type BufferedStreamMessage = RunStreamMessage & { id: number }

type RunListener = (message: BufferedStreamMessage) => void

interface InternalRun {
  summary: RunSummary
  projectDir: string
  /** Writable source checkout for this canvas branch, when explicitly bound. */
  sourceProjectDir: string | null
  scope: ProjectScope
  request: RunExecutionRequest
  transport: AgentProcessTransport
  abortController: AbortController
  messages: BufferedStreamMessage[]
  historyBytes: number
  listeners: Set<RunListener>
  nextEventId: number
  closed: boolean
  doneEventSent: boolean
  transportSettled: boolean
  cancelRequested: boolean
  cancelPromise: Promise<boolean> | null
  stopReason: Extract<CanvasAgentEvent, { type: 'done' }>['stopReason'] | null
  lastFileEvents: Map<string, number>
  pendingPermissionIds: Set<string>
  closedPromise: Promise<void>
  resolveClosed: () => void
  acceptancePromise: Promise<void>
  resolveAcceptance: () => void
  acceptanceState: 'pending' | 'accepted' | 'rejected'
  acceptanceError?: unknown
  logStore: RunLogStore
  logError?: unknown
}

export interface RunSubscription {
  history: BufferedStreamMessage[]
  closed: boolean
  replayGap: boolean
  unsubscribe(): void
}

export interface RunManagerOptions {
  projectRoot: string
  registry?: AgentRegistry
  /** Acquires the process-wide project lease before any run-owned state is opened. */
  acquireProjectLease?: (projectDir: string) => Promise<string>
  /** Best-effort post-close hook for branch-scoped source checkpointing. */
  onRunFinished?: (event: RunFinishedEvent) => Promise<void>
  /** Resolves an explicitly managed source worktree for a logical canvas branch. */
  resolveSourceProjectDir?: (input: {
    projectDir: string
    canvasBranch: string
  }) => Promise<string | null>
  /** Test seam for deterministic artifact settlement without OS watcher limits. */
  watchArtifacts?: typeof watchArtifacts
}

export interface RunFinishedEvent {
  summary: RunSummary
  request: RunExecutionRequest
  projectDir: string
}

interface PendingRunCreation {
  projectDir: string
  canvasBranch: string
  targetId: string
  agentId: string
  requestIdentity: string
  promise: Promise<RunSummary>
}

interface TerminalArtifactSnapshot {
  files: string[]
  complete: boolean
  manifest?: ArtifactManifestV1
}

export class RunManager {
  readonly #projectRoot: string
  readonly #registry: AgentRegistry
  readonly #acquireProjectLease?: RunManagerOptions['acquireProjectLease']
  readonly #onRunFinished?: (event: RunFinishedEvent) => Promise<void>
  readonly #resolveSourceProjectDir?: RunManagerOptions['resolveSourceProjectDir']
  readonly #watchArtifacts: typeof watchArtifacts
  readonly #runs = new Map<string, InternalRun>()
  readonly #tasks = new Map<string, Promise<void>>()
  readonly #sessionStores = new Map<string, SessionStore>()
  readonly #taskSessionStores = new Map<string, TaskSessionStoreV2>()
  readonly #artifactStoresV2 = new Map<string, RunArtifactStoreV2>()
  readonly #projectionPlanStoresV2 = new Map<string, ProjectionPlanStoreV2>()
  readonly #runLogStores = new Map<string, RunLogStore>()
  readonly #runLogRecovery = new Map<string, Promise<void>>()
  readonly #pendingCreates = new Map<string, PendingRunCreation>()
  readonly #branchRunLeases = new Map<string, Set<string>>()
  readonly #branchMutationLeases = new Set<string>()
  #closing = false

  constructor(options: RunManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#registry = options.registry ?? new AgentRegistry()
    this.#acquireProjectLease = options.acquireProjectLease
    this.#onRunFinished = options.onRunFinished
    this.#resolveSourceProjectDir = options.resolveSourceProjectDir
    this.#watchArtifacts = options.watchArtifacts ?? watchArtifacts
  }

  async create(request: RunExecutionRequest): Promise<RunSummary> {
    this.#assertOpen()
    // Pin the revision payload before any asynchronous lease/path work so a
    // caller cannot mutate the context while the run is being accepted.
    if (isResolvedTaskRunRequestV2(request)) request = structuredClone(request)
    const transport = this.#registry.resolve(request.agentId)
    if (!transport) {
      throw new ProtocolError(`unknown agent: ${request.agentId}`, 'unknown_agent', 404)
    }
    const leasedProjectDir = await this.#leaseProject(request.projectDir ?? '.')
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: leasedProjectDir,
    })
    this.#assertOpen()
    const projectDir = scope.projectDir
    const canvasBranch = request.canvasBranch ?? 'main'
    const runId = request.runId ?? randomUUID()
    const existing = this.#runs.get(runId)
    if (existing) {
      if (sameRunIdentity(existing, request, projectDir, canvasBranch)) {
        await existing.acceptancePromise
        if (existing.acceptanceState === 'rejected') throw existing.acceptanceError
        return { ...existing.summary }
      }
      throw new ProtocolError('run id already exists', 'run_already_exists', 409)
    }
    const pending = this.#pendingCreates.get(runId)
    if (pending) {
      if (samePendingRunIdentity(pending, request, projectDir, canvasBranch)) {
        return { ...await pending.promise }
      }
      throw new ProtocolError('run id already exists', 'run_already_exists', 409)
    }

    const leaseKey = this.#reserveRunBranch(projectDir, canvasBranch, runId)
    const creation = this.#createReserved({
      request,
      transport,
      scope,
      projectDir,
      canvasBranch,
      runId,
      leaseKey,
    })
    const reservation: PendingRunCreation = {
      projectDir,
      canvasBranch,
      targetId: runTargetId(request),
      agentId: request.agentId,
      requestIdentity: runRequestIdentity(request),
      promise: creation,
    }
    this.#pendingCreates.set(runId, reservation)
    const clearReservation = () => {
      if (this.#pendingCreates.get(runId) === reservation) this.#pendingCreates.delete(runId)
    }
    void creation.then(clearReservation, clearReservation)
    return creation
  }

  async #createReserved(input: {
    request: RunExecutionRequest
    transport: AgentProcessTransport
    scope: ProjectScope
    projectDir: string
    canvasBranch: string
    runId: string
    leaseKey: string
  }): Promise<RunSummary> {
    const {
      request,
      transport,
      scope,
      projectDir,
      canvasBranch,
      runId,
      leaseKey,
    } = input
    let leaseTransferred = false
    try {
      const sourceCandidate = this.#resolveSourceProjectDir
        ? await this.#resolveSourceProjectDir({ projectDir, canvasBranch })
        : null
      const sourceProjectDir = sourceCandidate
        ? await validateSourceExecutionDir(scope, sourceCandidate)
        : null
      await assertDaemonRunLogPath(scope)
      this.#assertOpen()
      const logStore = this.#runLogs(projectDir)
      await this.#runLogRecovery.get(projectDir)
      this.#assertOpen()
      if (await logStore.summary(runId)) {
        throw new ProtocolError(
          'run id already exists in durable history',
          'run_already_exists',
          409,
        )
      }
      if (sourceProjectDir && [...this.#runs.values()].some((run) =>
        run.sourceProjectDir === sourceProjectDir
        && (!run.closed || this.#tasks.has(run.summary.runId)))) {
        throw new ProtocolError(
          'source worktree already has an active run',
          'source_worktree_busy',
          409,
        )
      }
      // No await between this check and insertion: concurrent HTTP requests cannot overbook the slot.
      const activeRuns = [...this.#runs.values()].filter((run) => !run.closed).length
      if (activeRuns >= MAX_ACTIVE_RUNS) {
        throw new ProtocolError('too many active runs', 'run_capacity_reached', 429)
      }
      if ([...this.#runs.values()].some((run) =>
        !run.closed
        && run.projectDir === projectDir
        && runTargetId(run.request) === runTargetId(request)
        && (run.request.canvasBranch ?? 'main') === canvasBranch)) {
        const targetKind = isResolvedTaskRunRequestV2(request) ? 'task' : 'node'
        throw new ProtocolError(
          `this ${targetKind} already has an active run`,
          `${targetKind}_run_active`,
          409,
        )
      }
      const targetId = runTargetId(request)
      const summary: RunSummary = {
        runId,
        ...(isResolvedTaskRunRequestV2(request) ? { taskId: request.taskId } : {}),
        nodeId: targetId,
        agentId: request.agentId,
        canvasBranch,
        status: 'preparing',
        startedAt: Date.now(),
        sessionId: null,
      }
      const closed = deferred()
      const acceptance = deferred()
      const run: InternalRun = {
        summary,
        projectDir,
        sourceProjectDir,
        scope,
        request,
        transport,
        abortController: new AbortController(),
        messages: [],
        historyBytes: 0,
        listeners: new Set(),
        nextEventId: 1,
        closed: false,
        doneEventSent: false,
        transportSettled: false,
        cancelRequested: false,
        cancelPromise: null,
        stopReason: null,
        lastFileEvents: new Map(),
        pendingPermissionIds: new Set(),
        closedPromise: closed.promise,
        resolveClosed: closed.resolve,
        acceptancePromise: acceptance.promise,
        resolveAcceptance: acceptance.resolve,
        acceptanceState: 'pending',
        logStore,
      }
      this.#runs.set(runId, run)
      try {
        await logStore.start(summary)
        const descriptor = (await this.#registry.probe())
          .find((candidate) => candidate.id === request.agentId)
        if (!descriptor?.available) {
          throw new ProtocolError(
            descriptor?.detail || `agent is unavailable: ${request.agentId}`,
            'agent_unavailable',
            503,
          )
        }
        this.#assertOpen()
        await assertManagedPaths(
          scope,
          targetId,
          runId,
          canvasBranch,
          isResolvedTaskRunRequestV2(request),
        )
        run.acceptanceState = 'accepted'
        run.resolveAcceptance()
      } catch (error) {
        // The map entry is a reservation: it closes the key-level race while the
        // asynchronous symlink/path checks run, but failed requests leave no run.
        const rejection = error instanceof RunLogExistsError
          ? new ProtocolError(
              'run id already exists in durable history',
              'run_already_exists',
              409,
            )
          : error
        run.acceptanceState = 'rejected'
        run.acceptanceError = rejection
        run.resolveAcceptance()
        if (error instanceof RunLogExistsError) {
          this.#runs.delete(runId)
          throw rejection
        }
        const message = error instanceof Error ? error.message : String(error)
        run.summary.error = message
        this.#publishAgentEvent(run, { type: 'error', message })
        this.#publishAgentEvent(run, { type: 'done', stopReason: 'error' })
        await this.#finish(run, 'error', [], false)
        this.#runs.delete(runId)
        throw error
      }
      const task = this.#execute(run).finally(() => {
        this.#tasks.delete(runId)
        this.#releaseRunBranch(leaseKey, runId)
        this.#trimFinishedRuns()
      })
      this.#tasks.set(runId, task)
      leaseTransferred = true
      return { ...summary }
    } finally {
      if (!leaseTransferred) this.#releaseRunBranch(leaseKey, runId)
    }
  }

  get(runId: string): RunSummary | null {
    const run = this.#runs.get(runId)
    return run ? { ...run.summary } : null
  }

  async getPersisted(runId: string, projectDirRequest = '.'): Promise<RunSummary | null> {
    const { projectDir, store } = await this.#persistentRunStore(projectDirRequest)
    const active = this.#runs.get(runId)
    return active?.projectDir === projectDir ? { ...active.summary } : store.summary(runId)
  }

  async listRunHistory(
    projectDirRequest = '.',
    filter: { nodeId?: string; taskId?: string; canvasBranch?: string; limit?: number } = {},
  ): Promise<RunSummary[]> {
    const { store } = await this.#persistentRunStore(projectDirRequest)
    return store.list(filter)
  }

  async readRunLog(
    runId: string,
    projectDirRequest = '.',
    options: { afterEventId?: number; limit?: number } = {},
  ): Promise<RunLogPage | null> {
    const { store } = await this.#persistentRunStore(projectDirRequest)
    return store.page(runId, options)
  }

  async deleteRunLog(runId: string, projectDirRequest = '.'): Promise<boolean> {
    const { store } = await this.#persistentRunStore(projectDirRequest)
    return store.deleteLog(runId)
  }

  async lookupRunArtifact(
    runId: string,
    artifactId: string,
    projectDirRequest = '.',
  ): Promise<RunArtifactLookupV2 | null> {
    const { projectDir, store } = await this.#persistentRunStore(projectDirRequest)
    const summary = await store.summary(runId)
    if (!summary) return null
    return await this.#artifactStoreV2(
      projectDir,
      summary.canvasBranch ?? 'main',
    ).lookup(runId, artifactId) ?? null
  }

  async getPendingProjectionPlan(
    planId: string,
    projectDirRequest = '.',
    canvasBranchRequest = 'main',
  ): Promise<ProjectionSettlementV2 | null> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    const record = await this.#projectionPlansV2(projectDir, canvasBranch).get(planId)
    return record?.state === 'pending'
      ? { plan: record.plan, suggestedActions: record.suggestedActions }
      : null
  }

  subscribe(runId: string, listener: RunListener, afterId = 0): RunSubscription | null {
    const run = this.#runs.get(runId)
    if (!run) return null
    if (!run.closed && run.listeners.size >= MAX_SUBSCRIBERS_PER_RUN) {
      throw new ProtocolError('too many event subscribers for this run', 'subscriber_capacity_reached', 429)
    }
    const earliestId = run.messages[0]?.id ?? run.nextEventId
    const history = run.messages
      .filter((message) => message.id > afterId)
      .map((message) => ({ ...message }))
    if (!run.closed) run.listeners.add(listener)
    return {
      history,
      closed: run.closed,
      replayGap: afterId > 0 && afterId < earliestId - 1,
      unsubscribe: () => run.listeners.delete(listener),
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const run = this.#runs.get(runId)
    // Once the transport emitted a terminal event, cancellation would create an
    // impossible stream (done:end_turn followed by close:cancelled) during the
    // short artifact-watcher settle window.
    if (!run || run.closed) return false
    if (run.cancelPromise) return run.cancelPromise
    const cancellation = this.#cancelRun(run)
    run.cancelPromise = cancellation
    return cancellation
  }

  async #cancelRun(run: InternalRun): Promise<boolean> {
    if (run.doneEventSent && run.transportSettled) {
      await run.closedPromise
      return false
    }
    if (!run.doneEventSent) run.cancelRequested = true
    // Give transports such as acpx a chance to send protocol-native session
    // cancellation before the AbortSignal force-cleans any remaining process.
    let cancellationError: unknown
    try {
      await run.transport.cancel(run.summary.runId)
    } catch (error) {
      cancellationError = error
    }
    run.abortController.abort()
    await run.closedPromise
    if (cancellationError) throw cancellationError
    return true
  }

  /** Current phase-one transports resolve permissions non-interactively at spawn time. */
  resolvePermission(permissionId: string): { runId: string } | null {
    for (const run of this.#runs.values()) {
      if (run.pendingPermissionIds.has(permissionId) && !run.closed) {
        return { runId: run.summary.runId }
      }
    }
    return null
  }

  async listSessions(
    projectDirRequest = '.',
    filter: { canvasBranch?: string; nodeId?: string; agentId?: string } = {},
  ): Promise<SessionRecord[]> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    return this.#sessions(projectDir).list(filter)
  }

  async listTaskSessions(
    projectDirRequest = '.',
    filter: TaskSessionListFilterV2 = {},
  ): Promise<TaskSessionRecordV2[]> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    return this.#taskSessions(projectDir).list(filter)
  }

  /**
   * Atomically reserves every named branch for a lifecycle mutation. New runs
   * cannot enter while the operation is pending, and a run lease acquired
   * before this call makes the whole mutation fail without partial reservation.
   */
  async withIdleBranches<T>(
    projectDirRequest: string,
    branches: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertOpen()
    const projectDir = await this.#leaseProject(projectDirRequest)
    this.#assertOpen()
    const normalizedBranches = [...new Set(branches.map((branch) => parseCanvasBranch(branch)))]
      .sort((left, right) => left.localeCompare(right))
    if (normalizedBranches.length === 0) {
      throw new TypeError('at least one branch is required for a branch mutation lease')
    }
    const keys = normalizedBranches.map((branch) => branchLeaseKey(projectDir, branch))
    const busyIndex = keys.findIndex((key) =>
      this.#branchMutationLeases.has(key) || (this.#branchRunLeases.get(key)?.size ?? 0) > 0)
    if (busyIndex >= 0) {
      throw new ProtocolError(
        `canvas branch is busy: ${normalizedBranches[busyIndex]}`,
        'branch_busy',
        409,
      )
    }
    for (const key of keys) this.#branchMutationLeases.add(key)
    try {
      this.#assertOpen()
      return await operation()
    } finally {
      for (const key of keys) this.#branchMutationLeases.delete(key)
    }
  }

  async close(): Promise<void> {
    this.#closing = true
    const cancellations: Promise<boolean>[] = []
    for (const run of this.#runs.values()) {
      if (!run.closed) cancellations.push(this.cancel(run.summary.runId))
    }
    await Promise.allSettled(cancellations)
    await Promise.allSettled([...this.#pendingCreates.values()].map((pending) => pending.promise))
    await Promise.allSettled(this.#tasks.values())
    await Promise.allSettled([...this.#runLogStores.values()].map((store) => store.flush()))
  }

  async #execute(run: InternalRun): Promise<void> {
    let watcher: ArtifactWatcher | null = null
    let capturedSessionId: string | null = null
    let watcherError: Error | null = null
    const targetId = runTargetId(run.request)
    const canvasBranch = run.request.canvasBranch ?? 'main'
    const taskOwned = isResolvedTaskRunRequestV2(run.request)

    try {
      await assertManagedPaths(
        run.scope,
        targetId,
        run.summary.runId,
        canvasBranch,
        taskOwned,
      )
      await this.#revalidateSourceProjectDir(run)
      throwIfAborted(run.abortController.signal)
      const prepared = await prepareRunContext(
        run.request,
        run.projectDir,
        run.summary.runId,
        run.sourceProjectDir ?? run.projectDir,
      )
      throwIfAborted(run.abortController.signal)
      watcher = await this.#watchArtifacts({
        projectDir: run.projectDir,
        nodeId: targetId,
        canvasBranch,
        runId: run.summary.runId,
        ...(taskOwned ? {
          projectRelativeRoot: this.#artifactStoreV2(
            run.projectDir,
            canvasBranch,
          ).location(run.summary.runId).projectRelativeFilesRoot,
        } : {}),
        onEvent: (event) => this.#publishAgentEvent(run, event),
        onError: (error) => {
          watcherError = error
          this.#publishAgentEvent(run, {
            type: 'error',
            message: `Artifact watcher failed: ${error.message}`,
          })
        },
      })
      throwIfAborted(run.abortController.signal)

      let priorSessionId: string | null
      if (isResolvedTaskRunRequestV2(run.request)) {
        priorSessionId = (await this.#taskSessions(run.projectDir).get(
          canvasBranch,
          run.request.taskId,
          run.request.agentId,
        ))?.sessionId ?? null
      } else {
        priorSessionId = (await this.#sessions(run.projectDir).get(
          targetId,
          run.request.agentId,
          canvasBranch,
        ))?.sessionId ?? null
      }
      throwIfAborted(run.abortController.signal)
      const sessionId = priorSessionId ?? requestedRunSessionId(run.request)
      run.summary.status = 'running'
      // Recheck after directory creation and immediately before granting the CLI writable roots.
      await assertManagedPaths(
        run.scope,
        targetId,
        run.summary.runId,
        canvasBranch,
        taskOwned,
      )
      await this.#revalidateSourceProjectDir(run)
      throwIfAborted(run.abortController.signal)

      let result: Awaited<ReturnType<AgentProcessTransport['run']>>
      try {
        result = await run.transport.run({
          runId: run.summary.runId,
          nodeId: targetId,
          agentId: run.request.agentId,
          sessionId,
          prompt: prepared.agentPrompt,
          projectDir: run.projectDir,
          sourceProjectDir: run.sourceProjectDir ?? undefined,
          contextFile: prepared.contextFile,
          artifactDir: prepared.artifactDir,
          signal: run.abortController.signal,
          onEvent: (event) => this.#publishAgentEvent(run, event),
          onSessionId: (value) => {
            capturedSessionId = value
            run.summary.sessionId = value
            this.#publish(run, { event: 'session', data: { sessionId: value } })
          },
        })
      } finally {
        run.transportSettled = true
      }
      capturedSessionId = result.sessionId ?? capturedSessionId
      if (run.cancelRequested) throw cancelledRunError()
      throwIfAborted(run.abortController.signal)
      run.summary.sessionId = capturedSessionId
      if (capturedSessionId) {
        await this.#persistRunSession(run, capturedSessionId)
        throwIfAborted(run.abortController.signal)
        this.#publish(run, { event: 'session', data: { sessionId: capturedSessionId } })
      }

      await delay(WATCHER_SETTLE_MS, run.abortController.signal)
      throwIfAborted(run.abortController.signal)
      if (watcherError) throw watcherError
      const terminalReason = run.stopReason ?? 'end_turn'
      if (!run.doneEventSent) {
        this.#publishAgentEvent(run, { type: 'done', stopReason: terminalReason })
      }
      const status = statusForStopReason(terminalReason)
      await watcher?.close()
      watcher = null
      const artifacts = await this.#collectTerminalArtifacts(run, true)
      const outcome = status === 'done'
        ? taskOwned
          ? await readRunOutcomeV2(prepared.artifactDir)
          : await readRunOutcome(prepared.artifactDir)
        : undefined
      await this.#finish(
        run,
        status,
        artifacts.files,
        artifacts.complete,
        outcome,
        artifacts.manifest,
      )
    } catch (error) {
      await watcher?.close().catch(() => undefined)
      watcher = null
      if (capturedSessionId) {
        try {
          await this.#persistRunSession(run, capturedSessionId)
        } catch {
          // The primary run error remains the one surfaced to the UI.
        }
      }

      if (
        (run.doneEventSent && run.stopReason !== null)
        || run.cancelRequested
        || run.abortController.signal.aborted
        || isAbortError(error)
      ) {
        const terminalReason = run.cancelRequested ? 'cancelled' : run.stopReason ?? 'cancelled'
        if (!run.doneEventSent) {
          this.#publishAgentEvent(run, { type: 'done', stopReason: terminalReason })
        }
        const snapshot = await this.#collectTerminalArtifacts(run, false)
          .catch((): TerminalArtifactSnapshot => ({ files: [], complete: false }))
        await this.#finish(
          run,
          statusForStopReason(terminalReason),
          snapshot.files,
          snapshot.complete,
          undefined,
          snapshot.manifest,
        )
      } else {
        const message = error instanceof Error ? error.message : String(error)
        run.summary.error = message
        this.#publishAgentEvent(run, { type: 'error', message })
        if (!run.doneEventSent) this.#publishAgentEvent(run, { type: 'done', stopReason: 'error' })
        const snapshot = await this.#collectTerminalArtifacts(run, false)
          .catch((): TerminalArtifactSnapshot => ({ files: [], complete: false }))
        await this.#finish(run, 'error', snapshot.files, false, undefined, snapshot.manifest)
      }
    } finally {
      await watcher?.close().catch(() => undefined)
    }
  }

  #publishAgentEvent(run: InternalRun, original: CanvasAgentEvent): void {
    if (run.closed) return
    let event = original
    if (event.type === 'file-write') {
      const relative = this.#artifactRelativePath(run, event.path)
      if (!relative) return
      const now = Date.now()
      const prior = run.lastFileEvents.get(relative) ?? 0
      if (now - prior < 500) return
      run.lastFileEvents.set(relative, now)
      event = { type: 'file-write', path: relative, nodeId: runTargetId(run.request) }
    } else if (event.type === 'permission-request') {
      run.pendingPermissionIds.add(event.id)
      run.summary.status = 'awaiting-permission'
    } else if (event.type === 'done') {
      if (run.doneEventSent) return
      if (run.cancelRequested) event = { type: 'done', stopReason: 'cancelled' }
      run.doneEventSent = true
      run.stopReason = event.stopReason
    }
    this.#publish(run, { event: 'agent-event', data: event })
  }

  #artifactRelativePath(run: InternalRun, reportedPath: string): string | null {
    const absolute = path.isAbsolute(reportedPath)
      ? path.resolve(reportedPath)
      : path.resolve(run.projectDir, reportedPath)
    const relative = path.relative(run.projectDir, absolute).split(path.sep).join('/')
    const root = isResolvedTaskRunRequestV2(run.request)
      ? this.#artifactStoreV2(
          run.projectDir,
          run.request.canvasBranch,
        ).location(run.summary.runId).projectRelativeFilesRoot
      : artifactRunRelativeDir(
          run.request.canvasBranch ?? 'main',
          run.summary.runId,
          runTargetId(run.request),
        )
    const prefix = `${root}/`
    if (!relative.startsWith(prefix) || relative.includes('\0')) return null
    return isArtifactControlPath(relative.slice(prefix.length)) ? null : relative
  }

  #publish(run: InternalRun, message: RunStreamMessage): void {
    if (run.closed) return
    const buffered: BufferedStreamMessage = { ...message, id: run.nextEventId }
    run.nextEventId += 1
    run.messages.push(buffered)
    run.historyBytes += streamMessageSize(buffered)
    while (run.messages.length > EVENT_HISTORY_LIMIT || run.historyBytes > EVENT_HISTORY_BYTES) {
      const removed = run.messages.shift()
      if (!removed) break
      run.historyBytes -= streamMessageSize(removed)
    }
    void run.logStore.append(run.summary.runId, buffered).catch((error: unknown) => {
      run.logError ??= error
    })
    this.#broadcast(run, buffered)
  }

  #broadcast(run: InternalRun, buffered: BufferedStreamMessage): void {
    for (const listener of run.listeners) {
      try {
        listener(buffered)
      } catch {
        run.listeners.delete(listener)
      }
    }
  }

  async #finish(
    run: InternalRun,
    status: Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled'>,
    artifacts: string[],
    artifactsComplete: boolean,
    outcome?: RunOutcome | RunOutcomeV2,
    artifactManifest?: ArtifactManifestV1,
  ): Promise<void> {
    if (run.closed) return
    try {
      await run.logStore.flush(run.summary.runId)
    } catch (error) {
      run.logError ??= error
    }
    if (run.logError) {
      status = 'error'
      run.summary.error = `Could not persist the complete run log: ${errorMessage(run.logError)}`
    }
    run.summary.status = status
    run.summary.finishedAt = Date.now()
    let projectionPlan: ProjectionPlanV2 | undefined
    let suggestedActions: SuggestedAction[] | undefined
    if (isResolvedTaskRunRequestV2(run.request) && artifactManifest) {
      try {
        const created = await this.#projectionPlansV2(
          run.projectDir,
          run.request.canvasBranch,
        ).createPending({
          taskId: run.request.taskId,
          runId: run.summary.runId,
          runStatus: status,
          manifest: artifactManifest,
          plugins: BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2,
          ...(status === 'done' && outcome ? { outcome } : {}),
        })
        projectionPlan = created.plan
        suggestedActions = created.suggestedActions
      } catch (error) {
        status = 'error'
        run.summary.status = 'error'
        run.summary.error = `Could not persist the projection plan: ${errorMessage(error)}`
      }
    }
    const close: RunClosePayload = {
      runId: run.summary.runId,
      status,
      sessionId: run.summary.sessionId,
      artifacts,
      artifactsComplete,
      ...(artifactManifest ? { artifactManifest } : {}),
      ...(isResolvedTaskRunRequestV2(run.request)
        ? projectionPlan ? { projectionPlan, suggestedActions: suggestedActions ?? [] } : {}
        : status === 'done' && outcome ? { outcome: outcome as RunOutcome } : {}),
    }
    const buffered: BufferedStreamMessage = {
      event: 'close',
      data: close,
      id: run.nextEventId,
    }
    run.nextEventId += 1
    run.messages.push(buffered)
    run.historyBytes += streamMessageSize(buffered)
    try {
      await run.logStore.append(run.summary.runId, buffered)
      await run.logStore.finish(run.summary)
    } catch (error) {
      run.summary.status = 'error'
      run.summary.error = `Could not finalize the run log: ${errorMessage(error)}`
      close.status = 'error'
      delete close.outcome
      delete close.projectionPlan
      delete close.suggestedActions
    }
    this.#broadcast(run, buffered)
    run.closed = true
    run.listeners.clear()
    run.resolveClosed()
    if (this.#onRunFinished) {
      try {
        await this.#onRunFinished({
          summary: { ...run.summary },
          request: run.request,
          projectDir: run.projectDir,
        })
      } catch {
        // The run and its durable log are already complete. Versioning is
        // deliberately best-effort and reports degradation through its own API.
      }
    }
  }

  async #collectTerminalArtifacts(
    run: InternalRun,
    complete: boolean,
  ): Promise<TerminalArtifactSnapshot> {
    if (isResolvedTaskRunRequestV2(run.request)) {
      const closed = await this.#artifactStoreV2(
        run.projectDir,
        run.request.canvasBranch,
      ).closeRun(run.summary.runId, { complete })
      return {
        files: closed.manifest.entries.map((entry) => path.posix.join(
          closed.location.projectRelativeFilesRoot,
          entry.relativePath,
        )),
        complete: closed.manifest.complete,
        manifest: closed.manifest,
      }
    }
    return listArtifactSnapshot(run.projectDir, run.request.nodeId, {
      canvasBranch: run.request.canvasBranch ?? 'main',
      runId: run.summary.runId,
    })
  }

  async #persistRunSession(run: InternalRun, sessionId: string): Promise<void> {
    const canvasBranch = run.request.canvasBranch ?? 'main'
    if (isResolvedTaskRunRequestV2(run.request)) {
      await this.#taskSessions(run.projectDir).upsert({
        canvasBranch,
        taskId: run.request.taskId,
        agentId: run.request.agentId,
        sessionId,
      })
      return
    }
    await this.#sessions(run.projectDir).upsert({
      canvasBranch,
      nodeId: run.request.nodeId,
      agentId: run.request.agentId,
      sessionId,
    })
  }

  #sessions(projectDir: string): SessionStore {
    let store = this.#sessionStores.get(projectDir)
    if (!store) {
      store = new SessionStore(projectDir, {
        validatePath: () => assertSessionStorePath(projectDir),
      })
      this.#sessionStores.set(projectDir, store)
    }
    return store
  }

  #taskSessions(projectDir: string): TaskSessionStoreV2 {
    let store = this.#taskSessionStores.get(projectDir)
    if (!store) {
      const filePath = path.join(projectDir, '.gg', 'runtime', 'task-sessions-v2.json')
      store = new TaskSessionStoreV2(filePath, {
        validatePath: () => assertTaskSessionStoreV2Path(projectDir),
      })
      this.#taskSessionStores.set(projectDir, store)
    }
    return store
  }

  #artifactStoreV2(projectDir: string, canvasBranch: string): RunArtifactStoreV2 {
    const key = JSON.stringify([projectDir, canvasBranch])
    let store = this.#artifactStoresV2.get(key)
    if (!store) {
      store = new RunArtifactStoreV2(projectDir, canvasBranch)
      this.#artifactStoresV2.set(key, store)
    }
    return store
  }

  #projectionPlansV2(projectDir: string, canvasBranch: string): ProjectionPlanStoreV2 {
    const parsedBranch = parseCanvasBranch(canvasBranch)
    const key = JSON.stringify([projectDir, parsedBranch])
    let store = this.#projectionPlanStoresV2.get(key)
    if (!store) {
      const branchStorageId = canvasBranchStorageId(parsedBranch)
      const filePath = path.join(
        projectDir,
        '.gg',
        'runtime',
        'projection-plans',
        `${branchStorageId}.json`,
      )
      store = new ProjectionPlanStoreV2(filePath, {
        validatePath: () => assertProjectionPlanStoreV2Path(
          projectDir,
          branchStorageId,
          filePath,
        ),
      })
      this.#projectionPlanStoresV2.set(key, store)
    }
    return store
  }

  #runLogs(projectDir: string): RunLogStore {
    let store = this.#runLogStores.get(projectDir)
    if (!store) {
      store = new RunLogStore(projectDir)
      this.#runLogStores.set(projectDir, store)
      const recovery = store.markInterrupted().then(() => undefined)
      this.#runLogRecovery.set(projectDir, recovery)
    }
    return store
  }

  async #leaseProject(projectDirRequest: string): Promise<string> {
    const leased = this.#acquireProjectLease
      ? await this.#acquireProjectLease(projectDirRequest)
      : projectDirRequest
    return resolveProjectDir(this.#projectRoot, leased)
  }

  #reserveRunBranch(projectDir: string, canvasBranch: string, runId: string): string {
    const key = branchLeaseKey(projectDir, canvasBranch)
    if (this.#branchMutationLeases.has(key)) {
      throw new ProtocolError(
        `canvas branch is busy: ${canvasBranch}`,
        'branch_busy',
        409,
      )
    }
    let owners = this.#branchRunLeases.get(key)
    if (!owners) {
      owners = new Set()
      this.#branchRunLeases.set(key, owners)
    }
    owners.add(runId)
    return key
  }

  #releaseRunBranch(key: string, runId: string): void {
    const owners = this.#branchRunLeases.get(key)
    if (!owners) return
    owners.delete(runId)
    if (owners.size === 0) this.#branchRunLeases.delete(key)
  }

  async #revalidateSourceProjectDir(run: InternalRun): Promise<void> {
    if (!run.sourceProjectDir) return
    const candidate = await this.#resolveSourceProjectDir?.({
      projectDir: run.projectDir,
      canvasBranch: run.request.canvasBranch ?? 'main',
    })
    if (!candidate) {
      throw new ProtocolError(
        'managed source worktree is no longer bound',
        'source_worktree_unavailable',
        409,
      )
    }
    const current = await validateSourceExecutionDir(run.scope, candidate)
    if (current !== run.sourceProjectDir) {
      throw new ProtocolError(
        'managed source worktree binding changed before execution',
        'source_worktree_changed',
        409,
      )
    }
  }

  async #persistentRunStore(projectDirRequest: string): Promise<{
    projectDir: string
    store: RunLogStore
  }> {
    const leasedProjectDir = await this.#leaseProject(projectDirRequest)
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: leasedProjectDir,
    })
    await assertDaemonRunLogPath(scope)
    const store = this.#runLogs(scope.projectDir)
    await this.#runLogRecovery.get(scope.projectDir)
    return { projectDir: scope.projectDir, store }
  }

  #trimFinishedRuns(): void {
    const finished = [...this.#runs.values()]
      .filter((run) => run.closed)
      .sort((left, right) => (right.summary.finishedAt ?? 0) - (left.summary.finishedAt ?? 0))
    for (const run of finished.slice(FINISHED_RUN_LIMIT)) this.#runs.delete(run.summary.runId)
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }
}

async function assertDaemonRunLogPath(scope: ProjectScope): Promise<void> {
  const lexicalTarget = path.resolve(scope.projectDir, '.gg', 'runtime', 'runs')
  const canonicalGgDir = await canonicalizePotentialPath(scope.ggDir)
  const canonicalTarget = await canonicalizePotentialPath(lexicalTarget)
  if (
    canonicalGgDir !== scope.ggDir
    || !isPathWithin(scope.ggDir, lexicalTarget)
    || !isPathWithin(canonicalGgDir, canonicalTarget)
  ) {
    throw new ProtocolError(
      'unsafe managed path .gg/runtime/runs: path escapes the project .gg directory',
      'unsafe_managed_path',
      403,
    )
  }
}

function cancelledRunError(): Error {
  const error = new Error('Agent run was cancelled')
  error.name = 'AbortError'
  return error
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(): Error {
  const error = new Error('run cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

async function assertManagedPaths(
  scope: ProjectScope,
  targetId: string,
  runId: string,
  canvasBranch: string,
  taskOwned = false,
): Promise<void> {
  if (taskOwned) {
    await assertTaskSessionStoreV2Path(scope.projectDir)
    const branchStorageId = canvasBranchStorageId(parseCanvasBranch(canvasBranch))
    const projectionPlanPath = path.join(
      scope.projectDir,
      '.gg',
      'runtime',
      'projection-plans',
      `${branchStorageId}.json`,
    )
    await assertProjectionPlanStoreV2Path(
      scope.projectDir,
      branchStorageId,
      projectionPlanPath,
    )
  }
  const artifactRoot = taskOwned
    ? new RunArtifactStoreV2(scope.projectDir, canvasBranch)
        .location(runId).projectRelativeFilesRoot
    : artifactRunRelativeDir(canvasBranch, runId, targetId)
  const paths = [
    artifactRoot,
    `.gg/context/runs/${runId}`,
    '.gg/skills',
    ...(!taskOwned ? ['.gg/sessions.json'] : []),
    `.gg/runs/${runId}`,
  ]
  for (const managedPath of paths) {
    const decision = await assessWritePath(scope, managedPath)
    if (decision.disposition !== 'allow') {
      throw new ProtocolError(
        `unsafe managed path ${managedPath}: ${decision.reason}`,
        'unsafe_managed_path',
        403,
      )
    }
  }
}

async function validateSourceExecutionDir(
  scope: ProjectScope,
  candidate: string,
): Promise<string> {
  const sourceProjectDir = await resolveProjectDir(scope.projectRoot, candidate)
  const worktreesRoot = await canonicalizePotentialPath(
    path.join(scope.projectDir, '.gg', 'source-worktrees'),
  )
  const info = await pathInfo(sourceProjectDir)
  if (
    !info.directory
    || info.symbolicLink
    || sourceProjectDir === worktreesRoot
    || !isPathWithin(worktreesRoot, sourceProjectDir)
  ) {
    throw new ProtocolError(
      'source execution directory is not a managed source worktree',
      'unsafe_source_worktree',
      403,
    )
  }
  return sourceProjectDir
}

async function assertSessionStorePath(projectDir: string): Promise<void> {
  const expected = path.join(projectDir, '.gg', 'sessions.json')
  const canonicalProject = await canonicalizePotentialPath(projectDir)
  const canonical = await canonicalizePotentialPath(expected)
  if (canonicalProject !== projectDir || canonical !== expected) {
    throw new ProtocolError(
      'unsafe sessions path: path resolves through a symlink',
      'unsafe_managed_path',
      403,
    )
  }
  try {
    const info = await lstat(expected)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ProtocolError(
        'unsafe sessions path: expected a regular file',
        'unsafe_managed_path',
        403,
      )
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

async function assertTaskSessionStoreV2Path(projectDir: string): Promise<void> {
  const runtimeDir = path.join(projectDir, '.gg', 'runtime')
  const expected = path.join(runtimeDir, 'task-sessions-v2.json')
  const [canonicalProject, canonicalRuntime, canonicalExpected] = await Promise.all([
    canonicalizePotentialPath(projectDir),
    canonicalizePotentialPath(runtimeDir),
    canonicalizePotentialPath(expected),
  ])
  if (
    canonicalProject !== projectDir
    || canonicalRuntime !== runtimeDir
    || canonicalExpected !== expected
    || !isPathWithin(path.join(projectDir, '.gg'), expected)
  ) {
    throw new ProtocolError(
      'unsafe task sessions path: path resolves through a symlink',
      'unsafe_managed_path',
      403,
    )
  }
  try {
    const info = await lstat(expected)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ProtocolError(
        'unsafe task sessions path: expected a regular file',
        'unsafe_managed_path',
        403,
      )
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

async function assertProjectionPlanStoreV2Path(
  projectDir: string,
  branchStorageId: string,
  expected: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(branchStorageId)) {
    throw new ProtocolError(
      'unsafe projection plan path: branch storage id is invalid',
      'unsafe_managed_path',
      403,
    )
  }
  const runtimeDir = path.join(projectDir, '.gg', 'runtime')
  const plansDir = path.join(runtimeDir, 'projection-plans')
  const lexicalExpected = path.join(plansDir, `${branchStorageId}.json`)
  const [canonicalProject, canonicalRuntime, canonicalPlans, canonicalExpected] =
    await Promise.all([
      canonicalizePotentialPath(projectDir),
      canonicalizePotentialPath(runtimeDir),
      canonicalizePotentialPath(plansDir),
      canonicalizePotentialPath(expected),
    ])
  if (
    expected !== lexicalExpected
    || canonicalProject !== projectDir
    || canonicalRuntime !== runtimeDir
    || canonicalPlans !== plansDir
    || canonicalExpected !== expected
    || !isPathWithin(path.join(projectDir, '.gg'), expected)
  ) {
    throw new ProtocolError(
      'unsafe projection plan path: path resolves through a symlink',
      'unsafe_managed_path',
      403,
    )
  }
  try {
    const info = await lstat(expected)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ProtocolError(
        'unsafe projection plan path: expected a regular file',
        'unsafe_managed_path',
        403,
      )
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

async function pathInfo(candidate: string): Promise<{ directory: boolean; symbolicLink: boolean }> {
  const info = await lstat(candidate)
  return { directory: info.isDirectory(), symbolicLink: info.isSymbolicLink() }
}

function streamMessageSize(message: BufferedStreamMessage): number {
  return Buffer.byteLength(JSON.stringify(message.data), 'utf8') + 64
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function branchLeaseKey(projectDir: string, canvasBranch: string): string {
  return JSON.stringify([projectDir, canvasBranch])
}

function sameRunIdentity(
  run: InternalRun,
  request: RunExecutionRequest,
  projectDir: string,
  canvasBranch: string,
): boolean {
  return run.projectDir === projectDir
    && runTargetId(run.request) === runTargetId(request)
    && run.request.agentId === request.agentId
    && (run.request.canvasBranch ?? 'main') === canvasBranch
    && runRequestIdentity(run.request) === runRequestIdentity(request)
}

function samePendingRunIdentity(
  pending: PendingRunCreation,
  request: RunExecutionRequest,
  projectDir: string,
  canvasBranch: string,
): boolean {
  return pending.projectDir === projectDir
    && pending.canvasBranch === canvasBranch
    && pending.targetId === runTargetId(request)
    && pending.agentId === request.agentId
    && pending.requestIdentity === runRequestIdentity(request)
}

function runRequestIdentity(request: RunExecutionRequest): string {
  if (!isResolvedTaskRunRequestV2(request)) return 'canvas-v1'
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    baseRevision: request.baseRevision,
    prompt: request.prompt,
    attachments: request.attachments,
    materializationPolicy: request.materializationPolicy,
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return {
    promise,
    resolve: () => resolvePromise?.(),
  }
}

function statusForStopReason(
  reason: Extract<CanvasAgentEvent, { type: 'done' }>['stopReason'],
): Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled'> {
  return reason === 'error' ? 'error' : reason === 'cancelled' ? 'cancelled' : 'done'
}
