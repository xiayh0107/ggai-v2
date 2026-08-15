import type { CanvasDocument } from './model'

/**
 * Finds Task projections left behind by the historical DeleteNode behavior.
 *
 * A missing output by itself is not enough: a normal empty draft has no
 * materialization outcome, while a deliberately detached output still exists
 * in the document. We repair only when every receipt-backed output for a Task
 * is gone and the Task owns no other live Node.
 */
export function legacyDeletedViewTaskIds(document: CanvasDocument): string[] {
  const liveNodeIds = new Set(document.nodes.map((node) => node.id))
  const taskIdsWithOwnedNodes = new Set(document.nodes.flatMap((node) =>
    node.homeTaskId ? [node.homeTaskId] : []))
  const outcomeNodeIdsByTask = new Map<string, Set<string>>()

  for (const receipt of document.receipts) {
    if (receipt.kind !== 'materialization' || receipt.outcomes.length === 0) continue
    let outcomeNodeIds = outcomeNodeIdsByTask.get(receipt.taskId)
    if (!outcomeNodeIds) {
      outcomeNodeIds = new Set()
      outcomeNodeIdsByTask.set(receipt.taskId, outcomeNodeIds)
    }
    for (const outcome of receipt.outcomes) outcomeNodeIds.add(outcome.nodeId)
  }

  return document.tasks.flatMap((task) => {
    if (taskIdsWithOwnedNodes.has(task.id)) return []
    const outcomeNodeIds = outcomeNodeIdsByTask.get(task.id)
    if (!outcomeNodeIds) return []
    for (const nodeId of outcomeNodeIds) {
      if (liveNodeIds.has(nodeId)) return []
    }
    return [task.id]
  })
}
