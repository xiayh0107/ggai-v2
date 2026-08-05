import { describe, expect, it } from 'vitest'
import {
  applyCanvasCommandV2,
  CanvasCommandError,
  deterministicCanvasIdV2,
  type TrustedProjectionPlanInputV2,
} from './commands'
import {
  emptyCanvasDocumentV2,
  type CanvasDocumentV2,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from './model'

const PLAN_ID = `plan_${'a'.repeat(64)}`

function task(id = 'task-1'): CanvasTaskV2 {
  return {
    id,
    title: 'Scatter plot',
    goal: 'Create a classic scatter plot',
    anchor: { x: 100, y: 120 },
    origin: { kind: 'user' },
  }
}

function node(
  id: string,
  x: number,
  y: number,
  homeTaskId?: string,
): CanvasNodeV2 {
  return {
    id,
    type: 'text',
    frame: { x, y, w: 300, h: 180, z: 1 },
    title: id,
    artifactRefs: [],
    ...(homeTaskId ? { homeTaskId } : {}),
    origin: { kind: 'user' },
  }
}

function documentWithTask(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.tasks.push(task())
  return document
}

function plan(planId = PLAN_ID): TrustedProjectionPlanInputV2 {
  return {
    schemaVersion: 2,
    planId,
    runId: 'run-1',
    taskId: 'task-1',
    status: 'complete',
    manifestDigest: 'b'.repeat(64),
    outputs: [
      {
        key: 'source',
        pluginId: 'code',
        role: 'primary',
        title: 'R source',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'c'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: true,
      },
      {
        key: 'preview',
        pluginId: 'image',
        role: 'supporting',
        title: 'Scatter plot preview',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'d'.repeat(64)}`,
        }],
        derivedFrom: ['source'],
        materialize: true,
      },
      {
        key: 'notes',
        pluginId: 'file',
        role: 'auxiliary',
        title: 'Notes',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'e'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: false,
      },
    ],
    taskProposals: [
      {
        key: 'explain',
        title: 'Explain findings',
        prompt: 'Explain the relationship in the chart',
        inputOutputKeys: ['source'],
        dependsOn: [],
      },
      {
        key: 'export',
        title: 'Export report',
        prompt: 'Export the chart and explanation',
        inputOutputKeys: ['preview'],
        dependsOn: ['explain'],
      },
    ],
    warnings: ['Run ended with a partial but valid manifest'],
    digest: 'f'.repeat(64),
  }
}

describe('Canvas V2 commands', () => {
  it('manages task goals and moves a collection as one spatial unit', () => {
    let current = applyCanvasCommandV2(emptyCanvasDocumentV2(), {
      type: 'CreateTask',
      task: task(),
    })
    current.nodes.push(
      node('task-node', 140, 240, 'task-1'),
      node('top-node', 500, 200),
    )
    current = applyCanvasCommandV2(current, {
      type: 'UpdateTaskGoal',
      taskId: 'task-1',
      goal: 'Create and explain a scatter plot',
    })
    current = applyCanvasCommandV2(current, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-1',
        title: 'Analysis',
        anchor: { x: 60, y: 80 },
      },
      members: [
        { kind: 'task', id: 'task-1' },
        { kind: 'node', id: 'top-node' },
      ],
    })
    const moved = applyCanvasCommandV2(current, {
      type: 'MoveEntities',
      entities: [],
      collectionIds: ['collection-1'],
      dx: 25,
      dy: -10,
    })

    expect(moved.tasks[0]).toMatchObject({
      goal: 'Create and explain a scatter plot',
      anchor: { x: 125, y: 110 },
      collectionId: 'collection-1',
    })
    expect(moved.collections[0].anchor).toEqual({ x: 85, y: 70 })
    expect(moved.nodes.find((entry) => entry.id === 'task-node')?.frame).toMatchObject({
      x: 165,
      y: 230,
    })
    expect(moved.nodes.find((entry) => entry.id === 'top-node')?.frame).toMatchObject({
      x: 525,
      y: 190,
    })

    const dissolved = applyCanvasCommandV2(moved, {
      type: 'DissolveCollection',
      collectionId: 'collection-1',
    })
    const regrouped = applyCanvasCommandV2(dissolved, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-2',
        title: 'Delete together',
        anchor: { x: 0, y: 0 },
      },
      members: [{ kind: 'node', id: 'top-node' }],
    })
    const assigned = applyCanvasCommandV2(regrouped, {
      type: 'AssignToCollection',
      collectionId: 'collection-2',
      members: [{ kind: 'task', id: 'task-1' }],
    })
    const deleted = applyCanvasCommandV2(assigned, {
      type: 'DeleteCollection',
      collectionId: 'collection-2',
    })

    expect(deleted.collections).toEqual([])
    expect(deleted.tasks).toEqual([])
    expect(deleted.nodes.map((entry) => entry.id)).toEqual(['task-node'])
    expect(deleted.nodes[0].homeTaskId).toBeUndefined()
  })

  it('duplicates only task intent and inbound context, then releases nodes on task deletion', () => {
    const initial = documentWithTask()
    initial.nodes.push(
      node('source-context', 20, 40),
      node('task-output', 180, 260, 'task-1'),
    )
    initial.edges.push(
      {
        id: 'edge-input',
        from: { kind: 'node', id: 'source-context' },
        to: { kind: 'task', id: 'task-1' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-output',
        from: { kind: 'task', id: 'task-1' },
        to: { kind: 'node', id: 'task-output' },
        relation: 'produced',
        contextRole: 'summary',
        origin: { kind: 'user' },
      },
    )

    const duplicated = applyCanvasCommandV2(initial, {
      type: 'DuplicateTaskAsDraft',
      sourceTaskId: 'task-1',
      newTaskId: 'task-draft',
      offset: { x: 420, y: 0 },
    })

    expect(duplicated.tasks).toHaveLength(2)
    expect(duplicated.nodes).toHaveLength(2)
    expect(duplicated.tasks[1]).toMatchObject({
      id: 'task-draft',
      goal: initial.tasks[0].goal,
      origin: { kind: 'user' },
    })
    expect(duplicated.edges.filter((edge) => edge.to.id === 'task-draft')).toHaveLength(1)

    const deleted = applyCanvasCommandV2(duplicated, {
      type: 'DeleteTask',
      taskId: 'task-1',
    })

    expect(deleted.tasks.map((entry) => entry.id)).toEqual(['task-draft'])
    expect(deleted.nodes.find((entry) => entry.id === 'task-output')?.homeTaskId).toBeUndefined()
    expect(deleted.edges).toHaveLength(1)
    expect(deleted.edges[0].to).toEqual({ kind: 'task', id: 'task-draft' })
  })

  it('materializes trusted auto outputs once and never resurrects after task deletion', () => {
    const initial = documentWithTask()
    const trustedPlan = {
      ...plan(),
      status: 'partial' as const,
      taskProposals: [],
    }
    const materialized = applyCanvasCommandV2(initial, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const sourceId = deterministicCanvasIdV2('node', PLAN_ID, 'source')
    const previewId = deterministicCanvasIdV2('node', PLAN_ID, 'preview')

    expect(materialized.nodes.map((entry) => entry.id)).toEqual([sourceId, previewId])
    expect(materialized.nodes.every((entry) => entry.homeTaskId === 'task-1')).toBe(true)
    expect(materialized.edges.filter((edge) => edge.relation === 'produced')).toHaveLength(2)
    expect(materialized.edges.filter((edge) => edge.relation === 'derived')).toHaveLength(1)
    expect(materialized.edges[0].from).toEqual({ kind: 'task', id: 'task-1' })
    expect(materialized.receipts[0]).toEqual({
      kind: 'materialization',
      planId: PLAN_ID,
      runId: 'run-1',
      taskId: 'task-1',
      outcomes: [
        { outputKey: 'source', nodeId: sourceId },
        { outputKey: 'preview', nodeId: previewId },
      ],
      dismissedProposalKeys: [],
    })
    expect(applyCanvasCommandV2(materialized, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toBe(materialized)

    const deleted = applyCanvasCommandV2(materialized, {
      type: 'DeleteTask',
      taskId: 'task-1',
    })
    const replayed = applyCanvasCommandV2(deleted, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })

    expect(replayed).toBe(deleted)
    expect(replayed.tasks).toEqual([])
    expect(replayed.nodes).toHaveLength(2)
    expect(replayed.nodes.every((entry) => entry.homeTaskId === undefined)).toBe(true)
    expect(replayed.receipts).toHaveLength(1)
  })

  it('accepts bounded task proposals with source/dependency edges and records dismissal', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommandV2(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const accepted = applyCanvasCommandV2(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['explain', 'export'],
    })

    expect(accepted.tasks).toHaveLength(3)
    expect(accepted.tasks.slice(1).map((entry) => entry.origin.kind)).toEqual([
      'agent-proposal',
      'agent-proposal',
    ])
    expect(accepted.edges.filter((edge) => edge.relation === 'source')).toHaveLength(2)
    expect(accepted.edges.filter((edge) => edge.relation === 'depends-on')).toHaveLength(1)
    expect(accepted.receipts.map((receipt) => receipt.kind)).toEqual([
      'materialization',
      'proposal-acceptance',
    ])
    expect(applyCanvasCommandV2(accepted, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['explain', 'export'],
    })).toBe(accepted)

    const dismissed = applyCanvasCommandV2(accepted, {
      type: 'DismissPlan',
      plan: trustedPlan,
    })
    expect(dismissed.tasks).toHaveLength(3)
    expect(dismissed.nodes).toHaveLength(2)
    expect(dismissed.receipts[2]).toMatchObject({
      kind: 'plan-dismissal',
      proposalKeys: [],
    })
    expect(applyCanvasCommandV2(dismissed, {
      type: 'DismissPlan',
      plan: trustedPlan,
    })).toBe(dismissed)
  })

  it('keeps multi-step command failures atomic', () => {
    const initial = documentWithTask()
    initial.nodes.push(node('task-node', 140, 240, 'task-1'))
    const snapshot = structuredClone(initial)

    expect(() => applyCanvasCommandV2(initial, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-1',
        title: 'Invalid nesting',
        anchor: { x: 0, y: 0 },
      },
      members: [{ kind: 'node', id: 'task-node' }],
    })).toThrowError(CanvasCommandError)
    expect(() => applyCanvasCommandV2(initial, {
      type: 'MoveEntities',
      entities: [{ kind: 'task', id: 'task-1' }],
      dx: Number.NaN,
      dy: 10,
    })).toThrowError(CanvasCommandError)
    expect(initial).toEqual(snapshot)
  })
})
