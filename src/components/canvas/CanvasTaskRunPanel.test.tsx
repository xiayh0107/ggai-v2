// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskRunPreflightApi } from '@/agent/taskRunPreflightClient'
import type {
  TaskRunHttpClient,
  DaemonProjectionOutput,
  DaemonProjectionPlan,
} from '@/agent/taskRunHttpClient'
import { emptyCanvasDocument, type CanvasDocument } from '@/canvas/model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
} from '@/canvas/persistence'
import { CanvasProvider } from '@/canvas/provider'
import {
  CanvasTaskRunProvider,
  type CanvasTaskRunControllerFactoryInput,
  type CanvasTaskRunControllerLike,
} from '@/canvas/runProvider'
import type {
  CanvasRunTaskInput,
  CanvasTaskRunClose,
  CanvasTaskRunHandle,
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { CanvasStore } from '@/canvas/store'
import { taskComposerDraftKey } from '@/canvas/taskRunUi'
import { CanvasWorkbenchControllerProvider } from '@/canvas/workbenchController'
import {
  CanvasRunLogViewerContext,
  type OpenCanvasRunLogViewer,
} from '@/canvas/runLogViewerContext'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import type { SkillAssetApi } from '@/skills/client'
import CanvasTaskRunPanel from './CanvasTaskRunPanel'
import CanvasWorkbench from './CanvasWorkbench'

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
const readyPreflightApi: TaskRunPreflightApi = {
  check: async () => ({ status: 'ready', issues: [] }),
}

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

function canvasDocument(withOutput = false): CanvasDocument {
  const document = emptyCanvasDocument()
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

function makeStore(document = canvasDocument()): CanvasStore {
  return new CanvasStore({
    daemonBaseUrl: 'http://127.0.0.1:7380',
    scope: { projectDir, branch },
    persistence: new CanvasPersistence({
      adapter: new MemoryCanvasPersistenceAdapter(),
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

class FakeController implements CanvasTaskRunControllerLike {
  callbacks: CanvasTaskRunControllerFactoryInput | null = null
  callbackInstances: CanvasTaskRunControllerFactoryInput[] = []
  logs: CanvasTaskRunLogEntry[] = []
  readonly recoverAllMock = vi.fn(async (): Promise<CanvasTaskRunHandle[]> => [])
  readonly runTaskMock = vi.fn(async (input: CanvasRunTaskInput) =>
    pendingHandle(input.taskId, 'run-started'))
  readonly cancelTaskMock = vi.fn(async (
    taskId: string,
  ): Promise<CanvasTaskRunClose | null> => {
    void taskId
    return null
  })
  readonly disposeMock = vi.fn()

  readonly factory = (input: CanvasTaskRunControllerFactoryInput) => {
    this.callbacks = input
    this.callbackInstances.push(input)
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
    return this.logs
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

function pendingHandle(taskId: string, runId: string): CanvasTaskRunHandle {
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
  } as unknown as TaskRunHttpClient
}

async function renderHarness(input: {
  store?: CanvasStore
  controller?: FakeController
  daemon?: TaskRunHttpClient
  strict?: boolean
  openRunLogViewer?: OpenCanvasRunLogViewer
  preflightApi?: TaskRunPreflightApi
  artifactCatalogApi?: Pick<ProjectArtifactCatalogApi, 'list'>
  skillApi?: SkillAssetApi
} = {}) {
  const store = input.store ?? makeStore()
  const controller = input.controller ?? new FakeController()
  const daemon = input.daemon ?? daemonClient()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const artifactCatalogApi = input.artifactCatalogApi ?? {
    list: async () => ({
      schemaVersion: 2 as const,
      artifacts: [],
      truncated: false,
      partial: false,
      nextCursor: null,
    }),
  }
  const runSurface = (
    <CanvasTaskRunProvider
      store={store}
      daemonClient={daemon}
      controllerFactory={controller.factory}
    >
      <CanvasTaskRunPanel
        task={task}
        preflightApi={input.preflightApi ?? readyPreflightApi}
        artifactCatalogApi={artifactCatalogApi}
      />
      {input.skillApi && (
        <CanvasWorkbench
          projectId="test-project"
          artifactApi={{ ...artifactCatalogApi, artifactUrl: () => 'about:blank' }}
          skillApi={input.skillApi}
          onOpenHistory={() => undefined}
        />
      )}
    </CanvasTaskRunProvider>
  )
  const panel = (
    <CanvasProvider store={store}>
      {input.skillApi ? (
        <MemoryRouter>
          <CanvasWorkbenchControllerProvider skillApi={input.skillApi}>
            {runSurface}
          </CanvasWorkbenchControllerProvider>
        </MemoryRouter>
      ) : runSurface}
    </CanvasProvider>
  )
  const tree = input.openRunLogViewer
    ? (
        <CanvasRunLogViewerContext.Provider value={input.openRunLogViewer}>
          {panel}
        </CanvasRunLogViewerContext.Provider>
      )
    : panel
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
  output: DaemonProjectionOutput,
): DaemonProjectionPlan {
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
  output: DaemonProjectionOutput,
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

function trayOutput(overrides: Partial<DaemonProjectionOutput> = {}): DaemonProjectionOutput {
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

describe('Canvas Task Run panel', () => {
  it('blocks submission only for an explicit preflight issue and can retry', async () => {
    const check = vi.fn(async () => ({
      status: 'blocked' as const,
      issues: [{
        code: 'generation_service_unauthenticated' as const,
        message: '生成服务尚未登录，请完成登录后重试。',
        retryable: true,
      }],
    }))
    const { host } = await renderHarness({ preflightApi: { check } })

    await vi.waitFor(() => expect(host.getAttribute('data-preflight-status')).toBe('blocked'))
    const notice = required<HTMLElement>(host, '[data-testid="canvas-generation-preflight-notice"]')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('生成服务尚未登录')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(required<HTMLButtonElement>(host, `[aria-label="开始任务${task.title}"]`).disabled)
      .toBe(true)

    await act(async () => required<HTMLButtonElement>(notice, 'button').click())
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2))
  })

  it('keeps submission available when advisory preflight cannot be reached', async () => {
    const check = vi.fn(async () => {
      throw new Error('daemon unavailable')
    })
    const { controller, host } = await renderHarness({ preflightApi: { check } })

    await vi.waitFor(() => expect(host.getAttribute('data-preflight-status')).toBe('error'))
    expect(required<HTMLElement>(host, '[data-testid="canvas-generation-preflight-notice"]')
      .getAttribute('role')).toBe('status')
    const submit = required<HTMLButtonElement>(host, `[aria-label="开始任务${task.title}"]`)
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(controller.runTaskMock).toHaveBeenCalledOnce()
  })

  it('forwards only verified artifact identity through preflight and Run intent', async () => {
    const artifact: ProjectArtifactResource = {
      runId: 'run-reference',
      artifactId,
      taskId: 'task-reference',
      canvasBranch: branch,
      relativePath: 'images/reference.png',
      mediaType: 'image/png',
      size: 2_048,
      contentDigest: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
    }
    const list = vi.fn(async () => ({
      schemaVersion: 2 as const,
      artifacts: [artifact],
      truncated: false,
      partial: false,
      nextCursor: null,
    }))
    const check = vi.fn<TaskRunPreflightApi['check']>(
      async () => ({ status: 'ready', issues: [] }),
    )
    const { controller, host } = await renderHarness({
      artifactCatalogApi: { list },
      preflightApi: { check },
    })

    await act(async () => required<HTMLButtonElement>(host, '[aria-label="添加附件"]').click())
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    const picker = required<HTMLElement>(document.body, '[role="dialog"][aria-label="添加附件"]')
    await vi.waitFor(() => expect(picker.textContent).toContain('reference.png'))
    await act(async () => required<HTMLButtonElement>(picker, '[role="checkbox"]').click())

    expect(required(host, '[aria-label="已添加附件"]').textContent).toContain('reference.png')
    await vi.waitFor(() => expect(check.mock.calls.some(([input]) =>
      input.attachments?.some((attachment) => attachment.kind === 'artifact'
        && attachment.runId === artifact.runId
        && attachment.artifactId === artifact.artifactId))).toBe(true))
    await vi.waitFor(() => expect(host.getAttribute('data-preflight-status')).toBe('ready'))

    await act(async () => required<HTMLButtonElement>(
      host,
      `[aria-label="开始任务${task.title}"]`,
    ).click())
    expect(controller.runTaskMock).toHaveBeenCalledWith({
      taskId: task.id,
      agentId: 'codex',
      attachments: [{
        kind: 'artifact',
        runId: artifact.runId,
        artifactId: artifact.artifactId,
      }],
    })
  })

  it('opens the existing Node Skills workbench from the effective Skills summary', async () => {
    const skillRef = {
      skillId: 'figure-layout',
      revision: 2,
      digest: 'c'.repeat(64),
    }
    const list = vi.fn(async () => ({
      schemaVersion: 1 as const,
      assets: [{
        schemaVersion: 1 as const,
        ...skillRef,
        title: '科研图形布局',
        description: '保持图形层级清晰。',
        entrypoint: 'SKILL.md' as const,
        fileCount: 2,
        totalBytes: 4_096,
        importedAt: '2026-08-16T00:00:00.000Z',
        archived: false,
      }],
      typeBindings: [{
        schemaVersion: 1 as const,
        nodeType: 'image',
        revision: 3,
        skills: [skillRef],
        updatedAt: '2026-08-16T00:00:00.000Z',
      }],
    }))
    const skillApi = {
      list,
      import: vi.fn(),
      archive: vi.fn(),
      updateTypeBindings: vi.fn(),
    } as unknown as SkillAssetApi
    const { store, host } = await renderHarness({
      store: makeStore(canvasDocument(true)),
      skillApi,
    })

    const summary = await vi.waitFor(() => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-task-skills-summary"]',
    ))
    expect(summary.textContent).toContain('Skills 1')
    await act(async () => summary.click())

    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'node', id: 'node-1' }])
    expect(required(container, '[aria-label="节点 Skills"]')).not.toBeNull()
    await vi.waitFor(() => expect(required(container, '[aria-label="可用 Skills"]').textContent)
      .toContain('科研图形布局'))
  })

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

    expect(store.getSnapshot().view.composerDrafts[taskComposerDraftKey(task.id)])
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
    expect(first.store.getSnapshot().view.composerDrafts[taskComposerDraftKey(task.id)])
      .toBe('')

    act(() => root?.unmount())
    await act(async () => Promise.resolve())
    root = null
    container?.remove()
    container = null

    const continued = await renderHarness({ store: makeStore(canvasDocument(true)) })
    const composer = required<HTMLTextAreaElement>(continued.host, 'textarea')
    expect(required(
      continued.host,
      `[aria-label="继续任务${task.title}"]`,
    )).toBeTruthy()
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
    let resolveCancel!: (close: CanvasTaskRunClose) => void
    controller.cancelTaskMock.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveCancel = resolve }))
    const { store, host } = await renderHarness({ controller })
    const promptControl = required(host, '[data-testid="canvas-prompt-control"]')
    const composerSurface = required(host, '[data-testid="canvas-prompt-control-surface"]')
    const composerFooter = required(host, '[data-testid="canvas-prompt-control-footer"]')
    const composer = required<HTMLTextAreaElement>(host, 'textarea')
    const primaryAction = required<HTMLButtonElement>(
      host,
      `[aria-label="开始任务${task.title}"]`,
    )
    expect(promptControl.getAttribute('data-mode')).toBe('draft')
    act(() => store.setTaskRuntime({
      taskId: task.id,
      runId: 'run-active',
      phase: 'running',
      message: '正在生成图表',
      ghosts: [],
    }))

    expect(required(host, '[data-testid="canvas-prompt-control"]')).toBe(promptControl)
    expect(promptControl.getAttribute('data-mode')).toBe('running')
    expect(required(host, '[data-testid="canvas-prompt-control-surface"]'))
      .toBe(composerSurface)
    expect(required<HTMLTextAreaElement>(host, 'textarea')).toBe(composer)
    expect(required(host, '[data-testid="canvas-prompt-control-footer"]')).toBe(composerFooter)
    expect(required<HTMLButtonElement>(host, '[aria-label="取消运行"]')).toBe(primaryAction)
    expect(composer.value).toBe(task.goal)
    expect(composer.readOnly).toBe(true)
    expect(composer.disabled).toBe(false)
    expect(host.textContent).not.toContain('运行日志 · 0')
    expect(host.textContent).toContain('正在生成图表')
    expect(host.textContent).not.toContain('生成中')
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(primaryAction.querySelector('.animate-spin')).toBeNull()

    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="取消运行"]',
    ).click())
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
    expect(required(host, '[data-testid="canvas-prompt-control-surface"]'))
      .toBe(composerSurface)
    act(() => store.setTaskRuntime({
      taskId: task.id,
      runId: 'run-active',
      phase: 'cancelled',
      ghosts: [],
    }))
    expect(promptControl.getAttribute('data-mode')).toBe('draft')
    expect(required<HTMLTextAreaElement>(host, 'textarea')).toBe(composer)
    expect(composer.readOnly).toBe(false)
    expect(composer.placeholder).toBe(task.goal)
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
    const openRunLogViewer = vi.fn()
    controller.logs = Array.from({ length: 205 }, (_, index) => ({
      eventId: index + 1,
      kind: index % 2 ? 'tool' as const : 'thinking' as const,
      text: `entry-${index + 1}`,
    }))
    const { store, host } = await renderHarness({ controller, openRunLogViewer })
    const beforeNodeCount = store.getSnapshot().document.nodes.length
    act(() => store.setTaskRuntime({
      taskId: task.id,
      runId: 'run-log',
      phase: 'running',
      ghosts: [],
    }))
    const toggle = required<HTMLButtonElement>(host, '[aria-label="展开运行日志"]')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle.click())

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('收起运行日志')
    expect(required(host, '[role="log"]').querySelectorAll('li')).toHaveLength(200)
    const entries = required(host, '[role="log"]').querySelectorAll('li')
    expect(entries[0]?.textContent).toContain('entry-6')
    expect(entries[entries.length - 1]?.textContent).toContain('entry-205')
    expect(store.getSnapshot().document.nodes).toHaveLength(beforeNodeCount)

    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="在侧边大窗查看运行日志"]',
    ).click())
    expect(openRunLogViewer).toHaveBeenCalledWith({
      runId: 'run-log',
      title: task.title,
      initialTab: 'log',
    })
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
