import type {
  CanvasDocument,
  CanvasEdgeContextRole,
  CanvasEdgeRelation,
  CanvasEntityRef,
  CanvasPoint,
} from './model'
import type {
  CanvasCameraState,
  CanvasSelectionTarget,
} from './persistence'
import type { CanvasBounds } from './selectors'

export interface CanvasViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export interface CanvasScreenPoint {
  clientX: number
  clientY: number
}

export interface CanvasSelectableBounds {
  target: CanvasSelectionTarget
  bounds: CanvasBounds
}

export interface CanvasUserConnectionSemantics {
  relation: CanvasEdgeRelation
  contextRole: CanvasEdgeContextRole
}

/**
 * Shift-click and Shift-marquee are canvas selection gestures, so the browser
 * must not interpret them as extending a native text selection. Callers pass
 * the current Selection explicitly to keep ordinary node content selectable.
 */
export function suppressNativeTextSelectionForCanvasGesture(
  event: Pick<Event, 'preventDefault'>,
  selection: Pick<Selection, 'removeAllRanges'> | null,
): void {
  event.preventDefault()
  selection?.removeAllRanges()
}

/**
 * Turns the direct manipulation of connecting two ports into durable edge
 * semantics. Strong output lineage remains reserved for Task/Run actions.
 */
export function deriveUserConnectionSemantics(
  from: CanvasEntityRef,
  to: CanvasEntityRef,
): CanvasUserConnectionSemantics {
  if (to.kind === 'task') {
    return from.kind === 'task'
      ? { relation: 'depends-on', contextRole: 'summary' }
      : { relation: 'source', contextRole: 'full' }
  }
  return { relation: 'references', contextRole: 'none' }
}

export function screenToWorld(
  point: CanvasScreenPoint,
  camera: CanvasCameraState,
  viewport: CanvasViewportRect,
): CanvasPoint {
  return {
    x: (point.clientX - viewport.left - camera.x) / camera.zoom,
    y: (point.clientY - viewport.top - camera.y) / camera.zoom,
  }
}

export function zoomCameraAt(
  camera: CanvasCameraState,
  viewport: CanvasViewportRect,
  point: CanvasScreenPoint,
  requestedZoom: number,
): CanvasCameraState {
  const zoom = Math.min(2, Math.max(0.25, requestedZoom))
  const localX = point.clientX - viewport.left
  const localY = point.clientY - viewport.top
  const worldX = (localX - camera.x) / camera.zoom
  const worldY = (localY - camera.y) / camera.zoom
  return {
    x: localX - worldX * zoom,
    y: localY - worldY * zoom,
    zoom,
  }
}

export function normalizedBounds(a: CanvasPoint, b: CanvasPoint): CanvasBounds {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function intersectsBounds(a: CanvasBounds, b: CanvasBounds): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
}

export function selectionFromMarquee(
  selectable: readonly CanvasSelectableBounds[],
  marquee: CanvasBounds,
): CanvasSelectionTarget[] {
  return selectable
    .filter((entry) => intersectsBounds(entry.bounds, marquee))
    .map((entry) => ({ ...entry.target }))
}

export function updateSelection(
  current: readonly CanvasSelectionTarget[],
  target: CanvasSelectionTarget,
  additive: boolean,
): CanvasSelectionTarget[] {
  if (!additive) return [{ ...target }]
  const key = selectionKey(target)
  if (current.some((entry) => selectionKey(entry) === key)) {
    return current.filter((entry) => selectionKey(entry) !== key).map((entry) => ({ ...entry }))
  }
  return [...current.map((entry) => ({ ...entry })), { ...target }]
}

export function mergeSelection(
  current: readonly CanvasSelectionTarget[],
  incoming: readonly CanvasSelectionTarget[],
): CanvasSelectionTarget[] {
  const merged = current.map((entry) => ({ ...entry }))
  const keys = new Set(merged.map(selectionKey))
  for (const target of incoming) {
    const key = selectionKey(target)
    if (keys.has(key)) continue
    keys.add(key)
    merged.push({ ...target })
  }
  return merged
}

export interface CanvasSelectionHierarchyState {
  collapsedTaskIds?: readonly string[]
  collapsedCollectionIds?: readonly string[]
}

/**
 * Reduces a transient selection to the visible top-level entities that can act
 * as a single canvas surface. Containers are the canonical source of selection
 * whenever one of their descendants is selected alongside them.
 */
export function canonicalizeCanvasSelection(
  document: CanvasDocument,
  selection: readonly CanvasSelectionTarget[],
  hierarchy: CanvasSelectionHierarchyState = {},
): CanvasSelectionTarget[] {
  const tasksById = new Map(document.tasks.map((task) => [task.id, task]))
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const collectionIds = new Set(document.collections.map((collection) => collection.id))
  const collapsedTaskIds = new Set(hierarchy.collapsedTaskIds ?? [])
  const collapsedCollectionIds = new Set(hierarchy.collapsedCollectionIds ?? [])

  const uniqueSelection: CanvasSelectionTarget[] = []
  const selectedKeys = new Set<string>()
  for (const target of selection) {
    const key = selectionKey(target)
    if (selectedKeys.has(key) || !selectionTargetExists(target)) continue
    selectedKeys.add(key)
    uniqueSelection.push({ ...target })
  }

  const selectedTaskIds = new Set(uniqueSelection
    .filter((target) => target.kind === 'task')
    .map((target) => target.id))
  const selectedCollectionIds = new Set(uniqueSelection
    .filter((target) => target.kind === 'collection')
    .map((target) => target.id))

  return uniqueSelection.filter((target) => {
    if (target.kind === 'collection') return true

    if (target.kind === 'task') {
      const collectionId = tasksById.get(target.id)?.collectionId
      if (!collectionId) return true
      if (selectedCollectionIds.has(collectionId)) return false
      return !collapsedCollectionIds.has(collectionId)
    }

    const node = nodesById.get(target.id)
    if (!node) return false
    const homeTask = node.homeTaskId ? tasksById.get(node.homeTaskId) : undefined
    const collectionId = node.collectionId ?? homeTask?.collectionId
    if (collectionId) {
      if (selectedCollectionIds.has(collectionId)) return false
      if (collapsedCollectionIds.has(collectionId)) return false
    }
    if (!node.homeTaskId) return true
    if (selectedTaskIds.has(node.homeTaskId)) return false
    return !collapsedTaskIds.has(node.homeTaskId)
  })

  function selectionTargetExists(target: CanvasSelectionTarget): boolean {
    if (target.kind === 'node') return nodesById.has(target.id)
    if (target.kind === 'task') return tasksById.has(target.id)
    return collectionIds.has(target.id)
  }
}

export function nextRovingKey(
  keys: readonly string[],
  current: string | null,
  key: string,
): string | null {
  if (keys.length === 0) return null
  if (key === 'Home') return keys[0] ?? null
  if (key === 'End') return keys[keys.length - 1] ?? null
  const delta = key === 'ArrowRight' || key === 'ArrowDown'
    ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
  if (delta === 0) return current
  const index = Math.max(0, keys.indexOf(current ?? ''))
  return keys[(index + delta + keys.length) % keys.length] ?? null
}

export function selectionKey(target: CanvasSelectionTarget): string {
  return `${target.kind}:${target.id}`
}
