// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasArtifactViewerRequest } from '@/canvas/artifactViewerContext'
import type { CanvasNode } from '@/canvas/model'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import CanvasArtifactViewer from './CanvasArtifactViewer'

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

function viewerRequest(kind: CanvasArtifactViewerRequest['kind']): CanvasArtifactViewerRequest {
  return {
    kind,
    title: '调研纪要',
    artifact: {
      runId: 'run-1',
      artifactId: 'artifact-1',
      mediaType: kind === 'image' ? 'image/png' : 'text/markdown',
      size: 512,
      contentDigest: 'd'.repeat(64),
      title: '调研纪要',
      url: 'http://127.0.0.1:7380/runs/run-1/artifacts/artifact-1/content',
    },
  }
}

async function renderViewer(
  request: CanvasArtifactViewerRequest,
  onClose = vi.fn(),
  extra: {
    node?: CanvasNode
    controlsLocked?: boolean
    nodeActions?: string[]
    onToggleNodeMark?: (markId: string) => void
    onNodeAction?: (prompt: string) => void
    onFocusComposer?: () => void
    onDuplicate?: () => void
    onDelete?: () => void
  } = {},
) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<CanvasArtifactViewer request={request} onClose={onClose} {...extra} />)
    await Promise.resolve()
  })
  return { host: container, onClose }
}

function textNodeFixture(payload?: Record<string, unknown>): CanvasNode {
  return {
    id: 'node-1',
    type: 'text',
    frame: { x: 0, y: 0, w: 320, h: 200, z: 1 },
    title: '振奋之言',
    artifactRefs: [],
    origin: { kind: 'user' },
    payload,
  }
}

describe('Canvas artifact viewer', () => {
  it('renders markdown artifacts inline and closes via button and Escape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# 要点\n\n正文内容', {
      headers: { 'Content-Type': 'text/plain' },
    })))
    const onClose = vi.fn()
    const { host } = await renderViewer(viewerRequest('text'), onClose)

    await vi.waitFor(() => expect(host.textContent).toContain('正文内容'))
    expect(host.textContent).toContain('text/markdown')
    expect(host.textContent).toContain('512 B')
    // 抽屉容器带侧栏标识：画布滚轮缩放会跳过这个子树
    expect(host.querySelector('[data-canvas-side-panel]')).not.toBeNull()

    const close = host.querySelector<HTMLButtonElement>('[aria-label="关闭产物查看面板"]')
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows images without fetching text content', async () => {
    const fetchMock = vi.fn(async () => new Response(''))
    vi.stubGlobal('fetch', fetchMock)
    const { host } = await renderViewer(viewerRequest('image'))

    const image = host.querySelector('img')
    expect(image?.getAttribute('src')).toContain('/content')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to an external link for file artifacts', async () => {
    const fetchMock = vi.fn(async () => new Response(''))
    vi.stubGlobal('fetch', fetchMock)
    const { host } = await renderViewer(viewerRequest('file'))

    expect(host.textContent).toContain('该类型暂不支持内联查看')
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toContain('/content')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mirrors the full node toolbar with pressed states and styles the body with marks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('正文内容', {
      headers: { 'Content-Type': 'text/plain' },
    })))
    const onToggleNodeMark = vi.fn()
    const onFocusComposer = vi.fn()
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    const { host } = await renderViewer(viewerRequest('text'), vi.fn(), {
      node: textNodeFixture({ italic: true }),
      onToggleNodeMark,
      onFocusComposer,
      onDuplicate,
      onDelete,
    })

    const toolbar = host.querySelector('[data-testid="canvas-viewer-toolbar"]')
    expect(toolbar).not.toBeNull()
    // 与节点浮动工具条一致：提示词控件 + 格式标记 + 复制 + 删除
    expect(toolbar?.querySelector('[aria-label="打开节点提示词控件"]')).not.toBeNull()
    const italic = toolbar?.querySelector<HTMLButtonElement>('[data-node-mark="italic"]')
    const bold = toolbar?.querySelector<HTMLButtonElement>('[data-node-mark="bold"]')
    expect(italic?.getAttribute('aria-pressed')).toBe('true')
    expect(bold?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => bold!.click())
    expect(onToggleNodeMark).toHaveBeenCalledWith('bold')
    await act(async () => toolbar!.querySelector<HTMLButtonElement>(
      '[aria-label="打开节点提示词控件"]')!.click())
    expect(onFocusComposer).toHaveBeenCalledTimes(1)
    await act(async () => toolbar!.querySelector<HTMLButtonElement>(
      '[aria-label="复制所选节点"]')!.click())
    expect(onDuplicate).toHaveBeenCalledTimes(1)
    await act(async () => toolbar!.querySelector<HTMLButtonElement>(
      '[aria-label="从画布移除所选节点"]')!.click())
    expect(onDelete).toHaveBeenCalledTimes(1)

    // 正文套用节点 payload 里的格式标记（斜体）
    await vi.waitFor(() => expect(host.textContent).toContain('正文内容'))
    const body = host.querySelector<HTMLElement>('[data-canvas-side-panel] .space-y-2')
    expect(body?.style.fontStyle).toBe('italic')
  })

  it('shows type-specific action chips for nodes without marks', async () => {
    const fetchMock = vi.fn(async () => new Response(''))
    vi.stubGlobal('fetch', fetchMock)
    const onNodeAction = vi.fn()
    const imageNode: CanvasNode = { ...textNodeFixture(), type: 'image' }
    const { host } = await renderViewer(viewerRequest('image'), vi.fn(), {
      node: imageNode,
      nodeActions: ['生成图像', '更换风格', '生成变体', '提高分辨率'],
      onNodeAction,
    })

    const toolbar = host.querySelector('[data-testid="canvas-viewer-toolbar"]')
    expect(toolbar).not.toBeNull()
    expect(toolbar?.textContent).toContain('生成变体')
    const chip = Array.from(toolbar?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === '生成变体')
    await act(async () => chip!.click())
    expect(onNodeAction).toHaveBeenCalledWith('生成变体')
  })

  it('keeps an owned active artifact read-only while its Task controls the Run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('正文内容', {
      headers: { 'Content-Type': 'text/plain' },
    })))
    const onFocusComposer = vi.fn()
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    const { host } = await renderViewer(viewerRequest('text'), vi.fn(), {
      node: { ...textNodeFixture(), homeTaskId: 'task-1' },
      controlsLocked: true,
      onFocusComposer,
      onDuplicate,
      onDelete,
    })

    expect(host.querySelector('[data-testid="canvas-viewer-toolbar"]')).toBeNull()
    expect(onFocusComposer).not.toHaveBeenCalled()
    expect(onDuplicate).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(host.textContent).toContain('正文内容'))
  })
})
