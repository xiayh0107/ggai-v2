import { useEffect, useRef, type ReactNode } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Canvas 统一的右侧抽屉面板壳：产物查看、详细运行日志等都走这个形态，
 * 不再使用居中弹窗。浅色背板点击 / Esc 关闭；画布在背板后保持原位。
 */
export default function CanvasRightDrawer({
  ariaLabel,
  testId,
  onClose,
  children,
}: {
  ariaLabel: string
  testId?: string
  onClose: () => void
  children: ReactNode
}) {
  const drawerRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const drawer = drawerRef.current
      if (!drawer) return
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        drawer.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [])

  return (
    <div
      className="absolute inset-0 z-[70]"
      data-canvas-side-panel
      data-no-drag
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-[#0B1526]/20"
        data-testid="canvas-right-drawer-backdrop"
        onPointerDown={(event) => {
          event.stopPropagation()
          onClose()
        }}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-no-drag
        tabIndex={-1}
        className="absolute bottom-0 right-0 top-0 flex w-[min(560px,92vw)] flex-col border-l border-gg-line bg-gg-node shadow-float"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  )
}
