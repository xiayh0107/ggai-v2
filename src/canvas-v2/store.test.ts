import { describe, expect, it, vi } from 'vitest'
import { applyCanvasCommandV2, type CanvasCommandV2 } from './commands'
import type {
  CanvasV2CanvasScope,
  CanvasV2CommandOutbox,
  CanvasV2Envelope,
} from './daemonClient'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from './model'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
  type CanvasV2PersistenceScope,
  type CanvasV2ViewState,
} from './persistence'
import { CanvasV2Store, type CanvasV2StoreClient } from './store'

const scope: CanvasV2CanvasScope = {
  projectDir: '/workspace/project',
  branch: 'main',
}
const persistenceScope: CanvasV2PersistenceScope = {
  daemonBaseUrl: 'http://127.0.0.1:7380',
  ...scope,
}

function documentWithTask(goal = 'Initial goal'): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.tasks.push({
    id: 'task-1',
    title: 'Scatter plot',
    goal,
    anchor: { x: 100, y: 120 },
    origin: { kind: 'user' },
  })
  return document
}

function envelope(document: CanvasDocumentV2, revision: number): CanvasV2Envelope {
  return {
    branch: scope.branch,
    revision,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMutationId: null,
    document,
  }
}

function updateGoal(goal: string): CanvasCommandV2 {
  return { type: 'UpdateTaskGoal', taskId: 'task-1', goal }
}

function persistence(adapter = new MemoryCanvasV2PersistenceAdapter()) {
  let now = 0
  return new CanvasV2Persistence<CanvasCommandV2>({
    adapter,
    now: () => ++now,
  })
}

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Canvas V2 store', () => {
  it('hydrates daemon data, branch view state, and a durable optimistic outbox', async () => {
    const subjectPersistence = persistence()
    const storedView: CanvasV2ViewState = {
      camera: { x: 12, y: 30, zoom: 0.8 },
      selection: [{ kind: 'task', id: 'task-1' }],
      collapsedTaskIds: [],
      collapsedCollectionIds: [],
      composerDrafts: { 'task:task-1': 'Refine labels' },
    }
    await subjectPersistence.writeViewState(persistenceScope, storedView)
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 3,
      mutationId: 'queued-mutation',
      command: updateGoal('Queued goal'),
    })
    const releaseFlush = deferred()
    const flushStarted = deferred()
    const client: CanvasV2StoreClient = {
      getCanvas: async () => envelope(documentWithTask(), 3),
      flushOutbox: async (_scope, outbox) => {
        flushStarted.resolve()
        await releaseFlush.promise
        const entries = await outbox.list(persistenceScope)
        for (const entry of entries) await outbox.ack(persistenceScope, entry.mutationId)
        return {
          status: 'flushed',
          acknowledged: entries.length,
          envelope: envelope(documentWithTask('Queued goal'), 4),
        }
      },
    }
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client,
    })

    await store.load()
    await flushStarted.promise

    expect(store.getSnapshot()).toMatchObject({
      hydration: { status: 'ready' },
      envelope: { revision: 3, document: { tasks: [{ goal: 'Initial goal' }] } },
      document: { tasks: [{ goal: 'Queued goal' }] },
      view: storedView,
      commandSync: { pendingCount: 1 },
    })

    releaseFlush.resolve()
    await store.flushCommands()
    expect(store.getSnapshot()).toMatchObject({
      envelope: { revision: 4 },
      document: { tasks: [{ goal: 'Queued goal' }] },
      commandSync: { status: 'saved', pendingCount: 0 },
    })
    expect(await subjectPersistence.list(persistenceScope)).toEqual([])
  })

  it('queues consecutive optimistic commands while a flush is in flight and drains the race', async () => {
    const subjectPersistence = persistence()
    const firstFlushStarted = deferred()
    const releaseFirstFlush = deferred()
    let serverDocument = documentWithTask()
    let serverRevision = 5
    let flushCalls = 0
    const client: CanvasV2StoreClient = {
      getCanvas: async () => envelope(serverDocument, serverRevision),
      flushOutbox: async (_scope, outbox: CanvasV2CommandOutbox) => {
        flushCalls += 1
        const batch = await outbox.list(persistenceScope)
        if (flushCalls === 1) {
          firstFlushStarted.resolve()
          await releaseFirstFlush.promise
        }
        for (const entry of batch) {
          expect(entry.baseRevision).toBe(serverRevision)
          serverDocument = applyCanvasCommandV2(serverDocument, entry.command)
          serverRevision += 1
          await outbox.ack(persistenceScope, entry.mutationId)
        }
        return {
          status: 'flushed',
          acknowledged: batch.length,
          envelope: envelope(serverDocument, serverRevision),
        }
      },
    }
    const mutationIds = ['mutation-a', 'mutation-b', 'mutation-c']
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client,
      mutationId: () => mutationIds.shift() ?? 'unexpected-mutation',
    })
    await store.load()

    await store.dispatchCommand(updateGoal('A'))
    await firstFlushStarted.promise
    await Promise.all([
      store.dispatchCommand(updateGoal('B')),
      store.dispatchCommand(updateGoal('C')),
    ])

    expect(store.getSnapshot().document.tasks[0].goal).toBe('C')
    expect((await subjectPersistence.list(persistenceScope)).map((entry) => ({
      mutationId: entry.mutationId,
      baseRevision: entry.baseRevision,
    }))).toEqual([
      { mutationId: 'mutation-a', baseRevision: 5 },
      { mutationId: 'mutation-b', baseRevision: 6 },
      { mutationId: 'mutation-c', baseRevision: 7 },
    ])

    releaseFirstFlush.resolve()
    await store.flushCommands()
    expect(flushCalls).toBe(2)
    expect(store.getSnapshot()).toMatchObject({
      envelope: { revision: 8 },
      document: { tasks: [{ goal: 'C' }] },
      commandSync: { status: 'saved', pendingCount: 0 },
    })
    expect(await subjectPersistence.list(persistenceScope)).toEqual([])
  })

  it('persists only branch-local view state for camera, selection, collapse, and drafts', async () => {
    const subjectPersistence = persistence()
    const initialDocument = documentWithTask()
    const client: CanvasV2StoreClient = {
      getCanvas: async () => envelope(initialDocument, 0),
      flushOutbox: vi.fn(),
    }
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client,
    })
    await store.load()

    store.setCamera({ x: -20, y: 45, zoom: 1.4 })
    store.setSelection([
      { kind: 'task', id: 'task-1' },
      { kind: 'task', id: 'task-1' },
    ])
    store.setTaskCollapsed('task-1', true)
    store.setCollectionCollapsed('collection-1', true)
    store.setComposerDraft('task:task-1', 'Draft prompt')
    await store.flushViewState()

    expect(await subjectPersistence.readViewState(persistenceScope)).toEqual({
      camera: { x: -20, y: 45, zoom: 1.4 },
      selection: [{ kind: 'task', id: 'task-1' }],
      collapsedTaskIds: ['task-1'],
      collapsedCollectionIds: ['collection-1'],
      composerDrafts: { 'task:task-1': 'Draft prompt' },
    })
    expect(await subjectPersistence.readViewState({
      ...persistenceScope,
      branch: 'feature/rich-task',
    })).toBeNull()
    expect(store.getSnapshot().document).toEqual(initialDocument)
    expect(await subjectPersistence.list(persistenceScope)).toEqual([])
    expect(client.flushOutbox).not.toHaveBeenCalled()
  })

  it('flushes pending view state before reload and keeps the live camera and selection', async () => {
    const adapter = new MemoryCanvasV2PersistenceAdapter()
    const subjectPersistence = persistence(adapter)
    const storedView: CanvasV2ViewState = {
      camera: { x: 8, y: 12, zoom: 0.75 },
      selection: [],
      collapsedTaskIds: [],
      collapsedCollectionIds: [],
      composerDrafts: {},
    }
    await subjectPersistence.writeViewState(persistenceScope, storedView)
    const writeView = vi.spyOn(adapter, 'writeView')
    const materialized = documentWithTask('Materialized goal')
    materialized.nodes.push({
      id: 'node-1',
      type: 'text',
      frame: { x: 420, y: 120, w: 320, h: 180, z: 1 },
      title: 'Materialized output',
      artifactRefs: [],
      homeTaskId: 'task-1',
      origin: { kind: 'user' },
    })
    let reads = 0
    const client: CanvasV2StoreClient = {
      getCanvas: async () => envelope(reads++ === 0 ? documentWithTask() : materialized, reads),
      flushOutbox: vi.fn(),
    }
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client,
    })
    await store.load()

    const liveView: CanvasV2ViewState = {
      camera: { x: -320, y: 185, zoom: 1.65 },
      selection: [{ kind: 'task', id: 'task-1' }],
      collapsedTaskIds: [],
      collapsedCollectionIds: [],
      composerDrafts: { 'task:task-1': 'Keep this draft' },
    }
    store.setCamera(liveView.camera)
    store.setSelection(liveView.selection)
    store.setComposerDraft('task:task-1', 'Keep this draft')

    await store.reload()

    expect(writeView).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toMatchObject({
      hydration: { status: 'ready' },
      document: { nodes: [{ id: 'node-1' }] },
      view: liveView,
      viewSync: { status: 'saved', error: null },
    })
    expect(await subjectPersistence.readViewState(persistenceScope)).toEqual(liveView)
  })

  it('never replaces the live view with an older stored view when reload persistence fails', async () => {
    const adapter = new MemoryCanvasV2PersistenceAdapter()
    const subjectPersistence = persistence(adapter)
    const storedView: CanvasV2ViewState = {
      camera: { x: 10, y: 20, zoom: 0.8 },
      selection: [],
      collapsedTaskIds: [],
      collapsedCollectionIds: [],
      composerDrafts: {},
    }
    await subjectPersistence.writeViewState(persistenceScope, storedView)
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 2),
        flushOutbox: vi.fn(),
      },
    })
    await store.load()
    vi.spyOn(adapter, 'writeView').mockRejectedValue(new Error('IndexedDB unavailable'))

    store.setCamera({ x: -90, y: 240, zoom: 1.25 })
    store.setSelection([{ kind: 'task', id: 'task-1' }])
    await store.reload()

    expect(store.getSnapshot()).toMatchObject({
      hydration: { status: 'ready' },
      view: {
        camera: { x: -90, y: 240, zoom: 1.25 },
        selection: [{ kind: 'task', id: 'task-1' }],
      },
      viewSync: { status: 'error', error: 'IndexedDB unavailable' },
    })
    expect(await subjectPersistence.readViewState(persistenceScope)).toEqual(storedView)
  })

  it('derives task status and ghost layout from transient runtime without persisting it', async () => {
    const adapter = new MemoryCanvasV2PersistenceAdapter()
    const writeView = vi.spyOn(adapter, 'writeView')
    const subjectPersistence = persistence(adapter)
    const initialDocument = documentWithTask()
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(initialDocument, 0),
        flushOutbox: vi.fn(),
      },
    })
    await store.load()

    store.setTaskRuntime({
      taskId: 'task-1',
      runId: 'run-1',
      phase: 'running',
      progress: 0.35,
      message: 'Writing preview',
      ghosts: [{
        key: 'preview',
        title: 'Scatter plot preview',
        pluginId: 'image',
        role: 'primary',
        phase: 'writing',
        progress: 0.4,
      }],
    })

    expect(store.selectTaskView('task-1')).toMatchObject({
      status: {
        kind: 'generating',
        progress: 0.35,
        message: 'Writing preview',
      },
      ghosts: [{
        key: 'preview',
        phase: 'writing',
        progress: 0.4,
        frame: { x: 148, y: 216, w: 400, h: 256 },
      }],
    })
    expect(store.getSnapshot().document).toEqual(initialDocument)
    expect(await subjectPersistence.list(persistenceScope)).toEqual([])
    expect(writeView).not.toHaveBeenCalled()
  })

  it('keeps optimistic state and the durable command visible on a conflict', async () => {
    const subjectPersistence = persistence()
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 2),
        flushOutbox: async (_scope, outbox) => {
          const [entry] = await outbox.list(persistenceScope)
          return {
            status: 'conflict',
            reason: 'precondition',
            mutationId: entry.mutationId,
            currentRevision: 2,
            code: 'canvas_command_precondition_failed',
            message: 'Task changed remotely',
          }
        },
      },
      mutationId: () => 'mutation-conflict',
    })
    await store.load()

    await store.dispatchCommand(updateGoal('Optimistic goal'))
    await store.flushCommands()

    expect(store.getSnapshot()).toMatchObject({
      document: { tasks: [{ goal: 'Optimistic goal' }] },
      commandSync: {
        status: 'conflict',
        pendingCount: 1,
        conflict: {
          reason: 'precondition',
          mutationId: 'mutation-conflict',
        },
      },
    })
    expect((await subjectPersistence.list(persistenceScope)).map((entry) => entry.mutationId))
      .toEqual(['mutation-conflict'])
  })

  it('saves a conflicted FIFO from its immutable initial base and moves live view state', async () => {
    const subjectPersistence = persistence()
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 4,
      mutationId: 'mutation-a',
      command: updateGoal('Local A'),
    })
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 5,
      mutationId: 'mutation-b',
      command: updateGoal('Local B'),
    })
    const saveConflictBranch = vi.fn<NonNullable<CanvasV2StoreClient['saveConflictBranch']>>(
      async (_scope, input) => ({
        sourceBranch: input.sourceBranch,
        newBranch: input.newBranch,
        baseRevision: input.baseRevision,
        canvas: {
          ...envelope(documentWithTask('Local B'), 11),
          branch: input.newBranch,
          lastMutationId: 'mutation-b',
        },
      }),
    )
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 4),
        flushOutbox: async (_scope, outbox) => {
          await outbox.rebaseConflict(persistenceScope, 9)
          return {
            status: 'conflict',
            reason: 'revision',
            mutationId: 'mutation-a',
            currentRevision: 9,
            code: 'canvas_revision_conflict',
            message: 'Remote branch advanced',
          }
        },
        saveConflictBranch,
      },
    })
    await store.load()
    await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('conflict'))
    store.setCamera({ x: -240, y: 90, zoom: 1.4 })
    store.setSelection([{ kind: 'task', id: 'task-1' }])

    const result = await store.saveConflictAsBranch('conflicts/local-work')

    expect(result).toMatchObject({
      sourceBranch: 'main',
      newBranch: 'conflicts/local-work',
      baseRevision: 4,
    })
    expect(saveConflictBranch).toHaveBeenCalledWith(scope, {
      sourceBranch: 'main',
      newBranch: 'conflicts/local-work',
      baseRevision: 4,
      mutations: [
        { mutationId: 'mutation-a', command: updateGoal('Local A') },
        { mutationId: 'mutation-b', command: updateGoal('Local B') },
      ],
    })
    expect(await subjectPersistence.list(persistenceScope)).toEqual([])
    expect(await subjectPersistence.readViewState({
      ...persistenceScope,
      branch: 'conflicts/local-work',
    })).toMatchObject({
      camera: { x: -240, y: 90, zoom: 1.4 },
      selection: [{ kind: 'task', id: 'task-1' }],
    })
    expect(store.getSnapshot()).toMatchObject({
      document: { tasks: [{ goal: 'Local B' }] },
      commandSync: { status: 'saved', pendingCount: 0, conflict: null },
    })
  })

  it('keeps the original conflict and outbox when conflict branch saving fails', async () => {
    const subjectPersistence = persistence()
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 2,
      mutationId: 'mutation-conflict-save',
      command: updateGoal('Unsaved local goal'),
    })
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 2),
        flushOutbox: async () => ({
          status: 'conflict',
          reason: 'precondition',
          mutationId: 'mutation-conflict-save',
          code: 'canvas_command_precondition_failed',
          message: 'Task changed remotely',
        }),
        saveConflictBranch: async () => {
          throw new Error('Conflict branch request failed')
        },
      },
    })
    await store.load()
    await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('conflict'))

    await expect(store.saveConflictAsBranch('conflicts/retry-me'))
      .rejects.toThrow('Conflict branch request failed')

    expect((await subjectPersistence.list(persistenceScope)).map((entry) => entry.mutationId))
      .toEqual(['mutation-conflict-save'])
    expect(await subjectPersistence.readViewState({
      ...persistenceScope,
      branch: 'conflicts/retry-me',
    })).toBeNull()
    expect(store.getSnapshot().commandSync).toMatchObject({
      status: 'conflict',
      pendingCount: 1,
      conflict: { mutationId: 'mutation-conflict-save' },
    })
  })

  it('restores the complete original outbox when acknowledgement fails after branch creation', async () => {
    const subjectPersistence = persistence()
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 6,
      mutationId: 'mutation-ack-a',
      command: updateGoal('Local A'),
    })
    await subjectPersistence.enqueue(persistenceScope, {
      baseRevision: 7,
      mutationId: 'mutation-ack-b',
      command: updateGoal('Local B'),
    })
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 6),
        flushOutbox: async () => ({
          status: 'conflict',
          reason: 'revision',
          mutationId: 'mutation-ack-a',
          currentRevision: 12,
          code: 'canvas_revision_conflict',
          message: 'Remote branch advanced',
        }),
        saveConflictBranch: async (_scope, input) => ({
          sourceBranch: input.sourceBranch,
          newBranch: input.newBranch,
          baseRevision: input.baseRevision,
          canvas: {
            ...envelope(documentWithTask('Local B'), 8),
            branch: input.newBranch,
            lastMutationId: 'mutation-ack-b',
          },
        }),
      },
    })
    await store.load()
    await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('conflict'))
    const acknowledge = vi.spyOn(subjectPersistence, 'ack')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Local acknowledgement failed'))

    await expect(store.saveConflictAsBranch('conflicts/ack-retry'))
      .rejects.toThrow('Local acknowledgement failed')

    expect(acknowledge).toHaveBeenCalledTimes(2)
    expect((await subjectPersistence.list(persistenceScope)).map((entry) => entry.mutationId))
      .toEqual(['mutation-ack-a', 'mutation-ack-b'])
    expect(store.getSnapshot().commandSync).toMatchObject({
      status: 'conflict',
      pendingCount: 2,
      conflict: { mutationId: 'mutation-ack-a' },
    })
  })

  it('refuses to upload more than 500 conflicted mutations without touching the outbox', async () => {
    const subjectPersistence = persistence()
    for (let index = 0; index < 501; index += 1) {
      await subjectPersistence.enqueue(persistenceScope, {
        baseRevision: index,
        mutationId: `mutation-${index}`,
        command: updateGoal(`Local ${index}`),
      })
    }
    const saveConflictBranch = vi.fn<NonNullable<CanvasV2StoreClient['saveConflictBranch']>>()
    const store = new CanvasV2Store({
      daemonBaseUrl: persistenceScope.daemonBaseUrl,
      scope,
      persistence: subjectPersistence,
      client: {
        getCanvas: async () => envelope(documentWithTask(), 0),
        flushOutbox: async () => ({
          status: 'conflict',
          reason: 'revision',
          mutationId: 'mutation-0',
          currentRevision: 4,
          code: 'canvas_revision_conflict',
          message: 'Remote branch advanced',
        }),
        saveConflictBranch,
      },
    })
    await store.load()
    await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('conflict'))

    await expect(store.saveConflictAsBranch('conflicts/too-many'))
      .rejects.toThrow('501 pending mutations; maximum is 500')
    expect(saveConflictBranch).not.toHaveBeenCalled()
    expect(await subjectPersistence.list(persistenceScope)).toHaveLength(501)
    expect(store.getSnapshot().commandSync.status).toBe('conflict')
  })
})
