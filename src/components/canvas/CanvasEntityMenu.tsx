import { Ellipsis } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

export interface CanvasMenuItem {
  id: string
  label: string
  destructive?: boolean
  disabled?: boolean
}

export default function CanvasEntityMenu({
  label,
  items,
  onAction,
  className,
}: {
  label: string
  items: CanvasMenuItem[]
  onAction: (id: string) => void
  /** 追加到根节点的类名：用于悬停 / 选中才显现的轻量触发器。 */
  className?: string
}) {
  const triggerId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const enabledIndices = () => items
    .map((item, index) => item.disabled ? -1 : index)
    .filter((index) => index >= 0)

  const openMenu = (edge: 'first' | 'last' = 'first') => {
    const enabled = enabledIndices()
    setActiveIndex(edge === 'last' ? enabled.at(-1) ?? -1 : enabled[0] ?? -1)
    setOpen(true)
  }

  const closeMenu = (restoreFocus = true) => {
    setOpen(false)
    setActiveIndex(-1)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const moveFocus = (direction: 1 | -1) => {
    const enabled = enabledIndices()
    if (enabled.length === 0) return
    const position = enabled.indexOf(activeIndex)
    const nextPosition = position < 0
      ? direction > 0 ? 0 : enabled.length - 1
      : (position + direction + enabled.length) % enabled.length
    setActiveIndex(enabled[nextPosition]!)
  }

  useEffect(() => {
    if (!open) return
    if (activeIndex < 0) menuRef.current?.focus()
    else itemRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  useEffect(() => {
    if (!open) return
    const onOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', onOutsidePointerDown, true)
    return () => document.removeEventListener('pointerdown', onOutsidePointerDown, true)
  }, [open])

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      openMenu('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      openMenu('last')
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      const enabled = enabledIndices()
      setActiveIndex(event.key === 'Home' ? enabled[0] ?? -1 : enabled.at(-1) ?? -1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }
  }

  return (
    <div ref={rootRef} className={`relative${className ? ` ${className}` : ''}`} data-no-drag>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${triggerId}-menu` : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={onTriggerKeyDown}
        className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
      >
        <Ellipsis size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={`${triggerId}-menu`}
          role="menu"
          aria-labelledby={triggerId}
          tabIndex={activeIndex < 0 ? -1 : undefined}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-8 z-[80] min-w-40 rounded-[10px] border border-gg-line bg-white p-1 shadow-float"
        >
          {items.map((item, index) => (
            <button
              ref={(element) => { itemRefs.current[index] = element }}
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={item.disabled}
              onPointerDown={(event) => event.stopPropagation()}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                closeMenu()
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
