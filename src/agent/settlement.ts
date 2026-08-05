import type { RunOutcome } from './outcome'
import type { CanvasNode, InstrPhase, InstructionState } from '@/types/canvas'
import { getPlugin, type NodeContentPatch, type NodeRunResult } from '@/plugins/types'

const COMPLETION_META_PREFIXES = ['产物 ·', '执行失败 ·', '执行中断 ·']

export function withoutAgentProgress(payload: CanvasNode['payload']): Record<string, unknown> {
  const next = { ...payload }
  delete next.agentProgress
  return next
}

export function clearSuggestedActions(instruction: InstructionState): InstructionState {
  if (!instruction.suggestedActions) return instruction
  const next = { ...instruction }
  delete next.suggestedActions
  return next
}

function applyContentPatch(node: CanvasNode, patch: NodeContentPatch | null): CanvasNode {
  if (!patch) return node
  return {
    ...node,
    ...patch,
    ...(patch.payload ? { payload: { ...node.payload, ...patch.payload } } : {}),
  }
}

export function materializeNodeRun(
  node: CanvasNode,
  result: NodeRunResult,
): CanvasNode {
  const patch = getPlugin(node.type).materializeRunResult?.(node, result) ?? null
  return applyContentPatch(node, patch)
}

export interface SuccessfulRunSettlement {
  runId: string
  responseText: string
  artifactFiles: string[]
  outcome?: RunOutcome
}

/**
 * Pure successful-run reducer shared by live SSE completion and refresh recovery.
 * Transport/lifecycle ownership stays outside this function.
 */
export function applyRunOutcome(
  node: CanvasNode,
  settlement: SuccessfulRunSettlement,
): CanvasNode {
  const runResult: NodeRunResult = {
    responseText: settlement.responseText,
    artifactFiles: settlement.artifactFiles,
    ...(settlement.outcome ? { outcome: settlement.outcome } : {}),
  }
  const completionMeta = settlement.artifactFiles.length > 0
    ? settlement.artifactFiles.map((artifactPath) => `产物 · ${artifactPath}`)
    : ['✓ Agent 已完成']
  const instruction: InstructionState = {
    ...clearSuggestedActions(node.instruction),
    phase: 'done',
    open: false,
    ...(settlement.outcome ? {
      suggestedActions: {
        runId: settlement.runId,
        actions: settlement.outcome.suggestedActions,
      },
    } : {}),
  }
  const completed: CanvasNode = {
    ...node,
    payload: {
      ...withoutAgentProgress(node.payload),
      artifactFiles: settlement.artifactFiles,
    },
    meta: [
      ...(node.meta ?? []).filter((entry) =>
        !COMPLETION_META_PREFIXES.some((prefix) => entry.startsWith(prefix))
        && entry !== '✓ Agent 已完成'),
      ...completionMeta,
    ],
    instruction,
  }
  const patch = getPlugin(node.type).materializeRunResult?.(node, runResult) ?? null
  return applyContentPatch(completed, patch)
}

export interface UnsuccessfulRunSettlement {
  previousPhase: Extract<InstrPhase, 'idle' | 'done'>
  artifactFiles?: string[]
  message?: string | null
}

/** Pure failure/cancellation reducer used by live and recovered runs. */
export function settleUnsuccessfulRun(
  node: CanvasNode,
  settlement: UnsuccessfulRunSettlement,
): CanvasNode {
  const payload = withoutAgentProgress(node.payload)
  if (settlement.artifactFiles) payload.artifactFiles = settlement.artifactFiles
  return {
    ...node,
    payload,
    ...(settlement.message ? {
      meta: [
        ...(node.meta ?? []).filter((entry) =>
          !entry.startsWith('执行失败 ·') && !entry.startsWith('执行中断 ·')),
        settlement.message,
      ],
    } : {}),
    instruction: {
      ...clearSuggestedActions(node.instruction),
      phase: settlement.previousPhase,
      open: true,
    },
  }
}
