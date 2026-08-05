import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check, ChevronUp, ChevronDown, CircleAlert, Copy, Ellipsis, FileText, Info,
  Lightbulb, Maximize2, MessageSquareText, Terminal, X, Loader2,
} from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { GenerationLogEntry, GenerationPanelState } from '@/agent/generationProgress'
import type { CanvasNode, PortSide } from '@/types/canvas'
import { getPlugin } from '@/plugins/types'

const PORTS: { side: PortSide; style: React.CSSProperties }[] = [
  { side: 'top', style: { left: '50%', top: 0, transform: 'translate(-50%, -50%)' } },
  { side: 'right', style: { left: '100%', top: '50%', transform: 'translate(-50%, -50%)' } },
  { side: 'bottom', style: { left: '50%', top: '100%', transform: 'translate(-50%, -50%)' } },
  { side: 'left', style: { left: 0, top: '50%', transform: 'translate(-50%, -50%)' } },
]

interface Props {
  node: CanvasNode
  selected: boolean
  onDragStart: (e: React.PointerEvent, node: CanvasNode) => void
  onPortDown: (e: React.PointerEvent, node: CanvasNode, side: PortSide) => void
  onResizeStart: (e: React.PointerEvent, node: CanvasNode) => void
}

export default function NodeCard({ node, selected, onDragStart, onPortDown, onResizeStart }: Props) {
  const { generationByNodeId, reportSize, updateInstruction, cancelInstruction } = useCanvas()
  const ref = useRef<HTMLDivElement>(null)

  // 实测高度回填，供连线端点计算
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      reportSize(node.id, el.offsetWidth, el.offsetHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [node.id, reportSize])

  const plugin = getPlugin(node.type)
  const Icon = plugin.icon
  const instr = node.instruction

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, button, select, [data-no-drag]')) return
    onDragStart(e, node)
  }

  return (
    <div
      ref={ref}
      data-node-id={node.id}
      className="absolute select-none"
      style={{ left: node.x, top: node.y, width: node.w }}
      onPointerDown={onPointerDown}
    >
      <div
        className={`group overflow-visible rounded-[14px] border bg-gg-node transition-[border-color,box-shadow] duration-150 ${
          selected ? 'border-gg-select shadow-float' : 'border-gg-line hover:border-[#C7D2E0]'
        }`}
        style={selected ? { borderWidth: 1.5 } : undefined}
      >
        {/* 头部：类型图标 + 名称 + 悬停更多 */}
        <div className="flex items-center gap-2 px-3.5 pt-3">
          <Icon size={14} className="shrink-0 text-gg-muted" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gg-ink">
            {node.title || plugin.label}
          </span>
          <button
            data-no-drag
            className="flex h-5 w-5 items-center justify-center rounded-[6px] text-gg-muted opacity-0 transition-opacity hover:bg-gg-subtle hover:text-gg-ink group-hover:opacity-100"
            style={{ opacity: selected ? 1 : undefined }}
            title="更多"
          >
            <Ellipsis size={14} />
          </button>
        </div>

        {/* 主体：由节点插件决定渲染（空白态 / 生成中骨架 / 内容态） */}
        <div className="px-3.5 pb-3.5 pt-2.5">
          <NodeBody node={node} selected={selected} />
        </div>

        {instr.phase === 'generating' ? (
          <GenerationFooter
            key={generationByNodeId[node.id]?.epoch ?? node.id}
            progress={generationByNodeId[node.id]}
            onCancel={() => cancelInstruction(node.id)}
          />
        ) : instr.phase === 'done' ? (
          <CompletedFooter
            key={`done-${generationByNodeId[node.id]?.epoch ?? node.id}`}
            progress={generationByNodeId[node.id]}
            instrOpen={instr.open}
            onToggleInstr={() => updateInstruction(node.id, { open: !instr.open })}
          />
        ) : null}
      </div>

      {/* 连接端口：选中后出现（规范 2.4 / 4.2） */}
      {selected &&
        PORTS.map(({ side, style }) => (
          <button
            key={side}
            data-port={side}
            title="拖出以连接或创建节点"
            className="absolute z-10 h-[11px] w-[11px] cursor-crosshair rounded-full border-[1.5px] border-gg-select bg-white transition-transform hover:scale-125"
            style={style}
            onPointerDown={(e) => { e.stopPropagation(); onPortDown(e, node, side) }}
          />
        ))}

      {/* 缩放手柄 */}
      {selected && (
        <div
          data-no-drag
          className="absolute -bottom-1.5 -right-1.5 z-10 h-3.5 w-3.5 cursor-nwse-resize rounded-[4px] border-[1.5px] border-gg-select bg-white"
          onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e, node) }}
        />
      )}
    </div>
  )
}

function GenerationFooter({
  progress,
  onCancel,
}: {
  progress?: GenerationPanelState
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  const [roomy, setRoomy] = useState(false)
  const current = progress?.current ?? {
    key: 'connecting',
    kind: 'connecting' as const,
    label: '正在连接 Agent',
  }

  return (
    <div data-no-drag className="rounded-b-[13px] border-t border-gg-line bg-gg-subtle">
      <div className="flex min-h-[34px] items-center px-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? '收起生成过程' : '展开生成过程'}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-1 py-1 text-left text-[11.5px] transition-colors hover:bg-white/80"
        >
          {current.kind === 'warning' ? (
            <CircleAlert size={11} className="shrink-0 text-[#D97706]" />
          ) : (
            <Loader2 size={11} className="shrink-0 animate-spin text-gg-primary" />
          )}
          <span className="shrink-0 font-medium text-gg-primary">生成中</span>
          <span className="mx-0.5 h-3 w-px shrink-0 bg-gg-line" />
          <span className="truncate text-gg-muted" title={current.label}>{current.label}</span>
          <span className="flex-1" />
          {open ? <ChevronDown size={12} className="shrink-0 text-gg-muted" /> : <ChevronUp size={12} className="shrink-0 text-gg-muted" />}
        </button>
        <button
          type="button"
          onClick={() => setRoomy(true)}
          title="大窗查看"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-gg-muted transition-colors hover:bg-white hover:text-gg-ink"
        >
          <Maximize2 size={11} />
        </button>
        <span className="mx-1 h-4 w-px bg-gg-line" />
        <button
          type="button"
          onClick={onCancel}
          className="flex h-6 shrink-0 items-center gap-0.5 rounded-[7px] px-1.5 text-[11px] text-gg-danger transition-colors hover:bg-white"
          title="取消生成"
        >
          <X size={10} /> 取消
        </button>
      </div>

      {open && <GenerationDetail progress={progress} onExpand={() => setRoomy(true)} />}
      {roomy && <GenerationDrawer progress={progress} onClose={() => setRoomy(false)} />}
    </div>
  )
}

/**
 * 已完成底栏：保留本次运行的进度快照，点击可展开「生成过程 / 原始日志」回顾；
 * 原地点击节点本身即弹出指令面板（连续提示），底栏不再重复提供入口。
 * 没有快照（如历史节点）时维持原行为——整栏切换指令面板。
 */
function CompletedFooter({
  progress,
  instrOpen,
  onToggleInstr,
}: {
  progress?: GenerationPanelState
  instrOpen: boolean
  onToggleInstr: () => void
}) {
  const [open, setOpen] = useState(false)
  const [roomy, setRoomy] = useState(false)
  const hasDetail = Boolean(progress)
  const expanded = hasDetail ? open : instrOpen

  return (
    <div data-no-drag className="rounded-b-[13px] border-t border-gg-line bg-gg-subtle">
      <div className="flex min-h-[34px] items-center px-2.5">
        <button
          type="button"
          onClick={() => (hasDetail ? setOpen((value) => !value) : onToggleInstr())}
          aria-expanded={expanded}
          aria-label={hasDetail ? (open ? '收起生成过程' : '展开生成过程') : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-1 py-1 text-left text-[11.5px] text-gg-muted transition-colors hover:bg-white/80 hover:text-gg-ink"
        >
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-gg-success">
            <Check size={11} strokeWidth={2.2} /> 已完成
          </span>
          <span className="flex-1" />
          {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronUp size={12} className="shrink-0" />}
        </button>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setRoomy(true)}
            title="大窗查看"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-gg-muted transition-colors hover:bg-white hover:text-gg-ink"
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>

      {hasDetail && open && (
        <GenerationDetail progress={progress} terminal onExpand={() => setRoomy(true)} />
      )}
      {roomy && <GenerationDrawer progress={progress} terminal onClose={() => setRoomy(false)} />}
    </div>
  )
}

/** 页签行：生成过程 / 原始日志，可选「大窗查看」入口 */
function DetailTabs({
  tab,
  onChange,
  onExpand,
}: {
  tab: 'process' | 'log'
  onChange: (tab: 'process' | 'log') => void
  onExpand?: () => void
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1" role="tablist">
      {([
        { id: 'process', label: '生成过程' },
        { id: 'log', label: '原始日志' },
      ] as const).map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          onClick={() => onChange(item.id)}
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
            tab === item.id
              ? 'bg-[#EAF1FD] text-gg-primary'
              : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
          }`}
        >
          {item.label}
        </button>
      ))}
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          title="大窗查看"
          className="ml-auto flex h-5 w-5 items-center justify-center rounded-[6px] text-gg-muted transition-colors hover:bg-white hover:text-gg-ink"
        >
          <Maximize2 size={10} />
        </button>
      )}
    </div>
  )
}

/** 详情主体：步骤列表或原始日志；roomy 模式下放大字号、由外层容器滚动 */
function DetailBody({
  progress,
  terminal = false,
  tab,
  roomy = false,
}: {
  progress?: GenerationPanelState
  terminal?: boolean
  tab: 'process' | 'log'
  roomy?: boolean
}) {
  const logScrollRef = useRef<HTMLDivElement>(null)
  const current = progress?.current ?? {
    key: 'connecting',
    kind: 'connecting' as const,
    label: '正在连接 Agent',
  }
  const activities = [...(progress?.recent ?? []), current]
  const log = progress?.log ?? []

  // 原始日志跟随流式输出滚动到底部
  useEffect(() => {
    if (tab !== 'log') return
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tab, log.length])

  if (tab === 'process') {
    return (
      <div className={roomy ? 'space-y-2' : 'space-y-1.5'} aria-label="生成过程">
        {activities.map((activity, index) => {
          const active = !terminal && index === activities.length - 1
          return (
            <div
              key={`${activity.key}-${index}`}
              className={`flex items-center gap-2 ${roomy ? 'text-[12.5px]' : 'text-[10.5px]'}`}
            >
              {active ? (
                activity.kind === 'warning'
                  ? <CircleAlert size={roomy ? 13 : 11} className="shrink-0 text-[#D97706]" />
                  : <Loader2 size={roomy ? 13 : 11} className="shrink-0 animate-spin text-gg-primary" />
              ) : (
                <span
                  className={`flex shrink-0 items-center justify-center rounded-full bg-[#E8F5EE] text-gg-success ${
                    roomy ? 'h-[14px] w-[14px]' : 'h-[11px] w-[11px]'
                  }`}
                >
                  <Check size={roomy ? 10 : 8} strokeWidth={2.4} />
                </span>
              )}
              <span className={active ? 'text-gg-ink' : 'text-gg-muted'}>{activity.label}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      ref={logScrollRef}
      aria-label="原始日志"
      className={`overflow-y-auto pr-1 ${
        roomy ? 'max-h-none text-[12.5px] leading-5' : 'max-h-[168px] text-[11px] leading-4'
      }`}
    >
      {log.length === 0 ? (
        <p className="text-gg-muted">暂无原始日志</p>
      ) : (
        <LogEntries log={log} roomy={roomy} />
      )}
    </div>
  )
}

/* ---------------- 原始日志：结构化、可扫读 ---------------- */

type LogItem =
  | { type: 'entry'; entry: GenerationLogEntry }
  | { type: 'tool'; name: string; command: string; results: string[] }

/** 把扁平日志流分组：工具调用与随后的工具结果合并成一张卡片 */
function groupLogEntries(log: GenerationLogEntry[]): LogItem[] {
  const items: LogItem[] = []
  for (const entry of log) {
    if (entry.kind === 'tool' && entry.text.startsWith('→ ')) {
      const body = entry.text.slice(2)
      const spaceIndex = body.indexOf(' ')
      items.push({
        type: 'tool',
        name: spaceIndex === -1 ? body : body.slice(0, spaceIndex),
        command: spaceIndex === -1 ? '' : body.slice(spaceIndex + 1),
        results: [],
      })
    } else if (entry.kind === 'tool' && entry.text.startsWith('← ')) {
      const last = items.at(-1)
      if (last && last.type === 'tool') last.results.push(entry.text.slice(2))
      else items.push({ type: 'entry', entry })
    } else {
      items.push({ type: 'entry', entry })
    }
  }
  return items
}

/** 长文本默认折叠为几行，点击展开/收起 */
function ClampedText({
  text,
  mono = false,
  className = '',
  roomy = false,
}: {
  text: string
  mono?: boolean
  className?: string
  roomy?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 180
  return (
    <div>
      <p
        className={`whitespace-pre-wrap break-all ${mono ? 'font-mono' : ''} ${className}`}
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
          className={`mt-0.5 text-gg-primary transition-colors hover:underline ${roomy ? 'text-[11px]' : 'text-[9.5px]'}`}
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

/** 工具卡片：名称 + 命令（等宽）+ 默认折叠的执行结果 */
function ToolLogItem({ name, command, results, roomy }: {
  name: string
  command: string
  results: string[]
  roomy: boolean
}) {
  const [open, setOpen] = useState(false)
  const iconSize = roomy ? 12 : 10
  return (
    <div className={`rounded-[8px] border border-gg-line/70 bg-white/80 ${roomy ? 'px-2.5 py-2' : 'px-2 py-1.5'}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <Terminal size={iconSize} className="shrink-0 text-gg-primary" />
        <span className={`shrink-0 font-medium text-gg-primary ${roomy ? 'text-[12px]' : 'text-[10px]'}`}>
          {name}
        </span>
        {results.length > 0 && (
          <span className={`shrink-0 text-gg-muted ${roomy ? 'text-[10.5px]' : 'text-[9px]'}`}>
            {results.length} 条结果
          </span>
        )}
        <span className="flex-1" />
        {open
          ? <ChevronDown size={iconSize} className="shrink-0 text-gg-muted" />
          : <ChevronUp size={iconSize} className="shrink-0 text-gg-muted" />}
      </button>
      {command && (
        <ClampedText
          text={command}
          mono
          roomy={roomy}
          className={`mt-1 text-gg-muted ${roomy ? 'text-[11.5px] leading-[18px]' : 'text-[10px] leading-[15px]'}`}
        />
      )}
      {open && results.map((result, index) => (
        <ClampedText
          key={index}
          text={result}
          mono
          roomy={roomy}
          className={`mt-1 border-t border-gg-line/60 pt-1 text-gg-ink ${roomy ? 'text-[11.5px] leading-[18px]' : 'text-[10px] leading-[15px]'}`}
        />
      ))}
    </div>
  )
}

const ENTRY_STYLE: Record<GenerationLogEntry['kind'], {
  icon: typeof Lightbulb
  label: string
  textClass: string
  rowClass: string
}> = {
  thinking: {
    icon: Lightbulb,
    label: '思考',
    textClass: 'text-gg-muted',
    rowClass: '',
  },
  output: {
    icon: MessageSquareText,
    label: '输出',
    textClass: 'text-gg-ink',
    rowClass: '',
  },
  artifact: {
    icon: FileText,
    label: '产物',
    textClass: 'font-mono text-gg-primary',
    rowClass: '',
  },
  warning: {
    icon: CircleAlert,
    label: '警告',
    textClass: 'text-[#B45309]',
    rowClass: 'rounded-[8px] bg-[#FFFBEB] border border-[#FDE68A]/70',
  },
  info: {
    icon: Info,
    label: '信息',
    textClass: 'text-gg-muted',
    rowClass: '',
  },
  // tool 条目在 groupLogEntries 阶段已合并成卡片，这里仅作兜底
  tool: {
    icon: Terminal,
    label: '工具',
    textClass: 'font-mono text-gg-primary',
    rowClass: '',
  },
}

/** 结构化日志列表：按类型分卡展示，替代等宽字体墙 */
function LogEntries({ log, roomy = false }: { log: GenerationLogEntry[]; roomy?: boolean }) {
  const items = groupLogEntries(log)
  const iconSize = roomy ? 12 : 10
  const tagClass = roomy ? 'text-[10px]' : 'text-[8.5px]'
  return (
    <div className={roomy ? 'space-y-2' : 'space-y-1.5'}>
      {items.map((item, index) => {
        if (item.type === 'tool') {
          return (
            <ToolLogItem
              key={index}
              name={item.name}
              command={item.command}
              results={item.results}
              roomy={roomy}
            />
          )
        }
        const { entry } = item
        const style = ENTRY_STYLE[entry.kind]
        const Icon = style.icon
        return (
          <div
            key={index}
            className={`flex items-start gap-1.5 ${style.rowClass} ${style.rowClass ? (roomy ? 'px-2.5 py-2' : 'px-2 py-1.5') : ''}`}
          >
            <Icon size={iconSize} className={`mt-[3px] shrink-0 ${style.textClass.split(' ').at(-1)}`} />
            <span className={`mt-[2px] shrink-0 rounded-full bg-gg-subtle px-1.5 py-px text-gg-muted ${tagClass}`}>
              {style.label}
            </span>
            <div className="min-w-0 flex-1">
              <ClampedText
                text={entry.text}
                mono={entry.kind === 'artifact' || entry.kind === 'tool'}
                roomy={roomy}
                className={style.textClass}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 节点内的紧凑详情：页签 + 主体 */
function GenerationDetail({
  progress,
  terminal = false,
  onExpand,
}: {
  progress?: GenerationPanelState
  terminal?: boolean
  onExpand?: () => void
}) {
  const [tab, setTab] = useState<'process' | 'log'>('process')
  return (
    <div className="border-t border-gg-line/80 bg-white/55 px-3 py-2">
      <DetailTabs tab={tab} onChange={setTab} onExpand={onExpand} />
      <DetailBody progress={progress} terminal={terminal} tab={tab} />
    </div>
  )
}

/**
 * 宽敞视野：右侧大抽屉，用 portal 挂到 body（画布容器有 transform，
 * 直接 fixed 会被困在节点坐标系里）。运行中会跟随事件流实时刷新。
 */
function GenerationDrawer({
  progress,
  terminal = false,
  onClose,
}: {
  progress?: GenerationPanelState
  terminal?: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState<'process' | 'log'>('process')
  const [copied, setCopied] = useState(false)
  const copyLog = () => {
    const text = (progress?.log ?? []).map((entry) => entry.text).join('\n\n')
    if (!text) return
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      // 剪贴板不可用时静默忽略，按钮仅作便捷入口
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return createPortal(
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="运行详情"
        className="absolute bottom-0 right-0 top-0 flex w-[min(560px,92vw)] flex-col border-l border-gg-line bg-gg-node shadow-float"
      >
        <header className="flex items-center gap-2 border-b border-gg-line px-4 py-3">
          <span className="text-[13px] font-medium text-gg-ink">运行详情</span>
          {terminal ? (
            <span className="flex items-center gap-1 rounded-full bg-[#E8F5EE] px-2 py-0.5 text-[10.5px] font-medium text-gg-success">
              <Check size={10} strokeWidth={2.4} /> 已完成
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-[#EAF1FD] px-2 py-0.5 text-[10.5px] font-medium text-gg-primary">
              <Loader2 size={10} className="animate-spin" /> 生成中
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={copyLog}
            title={copied ? '已复制' : '复制日志'}
            disabled={copied}
            className="flex h-7 items-center gap-1 rounded-[8px] px-2 text-[11px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink disabled:text-gg-success"
          >
            {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制日志'}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink"
          >
            <X size={14} />
          </button>
        </header>
        <div className="px-4 pt-3">
          <DetailTabs tab={tab} onChange={setTab} />
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-1">
          <DetailBody progress={progress} terminal={terminal} tab={tab} roomy />
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/** 生成中：轻量骨架屏（规范 11.4，对所有插件统一） */
function GeneratingBody() {
  return (
    <div className="rounded-[10px] bg-gg-subtle p-3" data-no-drag>
      <div className="gg-shimmer space-y-2">
        <div className="h-2.5 w-2/5 rounded bg-[#E4EAF2]" />
        <div className="h-[72px] rounded-[8px] bg-[#E4EAF2]" />
        <div className="flex gap-2">
          <div className="h-2.5 w-1/4 rounded bg-[#E4EAF2]" />
          <div className="h-2.5 w-1/3 rounded bg-[#E4EAF2]" />
        </div>
      </div>
    </div>
  )
}

/**
 * 主体视图分派：生成中骨架由引擎统一接管；
 * 空白态 / 内容态完全交给节点插件（规范 2.3 状态递进）。
 */
function NodeBody({ node, selected }: { node: CanvasNode; selected: boolean }) {
  const plugin = getPlugin(node.type)
  if (node.instruction.phase === 'generating') return <GeneratingBody />
  const View = plugin.isEmpty(node) ? plugin.views.Empty : plugin.views.Content
  return <View node={node} selected={selected} />
}
