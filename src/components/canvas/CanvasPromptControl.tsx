import type {
  CSSProperties,
  FormEventHandler,
  PointerEventHandler,
  ReactNode,
} from 'react'

export type CanvasPromptControlMode = 'draft' | 'running'

export interface CanvasPromptControlProps {
  mode: CanvasPromptControlMode
  title: ReactNode
  detail?: ReactNode
  shortcut?: ReactNode
  topContent?: ReactNode
  inputLeading?: ReactNode
  inputContent: ReactNode
  footerLeading?: ReactNode
  footerActions?: ReactNode
  bodyAfter?: ReactNode
  children?: ReactNode
  ariaLabel: string
  className?: string
  style?: CSSProperties
  onSubmit?: FormEventHandler<HTMLFormElement>
  onPointerDown?: PointerEventHandler<HTMLFormElement>
}

/**
 * The one visual and semantic prompt surface used by Canvas.
 *
 * Draft and running are states of this control, not separate panels. Consumers
 * supply their state-specific content while this component owns the stable
 * shell, hierarchy, input surface and footer slots.
 */
export default function CanvasPromptControl({
  mode,
  title,
  detail,
  shortcut,
  topContent,
  inputLeading,
  inputContent,
  footerLeading,
  footerActions,
  bodyAfter,
  children,
  ariaLabel,
  className = '',
  style,
  onSubmit,
  onPointerDown,
}: CanvasPromptControlProps) {
  return (
    <form
      data-testid="canvas-prompt-control"
      data-mode={mode}
      data-no-drag
      aria-label={ariaLabel}
      onSubmit={onSubmit}
      onPointerDown={onPointerDown}
      className={`overflow-hidden rounded-[16px] border border-gg-line bg-white shadow-float ${className}`}
      style={style}
    >
      <div className="p-2.5">
        <header className="mb-2 flex items-start justify-between gap-3 px-1">
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold text-gg-ink">
              {title}
            </div>
            {detail && (
              <div className="mt-0.5 min-w-0 text-[10px] leading-4 text-gg-muted">
                {detail}
              </div>
            )}
          </div>
          {shortcut && (
            <span className="shrink-0 pt-0.5 text-[9px] text-gg-muted">
              {shortcut}
            </span>
          )}
        </header>

        {topContent}

        <div
          data-testid="canvas-prompt-control-surface"
          className="relative flex min-h-[62px] items-end gap-2 rounded-[12px] border border-gg-line bg-white p-2 focus-within:border-gg-primary/55 focus-within:ring-2 focus-within:ring-gg-primary/10"
        >
          {inputLeading}
          {inputContent}
        </div>

        <footer
          data-testid="canvas-prompt-control-footer"
          className="mt-1.5 flex min-h-8 items-center gap-1 px-1"
        >
          {footerLeading}
          <span className="flex-1" />
          {footerActions}
        </footer>

        {bodyAfter}
      </div>

      {children}
    </form>
  )
}
