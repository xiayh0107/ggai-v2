import { describe, expect, it } from 'vitest'
import {
  buildContextTaskPlan,
  canvasContextComposerKey,
  expandContextSelection,
  selectSourceNodes,
} from './contextComposer'
import { applyCanvasCommand } from './commands'
import { emptyCanvasDocument, type CanvasDocument } from './model'
import { compileTaskContext, taskContextArtifactRefs } from '../agent/taskContext'

function document(): CanvasDocument {
  const value = emptyCanvasDocument()
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
    const plan = buildContextTaskPlan({
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
    const plan = buildContextTaskPlan({
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

  it('keeps a community source visible and executable when its empty target becomes an output slot', () => {
    const sourceDocument = emptyCanvasDocument()
    sourceDocument.nodes.push(
      {
        id: 'community-image',
        type: '@community/image',
        frame: { x: 10, y: 10, w: 320, h: 220, z: 1 },
        title: 'Community image',
        artifactRefs: [{
          runId: 'run-community-image',
          artifactId: `artifact_${'f'.repeat(64)}`,
        }],
        origin: { kind: 'copied', sourceNodeId: 'original-image' },
      },
      {
        id: 'community-review-slot',
        type: '@community/review',
        frame: { x: 380, y: 10, w: 320, h: 220, z: 2 },
        title: 'Community review',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    )
    sourceDocument.edges.push({
      id: 'edge-community-source',
      from: { kind: 'node', id: 'community-image' },
      to: { kind: 'node', id: 'community-review-slot' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    })

    expect(selectSourceNodes(
      sourceDocument.nodes,
      sourceDocument.edges,
      sourceDocument.nodes[1]!,
    ).map((node) => node.id)).toEqual(['community-image'])

    const plan = buildContextTaskPlan({
      document: sourceDocument,
      selection: [{ kind: 'node', id: 'community-review-slot' }],
      prompt: 'Review this image',
      anchor: { x: 500, y: 400 },
      taskId: 'community-review-task',
    })
    expect(plan.sourceCount).toBe(1)
    const promoted = applyCanvasCommand(sourceDocument, plan.command)
    const pack = compileTaskContext({
      document: promoted,
      taskId: plan.task.id,
    })

    expect(pack.inputs).toHaveLength(1)
    expect(pack.inputs[0]).toMatchObject({
      kind: 'node',
      ref: { kind: 'node', id: 'community-image' },
      type: '@community/image',
      contextRole: 'full',
      artifactRefs: sourceDocument.nodes[0]!.artifactRefs,
    })
    expect(taskContextArtifactRefs(pack)).toEqual(sourceDocument.nodes[0]!.artifactRefs)
  })

  it('derives from one content Node through modified without overwriting it', () => {
    const source = document().nodes.find((node) => node.id === 'node-content')
    const plan = buildContextTaskPlan({
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
    // The derived Task anchors below the source Node so its chrome and first
    // output never stack on top of the original content.
    expect(plan.task.anchor).toEqual({
      x: 380 - 48,
      y: 10 + 220,
    })
    expect(source?.text).toBe('keep original')
  })

  it('expands saved Collections into ordinary top-level source edges and deduplicates', () => {
    const sourceDocument = document()
    const expanded = expandContextSelection(sourceDocument, [
      { kind: 'collection', id: 'collection-1' },
      { kind: 'task', id: 'task-source' },
    ])
    expect(expanded).toEqual([
      { kind: 'task', id: 'task-source' },
      { kind: 'node', id: 'node-empty' },
    ])

    const plan = buildContextTaskPlan({
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
    expect(() => buildContextTaskPlan({
      ...base,
      document: document(),
      selection: [{ kind: 'task', id: 'task-source' }],
    })).toThrow('must continue through its own Task composer')
    expect(canvasContextComposerKey([
      { kind: 'node', id: 'b' },
      { kind: 'task', id: 'a' },
    ])).toBe('context-composer:node:b|task:a')
  })
})
