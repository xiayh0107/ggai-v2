import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  type PermissionDecision,
  type PermissionResolution,
} from '@/agent/permissions'
import {
  DaemonTaskRunClient,
  type CanvasTaskRunDaemonApi,
} from '@/agent/taskRunClient'
import {
  CanvasTaskRunController,
  type CanvasPermissionRequestNotice,
  type CanvasProjectionSettlementNotice,
  type CanvasRunTaskInput,
  type CanvasTaskRunClose,
  type CanvasTaskRunHandle,
  type CanvasTaskRunLogEntry,
  type CanvasTaskRunSummary,
} from './runController'
import type { CanvasStore } from './store'
import { CanvasTaskRunContext } from './runHooks'

export interface CanvasProjectionReview {
  planId: string
  taskId: string
  runId: string
  plan: CanvasProjectionSettlementNotice['plan']
  suggestedActions: CanvasProjectionSettlementNotice['suggestedActions']
  receivedAt: number
}

export interface CanvasTaskRunNonFatalError {
  id: string
  operation: 'recover' | 'start' | 'cancel' | 'permission' | 'stream'
  message: string
  taskId?: string
  runId?: string
  occurredAt: number
}

export interface CanvasTaskRunLifecycleSnapshot {
  recovering: boolean
  recoveredScopeKeys: readonly string[]
  pendingPermissions: readonly CanvasPermissionRequestNotice[]
  projectionReviews: readonly CanvasProjectionReview[]
  nonFatalErrors: readonly CanvasTaskRunNonFatalError[]
}

export interface CanvasTaskRunControllerLike {
  runTask(input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle>
  recoverAll(): Promise<CanvasTaskRunHandle[]>
  cancelTask(taskId: string): Promise<CanvasTaskRunClose | null>
  getRunLog(runId: string): readonly CanvasTaskRunLogEntry[]
  readTaskRunSummary(runId: string): Promise<CanvasTaskRunSummary>
  readTaskRunLog(runId: string, afterEventId: number): Promise<{
    entries: readonly CanvasTaskRunLogEntry[]
    nextEventId: number | null
    closed: boolean
  }>
  dispose(): void
}

export interface CanvasTaskRunControllerFactoryInput {
  store: CanvasStore
  daemonClient: CanvasTaskRunDaemonApi
  onPermissionRequest: (notice: CanvasPermissionRequestNotice) => void
  onProjectionPlan: (notice: CanvasProjectionSettlementNotice) => void
  onError: (error: unknown) => void
}

export type CanvasTaskRunControllerFactory = (
  input: CanvasTaskRunControllerFactoryInput,
) => CanvasTaskRunControllerLike

export interface CanvasTaskRunProviderProps {
  store: CanvasStore
  daemonClient: CanvasTaskRunDaemonApi
  children: ReactNode
  /** Test seam; production always uses the trusted daemon adapter/controller. */
  controllerFactory?: CanvasTaskRunControllerFactory
}

type Listener = () => void

const EMPTY_SNAPSHOT: CanvasTaskRunLifecycleSnapshot = {
  recovering: false,
  recoveredScopeKeys: [],
  pendingPermissions: [],
  projectionReviews: [],
  nonFatalErrors: [],
}

export class CanvasTaskRunLifecycle {
  readonly #store: CanvasStore
  readonly #daemonClient: CanvasTaskRunDaemonApi
  readonly #controller: CanvasTaskRunControllerLike
  readonly #listeners = new Set<Listener>()
  readonly #recoveryByScope = new Map<string, Promise<void>>()
  readonly #observedRunIds = new Set<string>()
  #snapshot: CanvasTaskRunLifecycleSnapshot = EMPTY_SNAPSHOT
  #retainGeneration = 0
  #errorSequence = 0
  #disposed = false

  constructor(input: {
    store: CanvasStore
    daemonClient: CanvasTaskRunDaemonApi
    controllerFactory?: CanvasTaskRunControllerFactory
  }) {
    this.#store = input.store
    this.#daemonClient = input.daemonClient
    const factory = input.controllerFactory ?? defaultControllerFactory
    this.#controller = factory({
      store: input.store,
      daemonClient: input.daemonClient,
      onPermissionRequest: (notice) => this.#receivePermission(notice),
      onProjectionPlan: (notice) => this.#receiveProjectionPlan(notice),
      onError: (error) => this.#recordError('stream', error),
    })
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): CanvasTaskRunLifecycleSnapshot => this.#snapshot

  /** StrictMode-safe ownership: a same-instance immediate remount cancels disposal. */
  retain(): () => void {
    const generation = ++this.#retainGeneration
    return () => {
      queueMicrotask(() => {
        if (this.#retainGeneration === generation) this.dispose()
      })
    }
  }

  recoverOnce(): Promise<void> {
    this.#assertUsable()
    const canvas = this.#store.getSnapshot()
    if (canvas.hydration.status !== 'ready') return Promise.resolve()
    const scopeKey = JSON.stringify([canvas.scope.projectDir, canvas.scope.branch])
    const existing = this.#recoveryByScope.get(scopeKey)
    if (existing) return existing
    const operation = this.#recover(scopeKey)
    this.#recoveryByScope.set(scopeKey, operation)
    return operation
  }

  async startTask(input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle> {
    this.#assertUsable()
    try {
      const handle = await this.#controller.runTask(input)
      this.#observeHandle(handle)
      return handle
    } catch (error) {
      this.#recordError('start', error, { taskId: input.taskId })
      throw error
    }
  }

  continueTask(input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle> {
    return this.startTask(input)
  }

  async cancelTask(taskId: string): Promise<CanvasTaskRunClose | null> {
    this.#assertUsable()
    try {
      const close = await this.#controller.cancelTask(taskId)
      if (close) this.#clearPermissions({ taskId, runId: close.runId })
      return close
    } catch (error) {
      this.#recordError('cancel', error, { taskId })
      throw error
    }
  }

  async resolvePermission(
    permissionId: string,
    resolution: PermissionDecision | PermissionResolution,
  ): Promise<void> {
    this.#assertUsable()
    const pending = this.#snapshot.pendingPermissions.find((entry) =>
      entry.permissionId === permissionId)
    if (!pending) throw new Error(`Permission ${permissionId} is not pending`)
    try {
      await this.#daemonClient.resolvePermission(permissionId, resolution)
      this.#setSnapshot({
        ...this.#snapshot,
        pendingPermissions: this.#snapshot.pendingPermissions.filter((entry) =>
          entry.permissionId !== permissionId),
      })
    } catch (error) {
      this.#recordError('permission', error, {
        taskId: pending.taskId,
        runId: pending.runId,
      })
      throw error
    }
  }

  getRunLog(runId: string): readonly CanvasTaskRunLogEntry[] {
    return this.#controller.getRunLog(runId)
  }

  readTaskRunSummary(runId: string): Promise<CanvasTaskRunSummary> {
    this.#assertUsable()
    return this.#controller.readTaskRunSummary(runId)
  }

  readTaskRunLog(runId: string, afterEventId: number) {
    this.#assertUsable()
    return this.#controller.readTaskRunLog(runId, afterEventId)
  }

  getProjectionReviewForTask(taskId: string): CanvasProjectionReview | null {
    return this.#snapshot.projectionReviews
      .filter((review) => review.taskId === taskId)
      .sort((left, right) => right.receivedAt - left.receivedAt)[0] ?? null
  }

  getSuggestedActions(taskId: string) {
    return this.getProjectionReviewForTask(taskId)?.suggestedActions ?? []
  }

  /** Removes review UI only after a durable Canvas receipt settled that plan. */
  clearSettledProjectionReview(planId: string): boolean {
    const settled = this.#store.getSnapshot().envelope?.document.receipts.some((receipt) =>
      receipt.planId === planId
      && (receipt.kind === 'proposal-acceptance' || receipt.kind === 'plan-dismissal')) ?? false
    if (!settled) return false
    const projectionReviews = this.#snapshot.projectionReviews.filter((review) =>
      review.planId !== planId)
    if (projectionReviews.length === this.#snapshot.projectionReviews.length) return false
    this.#setSnapshot({ ...this.#snapshot, projectionReviews })
    return true
  }

  clearNonFatalError(errorId: string): void {
    const nonFatalErrors = this.#snapshot.nonFatalErrors.filter((error) => error.id !== errorId)
    if (nonFatalErrors.length === this.#snapshot.nonFatalErrors.length) return
    this.#setSnapshot({ ...this.#snapshot, nonFatalErrors })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#controller.dispose()
    this.#listeners.clear()
  }

  async #recover(scopeKey: string): Promise<void> {
    this.#setSnapshot({ ...this.#snapshot, recovering: true })
    try {
      const handles = await this.#controller.recoverAll()
      for (const handle of handles) this.#observeHandle(handle)
    } catch (error) {
      if (!this.#disposed && !isAbortError(error)) this.#recordError('recover', error)
    } finally {
      if (!this.#disposed) {
        this.#setSnapshot({
          ...this.#snapshot,
          recovering: false,
          recoveredScopeKeys: this.#snapshot.recoveredScopeKeys.includes(scopeKey)
            ? this.#snapshot.recoveredScopeKeys
            : [...this.#snapshot.recoveredScopeKeys, scopeKey],
        })
      }
    }
  }

  #observeHandle(handle: CanvasTaskRunHandle): void {
    if (this.#observedRunIds.has(handle.runId)) return
    this.#observedRunIds.add(handle.runId)
    void handle.completion.then(
      (close) => this.#clearPermissions({ taskId: handle.taskId, runId: close.runId }),
      (error: unknown) => {
        if (!this.#disposed && !isAbortError(error)) {
          this.#recordError('stream', error, { taskId: handle.taskId, runId: handle.runId })
        }
      },
    )
  }

  #receivePermission(notice: CanvasPermissionRequestNotice): void {
    if (this.#disposed) return
    const pendingPermissions = this.#snapshot.pendingPermissions
      .filter((entry) => entry.permissionId !== notice.permissionId)
    pendingPermissions.push(notice)
    this.#setSnapshot({ ...this.#snapshot, pendingPermissions })
  }

  #receiveProjectionPlan(notice: CanvasProjectionSettlementNotice): void {
    if (this.#disposed) return
    const current = this.#snapshot.projectionReviews.find((review) =>
      review.planId === notice.plan.planId)
    if (current) return
    this.#setSnapshot({
      ...this.#snapshot,
      projectionReviews: [...this.#snapshot.projectionReviews.filter((review) =>
        review.taskId !== notice.taskId), {
        planId: notice.plan.planId,
        taskId: notice.taskId,
        runId: notice.runId,
        plan: notice.plan,
        suggestedActions: notice.suggestedActions,
        receivedAt: Date.now(),
      }],
    })
  }

  #clearPermissions(identity: { taskId: string; runId: string }): void {
    if (this.#disposed) return
    const pendingPermissions = this.#snapshot.pendingPermissions.filter((entry) =>
      entry.taskId !== identity.taskId || entry.runId !== identity.runId)
    if (pendingPermissions.length === this.#snapshot.pendingPermissions.length) return
    this.#setSnapshot({ ...this.#snapshot, pendingPermissions })
  }

  #recordError(
    operation: CanvasTaskRunNonFatalError['operation'],
    error: unknown,
    identity: { taskId?: string; runId?: string } = {},
  ): void {
    if (this.#disposed) return
    const next: CanvasTaskRunNonFatalError = {
      id: `run-error-${++this.#errorSequence}`,
      operation,
      message: errorMessage(error),
      ...identity,
      occurredAt: Date.now(),
    }
    this.#setSnapshot({
      ...this.#snapshot,
      nonFatalErrors: [...this.#snapshot.nonFatalErrors.slice(-19), next],
    })
  }

  #setSnapshot(snapshot: CanvasTaskRunLifecycleSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Canvas Task Run lifecycle is disposed')
  }
}

export function CanvasTaskRunProvider({
  store,
  daemonClient,
  children,
  controllerFactory,
}: CanvasTaskRunProviderProps) {
  const lifecycle = useMemo(() => new CanvasTaskRunLifecycle({
    store,
    daemonClient,
    ...(controllerFactory ? { controllerFactory } : {}),
  }), [controllerFactory, daemonClient, store])
  const canvasState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => lifecycle.retain(), [lifecycle])

  useEffect(() => {
    if (canvasState.hydration.status === 'ready') void lifecycle.recoverOnce()
  }, [canvasState.hydration.status, canvasState.scope.branch, canvasState.scope.projectDir, lifecycle])

  return (
    <CanvasTaskRunContext.Provider value={lifecycle}>
      {children}
    </CanvasTaskRunContext.Provider>
  )
}

function defaultControllerFactory(
  input: CanvasTaskRunControllerFactoryInput,
): CanvasTaskRunControllerLike {
  return new CanvasTaskRunController({
    store: input.store,
    client: new DaemonTaskRunClient({ client: input.daemonClient }),
    onPermissionRequest: input.onPermissionRequest,
    onProjectionPlan: input.onProjectionPlan,
    onError: input.onError,
  })
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
