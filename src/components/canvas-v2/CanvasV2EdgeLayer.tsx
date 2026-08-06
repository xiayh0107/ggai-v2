import {
  type CanvasCollectionV2,
  type CanvasDocumentV2,
  type CanvasEdgeContextRoleV2,
  type CanvasEdgeRelationV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
} from '@/canvas-v2/model'
import type { CanvasBoundsV2, CanvasTaskViewV2 } from '@/canvas-v2/selectors'
import {
  collapsedCollectionBoundsV2,
  contextRoleLabelV2,
  edgeCurvePathV2,
  relationLabelV2,
  taskInteractionBoundsV2,
  translatedBoundsV2,
  visualEntityKeyV2,
} from './CanvasV2EdgeLayer.utils'

export type CanvasV2EdgeEndpoint = CanvasEntityRef | { kind: 'collection'; id: string }

export type CanvasV2EdgePreview =
  | { kind: 'task' | 'node' | 'collection'; id: string; dx: number; dy: number }
  | { kind: 'resize'; id: string; frame: CanvasNodeV2['frame'] }
  | null

export interface CanvasV2EdgeCollectionView {
  collection: CanvasCollectionV2
  bounds: CanvasBoundsV2
  collapsed: boolean
}

export default function CanvasV2EdgeLayer({
  document,
  taskViewsById,
  collectionViewsById,
  collapsedCollectionIds,
  hoveredVisualKey,
  preview,
  nodeFrames,
  onDeleteEdges,
}: {
  document: CanvasDocumentV2
  taskViewsById: ReadonlyMap<string, CanvasTaskViewV2>
  collectionViewsById: ReadonlyMap<string, CanvasV2EdgeCollectionView>
  collapsedCollectionIds: ReadonlySet<string>
  hoveredVisualKey: string | null
  preview: CanvasV2EdgePreview
  nodeFrames: ReadonlyMap<string, CanvasBoundsV2>
  onDeleteEdges: (edgeIds: string[]) => void
}) {
  const taskById = new Map(document.tasks.map((task) => [task.id, task]))
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const visualRef = (ref: CanvasEntityRef): CanvasV2EdgeEndpoint => {
    const node = ref.kind === 'node' ? nodeById.get(ref.id) : undefined
    const homeTaskId = node?.homeTaskId
    const collectionId = ref.kind === 'task'
      ? taskById.get(ref.id)?.collectionId
      : node?.collectionId ?? (homeTaskId ? taskById.get(homeTaskId)?.collectionId : undefined)
    if (collectionId
      && collapsedCollectionIds.has(collectionId)
      && hoveredVisualKey !== `collection:${collectionId}`) {
      return { kind: 'collection', id: collectionId }
    }
    if (homeTaskId) {
      const taskView = taskViewsById.get(homeTaskId)
      if (taskView?.presentation === 'collapsed'
        && hoveredVisualKey !== `task:${homeTaskId}`) {
        return { kind: 'task', id: homeTaskId }
      }
    }
    return ref
  }
  const bundles = new Map<string, {
    from: CanvasV2EdgeEndpoint
    to: CanvasV2EdgeEndpoint
    relation: CanvasEdgeRelationV2
    contextRole: CanvasEdgeContextRoleV2
    edgeIds: string[]
    agentAuthored: boolean
  }>()
  for (const edge of document.edges) {
    const from = visualRef(edge.from)
    const to = visualRef(edge.to)
    if (visualEntityKeyV2(from) === visualEntityKeyV2(to)) continue
    const key = JSON.stringify([
      visualEntityKeyV2(from),
      visualEntityKeyV2(to),
      edge.relation,
      edge.contextRole,
    ])
    const current = bundles.get(key)
    if (current) {
      current.edgeIds.push(edge.id)
      current.agentAuthored = current.agentAuthored && edge.origin.kind === 'agent'
    } else {
      bundles.set(key, {
        from,
        to,
        relation: edge.relation,
        contextRole: edge.contextRole,
        edgeIds: [edge.id],
        agentAuthored: edge.origin.kind === 'agent',
      })
    }
  }

  const offsetFor = (ref: CanvasV2EdgeEndpoint) => {
    if (!preview || preview.kind === 'resize') return { dx: 0, dy: 0 }
    if (preview.kind === ref.kind && preview.id === ref.id) return preview
    if (preview.kind !== 'collection' || ref.kind === 'collection') return { dx: 0, dy: 0 }
    const node = ref.kind === 'node' ? nodeById.get(ref.id) : undefined
    const homeTaskId = node?.homeTaskId
    const collectionId = ref.kind === 'task'
      ? taskById.get(ref.id)?.collectionId
      : node?.collectionId ?? (homeTaskId ? taskById.get(homeTaskId)?.collectionId : undefined)
    return collectionId === preview.id ? preview : { dx: 0, dy: 0 }
  }
  const rectFor = (ref: CanvasV2EdgeEndpoint): CanvasBoundsV2 | null => {
    const offset = offsetFor(ref)
    if (ref.kind === 'collection') {
      const view = collectionViewsById.get(ref.id)
      if (!view) return null
      const bounds = view.collapsed ? collapsedCollectionBoundsV2(view.collection) : view.bounds
      return translatedBoundsV2(bounds, offset)
    }
    if (ref.kind === 'task') {
      const view = taskViewsById.get(ref.id)
      if (!view) return null
      return translatedBoundsV2(taskInteractionBoundsV2(view), offset)
    }
    const node = nodeById.get(ref.id)
    if (!node) return null
    const frame = nodeFrames.get(node.id) ?? node.frame
    const taskOffset = preview?.kind === 'task' && preview.id === node.homeTaskId
      ? preview
      : { dx: 0, dy: 0 }
    return translatedBoundsV2(frame, taskOffset)
  }

  return (
    <svg
      aria-label="类型化语义连接"
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width="1"
      height="1"
    >
      {[...bundles.values()].map((bundle, index) => {
        const fromRect = rectFor(bundle.from)
        const toRect = rectFor(bundle.to)
        if (!fromRect || !toRect) return null
        const { from, to, path } = edgeCurvePathV2(fromRect, toRect)
        if (Math.hypot(from.x - to.x, from.y - to.y) < 2) return null
        const pathId = `canvas-v2-edge-${index}`
        const label = `${relationLabelV2(bundle.relation)}，上下文${contextRoleLabelV2(bundle.contextRole)}${
          bundle.edgeIds.length > 1 ? `，聚合 ${bundle.edgeIds.length} 条连接` : ''
        }`
        return (
          <g
            key={`${pathId}:${bundle.edgeIds.join(':')}`}
            role="button"
            tabIndex={0}
            aria-label={`${label}。按 Delete 删除用户连接`}
            data-edge-bundle-count={bundle.edgeIds.length}
            className="pointer-events-auto outline-none"
            onKeyDown={(event) => {
              if (event.key !== 'Delete' && event.key !== 'Backspace') return
              event.preventDefault()
              onDeleteEdges(bundle.edgeIds)
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
              stroke={bundle.agentAuthored ? '#A7B8CE' : '#7DA7E8'}
              strokeWidth={bundle.edgeIds.length > 1 ? 2.4 : 1.4}
              strokeDasharray={bundle.contextRole === 'none' ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            <text className="fill-[#526176] text-[9px]" dy="-5">
              <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                {relationLabelV2(bundle.relation)} · {contextRoleLabelV2(bundle.contextRole)}
                {bundle.edgeIds.length > 1 ? ` ×${bundle.edgeIds.length}` : ''}
              </textPath>
            </text>
          </g>
        )
      })}
    </svg>
  )
}
