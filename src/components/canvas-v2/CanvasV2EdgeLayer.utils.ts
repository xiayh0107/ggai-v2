import { COLLECTION_CHROME_LAYOUT_V2 } from '@/canvas-v2/layout'
import {
  entityKeyV2,
  type CanvasCollectionV2,
  type CanvasEdgeRelationV2,
  type CanvasEdgeV2,
} from '@/canvas-v2/model'
import {
  taskChromeFrameV2,
  type CanvasBoundsV2,
  type CanvasTaskViewV2,
} from '@/canvas-v2/selectors'
import type { CanvasV2EdgeEndpoint } from './CanvasV2EdgeLayer'

export function relationLabelV2(relation: CanvasEdgeRelationV2): string {
  const labels: Record<CanvasEdgeRelationV2, string> = {
    source: '来源',
    produced: '产出',
    derived: '派生',
    modified: '修改',
    references: '引用',
    compares: '比较',
    replaces: '替代',
    'depends-on': '依赖',
  }
  return labels[relation]
}

export function collapsedCollectionBoundsV2(
  collection: CanvasCollectionV2,
): CanvasBoundsV2 {
  return {
    x: collection.anchor.x,
    y: collection.anchor.y,
    w: COLLECTION_CHROME_LAYOUT_V2.collapsedWidth,
    h: COLLECTION_CHROME_LAYOUT_V2.collapsedHeight,
  }
}

export function taskInteractionBoundsV2(view: CanvasTaskViewV2): CanvasBoundsV2 {
  if (view.containerKind === 'task-card' || view.presentation === 'collapsed') {
    return taskChromeFrameV2(view.task, view.nodes, view.ghosts, view.presentation)
  }
  // Node-centric: the interactive Task region is the title strip attached
  // above its primary output Node, not a giant frame around every output.
  return taskChromeFrameV2(view.task, view.nodes, view.ghosts)
}

export function visualEntityKeyV2(ref: CanvasV2EdgeEndpoint): string {
  return `${ref.kind}:${ref.id}`
}

export function edgeSemanticKeyV2(edge: Pick<
  CanvasEdgeV2,
  'from' | 'to' | 'relation' | 'contextRole'
>): string {
  return JSON.stringify([
    entityKeyV2(edge.from),
    entityKeyV2(edge.to),
    edge.relation,
    edge.contextRole,
  ])
}

export function translatedBoundsV2(
  bounds: CanvasBoundsV2,
  offset: { dx: number; dy: number },
): CanvasBoundsV2 {
  return {
    ...bounds,
    x: bounds.x + offset.dx,
    y: bounds.y + offset.dy,
  }
}

export function edgeCurvePathV2(fromBounds: CanvasBoundsV2, toBounds: CanvasBoundsV2) {
  const { from, to, axis } = edgeBoundaryPointsV2(fromBounds, toBounds)
  const distance = axis === 'horizontal'
    ? Math.abs(to.x - from.x)
    : Math.abs(to.y - from.y)
  const curve = Math.max(48, distance * 0.35)
  const direction = axis === 'horizontal'
    ? Math.sign(to.x - from.x) || 1
    : Math.sign(to.y - from.y) || 1
  const path = axis === 'horizontal'
    ? `M ${from.x} ${from.y} C ${from.x + curve * direction} ${from.y}, ${to.x - curve * direction} ${to.y}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${from.y + curve * direction}, ${to.x} ${to.y - curve * direction}, ${to.x} ${to.y}`
  const reversed = axis === 'horizontal' ? to.x < from.x : to.y < from.y
  return { from, to, axis, path, reversed }
}

function edgeBoundaryPointsV2(from: CanvasBoundsV2, to: CanvasBoundsV2) {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y)
  if (horizontal) {
    return toCenter.x >= fromCenter.x ? {
      from: { x: from.x + from.w, y: fromCenter.y },
      to: { x: to.x, y: toCenter.y },
      axis: 'horizontal' as const,
    } : {
      from: { x: from.x, y: fromCenter.y },
      to: { x: to.x + to.w, y: toCenter.y },
      axis: 'horizontal' as const,
    }
  }
  return toCenter.y >= fromCenter.y ? {
    from: { x: fromCenter.x, y: from.y + from.h },
    to: { x: toCenter.x, y: to.y },
    axis: 'vertical' as const,
  } : {
    from: { x: fromCenter.x, y: from.y },
    to: { x: toCenter.x, y: to.y + to.h },
    axis: 'vertical' as const,
  }
}
