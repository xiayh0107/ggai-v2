// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

async function createSubject(view?: Partial<CanvasV2ViewState>) {
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
  const canvasDocument = fixtureDocument()
  const store = new CanvasV2Store({
    daemonBaseUrl,
    scope,
    persistence,
    client: {
      getCanvas: async () => ({
        branch: 'main',
        revision: 0,
        updatedAt: '2026-08-05T00:00:00.000Z',
        lastMutationId: null,
        document: canvasDocument,
      }),
      flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
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
