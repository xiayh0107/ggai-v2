import {
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  applyCanvasCommand,
  type CanvasCommand,
} from '@/canvas/commands'
import type { CanvasDocument } from '@/canvas/model'
import type { CanvasStore } from '@/canvas/store'
import {
  dispatchCommands,
  errorMessage,
} from './CanvasStage.logic'
import type {
  CanvasActionFeedbackProps,
  CanvasConfirmation,
  CanvasUndoOffer,
} from './CanvasActionFeedback'

interface CanvasActionHistoryOptions {
  document: CanvasDocument
  store: CanvasStore
  stageRef: { current: HTMLDivElement | null }
  setNotice: (notice: string | null) => void
}

interface CanvasActionHistory {
  optimisticDocument: CanvasDocument
  requestConfirmation: (confirmation: CanvasConfirmation) => void
  showUndoOffer: (offer: CanvasUndoOffer, delayMs?: number) => void
  dispatchWithUndo: (
    command: CanvasCommand,
    label: string,
    undoCommands: CanvasCommand[],
  ) => void
  feedbackProps: CanvasActionFeedbackProps
}

/** Owns delayed destructive commits, undo offers and confirmation focus semantics. */
export function useCanvasActionHistory(
  options: CanvasActionHistoryOptions,
): CanvasActionHistory {
  const { document, store, stageRef, setNotice } = options
  const confirmationDialogRef = useRef<HTMLDivElement>(null)
  const confirmationCancelRef = useRef<HTMLButtonElement>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [confirmation, setConfirmation] = useState<CanvasConfirmation | null>(null)
  const [undoOffer, setUndoOffer] = useState<CanvasUndoOffer | null>(null)

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
  }, [])

  useEffect(() => {
    if (!confirmation) return
    const returnFocus = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
      : null
    const stage = stageRef.current
    confirmationCancelRef.current?.focus()
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus()
      else stage?.focus()
    }
  }, [confirmation, stageRef])

  let optimisticDocument = document
  if (undoOffer?.pendingCommand) {
    try {
      optimisticDocument = applyCanvasCommand(document, undoOffer.pendingCommand)
    } catch {
      // A concurrent optimistic change can invalidate the pending deletion.
      // The timer will surface the dispatch error and restore the full document.
    }
  }

  const clearUndoOffer = () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = null
    setUndoOffer(null)
  }

  const showUndoOffer = (offer: CanvasUndoOffer, delayMs = 6_000) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoOffer(offer)
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null
      if (!offer.pendingCommand) {
        setUndoOffer((current) => current === offer ? null : current)
        return
      }
      void store.dispatchCommand(offer.pendingCommand).then(() => {
        setUndoOffer((current) => current === offer ? null : current)
      }).catch((error: unknown) => {
        setUndoOffer((current) => current === offer ? null : current)
        setNotice(`操作未保存，已恢复画布：${errorMessage(error)}`)
      })
    }, delayMs)
  }

  const dispatchWithUndo = (
    command: CanvasCommand,
    label: string,
    undoCommands: CanvasCommand[],
  ) => {
    void store.dispatchCommand(command)
      .then(() => showUndoOffer({ label, undoCommands }))
      .catch((error: unknown) => setNotice(errorMessage(error)))
  }

  const queueDestructive = (action: CanvasConfirmation) => {
    setConfirmation(null)
    if (action.commitImmediately) {
      void store.dispatchCommand(action.command)
        .then(async () => {
          await store.flushCommands()
          const sync = store.getSnapshot().commandSync
          if (sync.status === 'conflict' || sync.status === 'error') {
            throw new Error(sync.error ?? sync.conflict?.message ?? '画布同步失败')
          }
          stageRef.current?.focus()
          setNotice(action.successLabel ?? `已完成：${action.confirmLabel}`)
        })
        .catch((error: unknown) => setNotice(`操作未保存：${errorMessage(error)}`))
      return
    }
    showUndoOffer({
      label: action.successLabel ?? `已完成：${action.confirmLabel}`,
      pendingCommand: action.command,
    }, 5_000)
  }

  const undoLastAction = () => {
    const offer = undoOffer
    clearUndoOffer()
    if (!offer?.undoCommands) return
    void dispatchCommands(store, offer.undoCommands)
      .catch((error: unknown) => setNotice(errorMessage(error)))
  }

  return {
    optimisticDocument,
    requestConfirmation: setConfirmation,
    showUndoOffer,
    dispatchWithUndo,
    feedbackProps: {
      confirmation,
      confirmationCancelRef,
      confirmationDialogRef,
      dismissConfirmation: () => setConfirmation(null),
      queueDestructive,
      undoLastAction,
      undoOffer,
    },
  }
}
