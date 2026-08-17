import {
  canvasNodeWorldFrame,
  type CanvasCollection,
  type CanvasDocument,
  type CanvasEdgeContextRole,
  type CanvasEdgeRelation,
  type CanvasEntityRef,
  type CanvasWorldRect,
} from '@/canvas/model'
import type { CanvasBounds, CanvasTaskView } from '@/canvas/selectors'
import {
  collapsedCollectionBounds,
  edgeCurvePath,
  relationLabel,
  taskInteractionBounds,
  translatedBounds,
  visualEntityKey,
} from './CanvasEdgeLayer.utils'

export type CanvasEdgeEndpoint = CanvasEntityRef | { kind: 'collection'; id: string }

const EDGE_LABEL_MIN_LENGTH = 140

export type CanvasEdgePreview =
  | { kind: 'task' | 'node' | 'collection'; id: string; dx: number; dy: number }
  | {
      kind: 'selection'
      entities: CanvasEntityRef[]
      collectionIds: string[]
      dx: number
      dy: number
    }
  | { kind: 'resize'; id: string; frame: CanvasWorldRect }
  | null

export interface CanvasEdgeCollectionView {
  collection: CanvasCollection
  bounds: CanvasBounds
  collapsed: boolean
}

export default function CanvasEdgeLayer({
  document,
  taskViewsById,
  collectionViewsById,
  collapsedCollectionIds,
  taskIdsWithoutTopChrome,
  preview,
  nodeFrames,
  onDeleteEdges,
}: {
  document: CanvasDocument
  taskViewsById: ReadonlyMap<string, CanvasTaskView>
  collectionViewsById: ReadonlyMap<string, CanvasEdgeCollectionView>
  collapsedCollectionIds: ReadonlySet<string>
  /** 没有可见顶部 chrome 的任务：边改落到其首个可见输出 Node。 */
  taskIdsWithoutTopChrome?: ReadonlySet<string>
  preview: CanvasEdgePreview
  nodeFrames: ReadonlyMap<string, CanvasBounds>
  onDeleteEdges: (edgeIds: string[]) => void
}) {
  const taskById = new Map(document.tasks.map((task) => [task.id, task]))
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const isHiddenTaskChromePair = (a: CanvasEntityRef, b: CanvasEntityRef): boolean => {
    if (!taskIdsWithoutTopChrome || taskIdsWithoutTopChrome.size === 0) return false
    const taskRef = a.kind === 'task' ? a : b.kind === 'task' ? b : null
    const nodeRef = a.kind === 'node' ? a : b.kind === 'node' ? b : null
    if (!taskRef || !nodeRef || !taskIdsWithoutTopChrome.has(taskRef.id)) return false
    return nodeById.get(nodeRef.id)?.homeTaskId === taskRef.id
  }
  const visualRef = (ref: CanvasEntityRef): CanvasEdgeEndpoint => {
    // A single-output Task has no visible title strip. Edges targeting that
    // Task must terminate on its visible output Node; otherwise the geometry
    // points at the hidden strip above the Node and the wire appears to float
    // or loop back through the card.
    if (ref.kind === 'task' && taskIdsWithoutTopChrome?.has(ref.id)) {
      const primaryNode = taskViewsById.get(ref.id)?.nodes[0]
      if (primaryNode) return { kind: 'node', id: primaryNode.id }
    }
    const node = ref.kind === 'node' ? nodeById.get(ref.id) : undefined
    const homeTaskId = node?.homeTaskId
    const collectionId = ref.kind === 'task'
      ? taskById.get(ref.id)?.collectionId
      : node?.collectionId ?? (homeTaskId ? taskById.get(homeTaskId)?.collectionId : undefined)
    // Hidden members keep their edges aggregated to the collapsed container
    // boundary; never draw floating edges toward invisible Nodes.
    if (collectionId && collapsedCollectionIds.has(collectionId)) {
      return { kind: 'collection', id: collectionId }
    }
    if (homeTaskId) {
      const taskView = taskViewsById.get(homeTaskId)
      if (taskView?.presentation === 'collapsed') {
        return { kind: 'task', id: homeTaskId }
      }
    }
    return ref
  }
  const bundles = new Map<string, {
    from: CanvasEdgeEndpoint
    to: CanvasEdgeEndpoint
    relation: CanvasEdgeRelation
    contextRole: CanvasEdgeContextRole
    edgeIds: string[]
    userEdgeIds: string[]
  }>()
  for (const edge of document.edges) {
    if (isHiddenTaskChromePair(edge.from, edge.to)) continue
    const from = visualRef(edge.from)
    const to = visualRef(edge.to)
    if (visualEntityKey(from) === visualEntityKey(to)) continue
    const key = JSON.stringify([
      visualEntityKey(from),
      visualEntityKey(to),
      edge.relation,
      edge.contextRole,
    ])
    const current = bundles.get(key)
    if (current) {
      current.edgeIds.push(edge.id)
      if (edge.origin.kind === 'user') current.userEdgeIds.push(edge.id)
    } else {
      bundles.set(key, {
        from,
        to,
        relation: edge.relation,
        contextRole: edge.contextRole,
        edgeIds: [edge.id],
        userEdgeIds: edge.origin.kind === 'user' ? [edge.id] : [],
      })
    }
  }

  const offsetFor = (ref: CanvasEdgeEndpoint) => {
    if (!preview || preview.kind === 'resize') return { dx: 0, dy: 0 }
    if (preview.kind === 'selection') {
      if (ref.kind === 'collection') {
        return preview.collectionIds.includes(ref.id) ? preview : { dx: 0, dy: 0 }
      }
      const directlySelected = preview.entities.some((entity) =>
        entity.kind === ref.kind && entity.id === ref.id)
      const node = ref.kind === 'node' ? nodeById.get(ref.id) : undefined
      const homeTaskId = node?.homeTaskId
      const taskSelected = Boolean(homeTaskId && preview.entities.some((entity) =>
        entity.kind === 'task' && entity.id === homeTaskId))
      const collectionId = ref.kind === 'task'
        ? taskById.get(ref.id)?.collectionId
        : node?.collectionId ?? (homeTaskId ? taskById.get(homeTaskId)?.collectionId : undefined)
      return directlySelected || taskSelected
        || Boolean(collectionId && preview.collectionIds.includes(collectionId))
        ? preview
        : { dx: 0, dy: 0 }
    }
    if (preview.kind === ref.kind && preview.id === ref.id) return preview
    if (preview.kind === 'task' && ref.kind === 'node') {
      const node = nodeById.get(ref.id)
      if (node?.homeTaskId === preview.id) return preview
    }
    if (preview.kind !== 'collection' || ref.kind === 'collection') return { dx: 0, dy: 0 }
    const node = ref.kind === 'node' ? nodeById.get(ref.id) : undefined
    const homeTaskId = node?.homeTaskId
    const collectionId = ref.kind === 'task'
      ? taskById.get(ref.id)?.collectionId
      : node?.collectionId ?? (homeTaskId ? taskById.get(homeTaskId)?.collectionId : undefined)
    return collectionId === preview.id ? preview : { dx: 0, dy: 0 }
  }
  const rectFor = (ref: CanvasEdgeEndpoint): CanvasBounds | null => {
    const offset = offsetFor(ref)
    if (ref.kind === 'collection') {
      const view = collectionViewsById.get(ref.id)
      if (!view) return null
      const bounds = view.collapsed ? collapsedCollectionBounds(view.collection) : view.bounds
      return translatedBounds(bounds, offset)
    }
    if (ref.kind === 'task') {
      const view = taskViewsById.get(ref.id)
      if (!view) return null
      return translatedBounds(taskInteractionBounds(view), offset)
    }
    const node = nodeById.get(ref.id)
    if (!node) return null
    const frame = nodeFrames.get(node.id) ?? canvasNodeWorldFrame(document, node)
    return translatedBounds(frame, nodeFrames.has(node.id) ? { dx: 0, dy: 0 } : offset)
  }

  return (
    <svg
      aria-label="画布连接"
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width="1"
      height="1"
    >
      {[...bundles.values()].map((bundle, index) => {
        const fromRect = rectFor(bundle.from)
        const toRect = rectFor(bundle.to)
        if (!fromRect || !toRect) return null
        const { from, to, path, reversed } = edgeCurvePath(fromRect, toRect)
        const length = Math.hypot(from.x - to.x, from.y - to.y)
        if (length < 2) return null
        const pathId = `canvas-edge-${index}`
        const label = `${relationLabel(bundle.relation)}连接${
          bundle.edgeIds.length > 1 ? `，聚合 ${bundle.edgeIds.length} 条连接` : ''
        }`
        const labelTransform = reversed
          ? `rotate(180 ${(from.x + to.x) / 2} ${(from.y + to.y) / 2})`
          : undefined
        // Short edges (e.g. a Task strip to its own output) keep their
        // semantics in the tooltip and aria-label instead of cramped text.
        const showLabel = length >= EDGE_LABEL_MIN_LENGTH
        const deletable = bundle.userEdgeIds.length > 0
        return (
          <g
            key={`${pathId}:${bundle.edgeIds.join(':')}`}
            role="group"
            tabIndex={0}
            aria-label={deletable
              ? `${label}。按 Delete 删除用户连接`
              : `${label}。Agent 创建的连接，只读`}
            data-edge-bundle-count={bundle.edgeIds.length}
            className="pointer-events-auto outline-none focus-visible:drop-shadow-[0_0_2px_#1769E0]"
            onKeyDown={(event) => {
              if (!deletable || (event.key !== 'Delete' && event.key !== 'Backspace')) return
              event.preventDefault()
              onDeleteEdges(bundle.userEdgeIds)
            }}
          >
            <title>{label}</title>
            <path
              id={pathId}
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth="14"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={path}
              fill="none"
              stroke={deletable ? '#7DA7E8' : '#A7B8CE'}
              strokeWidth={bundle.edgeIds.length > 1 ? 2.4 : 1.4}
              strokeDasharray={bundle.contextRole === 'none' ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {showLabel && (
              <text
                className="fill-[#526176] text-[9px]"
                dy="-5"
                transform={labelTransform}
              >
                <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                  {relationLabel(bundle.relation)}
                  {bundle.edgeIds.length > 1 ? ` ×${bundle.edgeIds.length}` : ''}
                </textPath>
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
