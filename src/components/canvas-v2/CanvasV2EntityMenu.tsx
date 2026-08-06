import { Ellipsis } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'

export interface CanvasV2MenuItem {
  id: string
  label: string
  destructive?: boolean
  disabled?: boolean
}

export default function CanvasV2EntityMenu({
  label,
  items,
  onAction,
}: {
  label: string
  items: CanvasV2MenuItem[]
  onAction: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    setOpen(false)
  }

  return (
    <div className="relative" data-no-drag onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
      >
        <Ellipsis size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-8 z-[80] min-w-40 rounded-[10px] border border-gg-line bg-white p-1 shadow-float"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setOpen(false)
                onAction(item.id)
              }}
              className={`block w-full rounded-[7px] px-2.5 py-2 text-left text-[11px] outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:opacity-45 ${
                item.destructive ? 'text-[#B42318]' : 'text-gg-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
