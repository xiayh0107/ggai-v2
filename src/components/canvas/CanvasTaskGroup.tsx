import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileOutput,
  Grip,
  Loader2,
  PackageCheck,
  Sparkles,
} from 'lucide-react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { TASK_CHROME_LAYOUT } from '@/canvas/layout'
import { nodeHasVisibleContent } from '@/canvas/contextComposer'
import type { CanvasNode, CanvasTask } from '@/canvas/model'
import {
  taskChromeFrame,
  taskPrimaryOutputFrame,
  type CanvasGhostLayout,
  type CanvasTaskStatus,
  type CanvasTaskView,
} from '@/canvas/selectors'
import { getPlugin } from '@/plugins/types'
import CanvasConnectionPort from './CanvasConnectionPort'
import CanvasEntityMenu, { type CanvasMenuItem } from './CanvasEntityMenu'
import CanvasNodeCard from './CanvasNodeCard'
import CanvasTaskProposalReview from './CanvasTaskProposalReview'
import CanvasTaskRunPanel from './CanvasTaskRunPanel'
import { canvasTaskChromeState } from './CanvasTaskChrome'

export interface CanvasTaskGroupProps {
  view: CanvasTaskView
  projectDir: string
  selectedTask: boolean
  /** 任务当前/最近一次 Run 的 id，随任务状态一起透传给节点活动记录条。 */
  taskRunId?: string
  compoundSelectedTask?: boolean
  compoundSelection?: boolean
  showRunPanel?: boolean
  /** 当前画布缩放，用来让提示词 / 运行控件保持稳定的屏幕尺寸。 */
  zoom?: number
  selectedNodeIds: ReadonlySet<string>
  compoundSelectedNodeIds?: ReadonlySet<string>
  explicitlyCollapsed: boolean
  activeKey: string | null
  offset?: { dx: number; dy: number }
  nodeFrames?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>
  onSelectTask: (task: CanvasTask, additive: boolean) => void
  onToggleCollapsed: (taskId: string, collapsed: boolean) => void
  onTaskDragStart: (event: PointerEvent<HTMLElement>, task: CanvasTask) => void
  onNodeDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void
  /** 单产物任务隐藏标题条时的节点拖拽：整体移动任务但保持节点选中。 */
  onSoloTaskNodeDragStart?: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void
  onNodeResizeStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => void
  onTaskPortActivate?: (task: CanvasTask) => void
  /** 按住任务端口拖出一根线：落到实体上完成连接，落到空白弹新建节点菜单。 */
  onTaskPortDragStart?: (event: PointerEvent<HTMLButtonElement>, task: CanvasTask) => void
  activeConnectionKey?: string | null
  onTaskMenuAction?: (task: CanvasTask, action: string) => void
  onNodeMenuAction?: (node: CanvasNode, action: string) => void
  onEntityFocus: (key: string) => void
  onEntityKeyDown: (key: string, event: KeyboardEvent<HTMLButtonElement>) => void
  registerFocusable: (key: string, element: HTMLButtonElement | null) => void
}

export default function CanvasTaskGroup({
  view,
  projectDir,
  selectedTask,
  taskRunId,
  compoundSelectedTask = false,
  compoundSelection = false,
  showRunPanel = selectedTask,
  zoom = 1,
  selectedNodeIds,
  compoundSelectedNodeIds = selectedNodeIds,
  explicitlyCollapsed,
  activeKey,
  offset,
  nodeFrames,
  onSelectTask,
  onToggleCollapsed,
  onTaskDragStart,
  onNodeDragStart,
  onSoloTaskNodeDragStart,
  onNodeResizeStart,
  onTaskPortActivate,
  onTaskPortDragStart,
  activeConnectionKey,
  onTaskMenuAction,
  onNodeMenuAction,
  onEntityFocus,
  onEntityKeyDown,
  registerFocusable,
}: CanvasTaskGroupProps) {
  const { task } = view
  const {
    collapsed,
    compact,
    runActive,
    generatingPhase,
    chromelessSingleNode,
    captionChrome,
    liteTaskChrome,
    noTopChrome,
  } = canvasTaskChromeState(view, { selectedTask, compoundSelectedTask })
  const outputCount = view.nodes.length + view.ghosts.length
  const outputRegionId = `canvas-task-${task.id}-outputs`
  const taskKey = `task:${task.id}`
  const runPanelPosition = taskRunPanelPosition(view, zoom)
  const chromeFrame = taskChromeFrame(view.task, view.nodes, view.ghosts, view.presentation)
  const chromelessNodeMenuItems = [
    { id: 'task:continue', label: '继续任务' },
    { id: 'task:duplicate', label: '复制为草稿任务' },
    { id: 'task:delete', label: '解除任务关系，保留画布节点', destructive: true },
  ]
  const handleChromelessNodeMenuAction = (
    node: CanvasNode,
    action: string,
  ) => {
    if (action === 'task:continue') {
      onSelectTask(task, false)
      return
    }
    if (action.startsWith('task:')) {
      onTaskMenuAction?.(task, action.slice('task:'.length))
      return
    }
    onNodeMenuAction?.(node, action)
  }
  const taskHeader = (
    <TaskHeader
      task={task}
      status={view.status}
      selected={selectedTask}
      collapsed={collapsed}
      outputRegionId={outputRegionId}
      tabIndex={activeKey === taskKey ? 0 : -1}
      onFocus={() => onEntityFocus(taskKey)}
      onKeyDown={(event) => onEntityKeyDown(taskKey, event)}
      onDragStart={(event) => onTaskDragStart(event, task)}
      connectionActive={activeConnectionKey === taskKey}
      onPortActivate={onTaskPortActivate && !compoundSelectedTask
        ? () => onTaskPortActivate(task)
        : undefined}
      onPortDragStart={onTaskPortDragStart && !compoundSelectedTask
        ? (event) => onTaskPortDragStart(event, task)
        : undefined}
      onMenuAction={onTaskMenuAction ? (action) => onTaskMenuAction(task, action) : undefined}
      onToggle={() => {
        if (collapsed) onSelectTask(task, false)
        onToggleCollapsed(task.id, collapsed ? false : !explicitlyCollapsed)
      }}
      registerFocusable={(element) => registerFocusable(taskKey, element)}
    />
  )

  return (
    <section
      role="group"
      aria-label={view.accessibility.label}
      data-task-id={task.id}
      data-container-kind={view.containerKind}
      data-presentation={view.presentation}
      data-selected={selectedTask ? 'true' : 'false'}
      className="pointer-events-none absolute left-0 top-0"
      style={offset ? { transform: `translate(${offset.dx}px, ${offset.dy}px)` } : undefined}
    >
      {collapsed ? (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute overflow-hidden rounded-[16px] border bg-gg-node shadow-sm motion-reduce:transition-none ${
            selectedTask && !compoundSelectedTask
              ? 'border-[1.5px] border-gg-select shadow-float'
              : 'border-gg-line'
          }`}
          style={{
            left: task.anchor.x,
            top: task.anchor.y,
            width: TASK_CHROME_LAYOUT.collapsedWidth,
            height: TASK_CHROME_LAYOUT.collapsedHeight,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          <div className="flex h-full items-center gap-3 px-3">
            <div className="min-w-0 flex-1">{taskHeader}</div>
            <TaskSummary
              nodes={view.nodes}
              ghosts={view.ghosts}
              outputCount={outputCount}
              artifactCount={view.artifactCount}
            />
          </div>
        </div>
      ) : view.containerKind === 'task-card' ? (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute rounded-[16px] border bg-gg-node p-4 shadow-sm motion-reduce:transition-none ${
            selectedTask && !compoundSelectedTask
              ? 'border-[1.5px] border-gg-select shadow-float'
              : 'border-gg-line'
          }`}
          style={{
            left: task.anchor.x,
            top: task.anchor.y,
            width: TASK_CHROME_LAYOUT.cardWidth,
            height: compact
              ? TASK_CHROME_LAYOUT.compactHeight
              : TASK_CHROME_LAYOUT.cardHeight,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          {taskHeader}
          {!compact && (
            <div className="mt-3 border-t border-gg-line pt-3">
              <p className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-5 text-gg-muted">
                {task.goal || '尚未填写任务目标'}
              </p>
              <p className="mt-2 text-[10.5px] text-[#98A2B3]">尚无产物</p>
            </div>
          )}
        </div>
      ) : noTopChrome ? null : captionChrome ? (
        <div
          data-task-border={task.id}
          data-task-chrome="caption"
          className="group pointer-events-auto absolute flex items-center gap-1 pr-1 motion-reduce:transition-none"
          style={{
            left: chromeFrame.x,
            top: chromeFrame.y,
            width: chromeFrame.w,
            height: chromeFrame.h,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          <button
            ref={(element) => registerFocusable(taskKey, element)}
            type="button"
            data-focus-key={taskKey}
            aria-pressed={selectedTask}
            tabIndex={activeKey === taskKey ? 0 : -1}
            onFocus={() => onEntityFocus(taskKey)}
            onKeyDown={(event) => onEntityKeyDown(taskKey, event)}
            onPointerDown={(event) => onTaskDragStart(event, task)}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 active:cursor-grabbing"
          >
            <TaskCaptionStatus status={view.status} />
            <span className="truncate text-[12px] font-medium text-gg-muted group-hover:text-gg-ink">
              {task.title}
            </span>
            {view.nodes.length > 0 && !generatingPhase && (
              <span className="shrink-0 text-[10px] text-[#98A2B3]">{outputCount} 个产物</span>
            )}
          </button>
          {onTaskPortActivate && (
            <CanvasConnectionPort
              label={activeConnectionKey === taskKey
                ? `取消从任务${task.title}的连接`
                : `从任务${task.title}开始或完成连接`}
              title="连接任务"
              active={activeConnectionKey === taskKey}
              onActivate={() => onTaskPortActivate(task)}
              onDragStart={onTaskPortDragStart
                ? (event) => onTaskPortDragStart(event, task)
                : undefined}
            />
          )}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
            <button
              type="button"
              aria-expanded="true"
              aria-controls={outputRegionId}
              aria-label={`折叠任务${task.title}`}
              title="折叠任务"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onToggleCollapsed(task.id, true)}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35 motion-reduce:transition-none"
            >
              <ChevronDown size={14} />
            </button>
            {onTaskMenuAction && (
              <CanvasEntityMenu
                label={`${task.title}任务菜单`}
                items={taskMenuItems(task)}
                onAction={(action) => onTaskMenuAction(task, action)}
              />
            )}
          </div>
        </div>
      ) : (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute flex items-center gap-2 rounded-[16px] border bg-gg-node px-3 shadow-sm motion-reduce:transition-none ${
            selectedTask && !compoundSelectedTask
              ? 'border-[1.5px] border-gg-select shadow-float'
              : 'border-gg-line'
          }`}
          style={{
            left: chromeFrame.x,
            top: chromeFrame.y,
            width: chromeFrame.w,
            height: chromeFrame.h,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          <div className="min-w-0 flex-1">{taskHeader}</div>
          {view.containerKind === 'output-frame' && (
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] text-gg-muted">
              {outputCount} 个产物
              {view.artifactCount > 0 && (
                <span className="flex items-center gap-1">
                  <FileOutput size={11} aria-hidden="true" /> {view.artifactCount}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {!collapsed && (
        <div id={outputRegionId} aria-label={`${task.title}的产物`}>
          {view.nodes.map((node) => (
            <CanvasNodeCard
              key={node.id}
              node={node}
              frame={nodeFrames?.get(node.id)}
              projectDir={projectDir}
              selected={selectedNodeIds.has(node.id)}
              compoundSelected={compoundSelection && compoundSelectedNodeIds.has(node.id)}
              compact={compact}
              taskStatus={view.status}
              taskRunId={taskRunId}
              controlsLocked={runActive || !nodeHasVisibleContent(node)}
              extraMenuItems={liteTaskChrome ? chromelessNodeMenuItems : undefined}
              tabIndex={activeKey === `node:${node.id}` ? 0 : -1}
              onFocus={() => onEntityFocus(`node:${node.id}`)}
              onKeyDown={(event) => onEntityKeyDown(`node:${node.id}`, event)}
              onDragStart={chromelessSingleNode && onSoloTaskNodeDragStart
                ? onSoloTaskNodeDragStart
                : onNodeDragStart}
              onResizeStart={onNodeResizeStart}
              onMenuAction={liteTaskChrome
                ? handleChromelessNodeMenuAction
                : onNodeMenuAction}
              registerFocusable={(element) => registerFocusable(`node:${node.id}`, element)}
            />
          ))}
          {view.ghosts.map((ghost) => (
            <CanvasGhostCard
              key={ghost.key}
              ghost={ghost}
              task={task}
              status={view.status}
            />
          ))}
        </div>
      )}

      {!collapsed && showRunPanel && (
        <div
          className="pointer-events-auto absolute z-30"
          style={{
            left: runPanelPosition.x,
            top: runPanelPosition.y,
            transform: `scale(${runPanelPosition.scale})`,
            transformOrigin: 'top left',
          }}
        >
          <div className="space-y-3">
            <CanvasTaskRunPanel task={task} width={runPanelPosition.width} />
            <CanvasTaskProposalReview task={task} />
          </div>
        </div>
      )}
    </section>
  )
}

function taskRunPanelPosition(
  view: CanvasTaskView,
  zoom: number,
): { x: number; y: number; width: number; scale: number } {
  const safeZoom = Math.max(zoom, 0.1)
  const chrome = taskChromeFrame(view.task, view.nodes, view.ghosts, view.presentation)
  const primary = taskPrimaryOutputFrame(view.nodes, view.ghosts)
  const outputFrames = [
    ...view.nodes.map((node) => node.frame),
    ...view.ghosts.map((ghost) => ghost.frame),
  ]
  const anchor = primary ?? chrome
  const contentBottom = outputFrames.length > 0
    ? Math.max(...outputFrames.map((frame) => frame.y + frame.h))
    : chrome.y + chrome.h
  const screenWidth = Math.min(430, Math.max(360, anchor.w * safeZoom + 70))
  return {
    x: anchor.x - 20,
    y: contentBottom + 12 / safeZoom,
    width: screenWidth,
    scale: 1 / safeZoom,
  }
}

function TaskHeader({
  task,
  status,
  selected,
  collapsed,
  outputRegionId,
  tabIndex,
  onFocus,
  onKeyDown,
  onDragStart,
  connectionActive,
  onPortActivate,
  onPortDragStart,
  onMenuAction,
  onToggle,
  registerFocusable,
}: {
  task: CanvasTask
  status: CanvasTaskStatus
  selected: boolean
  collapsed: boolean
  outputRegionId: string
  tabIndex: number
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLButtonElement>) => void
  connectionActive: boolean
  onPortActivate?: () => void
  onPortDragStart?: (event: PointerEvent<HTMLButtonElement>) => void
  onMenuAction?: (action: string) => void
  onToggle: () => void
  registerFocusable: (element: HTMLButtonElement | null) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        ref={registerFocusable}
        type="button"
        data-focus-key={`task:${task.id}`}
        aria-pressed={selected}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onPointerDown={onDragStart}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[8px] text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 active:cursor-grabbing"
      >
        <Grip size={13} className="shrink-0 text-[#98A2B3]" aria-hidden="true" />
        <span className="truncate text-[12.5px] font-semibold text-gg-ink">{task.title}</span>
      </button>
      {onPortActivate && (
        <CanvasConnectionPort
          label={connectionActive
            ? `取消从任务${task.title}的连接`
            : `从任务${task.title}开始或完成连接`}
          title="连接任务"
          active={connectionActive}
          onActivate={onPortActivate}
          onDragStart={onPortDragStart}
        />
      )}
      <TaskStatus status={status} />
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={outputRegionId}
        aria-label={collapsed ? `展开任务${task.title}` : `折叠任务${task.title}`}
        title={collapsed ? '展开任务' : '折叠任务'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onToggle}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35 motion-reduce:transition-none"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {onMenuAction && (
        <CanvasEntityMenu
          label={`${task.title}任务菜单`}
          items={taskMenuItems(task)}
          onAction={onMenuAction}
        />
      )}
    </div>
  )
}

function taskMenuItems(task: CanvasTask): CanvasMenuItem[] {
  return [
    { id: 'duplicate', label: '复制为草稿任务' },
    ...(task.collectionId
      ? [{ id: 'remove-collection', label: '移出集合' }]
      : []),
    { id: 'delete', label: '解除任务关系，保留画布节点', destructive: true },
    { id: 'delete-views', label: '从画布移除任务和输出节点', destructive: true },
  ]
}

/** 轻量说明条里的任务状态：只在运行中 / 需要关注时出现，完成态保持安静。 */
function TaskCaptionStatus({ status }: { status: CanvasTaskStatus }) {
  const active = status.kind === 'queued' || status.kind === 'generating'
  const attention = status.kind === 'needs-attention'
    || status.kind === 'partial'
    || status.kind === 'failed'
  if (!active && !attention) return null
  return (
    <span
      data-task-status={status.kind}
      title={status.message ?? status.label}
      className={`flex shrink-0 items-center gap-1 text-[10px] font-medium ${
        attention ? 'text-[#B45309]' : 'text-gg-primary'
      }`}
    >
      {active ? (
        <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <CircleAlert size={10} aria-hidden="true" />
      )}
      {status.label}
    </span>
  )
}

function TaskStatus({ status }: { status: CanvasTaskStatus }) {
  const active = status.kind === 'queued' || status.kind === 'generating'
  const attention = status.kind === 'needs-attention'
    || status.kind === 'partial'
    || status.kind === 'failed'
  return (
    <span
      data-task-status={status.kind}
      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${
        attention
          ? 'bg-[#FFF4E5] text-[#B45309]'
          : active ? 'bg-[#EAF1FD] text-gg-primary' : 'bg-gg-subtle text-gg-muted'
      }`}
      title={status.message ?? status.label}
    >
      {active ? (
        <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : attention ? (
        <CircleAlert size={10} aria-hidden="true" />
      ) : (
        <PackageCheck size={10} aria-hidden="true" />
      )}
      {status.label}
    </span>
  )
}

function TaskSummary({
  nodes,
  ghosts,
  outputCount,
  artifactCount,
}: {
  nodes: CanvasNode[]
  ghosts: CanvasGhostLayout[]
  outputCount: number
  artifactCount: number
}) {
  const previews = [
    ...nodes.slice(0, 3).map((node) => ({ key: node.id, type: node.type, pending: false })),
    ...ghosts.slice(0, Math.max(0, 3 - nodes.length)).map((ghost) => ({
      key: ghost.key,
      type: ghost.pluginId ?? 'file',
      pending: true,
    })),
  ]
  return (
    <div className="flex shrink-0 items-center gap-2 text-[10px] text-gg-muted">
      <div className="flex -space-x-1" aria-hidden="true">
        {previews.map((preview) => {
          const Icon = getPlugin(preview.type).icon
          return (
            <span
              key={preview.key}
              className={`flex h-7 w-7 items-center justify-center rounded-[8px] border border-white bg-gg-subtle ${
                preview.pending ? 'opacity-65' : ''
              }`}
            >
              <Icon size={12} />
            </span>
          )
        })}
      </div>
      <span className="whitespace-nowrap">{outputCount} 个产物</span>
      {artifactCount > 0 && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <FileOutput size={11} aria-hidden="true" /> {artifactCount}
        </span>
      )}
    </div>
  )
}

function CanvasGhostCard({
  ghost,
  task,
  status,
}: {
  ghost: CanvasGhostLayout
  task: CanvasTask
  status: CanvasTaskStatus
}) {
  const plugin = getPlugin(ghost.pluginId ?? 'file')
  const Icon = ghost.provisional ? Sparkles : plugin.icon
  const title = ghost.provisional ? task.title : ghost.title
  return (
    <article
      role="status"
      aria-label={`${title}，${ghost.phase === 'ready' ? '等待写入画布' : '正在生成'}`}
      data-ghost-key={ghost.key}
      data-ghost-phase={ghost.phase}
      data-ghost-provisional={ghost.provisional ? 'true' : 'false'}
      className="pointer-events-none absolute flex overflow-hidden rounded-[16px] border border-gg-line bg-gg-node shadow-sm motion-reduce:transition-none"
      style={{
        left: ghost.frame.x,
        top: ghost.frame.y,
        width: ghost.frame.w,
        height: ghost.frame.h,
      }}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <header
          data-testid="canvas-ghost-node-header"
          className="flex h-10 shrink-0 items-center gap-2 px-3 text-[12px] text-gg-ink"
        >
          <Icon size={14} className="shrink-0 text-gg-muted" strokeWidth={1.8} />
          <span className="truncate font-medium">{title}</span>
        </header>
        <div
          data-testid="canvas-ghost-generating-surface"
          className="flex min-h-0 flex-1 items-center justify-center"
        >
          <span className="grid grid-cols-3 gap-3" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 rounded-full bg-gg-primary/55 motion-safe:animate-pulse"
                style={{ animationDelay: `${index * 110}ms` }}
              />
            ))}
          </span>
        </div>
        <footer
          data-testid="canvas-ghost-node-activity"
          className="flex h-9 shrink-0 items-center gap-2 border-t border-gg-line px-3 text-[10.5px] font-medium text-gg-primary"
          aria-hidden="true"
        >
          <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
          <span>{status.label}</span>
        </footer>
      </div>
    </article>
  )
}
