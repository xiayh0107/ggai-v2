// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  DaemonClient,
  DaemonProjectionOutputV2,
  DaemonProjectionPlanV2,
} from '@/agent/daemonClient'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from '@/canvas-v2/model'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
} from '@/canvas-v2/persistence'
import { CanvasV2Provider } from '@/canvas-v2/provider'
import {
  CanvasV2TaskRunProvider,
  type CanvasV2TaskRunControllerFactoryInput,
  type CanvasV2TaskRunControllerLike,
} from '@/canvas-v2/runProvider'
import type {
  CanvasV2RunTaskInput,
  CanvasV2TaskRunClose,
  CanvasV2TaskRunHandle,
  CanvasV2TaskRunLogEntry,
  CanvasV2TaskRunSummary,
} from '@/canvas-v2/runController'
import { CanvasV2Store } from '@/canvas-v2/store'
import { taskComposerDraftKeyV2 } from '@/canvas-v2/taskRunUi'
import CanvasV2TaskRunPanel from './CanvasV2TaskRunPanel'

const task = {
  id: 'task-1',
  title: '散点图任务',
  goal: '生成一个散点图',
  anchor: { x: 20, y: 30 },
  origin: { kind: 'user' as const },
}
const projectDir = '/workspace/project'
const branch = 'main'
const artifactId = `artifact_${'a'.repeat(64)}`
const planId = `plan_${'b'.repeat(64)}`

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
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function canvasDocument(withOutput = false): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.everCreated = true
  document.tasks.push(task)
  if (withOutput) {
    document.nodes.push({
      id: 'node-1',
      type: 'image',
      frame: { x: 60, y: 120, w: 400, h: 256, z: 1 },
      title: '已有散点图',
      artifactRefs: [{ runId: 'run-old', artifactId }],
      homeTaskId: task.id,
      origin: { kind: 'user' },
    })
  }
  return document
}

function makeStore(document = canvasDocument()): CanvasV2Store {
  return new CanvasV2Store({
    daemonBaseUrl: 'http://127.0.0.1:7380',
    scope: { projectDir, branch },
    persistence: new CanvasV2Persistence({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
    }),
    client: {
      getCanvas: async () => ({
        branch,
        revision: 7,
        updatedAt: '2026-08-05T00:00:00.000Z',
        lastMutationId: null,
        document,
      }),
      flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
    },
  })
}

class FakeController implements CanvasV2TaskRunControllerLike {
  callbacks: CanvasV2TaskRunControllerFactoryInput | null = null
  callbackInstances: CanvasV2TaskRunControllerFactoryInput[] = []
  logs: CanvasV2TaskRunLogEntry[] = []
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasV2TaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasV2RunTaskInput) =>
    pendingHandle(input.taskId, 'run-started'))
  readonly cancelTaskMock = vi.fn(async (
    taskId: string,
  ): Promise<CanvasV2TaskRunClose | null> => {
    void taskId
    return null
  })
  readonly disposeMock = vi.fn()

  readonly factory = (input: CanvasV2TaskRunControllerFactoryInput) => {
    this.callbacks = input
    this.callbackInstances.push(input)
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
    return this.logs
  }

  async readTaskRunSummary(runId: string): Promise<CanvasV2TaskRunSummary> {
    return {
      runId,
      taskId: task.id,
      agentId: 'codex',
      canvasBranch: branch,
      status: 'done',
      startedAt: 1,
    }
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

function daemonClient() {
  return {
    resolvePermission: vi.fn(async () => undefined),
  } as unknown as DaemonClient
}

async function renderHarness(input: {
  store?: CanvasV2Store
  controller?: FakeController
  daemon?: DaemonClient
  strict?: boolean
} = {}) {
  const store = input.store ?? makeStore()
  const controller = input.controller ?? new FakeController()
  const daemon = input.daemon ?? daemonClient()
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
        <CanvasV2TaskRunPanel task={task} />
      </CanvasV2TaskRunProvider>
    </CanvasV2Provider>
  )
  await act(async () => {
    root?.render(input.strict ? <StrictMode>{tree}</StrictMode> : tree)
  })
  await act(async () => {
    await vi.waitFor(() => expect(store.getSnapshot().hydration.status).toBe('ready'))
    await vi.waitFor(() => expect(controller.recoverAllMock).toHaveBeenCalledTimes(1))
  })
  return { store, controller, daemon, host: required(container, 'aside') }
}

function projectionPlan(
  output: DaemonProjectionOutputV2,
): DaemonProjectionPlanV2 {
  return {
    schemaVersion: 2,
    planId,
    runId: 'run-finished',
    taskId: task.id,
    status: 'complete',
    manifestDigest: 'c'.repeat(64),
    outputs: [output],
    taskProposals: [{
      key: 'follow-up',
      title: '不应由运行面板呈现的任务 proposal',
      prompt: '创建后续任务',
      inputOutputKeys: [output.key],
      dependsOn: [],
    }],
    warnings: [],
    digest: 'd'.repeat(64),
  }
}

function emitProjection(
  controller: FakeController,
  output: DaemonProjectionOutputV2,
  suggestedActions = [{
    id: 'recolor',
    label: '调整配色',
    prompt: '把散点图调整为蓝绿色配色。',
  }],
) {
  act(() => controller.callbackInstances.forEach((callbacks) => callbacks.onProjectionPlan({
    taskId: task.id,
    runId: 'run-finished',
    plan: projectionPlan(output),
    suggestedActions,
  })))
}

function required<ElementType extends Element>(
  host: ParentNode | null,
  selector: string,
): ElementType {
  const element = host?.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function trayOutput(overrides: Partial<DaemonProjectionOutputV2> = {}): DaemonProjectionOutputV2 {
  return {
    key: 'source',
    pluginId: 'code',
    role: 'auxiliary',
    title: '分析源码',
    artifactRefs: [{ runId: 'run-finished', artifactId }],
    derivedFrom: [],
    materialize: false,
    ...overrides,
  }
}

describe('Canvas V2 Task Run panel', () => {
  it('keeps suggested actions as branch-local drafts and never auto-runs under StrictMode', async () => {
    const { store, controller, host } = await renderHarness({ strict: true })
    const beforeDocument = structuredClone(store.getSnapshot().document)
    const composer = required<HTMLTextAreaElement>(host, 'textarea')
    act(() => composer.focus())
    emitProjection(controller, trayOutput())
    expect(document.activeElement).toBe(composer)
    expect(host.textContent).not.toContain('不应由运行面板呈现的任务 proposal')

    const suggestion = required<HTMLButtonElement>(host, '[aria-label*="调整配色"]')
    await act(async () => suggestion.click())

    expect(store.getSnapshot().view.composerDrafts[taskComposerDraftKeyV2(task.id)])
      .toBe('把散点图调整为蓝绿色配色。')
    expect(store.getSnapshot().document).toEqual(beforeDocument)
    expect(controller.runTaskMock).not.toHaveBeenCalled()
    expect(controller.recoverAllMock).toHaveBeenCalledTimes(1)
  })

  it('starts only from an explicit button and continues the same Task from the keyboard', async () => {
    const first = await renderHarness()
    const firstComposer = required<HTMLTextAreaElement>(first.host, 'textarea')
    act(() => setTextareaValue(firstComposer, '第一次运行提示'))
    await act(async () => required<HTMLButtonElement>(
      first.host,
      `[aria-label="开始任务${task.title}"]`,
    ).click())
    expect(first.controller.runTaskMock).toHaveBeenCalledWith({
      taskId: task.id,
      agentId: 'codex',
      prompt: '第一次运行提示',
    })
    expect(first.store.getSnapshot().view.composerDrafts[taskComposerDraftKeyV2(task.id)])
      .toBe('')

    act(() => root?.unmount())
    await act(async () => Promise.resolve())
    root = null
    container?.remove()
    container = null

    const continued = await renderHarness({ store: makeStore(canvasDocument(true)) })
    const composer = required<HTMLTextAreaElement>(continued.host, 'textarea')
    expect(required(continued.host, 'p').textContent).toContain('继续任务')
    act(() => setTextareaValue(composer, '继续调整标注'))
    await act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })))

    expect(continued.controller.runTaskMock).toHaveBeenCalledOnce()
    expect(continued.controller.runTaskMock).toHaveBeenCalledWith({
      taskId: task.id,
      agentId: 'codex',
      prompt: '继续调整标注',
    })
  })

  it('keeps cancellation pending until the durable close resolves', async () => {
    const controller = new FakeController()
    let resolveCancel!: (close: CanvasV2TaskRunClose) => void
    controller.cancelTaskMock.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveCancel = resolve }))
    const { store, host } = await renderHarness({ controller })
    act(() => store.setTaskRuntime({
      taskId: task.id,
      runId: 'run-active',
      phase: 'running',
      message: '正在生成图表',
      ghosts: [],
    }))

    await act(async () => required<HTMLButtonElement>(host, 'button').click())
    expect(host.textContent).toContain('等待取消完成')
    expect(controller.cancelTaskMock).toHaveBeenCalledWith(task.id)

    await act(async () => {
      resolveCancel({
        runId: 'run-active',
        status: 'cancelled',
        artifactsComplete: false,
      })
      await Promise.resolve()
    })
    expect(host.textContent).not.toContain('等待取消完成')
  })

  it('resolves allow and deny permission cards with an explicit remember choice', async () => {
    const daemon = daemonClient()
    const { controller, host } = await renderHarness({ daemon })
    act(() => {
      controller.callbacks?.onPermissionRequest({
        taskId: task.id,
        runId: 'run-active',
        permissionId: 'permission-write',
        action: '写入文件',
        detail: '创建 chart.png',
      })
      controller.callbacks?.onPermissionRequest({
        taskId: task.id,
        runId: 'run-active',
        permissionId: 'permission-shell',
        action: '运行命令',
        detail: '执行 Rscript',
      })
    })
    const cards = host.querySelectorAll<HTMLElement>('[aria-label="Agent 权限请求"]')
    expect(cards).toHaveLength(2)

    const remember = required<HTMLInputElement>(cards[0], 'input[type="checkbox"]')
    await act(async () => remember.click())
    await act(async () => [...cards[0].querySelectorAll('button')]
      .find((button) => button.textContent === '允许')?.click())
    expect(daemon.resolvePermission).toHaveBeenCalledWith('permission-write', {
      decision: 'allow',
      remember: true,
    })

    const remaining = required<HTMLElement>(host, '[aria-label="Agent 权限请求"]')
    await act(async () => [...remaining.querySelectorAll('button')]
      .find((button) => button.textContent === '拒绝')?.click())
    expect(daemon.resolvePermission).toHaveBeenCalledWith('permission-shell', {
      decision: 'deny',
      remember: false,
    })
  })

  it('shows non-fatal errors without unmounting the composer', async () => {
    const controller = new FakeController()
    controller.runTaskMock.mockRejectedValueOnce(new Error('daemon unavailable'))
    const { host } = await renderHarness({ controller })
    const composer = required<HTMLTextAreaElement>(host, 'textarea')
    act(() => setTextareaValue(composer, '运行失败也保留草稿'))
    await act(async () => required<HTMLButtonElement>(host, '[type="submit"]').click())

    expect(required<HTMLElement>(host, '[role="alert"]').textContent)
      .toContain('daemon unavailable')
    expect(required<HTMLTextAreaElement>(host, 'textarea').value)
      .toBe('运行失败也保留草稿')
    await act(async () => required<HTMLButtonElement>(host, '[aria-label="关闭运行错误"]').click())
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('expands an accessible bounded log without promoting log events to nodes', async () => {
    const controller = new FakeController()
    controller.logs = Array.from({ length: 205 }, (_, index) => ({
      eventId: index + 1,
      kind: index % 2 ? 'tool' as const : 'thinking' as const,
      text: `entry-${index + 1}`,
    }))
    const { store, host } = await renderHarness({ controller })
    const beforeNodeCount = store.getSnapshot().document.nodes.length
    act(() => store.setTaskRuntime({
      taskId: task.id,
      runId: 'run-log',
      phase: 'running',
      ghosts: [],
    }))
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('运行日志'))
    if (!toggle) throw new Error('Missing log toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle.click())

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(required(host, '[role="log"]').querySelectorAll('li')).toHaveLength(200)
    const entries = required(host, '[role="log"]').querySelectorAll('li')
    expect(entries[0]?.textContent).toContain('entry-6')
    expect(entries[entries.length - 1]?.textContent).toContain('entry-205')
    expect(store.getSnapshot().document.nodes).toHaveLength(beforeNodeCount)
  })

  it('uses only run-owned artifact URLs for unmaterialized tray outputs', async () => {
    const { controller, host } = await renderHarness()
    const output = {
      ...trayOutput({
        artifactRefs: [{ runId: 'run/safe', artifactId: 'artifact/../../secret' }],
      }),
      path: '../../foreign-run/secret.txt',
    }
    emitProjection(controller, output)

    const link = required<HTMLAnchorElement>(host, '[aria-label="未上画布的产物"] a')
    const url = new URL(link.href)
    expect(url.pathname).toBe('/runs/run%2Fsafe/artifacts/artifact%2F..%2F..%2Fsecret')
    expect(url.searchParams.get('projectDir')).toBe(projectDir)
    expect(url.searchParams.has('path')).toBe(false)
    expect(host.textContent).not.toContain('../../foreign-run/secret.txt')
    expect(controller.runTaskMock).not.toHaveBeenCalled()
  })
})
