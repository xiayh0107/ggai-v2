import { COLLECTION_CHROME_LAYOUT } from '@/canvas/layout'
import {
  entityKey,
  type CanvasCollection,
  type CanvasEdgeRelation,
  type CanvasEdge,
} from '@/canvas/model'
import {
  taskChromeFrame,
  type CanvasBounds,
  type CanvasTaskView,
} from '@/canvas/selectors'
import type { CanvasEdgeEndpoint } from './CanvasEdgeLayer'
import type { CanvasConnectionPortSide } from './CanvasConnectionPort'

export function relationLabel(relation: CanvasEdgeRelation): string {
  const labels: Record<CanvasEdgeRelation, string> = {
    source: '来源',
    produced: '产出',
    derived: '派生',
    modified: '修改',
    references: '引用',
    compares: '比较',
    replaces: '替代',
    'depends-on': '依赖',
    data: '数据',
  }
  return labels[relation]
}

export function collapsedCollectionBounds(
  collection: CanvasCollection,
): CanvasBounds {
  return {
    x: collection.anchor.x,
    y: collection.anchor.y,
    w: COLLECTION_CHROME_LAYOUT.collapsedWidth,
    h: COLLECTION_CHROME_LAYOUT.collapsedHeight,
  }
}

export function taskInteractionBounds(view: Pick<
  CanvasTaskView,
  'task' | 'nodes' | 'ghosts' | 'containerKind' | 'presentation'
>): CanvasBounds {
  if (view.containerKind === 'task-card' || view.presentation === 'collapsed') {
    return taskChromeFrame(view.task, view.nodes, view.ghosts, view.presentation)
  }
  // 运行刚启动、Agent 尚未声明 output 类型时只有临时 ghost，且 Task chrome
  // 按规范完全隐藏。外部连线必须落在可见生成面边界，不能指向上方不存在的标题条。
  if (view.nodes.length === 0 && view.ghosts.length === 1) {
    return view.ghosts[0]!.frame
  }
  // Node-centric: the interactive Task region is the title strip attached
  // above its primary output Node, not a giant frame around every output.
  return taskChromeFrame(view.task, view.nodes, view.ghosts)
}

export function visualEntityKey(ref: CanvasEdgeEndpoint): string {
  return `${ref.kind}:${ref.id}`
}

export function edgeSemanticKey(edge: Pick<
  CanvasEdge,
  'from' | 'to' | 'relation' | 'contextRole'
>): string {
  return JSON.stringify([
    entityKey(edge.from),
    entityKey(edge.to),
    edge.relation,
    edge.contextRole,
  ])
}

export function translatedBounds(
  bounds: CanvasBounds,
  offset: { dx: number; dy: number },
): CanvasBounds {
  return {
    ...bounds,
    x: bounds.x + offset.dx,
    y: bounds.y + offset.dy,
  }
}

export function edgeCurvePath(fromBounds: CanvasBounds, toBounds: CanvasBounds) {
  const { from, to, axis } = edgeBoundaryPoints(fromBounds, toBounds)
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

/** Keeps a draft wire attached to the spatial port where the pointer left. */
export function edgeDraftCurvePath(
  fromBounds: CanvasBounds,
  toBounds: CanvasBounds,
  fromSide?: CanvasConnectionPortSide,
) {
  if (!fromSide) return edgeCurvePath(fromBounds, toBounds)
  const from = edgePointForSide(fromBounds, fromSide)
  const to = { x: toBounds.x + toBounds.w / 2, y: toBounds.y + toBounds.h / 2 }
  const axis = fromSide === 'left' || fromSide === 'right'
    ? 'horizontal' as const
    : 'vertical' as const
  const sourceDirection = fromSide === 'right' || fromSide === 'bottom' ? 1 : -1
  const targetDirection = axis === 'horizontal'
    ? Math.sign(to.x - from.x) || sourceDirection
    : Math.sign(to.y - from.y) || sourceDirection
  const distance = axis === 'horizontal'
    ? Math.abs(to.x - from.x)
    : Math.abs(to.y - from.y)
  const curve = Math.max(48, distance * 0.35)
  const path = axis === 'horizontal'
    ? `M ${from.x} ${from.y} C ${from.x + curve * sourceDirection} ${from.y}, ${to.x - curve * targetDirection} ${to.y}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${from.y + curve * sourceDirection}, ${to.x} ${to.y - curve * targetDirection}, ${to.x} ${to.y}`
  const reversed = axis === 'horizontal' ? to.x < from.x : to.y < from.y
  return { from, to, axis, path, reversed }
}

function edgePointForSide(bounds: CanvasBounds, side: CanvasConnectionPortSide) {
  switch (side) {
    case 'top': return { x: bounds.x + bounds.w / 2, y: bounds.y }
    case 'right': return { x: bounds.x + bounds.w, y: bounds.y + bounds.h / 2 }
    case 'bottom': return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h }
    case 'left': return { x: bounds.x, y: bounds.y + bounds.h / 2 }
  }
}

function edgeBoundaryPoints(from: CanvasBounds, to: CanvasBounds) {
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
