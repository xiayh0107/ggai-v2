// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type { CanvasTaskRunLifecycle } from '@/canvas/runProvider'
import type { CanvasRunLogViewerTab } from '@/canvas/runLogViewerContext'
import CanvasRunLogViewer from './CanvasRunLogViewer'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

type LogPage = {
  entries: readonly CanvasTaskRunLogEntry[]
  nextEventId: number | null
  closed: boolean
}

function fakeLifecycle(overrides: {
  pages?: LogPage[]
  summary?: CanvasTaskRunSummary
  readError?: unknown
}) {
  const pages = [...(overrides.pages ?? [])]
  const readTaskRunLog = vi.fn(async (...args: [string, number]): Promise<LogPage> => {
    void args
    if (overrides.readError) throw overrides.readError
    return pages.shift() ?? { entries: [], nextEventId: null, closed: true }
  })
  const lifecycle = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({
      recovering: false,
      recoveredScopeKeys: [],
      pendingPermissions: [],
      projectionReviews: [],
      nonFatalErrors: [],
    }),
    getRunLog: () => [],
    readTaskRunSummary: vi.fn(async (runId: string): Promise<CanvasTaskRunSummary> =>
      overrides.summary ?? {
        runId,
        taskId: 'task-1',
        agentId: 'codex',
        canvasBranch: 'main',
        status: 'done',
        startedAt: 1_700_000_000_000,
      }),
    readTaskRunLog,
  } as unknown as CanvasTaskRunLifecycle
  return { lifecycle, readTaskRunLog }
}

async function renderViewer(
  lifecycle: CanvasTaskRunLifecycle | null,
  initialTab: CanvasRunLogViewerTab = 'log',
) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasTaskRunContext.Provider value={lifecycle}>
        <CanvasRunLogViewer
          request={{ runId: 'run-log', title: '振奋之言', initialTab }}
          onClose={() => undefined}
        />
      </CanvasTaskRunContext.Provider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('CanvasRunLogViewer 详细运行日志', () => {
  it('按游标翻页读取持久日志，结构化渲染（工具卡片 / 分类标签 / meta 行），读到 close 后停止', async () => {
    const { lifecycle, readTaskRunLog } = fakeLifecycle({
      pages: [
        {
          entries: [
            { eventId: 1, kind: 'meta', text: '建立会话 session-1' },
            { eventId: 2, kind: 'thinking', text: '理解任务与上下文' },
            { eventId: 3, kind: 'tool', text: '→ write_file {"path":"a.md"}' },
            { eventId: 4, kind: 'tool', text: '← ok' },
          ],
          nextEventId: 4,
          closed: false,
        },
        {
          entries: [
            { eventId: 5, kind: 'text', text: '心有所向，何惧路长！' },
            { eventId: 6, kind: 'meta', text: '运行结束 · done' },
          ],
          nextEventId: null,
          closed: true,
        },
      ],
    })
    await renderViewer(lifecycle)

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('运行结束 · done')
    })
    expect(readTaskRunLog.mock.calls.map(([, after]) => after)).toEqual([0, 4])
    // meta 行与分类标签
    expect(container?.textContent).toContain('建立会话 session-1')
    expect(container?.textContent).toContain('理解任务与上下文')
    // 工具调用合并成卡片：名称 + 等宽命令 + 可展开的结果计数
    expect(container?.textContent).toContain('write_file')
    expect(container?.textContent).toContain('{"path":"a.md"}')
    expect(container?.textContent).toContain('1 条结果')
    expect(container?.textContent).not.toContain('→ write_file')
    expect(container?.textContent).toContain('心有所向，何惧路长！')
    expect(container?.textContent).toContain('6 条')
    expect(container?.textContent).toContain('已完成')
    // 头部动作：复制日志 / 刷新 / 关闭；页签：日志 / 过程
    expect(container?.textContent).toContain('复制日志')
    expect(container?.querySelector('[aria-label="刷新运行日志"]')).not.toBeNull()
    expect(container?.querySelector('[aria-label="关闭运行日志面板"]')).not.toBeNull()
    // 右侧抽屉形态（不再是居中弹窗）
    const drawer = container!.querySelector<HTMLElement>(
      '[data-testid="canvas-run-log-viewer"]',
    )!
    expect(drawer.className).toContain('right-0')
    // 读到 close 后不再轮询
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readTaskRunLog).toHaveBeenCalledTimes(2)

    // 「过程」页签：友好步骤序列
    const processTab = [...container!.querySelectorAll('button')]
      .find((button) => button.textContent === '过程')!
    await act(async () => processTab.click())
    expect(container?.textContent).toContain('理解任务与上下文')
    expect(container?.textContent).toContain('生成内容')
  })

  it('从节点的“查看过程”入口打开时默认展示过程，同一 Run 改从日志入口打开会切换页签', async () => {
    const entries: CanvasTaskRunLogEntry[] = [
      { eventId: 1, kind: 'thinking', text: '理解任务与上下文' },
      { eventId: 2, kind: 'text', text: '向前一步' },
    ]
    const { lifecycle } = fakeLifecycle({
      pages: [{ entries, nextEventId: null, closed: true }],
    })
    await renderViewer(lifecycle, 'process')

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('生成内容')
    })
    let processTab = [...container!.querySelectorAll('button')]
      .find((button) => button.textContent === '过程')!
    let logTab = [...container!.querySelectorAll('button')]
      .find((button) => button.textContent === '日志')!
    const tablist = container?.querySelector('[role="tablist"]')
    const panel = container?.querySelector('[role="tabpanel"]')
    expect(tablist?.getAttribute('aria-label')).toBe('运行详情视图')
    expect(processTab.getAttribute('role')).toBe('tab')
    expect(processTab.getAttribute('aria-selected')).toBe('true')
    expect(logTab.getAttribute('aria-selected')).toBe('false')
    expect(processTab.getAttribute('aria-controls')).toBe(panel?.id)
    expect(panel?.getAttribute('aria-labelledby')).toBe(processTab.id)

    await act(async () => {
      processTab.focus()
      processTab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }))
    })
    expect(logTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(logTab)

    // 手动回到过程页，再验证新入口请求的切换。
    await act(async () => processTab.click())

    // Stage 以 runId 复用抽屉组件；请求变更也必须尊重新入口。
    await act(async () => {
      root?.render(
        <CanvasTaskRunContext.Provider value={lifecycle}>
          <CanvasRunLogViewer
            request={{ runId: 'run-log', title: '振奋之言', initialTab: 'log' }}
            onClose={() => undefined}
          />
        </CanvasTaskRunContext.Provider>,
      )
      await Promise.resolve()
    })
    processTab = [...container!.querySelectorAll('button')]
      .find((button) => button.textContent === '过程')!
    logTab = [...container!.querySelectorAll('button')]
      .find((button) => button.textContent === '日志')!
    expect(processTab.getAttribute('aria-selected')).toBe('false')
    expect(logTab.getAttribute('aria-selected')).toBe('true')
    expect(container?.textContent).toContain('向前一步')
  })

  it('抽屉将等待确认与取消表达为独立语义，不冒充进行中或完成', async () => {
    const permission = fakeLifecycle({
      pages: [{ entries: [], nextEventId: null, closed: false }],
      summary: {
        runId: 'run-log',
        taskId: 'task-1',
        agentId: 'codex',
        canvasBranch: 'main',
        status: 'awaiting-permission',
        startedAt: 1_700_000_000_000,
      },
    })
    await renderViewer(permission.lifecycle, 'process')
    await vi.waitFor(() => expect(container?.textContent).toContain('等待确认'))
    expect(container?.querySelector('.text-gg-warning')).not.toBeNull()

    const cancelled = fakeLifecycle({
      pages: [{ entries: [], nextEventId: null, closed: true }],
      summary: {
        runId: 'run-log',
        taskId: 'task-1',
        agentId: 'codex',
        canvasBranch: 'main',
        status: 'cancelled',
        startedAt: 1_700_000_000_000,
      },
    })
    await act(async () => {
      root?.render(
        <CanvasTaskRunContext.Provider value={cancelled.lifecycle}>
          <CanvasRunLogViewer
            request={{ runId: 'run-log', title: '振奋之言', initialTab: 'process' }}
            onClose={() => undefined}
          />
        </CanvasTaskRunContext.Provider>,
      )
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container?.textContent).toContain('已取消'))
    const cancelledPill = [...container!.querySelectorAll('span')]
      .find((entry) => entry.textContent?.trim() === '已取消')
    expect(cancelledPill?.className).toContain('text-gg-muted')
    expect(cancelledPill?.className).not.toContain('text-gg-success')
  })

  it('读取失败时给出错误与重试', async () => {
    const { lifecycle, readTaskRunLog } = fakeLifecycle({
      readError: new Error('daemon 暂不可用'),
    })
    await renderViewer(lifecycle)

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('daemon 暂不可用')
    })
    const retry = container?.querySelector<HTMLButtonElement>('button')
    expect([...container!.querySelectorAll('button')].some((button) =>
      button.textContent === '重试')).toBe(true)
    void retry
    await act(async () => {
      ;[...container!.querySelectorAll('button')]
        .find((button) => button.textContent === '重试')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(readTaskRunLog.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('无运行管理上下文时给出明确提示', async () => {
    await renderViewer(null)
    expect(container?.textContent).toContain('无法读取日志')
  })
})
