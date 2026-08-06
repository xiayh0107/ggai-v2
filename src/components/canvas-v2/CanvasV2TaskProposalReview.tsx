import {
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CanvasCommandV2 } from '@/canvas-v2/commands'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import type { CanvasTaskV2 } from '@/canvas-v2/model'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import type { CanvasV2TaskRunLifecycle } from '@/canvas-v2/runProvider'
import { selectProposalReviewV2 } from '@/canvas-v2/selectors'
import type { CanvasV2StoreState } from '@/canvas-v2/store'
import CanvasV2ProposalReviewPanel, {
  type CanvasV2ProposalReviewAcceptance,
} from './CanvasV2ProposalReviewPanel'

export interface CanvasV2TaskProposalReviewProps {
  task: CanvasTaskV2
}

/**
 * Connects the local review form to trusted lifecycle plans and durable Canvas
 * commands. This adapter never starts or continues a task run.
 */
export default function CanvasV2TaskProposalReview({
  task,
}: CanvasV2TaskProposalReviewProps) {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  if (!lifecycle) return null
  return <CanvasV2TaskProposalReviewContent task={task} lifecycle={lifecycle} />
}

function CanvasV2TaskProposalReviewContent({
  task,
  lifecycle,
}: CanvasV2TaskProposalReviewProps & { lifecycle: CanvasV2TaskRunLifecycle }) {
  useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
  const store = useCanvasV2Store()
  const canvasState = useCanvasV2State()
  const settlingRef = useRef(false)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = lifecycle.getProjectionReviewForTask(task.id)
  if (!review || review.plan.taskId !== task.id) return null

  const proposalKeys = review.plan.taskProposals.map((proposal) => proposal.key)
  const proposalReview = canvasState.envelope
    ? selectProposalReviewV2(
        canvasState.envelope.document,
        review.planId,
        proposalKeys,
      )
    : null
  const settledProposalKeys = proposalReview?.items
    .filter((item) => item.state !== 'pending')
    .map((item) => item.proposalKey) ?? []
  if (proposalKeys.length === 0 || proposalReview?.pendingCount === 0) return null

  const persistSettlement = async (
    command: CanvasCommandV2,
    receiptKind: 'proposal-acceptance' | 'plan-dismissal',
  ) => {
    if (settlingRef.current) return
    settlingRef.current = true
    setSettling(true)
    setError(null)
    try {
      // Local persistence is not settlement: wait until the daemon has acked
      // the outbox and returned the receipt in its authoritative envelope.
      await store.dispatchCommand(command)
      await store.flushCommands()
      const acknowledged = store.getSnapshot()
      const receiptAcknowledged = acknowledged.commandSync.status === 'saved'
        && acknowledged.commandSync.pendingCount === 0
        && acknowledged.envelope?.document.receipts.some((receipt) =>
          receipt.planId === review.planId && receipt.kind === receiptKind)
      if (!receiptAcknowledged) {
        throw new Error(settlementSyncError(acknowledged.commandSync))
      }
      lifecycle.clearSettledProjectionReview(review.planId)
    } catch (settlementError) {
      setError(errorMessage(settlementError))
    } finally {
      settlingRef.current = false
      setSettling(false)
    }
  }

  const accept = (acceptance: CanvasV2ProposalReviewAcceptance) => {
    void persistSettlement(
      {
        type: 'AcceptTaskProposals',
        plan: review.plan,
        proposalKeys: [...acceptance.proposalKeys],
        edits: structuredClone(acceptance.edits),
      },
      'proposal-acceptance',
    )
  }

  const reject = () => {
    void persistSettlement(
      {
        type: 'DismissPlan',
        plan: review.plan,
      },
      'plan-dismissal',
    )
  }

  return (
    <div
      data-testid={`canvas-v2-task-proposal-review-${task.id}`}
      data-no-drag
      aria-busy={settling}
      className="pointer-events-auto"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CanvasV2ProposalReviewPanel
        proposals={review.plan.taskProposals}
        settledProposalKeys={settledProposalKeys}
        onAccept={accept}
        onReject={reject}
      />
      <div
        role={error ? 'alert' : 'status'}
        aria-live={error ? 'assertive' : 'polite'}
        className={`mt-2 min-h-4 px-1 text-[10px] ${
          error ? 'text-[#B42318]' : 'text-gg-muted'
        }`}
      >
        {error ?? (settling ? '正在保存任务提案处理结果…' : '')}
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settlementSyncError(commandSync: CanvasV2StoreState['commandSync']) {
  if (commandSync.status === 'conflict') {
    return commandSync.conflict?.message ?? 'Canvas 同步发生冲突，任务提案仍待处理。'
  }
  if (commandSync.status === 'error') {
    return commandSync.error ?? 'Canvas 同步失败，任务提案仍待处理。'
  }
  return '尚未收到任务提案处理结果的 daemon 确认。'
}
