import type {
  CanvasCommandV2,
  DerivedTaskSourceV2,
} from './commands'
import { TASK_OUTPUT_LAYOUT_V2 } from './layout'
import {
  entityKeyV2,
  type CanvasDocumentV2,
  type CanvasEntityRef,
  type CanvasPointV2,
  type CanvasTaskV2,
} from './model'
import type { CanvasV2SelectionTarget } from './persistence'
import {
  selectTaskBoundsV2,
  selectTaskNodesV2,
  type CanvasBoundsV2,
} from './selectors'

export interface CanvasV2ContextTaskPlan {
  task: CanvasTaskV2
  command: CanvasCommandV2
  kind: 'new' | 'output-slot' | 'derived'
  sourceCount: number
}

export function canvasV2ContextComposerKey(
  selection: readonly CanvasV2SelectionTarget[],
): string {
  const keys = selection.map((target) => `${target.kind}:${target.id}`).sort()
  return `context-composer:${keys.join('|') || 'canvas'}`
}

export function selectionIsSingleTaskV2(
  selection: readonly CanvasV2SelectionTarget[],
): boolean {
  return selection.length === 1 && selection[0]?.kind === 'task'
}

export function buildContextTaskPlanV2(input: {
  document: CanvasDocumentV2
  selection: readonly CanvasV2SelectionTarget[]
  prompt: string
  anchor: CanvasPointV2
  taskId: string
}): CanvasV2ContextTaskPlan {
  const prompt = input.prompt.trim()
  if (!prompt) throw new TypeError('Task prompt must not be empty')
  if (selectionIsSingleTaskV2(input.selection)) {
    throw new TypeError('A selected Task must continue through its own Task composer')
  }
  const task: CanvasTaskV2 = {
    id: input.taskId,
    title: taskTitleFromPromptV2(prompt),
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
    if (isEmptyUserOutputSlotV2(node)) {
      const slotTask = node.collectionId ? { ...task, collectionId: node.collectionId } : task
      return {
        task: slotTask,
        command: { type: 'CreateTaskForOutputSlot', task: slotTask, nodeId: node.id },
        kind: 'output-slot',
        sourceCount: 0,
      }
    }
    const source: DerivedTaskSourceV2 = {
      entity: { kind: 'node', id: node.id },
      relation: 'modified',
      contextRole: 'full',
    }
    const derivedTask: CanvasTaskV2 = {
      ...task,
      anchor: derivedTaskAnchorV2([node.frame]),
    }
    return {
      task: derivedTask,
      command: { type: 'CreateDerivedTaskFromSelection', task: derivedTask, sources: [source] },
      kind: 'derived',
      sourceCount: 1,
    }
  }

  const entities = expandContextSelectionV2(input.document, input.selection)
  if (entities.length === 0) throw new TypeError('Selection has no context-capable entities')
  if (entities.length > 500) throw new TypeError('A derived Task can reference at most 500 sources')
  const sources: DerivedTaskSourceV2[] = entities.map((entity) => ({
    entity,
    relation: 'source',
    contextRole: 'full',
  }))
  const sourceFrames = entities
    .map((entity) => entityBoundsForAnchorV2(input.document, entity))
    .filter((frame): frame is CanvasBoundsV2 => frame !== null)
  const derivedTask: CanvasTaskV2 = sourceFrames.length > 0
    ? { ...task, anchor: derivedTaskAnchorV2(sourceFrames) }
    : task
  return {
    task: derivedTask,
    command: { type: 'CreateDerivedTaskFromSelection', task: derivedTask, sources },
    kind: 'derived',
    sourceCount: sources.length,
  }
}

export function expandContextSelectionV2(
  document: CanvasDocumentV2,
  selection: readonly CanvasV2SelectionTarget[],
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
  const unique = new Map(entities.map((entity) => [entityKeyV2(entity), entity]))
  return [...unique.values()]
}

export function isEmptyUserOutputSlotV2(node: CanvasDocumentV2['nodes'][number]): boolean {
  return node.origin.kind === 'user'
    && !node.homeTaskId
    && node.artifactRefs.length === 0
    && (node.text === undefined || node.text.trim().length === 0)
    && (node.payload === undefined || Object.keys(node.payload).length === 0)
}

/**
 * A derived Task anchors so its chrome starts right below the source content
 * and its first output Node never stacks on top of the original Node.
 */
const DERIVED_TASK_VERTICAL_GAP_V2 = 96

function derivedTaskAnchorV2(frames: readonly CanvasBoundsV2[]): CanvasPointV2 {
  const left = Math.min(...frames.map((frame) => frame.x))
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h))
  return {
    x: left - TASK_OUTPUT_LAYOUT_V2.offsetX,
    y: bottom + DERIVED_TASK_VERTICAL_GAP_V2 - TASK_OUTPUT_LAYOUT_V2.offsetY,
  }
}

function entityBoundsForAnchorV2(
  document: CanvasDocumentV2,
  entity: CanvasEntityRef,
): CanvasBoundsV2 | null {
  if (entity.kind === 'node') {
    return document.nodes.find((node) => node.id === entity.id)?.frame ?? null
  }
  const task = document.tasks.find((entry) => entry.id === entity.id)
  if (!task) return null
  return selectTaskBoundsV2(task, selectTaskNodesV2(document, task.id))
}

function taskTitleFromPromptV2(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() || '新任务'
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`
}
