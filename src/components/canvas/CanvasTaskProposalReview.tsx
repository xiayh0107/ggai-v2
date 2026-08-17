import {
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CanvasCommand } from '@/canvas/commands'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import type { CanvasTask } from '@/canvas/model'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type { CanvasTaskRunLifecycle } from '@/canvas/runProvider'
import { selectProposalReview } from '@/canvas/selectors'
import type { CanvasStoreState } from '@/canvas/store'
import CanvasProposalReviewPanel, {
  type CanvasProposalReviewAcceptance,
} from './CanvasProposalReviewPanel'

export interface CanvasTaskProposalReviewProps {
  task: CanvasTask
}

/**
 * Connects the local review form to trusted lifecycle plans and durable Canvas
 * commands. This adapter never starts or continues a task run.
 */
export default function CanvasTaskProposalReview({
  task,
}: CanvasTaskProposalReviewProps) {
  const lifecycle = useContext(CanvasTaskRunContext)
  if (!lifecycle) return null
  return <CanvasTaskProposalReviewContent task={task} lifecycle={lifecycle} />
}

function CanvasTaskProposalReviewContent({
  task,
  lifecycle,
}: CanvasTaskProposalReviewProps & { lifecycle: CanvasTaskRunLifecycle }) {
  useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
  const store = useCanvasStore()
  const canvasState = useCanvasState()
  const settlingRef = useRef(false)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = lifecycle.getProjectionReviewForTask(task.id)
  if (!review || review.plan.taskId !== task.id) return null

  const proposalKeys = review.plan.taskProposals.map((proposal) => proposal.key)
  const graphPlan = review.plan.graphPlan
  const proposalReview = canvasState.envelope
    ? selectProposalReview(
        canvasState.envelope.document,
        review.planId,
        proposalKeys,
      )
    : null
  const settledProposalKeys = proposalReview?.items
    .filter((item) => item.state !== 'pending')
    .map((item) => item.proposalKey) ?? []
  const graphSettled = graphPlan
    ? canvasState.envelope?.document.receipts.some((receipt) =>
        receipt.planId === graphPlan.planId
        && (receipt.kind === 'graph-materialization' || receipt.kind === 'plan-dismissal')) ?? false
    : true
  const proposalsSettled = proposalKeys.length === 0 || proposalReview?.pendingCount === 0
  if (graphSettled && proposalsSettled) return null

  const persistSettlement = async (
    command: CanvasCommand,
    receiptKind: 'proposal-acceptance' | 'plan-dismissal' | 'graph-materialization',
    clearReview = true,
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
      if (clearReview) lifecycle.clearSettledProjectionReview(review.planId)
    } catch (settlementError) {
      setError(errorMessage(settlementError))
    } finally {
      settlingRef.current = false
      setSettling(false)
    }
  }

  const accept = (acceptance: CanvasProposalReviewAcceptance) => {
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

  const acceptGraph = () => {
    if (!graphPlan) return
    void persistSettlement(
      { type: 'MaterializeGraphPlan', plan: graphPlan },
      'graph-materialization',
      proposalKeys.length === 0,
    )
  }

  return (
    <div
      data-testid={`canvas-task-proposal-review-${task.id}`}
      data-no-drag
      aria-busy={settling}
      className="pointer-events-auto"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {graphPlan && !graphSettled && (
        <section className="rounded-[12px] border border-gg-line bg-gg-node p-3" aria-label="Agent 构图预览">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium text-gg-ink">Agent 构图预览</p>
              <p className="mt-0.5 text-[9.5px] text-gg-muted">
                {graphPlan.nodes.length} 个节点 · {graphPlan.edges.length} 条数据边 · 接受后仍不会自动执行
              </p>
            </div>
            <div className="flex gap-1.5">
              <button type="button" disabled={settling} onClick={reject} className="rounded-[7px] border border-gg-line px-2 py-1 text-[9.5px] text-gg-muted disabled:opacity-50">拒绝整图</button>
              <button type="button" disabled={settling} onClick={acceptGraph} className="rounded-[7px] bg-gg-primary px-2 py-1 text-[9.5px] text-white disabled:opacity-50">接受整图</button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {graphPlan.nodes.slice(0, 12).map((entry) => (
              <div key={entry.logicalKey} className="rounded-[7px] bg-gg-subtle px-2 py-1.5 text-[9.5px] text-gg-ink">
                <span className="font-medium">{entry.node.title}</span>
                <span className="ml-1 text-gg-muted">{entry.node.typeRef.id}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {!proposalsSettled && (
        <CanvasProposalReviewPanel
          proposals={review.plan.taskProposals}
          settledProposalKeys={settledProposalKeys}
          onAccept={accept}
          onReject={reject}
        />
      )}
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

function settlementSyncError(commandSync: CanvasStoreState['commandSync']) {
  if (commandSync.status === 'conflict') {
    return commandSync.conflict?.message ?? 'Canvas 同步发生冲突，任务提案仍待处理。'
  }
  if (commandSync.status === 'error') {
    return commandSync.error ?? 'Canvas 同步失败，任务提案仍待处理。'
  }
  return '尚未收到任务提案处理结果的 daemon 确认。'
}
