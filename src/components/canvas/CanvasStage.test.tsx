// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCanvasCommand } from '@/canvas/commands'
import { TASK_OUTPUT_LAYOUT, taskOutputFrame } from '@/canvas/layout'
import { emptyCanvasDocument, type CanvasDocument } from '@/canvas/model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
  type CanvasViewState,
} from '@/canvas/persistence'
import { CanvasProvider } from '@/canvas/provider'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type {
  CanvasTaskRunLifecycle,
  CanvasTaskRunLifecycleSnapshot,
} from '@/canvas/runProvider'
import { CanvasStore } from '@/canvas/store'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import CanvasStage from './CanvasStage'

const daemonBaseUrl = 'http://127.0.0.1:7380'
const scope = { projectDir: '/workspace/project', branch: 'main' }
const planId = `plan_${'a'.repeat(64)}`
const artifactId = `artifact_${'b'.repeat(64)}`

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  registerBuiltinPlugins()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function fixtureDocument(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.tasks.push(
    {
      id: 'task-empty',
      title: '空任务',
      goal: '生成一个完整的研究摘要',
      anchor: { x: 40, y: 40 },
      origin: { kind: 'user' },
    },
    {
      id: 'task-single',
      title: '单产物',
      goal: '生成一段说明',
      anchor: { x: 560, y: 40 },
      origin: { kind: 'user' },
    },
    {
      id: 'task-multi',
      title: '多产物',
      goal: '生成图像和源代码',
      anchor: { x: 40, y: 480 },
      origin: { kind: 'user' },
    },
  )
  const singleFrame = taskOutputFrame(document.tasks[1].anchor, 0)
  const firstMultiFrame = taskOutputFrame(document.tasks[2].anchor, 0)
  const secondMultiFrame = taskOutputFrame(document.tasks[2].anchor, 1)
  document.nodes.push(
    {
      id: 'node-single',
      type: 'text',
      frame: { ...singleFrame, z: 1 },
      title: '说明文字',
      text: '这是单产物任务的内容。',
      artifactRefs: [],
      homeTaskId: 'task-single',
      origin: { kind: 'user' },
    },
    {
      id: 'node-image',
      type: 'image',
      frame: { ...firstMultiFrame, z: 2 },
      title: '结果预览',
      artifactRefs: [{ runId: 'run-multi', artifactId }],
      homeTaskId: 'task-multi',
      origin: {
        kind: 'agent-output',
        taskId: 'task-multi',
        runId: 'run-multi',
        planId,
        outputKey: 'preview',
      },
    },
    {
      id: 'node-code',
      type: 'code',
      frame: { ...secondMultiFrame, z: 3 },
      title: '分析代码',
      text: 'plot(x, y)',
      artifactRefs: [],
      homeTaskId: 'task-multi',
      origin: {
        kind: 'agent-output',
        taskId: 'task-multi',
        runId: 'run-multi',
        planId,
        outputKey: 'source',
      },
    },
    {
      id: 'node-top',
      type: 'pdf',
      frame: { x: 1040, y: 80, w: 300, h: 180, z: 4 },
      title: '独立资料',
      artifactRefs: [],
      origin: { kind: 'user' },
    },
  )
  document.receipts.push({
    kind: 'materialization',
    planId,
    runId: 'run-multi',
    taskId: 'task-multi',
    outcomes: [
      { outputKey: 'preview', nodeId: 'node-image' },
      { outputKey: 'source', nodeId: 'node-code' },
    ],
    dismissedProposalKeys: [],
  })
  return document
}

function collectionFixture(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.collections.push({
    id: 'collection-1',
    title: '研究集合',
    anchor: { x: 20, y: 20 },
  })
  document.tasks.push(
    {
      id: 'task-a',
      title: '集合任务',
      goal: '分析集合内容',
      anchor: { x: 80, y: 100 },
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    },
    {
      id: 'task-b',
      title: '目标任务',
      goal: '接收引用',
      anchor: { x: 980, y: 120 },
      origin: { kind: 'user' },
    },
  )
  document.nodes.push(
    {
      id: 'node-a',
      type: 'text',
      frame: { x: 500, y: 120, w: 300, h: 180, z: 1 },
      title: '集合节点',
      text: '顶层集合成员',
      artifactRefs: [],
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    },
    {
      id: 'node-child',
      type: 'code',
      frame: { x: 120, y: 300, w: 300, h: 180, z: 2 },
      title: '任务内部节点',
      text: 'summary(data)',
      artifactRefs: [],
      homeTaskId: 'task-a',
      origin: { kind: 'user' },
    },
  )
  document.edges.push(
    {
      id: 'edge-task',
      from: { kind: 'task', id: 'task-a' },
      to: { kind: 'task', id: 'task-b' },
      relation: 'references',
      contextRole: 'full',
      origin: { kind: 'user' },
    },
    {
      id: 'edge-node',
      from: { kind: 'node', id: 'node-a' },
      to: { kind: 'task', id: 'task-b' },
      relation: 'references',
      contextRole: 'full',
      origin: { kind: 'user' },
    },
    {
      id: 'edge-child',
      from: { kind: 'node', id: 'node-child' },
      to: { kind: 'task', id: 'task-b' },
      relation: 'references',
      contextRole: 'full',
      origin: { kind: 'user' },
    },
  )
  return document
}

function oversizedCollectionMacroFixture(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.collections.push(
    { id: 'collection-left', title: '左侧集合', anchor: { x: 20, y: 20 } },
    { id: 'collection-right', title: '右侧集合', anchor: { x: 1_100, y: 20 } },
  )
  for (let index = 0; index < 23; index += 1) {
    document.nodes.push({
      id: `left-${index}`,
      type: 'text',
      frame: { x: 60 + index * 8, y: 100 + index * 8, w: 160, h: 90, z: index },
      title: `左 ${index}`,
      artifactRefs: [],
      collectionId: 'collection-left',
      origin: { kind: 'user' },
    })
  }
  for (let index = 0; index < 22; index += 1) {
    document.nodes.push({
      id: `right-${index}`,
      type: 'text',
      frame: { x: 1_140 + index * 8, y: 100 + index * 8, w: 160, h: 90, z: 30 + index },
      title: `右 ${index}`,
      artifactRefs: [],
      collectionId: 'collection-right',
      origin: { kind: 'user' },
    })
  }
  return document
}

async function createSubject(
  view?: Partial<CanvasViewState>,
  canvasDocument = fixtureDocument(),
  reloadDocument?: CanvasDocument,
  lifecycle?: CanvasTaskRunLifecycle,
) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    schemaVersion: 2,
    runId: 'run-multi',
    artifactId,
    mediaType: 'image/png',
    size: 42,
    contentDigest: 'c'.repeat(64),
  }), { headers: { 'Content-Type': 'application/json' } })))
  const persistence = new CanvasPersistence({
    adapter: new MemoryCanvasPersistenceAdapter(),
  })
  if (view) {
    await persistence.writeViewState({ daemonBaseUrl, ...scope }, {
      camera: { x: 17, y: 23, zoom: 1 },
      selection: [],
      collapsedTaskIds: [],
      collapsedCollectionIds: [],
      composerDrafts: {},
      ...view,
    })
  }
  let serverDocument = structuredClone(canvasDocument)
  let serverRevision = 0
  let canvasReads = 0
  const store = new CanvasStore({
    daemonBaseUrl,
    scope,
    persistence,
    client: {
      getCanvas: async () => {
        const document = canvasReads++ === 0
          ? canvasDocument
          : reloadDocument ?? canvasDocument
        serverDocument = structuredClone(document)
        return {
          branch: 'main',
          revision: serverRevision,
          updatedAt: '2026-08-05T00:00:00.000Z',
          lastMutationId: null,
          document,
        }
      },
      flushOutbox: async (_scope, outbox) => {
        const entries = await outbox.list({ daemonBaseUrl, ...scope })
        for (const entry of entries) {
          serverDocument = applyCanvasCommand(serverDocument, entry.command)
          serverRevision += 1
          await outbox.ack({ daemonBaseUrl, ...scope }, entry.mutationId)
        }
        return {
          status: 'flushed',
          acknowledged: entries.length,
          envelope: {
            branch: 'main',
            revision: serverRevision,
            updatedAt: '2026-08-05T00:00:00.000Z',
            lastMutationId: entries.at(-1)?.mutationId ?? null,
            document: structuredClone(serverDocument),
          },
        }
      },
    },
  })
  await store.load()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 50,
    y: 20,
    left: 50,
    top: 20,
    right: 1050,
    bottom: 820,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  })
  await act(async () => {
    root?.render(
      <CanvasProvider store={store}>
        {lifecycle ? (
          <CanvasTaskRunContext.Provider value={lifecycle}>
            <CanvasStage />
          </CanvasTaskRunContext.Provider>
        ) : <CanvasStage />}
      </CanvasProvider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return { store, host: container }
}

function testTaskRunLifecycle(): CanvasTaskRunLifecycle {
  const snapshot: CanvasTaskRunLifecycleSnapshot = {
    recovering: false,
    recoveredScopeKeys: [],
    pendingPermissions: [],
    projectionReviews: [],
    nonFatalErrors: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getProjectionReviewForTask: () => null,
    getSuggestedActions: () => [],
    getRunLog: () => [],
    readTaskRunSummary: vi.fn(async (runId: string) => ({
      runId,
      taskId: 'task-multi',
      agentId: 'codex',
      canvasBranch: 'main',
      prompt: '生成一张结果预览',
      status: 'done' as const,
      startedAt: 1_700_000_000_000,
    })),
    startTask: vi.fn(),
    continueTask: vi.fn(),
    cancelTask: vi.fn(),
    clearNonFatalError: vi.fn(),
  } as unknown as CanvasTaskRunLifecycle
}

function required<ElementType extends Element>(host: ParentNode, selector: string): ElementType {
  const element = host.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  options: MouseEventInit & { pointerId?: number } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...options })
  Object.defineProperty(event, 'pointerId', { value: options.pointerId ?? 1 })
  target.dispatchEvent(event)
  return event
}

describe('Canvas interactive stage', () => {
  it('opens the create menu on blank-canvas double click without selecting menu text', async () => {
    const { host } = await createSubject(undefined, emptyCanvasDocument())
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges,
    } as unknown as Selection)
    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    const event = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: 420,
      clientY: 320,
    })

    await act(async () => stage.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(removeAllRanges).toHaveBeenCalledOnce()
    const menu = required<HTMLElement>(host, '[data-create-node-menu]')
    expect(menu.classList.contains('select-none')).toBe(true)
    expect(menu.textContent).toContain('创建节点')
  })

  it('renders each task container form, run-owned artifacts, collapse summaries, and ghosts', async () => {
    const { store, host } = await createSubject({ camera: { x: 17, y: 23, zoom: 1 } })

    expect(required(host, '[data-testid="canvas-world"]').getAttribute('style'))
      .toContain('translate(17px, 23px) scale(1)')
    expect(required(host, '[data-task-id="task-empty"]').getAttribute('data-container-kind'))
      .toBe('task-card')
    expect(required(host, '[data-task-id="task-single"]').getAttribute('data-container-kind'))
      .toBe('title-strip')
    const multi = required<HTMLElement>(host, '[data-task-id="task-multi"]')
    expect(multi.getAttribute('data-container-kind')).toBe('output-frame')
    expect(multi.getAttribute('aria-label')).toContain('2 个产物节点')

    const image = required<HTMLImageElement>(multi, 'img')
    const imageUrl = new URL(image.src)
    expect(imageUrl.pathname).toBe(`/runs/run-multi/artifacts/${artifactId}`)
    expect(imageUrl.searchParams.get('projectDir')).toBe(scope.projectDir)

    const collapse = required<HTMLButtonElement>(multi, '[aria-label="折叠任务多产物"]')
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    await act(async () => collapse.click())
    const collapsed = required<HTMLElement>(host, '[data-task-id="task-multi"]')
    expect(collapsed.getAttribute('data-presentation')).toBe('collapsed')
    expect(collapsed.textContent).toContain('2 个产物')
    expect(collapsed.querySelector('[data-node-id="node-image"]')).toBeNull()
    expect(required(collapsed, '[aria-label="展开任务多产物"]').getAttribute('aria-expanded'))
      .toBe('false')

    act(() => {
      store.setTaskRuntime({
        taskId: 'task-empty',
        runId: 'run-empty',
        phase: 'running',
        message: '正在生成预览',
        ghosts: [{
          key: 'preview',
          title: '预览图',
          pluginId: 'image',
          phase: 'writing',
          progress: 0.4,
        }],
      })
    })
    const ghost = required<HTMLElement>(host, '[data-ghost-key="preview"]')
    expect(ghost.getAttribute('data-ghost-phase')).toBe('writing')
    expect(required<HTMLElement>(ghost, '[data-testid="canvas-ghost-generating-surface"]'))
      .not.toBeNull()
    expect(required<HTMLElement>(ghost, '[data-testid="canvas-ghost-node-header"]').textContent)
      .toContain('预览图')
    expect(required<HTMLElement>(ghost, '[data-testid="canvas-ghost-node-activity"]').textContent)
      .toContain('生成中')
    expect(ghost.querySelector('.gg-shimmer')).toBeNull()
    // 没有顶部状态徽章；生成状态由 ghost 占位卡与 live region 传达
    expect(host.querySelector('[data-task-id="task-empty"] [data-task-status]')).toBeNull()
    expect(ghost.getAttribute('aria-label')).toContain('正在生成')
    await vi.waitFor(() => {
      expect(required(host, '[data-testid="canvas-live-region"]').textContent)
        .toContain('正在生成预览')
    })
  })

  it('keeps typed selection and focus while providing a roving entity tabindex', async () => {
    const { store, host } = await createSubject()
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges,
    } as unknown as Selection)
    const emptyTask = required<HTMLButtonElement>(host, '[data-focus-key="task:task-empty"]')
    const singleNode = required<HTMLButtonElement>(host, '[data-focus-key="node:node-single"]')
    expect(emptyTask.tabIndex).toBe(0)
    expect(singleNode.tabIndex).toBe(-1)

    let regularPointerDown!: MouseEvent
    act(() => {
      regularPointerDown = dispatchPointer(emptyTask, 'pointerdown', { clientX: 90, clientY: 70 })
    })
    act(() => dispatchPointer(window, 'pointerup', { clientX: 90, clientY: 70 }))
    expect(regularPointerDown.defaultPrevented).toBe(false)
    expect(removeAllRanges).not.toHaveBeenCalled()
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'task', id: 'task-empty' }])
    expect(document.activeElement).toBe(emptyTask)

    let additivePointerDown!: MouseEvent
    act(() => {
      additivePointerDown = dispatchPointer(singleNode, 'pointerdown', {
        clientX: 650,
        clientY: 180,
        shiftKey: true,
      })
    })
    expect(additivePointerDown.defaultPrevented).toBe(true)
    expect(removeAllRanges).toHaveBeenCalledOnce()
    expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'task', id: 'task-empty' },
      { kind: 'node', id: 'node-single' },
    ])
    expect(document.activeElement).toBe(singleNode)
    const hull = required<HTMLElement>(host, '[data-testid="canvas-selection-hull"]')
    expect(hull.getAttribute('data-selection-count')).toBe('2')
    expect(hull.getAttribute('data-node-shell')).toBe('true')
    expect(hull.className).toContain('rounded-[16px]')
    expect(hull.className).not.toContain('rounded-[18px]')
    expect(hull.textContent).toContain('组合节点 · 2 项')
    expect(hull.querySelectorAll('[data-selection-port]')).toHaveLength(4)
    const compoundToolbar = required(host, '[data-testid="canvas-selection-toolbar"]')
    expect(compoundToolbar.getAttribute('data-selection-mode')).toBe('compound')
    expect(compoundToolbar.textContent).not.toContain('2 个节点')
    expect(compoundToolbar.textContent).not.toContain('保存')

    act(() => singleNode.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })))
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe('task:task-multi')

    const focused = document.activeElement
    act(() => {
      store.setTaskRuntime({
        taskId: 'task-empty',
        phase: 'running',
        message: '流式状态更新',
        ghosts: [],
      })
    })
    expect(document.activeElement).toBe(focused)
  })

  it('canonicalizes a selected Task so its output Nodes are never double-counted', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'task', id: 'task-multi' },
      { kind: 'node', id: 'node-code' },
    ]))

    await vi.waitFor(() => expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'task', id: 'task-multi' },
    ]))
    expect(host.querySelector('[data-testid="canvas-selection-hull"]')).toBeNull()
    expect(required(host, '[data-task-id="task-multi"]').getAttribute('data-selected')).toBe('true')
    expect(required(host, '[data-node-id="node-image"]').getAttribute('data-selected')).toBe('false')
  })

  it('canonicalizes a selected Collection so its top-level members are never double-counted', async () => {
    const { store, host } = await createSubject(undefined, collectionFixture())
    act(() => store.setSelection([
      { kind: 'node', id: 'node-child' },
      { kind: 'task', id: 'task-a' },
      { kind: 'node', id: 'node-a' },
      { kind: 'collection', id: 'collection-1' },
    ]))
    await vi.waitFor(() => expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'collection', id: 'collection-1' },
    ]))
    expect(host.querySelector('[data-testid="canvas-selection-hull"]')).toBeNull()
    expect(required(host, '[data-collection-id="collection-1"]')
      .getAttribute('data-selected')).toBe('true')
  })

  it('uses the full Task footprint in a mixed temporary large node', async () => {
    const canvasDocument = fixtureDocument()
    const { store, host } = await createSubject(undefined, canvasDocument)
    act(() => store.setSelection([
      { kind: 'task', id: 'task-multi' },
      { kind: 'node', id: 'node-top' },
    ]))

    const hull = required<HTMLElement>(host, '[data-testid="canvas-selection-hull"]')
    const top = Number.parseFloat(hull.style.top)
    const bottom = top + Number.parseFloat(hull.style.height)
    const right = Number.parseFloat(hull.style.left) + Number.parseFloat(hull.style.width)
    for (const id of ['node-image', 'node-code']) {
      const frame = canvasDocument.nodes.find((node) => node.id === id)!.frame
      expect(bottom).toBeGreaterThanOrEqual(frame.y + frame.h + 14)
      expect(right).toBeGreaterThanOrEqual(frame.x + frame.w + 14)
    }
  })

  it('keeps Task output Node z-order in the global canvas stacking context', async () => {
    const canvasDocument = fixtureDocument()
    canvasDocument.nodes.find((node) => node.id === 'node-image')!.frame.z = 100
    canvasDocument.nodes.find((node) => node.id === 'node-top')!.frame.z = 1
    const { host } = await createSubject(undefined, canvasDocument)
    const task = required<HTMLElement>(host, '[data-task-id="task-multi"]')
    const taskOutput = required<HTMLElement>(host, '[data-node-id="node-image"]')
    const topLevel = required<HTMLElement>(host, '[data-node-id="node-top"]')

    expect(task.style.zIndex).toBe('')
    expect(Number(taskOutput.style.zIndex)).toBeGreaterThan(Number(topLevel.style.zIndex))
  })

  it('removes selected descendants as soon as their owning Task is collapsed', async () => {
    const { store, host } = await createSubject({
      selection: [
        { kind: 'node', id: 'node-image' },
        { kind: 'node', id: 'node-top' },
      ],
      collapsedTaskIds: ['task-multi'],
    })

    await vi.waitFor(() => expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'node', id: 'node-top' },
    ]))
    expect(host.querySelector('[data-node-id="node-image"]')).toBeNull()
    expect(host.querySelector('[data-testid="canvas-selection-hull"]')).toBeNull()
    expect(required(host, '[data-testid="canvas-selection-toolbar"]')
      .getAttribute('data-selection-mode')).toBe('single')
  })

  it('marquee-selects content inside an expanded Collection without absorbing it into the Collection', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } }, collectionFixture())
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges,
    } as unknown as Selection)
    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    let marqueePointerDown!: MouseEvent
    act(() => {
      marqueePointerDown = dispatchPointer(stage, 'pointerdown', {
        clientX: 540,
        clientY: 130,
        shiftKey: true,
      })
    })
    expect(marqueePointerDown.defaultPrevented).toBe(true)
    expect(removeAllRanges).toHaveBeenCalledOnce()
    act(() => dispatchPointer(window, 'pointermove', {
      clientX: 860,
      clientY: 330,
      shiftKey: true,
    }))
    act(() => dispatchPointer(window, 'pointerup', {
      clientX: 860,
      clientY: 330,
      shiftKey: true,
    }))

    expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'node', id: 'node-a' },
    ])
  })

  it('moves a temporary multi-selection as one view-only large node', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const beforeCollections = structuredClone(store.getSnapshot().document.collections)
    const hull = required<HTMLElement>(host, '[data-testid="canvas-selection-hull"]')
    const image = required<HTMLElement>(host, '[data-node-id="node-image"]')
    const code = required<HTMLElement>(host, '[data-node-id="node-code"]')
    expect(image.dataset.compoundSelected).toBe('true')
    expect(code.dataset.compoundSelected).toBe('true')
    expect(hull.querySelectorAll('[data-selection-port]')).toHaveLength(4)
    expect(hull.className).toContain('pointer-events-none')

    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'group-move' })
    const startX = 50 + Number.parseFloat(hull.style.left) + 4
    const startY = 20 + Number.parseFloat(hull.style.top) + 4
    act(() => dispatchPointer(hull, 'pointerdown', { clientX: startX, clientY: startY }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: startX + 45, clientY: startY + 25 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', {
      clientX: startX + 45,
      clientY: startY + 25,
    }))

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith({
      type: 'MoveEntities',
      entities: [
        { kind: 'node', id: 'node-image' },
        { kind: 'node', id: 'node-code' },
      ],
      dx: 45,
      dy: 25,
    })
    expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ])
    expect(store.getSnapshot().document.collections).toEqual(beforeCollections)
  })

  it('routes a selected Task descendant drag and ports through the compound surface', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([
      { kind: 'task', id: 'task-multi' },
      { kind: 'node', id: 'node-top' },
    ]))
    expect(host.querySelector(
      '[aria-label="从节点Weight vs. fuel economy scatter plot开始或完成连接"]',
    )).toBeNull()
    expect(host.querySelector(
      '[aria-label="从任务多产物开始或完成连接"]',
    )).toBeNull()

    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'task-group-move' })
    const childHandle = required<HTMLElement>(host, '[data-focus-key="node:node-image"]')
    act(() => dispatchPointer(childHandle, 'pointerdown', { clientX: 100, clientY: 100 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 130, clientY: 120 }))
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 130, clientY: 120 }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'MoveEntities',
      entities: [
        { kind: 'task', id: 'task-multi' },
        { kind: 'node', id: 'node-top' },
      ],
      dx: 30,
      dy: 20,
    })
  })

  it('routes selected Collection descendants through the group without blocking controls', async () => {
    const { store, host } = await createSubject(
      { camera: { x: 0, y: 0, zoom: 1 } },
      collectionFixture(),
    )
    act(() => store.setSelection([
      { kind: 'collection', id: 'collection-1' },
      { kind: 'task', id: 'task-b' },
    ]))
    const collection = required<HTMLElement>(host, '[data-collection-id="collection-1"]')
    const memberTask = required<HTMLElement>(host, '[data-task-id="task-a"]')
    expect(collection.style.zIndex).toBe('')
    expect(memberTask.style.zIndex).toBe('')
    expect(host.querySelector('[aria-label="从节点集合节点开始或完成连接"]')).toBeNull()
    expect(host.querySelector('[aria-label="从任务集合任务开始或完成连接"]')).toBeNull()
    expect(host.querySelector('[aria-label="从节点任务内部节点开始或完成连接"]')).toBeNull()

    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'collection-group-move' })
    const memberHandle = required<HTMLElement>(host, '[data-focus-key="node:node-a"]')
    act(() => dispatchPointer(memberHandle, 'pointerdown', { clientX: 100, clientY: 100 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 125, clientY: 115 }))
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 125, clientY: 115 }))

    expect(dispatch).toHaveBeenCalledWith({
      type: 'MoveEntities',
      entities: [{ kind: 'task', id: 'task-b' }],
      collectionIds: ['collection-1'],
      dx: 25,
      dy: 15,
    })
  })

  it('expands a temporary selection port into ordinary typed edges', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const rightPort = required<HTMLButtonElement>(
      host,
      '[data-selection-port="right"]',
    )
    expect(required(host, '[data-testid="canvas-selection-hull"]')
      .className).toContain('pointer-events-none')
    expect(rightPort.className).toContain('pointer-events-auto')
    await act(async () => rightPort.click())
    expect(rightPort.getAttribute('aria-pressed')).toBe('true')
    expect(required(host, '[data-selection-port="left"]')
      .getAttribute('aria-pressed')).toBe('false')
    // 节点头部端口已移除：连接草稿进行中，轻点目标节点卡片即完成连接
    const targetCard = required<HTMLElement>(host, '[data-node-id="node-top"]')
    act(() => dispatchPointer(targetCard, 'pointerdown', { clientX: 700, clientY: 120 }))
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 700, clientY: 120 }))

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CreateEdges',
      edges: expect.arrayContaining([
        expect.objectContaining({
          from: { kind: 'node', id: 'node-image' },
          to: { kind: 'node', id: 'node-top' },
          relation: 'references',
          contextRole: 'none',
        }),
        expect.objectContaining({
          from: { kind: 'node', id: 'node-code' },
          to: { kind: 'node', id: 'node-top' },
          relation: 'references',
          contextRole: 'none',
        }),
      ]),
    })))
  })

  it('permanently invalidates a temporary selection edge draft after selection changes', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    let rightPort = required<HTMLButtonElement>(host, '[data-selection-port="right"]')
    await act(async () => rightPort.click())
    expect(rightPort.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      store.setSelection([{ kind: 'node', id: 'node-top' }])
      await Promise.resolve()
    })
    await act(async () => {
      store.setSelection([
        { kind: 'node', id: 'node-image' },
        { kind: 'node', id: 'node-code' },
      ])
      await Promise.resolve()
    })

    rightPort = required<HTMLButtonElement>(host, '[data-selection-port="right"]')
    expect(rightPort.getAttribute('aria-pressed')).toBe('false')
  })

  it('cancels an in-progress connection without exposing semantic settings', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const sourcePort = required<HTMLButtonElement>(
      host,
      '[aria-label="从任务空任务开始或完成连接"]',
    )

    await act(async () => sourcePort.click())
    expect(sourcePort.getAttribute('aria-pressed')).toBe('true')
    expect(required<HTMLButtonElement>(host, '[aria-label="取消创建连接"]')
      .textContent).toContain('取消连接')

    await act(async () => required<HTMLElement>(
      host,
      '[data-testid="canvas-stage"]',
    ).dispatchEvent(new globalThis.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    })))

    expect(sourcePort.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('[aria-label="取消创建连接"]')).toBeNull()
    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="从任务空任务开始或完成连接"]',
    ).click())
    expect(dispatch.mock.calls.some(([command]) => command.type === 'CreateEdges')).toBe(false)
  })

  it('returns focus to the stage when the temporary large node is dismissed', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const toolbar = required<HTMLElement>(host, '[data-testid="canvas-selection-toolbar"]')
    expect(toolbar.getAttribute('role')).toBe('group')
    const dismiss = required<HTMLButtonElement>(toolbar, '[aria-label="取消组合节点选择"]')
    dismiss.focus()

    await act(async () => dismiss.click())

    expect(store.getSnapshot().view.selection).toEqual([])
    expect(document.activeElement).toBe(required(host, '[data-testid="canvas-stage"]'))
  })

  it('moves focus to the saved Collection when the temporary large node becomes durable', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'task', id: 'task-empty' },
      { kind: 'node', id: 'node-top' },
    ]))
    const save = required<HTMLButtonElement>(
      host,
      '[aria-label="将组合节点保存为集合"]',
    )
    save.focus()

    await act(async () => save.click())
    await vi.waitFor(() => {
      const selected = store.getSnapshot().view.selection
      expect(selected).toHaveLength(1)
      expect(selected[0]?.kind).toBe('collection')
      const collectionId = selected[0]!.id
      expect(document.activeElement).toBe(required(
        host,
        `[data-focus-key="collection:${collectionId}"]`,
      ))
    })
  })

  it('keeps camera, selection, and Task focus across materialization shape changes', async () => {
    const initialDocument = fixtureDocument()
    const materializedDocument = structuredClone(initialDocument)
    const task = materializedDocument.tasks.find((entry) => entry.id === 'task-empty')!
    materializedDocument.nodes.push({
      id: 'node-materialized',
      type: 'text',
      frame: { ...taskOutputFrame(task.anchor, 0), z: 5 },
      title: '新生成的产物',
      text: 'Run settle 后生成',
      artifactRefs: [],
      homeTaskId: task.id,
      origin: { kind: 'user' },
    })
    const { store, host } = await createSubject(undefined, initialDocument, materializedDocument)
    const before = required<HTMLButtonElement>(host, '[data-focus-key="task:task-empty"]')
    expect(required(host, '[data-task-id="task-empty"]').getAttribute('data-container-kind'))
      .toBe('task-card')
    act(() => {
      store.setCamera({ x: -280, y: 165, zoom: 1.55 })
      store.setSelection([{ kind: 'task', id: 'task-empty' }])
      before.focus()
    })
    expect(document.activeElement).toBe(before)

    await act(async () => {
      await store.reload()
    })

    // 物化为单产物任务后不再绘制完整标题条：任务焦点锚点随之消失，焦点安全回落
    expect(required(host, '[data-task-id="task-empty"]')
      .querySelector('[data-focus-key="task:task-empty"]')).toBeNull()
    expect(required(host, '[data-task-id="task-empty"]').getAttribute('data-container-kind'))
      .toBe('title-strip')
    expect(document.activeElement === document.body
      || required(host, '[data-testid="canvas-stage"]').contains(document.activeElement))
      .toBe(true)
    expect(store.getSnapshot().view).toMatchObject({
      camera: { x: -280, y: 165, zoom: 1.55 },
      selection: [{ kind: 'task', id: 'task-empty' }],
    })
    expect(required(host, '[data-testid="canvas-world"]').getAttribute('style'))
      .toContain('translate(-280px, 165px) scale(1.55)')
  })

  it('commits one task move, one node move, and one resize only on pointerup', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'ui-test' })
    // 单产物任务默认隐藏标题条：拖动节点头部即整体移动任务（保持任务锚点同步）
    const soloNode = required<HTMLButtonElement>(host, '[data-focus-key="node:node-single"]')

    act(() => dispatchPointer(soloNode, 'pointerdown', { clientX: 100, clientY: 100 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 130, clientY: 115 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 150, clientY: 130 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 150, clientY: 130 }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'MoveEntities',
      entities: [{ kind: 'task', id: 'task-single' }],
      dx: 50,
      dy: 30,
    })
    // 拖动节点只选中节点本身，任务未被选中
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'node', id: 'node-single' }])

    dispatch.mockClear()
    const node = required<HTMLButtonElement>(host, '[data-focus-key="node:node-top"]')
    act(() => dispatchPointer(node, 'pointerdown', { clientX: 200, clientY: 200 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 180, clientY: 240 }))
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 180, clientY: 240 }))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'MoveEntities',
      entities: [{ kind: 'node', id: 'node-top' }],
      dx: -20,
      dy: 40,
    })

    dispatch.mockClear()
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const resize = required<HTMLButtonElement>(host, '[data-node-resize="node-single"]')
    act(() => dispatchPointer(resize, 'pointerdown', { clientX: 300, clientY: 300 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 360, clientY: 340 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 360, clientY: 340 }))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'ResizeNode',
      nodeId: 'node-single',
      w: TASK_OUTPUT_LAYOUT.width + 60,
      h: TASK_OUTPUT_LAYOUT.height + 40,
    })
  })

  it('多产物任务未选中时标题条减重为轻量说明条，继续任务后恢复完整标题条', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const group = required<HTMLElement>(host, '[data-task-id="task-multi"]')
    expect(group.getAttribute('data-container-kind')).toBe('output-frame')

    // 默认（任务未选中）：轻量说明条——无卡片边框与状态徽章，
    // 保留任务焦点目标、产物计数与折叠入口
    const caption = required<HTMLElement>(group, '[data-task-chrome="caption"]')
    expect(caption.querySelector('[data-task-status]')).toBeNull()
    expect(caption.textContent).toContain('多产物')
    expect(caption.textContent).toContain('2 个产物')
    expect(caption.querySelector('[data-focus-key="task:task-multi"]')).not.toBeNull()
    expect(caption.querySelector('[aria-label="折叠任务多产物"]')).not.toBeNull()

    // 产物节点的右上角图标条并入任务级操作
    const continueItem = required<HTMLButtonElement>(
      group,
      'button[aria-label="继续任务"]',
    )
    await act(async () => continueItem.click())

    // 继续任务 = 选中任务：完整标题条（含状态徽章）恢复
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'task', id: 'task-multi' }])
    await vi.waitFor(() => {
      const after = required<HTMLElement>(host, '[data-task-id="task-multi"]')
      expect(after.querySelector('[data-task-chrome="caption"]')).toBeNull()
      expect(after.querySelector('[data-task-status]')).not.toBeNull()
    })
  })

  it('拖动多产物任务的轻量说明条整体移动任务', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'ui-test' })
    const caption = required<HTMLButtonElement>(
      host,
      '[data-task-id="task-multi"] [data-focus-key="task:task-multi"]',
    )

    act(() => dispatchPointer(caption, 'pointerdown', { clientX: 100, clientY: 500 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 140, clientY: 540 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 140, clientY: 540 }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'MoveEntities',
      entities: [{ kind: 'task', id: 'task-multi' }],
      dx: 40,
      dy: 40,
    })
  })

  it('生成阶段（仅有 ghost）不绘制任何顶部条', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([{ kind: 'task', id: 'task-empty' }]))
    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      runId: 'run-empty',
      phase: 'running',
      message: '正在生成预览',
      ghosts: [{
        key: 'preview',
        title: '预览图',
        pluginId: 'image',
        phase: 'writing',
        progress: 0.4,
      }],
    }))

    const group = required<HTMLElement>(host, '[data-task-id="task-empty"]')
    // 没有任何顶部条：轻量说明条与完整标题条都不绘制（状态由下方运行面板表达）
    expect(group.querySelector('[data-task-chrome="caption"]')).toBeNull()
    expect(group.querySelector('[data-focus-key="task:task-empty"]')).toBeNull()
    const fullBadge = [...group.querySelectorAll('[data-task-status]')]
      .find((element) => element.className.includes('rounded-full'))
    expect(fullBadge).toBeUndefined()
    // ghost 占位卡仍在
    expect(group.querySelector('[data-ghost-key="preview"]')).not.toBeNull()
  })

  it('运行刚启动但尚未声明产物时直接显示带节点外壳的临时输出面', async () => {
    const { store, host } = await createSubject(
      { camera: { x: 0, y: 0, zoom: 1 } },
      fixtureDocument(),
      undefined,
      testTaskRunLifecycle(),
    )
    act(() => store.setSelection([{ kind: 'task', id: 'task-empty' }]))
    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      runId: 'run-empty',
      phase: 'running',
      message: '正在运行',
      ghosts: [],
    }))

    const group = required<HTMLElement>(host, '[data-task-id="task-empty"]')
    expect(group.getAttribute('data-container-kind')).toBe('title-strip')
    expect(group.querySelector('[data-focus-key="task:task-empty"]')).toBeNull()
    expect(group.textContent).not.toContain('尚无产物')
    const ghost = required<HTMLElement>(group, '[data-ghost-key="pending-output:task-empty"]')
    expect(ghost.querySelector('[data-testid="canvas-ghost-generating-surface"]')).not.toBeNull()
    expect(required<HTMLElement>(ghost, '[data-testid="canvas-ghost-node-header"]').textContent)
      .toContain('空任务')
    expect(required<HTMLElement>(ghost, '[data-testid="canvas-ghost-node-activity"]').textContent)
      .toContain('生成中')
    expect(group.querySelector('[aria-label="空任务的运行控制"]')).not.toBeNull()
  })

  it('输出槽派生任务生成中（空槽节点已被认领）不绘制任何顶部条', async () => {
    const canvasDocument = fixtureDocument()
    canvasDocument.tasks.push({
      id: 'task-slot',
      title: '评论一下这个图画',
      goal: '评论一下这个图画',
      anchor: { x: 1040, y: 480 },
      origin: { kind: 'user' },
    })
    canvasDocument.nodes.push({
      id: 'node-slot',
      type: 'text',
      frame: { ...taskOutputFrame({ x: 1040, y: 480 }, 0), z: 5 },
      title: '等待内容',
      artifactRefs: [],
      homeTaskId: 'task-slot',
      origin: { kind: 'user' },
    })
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } }, canvasDocument)
    // 任务被选中（继续任务）且运行已启动，空槽节点还没有任何内容；
    // 运行正在往槽位写产物（ghost 存在）
    act(() => store.setSelection([{ kind: 'task', id: 'task-slot' }]))
    act(() => store.setTaskRuntime({
      taskId: 'task-slot',
      runId: 'run-slot',
      phase: 'running',
      message: '正在生成评论',
      ghosts: [{
        key: 'review',
        title: '画面评论',
        pluginId: 'text',
        phase: 'writing',
        progress: 0.4,
      }],
    }))

    const group = required<HTMLElement>(host, '[data-task-id="task-slot"]')
    // 空槽节点本身就是「等待内容」占位：不再重复绘制 ghost 卡，任务仍按单产物处理
    expect(group.querySelector('[data-ghost-key]')).toBeNull()
    expect(group.getAttribute('data-container-kind')).toBe('title-strip')
    // 没有任何顶部条：轻量说明条与完整标题条都不绘制，槽节点保持在原位
    expect(group.querySelector('[data-task-chrome="caption"]')).toBeNull()
    expect(group.querySelector('[data-focus-key="task:task-slot"]')).toBeNull()
    const slotDocNode = canvasDocument.nodes.find((node) => node.id === 'node-slot')!
    const slotNode = required<HTMLElement>(group, '[data-node-id="node-slot"]')
    expect(slotNode.style.left).toBe(`${slotDocNode.frame.x}px`)
    expect(slotNode.style.top).toBe(`${slotDocNode.frame.y}px`)
    const fullBadge = [...group.querySelectorAll('[data-task-status]')]
      .find((element) => element.className.includes('rounded-full'))
    expect(fullBadge).toBeUndefined()
    // 运行中的空槽由下方 RunPanel 唯一控权，不再暴露第二套节点 / 任务操作。
    expect(group.querySelector('[aria-label="等待内容节点操作"]')).toBeNull()
    expect(group.querySelector('[aria-label="等待内容节点操作"] [aria-label="折叠任务"]'))
      .toBeNull()

    // 生成结束、内容落进槽节点后：依然没有任何顶部条
    await act(async () => {
      await store.dispatchCommand({
        type: 'UpdateNodeContent',
        nodeId: 'node-slot',
        patch: { text: '生成的评论正文' },
      })
      store.setTaskRuntime({
        taskId: 'task-slot',
        runId: 'run-slot',
        phase: 'done',
        ghosts: [],
      })
    })
    await vi.waitFor(() => {
      const updated = required<HTMLElement>(host, '[data-task-id="task-slot"]')
      expect(updated.querySelector('[data-task-chrome="caption"]')).toBeNull()
      expect(updated.querySelector('[data-focus-key="task:task-slot"]')).toBeNull()
    })
  })

  it.each(['queued', 'running', 'awaiting-permission'] as const)(
    '单选有内容的所属节点时，%s Task 保持唯一运行控制权',
    async (phase) => {
      const lifecycle = testTaskRunLifecycle()
      const { store, host } = await createSubject(
        { camera: { x: 0, y: 0, zoom: 1 } },
        fixtureDocument(),
        undefined,
        lifecycle,
      )
      act(() => {
        store.setSelection([{ kind: 'node', id: 'node-single' }])
        store.setTaskRuntime({
          taskId: 'task-single',
          runId: 'run-single-active',
          phase,
          ghosts: [],
        })
      })

      await vi.waitFor(() => {
        const node = required<HTMLElement>(host, '[data-node-id="node-single"]')
        expect(node.getAttribute('data-selected')).toBe('true')
        expect(required(host, '[data-task-id="task-single"]')
          .getAttribute('data-selected')).toBe('false')
        expect(host.querySelector('[data-testid="canvas-task-run-panel-task-single"]'))
          .not.toBeNull()
      })
      // RunPanel 是唯一控制面：不再显示派生 composer、节点工具条或连接端口。
      expect(host.querySelector('[data-testid="canvas-context-composer"]')).toBeNull()
      expect(host.querySelector('[data-testid="canvas-selection-toolbar"]')).toBeNull()
      expect(host.querySelector('[data-testid="canvas-single-selection-ports"]')).toBeNull()
    },
  )

  it('复合选择包含 active owned node 时仍由父 Task 唯一控权', async () => {
    const lifecycle = testTaskRunLifecycle()
    const { store, host } = await createSubject(
      { camera: { x: 0, y: 0, zoom: 1 } },
      fixtureDocument(),
      undefined,
      lifecycle,
    )
    act(() => {
      store.setSelection([
        { kind: 'node', id: 'node-single' },
        { kind: 'node', id: 'node-top' },
      ])
      store.setTaskRuntime({
        taskId: 'task-single',
        runId: 'run-single-active-compound',
        phase: 'running',
        ghosts: [],
      })
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="canvas-task-run-panel-task-single"]'))
        .not.toBeNull()
    })
    expect(host.querySelector('[data-testid="canvas-context-composer"]')).toBeNull()
    expect(host.querySelector('[data-testid="canvas-selection-toolbar"]')).toBeNull()
    const hull = required(host, '[data-testid="canvas-selection-hull"]')
    expect(hull.querySelector('[data-selection-port]')).toBeNull()
  })

  it.each(['missing', 'error', 'cancelled', 'done'] as const)(
    '单选仍为空的 owned slot 时，%s 后仍回到父 Task 重试面板',
    async (phase) => {
      const canvasDocument = fixtureDocument()
      canvasDocument.tasks.push({
        id: 'task-owned-empty',
        title: '空槽重试',
        goal: '生成简洁文本',
        anchor: { x: 1040, y: 480 },
        origin: { kind: 'user' },
      })
      canvasDocument.nodes.push({
        id: 'node-owned-empty',
        type: 'text',
        frame: { ...taskOutputFrame({ x: 1040, y: 480 }, 0), z: 5 },
        title: '等待内容',
        artifactRefs: [],
        homeTaskId: 'task-owned-empty',
        origin: { kind: 'user' },
      })
      const lifecycle = testTaskRunLifecycle()
      const { store, host } = await createSubject(
        { camera: { x: 0, y: 0, zoom: 1 } },
        canvasDocument,
        undefined,
        lifecycle,
      )
      act(() => {
        store.setSelection([{ kind: 'node', id: 'node-owned-empty' }])
        if (phase !== 'missing') {
          store.setTaskRuntime({
            taskId: 'task-owned-empty',
            runId: `run-owned-empty-${phase}`,
            phase,
            ghosts: [],
          })
        }
      })

      await vi.waitFor(() => {
        expect(host.querySelector(
          '[data-testid="canvas-task-run-panel-task-owned-empty"]',
        )).not.toBeNull()
      })
      expect(required(host, '[data-node-id="node-owned-empty"]')
        .getAttribute('data-selected')).toBe('true')
      expect(host.querySelector('[data-testid="canvas-context-composer"]')).toBeNull()
      expect(host.querySelector('[data-testid="canvas-selection-toolbar"]')).toBeNull()
      expect(host.querySelector('[data-testid="canvas-single-selection-ports"]')).toBeNull()
      expect(required<HTMLTextAreaElement>(
        host,
        '#canvas-task-composer-task-owned-empty',
      ).disabled).toBe(false)
    },
  )

  it('所属任务结束且节点有内容后，恢复节点派生与类型工具', async () => {
    const lifecycle = testTaskRunLifecycle()
    const { store, host } = await createSubject(
      { camera: { x: 0, y: 0, zoom: 1 } },
      fixtureDocument(),
      undefined,
      lifecycle,
    )
    act(() => {
      store.setSelection([{ kind: 'node', id: 'node-single' }])
      store.setTaskRuntime({
        taskId: 'task-single',
        runId: 'run-single-done',
        phase: 'done',
        ghosts: [],
      })
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="canvas-task-run-panel-task-single"]'))
        .toBeNull()
      expect(host.querySelector('[data-testid="canvas-context-composer"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="canvas-selection-toolbar"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="canvas-single-selection-ports"]')).not.toBeNull()
    })
    expect(required(host, '[data-testid="canvas-selection-toolbar"]')
      .querySelector('[data-node-mark="bold"]')).not.toBeNull()
    expect(required(host, '[data-testid="canvas-selection-toolbar"]')
      .querySelector('[aria-label="打开节点提示词控件"]')).not.toBeNull()
  })

  it('单产物任务任何状态都不绘制完整标题条，选中（继续任务）也一样', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const group = required<HTMLElement>(host, '[data-task-id="task-single"]')
    expect(group.getAttribute('data-container-kind')).toBe('title-strip')
    // 默认（任务未选中）：无任务标题条，节点仍在
    expect(group.querySelector('[data-focus-key="task:task-single"]')).toBeNull()
    expect(group.querySelector('[data-focus-key="node:node-single"]')).not.toBeNull()

    // 节点右上角图标条并入任务级操作
    const continueItem = required<HTMLButtonElement>(
      group,
      'button[aria-label="继续任务"]',
    )
    await act(async () => continueItem.click())

    // 继续任务 = 选中任务；完整标题条（帽子）依然不出现
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'task', id: 'task-single' }])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(required<HTMLElement>(host, '[data-task-id="task-single"]')
      .querySelector('[data-focus-key="task:task-single"]')).toBeNull()
  })

  it('单产物任务没有折叠形态：持久化的折叠标记被忽略', async () => {
    const { host } = await createSubject({ collapsedTaskIds: ['task-single'] })
    const group = required<HTMLElement>(host, '[data-task-id="task-single"]')
    expect(group.getAttribute('data-container-kind')).toBe('title-strip')
    expect(group.getAttribute('data-presentation')).toBe('expanded')
    // 产物节点照常渲染，不存在「展开任务」入口
    expect(group.querySelector('[data-node-id="node-single"]')).not.toBeNull()
    expect(group.querySelector('[aria-label="展开任务单产物"]')).toBeNull()
    expect(group.querySelector('[aria-label="折叠任务单产物"]')).toBeNull()
  })

  it('pans and zooms only branch view state and supports additive Shift marquee', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    const beforeDocument = structuredClone(store.getSnapshot().document)

    act(() => dispatchPointer(stage, 'pointerdown', { clientX: 80, clientY: 60 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 130, clientY: 85 }))
    act(() => dispatchPointer(window, 'pointerup', { clientX: 130, clientY: 85 }))
    expect(store.getSnapshot().view.camera).toEqual({ x: 50, y: 25, zoom: 1 })

    act(() => stage.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      deltaY: -100,
    })))
    expect(store.getSnapshot().view.camera.zoom).toBeCloseTo(1.09)
    expect(store.getSnapshot().document).toEqual(beforeDocument)

    act(() => store.setCamera({ x: 0, y: 0, zoom: 1 }))
    act(() => store.setSelection([{ kind: 'node', id: 'node-top' }]))
    act(() => dispatchPointer(stage, 'pointerdown', {
      clientX: 570,
      clientY: 40,
      shiftKey: true,
    }))
    act(() => dispatchPointer(window, 'pointermove', {
      clientX: 1040,
      clientY: 430,
      shiftKey: true,
    }))
    expect(required(host, '[data-testid="canvas-marquee"]')).not.toBeNull()
    act(() => dispatchPointer(window, 'pointerup', {
      clientX: 1040,
      clientY: 430,
      shiftKey: true,
    }))
    expect(store.getSnapshot().view.selection).toEqual(expect.arrayContaining([
      { kind: 'node', id: 'node-top' },
      { kind: 'task', id: 'task-single' },
    ]))
    expect(store.getSnapshot().view.selection).not.toContainEqual(
      { kind: 'node', id: 'node-single' },
    )
  })

  it('leaves wheel events inside the side panel to the panel instead of zooming', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    // 模拟右侧抽屉（产物查看 / 详细日志）内部触发的滚轮事件
    const panel = document.createElement('div')
    panel.setAttribute('data-canvas-side-panel', '')
    const scroller = document.createElement('div')
    panel.append(scroller)
    stage.append(panel)

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      deltaY: -100,
    })))
    expect(store.getSnapshot().view.camera).toEqual({ x: 0, y: 0, zoom: 1 })
    panel.remove()

    // 面板外（画布区域）的滚轮仍然正常缩放
    act(() => stage.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      deltaY: -100,
    })))
    expect(store.getSnapshot().view.camera.zoom).toBeCloseTo(1.09)
  })

  it('explicitly saves a typed top-level selection as a collection and undoes through commands', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([
      { kind: 'task', id: 'task-empty' },
      { kind: 'node', id: 'node-top' },
    ]))

    const save = required<HTMLButtonElement>(
      host,
      '[aria-label="将组合节点保存为集合"]',
    )
    await act(async () => save.click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toHaveLength(1))
    const created = store.getSnapshot().document.collections[0]!
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CreateCollectionFromSelection',
      members: expect.arrayContaining([
        { kind: 'task', id: 'task-empty' },
        { kind: 'node', id: 'node-top' },
      ]),
    }))
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'collection', id: created.id }])

    const undo = required<HTMLButtonElement>(host, '[data-testid="canvas-undo"] button')
    await act(async () => undo.click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toEqual([]))
    expect(dispatch).toHaveBeenCalledWith({
      type: 'DissolveCollection',
      collectionId: created.id,
    })
  })

  it('assigns, duplicates, and dissolves saved collections through reducer-backed menus', async () => {
    const { store, host } = await createSubject(undefined, collectionFixture())
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([{ kind: 'task', id: 'task-b' }]))
    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="研究集合集合菜单"]',
    ).click())
    const assign = [...required<HTMLElement>(host, '[role="menu"]')
      .querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('加入所选内容'))
    if (!assign) throw new Error('Missing collection assignment button')
    await act(async () => assign.click())
    await vi.waitFor(() => expect(
      store.getSnapshot().document.tasks.find((task) => task.id === 'task-b')?.collectionId,
    ).toBe('collection-1'))
    expect(dispatch).toHaveBeenCalledWith({
      type: 'AssignToCollection',
      collectionId: 'collection-1',
      members: [{ kind: 'task', id: 'task-b' }],
    })
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-undo"] button',
    ).click())
    await vi.waitFor(() => expect(
      store.getSnapshot().document.tasks.find((task) => task.id === 'task-b')?.collectionId,
    ).toBeUndefined())

    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="研究集合集合菜单"]',
    ).click())
    const duplicate = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('复制集合'))
    if (!duplicate) throw new Error('Missing duplicate collection action')
    await act(async () => duplicate.click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toHaveLength(2))
    expect(dispatch.mock.calls.some(([command]) => command.type === 'DuplicateCollection')).toBe(true)
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-undo"] button',
    ).click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toHaveLength(1))

    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="研究集合集合菜单"]',
    ).click())
    const dissolve = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('解散集合'))
    if (!dissolve) throw new Error('Missing dissolve collection action')
    await act(async () => dissolve.click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toEqual([]))
    expect(store.getSnapshot().document.tasks.find((task) => task.id === 'task-a')).toBeDefined()
    expect(store.getSnapshot().document.nodes.find((node) => node.id === 'node-a')).toBeDefined()
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-undo"] button',
    ).click())
    await vi.waitFor(() => expect(store.getSnapshot().document.collections).toHaveLength(1))
    expect(store.getSnapshot().document.tasks.find((task) => task.id === 'task-a')?.collectionId)
      .toBe('collection-1')
  })

  it('renders a collection once, keeps collapsed edges bundled on hover, and moves once', async () => {
    const { store, host } = await createSubject({
      collapsedCollectionIds: ['collection-1'],
    }, collectionFixture())
    const collection = required<HTMLElement>(host, '[data-collection-id="collection-1"]')
    expect(collection.getAttribute('data-collapsed')).toBe('true')
    expect(host.querySelector('[data-task-id="task-a"]')).toBeNull()
    expect(host.querySelector('[data-node-id="node-a"]')).toBeNull()
    expect(host.querySelector('[data-node-id="node-child"]')).toBeNull()
    const bundle = required<SVGGElement>(host, '[data-edge-bundle-count="3"]')
    expect(bundle.getAttribute('aria-label')).toContain('聚合 3 条连接')
    expect(bundle.getAttribute('aria-label')).toContain('按 Delete')
    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'ui' })
    await act(async () => bundle.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    })))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith({
      type: 'DeleteEdges',
      edgeIds: ['edge-task', 'edge-node', 'edge-child'],
    })
    dispatch.mockClear()

    // Hovering a collapsed collection must not fan edges out toward hidden members.
    await act(async () => dispatchPointer(collection, 'pointerover'))
    expect(host.querySelectorAll('[data-edge-bundle-count="1"]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-edge-bundle-count="3"]')).toHaveLength(1)
    await act(async () => dispatchPointer(collection, 'pointerout'))

    const expand = required<HTMLButtonElement>(collection, '[aria-label="展开集合研究集合"]')
    await act(async () => expand.click())
    expect(host.querySelectorAll('[data-task-id="task-a"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-node-id="node-a"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-node-id="node-child"]')).toHaveLength(1)

    const header = required<HTMLButtonElement>(host, '[data-focus-key="collection:collection-1"]')
    act(() => dispatchPointer(header, 'pointerdown', { clientX: 80, clientY: 70 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 140, clientY: 95 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 140, clientY: 95 }))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith({
      type: 'MoveEntities',
      entities: [],
      collectionIds: ['collection-1'],
      dx: 60,
      dy: 25,
    })
  })

  it('creates a typed node from the creation menu and detaches task nodes', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const nodeCountBefore = store.getSnapshot().document.nodes.length

    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    await act(async () => stage.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: 420,
      clientY: 320,
    })))
    const menu = required<HTMLElement>(host, '[data-create-node-menu]')
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.length).toBeGreaterThan(0)
    const firstLabel = items[0]!.textContent ?? ''
    await act(async () => items[0]!.click())

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        type: 'CreateNode',
        node: expect.objectContaining({
          artifactRefs: [],
          origin: { kind: 'user' },
          title: firstLabel,
        }),
      }))
    })
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore + 1)
    })
    const created = store.getSnapshot().document.nodes.at(-1)!
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'node', id: created.id }])
    expect(host.querySelector('[data-create-node-menu]')).toBeNull()

    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-undo"] button',
    ).click())
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore)
    })

    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-task-id="task-single"] [aria-label="移出任务"]',
    ).click())
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'DetachNodeFromTask',
        nodeId: 'node-single',
      })
    })
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.find((node) => node.id === 'node-single')
        ?.homeTaskId).toBeUndefined()
    })
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="canvas-undo"] button',
    ).click())
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.find((node) => node.id === 'node-single')
        ?.homeTaskId).toBe('task-single')
    })
  })

  it('derives mixed collection-macro semantics without protocol controls', async () => {
    const { store, host } = await createSubject(undefined, collectionFixture())
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    expect(host.querySelector('[aria-label="连接语义设置"]')).toBeNull()
    expect(host.querySelector('[aria-label="连接 relation"]')).toBeNull()
    expect(host.querySelector('[aria-label="连接 contextRole"]')).toBeNull()
    expect(host.querySelector('[aria-label="选择目标集合"]')).toBeNull()
    expect(host.querySelector('[data-testid="save-selection-collection"]')).toBeNull()

    const sourcePort = required<HTMLButtonElement>(
      host,
      '[data-collection-id="collection-1"] [data-edge-port]',
    )
    const targetPort = required<HTMLButtonElement>(
      host,
      '[data-task-id="task-b"] [data-edge-port]',
    )
    expect(sourcePort.tagName).toBe('BUTTON')
    expect(sourcePort.getAttribute('aria-label')).toContain('集合研究集合')
    await act(async () => sourcePort.click())
    expect(sourcePort.getAttribute('aria-pressed')).toBe('true')
    await act(async () => targetPort.click())

    await vi.waitFor(() => expect(store.getSnapshot().document.edges).toHaveLength(5))
    const createCall = dispatch.mock.calls.find(([command]) => command.type === 'CreateEdges')
    expect(createCall?.[0]).toMatchObject({
      type: 'CreateEdges',
      edges: expect.arrayContaining([
        expect.objectContaining({
          from: { kind: 'task', id: 'task-a' },
          to: { kind: 'task', id: 'task-b' },
          relation: 'depends-on',
          contextRole: 'summary',
        }),
        expect.objectContaining({
          from: { kind: 'node', id: 'node-a' },
          to: { kind: 'task', id: 'task-b' },
          relation: 'source',
          contextRole: 'full',
        }),
      ]),
    })
    expect((createCall?.[0] as { edges: Array<{ from: { id: string } }> }).edges
      .map((edge) => edge.from.id).sort()).toEqual(['node-a', 'task-a'])
    const dependencyEdge = [...host.querySelectorAll<SVGGElement>('[data-edge-bundle-count]')]
      .find((entry) => entry.getAttribute('aria-label')?.includes('依赖连接'))
    expect(dependencyEdge?.getAttribute('tabindex')).toBe('0')
    expect(dependencyEdge?.textContent).toContain('依赖')
    expect(dependencyEdge?.textContent).not.toContain('摘要')
  })

  it('rejects an oversized collection macro instead of silently truncating its edges', async () => {
    const { store, host } = await createSubject(undefined, oversizedCollectionMacroFixture())
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const sourcePort = required<HTMLButtonElement>(
      host,
      '[data-collection-id="collection-left"] [data-edge-port]',
    )
    const targetPort = required<HTMLButtonElement>(
      host,
      '[data-collection-id="collection-right"] [data-edge-port]',
    )
    await act(async () => sourcePort.click())
    await act(async () => targetPort.click())
    expect(dispatch).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(required<HTMLElement>(
      host,
      '[data-testid="canvas-live-region"]',
    ).textContent).toContain('超过 500 条连接'))
  })

  it('persists node deletion immediately and guards active tasks', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const deleteNodeButton = required<HTMLButtonElement>(
      host,
      '[data-node-id="node-top"] [aria-label="从画布移除"]',
    )
    await act(async () => deleteNodeButton.click())
    const dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    const confirm = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('从画布移除'))
    if (!confirm) throw new Error('Missing delete confirmation')
    await act(async () => confirm.click())
    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-top' })

    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      phase: 'running',
      message: '仍在运行',
      ghosts: [],
    }))
    // active 零输出 Task 已投射成临时输出面，Task chrome 与结构动作一起隐藏；
    // 取消运行只由紧贴输出面的 RunPanel 提供，不能从菜单旁路删除。
    expect(host.querySelector('[aria-label="空任务任务菜单"]')).toBeNull()
    expect(host.querySelector('[data-ghost-key="pending-output:task-empty"]')).not.toBeNull()
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('describes Task removal in user terms without leaking storage jargon', async () => {
    const { host } = await createSubject()
    const taskMenu = required<HTMLButtonElement>(host, '[aria-label="空任务任务菜单"]')

    await act(async () => taskMenu.click())
    const detach = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('解除任务关系，保留画布节点'))
    if (!detach) throw new Error('Missing detach Task relationship action')
    await act(async () => detach.click())
    let dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    expect(dialog.textContent).toContain('输出节点会保留在画布并成为独立节点')
    expect(dialog.textContent).not.toMatch(/artifact|receipt/u)
    await act(async () => [...dialog.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('取消'))?.click())

    await act(async () => taskMenu.click())
    const removeAll = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('从画布移除任务和输出节点'))
    if (!removeAll) throw new Error('Missing remove Task and output nodes action')
    await act(async () => removeAll.click())
    dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    expect(dialog.textContent).toContain('生成内容会保留在资源库的“生成内容”中')
    expect(dialog.textContent).not.toMatch(/artifact|receipt/u)
  })

  it('removes an empty owner Task with its last artifact node while retaining the run receipt', async () => {
    const canvasDocument = fixtureDocument()
    const singlePlanId = `plan_${'d'.repeat(64)}`
    const node = canvasDocument.nodes.find((entry) => entry.id === 'node-single')!
    node.artifactRefs = [{ runId: 'run-single', artifactId }]
    node.origin = {
      kind: 'agent-output',
      taskId: 'task-single',
      runId: 'run-single',
      planId: singlePlanId,
      outputKey: 'only',
    }
    canvasDocument.edges.push({
      id: 'edge-single-source',
      from: { kind: 'node', id: 'node-top' },
      to: { kind: 'task', id: 'task-single' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    })
    canvasDocument.receipts.push({
      kind: 'materialization',
      planId: singlePlanId,
      runId: 'run-single',
      taskId: 'task-single',
      outcomes: [{ outputKey: 'only', nodeId: 'node-single' }],
      dismissedProposalKeys: [],
    })
    const projected = applyCanvasCommand(canvasDocument, {
      type: 'DeleteNode',
      nodeId: 'node-single',
    })
    expect(projected.tasks.some((task) => task.id === 'task-single')).toBe(false)
    expect(projected.nodes.some((entry) => entry.id === 'node-single')).toBe(false)

    const { store, host } = await createSubject(undefined, canvasDocument)
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-node-id="node-single"] [aria-label="从画布移除"]',
    ).click())
    const dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    expect(dialog.textContent).toContain('空任务外壳也会一并移除')
    expect(dialog.textContent).toContain('生成内容会保留在资源库的“生成内容”中')
    const confirm = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('从画布移除'))
    if (!confirm) throw new Error('Missing task-owned node delete confirmation')
    await act(async () => confirm.click())

    expect(host.querySelector('[data-node-id="node-single"]')).toBeNull()
    expect(host.querySelector('[data-task-id="task-single"]')).toBeNull()
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-single' })
    const snapshot = store.getSnapshot().document
    expect(snapshot.tasks.some((task) => task.id === 'task-single')).toBe(false)
    expect(snapshot.nodes.some((entry) => entry.id === 'node-single')).toBe(false)
    expect(snapshot.edges.some((edge) => edge.id === 'edge-single-source')).toBe(false)
    expect(snapshot.receipts.some((receipt) => receipt.taskId === 'task-single')).toBe(true)
  })

  it('traps confirmation focus, closes with Escape, and restores a safe focus target', async () => {
    const { host } = await createSubject()
    const stage = required<HTMLElement>(host, '[data-testid="canvas-stage"]')
    const trigger = required<HTMLButtonElement>(
      host,
      '[data-node-id="node-top"] [aria-label="从画布移除"]',
    )
    expect(stage.getAttribute('role')).toBe('region')
    expect(stage.querySelector('[role="application"]')).toBeNull()
    act(() => trigger.focus())
    await act(async () => trigger.click())

    const dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    const [cancel, confirm] = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('canvas-confirm-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('canvas-confirm-detail')
    expect(document.activeElement).toBe(cancel)

    await act(async () => cancel?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })))
    expect(document.activeElement).toBe(confirm)
    await act(async () => confirm?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })))
    expect(document.activeElement).toBe(cancel)

    await act(async () => cancel?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })))
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await act(async () => trigger.click())
    const confirmAgain = [...required<HTMLElement>(host, '[role="alertdialog"]')
      .querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('从画布移除'))
    if (!confirmAgain) throw new Error('Missing repeated delete confirmation')
    await act(async () => confirmAgain.click())

    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(document.activeElement).toBe(stage)
    await vi.waitFor(() => expect(
      required(host, '[data-testid="canvas-live-region"]').textContent,
    ).toContain('已从画布移除'))
  })

  it('keeps the node visible when immediate destructive persistence is rejected', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
      .mockRejectedValue(new Error('precondition changed'))
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-node-id="node-top"] [aria-label="从画布移除"]',
    ).click())
    const confirm = [...required<HTMLElement>(host, '[role="alertdialog"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('从画布移除'))
    if (!confirm) throw new Error('Missing node delete confirmation')
    await act(async () => confirm.click())
    await act(async () => Promise.resolve())
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-top' })
    expect(required(host, '[data-node-id="node-top"]')).not.toBeNull()
    await vi.waitFor(() => expect(
      required(host, '[data-testid="canvas-live-region"]').textContent,
    ).toContain('操作未保存'))
  })

  it('submits node deletion as soon as confirmation succeeds', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([{ kind: 'node', id: 'node-top' }]))
    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-node-id="node-top"] [aria-label="从画布移除"]',
    ).click())
    const confirm = [...required<HTMLElement>(host, '[role="alertdialog"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('从画布移除'))
    if (!confirm) throw new Error('Missing node delete confirmation')
    await act(async () => confirm.click())
    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-top' })
    expect(store.getSnapshot().document.nodes.some((node) => node.id === 'node-top')).toBe(false)
    expect(store.getSnapshot().view.selection).toEqual([])
  })

  it('throttles live-region updates instead of announcing every run event', async () => {
    vi.useFakeTimers()
    const { store, host } = await createSubject()
    const live = required<HTMLElement>(host, '[data-testid="canvas-live-region"]')

    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      phase: 'running',
      message: '阶段 A',
      ghosts: [],
    }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(live.textContent).toContain('阶段 A')

    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      phase: 'running',
      message: '阶段 B',
      ghosts: [],
    }))
    await act(async () => vi.advanceTimersByTimeAsync(699))
    expect(live.textContent).toContain('阶段 A')
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(live.textContent).toContain('阶段 B')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.getAttribute('aria-atomic')).toBe('true')
  })

  it('creates a connected node from a selected node port', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const nodeCountBefore = store.getSnapshot().document.nodes.length
    const edgeCountBefore = store.getSnapshot().document.edges.length

    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-selection-port="right"]',
    ).click())
    const menu = required<HTMLElement>(host, '[data-create-node-menu]')
    expect(menu.textContent).toContain('从“说明文字”新建节点')
    const textItem = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '文本')
    if (!textItem) throw new Error('Missing text node menu item')
    await act(async () => textItem.click())

    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore + 1)
    })
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.edges.length).toBe(edgeCountBefore + 1)
    })
    const created = store.getSnapshot().document.nodes.at(-1)!
    expect(created.type).toBe('text')
    const source = store.getSnapshot().document.nodes
      .find((node) => node.id === 'node-single')!
    expect(created.frame.x).toBe(source.frame.x + source.frame.w + 56)
    expect(store.getSnapshot().document.edges.at(-1)).toMatchObject({
      from: { kind: 'node', id: 'node-single' },
      to: { kind: 'node', id: created.id },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CreateEdges',
      edges: [expect.objectContaining({
        from: { kind: 'node', id: 'node-single' },
        to: { kind: 'node', id: created.id },
        relation: 'source',
      })],
    }))
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'node', id: created.id }])
    expect(host.querySelector('[data-create-node-menu]')).toBeNull()
  })

  it('does not invent preset actions for built-in nodes', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([{ kind: 'node', id: 'node-image' }]))
    const toolbar = required<HTMLElement>(host, '[aria-label="所选节点工具栏"]')
    expect(toolbar.textContent).not.toContain('生成变体')
    expect(host.querySelector('[aria-label="节点专属快捷指令"]')).toBeNull()
  })

  it('keeps internal Task-to-Node edges hidden while a chromeless Task is selected', async () => {
    const canvasDocument = fixtureDocument()
    canvasDocument.edges.push(
      {
        id: 'edge-produced',
        from: { kind: 'task', id: 'task-single' },
        to: { kind: 'node', id: 'node-single' },
        relation: 'references',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-control',
        from: { kind: 'node', id: 'node-single' },
        to: { kind: 'node', id: 'node-top' },
        relation: 'references',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
    )
    const { store, host } = await createSubject(undefined, canvasDocument)

    expect(host.querySelectorAll('[data-edge-bundle-count]')).toHaveLength(1)

    act(() => store.setSelection([{ kind: 'task', id: 'task-single' }]))
    expect(host.querySelector('[data-task-id="task-single"] [data-task-border]')).toBeNull()
    expect(host.querySelectorAll('[data-edge-bundle-count]')).toHaveLength(1)
  })

  it('routes an edge targeting a chromeless Task to its visible output Node', async () => {
    const canvasDocument = fixtureDocument()
    canvasDocument.edges.push({
      id: 'edge-to-chromeless-task',
      from: { kind: 'node', id: 'node-top' },
      to: { kind: 'task', id: 'task-single' },
      relation: 'references',
      contextRole: 'full',
      origin: { kind: 'user' },
    })
    const { store, host } = await createSubject(undefined, canvasDocument)
    const target = canvasDocument.nodes.find((node) => node.id === 'node-single')!
    const expectedX = target.frame.x + target.frame.w
    const expectedY = target.frame.y + target.frame.h / 2
    const bundle = [...host.querySelectorAll<SVGGElement>('[data-edge-bundle-count]')]
      .find((entry) => entry.getAttribute('aria-label')?.startsWith('引用连接'))
    expect(bundle).not.toBeNull()
    const visiblePath = bundle?.querySelector('path:not([stroke="transparent"])')
    expect(visiblePath?.getAttribute('d')).toMatch(
      new RegExp(`, ${expectedX} ${expectedY}$`),
    )

    act(() => store.setSelection([{ kind: 'task', id: 'task-single' }]))
    expect(host.querySelector('[data-task-id="task-single"] [data-task-border]')).toBeNull()
    const selectedBundle = [...host.querySelectorAll<SVGGElement>('[data-edge-bundle-count]')]
      .find((entry) => entry.getAttribute('aria-label')?.startsWith('引用连接'))
    expect(selectedBundle?.querySelector('path:not([stroke="transparent"])')
      ?.getAttribute('d')).toMatch(new RegExp(`, ${expectedX} ${expectedY}$`))
  })

  it('opens the creation menu at the drop point when a wire is dragged to blank canvas', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const port = required<HTMLButtonElement>(host, '[data-selection-port="right"]')
    const nodeCountBefore = store.getSnapshot().document.nodes.length

    act(() => dispatchPointer(port, 'pointerdown', { clientX: 600, clientY: 200 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 640, clientY: 240 }))
    // 拖拽中：虚线跟随光标
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 700, clientY: 400 }))

    const menu = required<HTMLElement>(host, '[data-create-node-menu]')
    expect(menu.textContent).toContain('从“说明文字”新建节点')
    // 菜单打开期间虚线保持（创建后无缝变成真实连线）
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()
    const textItem = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '文本')
    if (!textItem) throw new Error('Missing text node menu item')
    await act(async () => textItem.click())

    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore + 1)
    })
    const created = store.getSnapshot().document.nodes.at(-1)!
    // 落点（世界坐标 650,380）：新节点居中落在落点，而不是固定挂在某一侧
    expect(created.frame).toMatchObject({ x: 490, y: 340, w: 320, h: 256 })
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.edges.some((edge) =>
        edge.from.kind === 'node' && edge.from.id === 'node-single'
        && edge.to.kind === 'node' && edge.to.id === created.id)).toBe(true)
    })
    expect(host.querySelector('[data-create-node-menu]')).toBeNull()
  })

  it('cleans up a cancelled wire drag and allows the next drag to start', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const port = required<HTMLButtonElement>(host, '[data-selection-port="right"]')

    act(() => dispatchPointer(port, 'pointerdown', { clientX: 600, clientY: 200 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 640, clientY: 240 }))
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()

    act(() => dispatchPointer(window, 'pointercancel', { clientX: 640, clientY: 240 }))
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).toBeNull()

    act(() => dispatchPointer(port, 'pointerdown', { clientX: 600, clientY: 200 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 650, clientY: 260 }))
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()
    act(() => dispatchPointer(window, 'pointercancel', { clientX: 650, clientY: 260 }))
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).toBeNull()
  })

  it('opens the creation menu and connects every member when a compound wire is dropped on blank canvas', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const port = required<HTMLButtonElement>(host, '[data-selection-port="right"]')
    const nodeCountBefore = store.getSnapshot().document.nodes.length

    act(() => dispatchPointer(port, 'pointerdown', { clientX: 900, clientY: 520 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 960, clientY: 560 }))
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 1100, clientY: 600 }))

    const menu = required<HTMLElement>(host, '[data-create-node-menu]')
    expect(menu.textContent).toContain('从“组合节点 · 2 项”新建节点')
    expect(host.querySelector('path[stroke-dasharray="5 4"]')).not.toBeNull()
    const textItem = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '文本')
    if (!textItem) throw new Error('Missing text node menu item')
    await act(async () => textItem.click())

    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore + 1)
    })
    const created = store.getSnapshot().document.nodes.at(-1)!
    await vi.waitFor(() => {
      const incoming = store.getSnapshot().document.edges.filter((edge) =>
        edge.to.kind === 'node' && edge.to.id === created.id)
      expect(incoming).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: { kind: 'node', id: 'node-image' },
          relation: 'source',
          contextRole: 'full',
        }),
        expect.objectContaining({
          from: { kind: 'node', id: 'node-code' },
          relation: 'source',
          contextRole: 'full',
        }),
      ]))
    })
    expect(host.querySelector('[data-create-node-menu]')).toBeNull()
  })

  it('completes a connection when a wire is dropped onto another node', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const port = required<HTMLButtonElement>(host, '[data-selection-port="right"]')
    const target = required<HTMLElement>(host, '[data-node-id="node-top"]')
    const doc = document as Document & {
      elementFromPoint?: (x: number, y: number) => Element | null
    }
    const originalElementFromPoint = doc.elementFromPoint
    doc.elementFromPoint = () => target
    try {
      act(() => dispatchPointer(port, 'pointerdown', { clientX: 600, clientY: 200 }))
      act(() => dispatchPointer(window, 'pointermove', { clientX: 660, clientY: 260 }))
      await act(async () => dispatchPointer(window, 'pointerup', { clientX: 660, clientY: 260 }))

      await vi.waitFor(() => {
        expect(store.getSnapshot().document.edges.some((edge) =>
          edge.from.kind === 'node' && edge.from.id === 'node-single'
          && edge.to.kind === 'node' && edge.to.id === 'node-top')).toBe(true)
      })
      expect(host.querySelector('[data-create-node-menu]')).toBeNull()
    } finally {
      doc.elementFromPoint = originalElementFromPoint
    }
  })

  it('toggles text marks from the selection toolbar instead of prompt chips', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([{ kind: 'node', id: 'node-single' }]))
    const toolbar = required<HTMLElement>(host, '[aria-label="所选节点工具栏"]')
    for (const mark of ['bold', 'italic', 'h1', 'h2']) {
      expect(toolbar.querySelector(`[data-node-mark="${mark}"]`)).not.toBeNull()
    }
    // 文本节点不再显示改写类指令 chips（它们留在输入区）
    expect(toolbar.textContent).not.toContain('改写')

    const payloadOf = () => store.getSnapshot().document.nodes
      .find((node) => node.id === 'node-single')?.payload

    await act(async () => required<HTMLButtonElement>(host, '[data-node-mark="bold"]').click())
    await vi.waitFor(() => expect(payloadOf()?.bold).toBe(true))
    expect(required(host, '[data-node-mark="bold"]').getAttribute('aria-pressed')).toBe('true')
    const text = required<HTMLElement>(host, '[data-node-id="node-single"] [data-no-drag] > div')
    expect(text.style.fontWeight).toBe('600')

    await act(async () => required<HTMLButtonElement>(host, '[data-node-mark="h1"]').click())
    await vi.waitFor(() => expect(payloadOf()?.heading).toBe(1))
    // 标题级别互斥：H2 替换 H1；再次点击取消
    await act(async () => required<HTMLButtonElement>(host, '[data-node-mark="h2"]').click())
    await vi.waitFor(() => expect(payloadOf()?.heading).toBe(2))
    await act(async () => required<HTMLButtonElement>(host, '[data-node-mark="h2"]').click())
    await vi.waitFor(() => expect(payloadOf()?.heading).toBeUndefined())
    expect(payloadOf()?.bold).toBe(true)
  })

  it('hides the type-specific toolbar on an empty output slot until content arrives', async () => {
    const canvasDocument = fixtureDocument()
    canvasDocument.nodes.push(
      {
        id: 'node-empty-slot',
        type: 'text',
        frame: { x: 1040, y: 320, w: 320, h: 200, z: 5 },
        title: '等待内容',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
      {
        id: 'node-empty-image',
        type: 'image',
        frame: { x: 1400, y: 320, w: 320, h: 240, z: 6 },
        title: '等待图像',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    )
    const { store, host } = await createSubject(undefined, canvasDocument)

    // 空输出槽（无产物 / 无正文 / 无 payload）：类型专属工具条无意义，隐藏；
    // 通用操作（提示词控件 / 复制 / 删除）保留
    act(() => store.setSelection([{ kind: 'node', id: 'node-empty-slot' }]))
    let toolbar = required<HTMLElement>(host, '[aria-label="所选节点工具栏"]')
    expect(toolbar.querySelector('[data-node-mark]')).toBeNull()
    expect(toolbar.textContent).not.toContain('改写')
    expect(toolbar.querySelector('[aria-label="打开节点提示词控件"]')).not.toBeNull()
    expect(toolbar.querySelector('[aria-label="复制所选节点"]')).not.toBeNull()
    expect(toolbar.querySelector('[aria-label="从画布移除所选节点"]')).not.toBeNull()

    // 空图像节点同样不显示类型专属指令 chips（生成变体等）
    act(() => store.setSelection([{ kind: 'node', id: 'node-empty-image' }]))
    toolbar = required<HTMLElement>(host, '[aria-label="所选节点工具栏"]')
    expect(toolbar.textContent).not.toContain('生成变体')

    // 生成结束、内容出现后：类型专属工具条恢复显示
    await act(async () => {
      await store.dispatchCommand({
        type: 'UpdateNodeContent',
        nodeId: 'node-empty-slot',
        patch: { text: '生成的正文' },
      })
    })
    act(() => store.setSelection([{ kind: 'node', id: 'node-empty-slot' }]))
    await vi.waitFor(() => {
      expect(required(host, '[aria-label="所选节点工具栏"]')
        .querySelector('[data-node-mark="bold"]')).not.toBeNull()
    })
  })

  it('opens the artifact viewer panel from the inline preview', async () => {
    const { host } = await createSubject()
    let open: HTMLButtonElement | null = null
    await vi.waitFor(() => {
      open = host.querySelector<HTMLButtonElement>('[aria-label="打开产物结果预览"]')
      expect(open).not.toBeNull()
    })
    await act(async () => open!.click())

    const viewer = required<HTMLElement>(host, '[data-testid="canvas-artifact-viewer"]')
    expect(viewer.textContent).toContain('结果预览')
    expect(viewer.querySelector('img')).not.toBeNull()

    await act(async () => required<HTMLButtonElement>(
      viewer,
      '[aria-label="关闭产物查看面板"]',
    ).click())
    expect(host.querySelector('[data-testid="canvas-artifact-viewer"]')).toBeNull()
  })

  it('keeps an active Task artifact viewer read-only', async () => {
    const { store, host } = await createSubject()
    act(() => store.setTaskRuntime({
      taskId: 'task-multi',
      runId: 'run-multi-active',
      phase: 'running',
      ghosts: [],
    }))
    let open: HTMLButtonElement | null = null
    await vi.waitFor(() => {
      open = host.querySelector<HTMLButtonElement>('[aria-label="打开产物结果预览"]')
      expect(open).not.toBeNull()
    })
    await act(async () => open!.click())

    const viewer = required<HTMLElement>(host, '[data-testid="canvas-artifact-viewer"]')
    expect(viewer.querySelector('[data-testid="canvas-viewer-toolbar"]')).toBeNull()
  })

  it('closes the artifact drawer before focusing the node composer', async () => {
    const { host } = await createSubject(
      undefined,
      fixtureDocument(),
      undefined,
      testTaskRunLifecycle(),
    )
    let open: HTMLButtonElement | null = null
    await vi.waitFor(() => {
      open = host.querySelector<HTMLButtonElement>('[aria-label="打开产物结果预览"]')
      expect(open).not.toBeNull()
    })
    await act(async () => open!.click())
    const viewer = required<HTMLElement>(host, '[data-testid="canvas-artifact-viewer"]')

    await act(async () => {
      required<HTMLButtonElement>(viewer, '[aria-label="打开节点提示词控件"]').click()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(host.querySelector('[data-testid="canvas-artifact-viewer"]')).toBeNull()
    const composer = required<HTMLElement>(host, '[data-testid="canvas-context-composer"]')
    expect(composer.contains(document.activeElement)).toBe(true)
  })
})
