import type { CanvasCommand } from '@/canvas/commands'
import { canonicalizeCanvasSelection, selectionKey } from '@/canvas/interaction'
import { COLLECTION_CHROME_LAYOUT } from '@/canvas/layout'
import {
  type CanvasDocument,
  type CanvasEntityRef,
  type CanvasWorldRect,
  type CanvasPoint,
} from '@/canvas/model'
import type { CanvasSelectionTarget } from '@/canvas/persistence'
import type { CanvasStoreState } from '@/canvas/store'
import type { CanvasBounds } from '@/canvas/selectors'
import type { CanvasConnectionPortSide } from './CanvasConnectionPort'

export function moveTargetsForSelection(
  selection: readonly CanvasSelectionTarget[],
): { entities: CanvasEntityRef[]; collectionIds: string[] } {
  return {
    entities: selection.flatMap((target): CanvasEntityRef[] => target.kind === 'collection'
      ? []
      : [{ kind: target.kind, id: target.id }]),
    collectionIds: selection.flatMap((target) => target.kind === 'collection'
      ? [target.id]
      : []),
  }
}

export function canonicalSelectionForState(
  state: CanvasStoreState,
): CanvasSelectionTarget[] {
  return canonicalizeCanvasSelection(state.document, state.view.selection, {
    collapsedTaskIds: state.view.collapsedTaskIds,
    collapsedCollectionIds: state.view.collapsedCollectionIds,
  })
}

export function selectionCoverage(
  document: CanvasDocument,
  selection: readonly CanvasSelectionTarget[],
): { taskIds: Set<string>; nodeIds: Set<string> } {
  const selectedTaskIds = new Set(selection
    .filter((target) => target.kind === 'task')
    .map((target) => target.id))
  const selectedCollectionIds = new Set(selection
    .filter((target) => target.kind === 'collection')
    .map((target) => target.id))
  const tasksById = new Map(document.tasks.map((task) => [task.id, task]))
  const taskIds = new Set(document.tasks
    .filter((task) => task.collectionId && selectedCollectionIds.has(task.collectionId))
    .map((task) => task.id))
  const nodeIds = new Set(document.nodes
    .filter((node) => {
      if (node.homeTaskId && selectedTaskIds.has(node.homeTaskId)) return true
      const collectionId = node.collectionId
        ?? (node.homeTaskId ? tasksById.get(node.homeTaskId)?.collectionId : undefined)
      return Boolean(collectionId && selectedCollectionIds.has(collectionId))
    })
    .map((node) => node.id))
  return { taskIds, nodeIds }
}

export function expandedCollectionSelectionBounds(bounds: CanvasBounds): CanvasBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    w: COLLECTION_CHROME_LAYOUT.minimumWidth,
    h: 64,
  }
}

/** 给组合节点预留普通 Node 的 header，再包住所有成员内容。 */
export function compoundSelectionNodeBounds(bounds: CanvasBounds): CanvasBounds {
  const inset = { top: 48, right: 14, bottom: 14, left: 14 }
  return {
    x: bounds.x - inset.left,
    y: bounds.y - inset.top,
    w: bounds.w + inset.left + inset.right,
    h: bounds.h + inset.top + inset.bottom,
  }
}

export function pointInsideBounds(point: CanvasPoint, bounds: CanvasBounds): boolean {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.w
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.h
}

export function sameSelection(
  left: readonly CanvasSelectionTarget[],
  right: readonly CanvasSelectionTarget[],
): boolean {
  return left.length === right.length
    && left.every((target, index) => selectionKey(target) === selectionKey(right[index]!))
}

export function padBounds(bounds: CanvasBounds, padding: number): CanvasBounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
  }
}

export function unionBounds(bounds: readonly CanvasBounds[]): CanvasBounds {
  if (bounds.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...bounds.map((entry) => entry.x))
  const y = Math.min(...bounds.map((entry) => entry.y))
  const right = Math.max(...bounds.map((entry) => entry.x + entry.w))
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.h))
  return { x, y, w: right - x, h: bottom - y }
}

export function clientCanvasId(kind: 'node' | 'task' | 'collection' | 'edge'): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${kind}-${random}`
}

export async function dispatchCommands(
  store: { dispatchCommand: (command: CanvasCommand) => Promise<unknown> },
  commands: CanvasCommand[],
): Promise<void> {
  for (const command of commands) await store.dispatchCommand(command)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Places a node created from a port with a stable gap and center alignment. */
export function portCreatedNodeFrame(
  source: CanvasBounds,
  side: CanvasConnectionPortSide,
  width: number,
): CanvasWorldRect {
  const gap = 56
  const height = 256
  const centerX = Math.round(source.x + source.w / 2 - width / 2)
  const centerY = Math.round(source.y + source.h / 2 - height / 2)
  switch (side) {
    case 'right':
      return { x: Math.round(source.x + source.w + gap), y: centerY, w: width, h: height, z: 0 }
    case 'left':
      return { x: Math.round(source.x - width - gap), y: centerY, w: width, h: height, z: 0 }
    case 'bottom':
      return { x: centerX, y: Math.round(source.y + source.h + gap), w: width, h: height, z: 0 }
    case 'top':
      return { x: centerX, y: Math.round(source.y - height - gap), w: width, h: height, z: 0 }
  }
}
