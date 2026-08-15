import {
  Check,
  CircleAlert,
  CircleMinus,
  ListTree,
  Loader2,
  ScrollText,
} from 'lucide-react'
import type { CanvasNode } from '@/canvas/model'
import { useOpenCanvasRunLogViewer } from '@/canvas/runLogViewerContext'
import {
  nodeHasVisibleContent,
  type CanvasTaskStatus,
} from '@/canvas/selectors'

export interface CanvasNodeActivityStripProps {
  node: CanvasNode
  /** 所属任务的当前状态（仅当它与产物的来源 Run 一致时才视为实时状态）。 */
  taskStatus?: CanvasTaskStatus
  /** 所属任务当前/最近一次 Run 的 id，用于判断节点产物是否来自这次运行。 */
  taskRunId?: string
}

type ActivityTone = 'active' | 'attention' | 'danger' | 'done' | 'cancelled' | 'empty'

/**
 * Agent 产物与 Task-owned 空输出槽共用的单行活动条。节点内只表达
 * 当前状态；生成过程与原始日志都在统一的右侧抽屉查看。
 */
export default function CanvasNodeActivityStrip({
  node,
  taskStatus,
  taskRunId,
}: CanvasNodeActivityStripProps) {
  const openRunLogViewer = useOpenCanvasRunLogViewer()
  const originRunId = node.origin.kind === 'agent-output'
    ? node.origin.runId
    : node.homeTaskId
      ? taskRunId ?? null
      : null

  if (!originRunId) return null

  const isOriginRun = Boolean(taskRunId) && taskRunId === originRunId
  const taskOwnedEmptySlot = Boolean(node.homeTaskId)
    && !nodeHasVisibleContent(node)
  const tone = activityTone(isOriginRun, taskStatus, taskOwnedEmptySlot)
  const taskControlsVisible = taskStatus?.kind === 'queued'
    || taskStatus?.kind === 'generating'
    || taskStatus?.kind === 'needs-attention'
  const label = tone === 'done'
    ? '已完成'
    : tone === 'empty'
      ? '未生成内容'
      : taskStatus?.label ?? '运行中'
  const title = node.title || '节点'

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 border-t border-gg-line px-3 text-[10.5px]"
      data-no-drag
    >
      <span
        role="status"
        // Task 层已有唯一 live region；多产物节点不重复播报同一运行状态。
        aria-live="off"
        className={`flex min-w-0 flex-1 items-center gap-1.5 font-medium ${toneClassName(tone)}`}
      >
        <ActivityStateIcon tone={tone} />
        <span className="truncate">{label}</span>
      </span>

      {openRunLogViewer && !taskControlsVisible && (
        <div className="flex shrink-0 items-center gap-0.5 text-gg-muted">
          <button
            type="button"
            aria-label={`查看${title}的生成过程`}
            aria-haspopup="dialog"
            title="查看过程"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openRunLogViewer({
              runId: originRunId,
              title,
              initialTab: 'process',
            })}
            className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            <ListTree size={11} aria-hidden="true" />
            查看过程
          </button>
          <button
            type="button"
            aria-label={`查看${title}的详细运行日志`}
            aria-haspopup="dialog"
            title="详细日志"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openRunLogViewer({
              runId: originRunId,
              title,
              initialTab: 'log',
            })}
            className="flex h-6 w-6 items-center justify-center rounded-[6px] outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            <ScrollText size={11} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

function activityTone(
  isOriginRun: boolean,
  taskStatus: CanvasTaskStatus | undefined,
  taskOwnedEmptySlot: boolean,
): ActivityTone {
  if (!isOriginRun) return taskOwnedEmptySlot ? 'empty' : 'done'
  if (!taskStatus) return taskOwnedEmptySlot ? 'empty' : 'done'
  if (taskStatus.kind === 'queued' || taskStatus.kind === 'generating') return 'active'
  if (taskStatus.kind === 'needs-attention' || taskStatus.kind === 'partial') return 'attention'
  if (taskStatus.kind === 'failed') return 'danger'
  if (taskStatus.kind === 'cancelled') return 'cancelled'
  if (taskOwnedEmptySlot) return 'empty'
  return 'done'
}

function ActivityStateIcon({ tone }: { tone: ActivityTone }) {
  if (tone === 'active') {
    return (
      <Loader2
        size={11}
        className="shrink-0 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    )
  }
  if (tone === 'attention' || tone === 'empty') {
    return <CircleAlert size={11} className="shrink-0" aria-hidden="true" />
  }
  if (tone === 'danger') {
    return <CircleAlert size={11} className="shrink-0" aria-hidden="true" />
  }
  if (tone === 'cancelled') {
    return <CircleMinus size={11} className="shrink-0" aria-hidden="true" />
  }
  return <Check size={11} strokeWidth={2.4} className="shrink-0" aria-hidden="true" />
}

function toneClassName(tone: ActivityTone): string {
  switch (tone) {
    case 'active':
      return 'text-gg-primary'
    case 'attention':
    case 'empty':
      return 'text-gg-warning'
    case 'danger':
      return 'text-gg-danger'
    case 'cancelled':
      return 'text-gg-muted'
    case 'done':
      return 'text-gg-success'
  }
}
