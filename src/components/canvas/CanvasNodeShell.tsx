import type {
  ComponentPropsWithoutRef,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
  Ref,
} from 'react'
import type { LucideIcon } from 'lucide-react'
import type { CanvasBounds } from '@/canvas/selectors'

interface CanvasNodeHeaderButton {
  pressed: boolean
  tabIndex: number
  focusKey: string
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>
  onPointerDown: PointerEventHandler<HTMLButtonElement>
}

export interface CanvasNodeShellProps extends Omit<
  ComponentPropsWithoutRef<'article'>,
  'children' | 'className' | 'style' | 'title'
> {
  frame: CanvasBounds
  zIndex: number
  pointerEvents: 'auto' | 'none'
  selected: boolean
  /** 成为组合节点的成员时，成员保留原壳但不重复绘制蓝色选择描边。 */
  compoundSelected?: boolean
  icon: LucideIcon
  title: string
  headerButtonRef?: Ref<HTMLButtonElement>
  headerButton?: CanvasNodeHeaderButton
  actions?: ReactNode
  footer?: ReactNode
  overlay?: ReactNode
  bodyInset?: 'standard' | 'none'
  children?: ReactNode
}

/**
 * Canvas 中唯一的 Node 外壳。
 *
 * 普通节点、Node Studio 预览和临时组合节点都必须经过这里。调用方只能提供
 * 标题、内容、底部状态与受限操作，不能另造圆角、描边、标题条或选择态。
 */
export default function CanvasNodeShell({
  frame,
  zIndex,
  pointerEvents,
  selected,
  compoundSelected = false,
  icon: Icon,
  title,
  headerButtonRef,
  headerButton,
  actions,
  footer,
  overlay,
  bodyInset = 'standard',
  children,
  ...articleProps
}: CanvasNodeShellProps) {
  const headerContent = (
    <>
      <Icon size={14} className="shrink-0 text-gg-muted" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gg-ink">
        {title}
      </span>
    </>
  )

  return (
    <article
      {...articleProps}
      data-node-shell="true"
      className={`group absolute flex flex-col overflow-visible rounded-[16px] border bg-gg-node shadow-sm motion-reduce:transition-none ${
        selected && !compoundSelected
          ? 'border-[1.5px] border-gg-select shadow-float'
          : 'border-gg-line hover:border-[#C7D2E0]'
      } ${pointerEvents === 'auto' ? 'pointer-events-auto' : 'pointer-events-none'}`}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        zIndex,
      }}
    >
      <header className="flex h-9 shrink-0 select-none items-center gap-2 px-3">
        {headerButton ? (
          <button
            ref={headerButtonRef}
            type="button"
            data-focus-key={headerButton.focusKey}
            aria-pressed={headerButton.pressed}
            tabIndex={headerButton.tabIndex}
            onFocus={headerButton.onFocus}
            onKeyDown={headerButton.onKeyDown}
            onPointerDown={headerButton.onPointerDown}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[8px] text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 active:cursor-grabbing"
          >
            {headerContent}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {headerContent}
          </div>
        )}
        {actions}
      </header>

      <div className={`min-h-0 flex-1 overflow-hidden ${
        bodyInset === 'standard' ? 'p-3' : ''
      }`}>
        {children}
      </div>

      {footer}
      {overlay}
    </article>
  )
}
