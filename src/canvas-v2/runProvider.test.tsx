// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@/agent/daemonClient'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from './model'
import { CanvasV2Persistence, MemoryCanvasV2PersistenceAdapter } from './persistence'
import { CanvasV2Provider } from './provider'
import {
  useCanvasV2ProjectionReview,
  useCanvasV2SuggestedActions,
  useCanvasV2TaskRuns,
  useCanvasV2TaskRunState,
} from './runHooks'
import {
  CanvasV2TaskRunProvider,
  type CanvasV2TaskRunControllerFactoryInput,
  type CanvasV2TaskRunControllerLike,
  type CanvasV2TaskRunLifecycle,
} from './runProvider'
import type {
  CanvasV2RunTaskInput,
  CanvasV2TaskRunClose,
  CanvasV2TaskRunHandle,
} from './runController'
import { CanvasV2Store } from './store'

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

function canvasDocument(receiptPlanId?: string): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
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

function makeStore(document = canvasDocument()): CanvasV2Store {
  return new CanvasV2Store({
    daemonBaseUrl: 'http://127.0.0.1:7380',
    scope: { projectDir: '/workspace/project', branch: 'main' },
    persistence: new CanvasV2Persistence({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
    }),
    client: {
      getCanvas: async () => ({
        branch: 'main',
        revision: 4,
        updatedAt: '2026-08-05T00:00:00.000Z',
        lastMutationId: null,
        document,
      }),
      flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
    },
  })
}

function daemonClient() {
  return {
    resolvePermission: vi.fn(async () => undefined),
  } as unknown as DaemonClient
}

class FakeController implements CanvasV2TaskRunControllerLike {
  callbacks: CanvasV2TaskRunControllerFactoryInput | null = null
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasV2TaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasV2RunTaskInput) =>
    pendingHandle(input.taskId, 'run-started'))
  readonly cancelTaskMock = vi.fn(async (taskId: string): Promise<CanvasV2TaskRunClose | null> => {
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
  readonly disposeMock = vi.fn()

  factory = (input: CanvasV2TaskRunControllerFactoryInput) => {
    this.callbacks = input
    return this
  }

  runTask(input: CanvasV2RunTaskInput): Promise<CanvasV2TaskRunHandle> {
    return this.runTaskMock(input)
  }

  recoverAll(): Promise<CanvasV2TaskRunHandle[]> {
    return this.recoverAllMock()
  }

  cancelTask(taskId: string): Promise<CanvasV2TaskRunClose | null> {
    return this.cancelTaskMock(taskId)
  }

  getRunLog(runId: string) {
    return this.getRunLogMock(runId)
  }

  dispose(): void {
    this.disposeMock()
  }
}

function pendingHandle(taskId: string, runId: string): CanvasV2TaskRunHandle {
  return {
    taskId,
    runId,
    completion: new Promise(() => undefined),
    detach: () => undefined,
  }
}

function projectionPlan() {
  return {
    schemaVersion: 2 as const,
    planId: `plan_${'a'.repeat(64)}`,
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

let exposedLifecycle: CanvasV2TaskRunLifecycle | null = null
const lifecycleIdentities: CanvasV2TaskRunLifecycle[] = []

function Probe() {
  const lifecycle = useCanvasV2TaskRuns()
  const state = useCanvasV2TaskRunState()
  const review = useCanvasV2ProjectionReview('task-1')
  const actions = useCanvasV2SuggestedActions('task-1')
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
  store?: CanvasV2Store
  daemon?: DaemonClient
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
    <CanvasV2Provider store={store}>
      <CanvasV2TaskRunProvider
        store={store}
        daemonClient={daemon}
        controllerFactory={controller.factory}
      >
        <Probe />
      </CanvasV2TaskRunProvider>
    </CanvasV2Provider>
  )
  await act(async () => {
    root?.render(input.strict ? <StrictMode>{tree}</StrictMode> : tree)
  })
  await act(async () => {
    await vi.waitFor(() => expect(store.getSnapshot().hydration.status).toBe('ready'))
  })
  return { store, daemon, controller }
}

describe('Canvas V2 Task Run provider', () => {
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
    let resolveCancel!: (close: CanvasV2TaskRunClose) => void
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

  it('exposes bounded controller logs without copying them into Provider state', async () => {
    const { controller } = await renderHarness()

    expect(exposedLifecycle?.getRunLog('run-1')).toEqual([{
      eventId: 1,
      kind: 'thinking',
      text: 'working',
    }])
    expect(controller.getRunLogMock).toHaveBeenCalledWith('run-1')
  })
})
