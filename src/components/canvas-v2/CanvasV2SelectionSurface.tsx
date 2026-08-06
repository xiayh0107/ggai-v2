import {
  Copy,
  FolderPlus,
  MessageSquareText,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import type { PointerEvent } from 'react'
import type { CanvasV2CameraState } from '@/canvas-v2/persistence'
import type { CanvasBoundsV2 } from '@/canvas-v2/selectors'

export type CanvasV2SelectionPortSide = 'top' | 'right' | 'bottom' | 'left'

const PORTS: Array<{
  side: CanvasV2SelectionPortSide
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

export function CanvasV2SelectionWorldSurface({
  bounds,
  compound,
  solid = true,
  count,
  connectionActive,
  onDragStart,
  onPortActivate,
}: {
  bounds: CanvasBoundsV2
  compound: boolean
  solid?: boolean
  count: number
  connectionActive: boolean
  onDragStart?: (event: PointerEvent<HTMLDivElement>) => void
  onPortActivate: (side: CanvasV2SelectionPortSide) => void
}) {
  return (
    <div
      role={compound ? 'group' : undefined}
      aria-label={compound ? `临时选择组，${count} 个画布实体` : undefined}
      data-testid={compound ? 'canvas-v2-selection-hull' : 'canvas-v2-single-selection-ports'}
      data-selection-count={count}
      className={`absolute rounded-[18px] ${
        compound
          ? `pointer-events-auto border-[1.5px] border-gg-select ${
              solid ? 'bg-gg-node shadow-float' : 'bg-transparent'
            }`
          : 'pointer-events-none'
      }`}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        zIndex: compound ? 1 : 30,
      }}
      onPointerDown={(event) => {
        if (!compound || (event.target as HTMLElement).closest('button')) return
        onDragStart?.(event)
      }}
    >
      {PORTS.map(({ side, label, className }) => (
        <button
          key={side}
          type="button"
          aria-label={`${label}${compound ? '临时选择组' : '所选节点'}连接端口`}
          aria-pressed={connectionActive}
          title={compound ? '连接全部选中项' : '从节点连接或创建关系'}
          data-selection-port={side}
          data-no-drag
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onPortActivate(side)}
          className={`pointer-events-auto absolute z-30 flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-gg-select bg-white text-gg-select outline-none hover:scale-110 hover:bg-[#EAF1FD] focus-visible:ring-2 focus-visible:ring-gg-primary/40 motion-reduce:transform-none ${className} ${
            connectionActive ? 'bg-[#EAF1FD]' : ''
          }`}
        >
          <Plus size={11} strokeWidth={2.2} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

export function CanvasV2SelectionToolbar({
  bounds,
  camera,
  compound,
  count,
  canSaveCollection,
  onFocusComposer,
  onDuplicate,
  onDelete,
  onSaveCollection,
  onClear,
}: {
  bounds: CanvasBoundsV2
  camera: CanvasV2CameraState
  compound: boolean
  count: number
  canSaveCollection: boolean
  onFocusComposer: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onSaveCollection?: () => void
  onClear: () => void
}) {
  const left = camera.x + (bounds.x + bounds.w / 2) * camera.zoom
  const top = camera.y + bounds.y * camera.zoom
  return (
    <div
      role="toolbar"
      aria-label={compound ? `${count} 个选中项的工具栏` : '所选节点工具栏'}
      data-testid="canvas-v2-selection-toolbar"
      data-selection-mode={compound ? 'compound' : 'single'}
      data-no-drag
      className="absolute z-50 flex items-center gap-0.5 rounded-[16px] border border-gg-line bg-gg-node p-1 shadow-float"
      style={{ left, top, transform: 'translate(-50%, calc(-100% - 10px))' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={compound ? `使用 ${count} 个选中项创建任务` : '打开节点提示词控件'}
        aria-pressed
        onClick={onFocusComposer}
        className={`flex h-7 items-center justify-center gap-1.5 rounded-[8px] bg-gg-subtle text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
          compound ? 'px-2 text-[11px] font-medium' : 'w-7'
        }`}
      >
        <MessageSquareText size={14} aria-hidden="true" />
        {compound && <span>{count} 个节点</span>}
      </button>

      {compound && onSaveCollection && (
        <button
          type="button"
          disabled={!canSaveCollection}
          aria-label="把临时选择保存为集合"
          title="保存为集合"
          onClick={onSaveCollection}
          className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[11px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderPlus size={13} aria-hidden="true" /> 保存
        </button>
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
          aria-label="取消临时成组"
          title="取消临时成组"
          onClick={onClear}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-danger focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : onDelete ? (
        <button
          type="button"
          aria-label="删除所选节点"
          title="删除节点"
          onClick={onDelete}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-danger focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
