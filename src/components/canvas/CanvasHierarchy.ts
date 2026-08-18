import { canvasRootNode, type CanvasDocument, type CanvasNode } from '@/canvas/model'
import { COLLECTION_CHROME_LAYOUT } from '@/canvas/layout'
import {
  selectCollectionBounds,
  selectCollectionMembers,
  type CanvasBounds,
  type CanvasTaskView,
} from '@/canvas/selectors'

export interface CanvasCollectionView {
  collection: CanvasDocument['collections'][number]
  bounds: CanvasBounds
  collapsed: boolean
  memberCount: number
  artifactCount: number
}

export function deriveCanvasCollectionViews(
  document: CanvasDocument,
  collapsedIds: readonly string[],
): CanvasCollectionView[] {
  const collapsed = new Set(collapsedIds)
  return document.collections.map((collection) => {
    const members = selectCollectionMembers(document, collection.id)
    const taskIds = new Set(members.tasks.map((task) => task.id))
    const taskNodes = document.nodes.filter((node) =>
      node.homeTaskId !== undefined && taskIds.has(node.homeTaskId))
    return {
      collection,
      bounds: selectCollectionBounds(document, collection.id) ?? {
        x: collection.anchor.x,
        y: collection.anchor.y,
        w: COLLECTION_CHROME_LAYOUT.minimumWidth,
        h: COLLECTION_CHROME_LAYOUT.minimumHeight,
      },
      collapsed: collapsed.has(collection.id),
      memberCount: members.tasks.length + members.nodes.length,
      artifactCount: new Set([...members.nodes, ...taskNodes]
        .flatMap((node) => node.artifactRefs.map((artifact) =>
          `${artifact.runId}\u001f${artifact.artifactId}`))).size,
    }
  })
}

export interface CanvasHierarchyVisibility {
  hiddenTaskIds: Set<string>
  visibleTaskViews: CanvasTaskView[]
  visibleRootNodes: CanvasNode[]
  visibleChildNodes: CanvasNode[]
}

export function deriveCanvasHierarchyVisibility(input: {
  document: CanvasDocument
  taskViews: CanvasTaskView[]
  collapsedCollectionIds: ReadonlySet<string>
}): CanvasHierarchyVisibility {
  const hiddenTaskIds = new Set(input.document.tasks
    .filter((task) => task.collectionId && input.collapsedCollectionIds.has(task.collectionId))
    .map((task) => task.id))
  const collapsedTaskIds = new Set(input.taskViews
    .filter((view) => view.presentation === 'collapsed')
    .map((view) => view.task.id))
  return {
    hiddenTaskIds,
    visibleTaskViews: input.taskViews.filter((view) => !hiddenTaskIds.has(view.task.id)),
    visibleRootNodes: input.document.nodes.filter((node) => node.parentId === null
      && !node.homeTaskId
      && (!node.collectionId || !input.collapsedCollectionIds.has(node.collectionId))),
    visibleChildNodes: input.document.nodes.filter((node) => {
      if (node.parentId === null) return false
      const root = canvasRootNode(input.document, node)
      if (root.homeTaskId
        && (hiddenTaskIds.has(root.homeTaskId) || collapsedTaskIds.has(root.homeTaskId))) return false
      return !root.collectionId || !input.collapsedCollectionIds.has(root.collectionId)
    }),
  }
}

export function dataPortEndpointAction(input: {
  portDirection: 'input' | 'output'
  nodeId: string
  hasOutputDraft: boolean
}): { kind: 'notice'; message: string } | { kind: 'endpoint'; endpoint: { kind: 'node'; id: string } } {
  if (input.portDirection === 'input' && !input.hasOutputDraft) {
    return { kind: 'notice', message: '请先选择一个 output port' }
  }
  return { kind: 'endpoint', endpoint: { kind: 'node', id: input.nodeId } }
}
