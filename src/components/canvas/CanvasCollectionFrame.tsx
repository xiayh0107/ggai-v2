import { ChevronDown, ChevronRight, FolderKanban, Grip } from 'lucide-react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { COLLECTION_CHROME_LAYOUT } from '@/canvas/layout'
import type { CanvasCollection } from '@/canvas/model'
import type { CanvasBounds } from '@/canvas/selectors'
import CanvasEdgePort from './CanvasEdgePort'
import CanvasEntityMenu from './CanvasEntityMenu'

export default function CanvasCollectionFrame({
  collection,
  bounds,
  collapsed,
  selected,
  compoundSelected = false,
  memberCount,
  artifactCount,
  offset,
  tabIndex,
  connectionActive,
  canAddSelection = false,
  onFocus,
  onKeyDown,
  onDragStart,
  onToggle,
  onPortActivate,
  onPortDragStart,
  onMenuAction,
  registerFocusable,
}: {
  collection: CanvasCollection
  bounds: CanvasBounds
  collapsed: boolean
  selected: boolean
  compoundSelected?: boolean
  memberCount: number
  artifactCount: number
  offset?: { dx: number; dy: number }
  tabIndex: number
  connectionActive: boolean
  canAddSelection?: boolean
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLElement>, collection: CanvasCollection) => void
  onToggle: () => void
  onPortActivate: () => void
  /** 按住集合端口拖出一根线：落到实体上完成连接。 */
  onPortDragStart?: (event: PointerEvent<HTMLButtonElement>) => void
  onMenuAction: (action: string) => void
  registerFocusable: (element: HTMLButtonElement | null) => void
}) {
  const frame = collapsed ? {
    x: collection.anchor.x,
    y: collection.anchor.y,
    w: COLLECTION_CHROME_LAYOUT.collapsedWidth,
    h: COLLECTION_CHROME_LAYOUT.collapsedHeight,
  } : {
    ...bounds,
    w: Math.max(bounds.w, COLLECTION_CHROME_LAYOUT.minimumWidth),
    h: Math.max(bounds.h, COLLECTION_CHROME_LAYOUT.minimumHeight),
  }
  const regionId = `canvas-collection-${collection.id}-members`

  return (
    <section
      role="group"
      aria-label={`集合${collection.title}，${memberCount} 个成员`}
      data-canvas-entity="collection"
      data-collection-id={collection.id}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-compound-selected={compoundSelected ? 'true' : 'false'}
      className="pointer-events-none absolute left-0 top-0"
      style={offset ? { transform: `translate(${offset.dx}px, ${offset.dy}px)` } : undefined}
    >
      <div
        data-collection-border={collection.id}
        className={`pointer-events-auto absolute rounded-[20px] border bg-[#F7F9FC]/75 shadow-sm ${
          selected && !compoundSelected
            ? 'border-[1.5px] border-gg-select'
            : 'border-[#C7D2E0]'
        } ${collapsed ? 'bg-white/95' : ''}`}
        style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [data-no-drag]')) return
          onDragStart(event, collection)
        }}
      />
      <div
        className="pointer-events-auto absolute flex h-11 items-center gap-2 rounded-[12px] border border-gg-line bg-white px-2 shadow-sm"
        style={{ left: frame.x + 10, top: frame.y + 10, minWidth: 280 }}
      >
        <button
          ref={registerFocusable}
          type="button"
          data-focus-key={`collection:${collection.id}`}
          aria-pressed={selected}
          tabIndex={tabIndex}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => onDragStart(event, collection)}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[8px] text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 active:cursor-grabbing"
        >
          <Grip size={13} className="shrink-0 text-[#98A2B3]" aria-hidden="true" />
          <FolderKanban size={14} className="shrink-0 text-gg-primary" aria-hidden="true" />
          <span className="truncate text-[12px] font-semibold text-gg-ink">{collection.title}</span>
          <span className="shrink-0 text-[10px] text-gg-muted">{memberCount} 项</span>
          {artifactCount > 0 && (
            <span className="shrink-0 text-[10px] text-gg-muted">{artifactCount} 产物</span>
          )}
        </button>
        {!compoundSelected && (
          <CanvasEdgePort
            label={connectionActive
              ? `取消从集合${collection.title}的连接`
              : `从集合${collection.title}开始或完成连接`}
            active={connectionActive}
            onActivate={onPortActivate}
            onDragStart={onPortDragStart}
          />
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={regionId}
          aria-label={collapsed ? `展开集合${collection.title}` : `折叠集合${collection.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <CanvasEntityMenu
          label={`${collection.title}集合菜单`}
          items={[
            ...(canAddSelection
              ? [{ id: 'add-selection', label: '加入所选内容' }]
              : []),
            { id: 'duplicate', label: '复制集合' },
            { id: 'dissolve', label: '解散集合（保留成员）' },
            { id: 'delete-contents', label: '删除集合及内容', destructive: true },
          ]}
          onAction={onMenuAction}
        />
      </div>
      <span id={regionId} className="sr-only">
        {collapsed ? '成员已折叠' : '成员已展开'}
      </span>
    </section>
  )
}
