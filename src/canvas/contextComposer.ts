import {
  MAX_CANVAS_EDGE_BATCH,
  type CanvasCommand,
  type DerivedTaskSource,
} from './commands'
import { TASK_OUTPUT_LAYOUT } from './layout'
import {
  canvasNodeFrame,
  entityKey,
  type CanvasDocument,
  type CanvasEntityRef,
  type CanvasNode,
  type CanvasPoint,
  type CanvasTask,
} from './model'
import {
  promotedTaskInputsForOutputSlot,
  selectIncomingContextEdges,
} from './contextEdges'
import type { CanvasSelectionTarget } from './persistence'
import {
  nodeHasVisibleContent,
  selectTaskBounds,
  selectTaskNodes,
  type CanvasBounds,
} from './selectors'

export interface CanvasContextTaskPlan {
  task: CanvasTask
  command: CanvasCommand
  kind: 'new' | 'output-slot' | 'derived'
  sourceCount: number
}

export function canvasContextComposerKey(
  selection: readonly CanvasSelectionTarget[],
): string {
  const keys = selection.map((target) => `${target.kind}:${target.id}`).sort()
  return `context-composer:${keys.join('|') || 'canvas'}`
}

export function selectionIsSingleTask(
  selection: readonly CanvasSelectionTarget[],
): boolean {
  return selection.length === 1 && selection[0]?.kind === 'task'
}

export function buildContextTaskPlan(input: {
  document: CanvasDocument
  selection: readonly CanvasSelectionTarget[]
  prompt: string
  anchor: CanvasPoint
  taskId: string
}): CanvasContextTaskPlan {
  const prompt = input.prompt.trim()
  if (!prompt) throw new TypeError('Task prompt must not be empty')
  if (selectionIsSingleTask(input.selection)) {
    throw new TypeError('A selected Task must continue through its own Task composer')
  }
  const task: CanvasTask = {
    id: input.taskId,
    title: taskTitleFromPrompt(prompt),
    goal: prompt,
    anchor: { ...input.anchor },
    origin: { kind: 'user' },
  }

  if (input.selection.length === 0) {
    return {
      task,
      command: { type: 'CreateTask', task },
      kind: 'new',
      sourceCount: 0,
    }
  }

  if (input.selection.length === 1 && input.selection[0]?.kind === 'node') {
    const node = input.document.nodes.find((entry) => entry.id === input.selection[0]?.id)
    if (!node) throw new TypeError('Selected node does not exist')
    if (isEmptyUserOutputSlot(node)) {
      const slotTask = node.collectionId ? { ...task, collectionId: node.collectionId } : task
      const inheritedInputs = promotedTaskInputsForOutputSlot(input.document.edges, node.id)
      if (inheritedInputs.length > MAX_CANVAS_EDGE_BATCH) {
        throw new TypeError(
          `An output slot can inherit at most ${MAX_CANVAS_EDGE_BATCH} unique inputs`,
        )
      }
      return {
        task: slotTask,
        command: { type: 'CreateTaskForOutputSlot', task: slotTask, nodeId: node.id },
        kind: 'output-slot',
        sourceCount: inheritedInputs.length,
      }
    }
    const source: DerivedTaskSource = {
      entity: { kind: 'node', id: node.id },
      relation: 'modified',
      contextRole: 'full',
    }
    const derivedTask: CanvasTask = {
      ...task,
      anchor: derivedTaskAnchor([canvasNodeFrame(node)]),
    }
    return {
      task: derivedTask,
      command: { type: 'CreateDerivedTaskFromSelection', task: derivedTask, sources: [source] },
      kind: 'derived',
      sourceCount: 1,
    }
  }

  const entities = expandContextSelection(input.document, input.selection)
  if (entities.length === 0) throw new TypeError('Selection has no context-capable entities')
  if (entities.length > 500) throw new TypeError('A derived Task can reference at most 500 sources')
  const sources: DerivedTaskSource[] = entities.map((entity) => ({
    entity,
    relation: 'source',
    contextRole: 'full',
  }))
  const sourceFrames = entities
    .map((entity) => entityBoundsForAnchor(input.document, entity))
    .filter((frame): frame is CanvasBounds => frame !== null)
  const derivedTask: CanvasTask = sourceFrames.length > 0
    ? { ...task, anchor: derivedTaskAnchor(sourceFrames) }
    : task
  return {
    task: derivedTask,
    command: { type: 'CreateDerivedTaskFromSelection', task: derivedTask, sources },
    kind: 'derived',
    sourceCount: sources.length,
  }
}

export function expandContextSelection(
  document: CanvasDocument,
  selection: readonly CanvasSelectionTarget[],
): CanvasEntityRef[] {
  const entities: CanvasEntityRef[] = []
  for (const target of selection) {
    if (target.kind === 'collection') {
      entities.push(
        ...document.tasks
          .filter((task) => task.collectionId === target.id)
          .map((task): CanvasEntityRef => ({ kind: 'task', id: task.id })),
        ...document.nodes
          .filter((node) => !node.homeTaskId && node.collectionId === target.id)
          .map((node): CanvasEntityRef => ({ kind: 'node', id: node.id })),
      )
    } else if (target.kind === 'node' || target.kind === 'task') {
      entities.push({ kind: target.kind, id: target.id })
    }
  }
  const unique = new Map(entities.map((entity) => [entityKey(entity), entity]))
  return [...unique.values()]
}

/** 空内容判定见 selectors 的 nodeHasVisibleContent；此处保留组合判定。 */
export { nodeHasVisibleContent } from './selectors'

export function isEmptyUserOutputSlot(node: CanvasDocument['nodes'][number]): boolean {
  return node.origin.kind === 'user'
    && !node.homeTaskId
    && !nodeHasVisibleContent(node)
}

/**
 * A derived Task anchors so its chrome starts right below the source content
 * and its first output Node never stacks on top of the original Node.
 */
const DERIVED_TASK_VERTICAL_GAP = 96

function derivedTaskAnchor(frames: readonly CanvasBounds[]): CanvasPoint {
  const left = Math.min(...frames.map((frame) => frame.x))
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h))
  return {
    x: left - TASK_OUTPUT_LAYOUT.offsetX,
    y: bottom + DERIVED_TASK_VERTICAL_GAP - TASK_OUTPUT_LAYOUT.offsetY,
  }
}

function entityBoundsForAnchor(
  document: CanvasDocument,
  entity: CanvasEntityRef,
): CanvasBounds | null {
  if (entity.kind === 'node') {
    const node = document.nodes.find((candidate) => candidate.id === entity.id)
    return node ? canvasNodeFrame(node) : null
  }
  const task = document.tasks.find((entry) => entry.id === entity.id)
  if (!task) return null
  return selectTaskBounds(task, selectTaskNodes(document, task.id))
}

function taskTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() || '新任务'
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`
}

/** 节点的来源节点：经 contextRole 非 none 的边指向该节点（或其所属任务）的节点。 */
export function selectSourceNodes(
  nodes: readonly CanvasNode[],
  edges: ReadonlyArray<CanvasDocument['edges'][number]>,
  node: CanvasNode,
): CanvasNode[] {
  const targetTaskId = node.origin.kind === 'agent-output'
    ? node.origin.taskId
    : node.homeTaskId
  const incoming = [
    ...selectIncomingContextEdges(edges, { kind: 'node', id: node.id }),
    ...(targetTaskId
      ? selectIncomingContextEdges(edges, { kind: 'task', id: targetTaskId })
      : []),
  ]
  const ids = new Set(incoming.flatMap((edge) =>
    edge.from.kind === 'node' ? [edge.from.id] : []))
  return nodes.filter((candidate) => ids.has(candidate.id))
}
