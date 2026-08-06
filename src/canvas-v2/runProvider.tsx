import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  DaemonClient,
  type PermissionDecision,
  type PermissionResolution,
} from '@/agent/daemonClient'
import { DaemonTaskRunClientV2 } from '@/agent/daemonTaskRunClientV2'
import {
  CanvasV2TaskRunController,
  type CanvasV2PermissionRequestNotice,
  type CanvasV2ProjectionSettlementNotice,
  type CanvasV2RunTaskInput,
  type CanvasV2TaskRunClose,
  type CanvasV2TaskRunHandle,
  type CanvasV2TaskRunLogEntry,
} from './runController'
import type { CanvasV2Store } from './store'
import { CanvasV2TaskRunContext } from './runHooks'

export interface CanvasV2ProjectionReview {
  planId: string
  taskId: string
  runId: string
  plan: CanvasV2ProjectionSettlementNotice['plan']
  suggestedActions: CanvasV2ProjectionSettlementNotice['suggestedActions']
  receivedAt: number
}

export interface CanvasV2TaskRunNonFatalError {
  id: string
  operation: 'recover' | 'start' | 'cancel' | 'permission' | 'stream'
  message: string
  taskId?: string
  runId?: string
  occurredAt: number
}

export interface CanvasV2TaskRunLifecycleSnapshot {
  recovering: boolean
  recoveredScopeKeys: readonly string[]
  pendingPermissions: readonly CanvasV2PermissionRequestNotice[]
  projectionReviews: readonly CanvasV2ProjectionReview[]
  nonFatalErrors: readonly CanvasV2TaskRunNonFatalError[]
}

export interface CanvasV2TaskRunControllerLike {
  runTask(input: CanvasV2RunTaskInput): Promise<CanvasV2TaskRunHandle>
  recoverAll(): Promise<CanvasV2TaskRunHandle[]>
  cancelTask(taskId: string): Promise<CanvasV2TaskRunClose | null>
  getRunLog(runId: string): readonly CanvasV2TaskRunLogEntry[]
  dispose(): void
}

export interface CanvasV2TaskRunControllerFactoryInput {
  store: CanvasV2Store
  daemonClient: DaemonClient
  onPermissionRequest: (notice: CanvasV2PermissionRequestNotice) => void
  onProjectionPlan: (notice: CanvasV2ProjectionSettlementNotice) => void
  onError: (error: unknown) => void
}

export type CanvasV2TaskRunControllerFactory = (
  input: CanvasV2TaskRunControllerFactoryInput,
) => CanvasV2TaskRunControllerLike

export interface CanvasV2TaskRunProviderProps {
  store: CanvasV2Store
  daemonClient: DaemonClient
  children: ReactNode
  /** Test seam; production always uses the trusted daemon adapter/controller. */
  controllerFactory?: CanvasV2TaskRunControllerFactory
}

type Listener = () => void

const EMPTY_SNAPSHOT: CanvasV2TaskRunLifecycleSnapshot = {
  recovering: false,
  recoveredScopeKeys: [],
  pendingPermissions: [],
  projectionReviews: [],
  nonFatalErrors: [],
}

export class CanvasV2TaskRunLifecycle {
  readonly #store: CanvasV2Store
  readonly #daemonClient: DaemonClient
  readonly #controller: CanvasV2TaskRunControllerLike
  readonly #listeners = new Set<Listener>()
  readonly #recoveryByScope = new Map<string, Promise<void>>()
  readonly #observedRunIds = new Set<string>()
  #snapshot: CanvasV2TaskRunLifecycleSnapshot = EMPTY_SNAPSHOT
  #retainGeneration = 0
  #errorSequence = 0
  #disposed = false

  constructor(input: {
    store: CanvasV2Store
    daemonClient: DaemonClient
    controllerFactory?: CanvasV2TaskRunControllerFactory
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

  readonly getSnapshot = (): CanvasV2TaskRunLifecycleSnapshot => this.#snapshot

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

  async startTask(input: CanvasV2RunTaskInput): Promise<CanvasV2TaskRunHandle> {
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

  continueTask(input: CanvasV2RunTaskInput): Promise<CanvasV2TaskRunHandle> {
    return this.startTask(input)
  }

  async cancelTask(taskId: string): Promise<CanvasV2TaskRunClose | null> {
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

  getRunLog(runId: string): readonly CanvasV2TaskRunLogEntry[] {
    return this.#controller.getRunLog(runId)
  }

  getProjectionReviewForTask(taskId: string): CanvasV2ProjectionReview | null {
    return this.#snapshot.projectionReviews
      .filter((review) => review.taskId === taskId)
      .sort((left, right) => right.receivedAt - left.receivedAt)[0] ?? null
  }

  getSuggestedActions(taskId: string) {
    return this.getProjectionReviewForTask(taskId)?.suggestedActions ?? []
  }

  /** Removes review UI only after a durable Canvas receipt settled that plan. */
  clearSettledProjectionReview(planId: string): boolean {
    const settled = this.#store.getSnapshot().document.receipts.some((receipt) =>
      receipt.planId === planId
      && (receipt.kind === 'proposal-acceptance' || receipt.kind === 'plan-dismissal'))
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

  #observeHandle(handle: CanvasV2TaskRunHandle): void {
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

  #receivePermission(notice: CanvasV2PermissionRequestNotice): void {
    if (this.#disposed) return
    const pendingPermissions = this.#snapshot.pendingPermissions
      .filter((entry) => entry.permissionId !== notice.permissionId)
    pendingPermissions.push(notice)
    this.#setSnapshot({ ...this.#snapshot, pendingPermissions })
  }

  #receiveProjectionPlan(notice: CanvasV2ProjectionSettlementNotice): void {
    if (this.#disposed) return
    const current = this.#snapshot.projectionReviews.find((review) =>
      review.planId === notice.plan.planId)
    if (current) return
    this.#setSnapshot({
      ...this.#snapshot,
      projectionReviews: [...this.#snapshot.projectionReviews, {
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
    operation: CanvasV2TaskRunNonFatalError['operation'],
    error: unknown,
    identity: { taskId?: string; runId?: string } = {},
  ): void {
    if (this.#disposed) return
    const next: CanvasV2TaskRunNonFatalError = {
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

  #setSnapshot(snapshot: CanvasV2TaskRunLifecycleSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Canvas V2 Task Run lifecycle is disposed')
  }
}

export function CanvasV2TaskRunProvider({
  store,
  daemonClient,
  children,
  controllerFactory,
}: CanvasV2TaskRunProviderProps) {
  const lifecycle = useMemo(() => new CanvasV2TaskRunLifecycle({
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
    <CanvasV2TaskRunContext.Provider value={lifecycle}>
      {children}
    </CanvasV2TaskRunContext.Provider>
  )
}

function defaultControllerFactory(
  input: CanvasV2TaskRunControllerFactoryInput,
): CanvasV2TaskRunControllerLike {
  return new CanvasV2TaskRunController({
    store: input.store,
    client: new DaemonTaskRunClientV2({ client: input.daemonClient }),
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
