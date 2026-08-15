import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleMinus,
  Copy,
  Info,
  Lightbulb,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react'
import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type {
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import { activitiesFromRunLog } from '@/canvas/runLogActivities'
import type {
  CanvasRunLogViewerRequest,
  CanvasRunLogViewerTab,
} from '@/canvas/runLogViewerContext'
import CanvasRightDrawer from './CanvasRightDrawer'

const LIVE_POLL_INTERVAL_MS = 2_500
const MAX_PAGES_PER_PUMP = 8
const CLAMP_LENGTH = 180

/**
 * 详细运行日志：统一走右侧抽屉面板，读取 daemon 持久日志（刷新页面后仍可回看）。
 * 运行未结束时按游标轮询增量追加，读到终态 close 后停止。
 * 「日志」页签为结构化渲染（工具卡片 / 分类样式 / 长文折叠），「过程」页签为友好步骤。
 */
export default function CanvasRunLogViewer({
  request,
  onClose,
}: {
  request: CanvasRunLogViewerRequest
  onClose: () => void
}) {
  const lifecycle = useContext(CanvasTaskRunContext)
  const tabsId = useId()
  const processTabId = `${tabsId}-process-tab`
  const logTabId = `${tabsId}-log-tab`
  const tabPanelId = `${tabsId}-panel`
  const closeRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<CanvasTaskRunLogEntry[]>([])
  const [summary, setSummary] = useState<CanvasTaskRunSummary | null>(null)
  const [closed, setClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [tabSelection, setTabSelection] = useState<{
    request: CanvasRunLogViewerRequest
    tab: CanvasRunLogViewerTab
  }>({ request, tab: request.initialTab })
  // 一个新的打开请求必须尊重它的入口页签；用请求对象身份作为
  // 本地页签选择的边界，避免用 Effect 再同步一份 props 状态。
  const tab = tabSelection.request === request
    ? tabSelection.tab
    : request.initialTab
  const selectTab = (nextTab: CanvasRunLogViewerTab) => {
    setTabSelection({ request, tab: nextTab })
  }
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextTab: CanvasRunLogViewerTab | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextTab = tab === 'process' ? 'log' : 'process'
    } else if (event.key === 'Home') {
      nextTab = 'process'
    } else if (event.key === 'End') {
      nextTab = 'log'
    }
    if (!nextTab) return
    event.preventDefault()
    selectTab(nextTab)
    document.getElementById(nextTab === 'process' ? processTabId : logTabId)?.focus()
  }
  const [copied, setCopied] = useState(false)

  const retry = () => {
    setEntries([])
    setClosed(false)
    setLoading(true)
    setError(null)
    setRetryNonce((nonce) => nonce + 1)
  }

  const copyLog = () => {
    const text = entries.map((entry) => entry.text).join('\n\n')
    if (!text) return
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      // 剪贴板不可用时静默忽略，按钮仅作便捷入口
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!lifecycle) return
    let cancelled = false
    let timer: number | undefined
    let cursor = 0
    let sawClose = false

    const pump = async () => {
      try {
        for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_PUMP && !sawClose; pageIndex++) {
          const before = cursor
          const page = await lifecycle.readTaskRunLog(request.runId, cursor)
          if (cancelled) return
          if (page.entries.length > 0) {
            setEntries((current) => mergeLogEntries(current, page.entries))
            cursor = Math.max(cursor, ...page.entries.map((entry) => entry.eventId))
          }
          if (page.closed) {
            sawClose = true
            setClosed(true)
            break
          }
          if (page.nextEventId === null || page.nextEventId <= before) break
          cursor = Math.max(cursor, page.nextEventId)
        }
        if (cancelled) return
        setLoading(false)
        setError(null)
        if (!sawClose) timer = window.setTimeout(() => void pump(), LIVE_POLL_INTERVAL_MS)
      } catch (cause) {
        if (cancelled) return
        setLoading(false)
        setError(cause instanceof Error ? cause.message : '运行日志读取失败')
      }
    }

    void lifecycle.readTaskRunSummary(request.runId).then(
      (value) => {
        if (!cancelled) setSummary(value)
      },
      () => undefined, // 摘要缺失不阻塞日志本体
    )
    void pump()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [lifecycle, request.runId, retryNonce])

  // 新日志到达时，仅当用户本就停留在底部附近才跟随滚动。
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [entries, tab])

  const live = lifecycle !== null && !closed && !loading

  return (
    <CanvasRightDrawer
      ariaLabel={`Agent 运行详情：${request.title}`}
      testId="canvas-run-log-viewer"
      onClose={onClose}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-gg-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-gg-ink">
            运行详情 · {request.title}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-gg-muted">
            {summaryLine(summary, closed, entries.length)}
          </p>
        </div>
        <RunStatePill summary={summary} closed={closed} live={live} />
        <button
          type="button"
          onClick={copyLog}
          disabled={copied || entries.length === 0}
          title={copied ? '已复制' : '复制日志'}
          className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-2 text-[11px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:text-gg-success"
        >
          {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制日志'}
        </button>
        <button
          type="button"
          aria-label="刷新运行日志"
          title="刷新"
          onClick={retry}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭运行日志面板"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div
        role="tablist"
        aria-label="运行详情视图"
        className="flex shrink-0 gap-1 px-4 pt-3"
        onKeyDown={onTabsKeyDown}
      >
        <DrawerTab
          id={processTabId}
          controls={tabPanelId}
          active={tab === 'process'}
          onClick={() => selectTab('process')}
          label="过程"
        />
        <DrawerTab
          id={logTabId}
          controls={tabPanelId}
          active={tab === 'log'}
          onClick={() => selectTab('log')}
          label="日志"
        />
      </div>

      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={tab === 'process' ? processTabId : logTabId}
        className="flex min-h-0 flex-1 flex-col outline-none"
        tabIndex={0}
      >
        {!lifecycle ? (
          <div role="status" className="flex flex-1 items-center justify-center p-8 text-[12px] text-gg-muted">
            当前会话未接入运行管理，无法读取日志
          </div>
        ) : error && entries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p role="alert" className="text-[12px] text-gg-danger">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="rounded-[8px] bg-gg-subtle px-3 py-1.5 text-[11px] text-gg-ink outline-none hover:bg-gg-line focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              重试
            </button>
          </div>
        ) : loading && entries.length === 0 ? (
          <div role="status" className="flex flex-1 items-center justify-center gap-2 p-8 text-[12px] text-gg-muted">
            <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在读取运行日志…
          </div>
        ) : (
          <div
            ref={listRef}
            role={tab === 'log' ? 'log' : 'region'}
            aria-label={tab === 'log'
              ? `${request.title}的完整运行日志`
              : `${request.title}的生成过程`}
            className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2"
          >
            {entries.length === 0 ? (
              <p className="py-8 text-center text-[12px] text-gg-muted">这次运行还没有日志记录</p>
            ) : tab === 'log' ? (
              <StructuredLogEntries entries={entries} />
            ) : (
              <ProcessSteps entries={entries} live={live} />
            )}
            {error && (
              <p role="alert" className="mt-2 flex items-center gap-1.5 text-[11px] text-gg-danger">
                <CircleAlert size={11} aria-hidden="true" />
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </CanvasRightDrawer>
  )
}

function DrawerTab({
  id,
  controls,
  active,
  onClick,
  label,
}: {
  id: string
  controls: string
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`rounded-[8px] px-2.5 py-1 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
        active ? 'bg-gg-subtle text-gg-ink' : 'text-gg-muted hover:bg-gg-subtle/60 hover:text-gg-ink'
      }`}
    >
      {label}
    </button>
  )
}

function RunStatePill({
  summary,
  closed,
  live,
}: {
  summary: CanvasTaskRunSummary | null
  closed: boolean
  live: boolean
}) {
  const status = summary?.status
  if (status === 'awaiting-permission') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-gg-warning/10 px-2 py-0.5 text-[10px] font-medium text-gg-warning">
        <CircleAlert size={10} aria-hidden="true" />
        等待确认
      </span>
    )
  }
  if (status === 'error' || status === 'interrupted') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-gg-danger/10 px-2 py-0.5 text-[10px] font-medium text-gg-danger">
        <CircleAlert size={10} aria-hidden="true" />
        {status === 'error' ? '运行失败' : '已中断'}
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-gg-subtle px-2 py-0.5 text-[10px] font-medium text-gg-muted">
        <CircleMinus size={10} aria-hidden="true" />
        已取消
      </span>
    )
  }
  if (status === 'preparing' || status === 'running' || live || (!closed && !summary)) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-gg-primary/10 px-2 py-0.5 text-[10px] font-medium text-gg-primary">
        <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        进行中
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-gg-success/10 px-2 py-0.5 text-[10px] font-medium text-gg-success">
      <Check size={10} strokeWidth={2.4} aria-hidden="true" />
      已完成
    </span>
  )
}

/* ---------------- 「日志」页签：结构化条目 ---------------- */

type GroupedItem =
  | { type: 'tool'; key: string; name: string; command: string; results: string[] }
  | { type: 'entry'; key: string; entry: CanvasTaskRunLogEntry }

/** 工具调用与结果合并成卡片，其余条目按类型分样式，替代等宽字体墙。 */
function groupLogEntries(entries: readonly CanvasTaskRunLogEntry[]): GroupedItem[] {
  const items: GroupedItem[] = []
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.text.startsWith('→ ')) {
      const body = entry.text.slice(2)
      const spaceIndex = body.indexOf(' ')
      items.push({
        type: 'tool',
        key: `${entry.eventId}`,
        name: spaceIndex === -1 ? body : body.slice(0, spaceIndex),
        command: spaceIndex === -1 ? '' : body.slice(spaceIndex + 1),
        results: [],
      })
    } else if (entry.kind === 'tool' && entry.text.startsWith('← ')) {
      const last = items.at(-1)
      if (last && last.type === 'tool') last.results.push(entry.text.slice(2))
      else items.push({ type: 'entry', key: `${entry.eventId}:${entry.kind}`, entry })
    } else {
      items.push({ type: 'entry', key: `${entry.eventId}:${entry.kind}`, entry })
    }
  }
  return items
}

function StructuredLogEntries({
  entries,
}: {
  entries: readonly CanvasTaskRunLogEntry[]
}) {
  return (
    <div className="space-y-2">
      {groupLogEntries(entries).map((item) => {
        if (item.type === 'tool') {
          return <ToolLogCard key={item.key} name={item.name} command={item.command} results={item.results} />
        }
        return <LogEntryRow key={item.key} entry={item.entry} />
      })}
    </div>
  )
}

const ENTRY_STYLE: Record<CanvasTaskRunLogEntry['kind'], {
  icon: typeof Lightbulb
  label: string
  textClass: string
  rowClass: string
  mono: boolean
}> = {
  thinking: {
    icon: Lightbulb,
    label: '思考',
    textClass: 'text-gg-muted',
    rowClass: '',
    mono: false,
  },
  text: {
    icon: MessageSquareText,
    label: '输出',
    textClass: 'text-gg-ink',
    rowClass: '',
    mono: false,
  },
  warning: {
    icon: CircleAlert,
    label: '警告',
    textClass: 'text-gg-warning',
    rowClass: 'rounded-[8px] border border-gg-warning/30 bg-gg-warning/5',
    mono: false,
  },
  meta: {
    icon: Info,
    label: '记录',
    textClass: 'text-gg-muted',
    rowClass: '',
    mono: false,
  },
  // tool 条目在分组阶段已合并成卡片，这里仅作兜底
  tool: {
    icon: Terminal,
    label: '工具',
    textClass: 'font-mono text-gg-primary',
    rowClass: '',
    mono: true,
  },
}

function LogEntryRow({ entry }: { entry: CanvasTaskRunLogEntry }) {
  const style = ENTRY_STYLE[entry.kind]
  const Icon = style.icon
  return (
    <div className={`flex items-start gap-1.5 ${style.rowClass} ${style.rowClass ? 'px-2.5 py-2' : ''}`}>
      <Icon size={12} className={`mt-[3px] shrink-0 ${style.textClass.split(' ').at(-1)}`} />
      <span className="mt-[2px] shrink-0 rounded-full bg-gg-subtle px-1.5 py-px text-[10px] text-gg-muted">
        {style.label}
      </span>
      <div className="min-w-0 flex-1">
        <ClampedText text={entry.text} mono={style.mono} className={style.textClass} />
      </div>
    </div>
  )
}

/** 工具卡片：名称 + 命令（等宽）+ 默认折叠的执行结果 */
function ToolLogCard({
  name,
  command,
  results,
}: {
  name: string
  command: string
  results: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-[8px] border border-gg-line/70 bg-white/80 px-2.5 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
      >
        <Terminal size={12} className="shrink-0 text-gg-primary" />
        <span className="shrink-0 text-[12px] font-medium text-gg-primary">{name}</span>
        {results.length > 0 && (
          <span className="shrink-0 text-[10.5px] text-gg-muted">{results.length} 条结果</span>
        )}
        <span className="flex-1" />
        {open
          ? <ChevronDown size={12} className="shrink-0 text-gg-muted" />
          : <ChevronUp size={12} className="shrink-0 text-gg-muted" />}
      </button>
      {command && (
        <ClampedText
          text={command}
          mono
          className="mt-1 text-[11.5px] leading-[18px] text-gg-muted"
        />
      )}
      {open && results.map((result, index) => (
        <ClampedText
          key={index}
          text={result}
          mono
          className="mt-1 border-t border-gg-line/60 pt-1 text-[11.5px] leading-[18px] text-gg-ink"
        />
      ))}
    </div>
  )
}

/** 长文本默认折叠为三行，点击展开 / 收起 */
function ClampedText({
  text,
  mono = false,
  className = '',
}: {
  text: string
  mono?: boolean
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > CLAMP_LENGTH
  return (
    <div>
      <p
        className={`whitespace-pre-wrap break-all text-[12px] leading-[18px] ${mono ? 'font-mono' : ''} ${className}`}
        style={long && !expanded
          ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
          : undefined}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 text-[11px] text-gg-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

/* ---------------- 「过程」页签：友好步骤 ---------------- */

function ProcessSteps({
  entries,
  live,
}: {
  entries: readonly CanvasTaskRunLogEntry[]
  live: boolean
}) {
  const activities = activitiesFromRunLog(entries)
  if (activities.length === 0) {
    return <p className="py-8 text-center text-[12px] text-gg-muted">还没有可展示的步骤</p>
  }
  return (
    <ol aria-label="生成步骤" className="space-y-2.5">
      {activities.map((activity, index) => {
        const current = live && index === activities.length - 1
        return (
          <li key={activity.key} className="flex items-center gap-2.5 text-[12px]">
            {current ? (
              activity.warning
                ? <CircleAlert size={13} className="shrink-0 text-gg-warning" aria-hidden="true" />
                : (
                  <Loader2
                    size={13}
                    className="shrink-0 animate-spin text-gg-primary motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )
            ) : (
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-gg-success/10 text-gg-success">
                <Check size={9} strokeWidth={2.4} aria-hidden="true" />
              </span>
            )}
            <span className={current ? 'text-gg-ink' : 'text-gg-muted'}>{activity.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

/* ---------------- 数据 ---------------- */

function mergeLogEntries(
  current: readonly CanvasTaskRunLogEntry[],
  incoming: readonly CanvasTaskRunLogEntry[],
): CanvasTaskRunLogEntry[] {
  const seen = new Set(current.map((entry) => `${entry.eventId}:${entry.kind}:${entry.text.length}`))
  const merged = [...current]
  for (const entry of incoming) {
    const key = `${entry.eventId}:${entry.kind}:${entry.text.length}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged
}

function summaryLine(
  summary: CanvasTaskRunSummary | null,
  closed: boolean,
  entryCount: number,
): string {
  const parts: string[] = []
  if (summary) {
    parts.push(runStatusText(summary.status, closed))
    parts.push(`开始于 ${new Date(summary.startedAt).toLocaleString()}`)
  } else {
    parts.push(closed ? '运行已结束' : '运行记录')
  }
  parts.push(`${entryCount} 条`)
  return parts.join(' · ')
}

function runStatusText(status: CanvasTaskRunSummary['status'], closed: boolean): string {
  switch (status) {
    case 'done': return '已完成'
    case 'error': return '运行失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    case 'awaiting-permission': return '等待权限确认'
    case 'preparing': return '准备中'
    default: return closed ? '运行已结束' : '进行中'
  }
}
