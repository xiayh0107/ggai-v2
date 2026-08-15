import { Link2 } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export default function CanvasEdgePort({
  label,
  active,
  onActivate,
  onDragStart,
}: {
  label: string
  active: boolean
  onActivate: () => void
  /** 按住端口拖出一根线：落到实体上完成连接，落到空白弹新建节点菜单。 */
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-edge-port
      data-no-drag
      onPointerDown={(event) => {
        event.stopPropagation()
        onDragStart?.(event)
      }}
      onClick={onActivate}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/40 ${
        active
          ? 'border-gg-primary bg-[#EAF1FD] text-gg-primary'
          : 'border-gg-line bg-white text-gg-muted hover:border-gg-primary hover:text-gg-primary'
      }`}
    >
      <Link2 size={12} aria-hidden="true" />
    </button>
  )
}
