// @vitest-environment jsdom
import { act } from 'react'
import type { ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileQuestion } from 'lucide-react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '@/canvas/model'
import { CanvasArtifactViewerContext } from '@/canvas/artifactViewerContext'
import { CanvasRunLogViewerContext } from '@/canvas/runLogViewerContext'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import {
  getPlugin,
  listCreatablePlugins,
  registerPlugin,
  type NodePlugin,
  unregisterPlugin,
} from '@/plugins/types'
import { LEGACY_NODE_CONTEXT_POLICY } from '@/plugins/contextContracts'
import { defineNodeUi } from '@/plugins/uiContracts'
import CanvasNodeCard from './CanvasNodeCard'

const artifactId = `artifact_${'a'.repeat(64)}`
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
  vi.unstubAllGlobals()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('CanvasNodeCard artifact projection', () => {
  it('renders community artifacts through the platform-owned template', async () => {
    const plugin: NodePlugin = {
      id: '@tests/notebook-view',
      label: 'Notebook',
      desc: 'Notebook artifact view',
      icon: FileQuestion,
      defaultWidth: 320,
      initialPayload: () => ({}),
      isEmpty: () => false,
      ui: defineNodeUi('file'),
      instr: { placeholder: 'Use notebook', actions: [] },
      nodeContext: structuredClone(LEGACY_NODE_CONTEXT_POLICY),
      artifactClaims: [{ extensions: ['.ipynb'] }],
    }
    registerPlugin(plugin)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-notebook',
      artifactId,
      mediaType: 'application/x-ipynb+json',
      size: 128,
      contentDigest: 'b'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } })))

    try {
      await renderNode({
        id: 'node-notebook',
        type: plugin.id,
        frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
        title: 'Analysis notebook',
        artifactRefs: [{ runId: 'run-notebook', artifactId }],
        origin: { kind: 'user' },
      })

      const artifact = container?.querySelector('[data-node-artifact-template="file"]')
      expect(artifact?.textContent).toContain('Analysis notebook')
      expect(artifact?.textContent).toContain('application/x-ipynb+json')
    } finally {
      unregisterPlugin(plugin.id)
    }
  })

  it('keeps the generic file fallback renderable but out of creation menus', async () => {
    expect(getPlugin('file').ui).toEqual(defineNodeUi('file'))
    expect(listCreatablePlugins().map(({ id }) => id)).not.toContain('file')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-file',
      artifactId,
      mediaType: 'application/octet-stream',
      size: 17,
      contentDigest: 'c'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } })))

    await renderNode({
      id: 'node-file',
      type: 'file',
      frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
      title: 'unknown.bin',
      artifactRefs: [{ runId: 'run-file', artifactId }],
      origin: { kind: 'user' },
    })

    expect(container?.textContent).toContain('application/octet-stream')
    expect(container?.querySelector<HTMLAnchorElement>('a')?.href).toContain(
      `/runs/run-file/artifacts/${artifactId}`,
    )
  })

  it('renders verified R source bytes inside the code artifact view', async () => {
    const fetchArtifact = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/metadata')) {
        return new Response(JSON.stringify({
          schemaVersion: 2,
          runId: 'run-r-source',
          artifactId,
          mediaType: 'text/x-r',
          size: 45,
          contentDigest: 'd'.repeat(64),
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('library(ggplot2)\nggplot(mtcars, aes(wt, mpg))', {
        headers: { 'Content-Type': 'text/x-r' },
      })
    })
    vi.stubGlobal('fetch', fetchArtifact)

    await renderNode({
      id: 'node-r-source',
      type: 'code',
      frame: { x: 0, y: 0, w: 360, h: 260, z: 1 },
      title: 'classic_scatter_plot.R',
      artifactRefs: [{ runId: 'run-r-source', artifactId }],
      origin: { kind: 'user' },
    })

    expect(container?.querySelector('pre')?.textContent).toContain('ggplot(mtcars')
    expect(fetchArtifact).toHaveBeenCalledTimes(2)
    expect(fetchArtifact.mock.calls.some(([input]) =>
      String(input).includes(`/runs/run-r-source/artifacts/${artifactId}?`))).toBe(true)
  })

  it('keeps selectable content independent from the node drag surface', async () => {
    const onDragStart = vi.fn()
    await renderNode({
      id: 'node-clickable-body',
      type: 'text',
      frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
      title: 'Clickable body',
      text: 'Clicking this content opens its node-local prompt surface.',
      artifactRefs: [],
      origin: { kind: 'user' },
    }, onDragStart)

    act(() => {
      container?.querySelector('[data-no-drag]')?.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }))
    })
    expect(onDragStart).not.toHaveBeenCalled()
  })
})

describe('CanvasNodeCard 即时预览与活动记录', () => {
  const textArtifactId = `artifact_${'c'.repeat(64)}`

  function stubTextArtifactFetch(body: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (new URL(url).pathname.endsWith('/metadata')) {
        return new Response(JSON.stringify({
          schemaVersion: 2,
          runId: 'run-text',
          artifactId: textArtifactId,
          mediaType: 'text/plain',
          size: body.length,
          contentDigest: 'd'.repeat(64),
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(body, { headers: { 'Content-Type': 'text/plain' } })
    }))
  }

  const textNode: CanvasNode = {
    id: 'node-text',
    type: 'text',
    frame: { x: 0, y: 0, w: 360, h: 260, z: 1 },
    title: '振奋之言',
    artifactRefs: [{ runId: 'run-text', artifactId: textArtifactId }],
    origin: {
      kind: 'agent-output',
      taskId: 'task-text',
      runId: 'run-text',
      planId: 'plan-1',
      outputKey: 'output-1',
    },
  }

  it('文本产物直接内联渲染正文，不再显示文件卡片与产物链接条', async () => {
    stubTextArtifactFetch('向前一步，**世界**就会为你的勇气让路！')
    await renderNode(textNode)

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('向前一步，')
    })
    expect(container?.querySelector('strong')?.textContent).toBe('世界')
    expect(container?.textContent).not.toContain('产物 1')
    expect(container?.textContent).not.toContain('text/plain ·')
    // Agent 产物节点底部有状态条（无运行上下文时为静态「已完成」）
    expect(container?.textContent).toContain('已完成')
  })

  it('产物文本节点即时套用选择工具条的格式标记（粗体 / 斜体 / 标题）', async () => {
    stubTextArtifactFetch('向前一步，世界就会为你的勇气让路！')
    await renderNode({
      ...textNode,
      payload: { bold: true, italic: true, heading: 1 },
    })

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('向前一步，')
    })
    const view = container?.querySelector<HTMLElement>('.select-text > div')
    expect(view).toBeTruthy()
    expect(view?.style.fontStyle).toBe('italic')
    expect(view?.style.fontWeight).toBe('600')
    expect(view?.className).toContain('text-[19px]')
  })

  it('活动条只保留一行状态，过程与日志分别打开抽屉的对应页签', async () => {
    const openRunLog = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasRunLogViewerContext.Provider value={openRunLog}>
          <CanvasNodeCard
            node={{ ...textNode, artifactRefs: [] }}
            projectDir="/project"
            selected={false}
            tabIndex={0}
            taskStatus={{ kind: 'done', label: '已完成', live: 'polite' }}
            taskRunId="run-text"
            onFocus={() => undefined}
            onKeyDown={() => undefined}
            onDragStart={() => undefined}
            onResizeStart={() => undefined}
            registerFocusable={() => undefined}
          />
        </CanvasRunLogViewerContext.Provider>,
      )
    })

    const card = container?.querySelector<HTMLElement>('[data-node-id="node-text"]')
    expect(card?.style.height).toBe('260px')
    expect(container?.querySelector('ol')).toBeNull()
    expect(container?.querySelector('[aria-expanded]')).toBeNull()
    expect(container?.querySelectorAll('[role="status"]')).toHaveLength(1)

    const process = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="查看振奋之言的生成过程"]',
    )
    const log = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="查看振奋之言的详细运行日志"]',
    )
    expect(process?.textContent).toContain('查看过程')
    expect(log?.textContent).toBe('')
    await act(async () => process!.click())
    expect(openRunLog).toHaveBeenLastCalledWith({
      runId: 'run-text',
      title: '振奋之言',
      initialTab: 'process',
    })
    await act(async () => log!.click())
    expect(openRunLog).toHaveBeenLastCalledWith({
      runId: 'run-text',
      title: '振奋之言',
      initialTab: 'log',
    })
  })

  it('生成中、需要处理、取消与完成状态均用单行语义明确呈现', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const renderStatus = async (
      taskStatus: ComponentProps<typeof CanvasNodeCard>['taskStatus'],
      taskRunId: string | undefined = 'run-text',
    ) => act(async () => {
      root?.render(
        <CanvasNodeCard
          node={{ ...textNode, artifactRefs: [] }}
          projectDir="/project"
          selected={false}
          tabIndex={0}
          taskStatus={taskStatus}
          taskRunId={taskRunId}
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          onDragStart={() => undefined}
          onResizeStart={() => undefined}
          registerFocusable={() => undefined}
        />,
      )
    })

    await renderStatus({ kind: 'queued', label: '等待运行', live: 'polite' })
    let status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('等待运行')
    expect(status?.className).toContain('text-gg-primary')
    expect(status?.getAttribute('aria-live')).toBe('off')

    await renderStatus({ kind: 'generating', label: '正在生成', live: 'polite' })
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('正在生成')
    expect(status?.className).toContain('text-gg-primary')
    expect(status?.querySelector('svg')?.className.baseVal).toContain('animate-spin')

    await renderStatus({ kind: 'needs-attention', label: '等待确认', live: 'assertive' })
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('等待确认')
    expect(status?.className).toContain('text-gg-warning')

    await renderStatus({ kind: 'partial', label: '部分完成', live: 'assertive' })
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('部分完成')
    expect(status?.className).toContain('text-gg-warning')

    await renderStatus({ kind: 'failed', label: '运行失败', live: 'assertive' })
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('运行失败')
    expect(status?.className).toContain('text-gg-danger')
    expect(status?.getAttribute('aria-live')).toBe('off')

    await renderStatus({ kind: 'cancelled', label: '已取消', live: 'polite' })
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('已取消')
    expect(status?.className).toContain('text-gg-muted')

    // 来源 Run 已不是任务当前 Run 时，节点仍稳定表达自身的完成态。
    await renderStatus({ kind: 'generating', label: '正在生成', live: 'polite' }, 'run-next')
    status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('已完成')
    expect(status?.className).toContain('text-gg-success')
    expect(container?.querySelector('ol')).toBeNull()
  })

  it('Task-owned 空输出槽也显示当前 Run 状态，不必等产物物化后才可查看过程', async () => {
    const openRunLog = vi.fn()
    const outputSlot: CanvasNode = {
      id: 'node-owned-slot',
      type: 'text',
      frame: { x: 0, y: 0, w: 360, h: 260, z: 1 },
      title: '等待生成的文本',
      artifactRefs: [],
      homeTaskId: 'task-owned-slot',
      origin: { kind: 'user' },
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasRunLogViewerContext.Provider value={openRunLog}>
          <CanvasNodeCard
            node={outputSlot}
            projectDir="/project"
            selected={false}
            tabIndex={0}
            taskStatus={{ kind: 'needs-attention', label: '等待确认', live: 'assertive' }}
            taskRunId="run-owned-slot"
            onFocus={() => undefined}
            onKeyDown={() => undefined}
            onDragStart={() => undefined}
            onResizeStart={() => undefined}
            registerFocusable={() => undefined}
          />
        </CanvasRunLogViewerContext.Provider>,
      )
    })

    const status = container?.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe('等待确认')
    expect(status?.className).toContain('text-gg-warning')
    expect(container?.textContent).not.toContain('等待内容')
    expect(container?.querySelector('[data-testid="canvas-empty-surface"]')).not.toBeNull()
    expect(container?.querySelector('ol')).toBeNull()

    // Active Task 的运行入口只存在于节点下方的单一控制面，节点活动条不再重复一套按钮。
    expect(container?.querySelector(
      'button[aria-label="查看等待生成的文本的生成过程"]',
    )).toBeNull()
    expect(container?.querySelector(
      'button[aria-label="查看等待生成的文本的详细运行日志"]',
    )).toBeNull()
    expect(openRunLog).not.toHaveBeenCalled()

    await act(async () => {
      root?.render(
        <CanvasNodeCard
          node={outputSlot}
          projectDir="/project"
          selected={false}
          tabIndex={0}
          taskStatus={{ kind: 'generating', label: '生成中', live: 'polite' }}
          taskRunId="run-owned-slot"
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          onDragStart={() => undefined}
          onResizeStart={() => undefined}
          registerFocusable={() => undefined}
        />,
      )
    })
    expect(container?.querySelector('[data-testid="canvas-generating-surface"]')).not.toBeNull()
    expect(container?.querySelector('[data-testid="canvas-generating-surface"]')?.className)
      .not.toContain('bg-gg-subtle')
    expect(container?.querySelector('[data-testid="canvas-empty-surface"]')).toBeNull()
    expect(container?.textContent).not.toContain('等待内容')

    await act(async () => {
      root?.render(
        <CanvasRunLogViewerContext.Provider value={openRunLog}>
          <CanvasNodeCard
            node={outputSlot}
            projectDir="/project"
            selected={false}
            tabIndex={0}
            taskStatus={{ kind: 'done', label: '已完成', live: 'polite' }}
            taskRunId="run-owned-slot"
            onFocus={() => undefined}
            onKeyDown={() => undefined}
            onDragStart={() => undefined}
            onResizeStart={() => undefined}
            registerFocusable={() => undefined}
          />
        </CanvasRunLogViewerContext.Provider>,
      )
    })
    const terminalStatus = container?.querySelector<HTMLElement>('[role="status"]')
    expect(terminalStatus?.textContent).toBe('未生成内容')
    expect(terminalStatus?.className).toContain('text-gg-warning')
    expect(terminalStatus?.className).not.toContain('text-gg-success')

    // 槽位已写入 agent-output 来源元数据、但仍无任何可见内容时，
    // 也不能因 origin 改变而冒充绿色完成态。
    await act(async () => {
      root?.render(
        <CanvasNodeCard
          node={{
            ...outputSlot,
            id: 'node-empty-agent-output',
            origin: {
              kind: 'agent-output',
              taskId: 'task-owned-slot',
              runId: 'run-owned-slot',
              planId: 'plan-empty',
              outputKey: 'empty-output',
            },
          }}
          projectDir="/project"
          selected={false}
          tabIndex={0}
          taskStatus={{ kind: 'done', label: '已完成', live: 'polite' }}
          taskRunId="run-owned-slot"
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          onDragStart={() => undefined}
          onResizeStart={() => undefined}
          registerFocusable={() => undefined}
        />,
      )
    })
    const emptyAgentStatus = container?.querySelector<HTMLElement>('[role="status"]')
    expect(emptyAgentStatus?.textContent).toBe('未生成内容')
    expect(emptyAgentStatus?.className).toContain('text-gg-warning')
  })
})

describe('CanvasNodeCard 多产物链接条', () => {
  const multiArtifactA = `artifact_${'e'.repeat(64)}`
  const multiArtifactB = `artifact_${'f'.repeat(64)}`

  function stubMultiFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(multiArtifactB)) {
        return new Response(JSON.stringify({
          schemaVersion: 2,
          runId: 'run-multi',
          artifactId: multiArtifactB,
          mediaType: 'image/png',
          size: 99,
          contentDigest: 'f'.repeat(64),
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        schemaVersion: 2,
        runId: 'run-multi',
        artifactId: multiArtifactA,
        mediaType: 'application/json',
        size: 12,
        contentDigest: 'e'.repeat(64),
      }), { headers: { 'Content-Type': 'application/json' } })
    })
  }

  const multiNode: CanvasNode = {
    id: 'node-multi',
    type: 'file',
    frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
    title: '双产物',
    artifactRefs: [
      { runId: 'run-multi', artifactId: multiArtifactA },
      { runId: 'run-multi', artifactId: multiArtifactB },
    ],
    origin: { kind: 'user' },
  }

  it('点击产物链接在画布内查看面板打开，并按媒体类型选择形态', async () => {
    vi.stubGlobal('fetch', stubMultiFetch())
    const openViewer = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasArtifactViewerContext.Provider value={openViewer}>
          <CanvasNodeCard
            node={multiNode}
            projectDir="/project"
            selected={false}
            tabIndex={0}
            onFocus={() => undefined}
            onKeyDown={() => undefined}
            onDragStart={() => undefined}
            onResizeStart={() => undefined}
            registerFocusable={() => undefined}
          />
        </CanvasArtifactViewerContext.Provider>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const link = await vi.waitFor(() => {
      const found = [...container!.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('产物 2'))
      expect(found).toBeTruthy()
      return found!
    })
    await act(async () => link.click())
    await vi.waitFor(() => expect(openViewer).toHaveBeenCalledTimes(1))
    expect(openViewer.mock.calls[0]![0]).toMatchObject({
      kind: 'image',
      title: '双产物 · 产物 2',
    })
    expect(openViewer.mock.calls[0]![0].artifact.url).toContain(multiArtifactB)
  })

  it('无查看面板 Provider 时退回新标签页外链', async () => {
    vi.stubGlobal('fetch', stubMultiFetch())
    await renderNode(multiNode)
    const anchor = await vi.waitFor(() => {
      const found = container?.querySelector<HTMLAnchorElement>('[aria-label="运行产物"] a')
      expect(found).toBeTruthy()
      return found!
    })
    expect(anchor.href).toContain(`/runs/run-multi/artifacts/${multiArtifactA}`)
    expect(anchor.target).toBe('_blank')
  })
})

describe('CanvasNodeCard 外壳按钮降噪', () => {
  async function renderQuietNode(selected: boolean, onMenuAction?: (node: CanvasNode, action: string) => void) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasNodeCard
          node={{
            id: 'node-quiet',
            type: 'text',
            frame: { x: 0, y: 0, w: 320, h: 200, z: 1 },
            title: '静心',
            text: '正文',
            artifactRefs: [],
            origin: { kind: 'user' },
          }}
          projectDir="/project"
          selected={selected}
          tabIndex={0}
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          onDragStart={() => undefined}
          onResizeStart={() => undefined}
          onMenuAction={onMenuAction}
          registerFocusable={() => undefined}
        />,
      )
      await Promise.resolve()
    })
  }

  it('右上角水平图标工具条替代⋯菜单，点击直接触发对应操作', async () => {
    const onMenuAction = vi.fn()
    await renderQuietNode(true, onMenuAction)

    // 头部连接端口已彻底移除（改由拖线 / 轻点卡片完成连接）
    expect(container!.querySelector('[aria-label="从节点静心开始或完成连接"]')).toBeNull()
    expect(container!.querySelector('[aria-label="静心节点菜单"]')).toBeNull()

    const bar = container!.querySelector('[aria-label="静心节点操作"]')
    expect(bar).not.toBeNull()
    const duplicate = bar!.querySelector<HTMLButtonElement>('[aria-label="复制节点"]')
    const remove = bar!.querySelector<HTMLButtonElement>('[aria-label="从画布移除"]')
    expect(duplicate).not.toBeNull()
    expect(remove).not.toBeNull()
    // 每个操作都是直观图标按钮
    expect(duplicate!.querySelector('svg')).not.toBeNull()
    expect(remove!.querySelector('svg')).not.toBeNull()

    await act(async () => duplicate!.click())
    expect(onMenuAction).toHaveBeenCalledTimes(1)
    expect(onMenuAction.mock.calls[0]![1]).toBe('duplicate')
    await act(async () => remove!.click())
    expect(onMenuAction.mock.calls[1]![1]).toBe('delete')

    // 选中时常显；调整大小手柄为无图标小方块
    expect(bar!.className).not.toContain('opacity-0')
    const grip = container!.querySelector('[data-node-resize="node-quiet"]')
    expect(grip).not.toBeNull()
    expect(grip!.querySelector('svg')).toBeNull()
    expect(grip!.className).toContain('h-3.5')
  })

  it('未选中时操作条静止透明，悬停 / 键盘聚焦才显现', async () => {
    await renderQuietNode(false, () => undefined)
    const bar = container!.querySelector('[aria-label="静心节点操作"]')
    expect(bar).not.toBeNull()
    expect(bar!.className).toContain('opacity-0')
    expect(bar!.className).toContain('group-hover:opacity-100')
    expect(bar!.className).toContain('focus-within:opacity-100')
  })
})

async function renderNode(
  node: CanvasNode,
  onDragStart: NonNullable<ComponentProps<typeof CanvasNodeCard>['onDragStart']>
    = () => undefined,
): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasNodeCard
        node={node}
        projectDir="/project"
        selected={false}
        tabIndex={0}
        onFocus={() => undefined}
        onKeyDown={() => undefined}
        onDragStart={onDragStart}
        onResizeStart={() => undefined}
        registerFocusable={() => undefined}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
