import {
  Boxes,
  Copy,
  FolderPlus,
  MessageSquareText,
  Trash2,
  X,
} from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasCameraState } from '@/canvas/persistence'
import type { CanvasBounds } from '@/canvas/selectors'
import type { NodeMark } from '@/plugins/types'
import CanvasConnectionPort, {
  type CanvasConnectionPortSide,
} from './CanvasConnectionPort'
import CanvasNodeShell from './CanvasNodeShell'

const PORTS: Array<{
  side: CanvasConnectionPortSide
  label: string
  className: string
}> = [
  {
    side: 'top',
    label: '上方',
    className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
  },
  {
    side: 'right',
    label: '右侧',
    className: 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2',
  },
  {
    side: 'bottom',
    label: '下方',
    className: 'left-1/2 top-full -translate-x-1/2 -translate-y-1/2',
  },
  {
    side: 'left',
    label: '左侧',
    className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
  },
]

export function CanvasSelectionWorldSurface({
  bounds,
  compound,
  showPorts = true,
  count,
  activePortSide,
  onPortActivate,
  onPortDragStart,
}: {
  bounds: CanvasBounds
  compound: boolean
  /** Task 仍持有选中输出时保留选择轮廓，但不暴露结构连接入口。 */
  showPorts?: boolean
  count: number
  activePortSide: CanvasConnectionPortSide | null
  onPortActivate: (side: CanvasConnectionPortSide) => void
  /** 按住端口拖出一根线：落到实体上完成连接，落到空白弹新建节点菜单。 */
  onPortDragStart?: (
    side: CanvasConnectionPortSide,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
}) {
  const ports = showPorts && PORTS.map(({ side, label, className }) => (
    <CanvasConnectionPort
      key={side}
      label={`${label}${compound ? '组合节点' : '所选节点'}端口`}
      title={compound ? '连接全部选中项' : '从节点新建节点'}
      active={activePortSide === side}
      side={side}
      className={className}
      onDragStart={(event) => onPortDragStart?.(side, event)}
      onActivate={() => onPortActivate(side)}
    />
  ))

  if (compound) {
    return (
      <CanvasNodeShell
        role="group"
        aria-label={`组合节点，包含 ${count} 个选中项`}
        data-testid="canvas-selection-hull"
        data-selection-count={count}
        frame={bounds}
        zIndex={0}
        pointerEvents="none"
        selected
        icon={Boxes}
        title={`组合节点 · ${count} 项`}
        bodyInset="none"
        overlay={ports}
      />
    )
  }

  return (
    <div
      data-testid={showPorts ? 'canvas-single-selection-ports' : undefined}
      data-selection-count={count}
      className="pointer-events-none absolute"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        zIndex: 30,
      }}
    >
      {ports}
    </div>
  )
}

export function CanvasSelectionToolbar({
  bounds,
  camera,
  compound,
  canSaveCollection,
  nodeActions = [],
  nodeMarks = [],
  onFocusComposer,
  onNodeAction,
  onToggleNodeMark,
  onDuplicate,
  onDelete,
  onSaveCollection,
  onClear,
}: {
  bounds: CanvasBounds
  camera: CanvasCameraState
  compound: boolean
  canSaveCollection: boolean
  /** 单选节点时的类型专属快捷指令（如图像节点的生成变体）。 */
  nodeActions?: string[]
  /** 单选节点时的标记按钮（如文本节点的粗体 / 斜体 / 标题）：直接改写节点。 */
  nodeMarks?: NodeMark[]
  onFocusComposer: () => void
  onNodeAction?: (prompt: string) => void
  onToggleNodeMark?: (markId: string) => void
  onDuplicate?: () => void
  onDelete?: () => void
  onSaveCollection?: () => void
  onClear: () => void
}) {
  const left = camera.x + (bounds.x + bounds.w / 2) * camera.zoom
  const top = camera.y + bounds.y * camera.zoom
  return (
    <div
      role="group"
      aria-label={compound ? '组合节点工具栏' : '所选节点工具栏'}
      data-testid="canvas-selection-toolbar"
      data-selection-mode={compound ? 'compound' : 'single'}
      data-no-drag
      className="absolute z-50 flex items-center gap-0.5 rounded-[16px] border border-gg-line bg-gg-node p-1 shadow-float"
      style={{ left, top, transform: 'translate(-50%, calc(-100% - 10px))' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={compound ? '使用组合节点创建任务' : '打开节点提示词控件'}
        onClick={onFocusComposer}
        className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gg-subtle text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
      >
        <MessageSquareText size={14} aria-hidden="true" />
      </button>

      {compound && onSaveCollection && (
        <button
          type="button"
          disabled={!canSaveCollection}
          aria-label="将组合节点保存为集合"
          title="保存为集合"
          onClick={onSaveCollection}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
      )}

      {!compound && nodeMarks.length > 0 && onToggleNodeMark && (
        <>
          <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
          {nodeMarks.map((mark) => {
            const MarkIcon = mark.icon
            return (
              <button
                key={mark.id}
                type="button"
                title={mark.title}
                aria-label={mark.title}
                aria-pressed={mark.active}
                data-node-mark={mark.id}
                onClick={() => onToggleNodeMark(mark.id)}
                className={`flex h-7 w-7 items-center justify-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
                  mark.active
                    ? 'bg-gg-subtle text-gg-primary'
                    : 'text-gg-ink hover:bg-gg-subtle'
                }`}
              >
                <MarkIcon size={14} aria-hidden="true" />
              </button>
            )
          })}
        </>
      )}

      {!compound && nodeMarks.length === 0 && nodeActions.length > 0 && onNodeAction && (
        <>
          <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
          {nodeActions.slice(0, 5).map((prompt) => (
            <button
              key={prompt}
              type="button"
              title="填入提示词，不会自动运行"
              onClick={() => onNodeAction(prompt)}
              className="flex h-7 items-center rounded-[8px] px-2 text-[11px] text-gg-ink outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              {prompt}
            </button>
          ))}
        </>
      )}

      {!compound && onDuplicate && (
        <button
          type="button"
          aria-label="复制所选节点"
          title="复制节点"
          onClick={onDuplicate}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <Copy size={14} aria-hidden="true" />
        </button>
      )}

      <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
      {compound ? (
        <button
          type="button"
          aria-label="取消组合节点选择"
          title="取消组合节点选择"
          onClick={onClear}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-danger focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : onDelete ? (
        <button
          type="button"
          aria-label="从画布移除所选节点"
          title="从画布移除"
          onClick={onDelete}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-danger focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
