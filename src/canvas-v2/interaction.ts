import type { CanvasDocumentV2, CanvasPointV2 } from './model'
import type {
  CanvasV2CameraState,
  CanvasV2SelectionTarget,
} from './persistence'
import type { CanvasBoundsV2 } from './selectors'

export interface CanvasV2ViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export interface CanvasV2ScreenPoint {
  clientX: number
  clientY: number
}

export interface CanvasV2SelectableBounds {
  target: CanvasV2SelectionTarget
  bounds: CanvasBoundsV2
}

export function screenToWorldV2(
  point: CanvasV2ScreenPoint,
  camera: CanvasV2CameraState,
  viewport: CanvasV2ViewportRect,
): CanvasPointV2 {
  return {
    x: (point.clientX - viewport.left - camera.x) / camera.zoom,
    y: (point.clientY - viewport.top - camera.y) / camera.zoom,
  }
}

export function zoomCameraAtV2(
  camera: CanvasV2CameraState,
  viewport: CanvasV2ViewportRect,
  point: CanvasV2ScreenPoint,
  requestedZoom: number,
): CanvasV2CameraState {
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

export function normalizedBoundsV2(a: CanvasPointV2, b: CanvasPointV2): CanvasBoundsV2 {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function intersectsBoundsV2(a: CanvasBoundsV2, b: CanvasBoundsV2): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
}

export function selectionFromMarqueeV2(
  selectable: readonly CanvasV2SelectableBounds[],
  marquee: CanvasBoundsV2,
): CanvasV2SelectionTarget[] {
  return selectable
    .filter((entry) => intersectsBoundsV2(entry.bounds, marquee))
    .map((entry) => ({ ...entry.target }))
}

export function updateSelectionV2(
  current: readonly CanvasV2SelectionTarget[],
  target: CanvasV2SelectionTarget,
  additive: boolean,
): CanvasV2SelectionTarget[] {
  if (!additive) return [{ ...target }]
  const key = selectionKeyV2(target)
  if (current.some((entry) => selectionKeyV2(entry) === key)) {
    return current.filter((entry) => selectionKeyV2(entry) !== key).map((entry) => ({ ...entry }))
  }
  return [...current.map((entry) => ({ ...entry })), { ...target }]
}

export function mergeSelectionV2(
  current: readonly CanvasV2SelectionTarget[],
  incoming: readonly CanvasV2SelectionTarget[],
): CanvasV2SelectionTarget[] {
  const merged = current.map((entry) => ({ ...entry }))
  const keys = new Set(merged.map(selectionKeyV2))
  for (const target of incoming) {
    const key = selectionKeyV2(target)
    if (keys.has(key)) continue
    keys.add(key)
    merged.push({ ...target })
  }
  return merged
}

export interface CanvasV2SelectionHierarchyState {
  collapsedTaskIds?: readonly string[]
  collapsedCollectionIds?: readonly string[]
}

/**
 * Reduces a transient selection to the visible top-level entities that can act
 * as a single canvas surface. Containers are the canonical source of selection
 * whenever one of their descendants is selected alongside them.
 */
export function canonicalizeCanvasV2Selection(
  document: CanvasDocumentV2,
  selection: readonly CanvasV2SelectionTarget[],
  hierarchy: CanvasV2SelectionHierarchyState = {},
): CanvasV2SelectionTarget[] {
  const tasksById = new Map(document.tasks.map((task) => [task.id, task]))
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const collectionIds = new Set(document.collections.map((collection) => collection.id))
  const collapsedTaskIds = new Set(hierarchy.collapsedTaskIds ?? [])
  const collapsedCollectionIds = new Set(hierarchy.collapsedCollectionIds ?? [])

  const uniqueSelection: CanvasV2SelectionTarget[] = []
  const selectedKeys = new Set<string>()
  for (const target of selection) {
    const key = selectionKeyV2(target)
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

  function selectionTargetExists(target: CanvasV2SelectionTarget): boolean {
    if (target.kind === 'node') return nodesById.has(target.id)
    if (target.kind === 'task') return tasksById.has(target.id)
    return collectionIds.has(target.id)
  }
}

export function nextRovingKeyV2(
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

export function selectionKeyV2(target: CanvasV2SelectionTarget): string {
  return `${target.kind}:${target.id}`
}
