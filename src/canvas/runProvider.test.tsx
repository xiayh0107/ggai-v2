// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskRunHttpClient } from '@/agent/taskRunHttpClient'
import { emptyCanvasDocument, type CanvasDocument } from './model'
import { CanvasPersistence, MemoryCanvasPersistenceAdapter } from './persistence'
import { CanvasProvider } from './provider'
import {
  useCanvasProjectionReview,
  useCanvasSuggestedActions,
  useCanvasTaskRuns,
  useCanvasTaskRunState,
} from './runHooks'
import {
  CanvasTaskRunProvider,
  type CanvasTaskRunControllerFactoryInput,
  type CanvasTaskRunControllerLike,
  type CanvasTaskRunLifecycle,
} from './runProvider'
import type {
  CanvasRunTaskInput,
  CanvasTaskRunClose,
  CanvasTaskRunHandle,
  CanvasTaskRunSummary,
} from './runController'
import { CanvasStore } from './store'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  act(() => root?.unmount())
  await act(async () => Promise.resolve())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function canvasDocument(receiptPlanId?: string): CanvasDocument {
  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-1',
    title: 'Scatter plot',
    goal: 'Create a scatter plot',
    anchor: { x: 10, y: 20 },
    origin: { kind: 'user' },
  })
  if (receiptPlanId) {
    document.receipts.push({
      kind: 'plan-dismissal',
      planId: receiptPlanId,
      runId: 'run-recovered',
      taskId: 'task-1',
      proposalKeys: ['next'],
    })
  }
  return document
}

function makeStore(
  document = canvasDocument(),
  flushMode: 'legacy' | 'conflict' = 'legacy',
): CanvasStore {
  return new CanvasStore({
    daemonBaseUrl: 'http://127.0.0.1:7380',
    scope: { projectDir: '/workspace/project', branch: 'main' },
    persistence: new CanvasPersistence({
      adapter: new MemoryCanvasPersistenceAdapter(),
    }),
    client: {
      getCanvas: async () => ({
        branch: 'main',
        revision: 4,
        updatedAt: '2026-08-05T00:00:00.000Z',
        lastMutationId: null,
        document,
      }),
      flushOutbox: async (_scope, outbox) => {
        if (flushMode === 'conflict') {
          const entries = await outbox.list({
            daemonBaseUrl: 'http://127.0.0.1:7380',
            projectDir: '/workspace/project',
            branch: 'main',
          })
          return {
            status: 'conflict',
            reason: 'revision',
            mutationId: entries[0]?.mutationId ?? 'missing-mutation',
            currentRevision: 5,
            code: 'revision_conflict',
            message: 'Canvas revision changed before acknowledgement',
          }
        }
        return { status: 'flushed', acknowledged: 0, envelope: null }
      },
    },
  })
}

function daemonClient() {
  return {
    resolvePermission: vi.fn(async () => undefined),
  } as unknown as TaskRunHttpClient
}

class FakeController implements CanvasTaskRunControllerLike {
  callbacks: CanvasTaskRunControllerFactoryInput | null = null
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasTaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasRunTaskInput) =>
    pendingHandle(input.taskId, 'run-started'))
  readonly cancelTaskMock = vi.fn(async (taskId: string): Promise<CanvasTaskRunClose | null> => {
    void taskId
    return null
  })
  readonly getRunLogMock = vi.fn((runId: string) => {
    void runId
    return [{
      eventId: 1,
      kind: 'thinking' as const,
      text: 'working',
    }]
  })
  readonly readTaskRunSummaryMock = vi.fn(async (runId: string): Promise<CanvasTaskRunSummary> => ({
    runId,
    taskId: 'task-1',
    agentId: 'codex',
    canvasBranch: 'main',
    baseRevision: 4,
    prompt: 'Create a scatter plot.',
    status: 'done',
    startedAt: 1,
  }))
  readonly disposeMock = vi.fn()

  factory = (input: CanvasTaskRunControllerFactoryInput) => {
    this.callbacks = input
    return this
  }

  runTask(input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle> {
    return this.runTaskMock(input)
  }

  recoverAll(): Promise<CanvasTaskRunHandle[]> {
    return this.recoverAllMock()
  }

  cancelTask(taskId: string): Promise<CanvasTaskRunClose | null> {
    return this.cancelTaskMock(taskId)
  }

  getRunLog(runId: string) {
    return this.getRunLogMock(runId)
  }

  readTaskRunSummary(runId: string): Promise<CanvasTaskRunSummary> {
    return this.readTaskRunSummaryMock(runId)
  }

  readTaskRunLog(runId: string, afterEventId: number) {
    void runId
    void afterEventId
    return Promise.resolve({ entries: [], nextEventId: null, closed: false })
  }

  dispose(): void {
    this.disposeMock()
  }
}

function pendingHandle(taskId: string, runId: string): CanvasTaskRunHandle {
  return {
    taskId,
    runId,
    completion: new Promise(() => undefined),
    detach: () => undefined,
  }
}

function projectionPlan(identity = 'a') {
  return {
    schemaVersion: 2 as const,
    planId: `plan_${identity.repeat(64)}`,
    runId: 'run-recovered',
    taskId: 'task-1',
    status: 'complete' as const,
    manifestDigest: 'b'.repeat(64),
    outputs: [{
      key: 'preview',
      pluginId: 'image',
      role: 'primary' as const,
      title: 'Preview',
      artifactRefs: [{
        runId: 'run-recovered',
        artifactId: `artifact_${'c'.repeat(64)}`,
      }],
      derivedFrom: [],
      materialize: true,
    }],
    taskProposals: [{
      key: 'next',
      title: 'Refine',
      prompt: 'Refine the preview.',
      inputOutputKeys: ['preview'],
      dependsOn: [],
    }],
    warnings: [],
    digest: 'd'.repeat(64),
  }
}

let exposedLifecycle: CanvasTaskRunLifecycle | null = null
const lifecycleIdentities: CanvasTaskRunLifecycle[] = []

function Probe() {
  const lifecycle = useCanvasTaskRuns()
  const state = useCanvasTaskRunState()
  const review = useCanvasProjectionReview('task-1')
  const actions = useCanvasSuggestedActions('task-1')
  useEffect(() => {
    exposedLifecycle = lifecycle
    lifecycleIdentities.push(lifecycle)
  })
  return (
    <output
      data-recovering={String(state.recovering)}
      data-permissions={state.pendingPermissions.length}
      data-reviews={state.projectionReviews.length}
      data-actions={actions.length}
      data-errors={state.nonFatalErrors.length}
      data-plan={review?.planId ?? ''}
    />
  )
}

async function renderHarness(input: {
  store?: CanvasStore
  daemon?: TaskRunHttpClient
  controller?: FakeController
  strict?: boolean
} = {}) {
  const store = input.store ?? makeStore()
  const daemon = input.daemon ?? daemonClient()
  const controller = input.controller ?? new FakeController()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const tree = (
    <CanvasProvider store={store}>
      <CanvasTaskRunProvider
        store={store}
        daemonClient={daemon}
        controllerFactory={controller.factory}
      >
        <Probe />
      </CanvasTaskRunProvider>
    </CanvasProvider>
  )
  await act(async () => {
    root?.render(input.strict ? <StrictMode>{tree}</StrictMode> : tree)
  })
  await act(async () => {
    await vi.waitFor(() => expect(store.getSnapshot().hydration.status).toBe('ready'))
  })
  return { store, daemon, controller }
}

describe('Canvas Task Run provider', () => {
  afterEach(() => {
    exposedLifecycle = null
    lifecycleIdentities.length = 0
  })

  it('recovers each hydrated scope once under StrictMode and keeps context identity stable', async () => {
    const { controller } = await renderHarness({ strict: true })

    await act(async () => {
      await vi.waitFor(() => expect(controller.recoverAllMock).toHaveBeenCalledTimes(1))
    })
    expect(controller.disposeMock).not.toHaveBeenCalled()
    expect(new Set(lifecycleIdentities).size).toBe(1)
  })

  it('restores a terminal full plan into memory without accepting or starting proposals', async () => {
    const controller = new FakeController()
    const plan = projectionPlan()
    controller.recoverAllMock.mockImplementationOnce(async () => {
      controller.callbacks?.onProjectionPlan({
        taskId: 'task-1',
        runId: 'run-recovered',
        plan,
        suggestedActions: [{ id: 'refine', label: 'Refine', prompt: 'Refine it.' }],
      })
      return []
    })
    await renderHarness({ controller })

    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('output')?.dataset.reviews).toBe('1'))
    })
    expect(exposedLifecycle?.getProjectionReviewForTask('task-1')?.plan).toBe(plan)
    expect(exposedLifecycle?.getSuggestedActions('task-1')).toHaveLength(1)
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('replaces an older in-memory review when the same Task finishes a newer Run', async () => {
    const controller = new FakeController()
    await renderHarness({ controller })
    const first = projectionPlan('a')
    const latest = {
      ...projectionPlan('e'),
      runId: 'run-latest',
    }

    act(() => {
      controller.callbacks?.onProjectionPlan({
        taskId: 'task-1',
        runId: first.runId,
        plan: first,
        suggestedActions: [],
      })
      controller.callbacks?.onProjectionPlan({
        taskId: 'task-1',
        runId: latest.runId,
        plan: latest,
        suggestedActions: [],
      })
    })

    expect(container?.querySelector('output')?.dataset.reviews).toBe('1')
    expect(container?.querySelector('output')?.dataset.plan).toBe(latest.planId)
  })

  it('tracks permission requests and clears them only after daemon resolution succeeds', async () => {
    const daemon = daemonClient()
    const { controller } = await renderHarness({ daemon })
    act(() => controller.callbacks?.onPermissionRequest({
      taskId: 'task-1',
      runId: 'run-1',
      permissionId: 'permission-1',
      action: 'write',
      detail: 'Write preview.png',
    }))
    expect(container?.querySelector('output')?.dataset.permissions).toBe('1')

    await act(async () => {
      await exposedLifecycle?.resolvePermission('permission-1', 'allow')
    })

    expect(daemon.resolvePermission).toHaveBeenCalledWith('permission-1', 'allow')
    expect(container?.querySelector('output')?.dataset.permissions).toBe('0')
    expect(new Set(lifecycleIdentities).size).toBe(1)
  })

  it('waits for controller durable close when cancelling and clears Run permissions', async () => {
    const controller = new FakeController()
    let resolveCancel!: (close: CanvasTaskRunClose) => void
    controller.cancelTaskMock.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveCancel = resolve }))
    await renderHarness({ controller })
    act(() => controller.callbacks?.onPermissionRequest({
      taskId: 'task-1',
      runId: 'run-1',
      permissionId: 'permission-1',
      action: 'write',
      detail: 'Write output',
    }))
    let settled = false
    const cancelling = exposedLifecycle?.cancelTask('task-1').then(() => { settled = true })
    await act(async () => Promise.resolve())
    expect(settled).toBe(false)

    await act(async () => {
      resolveCancel({ runId: 'run-1', status: 'cancelled', artifactsComplete: false })
      await cancelling
    })

    expect(settled).toBe(true)
    expect(container?.querySelector('output')?.dataset.permissions).toBe('0')
  })

  it('unmounts by detaching the controller and never requests cancellation', async () => {
    const { controller } = await renderHarness({ strict: true })
    await act(async () => {
      await vi.waitFor(() => expect(controller.recoverAllMock).toHaveBeenCalledTimes(1))
    })

    act(() => root?.unmount())
    await act(async () => Promise.resolve())
    root = null

    expect(controller.disposeMock).toHaveBeenCalledTimes(1)
    expect(controller.cancelTaskMock).not.toHaveBeenCalled()
  })

  it('isolates recovery and action failures as non-fatal state', async () => {
    const controller = new FakeController()
    controller.recoverAllMock.mockRejectedValueOnce(new Error('recovery unavailable'))
    controller.runTaskMock.mockRejectedValueOnce(new Error('start unavailable'))
    await renderHarness({ controller })
    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('output')?.dataset.errors).toBe('1'))
    })

    await act(async () => exposedLifecycle?.recoverOnce())
    expect(controller.recoverAllMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await expect(exposedLifecycle?.startTask({
        taskId: 'task-1',
        agentId: 'codex',
      })).rejects.toThrow('start unavailable')
    })

    expect(container?.querySelector('output')?.dataset.errors).toBe('2')
    expect(container?.querySelector('output')).not.toBeNull()
  })

  it('clears a review only when Canvas has a durable settlement receipt', async () => {
    const plan = projectionPlan()
    const controller = new FakeController()
    controller.recoverAllMock.mockImplementationOnce(async () => {
      controller.callbacks?.onProjectionPlan({
        taskId: 'task-1',
        runId: 'run-recovered',
        plan,
        suggestedActions: [],
      })
      return []
    })
    await renderHarness({
      controller,
      store: makeStore(canvasDocument(plan.planId)),
    })
    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('output')?.dataset.reviews).toBe('1'))
    })

    act(() => {
      expect(exposedLifecycle?.clearSettledProjectionReview(plan.planId)).toBe(true)
    })
    expect(container?.querySelector('output')?.dataset.reviews).toBe('0')
  })

  it('does not clear a review from an optimistic receipt before daemon acknowledgement', async () => {
    const plan = projectionPlan()
    const controller = new FakeController()
    controller.recoverAllMock.mockImplementationOnce(async () => {
      controller.callbacks?.onProjectionPlan({
        taskId: 'task-1',
        runId: 'run-recovered',
        plan,
        suggestedActions: [],
      })
      return []
    })
    const { store } = await renderHarness({
      controller,
      store: makeStore(canvasDocument(), 'conflict'),
    })
    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('output')?.dataset.reviews).toBe('1'))
      await store.dispatchCommand({ type: 'DismissPlan', plan })
    })

    expect(store.getSnapshot().document.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'plan-dismissal', planId: plan.planId }),
    ]))
    expect(store.getSnapshot().envelope?.document.receipts).toEqual([])
    act(() => {
      expect(exposedLifecycle?.clearSettledProjectionReview(plan.planId)).toBe(false)
    })
    expect(container?.querySelector('output')?.dataset.reviews).toBe('1')
  })

  it('exposes bounded controller logs without copying them into Provider state', async () => {
    const { controller } = await renderHarness()

    expect(exposedLifecycle?.getRunLog('run-1')).toEqual([{
      eventId: 1,
      kind: 'thinking',
      text: 'working',
    }])
    expect(controller.getRunLogMock).toHaveBeenCalledWith('run-1')
  })

  it('exposes immutable Task Run summaries without copying them into Provider state', async () => {
    const { controller } = await renderHarness()
    const before = exposedLifecycle?.getSnapshot()

    await expect(exposedLifecycle?.readTaskRunSummary('run-origin')).resolves.toMatchObject({
      runId: 'run-origin',
      taskId: 'task-1',
      baseRevision: 4,
      prompt: 'Create a scatter plot.',
    })
    expect(controller.readTaskRunSummaryMock).toHaveBeenCalledWith('run-origin')
    expect(exposedLifecycle?.getSnapshot()).toBe(before)
  })
})
