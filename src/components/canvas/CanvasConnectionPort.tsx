import { Plus } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type CanvasConnectionPortSide = 'top' | 'right' | 'bottom' | 'left'

export default function CanvasConnectionPort({
  label,
  title,
  active,
  side,
  className = '',
  onActivate,
  onDragStart,
}: {
  label: string
  title: string
  active: boolean
  /** Spatial ports sit on one side of a selected Node; inline ports omit it. */
  side?: CanvasConnectionPortSide
  className?: string
  onActivate: () => void
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const spatial = side !== undefined
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      {...(spatial ? { 'data-selection-port': side } : { 'data-edge-port': true })}
      data-no-drag
      onPointerDown={(event) => {
        event.stopPropagation()
        onDragStart?.(event)
      }}
      onClick={onActivate}
      className={`${spatial ? 'pointer-events-auto absolute z-30' : 'shrink-0'} flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-gg-select bg-white text-gg-select outline-none hover:scale-110 hover:bg-[#EAF1FD] focus-visible:ring-2 focus-visible:ring-gg-primary/40 motion-reduce:transform-none ${className} ${
        active ? 'bg-[#EAF1FD]' : ''
      }`}
    >
      <Plus size={11} strokeWidth={2.2} aria-hidden="true" />
    </button>
  )
}
