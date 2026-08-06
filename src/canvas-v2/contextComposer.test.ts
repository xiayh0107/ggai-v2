import { describe, expect, it } from 'vitest'
import {
  buildContextTaskPlanV2,
  canvasV2ContextComposerKey,
  expandContextSelectionV2,
} from './contextComposer'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from './model'

function document(): CanvasDocumentV2 {
  const value = emptyCanvasDocumentV2()
  value.collections.push({ id: 'collection-1', title: 'Sources', anchor: { x: 10, y: 20 } })
  value.tasks.push({
    id: 'task-source',
    title: 'Source task',
    goal: 'Source',
    anchor: { x: 20, y: 40 },
    collectionId: 'collection-1',
    origin: { kind: 'user' },
  })
  value.nodes.push(
    {
      id: 'node-empty',
      type: 'image',
      frame: { x: 10, y: 10, w: 320, h: 220, z: 1 },
      title: 'Image slot',
      artifactRefs: [],
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    },
    {
      id: 'node-content',
      type: 'image',
      frame: { x: 380, y: 10, w: 320, h: 220, z: 2 },
      title: 'Original image',
      text: 'keep original',
      artifactRefs: [],
      origin: { kind: 'user' },
    },
    {
      id: 'node-child',
      type: 'text',
      frame: { x: 40, y: 100, w: 280, h: 160, z: 3 },
      title: 'Task child',
      artifactRefs: [],
      homeTaskId: 'task-source',
      origin: { kind: 'user' },
    },
  )
  return value
}

const base = {
  prompt: 'Create a useful result',
  anchor: { x: 500, y: 400 },
  taskId: 'task-new',
}

describe('context-aware Task creation', () => {
  it('creates a plain draft Task from an empty canvas context', () => {
    const plan = buildContextTaskPlanV2({
      ...base,
      document: document(),
      selection: [],
    })

    expect(plan.kind).toBe('new')
    expect(plan.command).toEqual({ type: 'CreateTask', task: plan.task })
    expect(plan.task).toMatchObject({
      id: 'task-new',
      goal: base.prompt,
      anchor: base.anchor,
      origin: { kind: 'user' },
    })
  })

  it('adopts one empty user Node as an output slot in the same collection', () => {
    const plan = buildContextTaskPlanV2({
      ...base,
      document: document(),
      selection: [{ kind: 'node', id: 'node-empty' }],
    })

    expect(plan.kind).toBe('output-slot')
    expect(plan.task.collectionId).toBe('collection-1')
    expect(plan.command).toEqual({
      type: 'CreateTaskForOutputSlot',
      task: plan.task,
      nodeId: 'node-empty',
    })
  })

  it('derives from one content Node through modified without overwriting it', () => {
    const source = document().nodes.find((node) => node.id === 'node-content')
    const plan = buildContextTaskPlanV2({
      ...base,
      document: document(),
      selection: [{ kind: 'node', id: 'node-content' }],
    })

    expect(plan.kind).toBe('derived')
    expect(plan.command).toMatchObject({
      type: 'CreateDerivedTaskFromSelection',
      sources: [{
        entity: { kind: 'node', id: 'node-content' },
        relation: 'modified',
        contextRole: 'full',
      }],
    })
    expect(source?.text).toBe('keep original')
  })

  it('expands saved Collections into ordinary top-level source edges and deduplicates', () => {
    const sourceDocument = document()
    const expanded = expandContextSelectionV2(sourceDocument, [
      { kind: 'collection', id: 'collection-1' },
      { kind: 'task', id: 'task-source' },
    ])
    expect(expanded).toEqual([
      { kind: 'task', id: 'task-source' },
      { kind: 'node', id: 'node-empty' },
    ])

    const plan = buildContextTaskPlanV2({
      ...base,
      document: sourceDocument,
      selection: [
        { kind: 'collection', id: 'collection-1' },
        { kind: 'node', id: 'node-content' },
      ],
    })
    expect(plan.sourceCount).toBe(3)
    expect(plan.command.type).toBe('CreateDerivedTaskFromSelection')
    if (plan.command.type === 'CreateDerivedTaskFromSelection') {
      expect(plan.command.sources.every((source) => source.relation === 'source')).toBe(true)
      expect(plan.command.sources.map((source) => source.entity)).not.toContainEqual({
        kind: 'node',
        id: 'node-child',
      })
    }
  })

  it('keeps one selected Task on its own continuation path and stores stable draft keys', () => {
    expect(() => buildContextTaskPlanV2({
      ...base,
      document: document(),
      selection: [{ kind: 'task', id: 'task-source' }],
    })).toThrow('must continue through its own Task composer')
    expect(canvasV2ContextComposerKey([
      { kind: 'node', id: 'b' },
      { kind: 'task', id: 'a' },
    ])).toBe('context-composer:node:b|task:a')
  })
})
