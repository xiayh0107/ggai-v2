import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { RunOutcome } from '../src/agent/outcome.js'
import type { SuggestedAction } from '../src/agent/suggestedActions.js'
import type { CanvasAgentEvent } from '../src/agent/types.js'
import type { ArtifactManifest } from './artifactManifest.js'
import { isArtifactControlPath } from './artifactPaths.js'
import { canvasBranchStorageId } from './canvasBranch.js'
import { readRunOutcome } from './outcome.js'
import { RunCapabilityReceiptStore } from './capabilityReceipt.js'
import {
  CapabilityExecutionScopes,
  type RunCapabilityScope,
} from './capabilityScopes.js'
import { prepareRunContext } from './packer.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  ProjectionPluginCapabilityStore,
  inspectProjectionPluginCapabilitySnapshot,
  projectionPluginContracts,
  type ProjectionPluginCapabilitySnapshot,
} from './pluginCapabilities.js'
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
  RunReproducibilitySnapshot,
  RunStreamMessage,
  RunSummary,
} from './protocol.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'
import { AgentRegistry } from './registry.js'
import {
  RunLogExistsError,
  RunLogStore,
  type RunHistoryFilter,
  type RunLogPage,
} from './runLogs.js'
import { recoverInterruptedTaskRuns } from './runRecovery.js'
import {
  RunArtifactStore,
  type RunArtifactLookup,
} from './runArtifactStorage.js'
import {
  TaskSessionStore,
  type TaskSessionListFilter,
  type TaskSessionRecord,
} from './taskSessions.js'
import {
  isNodeStudioRunRequest,
  isResolvedTaskRunRequest,
  pinResolvedTaskSkills,
  resolvedTaskAttachmentCapabilityDigest,
  requestedRunSessionId,
  runTargetId,
  type RunExecutionRequest,
} from './taskRunTypes.js'
import { parseTaskId } from './taskRunProtocol.js'
import type { AgentProcessTransport } from './transport/types.js'
import { ServiceScope } from './runtime/services.js'
import type { CapabilityProfileSnapshot } from './runtime/composition.js'
import { watchArtifacts, type ArtifactWatcher } from './watcher.js'
import type { ProjectionPlan, ProjectionSettlement } from './projectionPlan.js'
import type { NodeTypeSnapshot } from '../src/plugins/nodeTypeContracts.js'
import {
  ProjectionPlanStore,
  type ProjectionPlanLifecycle,
} from './projectionPlanStore.js'

const EVENT_HISTORY_LIMIT = 2_000
const EVENT_HISTORY_BYTES = 1024 * 1024
const FINISHED_RUN_LIMIT = 50
const MAX_ACTIVE_RUNS = 4
const MAX_SUBSCRIBERS_PER_RUN = 8
const WATCHER_SETTLE_MS = 350
const FALLBACK_CAPABILITY_PROFILE: CapabilityProfileSnapshot = Object.freeze({
  schemaVersion: 1,
  id: '@ggai/fallback-agent-runtime',
  version: '1.0.0',
  bundles: Object.freeze([]),
})

const PROJECTION_CAPABILITY_RECEIPT_KEY = 'ggai.projection-capabilities.v3'
const SKILL_CAPABILITY_RECEIPT_KEY = 'ggai.skill-capabilities.v1'
const SKILL_RESOLVER_CAPABILITY_RECEIPT_KEY = 'ggai.skill-resolver.v1'
const ATTACHMENT_CAPABILITY_RECEIPT_KEY = 'ggai.run-attachments.v1'

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
  capabilityScope: RunCapabilityScope | null
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
  /**
   * Runs only after a Task Run close and summary are durable. Failures leave
   * the trusted plan pending for explicit recovery and never change Run status.
   */
  onProjectionPlanReady?: (event: ProjectionPlanReadyEvent) => Promise<void>
  /** Resolves an explicitly managed source worktree for a logical canvas branch. */
  resolveSourceProjectDir?: (input: {
    projectDir: string
    canvasBranch: string
    taskOwned: boolean
    studioOwned: boolean
  }) => Promise<string | null>
  /** Test seam for deterministic artifact settlement without OS watcher limits. */
  watchArtifacts?: typeof watchArtifacts
  /** Application-owned scope tree; omitted callers receive an isolated fallback tree. */
  capabilityScopes?: CapabilityExecutionScopes
  /** Snapshots the active profile at the acceptance boundary. */
  capabilityProfile?: () => CapabilityProfileSnapshot
  /** Resolves daemon-owned immutable Node type snapshots for GraphProposal validation. */
  resolveNodeTypes?: (projectDir: string) => Promise<NodeTypeSnapshot[]>
  resolveGraphResourceHandles?: (projectDir: string) => Promise<string[]>
}

export type TaskRunReproducibilityReadModel = {
  runId: string
  reproducible: boolean
  generationService: string
  skills: { count: number }
  attachments: { count: number }
  capabilityProfile: { label: string }
}

export interface RunFinishedEvent {
  summary: RunSummary
  request: RunExecutionRequest
  projectDir: string
}

export interface ProjectionPlanReadyEvent {
  plan: ProjectionPlan
  projectDir: string
  canvasBranch: string
}

export interface RunProjectionPlanRecord extends ProjectionSettlement {
  state: ProjectionPlanLifecycle
}

export interface RunCreationOptions {
  /**
   * Revalidates request-scoped durable state after the Task Run lease is held.
   * This closes the gap between an HTTP handler reading a Canvas revision and
   * the Run becoming visible to destructive Task mutations.
   */
  validateReserved?: () => Promise<void>
}

export type TaskRunPreflightAvailability = 'ready' | 'busy' | 'capacity'

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
  manifest?: ArtifactManifest
}

interface RunReservation {
  branchKey: string
  taskKey?: string
}

export class RunManager {
  readonly #projectRoot: string
  readonly #registry: AgentRegistry
  readonly #acquireProjectLease?: RunManagerOptions['acquireProjectLease']
  readonly #onRunFinished?: (event: RunFinishedEvent) => Promise<void>
  readonly #onProjectionPlanReady?: (event: ProjectionPlanReadyEvent) => Promise<void>
  readonly #resolveSourceProjectDir?: RunManagerOptions['resolveSourceProjectDir']
  readonly #watchArtifacts: typeof watchArtifacts
  readonly #capabilityScopes: CapabilityExecutionScopes
  readonly #ownsCapabilityScopes: boolean
  readonly #capabilityProfile: () => CapabilityProfileSnapshot
  readonly #resolveNodeTypes?: RunManagerOptions['resolveNodeTypes']
  readonly #resolveGraphResourceHandles?: RunManagerOptions['resolveGraphResourceHandles']
  readonly #runs = new Map<string, InternalRun>()
  readonly #tasks = new Map<string, Promise<void>>()
  readonly #taskSessionStores = new Map<string, TaskSessionStore>()
  readonly #artifactStores = new Map<string, RunArtifactStore>()
  readonly #projectionPlanStores = new Map<string, ProjectionPlanStore>()
  readonly #pluginCapabilityStores = new Map<string, ProjectionPluginCapabilityStore>()
  readonly #runLogStores = new Map<string, RunLogStore>()
  readonly #runLogRecovery = new Map<string, Promise<void>>()
  readonly #capabilityReceiptStores = new Map<string, RunCapabilityReceiptStore>()
  readonly #pendingCreates = new Map<string, PendingRunCreation>()
  readonly #branchRunLeases = new Map<string, Set<string>>()
  readonly #branchMutationLeases = new Set<string>()
  readonly #taskRunLeases = new Map<string, Set<string>>()
  readonly #taskMutationLeases = new Set<string>()
  readonly #projectDeletionReservations = new Set<string>()
  readonly #projectRunPreparations = new Map<string, number>()
  #closing = false

  constructor(options: RunManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#registry = options.registry ?? new AgentRegistry()
    this.#acquireProjectLease = options.acquireProjectLease
    this.#onRunFinished = options.onRunFinished
    this.#onProjectionPlanReady = options.onProjectionPlanReady
    this.#resolveSourceProjectDir = options.resolveSourceProjectDir
    this.#watchArtifacts = options.watchArtifacts ?? watchArtifacts
    this.#ownsCapabilityScopes = options.capabilityScopes === undefined
    this.#capabilityScopes = options.capabilityScopes ?? new CapabilityExecutionScopes(
      this.#registry.runtimeServices ?? new ServiceScope({ label: 'run-manager-fallback' }),
    )
    this.#capabilityProfile = options.capabilityProfile
      ?? (() => this.#registry.runtimeDiagnostics?.().profile ?? FALLBACK_CAPABILITY_PROFILE)
    this.#resolveNodeTypes = options.resolveNodeTypes
    this.#resolveGraphResourceHandles = options.resolveGraphResourceHandles
  }

  async create(
    request: RunExecutionRequest,
    options: RunCreationOptions = {},
  ): Promise<RunSummary> {
    this.#assertOpen()
    // Pin the revision payload before any asynchronous lease/path work so a
    // caller cannot mutate the context while the run is being accepted.
    if (isResolvedTaskRunRequest(request)) {
      const pluginCapabilities = pinProjectionPluginCapabilities(request.pluginCapabilities)
      const resolvedSkills = pinResolvedTaskSkills(
        request.resolvedSkills,
        request.skillCapabilityDigest,
      )
      if (!/^[0-9a-f]{64}$/u.test(request.skillResolverCapabilityDigest)) {
        throw new TypeError('Task Run Skill Resolver digest is invalid')
      }
      if (!request.skillResolverProvider || request.skillResolverProvider.length > 240) {
        throw new TypeError('Task Run Skill Resolver provider is invalid')
      }
      request = structuredClone({ ...request, pluginCapabilities, resolvedSkills })
    }
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
    this.#beginRunPreparation(projectDir)
    try {
      if (isResolvedTaskRunRequest(request)) {
        request = {
          ...request,
          pluginCapabilities: await this.#pluginCapabilities(projectDir).pin(
            requirePinnedPluginCapabilities(request),
          ),
        }
      }
    } finally {
      this.#endRunPreparation(projectDir)
    }
    const canvasBranch = request.canvasBranch
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

    const runReservation = this.#reserveRun(request, projectDir, canvasBranch, runId)
    const creation = this.#createReserved({
      request,
      transport,
      scope,
      projectDir,
      canvasBranch,
      runId,
      reservation: runReservation,
      validateReserved: options.validateReserved,
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
    reservation: RunReservation
    validateReserved?: () => Promise<void>
  }): Promise<RunSummary> {
    const {
      request,
      transport,
      scope,
      projectDir,
      canvasBranch,
      runId,
      reservation,
      validateReserved,
    } = input
    let leaseTransferred = false
    let unownedCapabilityScope: RunCapabilityScope | null = null
    try {
      await validateReserved?.()
      this.#assertOpen()
      const sourceCandidate = this.#resolveSourceProjectDir
        ? await this.#resolveSourceProjectDir({
            projectDir,
            canvasBranch,
            taskOwned: isResolvedTaskRunRequest(request),
            studioOwned: isNodeStudioRunRequest(request),
          })
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
        && (run.request.canvasBranch) === canvasBranch)) {
        const targetKind = isResolvedTaskRunRequest(request) ? 'task' : 'node'
        throw new ProtocolError(
          `this ${targetKind} already has an active run`,
          `${targetKind}_run_active`,
          409,
        )
      }
      const targetId = runTargetId(request)
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
        isResolvedTaskRunRequest(request),
        isResolvedTaskRunRequest(request) || isNodeStudioRunRequest(request),
      )

      let capabilityReceiptDigest: string | undefined
      let reproducibilitySnapshot: RunReproducibilitySnapshot | undefined
      if (isResolvedTaskRunRequest(request)) {
        unownedCapabilityScope = this.#capabilityScopes
          .workspace(this.#projectRoot)
          .run(runId)
        const receipt = unownedCapabilityScope.acceptCapabilities(
          this.#capabilityProfile(),
          semanticCapabilitiesForTaskRun(request),
        )
        const pinnedReceipt = await this.#capabilityReceipts(projectDir).pin(receipt)
        capabilityReceiptDigest = pinnedReceipt.digest
        reproducibilitySnapshot = {
          generationService: descriptor.label,
          skillCount: request.resolvedSkills.length,
          attachmentCount: request.attachments.length,
          capabilityProfileLabel: capabilityProfileLabel(pinnedReceipt.profile.id),
        }
      }
      const summary: RunSummary = {
        runId,
        ...(isResolvedTaskRunRequest(request) ? {
          taskId: request.taskId,
          baseRevision: request.baseRevision,
          prompt: request.prompt,
        } : {}),
        nodeId: targetId,
        agentId: request.agentId,
        canvasBranch,
        ...(isResolvedTaskRunRequest(request)
          ? {
              pluginCapabilityDigest: requirePinnedPluginCapabilities(request).digest,
              skillCapabilityDigest: request.skillCapabilityDigest,
              capabilityReceiptDigest,
              reproducibilitySnapshot,
            }
          : {}),
        ...(isNodeStudioRunRequest(request) ? {
          runKind: 'node-studio' as const,
          baseDefinitionId: request.baseDefinitionId,
          baseDefinitionRevision: request.baseDefinitionRevision,
        } : {}),
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
        capabilityScope: unownedCapabilityScope,
      }
      unownedCapabilityScope = null
      this.#runs.set(runId, run)
      try {
        await logStore.start(summary)
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
          await run.capabilityScope?.dispose().catch(() => undefined)
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
        this.#releaseRunReservation(reservation, runId)
        this.#trimFinishedRuns()
      })
      this.#tasks.set(runId, task)
      leaseTransferred = true
      return { ...summary }
    } finally {
      await unownedCapabilityScope?.dispose().catch(() => undefined)
      if (!leaseTransferred) this.#releaseRunReservation(reservation, runId)
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

  async getTaskRunReproducibility(
    runId: string,
    projectDirRequest = '.',
  ): Promise<TaskRunReproducibilityReadModel | null> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    const summary = await this.getPersisted(runId, projectDir)
    if (!summary?.taskId) return null
    const snapshot = summary.reproducibilitySnapshot ?? {
      generationService: '未知生成服务',
      skillCount: 0,
      attachmentCount: 0,
      capabilityProfileLabel: '历史生成环境',
    }
    let reproducible = false
    if (summary.capabilityReceiptDigest && summary.reproducibilitySnapshot) {
      try {
        const receipt = await this.#capabilityReceipts(projectDir).get(runId)
        reproducible = receipt?.digest === summary.capabilityReceiptDigest
      } catch {
        reproducible = false
      }
    }
    return {
      runId,
      reproducible,
      generationService: snapshot.generationService,
      skills: { count: snapshot.skillCount },
      attachments: { count: snapshot.attachmentCount },
      capabilityProfile: { label: snapshot.capabilityProfileLabel },
    }
  }

  async listRunHistory(
    projectDirRequest = '.',
    filter: RunHistoryFilter = {},
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

  async readTerminalClose(
    runId: string,
    projectDirRequest = '.',
  ): Promise<RunClosePayload | null> {
    const { store } = await this.#persistentRunStore(projectDirRequest)
    return store.terminalClose(runId)
  }

  async deleteRunLog(runId: string, projectDirRequest = '.'): Promise<boolean> {
    const { store } = await this.#persistentRunStore(projectDirRequest)
    return store.deleteLog(runId)
  }

  async lookupRunArtifact(
    runId: string,
    artifactId: string,
    projectDirRequest = '.',
  ): Promise<RunArtifactLookup | null> {
    const { projectDir, store } = await this.#persistentRunStore(projectDirRequest)
    const summary = await store.summary(runId)
    if (!summary) return null
    return await this.#artifactStore(
      projectDir,
      summary.canvasBranch,
    ).lookup(runId, artifactId) ?? null
  }

  async getPendingProjectionPlan(
    planId: string,
    projectDirRequest = '.',
    canvasBranchRequest = 'main',
  ): Promise<ProjectionSettlement | null> {
    const record = await this.getProjectionPlanRecord(
      planId,
      projectDirRequest,
      canvasBranchRequest,
    )
    return record?.state === 'pending'
      ? { plan: record.plan, suggestedActions: record.suggestedActions }
      : null
  }

  async getProjectionPlanRecord(
    planId: string,
    projectDirRequest = '.',
    canvasBranchRequest = 'main',
  ): Promise<RunProjectionPlanRecord | null> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    const record = await this.#projectionPlans(projectDir, canvasBranch).get(planId)
    if (!record) return null

    // The registry is an indexed lifecycle view. Browser plan commands still
    // resolve their trusted semantic content from the append-only Run close.
    const logs = this.#runLogs(projectDir)
    await this.#runLogRecovery.get(projectDir)
    const [summary, close] = await Promise.all([
      logs.summary(record.plan.runId),
      logs.terminalClose(record.plan.runId),
    ])
    const closeActions = close?.suggestedActions ?? []
    if (!summary
      || summary.taskId !== record.plan.taskId
      || (summary.canvasBranch) !== canvasBranch
      || !close?.projectionPlan
      || close.projectionPlan.planId !== planId
      || close.projectionPlan.digest !== record.plan.digest
      || JSON.stringify(close.projectionPlan) !== JSON.stringify(record.plan)
      || JSON.stringify(closeActions) !== JSON.stringify(record.suggestedActions)) {
      throw new ProtocolError(
        'projection plan registry does not match its durable Run close',
        'projection_plan_log_mismatch',
        409,
      )
    }
    return {
      state: record.state,
      plan: close.projectionPlan,
      suggestedActions: closeActions,
    }
  }

  async dismissProjectionPlan(
    planId: string,
    projectDirRequest = '.',
    canvasBranchRequest = 'main',
  ): Promise<boolean> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    const store = this.#projectionPlans(projectDir, canvasBranch)
    if (!await store.get(planId)) return false
    await store.dismiss(planId)
    return true
  }

  /**
   * Reconciles the branch-scoped plan registry against the durable Canvas Task
   * set. Missing Tasks are authoritative deletions; their pending plans are
   * closed idempotently while the append-only Run close remains untouched.
   */
  async reconcileProjectionPlansForCanvasTasks(
    projectDirRequest: string,
    canvasBranchRequest: string,
    liveTaskIds: readonly string[],
  ): Promise<string[]> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    const parsedTaskIds = new Set(liveTaskIds.map((taskId) => parseTaskId(taskId)))
    this.#runLogs(projectDir)
    await this.#runLogRecovery.get(projectDir)
    const result = await this.#projectionPlans(
      projectDir,
      canvasBranch,
    ).dismissPendingForMissingTasks(parsedTaskIds)
    return result.dismissedPlanIds
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

  async listTaskSessions(
    projectDirRequest = '.',
    filter: TaskSessionListFilter = {},
  ): Promise<TaskSessionRecord[]> {
    const projectDir = await this.#leaseProject(projectDirRequest)
    return this.#taskSessions(projectDir).list(filter)
  }

  /**
   * Read-only availability hint for UI preflight. It never reserves a branch,
   * Task, Run id, or capacity slot; create() repeats the checks atomically.
   */
  async inspectTaskRunAvailability(
    projectDirRequest: string,
    canvasBranchRequest: string,
    taskIdRequest: string,
  ): Promise<TaskRunPreflightAvailability> {
    this.#assertOpen()
    const projectDir = await this.#leaseProject(projectDirRequest)
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    const taskId = parseTaskId(taskIdRequest)
    const branchKey = branchLeaseKey(projectDir, canvasBranch)
    const taskKey = taskLeaseKey(projectDir, canvasBranch, taskId)
    if (this.#branchMutationLeases.has(branchKey)
      || this.#taskMutationLeases.has(taskKey)
      || (this.#taskRunLeases.get(taskKey)?.size ?? 0) > 0) {
      return 'busy'
    }
    const activeRuns = [...this.#runs.values()].filter((run) => !run.closed).length
      + this.#pendingCreates.size
    return activeRuns >= MAX_ACTIVE_RUNS ? 'capacity' : 'ready'
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
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
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

  /**
   * Atomically reserves the named Tasks for a destructive Canvas mutation.
   * A pending or active Run owns the same key from the moment its creation is
   * reserved until all terminal settlement hooks finish, so neither side can
   * pass a check and then race the other.
   */
  async withIdleTasks<T>(
    projectDirRequest: string,
    canvasBranchRequest: string,
    taskIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertOpen()
    const projectDir = await this.#leaseProject(projectDirRequest)
    this.#assertOpen()
    const canvasBranch = parseCanvasBranch(canvasBranchRequest)
    // Rebuild interrupted durable Run closes before deciding that a Task is
    // idle. A restart must not create a window where deletion outruns recovery.
    this.#runLogs(projectDir)
    await this.#runLogRecovery.get(projectDir)
    this.#assertOpen()
    const normalizedTaskIds = [...new Set(taskIds.map((taskId) => parseTaskId(taskId)))]
      .sort((left, right) => left.localeCompare(right))
    if (normalizedTaskIds.length === 0) {
      throw new TypeError('at least one Task is required for a Task mutation lease')
    }
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    const keys = normalizedTaskIds.map((taskId) =>
      taskLeaseKey(projectDir, canvasBranch, taskId))
    const busyIndex = keys.findIndex((key) =>
      this.#taskMutationLeases.has(key) || (this.#taskRunLeases.get(key)?.size ?? 0) > 0)
    if (busyIndex >= 0) {
      const taskId = normalizedTaskIds[busyIndex]!
      if ((this.#taskRunLeases.get(keys[busyIndex]!)?.size ?? 0) > 0) {
        throw new ProtocolError(
          `task has an active or pending run: ${taskId}`,
          'task_run_active',
          409,
        )
      }
      throw new ProtocolError(`task is busy: ${taskId}`, 'task_busy', 409)
    }
    for (const key of keys) this.#taskMutationLeases.add(key)
    try {
      this.#assertOpen()
      return await operation()
    } finally {
      for (const key of keys) this.#taskMutationLeases.delete(key)
    }
  }

  /**
   * Reserves a whole project against new Runs while permanent deletion drains
   * the remaining daemon-owned stores. Existing or pending Runs fail closed.
   */
  async beginProjectDeletion(projectDirRequest: string): Promise<string> {
    this.#assertOpen()
    const projectDir = await this.#leaseProject(projectDirRequest)
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is busy', 'project_busy', 409)
    }
    this.#projectDeletionReservations.add(projectDir)
    try {
      this.#runLogs(projectDir)
      await this.#runLogRecovery.get(projectDir)
      const runBusy = [...this.#runs.values()].some((run) =>
        run.projectDir === projectDir && !run.closed)
        || (this.#projectRunPreparations.get(projectDir) ?? 0) > 0
        || [...this.#pendingCreates.values()].some((pending) =>
          pending.projectDir === projectDir)
        || [...this.#branchRunLeases.entries()].some(([key, owners]) =>
          projectScopedLeaseKey(key, projectDir) && owners.size > 0)
        || [...this.#branchMutationLeases].some((key) =>
          projectScopedLeaseKey(key, projectDir))
        || [...this.#taskMutationLeases].some((key) =>
          projectScopedLeaseKey(key, projectDir))
      if (runBusy) {
        throw new ProtocolError(
          'workspace project has an active or pending operation',
          'project_busy',
          409,
        )
      }
      await this.#runLogStores.get(projectDir)?.flush()
      return projectDir
    } catch (error) {
      this.#projectDeletionReservations.delete(projectDir)
      throw error
    }
  }

  evictProject(projectDir: string): void {
    const runIds = [...this.#runs.values()]
      .filter((run) => run.projectDir === projectDir)
      .map((run) => run.summary.runId)
    for (const runId of runIds) {
      this.#runs.delete(runId)
      this.#tasks.delete(runId)
    }
    this.#taskSessionStores.delete(projectDir)
    this.#runLogStores.delete(projectDir)
    this.#runLogRecovery.delete(projectDir)
    this.#pluginCapabilityStores.delete(projectDir)
    this.#capabilityReceiptStores.delete(projectDir)
    for (const key of this.#artifactStores.keys()) {
      if (projectScopedLeaseKey(key, projectDir)) this.#artifactStores.delete(key)
    }
    for (const key of this.#projectionPlanStores.keys()) {
      if (projectScopedLeaseKey(key, projectDir)) this.#projectionPlanStores.delete(key)
    }
  }

  endProjectDeletion(projectDir: string): void {
    this.#projectDeletionReservations.delete(projectDir)
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
    if (this.#ownsCapabilityScopes) await this.#capabilityScopes.dispose()
  }

  async #execute(run: InternalRun): Promise<void> {
    let watcher: ArtifactWatcher | null = null
    let capturedSessionId: string | null = null
    let watcherError: Error | null = null
    const targetId = runTargetId(run.request)
    const canvasBranch = run.request.canvasBranch
    const taskOwned = isResolvedTaskRunRequest(run.request)
    const manifestOwned = taskOwned || isNodeStudioRunRequest(run.request)

    try {
      await assertManagedPaths(
        run.scope,
        targetId,
        run.summary.runId,
        canvasBranch,
        taskOwned,
        manifestOwned,
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
        projectRelativeRoot: this.#artifactStore(
          run.projectDir,
          canvasBranch,
        ).location(run.summary.runId).projectRelativeFilesRoot,
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
      if (isNodeStudioRunRequest(run.request)) {
        // The current manifest is the complete Studio context. Package ids are
        // reusable draft labels, so resuming their prior Agent session would
        // leak an unrelated draft's conversation into this run.
        priorSessionId = null
      } else {
        priorSessionId = (await this.#taskSessions(run.projectDir).get(
          canvasBranch,
          run.request.taskId,
          run.request.agentId,
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
        manifestOwned,
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
      const outcome = status === 'done' && taskOwned
        ? await readRunOutcome(prepared.artifactDir)
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
      if (run.transport.supportsInteractivePermissions !== true) {
        const message = [
          `Agent requested permission for ${event.action},`,
          `but the ${run.transport.kind} transport is non-interactive.`,
          'The request was not exposed as an actionable prompt.',
        ].join(' ')
        run.summary.error = message
        event = { type: 'error', message }
      } else {
        run.pendingPermissionIds.add(event.id)
        run.summary.status = 'awaiting-permission'
      }
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
    const root = this.#artifactStore(
      run.projectDir,
      run.request.canvasBranch,
    ).location(run.summary.runId).projectRelativeFilesRoot
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
    outcome?: RunOutcome,
    artifactManifest?: ArtifactManifest,
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
    let projectionPlan: ProjectionPlan | undefined
    let suggestedActions: SuggestedAction[] | undefined
    if (isResolvedTaskRunRequest(run.request) && artifactManifest) {
      try {
        const taskRequest = run.request
        const task = taskRequest.canvasDocument.tasks.find((candidate) =>
          candidate.id === taskRequest.taskId)
        const allowedRootIds = new Set(taskRequest.canvasDocument.nodes.flatMap((node) => {
          const rootId = node.payload?.rootId
          return typeof rootId === 'string' ? [rootId] : []
        }))
        for (const rootId of await this.#resolveGraphResourceHandles?.(run.projectDir) ?? []) {
          allowedRootIds.add(rootId)
        }
        const created = await this.#projectionPlans(
          run.projectDir,
          run.request.canvasBranch,
        ).createPending({
          taskId: run.request.taskId,
          runId: run.summary.runId,
          runStatus: status,
          manifest: artifactManifest,
          plugins: projectionPluginContracts(requirePinnedPluginCapabilities(run.request)),
          ...(this.#resolveNodeTypes && task ? {
            nodeTypes: await this.#resolveNodeTypes(run.projectDir),
            taskAnchor: task.anchor,
            allowedRootIds,
          } : {}),
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
      ...(isResolvedTaskRunRequest(run.request) && projectionPlan
        ? { projectionPlan, suggestedActions: suggestedActions ?? [] }
        : {}),
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
      delete close.projectionPlan
      delete close.suggestedActions
    }
    if (close.projectionPlan && this.#onProjectionPlanReady) {
      try {
        await this.#onProjectionPlanReady({
          plan: close.projectionPlan,
          projectDir: run.projectDir,
          canvasBranch: run.request.canvasBranch,
        })
        if (close.projectionPlan.taskProposals.length === 0) {
          await this.#projectionPlans(
            run.projectDir,
            run.request.canvasBranch,
          ).dismiss(close.projectionPlan.planId)
        }
      } catch {
        // The durable pending plan is the recovery source of truth. Canvas
        // materialization can be replayed later without changing Run status.
      }
    }
    this.#broadcast(run, buffered)
    run.closed = true
    run.listeners.clear()
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
    await run.capabilityScope?.dispose().catch(() => undefined)
    run.resolveClosed()
  }

  async #collectTerminalArtifacts(
    run: InternalRun,
    complete: boolean,
  ): Promise<TerminalArtifactSnapshot> {
    const closed = await this.#artifactStore(
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

  async #persistRunSession(run: InternalRun, sessionId: string): Promise<void> {
    const canvasBranch = run.request.canvasBranch
    if (isNodeStudioRunRequest(run.request)) return
    await this.#taskSessions(run.projectDir).upsert({
      canvasBranch,
      taskId: run.request.taskId,
      agentId: run.request.agentId,
      sessionId,
    })
  }

  #taskSessions(projectDir: string): TaskSessionStore {
    let store = this.#taskSessionStores.get(projectDir)
    if (!store) {
      const filePath = path.join(projectDir, '.gg', 'runtime', 'task-sessions.json')
      store = new TaskSessionStore(filePath, {
        validatePath: () => assertTaskSessionStorePath(projectDir),
      })
      this.#taskSessionStores.set(projectDir, store)
    }
    return store
  }

  #artifactStore(projectDir: string, canvasBranch: string): RunArtifactStore {
    const key = JSON.stringify([projectDir, canvasBranch])
    let store = this.#artifactStores.get(key)
    if (!store) {
      store = new RunArtifactStore(projectDir, canvasBranch)
      this.#artifactStores.set(key, store)
    }
    return store
  }

  #projectionPlans(projectDir: string, canvasBranch: string): ProjectionPlanStore {
    const parsedBranch = parseCanvasBranch(canvasBranch)
    const key = JSON.stringify([projectDir, parsedBranch])
    let store = this.#projectionPlanStores.get(key)
    if (!store) {
      const branchStorageId = canvasBranchStorageId(parsedBranch)
      const filePath = path.join(
        projectDir,
        '.gg',
        'runtime',
        'projection-plans',
        `${branchStorageId}.json`,
      )
      store = new ProjectionPlanStore(filePath, {
        validatePath: () => assertProjectionPlanStorePath(
          projectDir,
          branchStorageId,
          filePath,
        ),
      })
      this.#projectionPlanStores.set(key, store)
    }
    return store
  }

  #runLogs(projectDir: string): RunLogStore {
    let store = this.#runLogStores.get(projectDir)
    if (!store) {
      store = new RunLogStore(projectDir)
      this.#runLogStores.set(projectDir, store)
      const recovery = recoverInterruptedTaskRuns({
        projectDir,
        runLogs: store,
        artifactStore: (canvasBranch) => this.#artifactStore(projectDir, canvasBranch),
        projectionPlanStore: (canvasBranch) => this.#projectionPlans(
          projectDir,
          canvasBranch,
        ),
        pluginCapabilities: (digest) => this.#pluginCapabilities(projectDir).recover(digest),
        capabilityReceipt: async (runId, expectedDigest) => {
          if (!expectedDigest) return
          const receipt = await this.#capabilityReceipts(projectDir).get(runId)
          if (!receipt || receipt.digest !== expectedDigest) {
            throw new Error('Run capability receipt is missing or does not match its summary')
          }
        },
        ...(this.#onProjectionPlanReady
          ? { onProjectionPlanReady: this.#onProjectionPlanReady }
          : {}),
      }).then(() => undefined)
      this.#runLogRecovery.set(projectDir, recovery)
    }
    return store
  }

  #pluginCapabilities(projectDir: string): ProjectionPluginCapabilityStore {
    let store = this.#pluginCapabilityStores.get(projectDir)
    if (!store) {
      store = new ProjectionPluginCapabilityStore(projectDir)
      this.#pluginCapabilityStores.set(projectDir, store)
    }
    return store
  }

  #capabilityReceipts(projectDir: string): RunCapabilityReceiptStore {
    let store = this.#capabilityReceiptStores.get(projectDir)
    if (!store) {
      store = new RunCapabilityReceiptStore(projectDir)
      this.#capabilityReceiptStores.set(projectDir, store)
    }
    return store
  }

  async #leaseProject(projectDirRequest: string): Promise<string> {
    const leased = this.#acquireProjectLease
      ? await this.#acquireProjectLease(projectDirRequest)
      : projectDirRequest
    const projectDir = await resolveProjectDir(this.#projectRoot, leased)
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    return projectDir
  }

  #beginRunPreparation(projectDir: string): void {
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    this.#projectRunPreparations.set(
      projectDir,
      (this.#projectRunPreparations.get(projectDir) ?? 0) + 1,
    )
  }

  #endRunPreparation(projectDir: string): void {
    const remaining = (this.#projectRunPreparations.get(projectDir) ?? 1) - 1
    if (remaining <= 0) {
      this.#projectRunPreparations.delete(projectDir)
    } else {
      this.#projectRunPreparations.set(projectDir, remaining)
    }
  }

  #reserveRun(
    request: RunExecutionRequest,
    projectDir: string,
    canvasBranch: string,
    runId: string,
  ): RunReservation {
    if (this.#projectDeletionReservations.has(projectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    const branchKey = this.#reserveRunBranch(projectDir, canvasBranch, runId)
    try {
      return {
        branchKey,
        ...(isResolvedTaskRunRequest(request)
          ? { taskKey: this.#reserveRunTask(projectDir, canvasBranch, request.taskId, runId) }
          : {}),
      }
    } catch (error) {
      this.#releaseRunBranch(branchKey, runId)
      throw error
    }
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

  #reserveRunTask(
    projectDir: string,
    canvasBranch: string,
    taskId: string,
    runId: string,
  ): string {
    const key = taskLeaseKey(projectDir, canvasBranch, taskId)
    if (this.#taskMutationLeases.has(key)) {
      throw new ProtocolError(`task is busy: ${taskId}`, 'task_busy', 409)
    }
    const currentOwners = this.#taskRunLeases.get(key)
    if ((currentOwners?.size ?? 0) > 0) {
      throw new ProtocolError(
        `this task already has an active or pending run: ${taskId}`,
        'task_run_active',
        409,
      )
    }
    const owners = currentOwners ?? new Set<string>()
    owners.add(runId)
    this.#taskRunLeases.set(key, owners)
    return key
  }

  #releaseRunReservation(reservation: RunReservation, runId: string): void {
    this.#releaseRunBranch(reservation.branchKey, runId)
    if (!reservation.taskKey) return
    const owners = this.#taskRunLeases.get(reservation.taskKey)
    if (!owners) return
    owners.delete(runId)
    if (owners.size === 0) this.#taskRunLeases.delete(reservation.taskKey)
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
      canvasBranch: run.request.canvasBranch,
      taskOwned: isResolvedTaskRunRequest(run.request),
      studioOwned: isNodeStudioRunRequest(run.request),
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
  manifestOwned = taskOwned,
): Promise<void> {
  void targetId
  if (taskOwned) {
    await assertTaskSessionStorePath(scope.projectDir)
    const branchStorageId = canvasBranchStorageId(parseCanvasBranch(canvasBranch))
    const projectionPlanPath = path.join(
      scope.projectDir,
      '.gg',
      'runtime',
      'projection-plans',
      `${branchStorageId}.json`,
    )
    await assertProjectionPlanStorePath(
      scope.projectDir,
      branchStorageId,
      projectionPlanPath,
    )
  }
  if (!manifestOwned) throw new ProtocolError('non-manifest Run artifacts are unsupported')
  const artifactRoot = new RunArtifactStore(scope.projectDir, canvasBranch)
    .location(runId).projectRelativeFilesRoot
  const paths = [
    artifactRoot,
    `.gg/context/runs/${runId}`,
    '.gg/skills',
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

async function assertTaskSessionStorePath(projectDir: string): Promise<void> {
  const runtimeDir = path.join(projectDir, '.gg', 'runtime')
  const expected = path.join(runtimeDir, 'task-sessions.json')
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

async function assertProjectionPlanStorePath(
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

function taskLeaseKey(projectDir: string, canvasBranch: string, taskId: string): string {
  return JSON.stringify([projectDir, canvasBranch, taskId])
}

function projectScopedLeaseKey(key: string, projectDir: string): boolean {
  try {
    const value = JSON.parse(key) as unknown
    return Array.isArray(value) && value[0] === projectDir
  } catch {
    return false
  }
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
    && (run.request.canvasBranch) === canvasBranch
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
  if (isNodeStudioRunRequest(request)) return JSON.stringify({
    executionKind: request.executionKind,
    baseDefinitionId: request.baseDefinitionId,
    baseDefinitionRevision: request.baseDefinitionRevision,
    prompt: request.prompt,
  })
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    baseRevision: request.baseRevision,
    prompt: request.prompt,
    attachments: request.attachments,
    materializationPolicy: request.materializationPolicy,
    pluginCapabilityDigest: requirePinnedPluginCapabilities(request).digest,
    skillResolverCapabilityDigest: request.skillResolverCapabilityDigest,
    skillResolverProvider: request.skillResolverProvider,
  })
}

function semanticCapabilitiesForTaskRun(
  request: Extract<RunExecutionRequest, { schemaVersion: 2 }>,
) {
  return [{
    key: PROJECTION_CAPABILITY_RECEIPT_KEY,
    provider: '@ggai/core-run-acceptance',
    digest: requirePinnedPluginCapabilities(request).digest,
  }, {
    key: SKILL_CAPABILITY_RECEIPT_KEY,
    provider: '@ggai/core-run-acceptance',
    digest: request.skillCapabilityDigest,
  }, {
    key: SKILL_RESOLVER_CAPABILITY_RECEIPT_KEY,
    provider: request.skillResolverProvider,
    digest: request.skillResolverCapabilityDigest,
  }, {
    key: ATTACHMENT_CAPABILITY_RECEIPT_KEY,
    provider: '@ggai/core-run-acceptance',
    digest: resolvedTaskAttachmentCapabilityDigest(request),
  }]
}

function capabilityProfileLabel(profileId: string): string {
  if (profileId === '@ggai/default-agent-runtime') return '默认生成环境'
  if (profileId === '@ggai/empty-agent-runtime') return '空生成环境'
  if (profileId === '@ggai/fallback-agent-runtime') return '兼容生成环境'
  return '自定义生成环境'
}

function pinProjectionPluginCapabilities(
  value: ProjectionPluginCapabilitySnapshot | undefined,
): ProjectionPluginCapabilitySnapshot {
  if (value === undefined) {
    return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
  }
  const inspection = inspectProjectionPluginCapabilitySnapshot(value)
  if (inspection.status !== 'valid') {
    throw new ProtocolError(
      `plugin capability snapshot is invalid: ${inspection.reason}`,
      'invalid_plugin_capabilities',
      400,
    )
  }
  return inspection.snapshot
}

function requirePinnedPluginCapabilities(
  request: Extract<RunExecutionRequest, { schemaVersion: 2 }>,
): ProjectionPluginCapabilitySnapshot {
  if (!request.pluginCapabilities) {
    throw new TypeError('Task Run was not pinned to plugin capabilities')
  }
  return request.pluginCapabilities
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
