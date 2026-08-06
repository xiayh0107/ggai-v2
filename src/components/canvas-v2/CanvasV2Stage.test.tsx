// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCanvasCommandV2 } from '@/canvas-v2/commands'
import { TASK_OUTPUT_LAYOUT_V2, taskOutputFrameV2 } from '@/canvas-v2/layout'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from '@/canvas-v2/model'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
  type CanvasV2ViewState,
} from '@/canvas-v2/persistence'
import { CanvasV2Provider } from '@/canvas-v2/provider'
import { CanvasV2Store } from '@/canvas-v2/store'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import CanvasV2Stage from './CanvasV2Stage'

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

function fixtureDocument(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
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
  const singleFrame = taskOutputFrameV2(document.tasks[1].anchor, 0)
  const firstMultiFrame = taskOutputFrameV2(document.tasks[2].anchor, 0)
  const secondMultiFrame = taskOutputFrameV2(document.tasks[2].anchor, 1)
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

function collectionFixture(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
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

function oversizedCollectionMacroFixture(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
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
  view?: Partial<CanvasV2ViewState>,
  canvasDocument = fixtureDocument(),
  reloadDocument?: CanvasDocumentV2,
) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    schemaVersion: 2,
    runId: 'run-multi',
    artifactId,
    mediaType: 'image/png',
    size: 42,
    contentDigest: 'c'.repeat(64),
  }), { headers: { 'Content-Type': 'application/json' } })))
  const persistence = new CanvasV2Persistence({
    adapter: new MemoryCanvasV2PersistenceAdapter(),
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
  const store = new CanvasV2Store({
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
          serverDocument = applyCanvasCommandV2(serverDocument, entry.command)
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
      <CanvasV2Provider store={store}>
        <CanvasV2Stage />
      </CanvasV2Provider>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return { store, host: container }
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
}

describe('Canvas V2 interactive stage', () => {
  it('renders each task container form, run-owned artifacts, collapse summaries, and ghosts', async () => {
    const { store, host } = await createSubject({ camera: { x: 17, y: 23, zoom: 1 } })

    expect(required(host, '[data-testid="canvas-v2-world"]').getAttribute('style'))
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
    expect(required<HTMLElement>(ghost, '.gg-shimmer').className)
      .toContain('motion-reduce:[&_*]:animate-none')
    expect(required(host, '[data-task-id="task-empty"] [data-task-status="generating"]'))
      .not.toBeNull()
    await vi.waitFor(() => {
      expect(required(host, '[data-testid="canvas-v2-live-region"]').textContent)
        .toContain('正在生成预览')
    })
  })

  it('keeps typed selection and focus while providing a roving entity tabindex', async () => {
    const { store, host } = await createSubject()
    const emptyTask = required<HTMLButtonElement>(host, '[data-focus-key="task:task-empty"]')
    const singleNode = required<HTMLButtonElement>(host, '[data-focus-key="node:node-single"]')
    expect(emptyTask.tabIndex).toBe(0)
    expect(singleNode.tabIndex).toBe(-1)

    act(() => dispatchPointer(emptyTask, 'pointerdown', { clientX: 90, clientY: 70 }))
    act(() => dispatchPointer(window, 'pointerup', { clientX: 90, clientY: 70 }))
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'task', id: 'task-empty' }])
    expect(document.activeElement).toBe(emptyTask)

    act(() => dispatchPointer(singleNode, 'pointerdown', {
      clientX: 650,
      clientY: 180,
      shiftKey: true,
    }))
    expect(store.getSnapshot().view.selection).toEqual([
      { kind: 'task', id: 'task-empty' },
      { kind: 'node', id: 'node-single' },
    ])
    expect(document.activeElement).toBe(singleNode)
    const hull = required<HTMLElement>(host, '[data-testid="canvas-v2-selection-hull"]')
    expect(hull.getAttribute('data-selection-count')).toBe('2')
    expect(hull.querySelectorAll('[data-selection-port]')).toHaveLength(4)
    expect(required(host, '[data-testid="canvas-v2-selection-toolbar"]')
      .getAttribute('data-selection-mode')).toBe('compound')

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

  it('moves a temporary multi-selection as one view-only large node', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const beforeCollections = structuredClone(store.getSnapshot().document.collections)
    const hull = required<HTMLElement>(host, '[data-testid="canvas-v2-selection-hull"]')
    const image = required<HTMLElement>(host, '[data-node-id="node-image"]')
    const code = required<HTMLElement>(host, '[data-node-id="node-code"]')
    expect(image.dataset.compoundSelected).toBe('true')
    expect(code.dataset.compoundSelected).toBe('true')
    expect(hull.querySelectorAll('[data-selection-port]')).toHaveLength(4)

    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'group-move' })
    const imageHandle = required<HTMLElement>(host, '[data-focus-key="node:node-image"]')
    act(() => dispatchPointer(imageHandle, 'pointerdown', { clientX: 100, clientY: 100 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 145, clientY: 125 }))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 145, clientY: 125 }))

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
    expect(required(host, '[data-testid="canvas-v2-selection-hull"]')
      .className).toContain('pointer-events-none')
    expect(rightPort.className).toContain('pointer-events-auto')
    await act(async () => rightPort.click())
    expect(rightPort.getAttribute('aria-pressed')).toBe('true')
    expect(required(host, '[data-selection-port="left"]')
      .getAttribute('aria-pressed')).toBe('false')
    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="从节点独立资料开始或完成连接"]',
    ).click())

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CreateEdges',
      edges: expect.arrayContaining([
        expect.objectContaining({
          from: { kind: 'node', id: 'node-image' },
          to: { kind: 'node', id: 'node-top' },
          relation: 'references',
          contextRole: 'full',
        }),
        expect.objectContaining({
          from: { kind: 'node', id: 'node-code' },
          to: { kind: 'node', id: 'node-top' },
          relation: 'references',
          contextRole: 'full',
        }),
      ]),
    })))
  })

  it('returns focus to the stage when the temporary large node is dismissed', async () => {
    const { store, host } = await createSubject()
    act(() => store.setSelection([
      { kind: 'node', id: 'node-image' },
      { kind: 'node', id: 'node-code' },
    ]))
    const toolbar = required<HTMLElement>(host, '[data-testid="canvas-v2-selection-toolbar"]')
    expect(toolbar.getAttribute('role')).toBe('group')
    const dismiss = required<HTMLButtonElement>(toolbar, '[aria-label="取消临时成组"]')
    dismiss.focus()

    await act(async () => dismiss.click())

    expect(store.getSnapshot().view.selection).toEqual([])
    expect(document.activeElement).toBe(required(host, '[data-testid="canvas-v2-stage"]'))
  })

  it('keeps camera, selection, and Task focus across materialization shape changes', async () => {
    const initialDocument = fixtureDocument()
    const materializedDocument = structuredClone(initialDocument)
    const task = materializedDocument.tasks.find((entry) => entry.id === 'task-empty')!
    materializedDocument.nodes.push({
      id: 'node-materialized',
      type: 'text',
      frame: { ...taskOutputFrameV2(task.anchor, 0), z: 5 },
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
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    act(() => {
      store.setCamera({ x: -280, y: 165, zoom: 1.55 })
      store.setSelection([{ kind: 'task', id: 'task-empty' }])
      before.focus()
    })
    expect(document.activeElement).toBe(before)

    await act(async () => {
      await store.reload()
    })

    const after = required<HTMLButtonElement>(host, '[data-focus-key="task:task-empty"]')
    expect(after).not.toBe(before)
    expect(required(host, '[data-task-id="task-empty"]').getAttribute('data-container-kind'))
      .toBe('title-strip')
    expect(document.activeElement).toBe(after)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(store.getSnapshot().view).toMatchObject({
      camera: { x: -280, y: 165, zoom: 1.55 },
      selection: [{ kind: 'task', id: 'task-empty' }],
    })
    expect(required(host, '[data-testid="canvas-v2-world"]').getAttribute('style'))
      .toContain('translate(-280px, 165px) scale(1.55)')
  })

  it('commits one task move, one node move, and one resize only on pointerup', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const dispatch = vi.spyOn(store, 'dispatchCommand').mockResolvedValue({ mutationId: 'ui-test' })
    const task = required<HTMLButtonElement>(host, '[data-focus-key="task:task-single"]')

    act(() => dispatchPointer(task, 'pointerdown', { clientX: 100, clientY: 100 }))
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

    dispatch.mockClear()
    const node = required<HTMLButtonElement>(host, '[data-focus-key="node:node-single"]')
    act(() => dispatchPointer(node, 'pointerdown', { clientX: 200, clientY: 200 }))
    act(() => dispatchPointer(window, 'pointermove', { clientX: 180, clientY: 240 }))
    await act(async () => dispatchPointer(window, 'pointerup', { clientX: 180, clientY: 240 }))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'MoveEntities',
      entities: [{ kind: 'node', id: 'node-single' }],
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
      w: TASK_OUTPUT_LAYOUT_V2.width + 60,
      h: TASK_OUTPUT_LAYOUT_V2.height + 40,
    })
  })

  it('pans and zooms only branch view state and supports additive Shift marquee', async () => {
    const { store, host } = await createSubject({ camera: { x: 0, y: 0, zoom: 1 } })
    const stage = required<HTMLElement>(host, '[data-testid="canvas-v2-stage"]')
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
    expect(required(host, '[data-testid="canvas-v2-marquee"]')).not.toBeNull()
    act(() => dispatchPointer(window, 'pointerup', {
      clientX: 1040,
      clientY: 430,
      shiftKey: true,
    }))
    expect(store.getSnapshot().view.selection).toEqual(expect.arrayContaining([
      { kind: 'node', id: 'node-top' },
      { kind: 'task', id: 'task-single' },
      { kind: 'node', id: 'node-single' },
    ]))
  })

  it('explicitly saves a typed top-level selection as a collection and undoes through commands', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([
      { kind: 'task', id: 'task-empty' },
      { kind: 'node', id: 'node-top' },
    ]))

    const save = required<HTMLButtonElement>(host, '[data-testid="save-selection-collection"]')
    expect(save.disabled).toBe(false)
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

    const undo = required<HTMLButtonElement>(host, '[data-testid="canvas-v2-undo"] button')
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
    const assign = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('加入集合'))
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
      '[data-testid="canvas-v2-undo"] button',
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
      '[data-testid="canvas-v2-undo"] button',
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
      '[data-testid="canvas-v2-undo"] button',
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

    await act(async () => required<HTMLButtonElement>(
      host,
      '[data-testid="create-node-menu-button"]',
    ).click())
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
      '[data-testid="canvas-v2-undo"] button',
    ).click())
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.length).toBe(nodeCountBefore)
    })

    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="说明文字节点菜单"]',
    ).click())
    const detach = [...required<HTMLElement>(host, '[role="menu"]')
      .querySelectorAll('button')]
      .find((button) => button.textContent === '移出任务')
    if (!detach) throw new Error('Missing detach node action')
    await act(async () => detach.click())
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
      '[data-testid="canvas-v2-undo"] button',
    ).click())
    await vi.waitFor(() => {
      expect(store.getSnapshot().document.nodes.find((node) => node.id === 'node-single')
        ?.homeTaskId).toBe('task-single')
    })
  })

  it('creates typed collection-macro edges with separate relation and context controls', async () => {
    const { store, host } = await createSubject(undefined, collectionFixture())
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const context = required<HTMLSelectElement>(host, '[aria-label="连接 contextRole"]')
    act(() => {
      context.value = 'summary'
      context.dispatchEvent(new Event('change', { bubbles: true }))
    })

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
      edges: [
        { relation: 'references', contextRole: 'summary' },
        { relation: 'references', contextRole: 'summary' },
      ],
    })
    expect((createCall?.[0] as { edges: Array<{ from: { id: string } }> }).edges
      .map((edge) => edge.from.id).sort()).toEqual(['node-a', 'task-a'])
    const summaryEdge = [...host.querySelectorAll<SVGGElement>('[data-edge-bundle-count]')]
      .find((entry) => entry.getAttribute('aria-label')?.includes('上下文摘要'))
    expect(summaryEdge?.getAttribute('tabindex')).toBe('0')
    expect(summaryEdge?.textContent).toContain('引用 · 摘要')
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
      '[data-testid="canvas-v2-live-region"]',
    ).textContent).toContain('超过 500 条边'))
  })

  it('projects destructive deletion immediately, supports undo, and guards active tasks', async () => {
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    const nodeMenu = required<HTMLButtonElement>(host, '[aria-label="独立资料节点菜单"]')
    await act(async () => nodeMenu.click())
    const deleteNode = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!deleteNode) throw new Error('Missing node delete menu item')
    await act(async () => deleteNode.click())
    const dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    const confirm = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!confirm) throw new Error('Missing delete confirmation')
    await act(async () => confirm.click())
    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(dispatch.mock.calls.some(([command]) => command.type === 'DeleteNode')).toBe(false)

    const undo = required<HTMLButtonElement>(host, '[data-testid="canvas-v2-undo"] button')
    await act(async () => undo.click())
    expect(required(host, '[data-node-id="node-top"]')).not.toBeNull()
    expect(dispatch.mock.calls.some(([command]) => command.type === 'DeleteNode')).toBe(false)

    act(() => store.setTaskRuntime({
      taskId: 'task-empty',
      phase: 'running',
      message: '仍在运行',
      ghosts: [],
    }))
    const taskMenu = required<HTMLButtonElement>(host, '[aria-label="空任务任务菜单"]')
    await act(async () => taskMenu.click())
    const taskDelete = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除任务（保留产物）'))
    if (!taskDelete) throw new Error('Missing task delete menu item')
    await act(async () => taskDelete.click())
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    await vi.waitFor(() => expect(
      required(host, '[data-testid="canvas-v2-live-region"]').textContent,
    ).toContain('需要先取消'))
  })

  it('traps confirmation focus, closes with Escape, and restores a safe focus target', async () => {
    const { host } = await createSubject()
    const stage = required<HTMLElement>(host, '[data-testid="canvas-v2-stage"]')
    const trigger = required<HTMLButtonElement>(host, '[aria-label="独立资料节点菜单"]')
    expect(stage.getAttribute('role')).toBe('region')
    expect(stage.querySelector('[role="application"]')).toBeNull()
    act(() => trigger.focus())
    await act(async () => trigger.click())
    const deleteItem = [...required<HTMLElement>(host, '[role="menu"]')
      .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!deleteItem) throw new Error('Missing delete node menu item')
    await act(async () => deleteItem.click())

    const dialog = required<HTMLElement>(host, '[role="alertdialog"]')
    const [cancel, confirm] = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('canvas-v2-confirm-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('canvas-v2-confirm-detail')
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
    const deleteAgain = [...required<HTMLElement>(host, '[role="menu"]')
      .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!deleteAgain) throw new Error('Missing repeated delete node menu item')
    await act(async () => deleteAgain.click())
    const confirmAgain = [...required<HTMLElement>(host, '[role="alertdialog"]')
      .querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!confirmAgain) throw new Error('Missing repeated delete confirmation')
    await act(async () => confirmAgain.click())

    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(document.activeElement).toBe(stage)
    const undoStatus = required<HTMLElement>(host, '[data-testid="canvas-v2-undo"]')
    expect(undoStatus.getAttribute('role')).toBe('status')
    expect(undoStatus.textContent).toContain('已从画布移除')
  })

  it('restores the visual projection when a deferred destructive command is rejected', async () => {
    vi.useFakeTimers()
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
      .mockRejectedValue(new Error('precondition changed'))
    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="独立资料节点菜单"]',
    ).click())
    const deleteNode = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!deleteNode) throw new Error('Missing node delete action')
    await act(async () => deleteNode.click())
    const confirm = [...required<HTMLElement>(host, '[role="alertdialog"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!confirm) throw new Error('Missing node delete confirmation')
    await act(async () => confirm.click())
    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-top' })
    expect(required(host, '[data-node-id="node-top"]')).not.toBeNull()
    expect(required(host, '[data-testid="canvas-v2-live-region"]').textContent)
      .toContain('已恢复画布')
  })

  it('submits a visually projected destructive command only after the undo window', async () => {
    vi.useFakeTimers()
    const { store, host } = await createSubject()
    const dispatch = vi.spyOn(store, 'dispatchCommand')
    act(() => store.setSelection([{ kind: 'node', id: 'node-top' }]))
    await act(async () => required<HTMLButtonElement>(
      host,
      '[aria-label="独立资料节点菜单"]',
    ).click())
    const deleteNode = [...required<HTMLElement>(host, '[role="menu"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!deleteNode) throw new Error('Missing node delete action')
    await act(async () => deleteNode.click())
    const confirm = [...required<HTMLElement>(host, '[role="alertdialog"]').querySelectorAll('button')]
      .find((button) => button.textContent?.includes('删除节点'))
    if (!confirm) throw new Error('Missing node delete confirmation')
    await act(async () => confirm.click())
    expect(host.querySelector('[data-node-id="node-top"]')).toBeNull()
    expect(store.getSnapshot().view.selection).toEqual([{ kind: 'node', id: 'node-top' }])
    expect(dispatch).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(4_999))
    expect(dispatch).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(dispatch).toHaveBeenCalledWith({ type: 'DeleteNode', nodeId: 'node-top' })
    expect(store.getSnapshot().document.nodes.some((node) => node.id === 'node-top')).toBe(false)
    expect(store.getSnapshot().view.selection).toEqual([])
  })

  it('throttles live-region updates instead of announcing every run event', async () => {
    vi.useFakeTimers()
    const { store, host } = await createSubject()
    const live = required<HTMLElement>(host, '[data-testid="canvas-v2-live-region"]')

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
})
