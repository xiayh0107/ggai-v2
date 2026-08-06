import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileOutput,
  Grip,
  Loader2,
  PackageCheck,
} from 'lucide-react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { TASK_CHROME_LAYOUT_V2 } from '@/canvas-v2/layout'
import type { CanvasNodeV2, CanvasTaskV2 } from '@/canvas-v2/model'
import type {
  CanvasGhostLayoutV2,
  CanvasTaskStatusV2,
  CanvasTaskViewV2,
} from '@/canvas-v2/selectors'
import { getPlugin } from '@/plugins/types'
import CanvasV2EdgePort from './CanvasV2EdgePort'
import CanvasV2EntityMenu from './CanvasV2EntityMenu'
import CanvasV2NodeCard from './CanvasV2NodeCard'

export interface CanvasV2TaskGroupProps {
  view: CanvasTaskViewV2
  projectDir: string
  selectedTask: boolean
  selectedNodeIds: ReadonlySet<string>
  explicitlyCollapsed: boolean
  activeKey: string | null
  offset?: { dx: number; dy: number }
  nodeFrames?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>
  onSelectTask: (task: CanvasTaskV2, additive: boolean) => void
  onToggleCollapsed: (taskId: string, collapsed: boolean) => void
  onTaskDragStart: (event: PointerEvent<HTMLElement>, task: CanvasTaskV2) => void
  onNodeDragStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNodeV2) => void
  onNodeResizeStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNodeV2) => void
  onTaskPortActivate?: (task: CanvasTaskV2) => void
  onNodePortActivate?: (node: CanvasNodeV2) => void
  activeConnectionKey?: string | null
  onTaskMenuAction?: (task: CanvasTaskV2, action: string) => void
  onNodeMenuAction?: (node: CanvasNodeV2, action: string) => void
  onHoverChange?: (hovered: boolean) => void
  onEntityFocus: (key: string) => void
  onEntityKeyDown: (key: string, event: KeyboardEvent<HTMLButtonElement>) => void
  registerFocusable: (key: string, element: HTMLButtonElement | null) => void
}

export default function CanvasV2TaskGroup({
  view,
  projectDir,
  selectedTask,
  selectedNodeIds,
  explicitlyCollapsed,
  activeKey,
  offset,
  nodeFrames,
  onSelectTask,
  onToggleCollapsed,
  onTaskDragStart,
  onNodeDragStart,
  onNodeResizeStart,
  onTaskPortActivate,
  onNodePortActivate,
  activeConnectionKey,
  onTaskMenuAction,
  onNodeMenuAction,
  onHoverChange,
  onEntityFocus,
  onEntityKeyDown,
  registerFocusable,
}: CanvasV2TaskGroupProps) {
  const { task } = view
  const collapsed = view.presentation === 'collapsed'
  const compact = view.presentation === 'compact'
  const outputCount = view.nodes.length + view.ghosts.length
  const outputRegionId = `canvas-v2-task-${task.id}-outputs`
  const taskKey = `task:${task.id}`
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
      onPortActivate={onTaskPortActivate ? () => onTaskPortActivate(task) : undefined}
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
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {collapsed ? (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute overflow-hidden rounded-[16px] border bg-gg-node shadow-sm motion-reduce:transition-none ${
            selectedTask ? 'border-[1.5px] border-gg-select shadow-float' : 'border-gg-line'
          }`}
          style={{
            left: task.anchor.x,
            top: task.anchor.y,
            width: TASK_CHROME_LAYOUT_V2.collapsedWidth,
            height: TASK_CHROME_LAYOUT_V2.collapsedHeight,
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
            selectedTask ? 'border-[1.5px] border-gg-select shadow-float' : 'border-gg-line'
          }`}
          style={{
            left: task.anchor.x,
            top: task.anchor.y,
            width: TASK_CHROME_LAYOUT_V2.cardWidth,
            height: compact
              ? TASK_CHROME_LAYOUT_V2.compactHeight
              : TASK_CHROME_LAYOUT_V2.cardHeight,
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
      ) : view.containerKind === 'title-strip' ? (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute flex items-center rounded-[16px] border bg-gg-node px-3 shadow-sm motion-reduce:transition-none ${
            selectedTask ? 'border-[1.5px] border-gg-select shadow-float' : 'border-gg-line'
          }`}
          style={{
            left: task.anchor.x,
            top: task.anchor.y,
            width: TASK_CHROME_LAYOUT_V2.titleStripWidth,
            height: TASK_CHROME_LAYOUT_V2.titleStripHeight,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          <div className="min-w-0 flex-1">{taskHeader}</div>
        </div>
      ) : (
        <div
          data-task-border={task.id}
          className={`pointer-events-auto absolute rounded-[18px] border bg-white/45 shadow-sm motion-reduce:transition-none ${
            selectedTask ? 'border-[1.5px] border-gg-select' : 'border-gg-line'
          }`}
          style={{
            left: view.bounds.x,
            top: view.bounds.y,
            width: view.bounds.w,
            height: view.bounds.h,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
            onTaskDragStart(event, task)
          }}
        >
          <div
            className="absolute left-3 top-3 max-w-[420px] rounded-[11px] border border-gg-line bg-gg-node px-2.5 py-2 shadow-sm"
          >
            {taskHeader}
          </div>
        </div>
      )}

      {!collapsed && (
        <div id={outputRegionId} aria-label={`${task.title}的产物`}>
          {view.nodes.map((node) => (
            <CanvasV2NodeCard
              key={node.id}
              node={node}
              frame={nodeFrames?.get(node.id)}
              projectDir={projectDir}
              selected={selectedNodeIds.has(node.id)}
              compact={compact}
              tabIndex={activeKey === `node:${node.id}` ? 0 : -1}
              onFocus={() => onEntityFocus(`node:${node.id}`)}
              onKeyDown={(event) => onEntityKeyDown(`node:${node.id}`, event)}
              onDragStart={onNodeDragStart}
              onResizeStart={onNodeResizeStart}
              onPortActivate={onNodePortActivate}
              connectionActive={activeConnectionKey === `node:${node.id}`}
              onMenuAction={onNodeMenuAction}
              registerFocusable={(element) => registerFocusable(`node:${node.id}`, element)}
            />
          ))}
          {view.ghosts.map((ghost) => (
            <CanvasV2GhostCard key={ghost.key} ghost={ghost} compact={compact} />
          ))}
        </div>
      )}
    </section>
  )
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
  onMenuAction,
  onToggle,
  registerFocusable,
}: {
  task: CanvasTaskV2
  status: CanvasTaskStatusV2
  selected: boolean
  collapsed: boolean
  outputRegionId: string
  tabIndex: number
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLButtonElement>) => void
  connectionActive: boolean
  onPortActivate?: () => void
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
        <CanvasV2EdgePort
          label={connectionActive
            ? `取消从任务${task.title}的连接`
            : `从任务${task.title}开始或完成连接`}
          active={connectionActive}
          onActivate={onPortActivate}
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
        <CanvasV2EntityMenu
          label={`${task.title}任务菜单`}
          items={[
            { id: 'duplicate', label: '复制为草稿任务' },
            ...(task.collectionId
              ? [{ id: 'remove-collection', label: '移出集合' }]
              : []),
            { id: 'delete', label: '删除任务（保留产物）', destructive: true },
            { id: 'delete-views', label: '删除任务及全部视图', destructive: true },
          ]}
          onAction={onMenuAction}
        />
      )}
    </div>
  )
}

function TaskStatus({ status }: { status: CanvasTaskStatusV2 }) {
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
  nodes: CanvasNodeV2[]
  ghosts: CanvasGhostLayoutV2[]
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

function CanvasV2GhostCard({
  ghost,
  compact,
}: {
  ghost: CanvasGhostLayoutV2
  compact: boolean
}) {
  const plugin = getPlugin(ghost.pluginId ?? 'file')
  const Icon = plugin.icon
  return (
    <article
      role="status"
      aria-label={`${ghost.title}，${ghost.phase === 'ready' ? '等待写入画布' : '正在生成'}`}
      data-ghost-key={ghost.key}
      data-ghost-phase={ghost.phase}
      className="pointer-events-none absolute overflow-hidden rounded-[16px] border border-dashed border-[#B9C7DA] bg-white/75 motion-reduce:transition-none"
      style={{
        left: ghost.frame.x,
        top: ghost.frame.y,
        width: ghost.frame.w,
        height: ghost.frame.h,
      }}
    >
      <header className="flex h-10 items-center gap-2 border-b border-gg-line px-3 text-[12px] text-gg-muted">
        <Icon size={14} />
        <span className="truncate">{ghost.title}</span>
      </header>
      <div className="gg-shimmer h-[calc(100%-2.5rem)] space-y-3 p-3 motion-reduce:[&_*]:animate-none">
        <div className="h-3 w-2/5 rounded bg-[#E4EAF2]" />
        <div className={`${compact ? 'h-10' : 'h-[126px]'} rounded-[10px] bg-[#E4EAF2]`} />
        {!compact && <div className="h-3 w-3/5 rounded bg-[#E4EAF2]" />}
      </div>
    </article>
  )
}
