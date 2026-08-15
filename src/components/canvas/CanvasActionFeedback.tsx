import { Undo2 } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { CanvasCommand } from '@/canvas/commands'

export interface CanvasConfirmation {
  title: string
  detail: string
  confirmLabel: string
  successLabel?: string
  command: CanvasCommand
  /** Node removal must survive an immediate navigation or reload. */
  commitImmediately?: boolean
}

export interface CanvasUndoOffer {
  label: string
  undoCommands?: CanvasCommand[]
  pendingCommand?: CanvasCommand
}

export interface CanvasActionFeedbackProps {
  confirmation: CanvasConfirmation | null
  confirmationCancelRef: { current: HTMLButtonElement | null }
  confirmationDialogRef: { current: HTMLDivElement | null }
  dismissConfirmation: () => void
  queueDestructive: (confirmation: CanvasConfirmation) => void
  undoLastAction: () => void
  undoOffer: CanvasUndoOffer | null
}

export default function CanvasActionFeedback(props: CanvasActionFeedbackProps) {
  const {
    confirmation,
    confirmationCancelRef,
    confirmationDialogRef,
    dismissConfirmation,
    queueDestructive,
    undoLastAction,
    undoOffer,
  } = props

  return (
    <>
      {undoOffer && (
        <div
          role="status"
          data-testid="canvas-undo"
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[12px] bg-[#1D2939] px-3 py-2 text-[11px] text-white shadow-float"
        >
          <span>{undoOffer.label}</span>
          <button
            type="button"
            onClick={undoLastAction}
            className="flex items-center gap-1 rounded-[7px] px-2 py-1 font-semibold text-[#9DC1FF] outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Undo2 size={12} aria-hidden="true" /> 撤销
          </button>
        </div>
      )}

      {confirmation && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[#101828]/20 p-6">
          <div
            ref={confirmationDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="canvas-confirm-title"
            aria-describedby="canvas-confirm-detail"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                dismissConfirmation()
              } else if (event.key === 'Tab') {
                trapDialogFocus(event, confirmationDialogRef.current)
              }
            }}
            className="w-full max-w-sm rounded-[16px] border border-gg-line bg-white p-5 shadow-float"
          >
            <h2 id="canvas-confirm-title" className="text-[14px] font-semibold text-gg-ink">
              {confirmation.title}
            </h2>
            <p id="canvas-confirm-detail" className="mt-2 text-[11px] leading-5 text-gg-muted">
              {confirmation.detail}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={confirmationCancelRef}
                type="button"
                onClick={dismissConfirmation}
                className="rounded-[9px] border border-gg-line px-3 py-2 text-[11px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => queueDestructive(confirmation)}
                className="rounded-[9px] bg-[#B42318] px-3 py-2 text-[11px] font-semibold text-white outline-none hover:bg-[#912018] focus-visible:ring-2 focus-visible:ring-[#F97066]"
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function trapDialogFocus(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLDivElement | null,
): void {
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )]
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable.at(-1)!
  const active = globalThis.document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}
