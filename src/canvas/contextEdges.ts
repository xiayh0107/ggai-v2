import {
  entityKey,
  type CanvasEdgeContextRole,
  type CanvasEdge,
  type CanvasEntityRef,
} from './model.js'

export type ContextBearingEdge = CanvasEdge & {
  contextRole: Exclude<CanvasEdgeContextRole, 'none'>
}

export interface PromotedTaskInput {
  from: CanvasEntityRef
  contextRole: Exclude<CanvasEdgeContextRole, 'none'>
}

/** `none` edges remain durable visual lineage but never authorize Agent context. */
export function isContextBearingEdge(
  edge: CanvasEdge,
): edge is ContextBearingEdge {
  return edge.contextRole === 'full' || edge.contextRole === 'summary'
}

/** Canonical selector shared by Task compilation and UI/source transitions. */
export function selectIncomingContextEdges(
  edges: readonly CanvasEdge[],
  target: CanvasEntityRef,
): ContextBearingEdge[] {
  const targetKey = entityKey(target)
  return edges.filter((edge): edge is ContextBearingEdge =>
    isContextBearingEdge(edge) && entityKey(edge.to) === targetKey)
}

export function selectDirectTaskInputEdges(
  edges: readonly CanvasEdge[],
  taskId: string,
): ContextBearingEdge[] {
  return selectIncomingContextEdges(edges, { kind: 'task', id: taskId })
}

/**
 * Resolve the content-bearing inputs that an empty Node contributes when it is
 * atomically promoted to a Task output slot. Multiple edges from the same
 * source collapse to one Task input; `full` wins over `summary`.
 */
export function promotedTaskInputsForOutputSlot(
  edges: readonly CanvasEdge[],
  nodeId: string,
): PromotedTaskInput[] {
  const promoted = new Map<string, PromotedTaskInput>()
  for (const edge of selectIncomingContextEdges(edges, { kind: 'node', id: nodeId })) {
    const key = entityKey(edge.from)
    const existing = promoted.get(key)
    if (!existing) {
      promoted.set(key, {
        from: structuredClone(edge.from),
        contextRole: edge.contextRole,
      })
      continue
    }
    if (edge.contextRole === 'full') existing.contextRole = 'full'
  }
  return [...promoted.values()]
}
