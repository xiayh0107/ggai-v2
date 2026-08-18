import { applyCanvasCommand, type CanvasCommand } from './commands'
import { MAX_CANVAS_CONFLICT_MUTATIONS } from './daemonClient'
import type {
  CanvasCanvasScope,
  CanvasCommandOutbox,
  CanvasDaemonClient,
  CanvasEnvelope,
  CanvasFlushResult,
  CanvasSaveConflictBranchInput,
  CanvasSaveConflictBranchResult,
} from './daemonClient'
import { emptyCanvasDocument, type CanvasDocument } from './model'
import {
  CanvasPersistence,
  type CanvasOutboxEntry,
  type CanvasPersistenceScope,
  type CanvasSelectionTarget,
  type CanvasViewState,
} from './persistence'
import {
  selectTaskView,
  type CanvasGhostOutput,
  type CanvasProposalReview,
  type CanvasTaskRuntime,
  type CanvasTaskView,
} from './selectors'

export type CanvasHydrationStatus = 'idle' | 'loading' | 'ready' | 'error'
export type CanvasRefreshStatus = 'idle' | 'refreshing' | 'error'
export type CanvasCommandSyncStatus =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'error'
  | 'conflict'
export type CanvasViewSyncStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface CanvasStoreConflict {
  reason: 'revision' | 'precondition' | 'replay'
  mutationId: string
  code: string
  message: string
  currentRevision?: number
}

export interface CanvasStoreState {
  scope: CanvasCanvasScope
  hydration: {
    status: CanvasHydrationStatus
    error: string | null
  }
  /** Background daemon refresh; unlike initial hydration it never unmounts Canvas. */
  refresh: {
    status: CanvasRefreshStatus
    error: string | null
  }
  commandSync: {
    status: CanvasCommandSyncStatus
    pendingCount: number
    error: string | null
    conflict: CanvasStoreConflict | null
  }
  viewSync: {
    status: CanvasViewSyncStatus
    error: string | null
  }
  /** Last daemon-acknowledged envelope. */
  envelope: CanvasEnvelope | null
  /** Envelope document plus locally queued commands. */
  document: CanvasDocument
  /** Branch-local browser state. Never copied into document. */
  view: CanvasViewState
  /** Run/SSE projection. Never copied into document or IndexedDB view state. */
  runtimeByTaskId: Readonly<Record<string, CanvasTaskRuntime>>
}

export interface CanvasStoreClient {
  getCanvas(scope: CanvasCanvasScope): Promise<CanvasEnvelope>
  flushOutbox(
    scope: CanvasCanvasScope,
    outbox: CanvasCommandOutbox,
  ): Promise<CanvasFlushResult>
  saveConflictBranch?(
    scope: CanvasCanvasScope,
    input: CanvasSaveConflictBranchInput,
  ): Promise<CanvasSaveConflictBranchResult>
}

export interface CanvasStoreOptions {
  daemonBaseUrl: string
  scope: CanvasCanvasScope
  client: CanvasStoreClient | CanvasDaemonClient
  persistence?: CanvasPersistence<CanvasCommand>
  mutationId?: () => string
  viewWriteDelayMs?: number
}

export type CanvasOutboxReplayResult =
  | { status: 'applied'; document: CanvasDocument }
  | {
      status: 'conflict'
      document: CanvasDocument
      mutationId: string
      message: string
    }

type Listener = () => void

export function defaultCanvasViewState(): CanvasViewState {
  return {
    camera: { x: 80, y: 60, zoom: 1 },
    selection: [],
    collapsedTaskIds: [],
    collapsedCollectionIds: [],
    composerDrafts: {},
  }
}

export function replayCanvasOutbox(
  document: CanvasDocument,
  entries: readonly CanvasOutboxEntry<CanvasCommand>[],
): CanvasOutboxReplayResult {
  let next = document
  for (const entry of entries) {
    try {
      next = applyCanvasCommand(next, entry.command)
    } catch (error) {
      return {
        status: 'conflict',
        document: next,
        mutationId: entry.mutationId,
        message: errorMessage(error),
      }
    }
  }
  return { status: 'applied', document: next }
}

export class CanvasStore {
  readonly #client: CanvasStoreClient
  readonly #persistence: CanvasPersistence<CanvasCommand>
  readonly #outbox: CanvasCommandOutbox
  readonly #persistenceScope: CanvasPersistenceScope
  readonly #mutationId: () => string
  readonly #viewWriteDelayMs: number
  readonly #listeners = new Set<Listener>()

  #state: CanvasStoreState
  #loadPromise: Promise<void> | null = null
  #reloadPromise: Promise<void> | null = null
  #reloadRequested = false
  #flushPromise: Promise<void> | null = null
  #flushRequested = false
  #enqueueTail: Promise<void> = Promise.resolve()
  #outboxTail: Promise<void> = Promise.resolve()
  #acknowledgedRevision = 0
  #viewWriteTail: Promise<void> = Promise.resolve()
  #viewTimer: ReturnType<typeof setTimeout> | null = null
  #viewVersion = 0

  constructor(options: CanvasStoreOptions) {
    if (!options.daemonBaseUrl.trim()) throw new TypeError('daemonBaseUrl is required')
    if (!options.scope.projectDir || !options.scope.branch) {
      throw new TypeError('Canvas scope requires projectDir and branch')
    }
    this.#client = options.client
    this.#persistence = options.persistence ?? new CanvasPersistence<CanvasCommand>()
    this.#outbox = {
      list: (scope) => this.#withOutboxLock(() => this.#persistence.list(scope)),
      ack: (scope, mutationId) => this.#withOutboxLock(async () => {
        await this.#persistence.ack(scope, mutationId)
        this.#acknowledgedRevision += 1
      }),
      rebaseConflict: (scope, serverRevision) => this.#withOutboxLock(async () => {
        const entries = await this.#persistence.rebaseConflict(scope, serverRevision)
        this.#acknowledgedRevision = serverRevision
        return entries
      }),
    }
    this.#persistenceScope = {
      daemonBaseUrl: options.daemonBaseUrl,
      projectDir: options.scope.projectDir,
      branch: options.scope.branch,
    }
    this.#mutationId = options.mutationId ?? defaultMutationId
    this.#viewWriteDelayMs = options.viewWriteDelayMs ?? 180
    this.#state = {
      scope: structuredClone(options.scope),
      hydration: { status: 'idle', error: null },
      refresh: { status: 'idle', error: null },
      commandSync: {
        status: 'idle',
        pendingCount: 0,
        error: null,
        conflict: null,
      },
      viewSync: { status: 'idle', error: null },
      envelope: null,
      document: emptyCanvasDocument(),
      view: defaultCanvasViewState(),
      runtimeByTaskId: {},
    }
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): CanvasStoreState => this.#state

  load(): Promise<void> {
    if (this.#state.hydration.status === 'ready') return Promise.resolve()
    if (this.#loadPromise) return this.#loadPromise
    const operation = this.#load(false)
    this.#loadPromise = operation
    return operation
  }

  async reload(): Promise<void> {
    this.#reloadRequested = true
    if (this.#reloadPromise) return this.#reloadPromise
    const operation = this.#drainReloadRequests().finally(() => {
      if (this.#reloadPromise === operation) this.#reloadPromise = null
    })
    this.#reloadPromise = operation
    return operation
  }

  async #drainReloadRequests(): Promise<void> {
    while (this.#reloadRequested) {
      this.#reloadRequested = false
      await this.#reloadOnce()
    }
  }

  async #reloadOnce(): Promise<void> {
    if (this.#flushPromise) await this.#flushPromise
    if (this.#state.viewSync.status === 'pending'
      || this.#state.viewSync.status === 'saving'
      || this.#state.viewSync.status === 'error') {
      await this.flushViewState()
    }
    const backgroundRefresh = this.#state.hydration.status === 'ready'
    await this.#load(true, backgroundRefresh)
  }

  dispatchCommand(command: CanvasCommand): Promise<{ mutationId: string }> {
    let resolveResult!: (result: { mutationId: string }) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<{ mutationId: string }>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const operation = this.#enqueueTail.then(async () => {
      this.#assertCanDispatch()
      applyCanvasCommand(this.#state.document, command)
      const mutationId = this.#mutationId()
      await this.#withOutboxLock(async () => {
        this.#assertCanDispatch()
        const pending = await this.#persistence.list(this.#persistenceScope)
        const baseRevision = this.#acknowledgedRevision + pending.length
        const nextDocument = applyCanvasCommand(this.#state.document, command)
        await this.#persistence.enqueue(this.#persistenceScope, {
          baseRevision,
          mutationId,
          command,
        })
        this.#setState((state) => ({
          ...state,
          document: nextDocument,
          commandSync: {
            status: 'pending',
            pendingCount: pending.length + 1,
            error: null,
            conflict: null,
          },
        }))
      })
      resolveResult({ mutationId })
      void this.flushCommands()
    })
    this.#enqueueTail = operation.then(
      () => undefined,
      (error) => {
        rejectResult(error)
      },
    )
    return result
  }

  flushCommands(): Promise<void> {
    if (this.#flushPromise) {
      this.#flushRequested = true
      return this.#flushPromise
    }
    this.#flushRequested = false
    const operation = this.#drainCommands().finally(() => {
      if (this.#flushPromise !== operation) return
      this.#flushPromise = null
      if (this.#flushRequested
        && this.#state.commandSync.status !== 'conflict'
        && this.#state.commandSync.status !== 'error') {
        this.#flushRequested = false
        void this.flushCommands()
      }
    })
    this.#flushPromise = operation
    return operation
  }

  retryCommands(): Promise<void> {
    if (this.#state.commandSync.status !== 'error') return Promise.resolve()
    this.#setState((state) => ({
      ...state,
      commandSync: { ...state.commandSync, status: 'pending', error: null },
    }))
    return this.flushCommands()
  }

  async saveConflictAsBranch(newBranch: string): Promise<CanvasSaveConflictBranchResult> {
    await this.#enqueueTail
    if (this.#flushPromise) await this.#flushPromise
    if (this.#state.commandSync.status !== 'conflict' || !this.#state.commandSync.conflict) {
      throw new Error('Canvas conflict branch can only be saved from a conflict state')
    }
    const saveConflictBranch = this.#client.saveConflictBranch
    if (!saveConflictBranch) {
      throw new Error('Canvas conflict branch saving is unavailable')
    }
    const entries = await this.#withOutboxLock(() =>
      this.#persistence.list(this.#persistenceScope))
    if (entries.length === 0) {
      throw new Error('Canvas conflict has no pending mutations to save')
    }
    if (entries.length > MAX_CANVAS_CONFLICT_MUTATIONS) {
      throw new Error(
        `Canvas conflict has ${entries.length} pending mutations; maximum is ${MAX_CANVAS_CONFLICT_MUTATIONS}`,
      )
    }
    const sourceBranch = this.#state.scope.branch
    const result = await saveConflictBranch.call(this.#client, this.#state.scope, {
      sourceBranch,
      newBranch,
      baseRevision: entries[0]!.initialBaseRevision,
      mutations: entries.map((entry) => ({
        mutationId: entry.mutationId,
        command: structuredClone(entry.command),
      })),
    })
    const targetScope: CanvasPersistenceScope = {
      ...this.#persistenceScope,
      branch: result.newBranch,
    }
    await this.#persistence.writeViewState(targetScope, structuredClone(this.#state.view))
    await this.#withOutboxLock(async () => {
      const current = await this.#persistence.list(this.#persistenceScope)
      if (current.length !== entries.length
        || current.some((entry, index) => entry.mutationId !== entries[index]?.mutationId)) {
        throw new Error('Canvas conflict outbox changed while saving its branch')
      }
      try {
        for (const entry of entries) {
          await this.#persistence.ack(this.#persistenceScope, entry.mutationId)
        }
      } catch (error) {
        await this.#persistence.replaceOutbox(this.#persistenceScope, entries)
        throw error
      }
    })
    this.#setState((state) => ({
      ...state,
      commandSync: {
        status: 'saved',
        pendingCount: 0,
        error: null,
        conflict: null,
      },
    }))
    return result
  }

  setCamera(camera: CanvasViewState['camera']): void {
    if (![camera.x, camera.y, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) {
      throw new TypeError('Canvas camera is invalid')
    }
    this.#updateView((view) => ({ ...view, camera: { ...camera } }))
  }

  setSelection(selection: CanvasSelectionTarget[]): void {
    const seen = new Set<string>()
    const unique = selection.filter((target) => {
      const key = `${target.kind}:${target.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map((target) => ({ ...target }))
    this.#updateView((view) => ({ ...view, selection: unique }))
  }

  setTaskCollapsed(taskId: string, collapsed: boolean): void {
    this.#updateView((view) => ({
      ...view,
      collapsedTaskIds: toggleId(view.collapsedTaskIds, taskId, collapsed),
    }))
  }

  setCollectionCollapsed(collectionId: string, collapsed: boolean): void {
    this.#updateView((view) => ({
      ...view,
      collapsedCollectionIds: toggleId(
        view.collapsedCollectionIds,
        collectionId,
        collapsed,
      ),
    }))
  }

  setComposerDraft(entityKey: string, draft: string): void {
    if (!entityKey || entityKey.length > 512 || draft.length > 250_000) {
      throw new TypeError('Canvas composer draft is invalid')
    }
    this.#updateView((view) => ({
      ...view,
      composerDrafts: { ...view.composerDrafts, [entityKey]: draft },
    }))
  }

  flushViewState(): Promise<void> {
    if (this.#viewTimer) {
      clearTimeout(this.#viewTimer)
      this.#viewTimer = null
    }
    const version = this.#viewVersion
    const view = structuredClone(this.#state.view)
    this.#setState((state) => ({
      ...state,
      viewSync: { status: 'saving', error: null },
    }))
    const operation = this.#viewWriteTail
      .catch(() => undefined)
      .then(() => this.#persistence.writeViewState(this.#persistenceScope, view))
      .then(() => {
        if (version === this.#viewVersion) {
          this.#setState((state) => ({
            ...state,
            viewSync: { status: 'saved', error: null },
          }))
        } else {
          this.#setState((state) => ({
            ...state,
            viewSync: { status: 'pending', error: null },
          }))
          this.#scheduleViewWrite()
        }
      })
      .catch((error: unknown) => {
        this.#setState((state) => ({
          ...state,
          viewSync: { status: 'error', error: errorMessage(error) },
        }))
      })
    this.#viewWriteTail = operation
    return operation
  }

  setTaskRuntime(runtime: CanvasTaskRuntime): void {
    if (this.#state.hydration.status === 'ready'
      && !this.#state.document.tasks.some((task) => task.id === runtime.taskId)) {
      throw new TypeError(`Task ${runtime.taskId} does not exist`)
    }
    const keys = runtime.ghosts.map((ghost) => ghost.key)
    if (new Set(keys).size !== keys.length) {
      throw new TypeError('Canvas ghost keys must be unique per task')
    }
    this.#setState((state) => ({
      ...state,
      runtimeByTaskId: {
        ...state.runtimeByTaskId,
        [runtime.taskId]: structuredClone(runtime),
      },
    }))
  }

  upsertTaskGhost(taskId: string, ghost: CanvasGhostOutput): void {
    const runtime = this.#state.runtimeByTaskId[taskId]
    if (!runtime) throw new TypeError(`Task ${taskId} has no runtime state`)
    const index = runtime.ghosts.findIndex((entry) => entry.key === ghost.key)
    const ghosts = [...runtime.ghosts]
    if (index === -1) ghosts.push(structuredClone(ghost))
    else ghosts[index] = structuredClone(ghost)
    this.setTaskRuntime({ ...runtime, ghosts })
  }

  clearTaskRuntime(taskId: string): void {
    if (!this.#state.runtimeByTaskId[taskId]) return
    const next = { ...this.#state.runtimeByTaskId }
    delete next[taskId]
    this.#setState((state) => ({ ...state, runtimeByTaskId: next }))
  }

  selectTaskView(
    taskId: string,
    proposalReview?: CanvasProposalReview,
  ): CanvasTaskView | null {
    const selected = this.#state.view.selection.some((target) =>
      target.kind === 'task' && target.id === taskId)
    return selectTaskView(this.#state.document, taskId, {
      zoom: this.#state.view.camera.zoom,
      selected,
      explicitlyCollapsed: this.#state.view.collapsedTaskIds.includes(taskId),
      runtime: this.#state.runtimeByTaskId[taskId],
      ...(proposalReview ? { proposalReview } : {}),
    })
  }

  dispose(): void {
    if (this.#viewTimer) clearTimeout(this.#viewTimer)
    this.#viewTimer = null
    if (this.#state.viewSync.status === 'pending') void this.flushViewState()
    this.#listeners.clear()
  }

  async #load(preserveLiveView: boolean, backgroundRefresh = false): Promise<void> {
    this.#setState((state) => ({
      ...state,
      ...(backgroundRefresh
        ? { refresh: { status: 'refreshing' as const, error: null } }
        : { hydration: { status: 'loading' as const, error: null } }),
      commandSync: { ...state.commandSync, error: null, conflict: null },
      ...(preserveLiveView ? {} : { viewSync: { status: 'idle' as const, error: null } }),
    }))
    try {
      const [envelope, storedView, entries] = await Promise.all([
        this.#client.getCanvas(this.#state.scope),
        this.#persistence.readViewState(this.#persistenceScope),
        this.#outbox.list(this.#persistenceScope),
      ])
      if (backgroundRefresh && envelope.revision < this.#acknowledgedRevision) {
        this.#setState((state) => ({
          ...state,
          refresh: { status: 'idle', error: null },
        }))
        return
      }
      this.#acknowledgedRevision = envelope.revision
      const replay = replayCanvasOutbox(envelope.document, entries)
      if (replay.status === 'conflict') {
        this.#setState((state) => ({
          ...state,
          hydration: { status: 'ready', error: null },
          refresh: { status: 'idle', error: null },
          envelope,
          document: replay.document,
          view: preserveLiveView ? state.view : storedView ?? defaultCanvasViewState(),
          ...(preserveLiveView
            ? {}
            : { viewSync: { status: 'saved' as const, error: null } }),
          commandSync: {
            status: 'conflict',
            pendingCount: entries.length,
            error: null,
            conflict: {
              reason: 'replay',
              mutationId: replay.mutationId,
              code: 'local_replay_failed',
              message: replay.message,
            },
          },
        }))
        return
      }
      this.#setState((state) => ({
        ...state,
        hydration: { status: 'ready', error: null },
        refresh: { status: 'idle', error: null },
        envelope,
        document: replay.document,
        view: preserveLiveView ? state.view : storedView ?? defaultCanvasViewState(),
        ...(preserveLiveView
          ? {}
          : { viewSync: { status: 'saved' as const, error: null } }),
        commandSync: {
          status: entries.length > 0 ? 'pending' : 'saved',
          pendingCount: entries.length,
          error: null,
          conflict: null,
        },
      }))
      if (entries.length > 0) void this.flushCommands()
    } catch (error) {
      if (backgroundRefresh) {
        this.#setState((state) => ({
          ...state,
          refresh: { status: 'error', error: errorMessage(error) },
        }))
        throw error
      }
      this.#setState((state) => ({
        ...state,
        hydration: { status: 'error', error: errorMessage(error) },
      }))
    }
  }

  async #drainCommands(): Promise<void> {
    while (true) {
      this.#flushRequested = false
      await this.#flushCommandsOnce()
      if (this.#state.commandSync.status === 'conflict'
        || this.#state.commandSync.status === 'error') return
      const entries = await this.#outbox.list(this.#persistenceScope)
      if (entries.length === 0 && !this.#flushRequested) return
    }
  }

  async #flushCommandsOnce(): Promise<void> {
    const entries = await this.#withOutboxLock(async () => {
      const pending = await this.#persistence.list(this.#persistenceScope)
      this.#setState((state) => ({
        ...state,
        commandSync: pending.length === 0
          ? {
              status: 'saved',
              pendingCount: 0,
              error: null,
              conflict: null,
            }
          : {
              ...state.commandSync,
              status: 'saving',
              pendingCount: pending.length,
              error: null,
            },
      }))
      return pending
    })
    if (entries.length === 0) {
      return
    }
    try {
      const result = await this.#client.flushOutbox(this.#state.scope, this.#outbox)
      if (result.status === 'conflict') {
        await this.#withOutboxLock(async () => {
          const pending = await this.#persistence.list(this.#persistenceScope)
          this.#setState((state) => ({
            ...state,
            ...(result.envelope ? { envelope: result.envelope } : {}),
            commandSync: {
              status: 'conflict',
              pendingCount: pending.length,
              error: null,
              conflict: {
                reason: result.reason,
                mutationId: result.mutationId,
                code: result.code,
                message: result.message,
                ...(result.currentRevision === undefined
                  ? {}
                  : { currentRevision: result.currentRevision }),
              },
            },
          }))
        })
        return
      }
      const envelope = result.envelope ?? this.#state.envelope
      if (!envelope) throw new Error('Canvas flush did not return an envelope')
      await this.#withOutboxLock(async () => {
        this.#acknowledgedRevision = envelope.revision
        const pending = await this.#persistence.list(this.#persistenceScope)
        const replay = replayCanvasOutbox(envelope.document, pending)
        if (replay.status === 'conflict') {
          this.#setState((state) => ({
            ...state,
            envelope,
            document: replay.document,
            commandSync: {
              status: 'conflict',
              pendingCount: pending.length,
              error: null,
              conflict: {
                reason: 'replay',
                mutationId: replay.mutationId,
                code: 'local_replay_failed',
                message: replay.message,
              },
            },
          }))
          return
        }
        this.#setState((state) => ({
          ...state,
          envelope,
          document: replay.document,
          commandSync: {
            status: pending.length > 0 ? 'pending' : 'saved',
            pendingCount: pending.length,
            error: null,
            conflict: null,
          },
        }))
      })
    } catch (error) {
      await this.#withOutboxLock(async () => {
        const pending = await this.#persistence.list(this.#persistenceScope)
        this.#setState((state) => ({
          ...state,
          commandSync: {
            status: 'error',
            pendingCount: pending.length,
            error: errorMessage(error),
            conflict: null,
          },
        }))
      })
    }
  }

  #assertCanDispatch(): void {
    if (this.#state.hydration.status !== 'ready') {
      throw new Error('Canvas is not ready')
    }
    if (this.#state.commandSync.status === 'conflict') {
      throw new Error('Canvas has an unresolved command conflict')
    }
    if (this.#state.commandSync.status === 'error') {
      throw new Error('Canvas command outbox must be retried first')
    }
  }

  #updateView(update: (view: CanvasViewState) => CanvasViewState): void {
    const view = update(structuredClone(this.#state.view))
    this.#viewVersion += 1
    this.#setState((state) => ({
      ...state,
      view,
      viewSync: { status: 'pending', error: null },
    }))
    this.#scheduleViewWrite()
  }

  #scheduleViewWrite(): void {
    if (this.#viewTimer) clearTimeout(this.#viewTimer)
    this.#viewTimer = setTimeout(() => {
      this.#viewTimer = null
      void this.flushViewState()
    }, this.#viewWriteDelayMs)
  }

  #setState(update: (state: CanvasStoreState) => CanvasStoreState): void {
    this.#state = update(this.#state)
    for (const listener of this.#listeners) listener()
  }

  #withOutboxLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#outboxTail.then(operation, operation)
    this.#outboxTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function toggleId(ids: readonly string[], id: string, enabled: boolean): string[] {
  const present = ids.includes(id)
  if (enabled === present) return [...ids]
  return enabled ? [...ids, id] : ids.filter((entry) => entry !== id)
}

function defaultMutationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `mutation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
