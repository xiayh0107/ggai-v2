// @vitest-environment jsdom
import { act, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskRunHttpClient, DaemonProjectionPlan } from '@/agent/taskRunHttpClient'
import { applyCanvasCommand, type CanvasCommand } from '@/canvas/commands'
import type {
  CanvasCommandOutbox,
  CanvasEnvelope,
} from '@/canvas/daemonClient'
import { emptyCanvasDocument, type CanvasDocument } from '@/canvas/model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
  type CanvasPersistenceScope,
} from '@/canvas/persistence'
import { CanvasProvider } from '@/canvas/provider'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import {
  CanvasTaskRunProvider,
  type CanvasTaskRunControllerFactoryInput,
  type CanvasTaskRunControllerLike,
  type CanvasTaskRunLifecycle,
} from '@/canvas/runProvider'
import type {
  CanvasRunTaskInput,
  CanvasTaskRunClose,
  CanvasTaskRunHandle,
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { selectTaskView } from '@/canvas/selectors'
import { CanvasStore } from '@/canvas/store'
import CanvasTaskGroup from './CanvasTaskGroup'

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
const plan: DaemonProjectionPlan = {
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
let mountedStore: CanvasStore | null = null
let capturedLifecycle: CanvasTaskRunLifecycle | null = null

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

function canvasDocument(settledProposalKey?: string): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.tasks.push(task)
  document.receipts.push({
    kind: 'materialization',
    planId,
    runId: plan.runId,
    taskId: task.id,
    outcomes: [],
    dismissedProposalKeys: settledProposalKey ? [settledProposalKey] : [],
  })
  return document
}

function envelope(document: CanvasDocument, revision: number): CanvasEnvelope {
  return {
    branch,
    revision,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMutationId: null,
    document: structuredClone(document),
  }
}

type FlushMode = 'success' | 'error' | 'conflict'

function makeStore(initialDocument: CanvasDocument, flushMode: FlushMode = 'success') {
  const persistenceScope: CanvasPersistenceScope = {
    daemonBaseUrl,
    projectDir,
    branch,
  }
  let serverDocument = structuredClone(initialDocument)
  let serverRevision = 7
  const flushedCommands: CanvasCommand[] = []
  const persistence = new CanvasPersistence<CanvasCommand>({
    adapter: new MemoryCanvasPersistenceAdapter(),
  })
  const store = new CanvasStore({
    daemonBaseUrl,
    scope: { projectDir, branch },
    persistence,
    client: {
      getCanvas: async () => envelope(serverDocument, serverRevision),
      flushOutbox: async (_scope, outbox: CanvasCommandOutbox) => {
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
          serverDocument = applyCanvasCommand(serverDocument, entry.command)
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

class FakeController implements CanvasTaskRunControllerLike {
  callbacks: CanvasTaskRunControllerFactoryInput | null = null
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasTaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasRunTaskInput) => ({
    taskId: input.taskId,
    runId: 'run-unexpected',
    completion: new Promise<CanvasTaskRunClose>(() => undefined),
    detach: () => undefined,
  }))
  readonly cancelTaskMock = vi.fn(async (
    taskId: string,
  ): Promise<CanvasTaskRunClose | null> => {
    void taskId
    return null
  })
  readonly disposeMock = vi.fn()

  readonly factory = (input: CanvasTaskRunControllerFactoryInput) => {
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

  getRunLog(runId: string): readonly CanvasTaskRunLogEntry[] {
    void runId
    return []
  }

  async readTaskRunSummary(runId: string): Promise<CanvasTaskRunSummary> {
    return {
      runId,
      taskId: task.id,
      agentId: 'codex',
      canvasBranch: branch,
      status: 'done',
      startedAt: 1,
    }
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

function daemonClient(): TaskRunHttpClient {
  return {
    resolvePermission: vi.fn(async () => undefined),
  } as unknown as TaskRunHttpClient
}

function LifecycleCapture() {
  const lifecycle = useContext(CanvasTaskRunContext)
  useEffect(() => {
    capturedLifecycle = lifecycle
    return () => {
      if (capturedLifecycle === lifecycle) capturedLifecycle = null
    }
  }, [lifecycle])
  return null
}

async function renderHarness(input: {
  document?: CanvasDocument
  withRunContext?: boolean
  flushMode?: FlushMode
  showRunPanel?: boolean
} = {}) {
  const initialDocument = input.document ?? canvasDocument()
  const { store, flushedCommands } = makeStore(initialDocument, input.flushMode)
  const controller = new FakeController()
  const view = selectTaskView(initialDocument, task.id, {
    zoom: 1,
    selected: true,
  })
  if (!view) throw new Error('Missing task view')
  const taskGroup = (
    <CanvasTaskGroup
      view={view}
      projectDir={projectDir}
      selectedTask
      showRunPanel={input.showRunPanel ?? true}
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
    <CanvasTaskRunProvider
      store={store}
      daemonClient={daemonClient()}
      controllerFactory={controller.factory}
    >
      <LifecycleCapture />
      {taskGroup}
    </CanvasTaskRunProvider>
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mountedStore = store
  await act(async () => root?.render(
    <CanvasProvider store={store}>{content}</CanvasProvider>,
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

describe('Canvas Task proposal review integration', () => {
  it('renders pending proposals inside the selected Task and derives settled keys from receipts', async () => {
    const { controller } = await renderHarness({
      document: canvasDocument('publish'),
    })
    emitProjection(controller)

    const taskContainer = required<HTMLElement>(`[data-task-id="${task.id}"]`)
    expect(taskContainer.querySelector('[data-testid="canvas-proposal-review-panel"]'))
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

    expect(container?.querySelector('[data-testid="canvas-proposal-review-panel"]'))
      .not.toBeNull()
    expect(capturedLifecycle?.getSnapshot().projectionReviews).toHaveLength(1)
    expect(required<HTMLElement>('[role="alert"]').textContent).toContain('daemon unavailable')
    expect(store.getSnapshot().envelope?.document.receipts).toEqual([
      expect.objectContaining({ kind: 'materialization', planId }),
    ])
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

    expect(container?.querySelector('[data-testid="canvas-proposal-review-panel"]'))
      .not.toBeNull()
    expect(capturedLifecycle?.getSnapshot().projectionReviews).toHaveLength(1)
    expect(required<HTMLElement>('[role="alert"]').textContent)
      .toContain('Canvas revision changed')
    expect(store.getSnapshot().envelope?.document.receipts).toEqual([
      expect.objectContaining({ kind: 'materialization', planId }),
    ])
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })

  it('renders the selected Task safely without proposal or run controls when context is absent', async () => {
    await renderHarness({ withRunContext: false })

    expect(required(`[data-task-id="${task.id}"]`)).not.toBeNull()
    expect(container?.querySelector('[data-testid^="canvas-task-proposal-review-"]'))
      .toBeNull()
    expect(container?.querySelector('[data-testid^="canvas-task-run-panel-"]'))
      .toBeNull()
  })

  it('suppresses the Task run panel when a compound selection owns the context surface', async () => {
    await renderHarness({ showRunPanel: false })

    expect(required(`[data-task-id="${task.id}"]`)).not.toBeNull()
    expect(container?.querySelector('[data-testid^="canvas-task-run-panel-"]'))
      .toBeNull()
  })
})
