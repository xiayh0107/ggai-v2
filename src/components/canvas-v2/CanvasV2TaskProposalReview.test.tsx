// @vitest-environment jsdom
import { act, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonClient, DaemonProjectionPlanV2 } from '@/agent/daemonClient'
import { applyCanvasCommandV2, type CanvasCommandV2 } from '@/canvas-v2/commands'
import type {
  CanvasV2CommandOutbox,
  CanvasV2Envelope,
} from '@/canvas-v2/daemonClient'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from '@/canvas-v2/model'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
  type CanvasV2PersistenceScope,
} from '@/canvas-v2/persistence'
import { CanvasV2Provider } from '@/canvas-v2/provider'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import {
  CanvasV2TaskRunProvider,
  type CanvasV2TaskRunControllerFactoryInput,
  type CanvasV2TaskRunControllerLike,
  type CanvasV2TaskRunLifecycle,
} from '@/canvas-v2/runProvider'
import type {
  CanvasV2RunTaskInput,
  CanvasV2TaskRunClose,
  CanvasV2TaskRunHandle,
  CanvasV2TaskRunLogEntry,
} from '@/canvas-v2/runController'
import { selectTaskViewV2 } from '@/canvas-v2/selectors'
import { CanvasV2Store } from '@/canvas-v2/store'
import CanvasV2TaskGroup from './CanvasV2TaskGroup'

const projectDir = '/workspace/project'
const branch = 'main'
const daemonBaseUrl = 'http://127.0.0.1:7380'
const planId = `plan_${'a'.repeat(64)}`
const task = {
  id: 'task-parent',
  title: '分析任务',
  goal: '完成数据分析',
  anchor: { x: 40, y: 50 },
  origin: { kind: 'user' as const },
}
const plan: DaemonProjectionPlanV2 = {
  schemaVersion: 2,
  planId,
  runId: 'run-finished',
  taskId: task.id,
  status: 'complete',
  manifestDigest: 'b'.repeat(64),
  outputs: [],
  taskProposals: [
    {
      key: 'prepare',
      title: '整理数据',
      prompt: '整理原始数据。',
      inputOutputKeys: [],
      dependsOn: [],
    },
    {
      key: 'explain',
      title: '解释结果',
      prompt: '解释数据结果。',
      inputOutputKeys: [],
      dependsOn: ['prepare'],
    },
    {
      key: 'publish',
      title: '发布报告',
      prompt: '发布最终报告。',
      inputOutputKeys: [],
      dependsOn: ['explain'],
    },
  ],
  warnings: [],
  digest: 'c'.repeat(64),
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let mountedStore: CanvasV2Store | null = null
let capturedLifecycle: CanvasV2TaskRunLifecycle | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    await mountedStore?.flushCommands()
    await Promise.resolve()
  })
  act(() => root?.unmount())
  await act(async () => Promise.resolve())
  root = null
  container?.remove()
  container = null
  mountedStore = null
  capturedLifecycle = null
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function canvasDocument(settledProposalKey?: string): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.everCreated = true
  document.tasks.push(task)
  if (settledProposalKey) {
    document.receipts.push({
      kind: 'materialization',
      planId,
      runId: plan.runId,
      taskId: task.id,
      outcomes: [],
      dismissedProposalKeys: [settledProposalKey],
    })
  }
  return document
}

function envelope(document: CanvasDocumentV2, revision: number): CanvasV2Envelope {
  return {
    branch,
    revision,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMutationId: null,
    document: structuredClone(document),
  }
}

type FlushMode = 'success' | 'error' | 'conflict'

function makeStore(initialDocument: CanvasDocumentV2, flushMode: FlushMode = 'success') {
  const persistenceScope: CanvasV2PersistenceScope = {
    daemonBaseUrl,
    projectDir,
    branch,
  }
  let serverDocument = structuredClone(initialDocument)
  let serverRevision = 7
  const flushedCommands: CanvasCommandV2[] = []
  const persistence = new CanvasV2Persistence<CanvasCommandV2>({
    adapter: new MemoryCanvasV2PersistenceAdapter(),
  })
  const store = new CanvasV2Store({
    daemonBaseUrl,
    scope: { projectDir, branch },
    persistence,
    client: {
      getCanvas: async () => envelope(serverDocument, serverRevision),
      flushOutbox: async (_scope, outbox: CanvasV2CommandOutbox) => {
        const entries = await outbox.list(persistenceScope)
        if (flushMode === 'error') throw new Error('daemon unavailable')
        if (flushMode === 'conflict') {
          return {
            status: 'conflict' as const,
            reason: 'revision' as const,
            mutationId: entries[0]?.mutationId ?? 'missing-mutation',
            currentRevision: serverRevision + 1,
            code: 'revision_conflict',
            message: 'Canvas revision changed',
          }
        }
        for (const entry of entries) {
          flushedCommands.push(structuredClone(entry.command))
          serverDocument = applyCanvasCommandV2(serverDocument, entry.command)
          serverRevision += 1
          await outbox.ack(persistenceScope, entry.mutationId)
        }
        return {
          status: 'flushed' as const,
          acknowledged: entries.length,
          envelope: envelope(serverDocument, serverRevision),
        }
      },
    },
  })
  return { store, flushedCommands }
}

class FakeController implements CanvasV2TaskRunControllerLike {
  callbacks: CanvasV2TaskRunControllerFactoryInput | null = null
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasV2TaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasV2RunTaskInput) => ({
    taskId: input.taskId,
    runId: 'run-unexpected',
    completion: new Promise<CanvasV2TaskRunClose>(() => undefined),
    detach: () => undefined,
  }))
  readonly cancelTaskMock = vi.fn(async (
    taskId: string,
  ): Promise<CanvasV2TaskRunClose | null> => {
    void taskId
    return null
  })
  readonly disposeMock = vi.fn()

  readonly factory = (input: CanvasV2TaskRunControllerFactoryInput) => {
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

  getRunLog(runId: string): readonly CanvasV2TaskRunLogEntry[] {
    void runId
    return []
  }

  dispose(): void {
    this.disposeMock()
  }
}

function daemonClient(): DaemonClient {
  return {
    resolvePermission: vi.fn(async () => undefined),
  } as unknown as DaemonClient
}

function LifecycleCapture() {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  useEffect(() => {
    capturedLifecycle = lifecycle
    return () => {
      if (capturedLifecycle === lifecycle) capturedLifecycle = null
    }
  }, [lifecycle])
  return null
}

async function renderHarness(input: {
  document?: CanvasDocumentV2
  withRunContext?: boolean
  flushMode?: FlushMode
} = {}) {
  const initialDocument = input.document ?? canvasDocument()
  const { store, flushedCommands } = makeStore(initialDocument, input.flushMode)
  const controller = new FakeController()
  const view = selectTaskViewV2(initialDocument, task.id, {
    zoom: 1,
    selected: true,
  })
  if (!view) throw new Error('Missing task view')
  const taskGroup = (
    <CanvasV2TaskGroup
      view={view}
      projectDir={projectDir}
      selectedTask
      selectedNodeIds={new Set()}
      explicitlyCollapsed={false}
      activeKey={`task:${task.id}`}
      onSelectTask={() => undefined}
      onToggleCollapsed={() => undefined}
      onTaskDragStart={() => undefined}
      onNodeDragStart={() => undefined}
      onNodeResizeStart={() => undefined}
      onEntityFocus={() => undefined}
      onEntityKeyDown={() => undefined}
      registerFocusable={() => undefined}
    />
  )
  const content = input.withRunContext === false ? taskGroup : (
    <CanvasV2TaskRunProvider
      store={store}
      daemonClient={daemonClient()}
      controllerFactory={controller.factory}
    >
      <LifecycleCapture />
      {taskGroup}
    </CanvasV2TaskRunProvider>
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mountedStore = store
  await act(async () => root?.render(
    <CanvasV2Provider store={store}>{content}</CanvasV2Provider>,
  ))
  await act(async () => {
    await vi.waitFor(() => expect(store.getSnapshot().hydration.status).toBe('ready'))
    if (input.withRunContext !== false) {
      await vi.waitFor(() => expect(controller.recoverAllMock).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(capturedLifecycle?.getSnapshot().recovering).toBe(false))
      await vi.waitFor(() => expect(capturedLifecycle?.getSnapshot().recoveredScopeKeys)
        .toHaveLength(1))
    }
  })
  return { store, controller, flushedCommands }
}

function emitProjection(controller: FakeController) {
  act(() => controller.callbacks?.onProjectionPlan({
    taskId: task.id,
    runId: plan.runId,
    plan,
    suggestedActions: [],
  }))
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = container?.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function setTextValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Canvas V2 Task proposal review integration', () => {
  it('renders pending proposals inside the selected Task and derives settled keys from receipts', async () => {
    const { controller } = await renderHarness({
      document: canvasDocument('publish'),
    })
    emitProjection(controller)

    const taskContainer = required<HTMLElement>(`[data-task-id="${task.id}"]`)
    expect(taskContainer.querySelector('[data-testid="canvas-v2-proposal-review-panel"]'))
      .not.toBeNull()
    expect(taskContainer.querySelector('[data-proposal-key="prepare"]')).not.toBeNull()
    expect(taskContainer.querySelector('[data-proposal-key="explain"]')).not.toBeNull()
    expect(taskContainer.querySelector('[data-proposal-key="publish"]')).toBeNull()
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('dispatches an edited trusted acceptance, persists its receipt, then clears review', async () => {
    const { store, controller, flushedCommands } = await renderHarness()
    emitProjection(controller)
    expect(capturedLifecycle?.getSnapshot().projectionReviews).toHaveLength(1)
    setTextValue(
      required<HTMLInputElement>('[data-testid="proposal-title-explain"]'),
      '撰写结论',
    )
    setTextValue(
      required<HTMLTextAreaElement>('[data-testid="proposal-prompt-explain"]'),
      '根据数据撰写清晰结论。',
    )

    await act(async () => {
      required<HTMLButtonElement>('[data-testid="proposal-accept"]').click()
      await vi.waitFor(() => expect(capturedLifecycle?.getSnapshot().projectionReviews)
        .toHaveLength(0))
      await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('saved'))
    })

    expect(flushedCommands).toContainEqual({
      type: 'AcceptTaskProposals',
      plan,
      proposalKeys: ['prepare', 'explain', 'publish'],
      edits: {
        explain: {
          title: '撰写结论',
          prompt: '根据数据撰写清晰结论。',
        },
      },
    })
    expect(store.getSnapshot().document.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'proposal-acceptance', planId }),
    ]))
    expect(store.getSnapshot().document.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '撰写结论',
        goal: '根据数据撰写清晰结论。',
        origin: expect.objectContaining({ kind: 'agent-proposal', proposalKey: 'explain' }),
      }),
    ]))
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('dispatches DismissPlan for rejection and clears only after its receipt exists', async () => {
    const { store, controller, flushedCommands } = await renderHarness()
    emitProjection(controller)

    await act(async () => {
      required<HTMLButtonElement>('[data-testid="proposal-reject"]').click()
      await vi.waitFor(() => expect(capturedLifecycle?.getSnapshot().projectionReviews)
        .toHaveLength(0))
      await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('saved'))
    })

    expect(flushedCommands).toContainEqual({ type: 'DismissPlan', plan })
    expect(store.getSnapshot().document.receipts).toContainEqual({
      kind: 'plan-dismissal',
      planId,
      runId: plan.runId,
      taskId: task.id,
      proposalKeys: ['prepare', 'explain', 'publish'],
    })
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('keeps the review pending when daemon flush fails after optimistic acceptance', async () => {
    const { store, controller } = await renderHarness({ flushMode: 'error' })
    emitProjection(controller)

    await act(async () => {
      required<HTMLButtonElement>('[data-testid="proposal-accept"]').click()
      await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('error'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container?.querySelector('[data-testid="canvas-v2-proposal-review-panel"]'))
      .not.toBeNull()
    expect(capturedLifecycle?.getSnapshot().projectionReviews).toHaveLength(1)
    expect(required<HTMLElement>('[role="alert"]').textContent).toContain('daemon unavailable')
    expect(store.getSnapshot().envelope?.document.receipts).toEqual([])
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('keeps the review pending when the settlement loses daemon CAS', async () => {
    const { store, controller } = await renderHarness({ flushMode: 'conflict' })
    emitProjection(controller)

    await act(async () => {
      required<HTMLButtonElement>('[data-testid="proposal-reject"]').click()
      await vi.waitFor(() => expect(store.getSnapshot().commandSync.status).toBe('conflict'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container?.querySelector('[data-testid="canvas-v2-proposal-review-panel"]'))
      .not.toBeNull()
    expect(capturedLifecycle?.getSnapshot().projectionReviews).toHaveLength(1)
    expect(required<HTMLElement>('[role="alert"]').textContent)
      .toContain('Canvas revision changed')
    expect(store.getSnapshot().envelope?.document.receipts).toEqual([])
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('renders the selected Task safely without proposal or run controls when context is absent', async () => {
    await renderHarness({ withRunContext: false })

    expect(required(`[data-task-id="${task.id}"]`)).not.toBeNull()
    expect(container?.querySelector('[data-testid^="canvas-v2-task-proposal-review-"]'))
      .toBeNull()
    expect(container?.querySelector('[data-testid^="canvas-v2-task-run-panel-"]'))
      .toBeNull()
  })
})
